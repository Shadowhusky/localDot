import { type ReplacementRecord, ReplacementRecord as Schema } from "@localdot/protocol";
import { PrivateRecords } from "./private-records.ts";
export class ReplacementStore {
  readonly #records: PrivateRecords<ReplacementRecord>;
  constructor(home: string) {
    this.#records = new PrivateRecords(home, "replacements", (value, id) => {
      const record = Schema.parse(value);
      if (record.requestId !== id) throw new Error("replacement record owner mismatch");
      return record;
    });
  }
  read(requestId: string): ReplacementRecord | undefined {
    return this.#records.read(requestId);
  }
  list(): ReplacementRecord[] {
    return this.#records.list();
  }
  write(record: ReplacementRecord): void {
    this.#records.write(record.requestId, record);
  }
}
