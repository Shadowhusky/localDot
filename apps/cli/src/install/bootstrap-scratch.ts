import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "./copy-inventory.ts";
import {
  BootstrapLeaseBusy,
  type InstallLockLifetime,
  keydBootstrapLeaseAcquirer,
  systemBootstrapLeaseAcquirer,
  withInstallLock,
} from "./install-lock.ts";
import { privateRecordStore } from "./private-record.ts";

type Identity = Readonly<{ dev: string; ino: string; birthtimeNs: string }>;
type Ownership = Readonly<{
  v: 1;
  nonce: string;
  parent: Identity;
  records: Identity;
  entry: Identity;
  lock: Identity;
  payload: Identity;
}>;
const fail = () => new Error("Bootstrap preparation recovery requires ownership inspection.");
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
const exists = (e: unknown) => e instanceof Error && "code" in e && e.code === "EEXIST";
const noncePattern = /^[a-f0-9]{32}$/;
function fields(value: unknown, keys: string[]): { [key: string]: unknown } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",")
  )
    throw fail();
  return value as { [key: string]: unknown };
}
function identity(value: unknown): Identity {
  const v = fields(value, ["dev", "ino", "birthtimeNs"]);
  for (const k of ["dev", "ino", "birthtimeNs"])
    if (typeof v[k] !== "string" || !/^(?:0|[1-9][0-9]{0,24})$/.test(v[k])) throw fail();
  return { dev: v.dev as string, ino: v.ino as string, birthtimeNs: v.birthtimeNs as string };
}
const schema = {
  parse(value: unknown): Ownership {
    const v = fields(value, ["v", "nonce", "parent", "records", "entry", "lock", "payload"]);
    if (v.v !== 1 || typeof v.nonce !== "string" || !noncePattern.test(v.nonce)) throw fail();
    return {
      v: 1,
      nonce: v.nonce,
      parent: identity(v.parent),
      records: identity(v.records),
      entry: identity(v.entry),
      lock: identity(v.lock),
      payload: identity(v.payload),
    };
  },
};
const snapshot = (s: { dev: bigint; ino: bigint; birthtimeNs: bigint }): Identity => ({
  dev: String(s.dev),
  ino: String(s.ino),
  birthtimeNs: String(s.birthtimeNs),
});
const same = (a: Identity, b: Identity) =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const area = (state: string) => join(state, "bootstrap-leases");
const entryPath = (state: string, nonce: string) => join(area(state), nonce);
const payloadPath = (state: string, nonce: string) => join(state, `.bootstrap-${nonce}`);
const storeAt = (state: string, nonce: string) =>
  privateRecordStore(entryPath(state, nonce), "ownership.json", schema);
async function ownedDirectory(path: string, id: Identity) {
  if (!same(snapshot(await privateDirectory(path)), id)) throw fail();
}
async function lockIdentity(entry: string) {
  const stat = await lstat(join(entry, "install.lock"), { bigint: true });
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.size !== 0n ||
    stat.uid !== BigInt(process.getuid?.() ?? -1) ||
    (stat.mode & 0o7777n) !== 0o600n
  )
    throw fail();
  return snapshot(stat);
}
async function syncDirectory(path: string, id: Identity) {
  await ownedDirectory(path, id);
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!same(snapshot(await fd.stat({ bigint: true })), id)) throw fail();
    await fd.sync();
  } finally {
    await fd.close();
  }
  await ownedDirectory(path, id);
}
function assertLifetime(directory: string, lifetime: InstallLockLifetime) {
  if (lifetime.directory !== directory) throw fail();
  lifetime.inheritDescriptor();
}
async function checkRecord(state: string, record: Ownership) {
  const entry = entryPath(state, record.nonce);
  await ownedDirectory(state, record.parent);
  await ownedDirectory(area(state), record.records);
  await ownedDirectory(entry, record.entry);
  if (!same(await lockIdentity(entry), record.lock)) throw fail();
  if (JSON.stringify(await storeAt(state, record.nonce).read()) !== JSON.stringify(record))
    throw fail();
}
async function retire(state: string, record: Ownership, lifetime: InstallLockLifetime) {
  const entry = entryPath(state, record.nonce),
    payload = payloadPath(state, record.nonce);
  assertLifetime(entry, lifetime);
  await checkRecord(state, record);
  let present = true;
  try {
    await lstat(payload);
  } catch (error) {
    if (!missing(error)) throw error;
    present = false;
  }
  if (present) {
    await ownedDirectory(payload, record.payload);
    assertLifetime(entry, lifetime);
    await rm(payload, { recursive: true, force: false });
  }
  await syncDirectory(state, record.parent);
  try {
    await lstat(payload);
    throw fail();
  } catch (error) {
    if (!missing(error)) throw error;
  }
  // Keep receipt and lease outside the payload until all payload removal is durable.
  await checkRecord(state, record);
  assertLifetime(entry, lifetime);
  await rm(entry, { recursive: true, force: false });
  await syncDirectory(area(state), record.records);
}

