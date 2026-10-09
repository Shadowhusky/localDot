import { describe, expect, it } from "vitest";
import { parseEvent } from "./events.ts";
import { ulid } from "./ids.ts";
import {
  Routine,
  RoutineDraft,
  RoutineUpdate,
  SessionOrigin,
  SessionRun,
  StopAllOutcome,
  stopOutcomeConfirmed,
} from "./routines.ts";
import { BootConfig } from "./tool-api.ts";

const draft = {
  name: "Morning bills",
  instruction: "Check my utility and bank sites for new statements and save the PDFs to Bills.",
  when: { kind: "weekdays", time: "08:30" },
};

describe("routine drafts", () => {
  it("accepts a minimal draft and leaves defaults to the daemon", () => {
    expect(RoutineDraft.parse(draft)).toEqual(draft);
  });
  it.each([
    [{ ...draft, active: true }],
    [{ ...draft, budget_usd: 100 }],
    [{ ...draft, when: { kind: "daily", time: "24:00" } }],
    [{ ...draft, when: { kind: "once", date: "2026-02-30", time: "09:00" } }],
    [{ ...draft, when: { kind: "hours", every: 5 } }],
    [{ ...draft, when: { kind: "weekly", days: [1, 1], time: "09:00" } }],
    [{ ...draft, tz: "Mars/Olympus_Mons" }],
    [{ ...draft, name: "two\nlines" }],
    [{ ...draft, instruction: "   " }],
    [{ ...draft, approvalWindowMinutes: 4 }],
    [{ ...draft, budgetUSD: 0 }],
  ])("refuses %j", (value) => {
    expect(RoutineDraft.safeParse(value).success).toBe(false);
  });
  it("needs a revision to update and allows only active or paused", () => {
    expect(RoutineUpdate.safeParse({ name: "x" }).success).toBe(false);
    expect(RoutineUpdate.parse({ revision: 3, state: "paused" })).toEqual({
      revision: 3,
      state: "paused",
    });
    expect(RoutineUpdate.safeParse({ revision: 3, state: "proposed" }).success).toBe(false);
    expect(RoutineUpdate.safeParse({ revision: 3, until: null }).success).toBe(true);
  });
});

describe("origins and runs", () => {
  const routineId = ulid(),
    runId = ulid();
  const origin = {
    kind: "routine",
    routineId,
    runId,
    name: "Morning bills",
    dueAt: "2026-10-12T07:30:00.000Z",
  };
  it("puts an optional origin on session.start", () => {
    const base = { v: 1, id: ulid(), seq: 0, t: 0, agent: "main", type: "session.start" };
    const data = { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "Morning bills" };
    expect(parseEvent({ ...base, data }).type).toBe("session.start");
    const event = parseEvent({ ...base, data: { ...data, origin } });
    expect(event.type === "session.start" && event.data.origin).toEqual(origin);
    expect(SessionOrigin.safeParse({ ...origin, kind: "trigger" }).success).toBe(false);
  });
  it("records a proposal in the session log", () => {
    const event = parseEvent({
      v: 1,
      id: ulid(),
      seq: 3,
      t: 10,
      agent: "main",
      type: "routine.proposed",
      data: {
        routineId,
        revision: 1,
        name: "Morning bills",
        summary: "Weekdays at 08:30 · London time",
        instruction: draft.instruction,
        profile: "ask_first",
        notify: "changes",
        budgetUSD: 0.5,
        approvalWindowMinutes: 60,
        missedPolicy: "run_once",
      },
    });
    expect(event.type).toBe("routine.proposed");
  });
  it("carries a routine run description to the brain", () => {
    const run = {
      kind: "routine",
      name: "Morning bills",
      profile: "read_only",
      approvalWindowMinutes: 60,
    };
    expect(SessionRun.parse(run)).toEqual(run);
    expect(BootConfig.shape.run.safeParse(run).success).toBe(true);
    expect(BootConfig.shape.run.safeParse({ ...run, profile: "everything" }).success).toBe(false);
  });
  it("serves a routine with its last run", () => {
    const routine = {
      id: routineId,
      kind: "routine",
      name: "Morning bills",
      instruction: draft.instruction,
      when: draft.when,
      tz: "Europe/London",
      until: null,
      profile: "ask_first",
      notify: "changes",
      approvalWindowMinutes: 60,
      budgetUSD: 0.5,
      missedPolicy: "run_once",
      state: "active",
      pausedReason: null,
      revision: 2,
      nextDueAt: "2026-10-12T07:30:00.000Z",
      summary: "Weekdays at 08:30 · London time",
      createdFromSession: null,
      createdAt: "2026-10-08T10:00:00.000Z",
      updatedAt: "2026-10-08T10:00:00.000Z",
      lastRun: {
        id: runId,
        routineId,
        dueAt: "2026-10-09T07:30:00.000Z",
        startedAt: "2026-10-09T07:30:01.000Z",
        endedAt: "2026-10-09T07:34:00.000Z",
        sessionId: ulid(),
        outcome: "done",
        note: "2 new statements",
      },
      keepAsked: false,
    };
    expect(Routine.parse(routine)).toEqual(routine);
  });
});

describe("stop everything", () => {
  const ok = { revoked: true, paused: true, closed: false, stopped: false, errors: [] };
  it("confirms a stop the same way localdot stop does", () => {
    expect(stopOutcomeConfirmed(ok)).toBe(true);
    expect(stopOutcomeConfirmed({ ...ok, paused: false, closed: true, stopped: true })).toBe(true);
    expect(stopOutcomeConfirmed({ ...ok, paused: false })).toBe(false);
  });
  it("describes what was stopped", () => {
    const cellId = ulid();
    expect(
      StopAllOutcome.parse({
        sessions: [{ sessionId: ulid(), cellId, outcome: ok }],
        cells: [],
        routinesPaused: 1,
        launchesCancelled: 0,
        confirmed: true,
      }).confirmed,
    ).toBe(true);
  });
});
