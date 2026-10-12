import {
  ReplacementRecord as RecordSchema,
  type ReplacementRecord,
  type ReplacementRequest,
  ReplacementRequest as RequestSchema,
  ULID_PATTERN,
} from "@localdot/protocol";
import type { ReplacementStore } from "./replacement-store.ts";

export type { ReplacementRecord } from "@localdot/protocol";
export interface ReplacementDeps {
  current(): { cellId: string; revision: number; fenced: boolean; taskEnded: boolean };
  save(record: ReplacementRecord): Promise<void>;
  retireOld(cellId: string): Promise<{ absent: boolean; revoked: boolean; streamClosed: boolean }>;
  allocateId(): string;
  createFresh(id: string): Promise<void>;
  retireFresh(id: string): Promise<void>;
}
function sameOwner(d: ReplacementDeps, owner: ReturnType<ReplacementDeps["current"]>): void {
  const current = d.current();
  if (
    current.cellId !== owner.cellId ||
    current.revision !== owner.revision ||
    !current.fenced ||
    !current.taskEnded
  )
    throw new Error("replacement owner changed");
}
export async function replaceFencedComputer(
  requestId: string,
  expectedRevision: number,
  d: ReplacementDeps,
): Promise<ReplacementRecord> {
  const owner = d.current();
  if (
    !ULID_PATTERN.test(requestId) ||
    !owner.fenced ||
    !owner.taskEnded ||
    owner.revision !== expectedRevision
  )
    throw new Error("replacement not admitted");
  let record: ReplacementRecord = RecordSchema.parse({
    requestId,
    oldCellId: owner.cellId,
    revision: owner.revision,
    phase: "retiring",
  });
  await d.save(record);
  sameOwner(d, owner);
  let retired: Awaited<ReturnType<ReplacementDeps["retireOld"]>>;
  try {
    retired = await d.retireOld(owner.cellId);
  } catch {
    retired = { absent: false, revoked: false, streamClosed: false };
  }
  if (!retired.absent || !retired.revoked || !retired.streamClosed) {
    record = { ...record, phase: "blocked", reason: "old_retirement" };
    await d.save(record);
    return record;
  }
  sameOwner(d, owner);
  record = { ...record, phase: "retired" };
  await d.save(record);
  sameOwner(d, owner);
  const newCellId = d.allocateId();
  if (newCellId === owner.cellId || !ULID_PATTERN.test(newCellId))
    throw new Error("replacement must have a fresh identity");
  record = { ...record, newCellId, phase: "allocating" };
  await d.save(record);
  try {
    sameOwner(d, owner);
    await d.createFresh(newCellId);
    sameOwner(d, owner);
    record = { ...record, phase: "ready" };
    await d.save(record);
    sameOwner(d, owner);
    return record;
  } catch {
    await d.retireFresh(newCellId);
    record = { ...record, phase: "blocked", reason: "new_creation" };
    await d.save(record);
    return record;
  }
}
export interface ReplacementOwnerDeps {
  onReady?(record: ReplacementRecord): void;
  store: Pick<ReplacementStore, "read" | "write" | "list">;
  expectedRequests?(): { oldCellId: string; requestId: string }[];
  forCell(id: string): ReplacementDeps & {
    inspectFresh(id: string): Promise<"ready" | "owned" | "absent" | "foreign">;
  };
}
export class ReplacementConflict extends Error {}
// One daemon owner serializes each old cell. Durable request IDs are retained forever within the bounded store.
export class ReplacementOwner {
  readonly #byOld = new Map<string, string>();
  readonly #requestOwners = new Map<string, { cellId: string; revision: number }>();
  readonly #active = new Map<string, Promise<ReplacementRecord>>();
  readonly #activeRevisions = new Map<string, number>();
  readonly #closed = new Set<string>();
  #starting?: Promise<void>;
  #unavailable = false;
  constructor(private readonly deps: ReplacementOwnerDeps) {}
  start(): Promise<void> {
    if (!this.#starting) this.#starting = this.#recover();
    return this.#starting;
  }
  async #recover(): Promise<void> {
    try {
      const records = this.deps.store.list(),
        groups = new Map<string, ReplacementRecord[]>();
      for (const expected of this.deps.expectedRequests?.() ?? []) {
        if (
          !records.some(
            (record) =>
              record.oldCellId === expected.oldCellId && record.requestId === expected.requestId,
          )
        )
          throw new Error("recorded replacement owner is missing");
      }
      for (const record of records) {
        const reserved = this.#requestOwners.get(record.requestId);
        if (
          reserved &&
          (reserved.cellId !== record.oldCellId || reserved.revision !== record.revision)
        )
          throw new Error("ambiguous replacement request owner");
        this.#requestOwners.set(record.requestId, {
          cellId: record.oldCellId,
          revision: record.revision,
        });
        const rows = groups.get(record.oldCellId) ?? [];
        rows.push(record);
        groups.set(record.oldCellId, rows);
      }
      for (const [oldCellId, rows] of groups) {
        const ready = rows.filter((record) => record.phase === "ready"),
          unsettled = rows.filter((record) => !this.#terminal(record));
        if (ready.length > 1 || unsettled.length > 1 || (ready.length && unsettled.length))
          throw new Error("ambiguous replacement owner");
        const record = ready[0] ?? unsettled[0] ?? rows.at(-1);
        if (!record) continue;
        this.#byOld.set(oldCellId, record.requestId);
        if (record.phase === "blocked") continue;
        const d = this.deps.forCell(oldCellId),
          current = d.current();
        if (!current.fenced || current.revision !== record.revision)
          throw new Error("replacement fence unavailable");
        if (record.newCellId) {
          // A completed replacement can later need recovery of its own. Its durable
          // fence belongs to that later lifecycle; it is no longer a partial candidate
          // whose home this historical request is allowed to purge or publish.
          const successor = this.deps.forCell(record.newCellId).current();
          if (
            record.phase === "ready" &&
            successor.cellId === record.newCellId &&
            successor.fenced &&
            successor.revision > 0
          )
            continue;
          const state = await d.inspectFresh(record.newCellId);
          if (state === "foreign") throw new Error("foreign replacement candidate");
          // Once published, the successor is the user's computer. A normal stop,
          // paused desktop or restarted key service must not turn it back into a
          // disposable partial allocation. Release the recovery hold and let the
          // normal computer lifecycle reconcile readiness without deleting data.
          if (
            record.phase === "ready" &&
            (state === "ready" || state === "owned") &&
            current.taskEnded
          ) {
            sameOwner(d, current);
            this.deps.store.write(record);
            sameOwner(d, current);
            this.deps.onReady?.(record);
            continue;
          }
          if (state !== "absent") await d.retireFresh(record.newCellId);
        }
        this.deps.store.write({
          ...record,
          phase: "blocked",
          reason: record.newCellId ? "new_creation" : "old_retirement",
        });
      }
    } catch {
      this.#unavailable = true;
      throw new ReplacementConflict("replacement recovery needs attention");
    }
  }

  #terminal(record: ReplacementRecord): boolean {
    return record.phase === "ready" || record.phase === "blocked";
  }
  async status(oldCellId: string, requestId: string): Promise<ReplacementRecord | undefined> {
    await this.start();
    if (this.#unavailable || this.#closed.has(oldCellId))
      throw new ReplacementConflict("replacement records unavailable");
    const record = this.deps.store.read(requestId);
    if (record && record.oldCellId !== oldCellId)
      throw new ReplacementConflict("replacement request owner mismatch");
    if (record?.phase === "ready" && this.#active.has(oldCellId))
      return { ...record, phase: "allocating" };
    return record;
  }
  async replace(oldCellId: string, raw: unknown): Promise<ReplacementRecord> {
    const body: ReplacementRequest = RequestSchema.parse(raw);
    await this.start();
    if (this.#unavailable || this.#closed.has(oldCellId))
      throw new ReplacementConflict("replacement admission is closed");
    const reserved = this.#requestOwners.get(body.requestId);
    if (reserved && (reserved.cellId !== oldCellId || reserved.revision !== body.oldRevision))
      throw new ReplacementConflict("replacement request owner mismatch");
    const inFlight = this.#active.get(oldCellId);
    if (inFlight && this.#byOld.get(oldCellId) === body.requestId) {
      if (this.#activeRevisions.get(oldCellId) !== body.oldRevision)
        throw new ReplacementConflict("replacement request owner mismatch");
      return inFlight;
    }
    const existing = this.deps.store.read(body.requestId);
    if (existing) {
      if (existing.oldCellId !== oldCellId || existing.revision !== body.oldRevision)
        throw new ReplacementConflict("replacement request owner mismatch");
      const active = this.#active.get(oldCellId);
      if (active && this.#byOld.get(oldCellId) === body.requestId) return active;
      if (!this.#terminal(existing))
        throw new ReplacementConflict("replacement is still uncertain");
      return existing;
    }
    const prior = this.#byOld.get(oldCellId);
    if (this.#active.has(oldCellId))
      throw new ReplacementConflict("replacement is already running");
    if (prior && this.deps.store.read(prior)?.phase !== "blocked")
      throw new ReplacementConflict("the computer already has a replacement");
    const d = this.deps.forCell(oldCellId),
      current = d.current();
    if (current.cellId !== oldCellId || !current.fenced || current.revision !== body.oldRevision)
      throw new ReplacementConflict("replacement not admitted");
    if (!current.taskEnded) throw new ReplacementConflict("previous task retirement unconfirmed");
    // Reserve the global request identity before queued persistence or effects can yield.
    // Keep the reservation after uncertain writes: another cell must never reuse that identity.
    this.#requestOwners.set(body.requestId, { cellId: oldCellId, revision: body.oldRevision });
    this.#byOld.set(oldCellId, body.requestId);
    // Publish the promise synchronously, before any retirement or creation can reenter the owner.
    const work = Promise.resolve().then(async () => {
      const result = await replaceFencedComputer(body.requestId, body.oldRevision, {
        ...d,
        save: async (record) => {
          this.deps.store.write(record);
        },
      });
      if (result.phase === "ready") this.deps.onReady?.(result);
      return result;
    });
    this.#active.set(oldCellId, work);
    this.#activeRevisions.set(oldCellId, body.oldRevision);
    try {
      return await work;
    } catch {
      this.#closed.add(oldCellId);
      throw new ReplacementConflict("replacement completion could not be confirmed");
    } finally {
      if (this.#active.get(oldCellId) === work) {
        this.#active.delete(oldCellId);
        this.#activeRevisions.delete(oldCellId);
      }
    }
  }
}
