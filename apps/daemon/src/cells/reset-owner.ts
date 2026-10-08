import { ULID_PATTERN } from "@localdot/protocol";
import {
  ComputerResetRecord,
  ComputerResetRequest,
  type ComputerResetSource,
} from "../../../../packages/protocol/src/computer-reset.ts";
import type { ComputerResetStore } from "./reset-store.ts";

export interface ComputerResetHost {
  store: Pick<ComputerResetStore, "read" | "list" | "write">;
  allocateId(): string;
  /** Independent durable admission fence for both IDs; permanent for the old computer.
   * Retain request binding so losing the transaction record cannot reopen admission. */
  hold(oldCellId: string, newCellId: string, requestId: string): void;
  expectedRequests(): { oldCellId: string; newCellId: string; requestId: string }[];
  closeAdmission(): void;
  capture(oldCellId: string): ComputerResetSource;
  /** Drain executors/grants, retire exact snapshot resources and erase both old volumes. */
  retireOld(record: ComputerResetRecord): Promise<void>;
  oldAbsent(record: ComputerResetRecord): Promise<boolean>;
  inspectFresh(record: ComputerResetRecord): Promise<"absent" | "owned" | "ready" | "foreign">;
  createFresh(record: ComputerResetRecord): Promise<void>;
  retireFresh(record: ComputerResetRecord): Promise<void>;
  publish(record: ComputerResetRecord): void;
}
const fail = () => new Error("Computer reset is unconfirmed. Retry the same request explicitly.");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One daemon-owned coordinator. Startup restores holds only; it never resumes destructive work.
 * Every explicit retry uses the recorded source/candidate, and a ready request never resets again.
 */
