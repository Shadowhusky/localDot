import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AUTONOMY,
  type RoutineDraft,
  type RoutineSchedule,
  ulid,
} from "@localdot/protocol";
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
  const add = (rule: RoutineSchedule, extra: Partial<RoutineDraft> = {}) =>
    store.create(
      { name: "R", instruction: "do it", schedules: [rule], ...extra },
      { state: "active" },
    );
  const missed = (id: string) => store.runs(id).filter((r) => r.outcome === "missed");
  return { clock, store, launcher, launches, scheduler, add, missed };
}
const iso = (value: string) => new Date(value).toISOString();
const daily = (...times: string[]): RoutineSchedule => ({ every: 1, unit: "day", times });
const HOURLY: RoutineSchedule = { every: 1, unit: "hour" };
const dues = (launches: { due: string }[]) => launches.map((l) => l.due);

describe("routine scheduler", () => {
  it("launches at the due time", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    f.add(daily("08:30"));
    f.scheduler.start();
    f.clock.advance(29 * 60_000);
    expect(f.launches).toEqual([]);
    f.clock.advance(60_000);
    expect(f.launches.map((l) => [l.due, l.note])).toEqual([[iso("2026-10-12T07:30:00Z"), ""]]);
  });

  it("run once when I'm back: one late run and one missed", () => {
    const f = fixture();
    const routine = f.add(HOURLY);
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
    const routine = f.add(HOURLY, { missedPolicy: "skip" });
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
    f.add(daily("08:30"));
    f.scheduler.start();
    f.clock.sleep(2 * 3_600_000);
    f.clock.advance(30_000);
    expect(f.launches.map((l) => [l.due, l.note])).toEqual([[iso("2026-10-12T07:30:00Z"), "late"]]);
    f.clock.advance(3_600_000);
    expect(f.launches).toHaveLength(1);
  });

  it("does not mistake a busy event loop for sleep", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    f.add(daily("08:30"));
    f.scheduler.start();
    f.clock.advance(10 * 60_000);
    expect(f.launches).toEqual([]);
  });

  it("writes at most 24 missed rows plus a summary after a week asleep", () => {
    const f = fixture();
    const routine = f.add(HOURLY);
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
    const once = f.add(daily("08:30"), { start: "2026-10-12", until: "2026-10-12" });
    const ended = f.add(daily("07:30"), { until: "2026-10-13" });
    f.scheduler.start();
    f.clock.advance(31 * 60_000);
    expect(f.store.get(once.id)?.state).toBe("finished");
    expect(f.launches).toHaveLength(1);
    f.clock.advance(2 * 86_400_000);
    expect(f.store.get(ended.id)?.state).toBe("finished");
    expect(f.launches).toHaveLength(2);
  });

  it("does not relaunch the due time of a run a restart interrupted", () => {
    const f = fixture("2026-10-12T07:40:00Z");
    const routine = f.add(daily("08:30"));
    f.store.setNextDue(routine.id, Date.parse("2026-10-13T07:30:00Z"));
    f.scheduler.start();
    expect(f.launches).toEqual([]);
  });

  it("launches nothing before start, even when a route re-plans an overdue routine", () => {
    const f = fixture("2026-10-12T07:40:00Z");
    const routine = f.add(HOURLY);
    f.store.setNextDue(routine.id, Date.parse("2026-10-12T08:00:00Z"));
    f.clock.advance(3_600_000);
    f.scheduler.replan();
    expect(f.launches).toEqual([]);
    f.scheduler.start();
    expect(f.launches).toHaveLength(1);
  });

  it("does not back-fill while a routine was paused", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    const routine = f.add(HOURLY);
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
    f.add(daily("10:00"));
    f.scheduler.start();
    f.add(daily("08:15"));
    f.scheduler.replan();
    f.clock.advance(15 * 60_000);
    expect(dues(f.launches)).toEqual([iso("2026-10-12T07:15:00Z")]);
  });

  it("keeps 08:30 local across a daylight saving change", () => {
    const f = fixture("2026-10-24T07:00:00Z");
    f.add(daily("08:30"));
    f.scheduler.start();
    f.clock.advance(2 * 86_400_000);
    expect(dues(f.launches)).toEqual([iso("2026-10-24T07:30:00Z"), iso("2026-10-25T08:30:00Z")]);
  });

  it("runs each hourly slot once when the clocks spring forward", () => {
    const f = fixture("2026-03-28T23:30:00Z");
    f.add(HOURLY);
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

  describe("across a daylight saving change in New York", () => {
    const newYork = (f: ReturnType<typeof fixture>, rule: RoutineSchedule, extra = {}) =>
      f.add(rule, { tz: "America/New_York", ...extra });

    it("spring forward: a run in the skipped hour moves on and nothing runs twice", () => {
      const f = fixture("2026-03-07T05:00:00Z");
      newYork(f, daily("02:30", "03:30", "09:00"));
      f.scheduler.start();
      f.clock.advance(2 * 86_400_000);
      expect(dues(f.launches)).toEqual([
        iso("2026-03-07T07:30:00Z"),
        iso("2026-03-07T08:30:00Z"),
        iso("2026-03-07T14:00:00Z"),
        // 02:30 does not exist on the 8th: it runs at 03:30, which was already due.
        iso("2026-03-08T07:30:00Z"),
        iso("2026-03-08T13:00:00Z"),
      ]);
    });
    it("fall back: a run in the repeated hour runs the first time only", () => {
      const f = fixture("2026-10-31T04:00:00Z");
      newYork(f, daily("01:30", "09:00"));
      f.scheduler.start();
      f.clock.advance(2 * 86_400_000);
      expect(dues(f.launches)).toEqual([
        iso("2026-10-31T05:30:00Z"),
        iso("2026-10-31T13:00:00Z"),
        iso("2026-11-01T05:30:00Z"),
        iso("2026-11-01T14:00:00Z"),
      ]);
    });
    it("every 30 minutes keeps one run per slot through both changes", () => {
      const rule: RoutineSchedule = { every: 30, unit: "minute", from: "01:00", to: "03:00" };
      const spring = fixture("2026-03-08T05:30:00Z");
      newYork(spring, rule);
      spring.scheduler.start();
      spring.clock.advance(4 * 3_600_000);
      expect(dues(spring.launches)).toEqual([
        iso("2026-03-08T06:00:00Z"),
        iso("2026-03-08T06:30:00Z"),
        iso("2026-03-08T07:00:00Z"),
        iso("2026-03-08T07:30:00Z"),
      ]);
      const autumn = fixture("2026-11-01T04:30:00Z");
      newYork(autumn, rule);
      autumn.scheduler.start();
      autumn.clock.advance(6 * 3_600_000);
      const due = dues(autumn.launches);
      expect(new Set(due).size).toBe(due.length);
      expect(due).toEqual([
        iso("2026-11-01T05:00:00Z"),
        iso("2026-11-01T05:30:00Z"),
        iso("2026-11-01T07:00:00Z"),
        iso("2026-11-01T07:30:00Z"),
        iso("2026-11-01T08:00:00Z"),
      ]);
    });
    it("a Mac asleep across the change catches up once, by the routine's policy", () => {
      const f = fixture("2026-03-07T12:00:00Z");
      const routine = newYork(f, daily("09:00"));
      f.scheduler.start();
      f.clock.sleep(2 * 86_400_000);
      f.clock.advance(30_000);
      expect(f.launches.map((l) => [l.due, l.note])).toEqual([
        [iso("2026-03-08T13:00:00Z"), "late"],
      ]);
      expect(f.missed(routine.id).map((r) => new Date(r.dueAt).toISOString())).toEqual([
        iso("2026-03-07T14:00:00Z"),
      ]);
    });
  });

  it("runs several schedules on one routine from one plan", () => {
    const f = fixture("2026-10-12T06:59:00Z");
    f.store.create(
      {
        name: "R",
        instruction: "do it",
        schedules: [
          daily("09:00", "12:00"),
          { every: 1, unit: "week", weekdays: [1], times: ["10:00"] },
        ],
      },
      { state: "active" },
    );
    f.scheduler.start();
    f.clock.advance(6 * 3_600_000);
    expect(dues(f.launches)).toEqual([
      iso("2026-10-12T08:00:00Z"),
      iso("2026-10-12T09:00:00Z"),
      iso("2026-10-12T11:00:00Z"),
    ]);
  });

  it("waits for a start date in the future", () => {
    const f = fixture("2026-10-12T06:59:00Z");
    f.add(daily("09:00"), { start: "2026-10-14" });
    f.scheduler.start();
    f.clock.advance(2 * 86_400_000);
    expect(f.launches).toEqual([]);
    f.clock.advance(86_400_000);
    expect(dues(f.launches)).toEqual([iso("2026-10-14T08:00:00Z")]);
  });

  it("treats a clock moved forward like a wake and catches up once", () => {
    const f = fixture("2026-10-12T07:00:00Z");
    f.add(daily("08:30"));
    f.scheduler.start();
    f.clock.setWall("2026-10-12T09:00:00Z");
    f.clock.advance(30_000);
    expect(f.launches.map((l) => [l.due, l.note])).toEqual([[iso("2026-10-12T07:30:00Z"), "late"]]);
  });

  it("never runs a due time twice when the clock is moved back", () => {
    const f = fixture("2026-10-12T07:29:00Z");
    f.add(daily("08:30"));
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
    const broken = f.add(daily("09:00"));
    f.add(daily("08:30"));
    // Something that slipped past validation (an older release wrote it) cannot be planned.
    vi.spyOn(f.store, "list").mockImplementation(function (this: unknown) {
      return RoutineStore.prototype.list
        .call(f.store, { includeHidden: true })
        .map((r) => (r.id === broken.id ? { ...r, tz: "Not/AZone" } : r));
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
    f.add(daily("08:30"));
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
        live: () => [],
        busy: () => false,
        parked: () => false,
        post: () => false,
        settled: async () => {},
        title: () => undefined,
        latest: (id) => id,
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
      { name: "Inbox", instruction: "Check my inbox", schedules: [HOURLY] },
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
