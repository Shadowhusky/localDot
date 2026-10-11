import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { type DockerClient, DockerError } from "./docker.ts";
import { runtimeCandidateIdentity, runtimeCandidateSpec } from "./runtime-update-candidate.ts";
import {
  preparedRuntimeRecord,
  RuntimeImages,
  type RuntimeUpdateJournal,
  type RuntimeUpdateStore,
  runtimeSource,
} from "./runtime-update-store.ts";
import { requireUnmodifiedSystem } from "./system-state.ts";
import type { CellRecord } from "./types.ts";

type Role = "gate" | "desktop";
type Raw = Record<string, unknown>;
const object = (raw: unknown): raw is Raw =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);
const failure = () =>
  new Error("Computer runtime update is unconfirmed; keep this computer stopped");
const route = (kind: string, id: string, inspect = false) =>
  `/${kind}/${encodeURIComponent(id)}${inspect && kind === "containers" ? "/json" : ""}`;
const roles = ["gate", "desktop"] as const;

export interface RuntimeUpdateHost {
  docker: Pick<DockerClient, "request">;
  journal: Pick<RuntimeUpdateStore, "read" | "write">;
  signal?: AbortSignal;
  readCell(id: string): CellRecord | undefined;
  saveCell(record: CellRecord): void | Promise<void>;
  /** Must prove exclusive update ownership, closed admission, drained executors and absent
   * key listeners. Called before each mutation. A stopped Docker container alone is insufficient. */
  assertQuiescent(id: string): Promise<void>;
}

/** Replace only stopped executable containers. Networks, home, browser profile, tokens and cell
 * identity are retained. No start, volume creation/deletion or ordinary reconciliation occurs.
 * The caller must keep its installation/admission lock until selected-release startup completes.
 * An interrupted target must be prepared first, while stopped, before preparing a rollback target. */
export async function prepareDesktopRuntime(
  host: RuntimeUpdateHost,
  input: { cellId: string; images: RuntimeUpdateJournal["images"]; fullcolor: boolean },
): Promise<CellRecord> {
  // Snapshot caller values before the first await. Never expose raw Docker/config errors.
  try {
    return await prepare(host, structuredClone(input));
  } catch {
    throw failure();
  }
}

