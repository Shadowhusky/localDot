import { describe, expect, it } from "vitest";
import {
  addedSchedule,
  draftFromForm,
  formFromRoutine,
  previewOf,
  type RoutineFormState,
  type ScheduleFormState,
  withUnit,
} from "./routine-form.ts";

const now = Date.parse("2026-10-12T09:00:00Z");
const fresh = (): RoutineFormState => ({
  ...formFromRoutine(null, "Europe/London", now),
  name: "Bills",
  instruction: "Check bills",
});
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const rule = (patch: Partial<ScheduleFormState>): ScheduleFormState => ({
  ...(fresh().schedules[0] as ScheduleFormState),
  ...patch,
});

describe("routine form", () => {
  it("starts with plain defaults and no spending limit", () => {
    expect(formFromRoutine(null, "Europe/London", now)).toMatchObject({
      once: false,
      date: "2026-10-12",
      onceTimes: ["09:00"],
      start: "2026-10-12",
      tz: "Europe/London",
      schedules: [{ every: "1", unit: "week", weekdays: [1, 2, 3, 4, 5], times: ["09:00"] }],
      profile: "ask_first",
      notify: "changes",
      missedPolicy: "run_once",
      windowMinutes: "60",
      limited: false,
    });
    const result = draftFromForm(fresh());
    expect(result.ok && result.draft.budgetUSD).toBeNull();
  });
  it.each([
    [
      { unit: "day", weekdays: EVERY_DAY, times: ["08:30"] },
      { every: 1, unit: "day", times: ["08:30"] },
    ],
    [
      { times: ["17:00", "09:00", "09:00"], weekdays: [4, 1] },
      { every: 1, unit: "week", weekdays: [1, 4], times: ["09:00", "17:00"] },
    ],
    [
      { every: "2", unit: "month", monthDays: [-1, 15, 1], times: ["08:00"] },
      { every: 2, unit: "month", monthDays: [1, 15, -1], times: ["08:00"] },
    ],
    [
      { every: "4", unit: "hour", weekdays: EVERY_DAY, from: "09:00", to: "21:00" },
      { every: 4, unit: "hour", from: "09:00", to: "21:00" },
    ],
    [
      { every: "30", unit: "minute", weekdays: [1, 2], from: "", to: "" },
      { every: 30, unit: "minute", weekdays: [1, 2] },
    ],
  ])("builds the schedule %j", (fields, expected) => {
    const result = draftFromForm({ ...fresh(), schedules: [rule(fields as never)] });
    expect(result.ok && result.draft.schedules).toEqual([expected]);
  });
  it("carries several schedules, the dates and the time zone", () => {
    const result = draftFromForm({
      ...fresh(),
      schedules: [rule({}), rule({ id: "s1", unit: "day", weekdays: EVERY_DAY, times: ["18:00"] })],
      start: "2026-11-10",
      ends: true,
      until: "2026-12-20",
      tz: "America/New_York",
    });
    expect(result.ok && result.draft).toMatchObject({
      start: "2026-11-10",
      until: "2026-12-20",
      tz: "America/New_York",
    });
    expect(result.ok && result.draft.schedules).toHaveLength(2);
  });
  it("makes a one-off one day", () => {
    const result = draftFromForm({
      ...fresh(),
      once: true,
      date: "2026-10-20",
      onceTimes: ["15:00"],
    });
    expect(result.ok && result.draft).toMatchObject({
      schedules: [{ every: 1, unit: "day", times: ["15:00"] }],
      start: "2026-10-20",
      until: "2026-10-20",
    });
  });
  it("shows every problem at once", () => {
    const result = draftFromForm({
      ...fresh(),
      name: "",
      instruction: " ",
      schedules: [rule({ weekdays: [] })],
      limited: true,
      budget: "0",
      ends: true,
      until: "",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual([
      "budget",
      "instruction",
      "name",
      "schedules",
      "until",
    ]);
    expect(!result.ok && result.errors.schedules?.s0).toEqual({ days: "Pick at least one day." });
  });
  it.each([
    [{ every: "4", unit: "minute" }, { every: "Use a number from 5 to 720." }],
    [{ every: "", unit: "day" }, { every: "Use a number from 1 to 365." }],
    [{ every: "24", unit: "hour" }, { every: "Use a number from 1 to 23." }],
    [{ unit: "month", monthDays: [] }, { days: "Pick at least one day." }],
    [{ unit: "day", times: [""] }, { times: "Pick a time." }],
    [{ unit: "hour", from: "17:00", to: "09:00" }, { span: "End after it starts." }],
  ])("says what is wrong with %j", (fields, errors) => {
    const result = draftFromForm({ ...fresh(), schedules: [rule(fields as never)] });
    expect(!result.ok && result.errors.schedules?.s0).toEqual(errors);
  });
  it("refuses a last day before the first", () => {
    const result = draftFromForm({ ...fresh(), ends: true, until: "2026-10-01" });
    expect(!result.ok && result.errors.until).toBe("The last day can't be before the first.");
  });
  it("round-trips a saved routine", () => {
    const saved = {
      name: "Prices",
      instruction: "Check fares",
      schedules: [
        { every: 4, unit: "hour", from: "08:00" },
        { every: 2, unit: "week", weekdays: [1, 4], times: ["09:00", "17:00"] },
        { every: 1, unit: "month", monthDays: [15, -1], times: ["08:00"] },
      ],
      tz: "America/New_York",
      start: "2026-10-01",
      until: "2026-12-31",
      profile: "read_only",
      notify: "always",
      missedPolicy: "skip",
      approvalWindowMinutes: 30,
      budgetUSD: 1.5,
    } as never;
    const result = draftFromForm(formFromRoutine(saved, "Europe/London", now));
    expect(result.ok && result.draft).toEqual(saved);
  });
  it("opens a one-off as a one-off", () => {
    const form = formFromRoutine(
      {
        name: "x",
        instruction: "y",
        schedules: [{ every: 1, unit: "day", times: ["15:00"] }],
        tz: "Europe/London",
        start: "2026-10-20",
        until: "2026-10-20",
        profile: "ask_first",
        notify: "changes",
        missedPolicy: "run_once",
        approvalWindowMinutes: 60,
        budgetUSD: null,
      },
      "Europe/London",
      now,
    );
    expect(form).toMatchObject({
      once: true,
      date: "2026-10-20",
      onceTimes: ["15:00"],
      ends: false,
    });
  });
  it("fills in the start date's own day where a saved rule leaves it out", () => {
    const form = formFromRoutine(
      {
        name: "x",
        instruction: "y",
        schedules: [
          { every: 1, unit: "week", times: ["09:00"] },
          { every: 1, unit: "month", times: ["09:00"] },
        ],
        tz: "Europe/London",
        start: "2026-10-14",
        until: null,
        profile: "ask_first",
        notify: "changes",
        missedPolicy: "run_once",
        approvalWindowMinutes: 60,
        budgetUSD: null,
      },
      "Europe/London",
      now,
    );
    expect(form.schedules[0]?.weekdays).toEqual([3]);
    expect(form.schedules[1]?.monthDays).toEqual([14]);
  });
  it("refuses a schedule with no run left, unless an edit leaves it as it was", () => {
    const clock = { now };
    const passed = { ...fresh(), once: true, date: "2026-10-12", onceTimes: ["10:00"] };
    const result = draftFromForm(passed, clock);
    expect(!result.ok && result.errors.times).toBe("That time has passed. Pick a later one.");
    expect(draftFromForm({ ...passed, onceTimes: ["10:01"] }, clock).ok).toBe(true);
    const saved = {
      schedules: [{ every: 1, unit: "day" as const, times: ["10:00"] }],
      tz: "Europe/London",
      start: "2026-10-12",
      until: "2026-10-12",
    };
    expect(draftFromForm(passed, { ...clock, saved }).ok).toBe(true);
    const ended = draftFromForm(
      {
        ...fresh(),
        schedules: [rule({ unit: "day", times: ["09:00"] })],
        start: "2026-10-01",
        ends: true,
        until: "2026-10-02",
      },
      clock,
    );
    expect(!ended.ok && ended.errors.until).toBe(
      "No runs are left on those dates. Pick a later last day.",
    );
  });
  it("gives each added schedule its own id, and keeps a step that fits a new unit", () => {
    expect(addedSchedule([rule({ id: "s0" }), rule({ id: "s3" })]).id).toBe("s4");
    expect(withUnit(rule({ every: "2" }), "day").every).toBe("2");
    expect(withUnit(rule({ every: "1" }), "minute").every).toBe("30");
    expect(withUnit(rule({ every: "200" }), "hour").every).toBe("1");
  });
  it("runs every day when it turns to minutes, hours or days, not just the days a week had", () => {
    expect(withUnit(rule({ weekdays: [1, 2] }), "hour").weekdays).toEqual(EVERY_DAY);
    expect(withUnit(rule({ weekdays: [1, 2] }), "day").weekdays).toEqual(EVERY_DAY);
    expect(
      withUnit(rule({ unit: "hour", every: "1", weekdays: [1, 2] }), "minute").weekdays,
    ).toEqual([1, 2]);
  });
  it("previews the words and the next runs as the form stands", () => {
    const preview = previewOf(
      { ...fresh(), schedules: [rule({ times: ["09:00", "17:00"] })], start: "2026-11-10" },
      now,
    );
    expect(preview?.summary).toBe("Weekdays at 9:00 and 17:00, from 10 Nov · London time");
    expect(preview?.runs.slice(0, 3).map((run) => new Date(run).toISOString())).toEqual([
      "2026-11-10T09:00:00.000Z",
      "2026-11-10T17:00:00.000Z",
      "2026-11-11T09:00:00.000Z",
    ]);
    expect(preview?.runs).toHaveLength(5);
    expect(previewOf({ ...fresh(), schedules: [rule({ weekdays: [] })] }, now)).toBeNull();
  });
});
