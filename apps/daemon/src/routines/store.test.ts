import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RoutineStore, toRoutine } from "./store.ts";

const homes: string[] = [];
const stores: RoutineStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const clock = Date.parse("2026-10-08T10:00:00Z");
function open(home = mkdtempSync(join(tmpdir(), "ld-routines-"))) {
  if (!homes.includes(home)) homes.push(home);
  const store = new RoutineStore(home, { now: () => clock, zone: () => "Europe/London" });
  stores.push(store);
  return { home, store };
}
const draft = {
  name: "Morning bills",
  instruction: "Check statements.",
  schedules: [{ every: 1, unit: "week" as const, weekdays: [1, 2, 3, 4, 5], times: ["08:30"] }],
};

describe("routine store", () => {
  it("creates with defaults, the daemon's zone and a private file", () => {
    const { home, store } = open();
    const routine = store.create(draft, { state: "active" });
    expect(routine).toMatchObject({
      kind: "routine",
      tz: "Europe/London",
      profile: "ask_first",
      notify: "changes",
      approvalWindowMinutes: 60,
      budgetUSD: null,
      missedPolicy: "run_once",
      state: "active",
      revision: 1,
      start: "2026-10-08",
      nextDueAt: null,
    });
    expect(statSync(join(home, "routines.sqlite")).mode & 0o777).toBe(0o600);
    expect(toRoutine(routine, undefined, clock).summary).toBe("Weekdays at 8:30 · London time");
  });

  it("keeps a spending limit only when the user sets one", () => {
    const { store } = open();
    const capped = store.create({ ...draft, budgetUSD: 2 }, { state: "active" });
    expect(capped.budgetUSD).toBe(2);
    expect(store.update(capped.id, { revision: 1, budgetUSD: null }).budgetUSD).toBeNull();
  });

  it("refuses a stale revision and clears the next due time when the schedule changes", () => {
    const { store } = open();
    const routine = store.create(draft, { state: "active" });
    store.setNextDue(routine.id, 123);
    expect(() => store.update(routine.id, { revision: 7, name: "x" })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    const updated = store.update(routine.id, {
      revision: 1,
      schedules: [{ every: 1, unit: "day", times: ["09:00"] }],
    });
    expect(updated).toMatchObject({
      revision: 2,
      nextDueAt: null,
      schedules: [{ every: 1, unit: "day", times: ["09:00"] }],
    });
  });

  it("confirms a proposal once", () => {
    const { store } = open();
    const session = ulid();
    const proposed = store.create(draft, { state: "proposed", createdFromSession: session });
    expect(store.confirm(proposed.id, 1, { budgetUSD: 1 })).toMatchObject({
      state: "active",
      revision: 2,
      budgetUSD: 1,
    });
    expect(() => store.confirm(proposed.id, 2)).toThrow(expect.objectContaining({ status: 409 }));
  });

  it("enforces the routine, proposal and follow-up limits", () => {
    const { store } = open();
    for (let i = 0; i < 50; i++) store.create({ ...draft, name: `R${i}` }, { state: "active" });
    expect(() => store.create(draft, { state: "active" })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    const { store: other } = open();
    const session = ulid();
    for (let i = 0; i < 3; i++)
      other.create(draft, { state: "proposed", createdFromSession: session });
    expect(() => other.create(draft, { state: "proposed", createdFromSession: session })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("never counts proposals toward the routine limit, and keeps only the newest twenty", () => {
    const { store } = open();
    for (let i = 0; i < 49; i++) store.create({ ...draft, name: `R${i}` }, { state: "active" });
    const sessions = Array.from({ length: 15 }, () => ulid());
    for (const session of sessions)
      for (let i = 0; i < 3; i++)
        store.create(draft, { state: "proposed", createdFromSession: session });
    expect(store.create(draft, { state: "active" }).state).toBe("active");
    const proposals = store.list().filter((r) => r.state === "proposed");
    expect(proposals).toHaveLength(20);
    // Saving a proposal is still held to the limit.
    const newest = proposals.at(-1);
    expect(() => store.confirm(newest?.id ?? "", 1)).toThrow(
      expect.objectContaining({ status: 409, message: expect.stringContaining("50 routines") }),
    );
  });

  it("lets proposals nobody saved expire after a week", () => {
    const home = mkdtempSync(join(tmpdir(), "ld-routines-"));
    homes.push(home);
    let now = clock;
    const store = new RoutineStore(home, { now: () => now, zone: () => "Europe/London" });
    stores.push(store);
    const old = store.create(draft, { state: "proposed", createdFromSession: ulid() });
    now += 7 * 86_400_000 + 1;
    const fresh = store.create(draft, { state: "proposed", createdFromSession: ulid() });
    expect(store.get(old.id)).toBeUndefined();
    expect(store.get(fresh.id)?.state).toBe("proposed");
  });

  it("keeps the thirty newest finished routines with their history", () => {
    const home = mkdtempSync(join(tmpdir(), "ld-routines-"));
    homes.push(home);
    let now = clock;
    const store = new RoutineStore(home, { now: () => now++, zone: () => "Europe/London" });
    stores.push(store);
    const finished = Array.from({ length: 40 }, (_, i) => {
      const once = store.create({ ...draft, name: `Once ${i}` }, { state: "active" });
      store.recordRun({
        routineId: once.id,
        dueAt: now,
        startedAt: now,
        endedAt: now,
        sessionId: null,
        outcome: "done",
        note: "",
      });
      return store.setState(once.id, "finished", null).id;
    });
    for (let i = 0; i < 50; i++) store.create({ ...draft, name: `R${i}` }, { state: "active" });
    expect(store.list()).toHaveLength(80);
    expect(store.get(finished[9] ?? "")).toBeUndefined();
    expect(store.runs(finished[9] ?? "")).toEqual([]);
    expect(store.get(finished[10] ?? "")?.state).toBe("finished");
  });

  it("answers invalid text and dates in plain words", () => {
    const { store } = open();
    for (const [input, message] of [
      [{ ...draft, name: "Two\nlines" }, "A routine's name is one line of up to 80 characters."],
      [{ ...draft, until: "2026-02-30" }, "The end date isn't a real date."],
      [{ ...draft, start: "2026-02-30" }, "The start date isn't a real date."],
      [
        { ...draft, start: "2026-11-02", until: "2026-11-01" },
        "The last day comes before the first.",
      ],
      [
        { ...draft, schedules: [{ every: 1, unit: "minute" }] },
        "A step in minutes must be from 5 to 720.",
      ],
      [
        { ...draft, start: "2026-10-01", until: "2026-10-02" },
        "No runs are left on those dates. Pick a later last day.",
      ],
    ] as const)
      expect(() => store.create(input as never, { state: "active" })).toThrow(
        expect.objectContaining({ name: "RoutineError", status: 400, message }),
      );
  });

  it("refuses a one-off whose time has passed, but not a rename of one", () => {
    const { store } = open();
    const passed = {
      schedules: [{ every: 1, unit: "day" as const, times: ["10:59"] }],
      start: "2026-10-08",
      until: "2026-10-08",
    };
    expect(() => store.create({ ...draft, ...passed }, { state: "active" })).toThrow(
      expect.objectContaining({ status: 400, message: "That time has passed. Pick a later one." }),
    );
    const later = store.create(
      {
        ...draft,
        schedules: [{ every: 1, unit: "day", times: ["11:01"] }],
        start: "2026-10-08",
        until: "2026-10-08",
      },
      { state: "active" },
    );
    expect(() => store.update(later.id, { revision: 1, ...passed })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    const proposal = store.create(
      {
        ...draft,
        schedules: [{ every: 1, unit: "day", times: ["11:01"] }],
        start: "2026-10-08",
        until: "2026-10-08",
      },
      { state: "proposed", createdFromSession: ulid() },
    );
    expect(() => store.confirm(proposal.id, 1, passed)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("lets the user take away the last day dot drafted", () => {
    const { store } = open();
    const proposal = store.create(
      { ...draft, until: "2026-12-31" },
      { state: "proposed", createdFromSession: ulid() },
    );
    expect(store.confirm(proposal.id, 1, { until: null }).until).toBeNull();
  });

  it("keeps a pending due time through a rename that resends the same schedule", () => {
    const { store } = open();
    const routine = store.create(draft, { state: "active" });
    store.setNextDue(routine.id, 123);
    const renamed = store.update(routine.id, {
      revision: 1,
      name: "Bills",
      schedules: [{ every: 1, unit: "week" as const, weekdays: [1, 2, 3, 4, 5], times: ["08:30"] }],
      until: null,
    });
    expect(renamed).toMatchObject({ name: "Bills", nextDueAt: 123 });
  });

  it("hides follow-ups from the list unless asked", () => {
    const { store } = open();
    store.create(draft, { state: "active" });
    store.create(
      {
        name: "Follow-up",
        instruction: "check the parcel",
        schedules: [{ every: 1, unit: "day", times: ["15:00"] }],
        start: "2026-10-08",
        until: "2026-10-08",
      },
      {
        state: "active",
        kind: "follow_up",
        followUp: { sessionId: ulid(), note: "check the parcel" },
      },
    );
    expect(store.list()).toHaveLength(1);
    expect(store.list({ includeHidden: true })).toHaveLength(2);
  });

  it("pauses active routines for Stop everything and resumes only those", () => {
    const { store } = open();
    const a = store.create(draft, { state: "active" });
    const b = store.create(draft, { state: "active" });
    store.update(b.id, { revision: 1, state: "paused" });
    expect(store.pauseAllActive("stop_all")).toEqual([a.id]);
    expect(store.get(a.id)).toMatchObject({ state: "paused", pausedReason: "stop_all" });
    expect(store.pauseAllActive("stop_all")).toEqual([]);
    expect(store.resumeStopAll()).toEqual([a.id]);
    expect(store.get(a.id)).toMatchObject({ state: "active", pausedReason: null, nextDueAt: null });
    expect(store.get(b.id)).toMatchObject({ state: "paused", pausedReason: "user" });
  });

  it("brings a finished one-off back when its schedule changes", () => {
    const { store } = open();
    const once = store.create(
      {
        ...draft,
        schedules: [{ every: 1, unit: "day", times: ["15:00"] }],
        start: "2026-10-08",
        until: "2026-10-08",
      },
      { state: "active" },
    );
    store.setState(once.id, "finished", null);
    const again = store.update(once.id, {
      revision: 2,
      schedules: [{ every: 1, unit: "day", times: ["15:00"] }],
      start: "2026-10-09",
      until: "2026-10-09",
    });
    expect(again).toMatchObject({ state: "active", revision: 3 });
  });

  it("keeps run history newest first and finds open runs across a restart", () => {
    const { home, store } = open();
    const routine = store.create(draft, { state: "active" });
    const first = store.recordRun({
      routineId: routine.id,
      dueAt: 1,
      startedAt: null,
      endedAt: null,
      sessionId: null,
      outcome: "missed",
      note: "",
    });
    const second = store.recordRun({
      routineId: routine.id,
      dueAt: 2,
      startedAt: 3,
      endedAt: null,
      sessionId: ulid(),
      outcome: "running",
      note: "late",
    });
    expect(store.runs(routine.id).map((r) => r.id)).toEqual([second.id, first.id]);
    expect(store.openRuns().map((r) => r.id)).toEqual([second.id]);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = open(home).store;
    expect(reopened.get(routine.id)?.name).toBe("Morning bills");
    expect(reopened.updateRun(second.id, { outcome: "done", endedAt: 4 }).outcome).toBe("done");
    expect(reopened.lastRun(routine.id)?.outcome).toBe("done");
    expect(reopened.openRuns()).toEqual([]);
  });

  it("deletes a routine with its history, only at the current revision", () => {
    const { store } = open();
    const routine = store.create(draft, { state: "active" });
    store.recordRun({
      routineId: routine.id,
      dueAt: 1,
      startedAt: null,
      endedAt: 2,
      sessionId: null,
      outcome: "done",
      note: "",
    });
    expect(() => store.remove(routine.id, 9)).toThrow(expect.objectContaining({ status: 409 }));
    store.remove(routine.id, 1);
    expect(store.get(routine.id)).toBeUndefined();
    expect(store.runs(routine.id)).toEqual([]);
  });
});