export class ComputerResetOwner {
  readonly #old = new Map<string, string>();
  readonly #ids = new Set<string>();
  readonly #active = new Map<string, Promise<ComputerResetRecord>>();
  #available = false;
  constructor(private readonly host: ComputerResetHost) {
    try {
      const rows = host.store.list().map((row) => ComputerResetRecord.parse(row));
      for (const expected of host.expectedRequests())
        if (
          !rows.some(
            (row) =>
              row.oldCellId === expected.oldCellId &&
              row.newCellId === expected.newCellId &&
              row.requestId === expected.requestId,
          )
        )
          throw fail();
      const requests = new Set<string>(),
        candidates = new Set<string>();
      for (const row of rows) {
        if (
          this.#old.has(row.oldCellId) ||
          requests.has(row.requestId) ||
          candidates.has(row.newCellId)
        )
          throw fail();
        this.#old.set(row.oldCellId, row.requestId);
        requests.add(row.requestId);
        candidates.add(row.newCellId);
        this.#ids.add(row.oldCellId);
        this.#ids.add(row.newCellId);
      }
      const edges = new Map(rows.map((row) => [row.oldCellId, row.newCellId]));
      for (const row of rows) {
        const seen = new Set<string>();
        let id: string | undefined = row.oldCellId;
        while (id !== undefined) {
          if (seen.has(id)) throw fail();
          seen.add(id);
          id = edges.get(id);
        }
      }
      for (const row of rows) host.hold(row.oldCellId, row.newCellId, row.requestId);
      this.#available = true;
    } catch {
      host.closeAdmission();
    }
  }
  /** Call after ordinary cell reconciliation. Only verified completed candidates can be
   * republished; incomplete records retain their holds until an explicit same-request retry. */
  async restoreReady(): Promise<void> {
    if (!this.#available) throw fail();
    for (const raw of this.host.store.list()) {
      const record = ComputerResetRecord.parse(raw);
      if (record.phase !== "ready" || this.#old.has(record.newCellId)) continue;
      if (this.#old.get(record.oldCellId) !== record.requestId) throw fail();
      await this.#run(record);
    }
  }
  status(oldCellId: string, requestId: string): ComputerResetRecord | undefined {
    if (
      !this.#available ||
      oldCellId.length !== 26 ||
      requestId.length !== 26 ||
      !ULID_PATTERN.test(oldCellId) ||
      !ULID_PATTERN.test(requestId)
    )
      throw fail();
    const row = this.host.store.read(requestId);
    if (!row) {
      if (this.#old.get(oldCellId) === requestId) {
        this.#available = false;
        this.host.closeAdmission();
        throw fail();
      }
      return undefined;
    }
    const record = ComputerResetRecord.parse(row);
    if (record.oldCellId !== oldCellId || this.#old.get(oldCellId) !== requestId) throw fail();
    return record;
  }
  reset(oldCellId: string, input: ComputerResetRequest): Promise<ComputerResetRecord> {
    if (!this.#available || oldCellId.length !== 26 || !ULID_PATTERN.test(oldCellId))
      return Promise.reject(fail());
    let request: ComputerResetRequest;
    try {
      request = ComputerResetRequest.parse(input);
    } catch {
      return Promise.reject(fail());
    }
    const pending = this.#active.get(oldCellId);
    if (pending)
      return this.#old.get(oldCellId) === request.requestId ? pending : Promise.reject(fail());
    const existingRequest = this.#old.get(oldCellId);
    if (existingRequest && existingRequest !== request.requestId) return Promise.reject(fail());
    let record: ComputerResetRecord;
    try {
      const stored = this.host.store.read(request.requestId);
      if (stored) {
        record = ComputerResetRecord.parse(stored);
        if (record.oldCellId !== oldCellId || existingRequest !== request.requestId) throw fail();
      } else {
        if (existingRequest) throw fail();
        const newCellId = this.host.allocateId();
        if (
          newCellId === oldCellId ||
          this.#ids.has(newCellId) ||
          newCellId.length !== 26 ||
          !ULID_PATTERN.test(newCellId)
        )
          throw fail();
        this.host.hold(oldCellId, newCellId, request.requestId);
        record = ComputerResetRecord.parse({
          v: 1,
          requestId: request.requestId,
          oldCellId,
          newCellId,
          source: this.host.capture(oldCellId),
          phase: "retiring",
        });
        // Reserve before a write whose acknowledgement could be lost. No other request may
        // acquire the same old computer while the status of this write is uncertain.
        this.#old.set(oldCellId, request.requestId);
        this.#ids.add(oldCellId);
        this.#ids.add(newCellId);
        this.host.store.write(record);
      }
    } catch {
      return Promise.reject(fail());
    }
    const work = this.#run(record);
    this.#active.set(oldCellId, work);
    void work
      .finally(() => {
        if (this.#active.get(oldCellId) === work) this.#active.delete(oldCellId);
      })
      .catch(() => {});
    return work;
  }
  #check(record: ComputerResetRecord) {
    if (!this.#available || !same(this.host.store.read(record.requestId), record)) throw fail();
  }
  #save(record: ComputerResetRecord, phase: ComputerResetRecord["phase"]) {
    this.#check(record);
    const next = ComputerResetRecord.parse({ ...record, phase });
    this.host.store.write(next);
    this.#check(next);
    return next;
  }
  async #run(input: ComputerResetRecord): Promise<ComputerResetRecord> {
    let record = input;
    try {
      this.#check(record);
      if (record.phase === "ready") {
        // A later reset of the candidate must never be undone by replaying this old request.
        if (!this.#old.has(record.newCellId)) {
          if (!(await this.host.oldAbsent(record))) throw fail();
          if ((await this.host.inspectFresh(record)) !== "ready") throw fail();
          this.#check(record);
          this.host.publish(record);
        }
        return record;
      }
      this.host.hold(record.oldCellId, record.newCellId, record.requestId);
      if (record.phase === "retiring") {
        // A candidate-name collision must be discovered before erasing the old computer.
        if ((await this.host.inspectFresh(record)) !== "absent") throw fail();
        this.#check(record);
        await this.host.retireOld(record);
        this.#check(record);
        if (!(await this.host.oldAbsent(record))) throw fail();
        record = this.#save(record, "retired");
      }
      if (!(await this.host.oldAbsent(record))) throw fail();
      this.#check(record);
      let fresh = await this.host.inspectFresh(record);
      this.#check(record);
      if (fresh === "foreign") throw fail();
      if (record.phase === "retired") {
        // Nothing was authorized to exist at the candidate identity before creating was saved.
        if (fresh !== "absent") throw fail();
        record = this.#save(record, "creating");
      } else if (fresh === "owned") {
        await this.host.retireFresh(record);
        this.#check(record);
        fresh = await this.host.inspectFresh(record);
        if (fresh !== "absent") throw fail();
      }
      if (fresh === "absent") {
        await this.host.createFresh(record);
        this.#check(record);
      }
      if ((await this.host.inspectFresh(record)) !== "ready") throw fail();
      this.#check(record);
      if (!(await this.host.oldAbsent(record))) throw fail();
      record = this.#save(record, "ready");
      this.host.publish(record);
      return record;
    } catch {
      throw fail();
    }
  }
}
