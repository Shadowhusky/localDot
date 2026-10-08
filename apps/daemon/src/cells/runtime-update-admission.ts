import { isDeepStrictEqual as equal } from "node:util";
import {
  preparedRuntimeRecord,
  RuntimeImages,
  type RuntimeUpdateJournal,
  RuntimeUpdateStore,
} from "./runtime-update-store.ts";
import type { CellRecord } from "./types.ts";

const failure = () => new Error("Computer runtime update recovery is incomplete.");

/** Construct before ordinary reconciliation. Prepared records are still held after a restart
 * until their cell identity and selected-release images are freshly checked. No destructive
 * recovery or automatic target selection happens here. */
export class RuntimeUpdateAdmission {
  readonly #records = new Map<string, RuntimeUpdateJournal>();
  readonly #released = new Set<string>();
  readonly #retired = new Set<string>();
  #store?: RuntimeUpdateStore;
  #closed = false;
  constructor(home: string) {
    try {
      this.#store = new RuntimeUpdateStore(home);
      for (const row of this.#store.list()) this.#records.set(row.source.id, row);
    } catch {
      this.#closed = true;
    }
  }
  held(id: string): boolean {
    return this.#closed || (this.#records.has(id) && !this.#released.has(id));
  }
  creationAllowed(): boolean {
    return !this.#closed && this.#records.size === this.#released.size + this.#retired.size;
  }
  #unchanged(): void {
    try {
      if (this.#closed || !this.#store) throw failure();
      const rows = this.#store.list();
      if (
        rows.length !== this.#records.size ||
        rows.some((row) => !equal(this.#records.get(row.source.id), row))
      )
        throw failure();
    } catch {
      this.#closed = true;
      throw failure();
    }
  }
  async restorePrepared(input: {
    images: { desktop: string; gate: string } | undefined;
    readCell(id: string): CellRecord | undefined;
    verify(record: CellRecord): Promise<void>;
    canPublish(): boolean;
    // Only a durable permanent fence/reset binding qualifies, never a transient unavailable flag.
    retired?(id: string): boolean;
  }): Promise<void> {
    this.#unchanged();
    if (!this.#records.size) return;
    const images = RuntimeImages.parse(input.images);
    // Validate every journal before releasing any computer. An unfinished update remains held.
    const retired = [...this.#records.keys()].filter((id) => input.retired?.(id) === true);
    const prepared = [...this.#records.values()]
      .filter((row) => !retired.includes(row.source.id))
      .map((row) => {
        if (row.phase !== "prepared" || !equal(row.images, images)) throw failure();
        const record = preparedRuntimeRecord(row);
        if (!equal(input.readCell(record.id), record)) throw failure();
        return record;
      });
    for (const record of prepared) {
      if (!input.canPublish()) throw failure();
      await input.verify(structuredClone(record));
      this.#unchanged();
    }
    if (!input.canPublish()) throw failure();
    if (retired.some((id) => input.retired?.(id) !== true)) throw failure();
    if (prepared.some((record) => !equal(input.readCell(record.id), record))) throw failure();
    for (const record of prepared) this.#released.add(record.id);
    for (const id of retired) this.#retired.add(id);
  }
}
