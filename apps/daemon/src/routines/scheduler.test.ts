import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUTONOMY, type RoutineDraft, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { RoutineLauncher } from "./launch.ts";
import { ExpiredRuns } from "./policy.ts";
import { RoutineScheduler } from "./scheduler.ts";
import { RoutineStore, type StoredRoutine } from "./store.ts";
import { FakeClock } from "./testing/fake-clock.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});
function fixture(start = "2026-10-12T06:59:00Z") {
  const home = mkdtempSync(join(tmpdir(), "ld-scheduler-"));
  const clock = new FakeClock(start);
  const store = new RoutineStore(home, { now: clock.now, zone: () => "Europe/London" });
  const launches: { routine: StoredRoutine; due: string; note: string }[] = [];
  const launcher = {
    launch: vi.fn(async (routine: StoredRoutine, due: number, note = "") => {
      launches.push({ routine, due: new Date(due).toISOString(), note });
      return store.recordRun({
        routineId: routine.id,
        dueAt: due,
        startedAt: clock.now(),
        endedAt: null,
        sessionId: ulid(),
        outcome: "running",
        note,
      });
    }),
  };
  const scheduler = new RoutineScheduler({ store, launcher, clock, publish: () => {} });
  cleanup.push(() => {
    scheduler.stop();
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const add = (when: RoutineDraft["when"], extra: Partial<RoutineDraft> = {}) =>
    store.create({ name: "R", instruction: "do it", when, ...extra }, { state: "active" });
  const missed = (id: string) => store.runs(id).filter((r) => r.outcome === "missed");
  return { clock, store, launcher, launches, scheduler, add, missed };
}
const iso = (value: string) => new Date(value).toISOString();
const dues = (launches: { due: string }[]) => launches.map((l) => l.due);

describe("routine scheduler", () => {
  it("launches at the due time", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    f.add({ kind: "daily", time: "08:30" });
    f.scheduler.start();
    f.clock.advance(29 * 60_000);
    expect(f.launches).toEqual([]);
    f.clock.advance(60_000);
    expect(f.launches.map((l) => [l.due, l.note])).toEqual([[iso("2026-10-12T07:30:00Z"), ""]]);
  });

  it("run once when I'm back: one late run and one missed", () => {
    const f = fixture();
    const routine = f.add({ kind: "hours", every: 1 });
    f.scheduler.start();
    f.scheduler.pause();
    f.clock.advance(2 * 3_600_000);
    f.scheduler.resume();
    expect(f.launches.map((l) => [l.due, l.note])).toEqual([[iso("2026-10-12T08:00:00Z"), "late"]]);
    expect(f.missed(routine.id).map((r) => new Date(r.dueAt).toISOString())).toEqual([
      iso("2026-10-12T07:00:00Z"),
    ]);
  });

  it("skip: no runs and two missed", () => {
    const f = fixture();
    const routine = f.add({ kind: "hours", every: 1 }, { missedPolicy: "skip" });
    f.scheduler.start();
    f.scheduler.pause();
    f.clock.advance(2 * 3_600_000);
    f.scheduler.resume();
    expect(f.launches).toEqual([]);
    expect(f.missed(routine.id).map((r) => r.note)).toEqual([
      "Skipped while asleep",
      "Skipped while asleep",
    ]);
  });

  it("notices a wake from sleep and catches up once", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    f.add({ kind: "daily", time: "08:30" });
    f.scheduler.start();
    f.clock.sleep(2 * 3_600_000);
    f.clock.advance(30_000);
    expect(f.launches.map((l) => [l.due, l.note])).toEqual([[iso("2026-10-12T07:30:00Z"), "late"]]);
    f.clock.advance(3_600_000);
    expect(f.launches).toHaveLength(1);
  });

  it("does not mistake a busy event loop for sleep", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    f.add({ kind: "daily", time: "08:30" });
    f.scheduler.start();
    f.clock.advance(10 * 60_000);
    expect(f.launches).toEqual([]);
  });

  it("writes at most 24 missed rows plus a summary after a week asleep", () => {
    const f = fixture();
    const routine = f.add({ kind: "hours", every: 1 });
    f.scheduler.start();
    f.clock.sleep(7 * 86_400_000);
    f.clock.advance(30_000);
    expect(f.launches).toHaveLength(1);
    const rows = f.store.runs(routine.id, { limit: 200 }).filter((r) => r.outcome === "missed");
    expect(rows).toHaveLength(25);
    expect(rows.some((r) => /^\d+ earlier runs were missed/.test(r.note))).toBe(true);
  });

  it("finishes a one-off routine after it runs and a routine past its end date", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    const once = f.add({ kind: "once", date: "2026-10-12", time: "08:30" });
    const ended = f.add({ kind: "daily", time: "08:30" }, { until: "2026-10-11" });
    f.scheduler.start();
    f.clock.advance(31 * 60_000);
    expect(f.store.get(once.id)?.state).toBe("finished");
    expect(f.store.get(ended.id)?.state).toBe("finished");
    expect(f.launches).toHaveLength(1);
  });

  it("does not relaunch the due time of a run a restart interrupted", () => {
    const f = fixture("2026-10-12T07:40:00Z");
    const routine = f.add({ kind: "daily", time: "08:30" });
    f.store.setNextDue(routine.id, Date.parse("2026-10-13T07:30:00Z"));
    f.scheduler.start();
    expect(f.launches).toEqual([]);
  });

  it("launches nothing before start, even when a route re-plans an overdue routine", () => {
    const f = fixture("2026-10-12T07:40:00Z");
    const routine = f.add({ kind: "hours", every: 1 });
    f.store.setNextDue(routine.id, Date.parse("2026-10-12T08:00:00Z"));
    f.clock.advance(3_600_000);
    f.scheduler.replan();
    expect(f.launches).toEqual([]);
    f.scheduler.start();
    expect(f.launches).toHaveLength(1);
  });

  it("does not back-fill while a routine was paused", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    const routine = f.add({ kind: "hours", every: 1 });
    f.store.update(routine.id, { revision: 1, state: "paused" });
    f.scheduler.start();
    f.clock.sleep(3 * 86_400_000);
    f.store.update(routine.id, { revision: 2, state: "active" });
    f.scheduler.replan();
    expect(f.missed(routine.id)).toEqual([]);
    expect(f.launches).toEqual([]);
  });

  it("re-plans when an earlier routine is added", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    f.add({ kind: "daily", time: "10:00" });
    f.scheduler.start();
    f.add({ kind: "daily", time: "08:15" });
    f.scheduler.replan();
    f.clock.advance(15 * 60_000);
    expect(dues(f.launches)).toEqual([iso("2026-10-12T07:15:00Z")]);
  });

  it("keeps 08:30 local across a daylight saving change", () => {
    const f = fixture("2026-10-24T07:00:00Z");
    f.add({ kind: "daily", time: "08:30" });
    f.scheduler.start();
    f.clock.advance(2 * 86_400_000);
    expect(dues(f.launches)).toEqual([iso("2026-10-24T07:30:00Z"), iso("2026-10-25T08:30:00Z")]);
  });

  it("runs each hourly slot once when the clocks spring forward", () => {
    const f = fixture("2026-03-28T23:30:00Z");
    f.add({ kind: "hours", every: 1 });
    f.scheduler.start();
    f.clock.advance(5 * 3_600_000);
    const due = dues(f.launches);
    expect(new Set(due).size).toBe(due.length);
    expect(due).toEqual([
      iso("2026-03-29T00:00:00Z"),
      iso("2026-03-29T01:00:00Z"),
      iso("2026-03-29T02:00:00Z"),
      iso("2026-03-29T03:00:00Z"),
      iso("2026-03-29T04:00:00Z"),
    ]);
  });

  it("treats a clock moved forward like a wake and catches up once", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    f.add({ kind: "daily", time: "08:30" });
    f.scheduler.start();
    f.clock.setWall("2026-10-12T09:00:00Z");
    f.clock.advance(30_000);
    expect(f.launches.map((l) => [l.due, l.note])).toEqual([[iso("2026-10-12T07:30:00Z"), "late"]]);
  });

  it("never runs a due time twice when the clock is moved back", () => {
    const f = fixture("2026-10-12T07:29:00Z");
    f.add({ kind: "daily", time: "08:30" });
    f.scheduler.start();
    f.clock.advance(2 * 60_000);
    expect(f.launches).toHaveLength(1);
    f.clock.setWall("2026-10-12T07:00:00Z");
    f.clock.advance(60 * 60_000);
    expect(dues(f.launches)).toEqual([iso("2026-10-12T07:30:00Z")]);
    f.clock.advance(86_400_000);
    expect(dues(f.launches)).toEqual([iso("2026-10-12T07:30:00Z"), iso("2026-10-13T07:30:00Z")]);
  });

  it("keeps planning the other routines when one schedule cannot be computed", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    const broken = f.add({ kind: "daily", time: "09:00" });
    f.add({ kind: "daily", time: "08:30" });
    // A rule that slipped past validation (an older release wrote it) cannot be read back.
    vi.spyOn(f.store, "list").mockImplementation(function (this: unknown) {
      return RoutineStore.prototype.list
        .call(f.store, { includeHidden: true })
        .map((r) =>
          r.id === broken.id ? { ...r, when: { kind: "custom" as const, rule: "FREQ=HOURLY" } } : r,
        );
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    f.scheduler.start();
    f.clock.advance(31 * 60_000);
    expect(dues(f.launches)).toEqual([iso("2026-10-12T07:30:00Z")]);
    expect(quiet).toHaveBeenCalledWith("routines: a routine could not be planned");
    quiet.mockRestore();
  });

  it("logs a planning failure and tries again a minute later", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    f.add({ kind: "daily", time: "08:30" });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const list = vi.spyOn(f.store, "list").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    f.scheduler.start();
    expect(quiet).toHaveBeenCalledWith(expect.stringContaining("retrying in a minute"));
    list.mockRestore();
    f.clock.advance(31 * 60_000);
    expect(f.launches).toHaveLength(1);
    quiet.mockRestore();
  });
});

