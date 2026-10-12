import { existsSync } from "node:fs";
import { join } from "node:path";
import { FenceRecord } from "./agent/safety/fences.ts";
import { NativeBootRecords, readNativeBoot } from "./agent/safety/native-boot.ts";
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
    const boot = readNativeBoot();
    const boots = existsSync(join(home, "safety", "native-boots"))
      ? new NativeBootRecords(home)
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
        pendingAction: "recover-computer" as const,
        detail: `Computer ${record.cellId}, task ${record.sessionId}: earlier cleanup was not confirmed. ${
          record.executor === "native" && !record.nativeRetired
            ? nativeRecoveryAdvice(record, boot, boots)
            : "Task retirement is confirmed. Use Replace computer to recover the saved apps and files."
        }`,
      }));
  } catch {
    return [
      {
        name: "computer-recovery",
        ok: false,
        pendingAction: "recover-computer" as const,
        detail:
          "Recovery records could not be read. Keep the safety and computer folders intact; share this diagnostic.",
      },
    ];
  }
}

function nativeRecoveryAdvice(
  record: FenceRecord,
  boot: ReturnType<typeof readNativeBoot>,
  boots: NativeBootRecords | undefined,
): string {
  const saved = boots?.read(record.cellId);
  let advice =
    "No verified system-restart record is available. Keep the saved computer data; share this diagnostic.";
  if (
    boot &&
    saved?.host === boot.host &&
    saved.sessionId === record.sessionId &&
    saved.revision === record.revision
  ) {
    advice =
      saved.boot === boot.boot
        ? "Restart this machine, run localdot up, then use Replace computer. Your saved computer data is kept."
        : "The system has restarted. Run localdot up to check recovery, then use Replace computer.";
  }
  return `Native task exit has not been confirmed. ${advice}`;
}
