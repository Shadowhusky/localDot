import { ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { ComputerResetRecord } from "../../../../packages/protocol/src/computer-reset.ts";
import { PrivateRecords } from "../agent/safety/private-records.ts";
import { ComputerResetStore } from "./reset-store.ts";

const Id = z.string().length(26).regex(ULID_PATTERN);
const Binding = z
  .strictObject({ requestId: Id, oldCellId: Id, newCellId: Id })
  .refine((value) => value.oldCellId !== value.newCellId, "reset identity must change");
type Binding = z.infer<typeof Binding>;
const failure = () => new Error("Computer reset admission is unavailable");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Independent deny-only receipt. Old identities never reopen. A candidate is held until its
 * first publication from verified Ready, which leaves a durable release receipt; from then on it is
 * an ordinary computer and later restarts never re-confirm it. No deletion API. */
export class ComputerResetHolds {
  readonly #bindings = new Map<string, Binding>();
  readonly #old = new Map<string, string>();
  readonly #candidate = new Map<string, string>();
  readonly #released = new Set<string>();
  readonly #finalised = new Set<string>();
  readonly #listeners = new Set<(binding: Binding) => void>();
  #records?: PrivateRecords<Binding>;
  #receipts?: PrivateRecords<Binding>;
  #resets?: ComputerResetStore;
  #closed = false;
  constructor(home: string) {
    try {
      this.#records = new PrivateRecords(home, "computer-reset-holds", (raw, id) => {
        const binding = Binding.parse(raw);
        if (binding.requestId !== id) throw failure();
        return binding;
      });
      this.#receipts = new PrivateRecords(home, "computer-reset-releases", (raw, id) => {
        const binding = Binding.parse(raw);
        if (binding.requestId !== id) throw failure();
        return binding;
      });
      this.#resets = new ComputerResetStore(home);
      for (const binding of this.#records.list()) this.#remember(binding);
      for (const receipt of this.#receipts.list()) {
        if (
          !same(this.#bindings.get(receipt.requestId), receipt) ||
          this.#resets.read(receipt.requestId)?.phase !== "ready"
        )
          throw failure();
        this.#finalised.add(receipt.newCellId);
      }
    } catch {
      this.#closed = true;
    }
  }
  closeAdmission(): void {
    this.#closed = true;
  }
  oldHeld(id: string): boolean {
    return this.#closed || this.#old.has(id);
  }
  candidateHeld(id: string): boolean {
    return (
      this.#closed ||
      this.#old.has(id) ||
      (this.#candidate.has(id) && !this.#released.has(id) && !this.#finalised.has(id))
    );
  }
  /** Published in an earlier daemon run: an ordinary computer that is never re-confirmed. */
  finalised(id: string): boolean {
    return !this.#closed && !this.#old.has(id) && this.#finalised.has(id);
  }
  records(): Binding[] {
    if (this.#closed || !this.#records) throw failure();
    try {
      const rows = this.#records.list();
      if (
        rows.length !== this.#bindings.size ||
        rows.some((row) => !same(this.#bindings.get(row.requestId), row))
      )
        throw failure();
      return rows;
    } catch {
      this.#closed = true;
      throw failure();
    }
  }
  subscribe(listener: (binding: Binding) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #remember(binding: Binding) {
    const request = this.#bindings.get(binding.requestId),
      old = this.#old.get(binding.oldCellId),
      candidate = this.#candidate.get(binding.newCellId);
    if (
      (request && !same(request, binding)) ||
      (old && old !== binding.requestId) ||
      (candidate && candidate !== binding.requestId)
    )
      throw failure();
    // A chain of successive resets is valid, a cycle is not.
    let id: string | undefined = binding.newCellId;
    const seen = new Set([binding.oldCellId]);
    while (id !== undefined) {
      if (seen.has(id)) throw failure();
      seen.add(id);
      const next = this.#old.get(id);
      id = next ? this.#bindings.get(next)?.newCellId : undefined;
    }
    this.#bindings.set(binding.requestId, Object.freeze({ ...binding }));
    this.#old.set(binding.oldCellId, binding.requestId);
    this.#candidate.set(binding.newCellId, binding.requestId);
    this.#released.delete(binding.newCellId);
  }
  hold(oldCellId: string, newCellId: string, requestId: string): void {
    if (this.#closed || !this.#records) throw failure();
    const binding = Binding.parse({ requestId, oldCellId, newCellId });
    try {
      this.#remember(binding);
      for (const listener of this.#listeners) listener(Object.freeze({ ...binding }));
      const previous = this.#records.read(requestId);
      if (previous && !same(previous, binding)) throw failure();
      this.#records.write(requestId, binding);
      if (!same(this.#records.read(requestId), binding)) throw failure();
    } catch {
      this.#closed = true;
      throw failure();
    }
  }
  /** The production caller must freshly verify physical readiness before this publication gate.
   * A matching durable Ready record is necessary; it never substitutes for that runtime check. */
  publish(input: ComputerResetRecord): void {
    if (this.#closed || !this.#resets || !this.#receipts) throw failure();
    const receipts = this.#receipts,
      record = ComputerResetRecord.parse(input),
      binding = this.#bindings.get(record.requestId);
    try {
      if (
        record.phase !== "ready" ||
        !binding ||
        binding.oldCellId !== record.oldCellId ||
        binding.newCellId !== record.newCellId ||
        this.#old.has(record.newCellId) ||
        !same(this.#records?.read(record.requestId), binding) ||
        !same(this.#resets.read(record.requestId), record)
      )
        throw failure();
      const prior = receipts.read(record.requestId);
      if (prior && !same(prior, binding)) throw failure();
      receipts.write(record.requestId, binding);
      if (!same(receipts.read(record.requestId), binding)) throw failure();
      this.#released.add(record.newCellId);
    } catch {
      this.#released.delete(record.newCellId);
      throw failure();
    }
  }
}
