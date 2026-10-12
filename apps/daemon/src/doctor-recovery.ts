import { existsSync } from "node:fs";
import { join } from "node:path";
import { FenceRecord } from "./agent/safety/fences.ts";
import { NativeBootRecords, readNativeBoot } from "./agent/safety/native-boot.ts";
import { type NativeTaskState, nativeTaskState } from "./agent/safety/native-tasks.ts";
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
            ? nativeRecoveryAdvice(
                record,
                boot,
                boots,
                nativeTaskState(home, record.cellId, record.sessionId),
              )
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
  state: NativeTaskState,
): string {
  if (state === "exited")
    return "The recorded native task process group has exited. Run localdot doctor --fix to save recovery confirmation, then use Replace computer. Your saved apps and files are kept.";
  if (state === "alive")
    return "The recorded native task process group is still running. Run localdot doctor --fix to stop localDot and recheck. Recovery will not be confirmed while that group is alive.";
  const manual = `If you have independently confirmed that the old task is gone, run localdot down, then localdot recover --cell ${record.cellId} --confirm-native-exit. This saves your confirmation without deleting computer data.`;

  const saved = boots?.read(record.cellId);
  let advice = `No verified system-restart record is available; the task's original boot is unknown. ${manual}`;
  if (
    boot &&
    saved?.host === boot.host &&
    saved.sessionId === record.sessionId &&
    saved.revision === record.revision
  ) {
    advice =
      saved.boot === boot.boot
        ? "Run localdot doctor --fix first. If native task exit is still unconfirmed, restart this machine, run localdot up, then use Replace computer. Your saved computer data is kept. " +
          manual
        : "The system has restarted. Run localdot up to check recovery, then use Replace computer.";
  }
  return `Native task exit has not been confirmed (${state === "legacy" ? "this older task has no saved process identity" : "process evidence is incomplete or unavailable"}); stopped Docker containers do not confirm host task exit. ${advice}`;
}