/** Allocate and durably record an empty payload while holding a separate kernel lease. Work must
 * drain all effects before returning. No age/PID inference and no downloaded code before trust. */
export async function withBootstrapScratch<T>(
  state: string,
  signal: AbortSignal,
  work: (directory: string) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const parent = snapshot(await privateDirectory(state));
  try {
    await mkdir(area(state), { mode: 0o700 });
  } catch (error) {
    if (!exists(error)) throw error;
  }
  const records = snapshot(await privateDirectory(area(state)));
  const nonce = randomBytes(16).toString("hex"),
    entry = entryPath(state, nonce);
  await mkdir(entry, { mode: 0o700 });
  await syncDirectory(area(state), records);
  return withInstallLock(entry, signal, systemBootstrapLeaseAcquirer, async (lifetime) => {
    const payload = payloadPath(state, nonce);
    await mkdir(payload, { mode: 0o700 });
    const record: Ownership = {
      v: 1,
      nonce,
      parent,
      records,
      entry: snapshot(await privateDirectory(entry)),
      lock: await lockIdentity(entry),
      payload: snapshot(await privateDirectory(payload)),
    };
    await syncDirectory(payload, record.payload);
    await syncDirectory(state, parent);
    await storeAt(state, nonce).save(record);
    let result: T;
    try {
      signal.throwIfAborted();
      result = await work(payload);
      signal.throwIfAborted();
    } catch (error) {
      try {
        await retire(state, record, lifetime);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Bootstrap failed; cleanup requires inspection.",
        );
      }
      throw error;
    }
    await retire(state, record, lifetime);
    return result;
  });
}

async function bothAbsent(state: string, nonce: string) {
  for (const path of [entryPath(state, nonce), payloadPath(state, nonce)]) {
    try {
      await lstat(path);
      return false;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return true;
}

/** Called only under the authenticated global install lock. Live pre-lock installers are skipped,
 * not interrupted. Unknown allocations have no cleanup authority and are retained for inspection. */
export async function recoverBootstrapScratch(
  state: string,
  verifiedKeydPath: string,
  signal: AbortSignal,
  globalLifetime: InstallLockLifetime,
) {
  signal.throwIfAborted();
  assertLifetime(state, globalLifetime);
  await privateDirectory(state);
  try {
    await privateDirectory(area(state));
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  const names = await readdir(area(state));
  if (names.length > 1024 || names.some((name) => !noncePattern.test(name))) throw fail();
  const records: Ownership[] = [];
  for (const nonce of names.sort()) {
    signal.throwIfAborted();
    try {
      const record = await storeAt(state, nonce).read();
      if (!record) continue;
      if (record.nonce !== nonce) throw fail();
      records.push(record);
    } catch (error) {
      if (await bothAbsent(state, nonce)) continue;
      throw error;
    }
  }
  for (const record of records) {
    signal.throwIfAborted();
    assertLifetime(state, globalLifetime);
    try {
      await checkRecord(state, record);
      await withInstallLock(
        entryPath(state, record.nonce),
        signal,
        keydBootstrapLeaseAcquirer(verifiedKeydPath),
        (lifetime) => retire(state, record, lifetime),
      );
    } catch (error) {
      if (error instanceof BootstrapLeaseBusy) continue;
      if (await bothAbsent(state, record.nonce)) continue;
      throw error;
    }
  }
}
