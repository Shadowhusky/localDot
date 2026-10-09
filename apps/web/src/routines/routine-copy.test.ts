import type { Routine, RoutineRun } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  nextRunText,
  originLine,
  outcomeGlyph,
  rowState,
  runLine,
  whenText,
} from "./routine-copy.ts";

const base = {
  id: "01J00000000000000000000001",
  kind: "routine",
  name: "Morning bills",
  instruction: "x",
  when: { kind: "weekdays", time: "08:30" },
  tz: "Europe/London",
  until: null,
  profile: "ask_first",
  notify: "changes",
  approvalWindowMinutes: 60,
  budgetUSD: null,
  missedPolicy: "run_once",
  state: "active",
  pausedReason: null,
  revision: 1,
  nextDueAt: "2026-10-13T07:30:00.000Z",
  summary: "Weekdays at 08:30 · London time",
  createdFromSession: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  lastRun: null,
  keepAsked: false,
} as Routine;
const run = (patch: Partial<RoutineRun>): RoutineRun => ({
  id: "01J00000000000000000000002",
  routineId: base.id,
  dueAt: "2026-10-12T07:30:00.000Z",
  startedAt: null,
  endedAt: null,
  sessionId: null,
  outcome: "done",
  note: "",
  ...patch,
});

describe("routine copy", () => {
  it("says when it runs next, on the routine's own clock", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    expect(nextRunText(base, now)).toBe("Next Tomorrow 08:30");
    expect(nextRunText({ ...base, nextDueAt: "2026-10-12T14:00:00.000Z" }, now)).toBe(
      "Next Today 15:00",
    );
    expect(nextRunText({ ...base, nextDueAt: "2026-10-15T07:30:00.000Z" }, now)).toBe(
      "Next Thu 15 Oct 08:30",
    );
    expect(nextRunText({ ...base, state: "paused" }, now)).toBe("Paused");
    expect(nextRunText({ ...base, state: "finished", nextDueAt: null }, now)).toBe("Finished");
    expect(whenText(Date.parse("2026-10-11T19:00:00Z"), "Europe/London", now)).toBe(
      "Yesterday 20:00",
    );
  });
  it("keeps a row's state short", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    expect(rowState(base, now)).toBe("next Tomorrow 08:30");
    expect(rowState({ ...base, nextDueAt: "2026-10-15T07:30:00.000Z" }, now)).toBe(
      "next Thu 08:30",
    );
    expect(rowState({ ...base, nextDueAt: "2026-10-30T08:30:00.000Z" }, now)).toBe(
      "next 30 Oct 08:30",
    );
    expect(rowState({ ...base, state: "paused" }, now)).toBe("Paused");
  });
  it("shows a glyph for every outcome, never colour alone", () => {
    expect(outcomeGlyph("done")).toBe("done");
    expect(outcomeGlyph("needs_you")).toBe("ask");
    expect(outcomeGlyph("needs_you_expired")).toBe("failed");
    expect(outcomeGlyph("budget")).toBe("failed");
    expect(outcomeGlyph("missed")).toBe("skipped");
    expect(outcomeGlyph("running")).toBe("doing");
  });
  it("writes each history line in plain words", () => {
    expect(
      runLine(run({ note: "late", startedAt: "2026-10-12T08:12:00.000Z" }), "Europe/London"),
    ).toBe("Missed 08:30 · ran at 09:12");
    expect(runLine(run({ outcome: "missed" }), "Europe/London")).toBe("Missed 08:30");
    expect(runLine(run({ outcome: "missed", note: "Skipped while asleep" }), "Europe/London")).toBe(
      "Skipped while asleep",
    );
    expect(
      runLine(run({ outcome: "needs_you_expired", note: "Checked two sites" }), "Europe/London"),
    ).toBe("Nobody answered · Checked two sites");
    expect(runLine(run({ outcome: "skipped", note: "computer busy" }), "Europe/London")).toBe(
      "Skipped · your computer was busy",
    );
    expect(runLine(run({ outcome: "done", note: "2 new statements" }), "Europe/London")).toBe(
      "2 new statements",
    );
    expect(runLine(run({ outcome: "budget", note: "" }), "Europe/London")).toBe(
      "Spending limit reached",
    );
  });
  it("names who started a thread", () => {
    expect(
      originLine(
        {
          kind: "routine",
          routineId: base.id,
          runId: base.id,
          name: "Morning bills",
          dueAt: "2026-10-12T07:30:00.000Z",
        },
        "Europe/London",
      ),
    ).toBe("Morning bills · started by a routine at 08:30");
  });
});
