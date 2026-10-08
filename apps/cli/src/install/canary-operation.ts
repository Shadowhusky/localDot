import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import {
  CanaryOperation,
  CanaryOperationRecord,
  type CanaryRole,
} from "../../../../packages/protocol/src/canary-operation.ts";
import { withCanaryDirectoryLease } from "./canary-lease.ts";
import type { KernelLockAcquirer } from "./install-lock.ts";
import { privateRecordStore } from "./private-record.ts";

export interface CanaryOperationStore {
  read(): Promise<CanaryOperation | null>;
  save(value: CanaryOperation | null): Promise<void>;
}
export interface CanaryOperationJournal {
  snapshot(): CanaryOperation;
  capture(role: Exclude<CanaryRole, "home">, id: string): Promise<void>;
  capture(role: "home", created: true): Promise<void>;
}
type Identity = Pick<CanaryOperation, "owner" | "engineId">;
type NewOperation = Identity & Pick<CanaryOperation, "cellId" | "images">;
const failure = () =>
  new Error("Diagnostic recovery could not confirm exclusive ownership and cleanup.");
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
const safe = (s: BigIntStats) =>
  s.isDirectory() && s.uid === BigInt(process.getuid?.() ?? -1) && (s.mode & 0o7777n) === 0o700n;
const identity = (s: BigIntStats) => ({ device: String(s.dev), inode: String(s.ino) });
const same = (a: CanaryOperation["directory"], b: CanaryOperation["directory"]) =>
  a !== null && b !== null && a.device === b.device && a.inode === b.inode;
