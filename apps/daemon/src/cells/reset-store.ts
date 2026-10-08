import { ComputerResetRecord } from "../../../../packages/protocol/src/computer-reset.ts";
import { PrivateRecords } from "../agent/safety/private-records.ts";

export class ComputerResetStore {
  readonly #records: PrivateRecords<ComputerResetRecord>;
  constructor(home: string) {
    this.#records = new PrivateRecords(home, "computer-resets", (raw, id) => {
      const record = ComputerResetRecord.parse(raw);
      if (record.requestId !== id) throw new Error("Reset request owner mismatch");
      return record;
    });
  }
  list() {
    return this.#records.list();
  }
  read(id: string) {
    return this.#records.read(id);
  }
  write(input: ComputerResetRecord) {
    const record = ComputerResetRecord.parse(input),
      before = this.#records.read(record.requestId);
    const phases = ["retiring", "retired", "creating", "ready"];
    if (before) {
      if (
        JSON.stringify({ ...before, phase: record.phase }) !== JSON.stringify(record) ||
        ![phases.indexOf(before.phase), phases.indexOf(before.phase) + 1].includes(
          phases.indexOf(record.phase),
        )
      )
        throw new Error("Reset ownership or phase changed");
    } else if (record.phase !== "retiring") throw new Error("Missing reset intent");
    this.#records.write(record.requestId, record);
  }
}
