import { existsSync } from "node:fs";
import { join } from "node:path";
import { FenceRecord } from "./agent/safety/fences.ts";
import { PrivateRecords } from "./agent/safety/private-records.ts";
import { ReplacementStore } from "./agent/safety/replacement-store.ts";
import type { DoctorCheck } from "./doctor.ts";

export function recoveryChecks(home: string): DoctorCheck[] {
  if (!existsSync(join(home, "safety", "fences"))) return [];
  try {
    const records = new PrivateRecords(home, "fences", (raw, id) => {
      const record = FenceRecord.parse(raw);
      if (record.cellId !== id) throw new Error("wrong fence owner");
      return record;
    }).list();
    const replacements = existsSync(join(home, "safety", "replacements"))
      ? new ReplacementStore(home)
      : undefined;
    return records
      .filter(
        (record) =>
          !record.replacementRequest ||
          replacements?.read(record.replacementRequest)?.phase !== "ready",
      )
      .map((record) => ({
        name: "computer-recovery",
        ok: false,
        detail: `Computer ${record.cellId}, task ${record.sessionId}: earlier cleanup was not confirmed. ${
          record.executor === "native" && !record.nativeRetired
            ? "Native task exit has not been confirmed. Keep the saved computer data; share this diagnostic before retrying recovery."
            : "Task retirement is confirmed. Use Replace computer to recover the saved apps and files."
        }`,
      }));
  } catch {
    return [
      {
        name: "computer-recovery",
        ok: false,
        detail:
          "Recovery records could not be read. Keep the safety and computer folders intact; share this diagnostic.",
      },
    ];
  }
}