async function prepare(
  host: RuntimeUpdateHost,
  input: Parameters<typeof prepareDesktopRuntime>[1],
): Promise<CellRecord> {
  host.signal?.throwIfAborted();
  const images = RuntimeImages.parse(input.images);
  if (typeof input.fullcolor !== "boolean") throw failure();
  let journal = host.journal.read(input.cellId);
  const current = runtimeSource(host.readCell(input.cellId));
  if (current.id !== input.cellId) throw failure();
  await host.assertQuiescent(input.cellId);
  if (
    !journal ||
    (journal.phase === "prepared" &&
      (!equal(journal.images, images) || journal.fullcolor !== input.fullcolor))
  ) {
    const fresh: RuntimeUpdateJournal = {
      v: 1,
      operationId: randomUUID(),
      source: current,
      images,
      fullcolor: input.fullcolor,
      phase: "retiring",
      candidates: { gate: null, desktop: null },
    };
    if (journal && !equal(preparedRuntimeRecord(journal), current)) throw failure();
    await retained(fresh);
    // A fresh update cannot invent missing originals; only durable intent permits retrying retirement.
    for (const role of roles) if (!(await original(fresh, role))) throw failure();
    await requireUnmodifiedSystem(host.docker, current.ownership?.desktop ?? "");
    await host.assertQuiescent(input.cellId);
    host.signal?.throwIfAborted();
    if (
      !equal(host.readCell(input.cellId), current) ||
      !equal(host.journal.read(input.cellId), journal)
    )
      throw failure();
    host.journal.write(fresh);
    journal = fresh;
  }
  if (!equal(journal.images, images) || journal.fullcolor !== input.fullcolor) throw failure();
  let active = journal;
  function check(): void {
    host.signal?.throwIfAborted();
    if (!equal(host.journal.read(input.cellId), active)) throw failure();
    const now = runtimeSource(host.readCell(input.cellId));
    if (
      !equal(now, active.source) &&
      !(active.phase === "prepared" && equal(now, preparedRuntimeRecord(active)))
    )
      throw failure();
  }
  async function beforeMutation(): Promise<void> {
    check();
    await host.assertQuiescent(input.cellId);
    check();
    await retained(active);
    check();
  }
  function save(next: RuntimeUpdateJournal): void {
    check();
    host.journal.write(next);
    active = next;
    check();
  }
  check();
  await retained(active);
  if (active.phase === "retiring") {
    // Validate both before the first DELETE, then freshly validate each exact stopped identity.
    for (const role of roles) await original(active, role);
    if (await original(active, "desktop"))
      await requireUnmodifiedSystem(host.docker, active.source.ownership?.desktop ?? "");
    for (const role of roles) {
      await beforeMutation();
      if (!(await original(active, role))) continue;
      const id = active.source.ownership?.[role];
      if (!id) throw failure();
      try {
        // Docker itself refuses a concurrently started container. Never force or remove volumes.
        await host.docker.request({ method: "DELETE", path: route("containers", id) });
      } catch {
        if (await original(active, role)) throw failure();
      }
      if (await original(active, role)) throw failure();
    }
    save({ ...active, phase: "creating" });
  }
  for (const role of roles) {
    if (active.phase === "prepared") break;
    await beforeMutation();
    let id = await candidate(active, role);
    if (!id) {
      if (active.candidates[role] !== null) throw failure();
      const spec = runtimeCandidateSpec(active, role);
      try {
        await host.docker.request({
          method: "POST",
          path: "/containers/create",
          query: { name: active.source.docker[role] },
          body: spec,
        });
      } catch {
        // Name + unpredictable persisted operation label + spec is the recovery authority when
        // a create reply is lost. A different operation's container must never be adopted.
      }
      id = await candidate(active, role);
      if (!id) throw failure();
    }
    save({ ...active, candidates: { ...active.candidates, [role]: id } });
  }
  for (const role of roles) if (!(await candidate(active, role))) throw failure();
  if (active.phase !== "prepared") save({ ...active, phase: "prepared" });
  await beforeMutation();
  const prepared = preparedRuntimeRecord(active);
  if (!equal(host.readCell(input.cellId), prepared)) await host.saveCell(prepared);
  check();
  if (!equal(host.readCell(input.cellId), prepared)) throw failure();
  // Prepared is not Ready: the ordinary startup owner must wire keyd, attach the gate and self-test.
  return prepared;

  async function read(kind: string, id: string): Promise<Raw | undefined> {
    host.signal?.throwIfAborted();
    try {
      const raw = await host.docker.request<unknown>({
        method: "GET",
        path: route(kind, id, true),
      });
      if (!object(raw)) throw failure();
      return raw;
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return undefined;
      throw error;
    }
  }
  function labels(raw: Raw, cell: string, role: string, container: boolean): void {
    const config = object(raw.Config) ? raw.Config : undefined;
    const found = container ? config?.Labels : raw.Labels;
    if (!object(found) || found["localdot.cell"] !== cell || found["localdot.role"] !== role)
      throw failure();
  }
  function stopped(raw: Raw): void {
    if (
      !object(raw.State) ||
      raw.State.Running !== false ||
      raw.State.Paused !== false ||
      raw.State.Restarting !== false
    )
      throw failure();
  }
  async function original(j: RuntimeUpdateJournal, role: Role): Promise<boolean> {
    const id = j.source.ownership?.[role];
    if (!id) throw failure();
    const named = await read("containers", j.source.docker[role]);
    const raw = named ?? (await read("containers", id));
    if (!raw) return false;
    if (raw.Id !== id) throw failure();
    labels(raw, j.source.id, role, true);
    stopped(raw);
    return true;
  }
  async function candidate(j: RuntimeUpdateJournal, role: Role): Promise<string | undefined> {
    const raw = await read("containers", j.source.docker[role]);
    if (!raw) {
      // A recorded candidate that vanished or was renamed requires attention, never recreation.
      if (j.candidates[role]) throw failure();
      return undefined;
    }
    const id = runtimeCandidateIdentity(j, role, raw);
    stopped(raw);
    return id;
  }
  async function retained(j: RuntimeUpdateJournal): Promise<void> {
    const d = j.source.docker;
    if (j.phase !== "retiring") {
      for (const role of roles) {
        const id = j.source.ownership?.[role];
        if (!id || (await read("containers", id))) throw failure();
      }
    }
    for (const [field, role] of [
      ["internalNetwork", "internal"],
      ["egressNetwork", "egress"],
    ] as const) {
      const raw = await read("networks", d[field]);
      if (!raw || raw.Id !== j.source.ownership?.[field]) throw failure();
      labels(raw, j.source.id, role, false);
    }
    const volume = await read("volumes", d.homeVolume);
    if (!volume || volume.Name !== d.homeVolume) throw failure();
    labels(volume, j.source.id, "home", false);
    const mounts = await host.docker.request<unknown>({
      method: "GET",
      path: "/containers/json",
      query: { all: "true", filters: JSON.stringify({ volume: [d.homeVolume] }) },
    });
    // During lost-create recovery the unrecorded desktop candidate may already mount the home.
    const allowed = new Set([j.source.ownership?.desktop, j.candidates.desktop]);
    if (!Array.isArray(mounts)) throw failure();
    for (const mount of mounts) {
      if (!object(mount) || typeof mount.Id !== "string") throw failure();
      if (
        !allowed.has(mount.Id) &&
        (j.phase === "retiring" || mount.Id !== (await candidate(j, "desktop")))
      )
        throw failure();
    }
  }
}
