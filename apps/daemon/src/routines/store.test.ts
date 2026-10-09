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
  when: { kind: "weekdays" as const, time: "08:30" },
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
      budgetUSD: 0.5,
      missedPolicy: "run_once",
      state: "active",
      revision: 1,
      anchor: "2026-10-08",
      nextDueAt: null,
    });
    expect(statSync(join(home, "routines.sqlite")).mode & 0o777).toBe(0o600);
    expect(toRoutine(routine, undefined).summary).toBe("Weekdays at 08:30 · London time");
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
      when: { kind: "daily", time: "09:00" },
    });
    expect(updated).toMatchObject({
      revision: 2,
      nextDueAt: null,
      when: { kind: "daily", time: "09:00" },
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

  it("hides follow-ups from the list unless asked", () => {
    const { store } = open();
    store.create(draft, { state: "active" });
    store.create(
      {
        name: "Follow-up",
        instruction: "check the parcel",
        when: { kind: "once", date: "2026-10-08", time: "15:00" },
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
      { ...draft, when: { kind: "once", date: "2026-10-08", time: "15:00" } },
      { state: "active" },
    );
    store.setState(once.id, "finished", null);
    const again = store.update(once.id, {
      revision: 2,
      when: { kind: "once", date: "2026-10-09", time: "15:00" },
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
