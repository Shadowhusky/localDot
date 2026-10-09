import { type RoutineAppEvent, StopAllOutcome, stopOutcomeConfirmed } from "@localdot/protocol";
import type { CellApi } from "../cells/orchestrator.ts";
// KillSwitch's own outcome type (errors: string[]); StopAllOutcome.parse checks the error strings.
import type { KillSwitch, StopOutcome } from "../gateway/kill-switch.ts";
import type { LiveSessions } from "../gateway/live.ts";
import type { RoutineLauncher } from "./launch.ts";
import type { RoutineScheduler } from "./scheduler.ts";
import type { StopAllAudit } from "./stop-all-audit.ts";
import type { RoutineStore } from "./store.ts";

export interface StopAllDeps {
  cells: Pick<CellApi, "list">;
  live: Pick<LiveSessions, "get">;
  killSwitch: Pick<KillSwitch, "stopSession" | "stopIdleCell">;
  store: Pick<RoutineStore, "pauseAllActive" | "get">;
  launcher: Pick<RoutineLauncher, "cancelAll">;
  scheduler: Pick<RoutineScheduler, "replan">;
  audit: StopAllAudit;
  publish(event: RoutineAppEvent): void;
  now(): number;
}

/** Pauses every routine first, so nothing new starts, then stops every task and freezes every
 * computer. Calling it again changes nothing new and still reports what is confirmed.
 */
export async function stopAll(deps: StopAllDeps, by: "user" | "cli"): Promise<StopAllOutcome> {
  const paused = deps.store.pauseAllActive("stop_all");
  const launchesCancelled = deps.launcher.cancelAll();
  deps.scheduler.replan();
  const sessions: { sessionId: string; cellId: string; outcome: StopOutcome | null }[] = [];
  const cells: { cellId: string; outcome: StopOutcome }[] = [];
  await Promise.all(
    deps.cells
      .list()
      .filter((cell) => cell.state !== "removed")
      .map(async (cell) => {
        const sessionId = deps.live.get(cell.id);
        if (sessionId) {
          const outcome = await deps.killSwitch.stopSession(sessionId).catch(() => null);
          if (outcome !== undefined) {
            sessions.push({ sessionId, cellId: cell.id, outcome });
            return;
          }
        }
        // No task, or its task ended in between: freeze the computer itself.
        const outcome = await deps.killSwitch.stopIdleCell(cell.id).catch(() => undefined);
        if (outcome) cells.push({ cellId: cell.id, outcome });
      }),
  );
  const confirmed =
    sessions.every((row) => row.outcome !== null && stopOutcomeConfirmed(row.outcome)) &&
    cells.every((row) => stopOutcomeConfirmed(row.outcome));
  const outcome = StopAllOutcome.parse({
    sessions,
    cells,
    routinesPaused: paused.length,
    launchesCancelled,
    confirmed,
  });
  try {
    deps.audit.append({ at: deps.now(), by, outcome });
  } catch {
    console.error("the Stop everything audit line could not be written");
  }
  for (const id of paused) {
    const routine = deps.store.get(id);
    if (routine)
      deps.publish({
        type: "routine.changed",
        routineId: id,
        revision: routine.revision,
        state: routine.state,
      });
  }
  return outcome;
}
