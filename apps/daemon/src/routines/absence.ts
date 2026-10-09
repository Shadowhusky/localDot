import type { RoutineAppEvent } from "@localdot/protocol";
import type { RoutineGate } from "./scheduler.ts";
import type { RoutineStore, StoredRoutine } from "./store.ts";

export const ABSENCE_MS = 14 * 86_400_000;

/** Nobody has opened a routine's results for 14 days: ask before running it again, and pause it
 * if the question is still unanswered at the following due time. Follow-ups are exempt.
 */
export class AbsenceGuard implements RoutineGate {
  constructor(
    private readonly deps: {
      store: RoutineStore;
      publish(event: RoutineAppEvent): void;
      now(): number;
    },
  ) {}
  intercept(routine: StoredRoutine, dueAt: number): boolean {
    if (routine.kind !== "routine") return false;
    const { store, publish } = this.deps;
    const now = this.deps.now();
    if (now - (routine.lastSeenAt ?? routine.createdAt) < ABSENCE_MS) return false;
    if (routine.absenceAskedAt === null) {
      store.setAbsenceAsked(routine.id, now);
      const run = store.recordRun({
        routineId: routine.id,
        dueAt,
        startedAt: null,
        endedAt: now,
        sessionId: null,
        outcome: "needs_you",
        note: `Asked: keep running ${routine.name}?`,
      });
      publish({
        type: "routine.run",
        routineId: routine.id,
        runId: run.id,
        outcome: "needs_you",
        sessionId: null,
        notify: true,
        title: `Keep running ${routine.name}?`,
      });
      return true;
    }
    const paused = store.setState(routine.id, "paused", "absence");
    const run = store.recordRun({
      routineId: routine.id,
      dueAt,
      startedAt: null,
      endedAt: now,
      sessionId: null,
      outcome: "skipped",
      note: "Paused: nobody answered Keep running?",
    });
    publish({
      type: "routine.changed",
      routineId: routine.id,
      revision: paused.revision,
      state: paused.state,
    });
    publish({
      type: "routine.run",
      routineId: routine.id,
      runId: run.id,
      outcome: "skipped",
      sessionId: null,
      notify: false,
      title: `${routine.name}: Paused`,
    });
    return true;
  }
}
