import type { RoutineAppEvent } from "@localdot/protocol";
import { notifyFor, type RoutineLauncher } from "./launch.ts";
import { dueTimesBetween, nextDue } from "./schedule.ts";
import { type RoutineStore, type StoredRoutine, type StoredRun, scheduleOf } from "./store.ts";

export interface SchedulerClock {
  // Wall clock (Date.now).
  now(): number;
  // Monotonic (performance.now): it does not advance while the Mac sleeps.
  mono(): number;
  setTimeout(fn: () => void, ms: number): () => void;
  setInterval(fn: () => void, ms: number): () => void;
}
/** Decides a due run itself instead of launching it (the absence guard). */
export interface RoutineGate {
  intercept(routine: StoredRoutine, dueAt: number): boolean;
}
export interface SchedulerDeps {
  store: RoutineStore;
  launcher: Pick<RoutineLauncher, "launch" | "recoverInterrupted">;
  publish(event: RoutineAppEvent): void;
  clock: SchedulerClock;
  gate?: RoutineGate;
  graceMs?: number;
  wakeCheckMs?: number;
  driftMs?: number;
  missedRows?: number;
}
const DAY_MS = 86_400_000;

/** One timer for the earliest due routine. The next due time is persisted before a run is
 * launched, so a crash never launches the same due time twice. A wake from sleep (or a clock
 * moved forward) is noticed when the wall clock gets ahead of the monotonic one; due times passed
 * meanwhile follow each routine's missed-run policy.
 */
export class RoutineScheduler {
  #timer: (() => void) | undefined;
  #interval: (() => void) | undefined;
  #paused = false;
  #lastWall = 0;
  #lastMono = 0;
  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.deps.launcher.recoverInterrupted();
    this.#lastWall = this.deps.clock.now();
    this.#lastMono = this.deps.clock.mono();
    this.#interval = this.deps.clock.setInterval(
      () => this.#checkWake(),
      this.deps.wakeCheckMs ?? 30_000,
    );
    this.#safely();
  }
  stop(): void {
    this.#timer?.();
    this.#interval?.();
    this.#timer = this.#interval = undefined;
  }
  pause(): void {
    this.#paused = true;
    this.#timer?.();
    this.#timer = undefined;
  }
  resume(): void {
    this.#paused = false;
    this.replan();
  }

  replan(): void {
    if (this.#paused) return;
    this.#timer?.();
    this.#timer = undefined;
    const now = this.deps.clock.now();
    for (const routine of this.#active()) {
      // One routine that cannot be planned never holds up the others.
      try {
        const due = routine.nextDueAt ?? this.#plan(routine, now);
        if (due !== null && due <= now) this.#fire(routine, due, now);
      } catch {
        console.error("routines: a routine could not be planned");
      }
    }
    const upcoming = this.#active()
      .map((r) => r.nextDueAt)
      .filter((v): v is number => v !== null);
    if (upcoming.length)
      this.#timer = this.deps.clock.setTimeout(
        () => this.#safely(),
        Math.min(Math.max(Math.min(...upcoming) - now, 0), DAY_MS),
      );
  }

  #active(): StoredRoutine[] {
    return this.deps.store.list({ includeHidden: true }).filter((r) => r.state === "active");
  }
  #plan(routine: StoredRoutine, after: number): number | null {
    const due = nextDue(scheduleOf(routine), after);
    if (due === null) this.#finishRoutine(routine);
    else this.deps.store.setNextDue(routine.id, due);
    return due;
  }
  #finishRoutine(routine: StoredRoutine): void {
    const done = this.deps.store.setState(routine.id, "finished", null);
    this.deps.publish({
      type: "routine.changed",
      routineId: done.id,
      revision: done.revision,
      state: done.state,
    });
  }

  #fire(routine: StoredRoutine, due: number, now: number): void {
    const schedule = scheduleOf(routine);
    // Persist the next due time first: a crash after this point can never launch `due` twice.
    this.#plan(routine, now);
    if (now - due <= (this.deps.graceMs ?? 300_000)) {
      this.#launch(routine, due, "");
      return;
    }
    const all = dueTimesBetween(schedule, due - 1, now);
    const late = routine.missedPolicy === "run_once" ? all.pop() : undefined;
    const cap = this.deps.missedRows ?? 24;
    const shown = all.slice(-cap);
    const hidden = all.length - shown.length;
    const note = late === undefined ? "Skipped while asleep" : "";
    if (hidden > 0)
      this.deps.store.recordRun({
        routineId: routine.id,
        dueAt: all[0] as number,
        startedAt: null,
        endedAt: now,
        sessionId: null,
        outcome: "missed",
        note: `${hidden} earlier runs were missed while the Mac was asleep or localDot wasn't running.`,
      });
    let last: StoredRun | undefined;
    for (const dueAt of shown)
      last = this.deps.store.recordRun({
        routineId: routine.id,
        dueAt,
        startedAt: null,
        endedAt: now,
        sessionId: null,
        outcome: "missed",
        note,
      });
    if (last)
      this.deps.publish({
        type: "routine.run",
        routineId: routine.id,
        runId: last.id,
        outcome: "missed",
        sessionId: null,
        notify: notifyFor(routine.notify, "missed", false),
        title: `${routine.name}: Missed`,
      });
    if (late !== undefined) this.#launch(routine, late, "late");
  }

  #launch(routine: StoredRoutine, due: number, note: string): void {
    if (this.deps.gate?.intercept(routine, due)) return;
    // A failed history write must never become an unhandled rejection in the daemon.
    void this.deps.launcher
      .launch(routine, due, note)
      .catch(() => console.error("routines: a run could not be recorded"));
  }

  // Timer callbacks: a store error (such as SQLITE_BUSY) is logged and retried in a minute
  // instead of throwing out of a timer and crashing the daemon.
  #safely(): void {
    try {
      this.replan();
    } catch {
      console.error("routines: planning failed; retrying in a minute");
      this.#timer?.();
      this.#timer = this.deps.clock.setTimeout(() => this.#safely(), 60_000);
    }
  }

  #checkWake(): void {
    const wall = this.deps.clock.now(),
      mono = this.deps.clock.mono();
    const drift = wall - this.#lastWall - (mono - this.#lastMono);
    this.#lastWall = wall;
    this.#lastMono = mono;
    if (Math.abs(drift) > (this.deps.driftMs ?? 60_000)) this.#safely();
  }
}