describe("overlapping runs", () => {
  it("skips the next due time while the previous run is still going", async () => {
    const home = mkdtempSync(join(tmpdir(), "ld-overlap-"));
    const clock = new FakeClock("2026-10-12T06:59:00Z");
    const store = new RoutineStore(home, { now: clock.now, zone: () => "Europe/London" });
    const log = new EventLog(home);
    const cells = new FakeOrchestrator();
    const cellId = ulid();
    cells.cells.set(cellId, {
      id: cellId,
      state: "ready",
      scale: 2,
      createdAt: "2026-10-01T00:00:00Z",
      stream: NO_STREAM,
    });
    const started: string[] = [];
    const launcher = new RoutineLauncher({
      store,
      cells,
      runner: {
        start: async (_cell, task) => {
          const id = log.createSession(task);
          started.push(id);
          return { id };
        },
        end: () => true,
        live: () => undefined,
        busy: () => false,
        parked: () => false,
        post: () => false,
        settled: async () => {},
        title: () => undefined,
      },
      events: log,
      dockerAvailable: async () => true,
      userAutonomy: () => DEFAULT_AUTONOMY,
      expired: new ExpiredRuns(),
      publish: () => {},
      clock,
    });
    const scheduler = new RoutineScheduler({ store, launcher, clock, publish: () => {} });
    cleanup.push(() => {
      scheduler.stop();
      store.close();
      log.close();
      rmSync(home, { recursive: true, force: true });
    });
    const routine = store.create(
      { name: "Inbox", instruction: "Check my inbox", when: { kind: "hours", every: 1 } },
      { state: "active" },
    );
    scheduler.start();
    clock.advance(60_000);
    await clock.flush();
    clock.advance(3_600_000);
    await clock.flush();
    expect(started).toHaveLength(1);
    expect(store.runs(routine.id).map((r) => [r.outcome, r.note])).toEqual([
      ["skipped", "The previous run was still going."],
      ["running", ""],
    ]);
  });
});