const pathFor = (state: string, r: CanaryOperation) => join(state, `canary-${r.runId}`);
async function privateDirectory(path: string) {
  const stat = await lstat(path, { bigint: true });
  if (!safe(stat) || (await realpath(path)) !== path) throw failure();
  return stat;
}
async function checkState(state: string) {
  if (!isAbsolute(state) || normalize(state) !== state || state === "/") throw failure();
  return privateDirectory(state);
}
async function syncState(state: string, before: BigIntStats) {
  const handle = await open(
    state,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const current = await handle.stat({ bigint: true });
    if (
      !safe(current) ||
      !same(identity(before), identity(current)) ||
      !same(identity(before), identity(await privateDirectory(state)))
    )
      throw failure();
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export function canaryOperationStore(state: string): CanaryOperationStore {
  return privateRecordStore(state, "canary-operation.json", CanaryOperationRecord);
}

// No new effects may start after a failed write, including a lost acknowledgement after rename.
// Serial capture prevents two concurrently completed creates from overwriting each other's IDs.
function journal(
  store: CanaryOperationStore,
  record: CanaryOperation,
): CanaryOperationJournal & { drain(): Promise<void> } {
  let current = CanaryOperation.parse(record),
    poisoned = false,
    sealed = false;
  let tail = Promise.resolve();
  return {
    snapshot: () => structuredClone(current),
    capture: (role: CanaryRole, value: string | true) => {
      if (sealed) return Promise.reject(failure());
      const next = tail.then(async () => {
        if (poisoned || current.phase !== "active") throw failure();
        const prior = current.resources[role];
        if (prior !== null && prior !== false && prior !== value) throw failure();
        const updated = CanaryOperation.parse({
          ...current,
          resources: { ...current.resources, [role]: value },
        });
        // Keep memory unchanged if persistence fails; recovery re-reads the durable record.
        try {
          await store.save(updated);
        } catch {
          poisoned = true;
          throw failure();
        }
        current = updated;
      });
      tail = next.catch(() => {
        poisoned = true;
      });
      return next;
    },
    drain: async () => {
      sealed = true;
      await tail;
      if (poisoned) throw failure();
    },
  };
}

type Cleanup = (
  operation: CanaryOperation,
  directory: string,
  signal: AbortSignal,
) => Promise<void>;
/** Cleanup MUST verify the recorded Docker engine, resolve lost replies by exact random
 * names + all ownership labels, stop/remove exact IDs, prove all resources absent and drain
 * its effects. It runs only while the directory lifetime lease is held. It must not remove
 * or replace the root directory. This layer owns journal retirement and artifact removal.
 */
export interface CanaryOperationContext {
  state: string;
  store: CanaryOperationStore;
  acquire: KernelLockAcquirer;
  cleanup: Cleanup;
}
async function loadOwned(context: CanaryOperationContext, expected: Identity) {
  await checkState(context.state);
  const record = CanaryOperationRecord.parse(await context.store.read());
  if (record && (record.owner !== expected.owner || record.engineId !== expected.engineId))
    throw failure();
  return record;
}
async function retire(
  context: CanaryOperationContext,
  record: CanaryOperation,
  directory: string,
  signal: AbortSignal,
) {
  const parent = await checkState(context.state);
  if (!same(record.directory, identity(await privateDirectory(directory)))) throw failure();
  await context.cleanup(structuredClone(record), directory, signal);
  signal.throwIfAborted();
  if (!same(record.directory, identity(await privateDirectory(directory)))) throw failure();
  // Retired is durable before deletion. Only this phase permits an absent directory on retry.
  await context.store.save(CanaryOperation.parse({ ...record, phase: "retired" }));
  await rm(directory, { recursive: true, force: false });
  await syncState(context.state, parent);
  await context.store.save(null);
  signal.throwIfAborted();
}

/** Caller owns the installation mutex. Never treats a missing active directory or a remembered
 * PID as proof of helper retirement. No new diagnostic run starts until recovery has finished.
 */
export async function recoverCanaryOperation(
  context: CanaryOperationContext,
  expected: Identity,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let record = await loadOwned(context, expected);
  signal.throwIfAborted();
  if (!record) return;
  const directory = pathFor(context.state, record);
  let stat: BigIntStats;
  try {
    stat = await privateDirectory(directory);
  } catch (error) {
    if (!missing(error) || record.phase === "active") throw failure();
    if (record.phase === "retired") {
      // All effects were drained before this phase was persisted. Reconfirm Docker absence.
      await context.cleanup(structuredClone(record), directory, signal);
      signal.throwIfAborted();
    }
    await context.store.save(null);
    return;
  }
  if (record.phase === "allocating") {
    // No helper/container effect was allowed before the active record. A lost mkdir/save reply
    // may leave only an empty private directory; anything else requires manual investigation.
    if ((await readdir(directory)).length !== 0) throw failure();
    record = CanaryOperation.parse({ ...record, phase: "active", directory: identity(stat) });
    await context.store.save(record);
  } else if (!same(record.directory, identity(stat))) throw failure();
  const owned = record;
  await withCanaryDirectoryLease(directory, signal, context.acquire, async () => {
    if (!same(owned.directory, identity(await privateDirectory(directory)))) throw failure();
    await retire(context, owned, directory, signal);
  });
}

/** Persist all random resource names/labels through runId before mkdir or any child/Docker
 * effect. Work receives only a held descriptor and journal; it must drain every effect before
 * settling. Cleanup has an independent bounded signal so caller cancellation cannot skip it.
 */
export async function withCanaryOperation<T>(
  context: CanaryOperationContext,
  input: NewOperation,
  signal: AbortSignal,
  work: (journal: CanaryOperationJournal, directory: string, descriptor: number) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const copied = structuredClone(input);
  if (await loadOwned(context, copied)) throw failure();
  const parent = await checkState(context.state);
  const planned = CanaryOperation.parse({
    ...copied,
    v: 1,
    runId: randomUUID(),
    phase: "allocating",
    directory: null,
    resources: { desktop: null, gate: null, internal: null, egress: null, home: false },
  });
  await context.store.save(planned);
  signal.throwIfAborted();
  const directory = pathFor(context.state, planned);
  await mkdir(directory, { mode: 0o700 });
  await syncState(context.state, parent);
  const active = CanaryOperation.parse({
    ...planned,
    phase: "active",
    directory: identity(await privateDirectory(directory)),
  });
  await context.store.save(active);
  return withCanaryDirectoryLease(directory, signal, context.acquire, async (descriptor) => {
    if (!same(active.directory, identity(await privateDirectory(directory)))) throw failure();
    const scope = journal(context.store, active);
    let value: T | undefined,
      workFailed = false,
      workError: unknown;
    try {
      signal.throwIfAborted();
      value = await work(scope, directory, descriptor);
      await scope.drain();
      signal.throwIfAborted();
    } catch (error) {
      workFailed = true;
      workError = error;
    }
    // Cleanup failure takes priority over a successful or failed scan. Re-read rather than
    // trusting an in-memory capture after an uncertain durable write.
    await scope.drain().catch(() => {});
    const persisted = await loadOwned(context, copied);
    if (
      !persisted ||
      persisted.runId !== active.runId ||
      !same(persisted.directory, active.directory)
    )
      throw failure();
    await retire(context, persisted, directory, AbortSignal.timeout(60_000));
    if (workFailed) throw workError;
    signal.throwIfAborted();
    return value as T;
  });
}
