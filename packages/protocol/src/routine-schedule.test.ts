import { describe, expect, it } from "vitest";
import {
  describeSchedules,
  dueTimesBetween,
  nextDue,
  nextRuns,
  type RoutineTiming,
  zonedToUtc,
} from "./routine-schedule.ts";
import { LAST_DAY, RoutineSchedule } from "./routines.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const next = (schedule: RoutineTiming, after: string) => {
  const value = nextDue(schedule, at(after));
  return value === null ? null : iso(value);
};
const FIRST = "2020-01-01";
const timing = (
  tz: string,
  schedules: RoutineSchedule | readonly RoutineSchedule[],
  extra: Partial<RoutineTiming> = {},
): RoutineTiming => ({
  schedules: Array.isArray(schedules) ? schedules : [schedules as RoutineSchedule],
  tz,
  start: FIRST,
  ...extra,
});
const london = (rule: RoutineSchedule | readonly RoutineSchedule[], extra = {}) =>
  timing("Europe/London", rule, extra);
const newYork = (rule: RoutineSchedule | readonly RoutineSchedule[], extra = {}) =>
  timing("America/New_York", rule, extra);
const daily = (...times: string[]): RoutineSchedule => ({ every: 1, unit: "day", times });
const weekly = (weekdays: number[], ...times: string[]): RoutineSchedule => ({
  every: 1,
  unit: "week",
  weekdays,
  times,
});
const weekdays = (...times: string[]) => weekly([1, 2, 3, 4, 5], ...times);
const hours = (every: number, from?: string): RoutineSchedule => ({
  every,
  unit: "hour",
  ...(from ? { from } : {}),
});

describe("next due time", () => {
  it.each([
    [
      "London spring forward keeps 08:30 local",
      london(daily("08:30")),
      "2026-03-28T08:30:00Z",
      "2026-03-29T07:30:00.000Z",
    ],
    [
      "London fall back keeps 08:30 local",
      london(daily("08:30")),
      "2026-10-24T07:30:00Z",
      "2026-10-25T08:30:00.000Z",
    ],
    [
      "New York spring forward keeps 08:30 local",
      newYork(daily("08:30")),
      "2026-03-07T13:30:00Z",
      "2026-03-08T12:30:00.000Z",
    ],
    [
      "New York fall back keeps 08:30 local",
      newYork(daily("08:30")),
      "2026-10-31T12:30:00Z",
      "2026-11-01T13:30:00.000Z",
    ],
    [
      "London 01:30 in the gap runs at 02:30 BST",
      london(daily("01:30")),
      "2026-03-28T01:30:00Z",
      "2026-03-29T01:30:00.000Z",
    ],
    [
      "London 01:30 twice runs at the first",
      london(daily("01:30")),
      "2026-10-24T00:30:00Z",
      "2026-10-25T00:30:00.000Z",
    ],
    [
      "New York 02:30 in the gap runs at 03:30 EDT",
      newYork(daily("02:30")),
      "2026-03-07T07:30:00Z",
      "2026-03-08T07:30:00.000Z",
    ],
    [
      "weekdays at 08:30 from Friday 09:00 is Monday",
      london(weekdays("08:30")),
      "2026-10-09T08:00:00Z",
      "2026-10-12T07:30:00.000Z",
    ],
    [
      "weekly Monday and Thursday",
      newYork(weekly([1, 4], "09:00")),
      "2026-10-09T13:00:00Z",
      "2026-10-12T13:00:00.000Z",
    ],
    [
      "weekly continues to Thursday",
      newYork(weekly([1, 4], "09:00")),
      "2026-10-12T13:00:00Z",
      "2026-10-15T13:00:00.000Z",
    ],
    [
      "every 4 hours from 09:00 rolls to the next morning",
      london(hours(4, "09:00")),
      "2026-10-09T20:00:00Z",
      "2026-10-10T08:00:00.000Z",
    ],
    [
      "once, before it",
      london(daily("15:00"), { start: "2026-10-12", until: "2026-10-12" }),
      "2026-10-01T00:00:00Z",
      "2026-10-12T14:00:00.000Z",
    ],
    [
      "once, after it",
      london(daily("15:00"), { start: "2026-10-12", until: "2026-10-12" }),
      "2026-10-12T14:00:00Z",
      null,
    ],
    [
      "end date, last day",
      london(daily("08:30"), { until: "2026-10-10" }),
      "2026-10-09T08:00:00Z",
      "2026-10-10T07:30:00.000Z",
    ],
    [
      "end date, after it",
      london(daily("08:30"), { until: "2026-10-10" }),
      "2026-10-10T07:30:00Z",
      null,
    ],
  ] as const)("%s", (_name, schedule, after, expected) => {
    expect(next(schedule, after)).toBe(expected);
  });

  it("maps a skipped wall time forward and a repeated one to its first instant", () => {
    expect(
      new Date(zonedToUtc({ y: 2026, m: 3, d: 29 }, 1, 30, "Europe/London")).toISOString(),
    ).toBe("2026-03-29T01:30:00.000Z");
    expect(
      new Date(zonedToUtc({ y: 2026, m: 10, d: 25 }, 1, 30, "Europe/London")).toISOString(),
    ).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("due times between", () => {
  it("never runs an hourly slot twice when the clock jumps forward", () => {
    const times = dueTimesBetween(
      london(hours(1)),
      at("2026-03-28T23:59:00Z"),
      at("2026-03-29T22:59:00Z"),
    );
    expect(times).toHaveLength(23);
    expect(new Set(times).size).toBe(23);
    expect(new Date(times[0] as number).toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(new Date(times[1] as number).toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });
  it("runs the repeated hour once when the clock falls back", () => {
    const times = dueTimesBetween(
      london(hours(1)),
      at("2026-10-24T22:59:00Z"),
      at("2026-10-25T23:59:00Z"),
    );
    expect(times).toHaveLength(24);
    expect(new Set(times).size).toBe(24);
  });
  it("is bounded", () => {
    expect(dueTimesBetween(london(hours(1)), 0, at("2026-10-01T00:00:00Z"), 100)).toHaveLength(100);
  });
});

describe("the schedule model", () => {
  const from = (after: string, schedule: RoutineTiming, count: number) =>
    nextRuns(schedule, at(after), count).map(iso);

  it("waits for its start date", () => {
    expect(next(london(daily("09:00"), { start: "2026-11-10" }), "2026-10-01T00:00:00Z")).toBe(
      "2026-11-10T09:00:00.000Z",
    );
  });
  it("stops after its last date, inclusive", () => {
    expect(
      from(
        "2026-11-09T00:00:00Z",
        london(daily("09:00"), { start: "2026-11-10", until: "2026-11-11" }),
        5,
      ),
    ).toEqual(["2026-11-10T09:00:00.000Z", "2026-11-11T09:00:00.000Z"]);
  });
  it("runs at several times of day", () => {
    expect(from("2026-11-09T00:00:00Z", london(weekdays("17:00", "09:00")), 4)).toEqual([
      "2026-11-09T09:00:00.000Z",
      "2026-11-09T17:00:00.000Z",
      "2026-11-10T09:00:00.000Z",
      "2026-11-10T17:00:00.000Z",
    ]);
  });
  it("merges several schedules and runs a shared moment once", () => {
    expect(
      from(
        "2026-11-13T00:00:00Z",
        london([weekdays("09:00"), weekly([5, 6], "09:00", "12:00")]),
        4,
      ),
    ).toEqual([
      "2026-11-13T09:00:00.000Z",
      "2026-11-13T12:00:00.000Z",
      "2026-11-14T09:00:00.000Z",
      "2026-11-14T12:00:00.000Z",
    ]);
  });
  it("counts every N days from the start date", () => {
    expect(
      from(
        "2026-11-01T00:00:00Z",
        london({ every: 3, unit: "day", times: ["08:00"] }, { start: "2026-11-02" }),
        3,
      ),
    ).toEqual(["2026-11-02T08:00:00.000Z", "2026-11-05T08:00:00.000Z", "2026-11-08T08:00:00.000Z"]);
  });
  it("counts every N weeks from the Monday of the start date's week", () => {
    expect(
      from(
        "2026-11-01T00:00:00Z",
        london(
          { every: 2, unit: "week", weekdays: [1, 5], times: ["08:00"] },
          { start: "2026-11-04" },
        ),
        3,
      ),
    ).toEqual(["2026-11-06T08:00:00.000Z", "2026-11-16T08:00:00.000Z", "2026-11-20T08:00:00.000Z"]);
  });
  it("runs a week on the start date's weekday unless told otherwise", () => {
    expect(
      next(
        london({ every: 1, unit: "week", times: ["08:00"] }, { start: "2026-11-04" }),
        "2026-11-05T00:00:00Z",
      ),
    ).toBe("2026-11-11T08:00:00.000Z");
  });
  it("counts every N months from the start date's month, on the chosen days", () => {
    expect(
      from(
        "2026-11-01T00:00:00Z",
        london(
          { every: 2, unit: "month", monthDays: [1, 15], times: ["08:00"] },
          { start: "2026-11-02" },
        ),
        3,
      ),
    ).toEqual(["2026-11-15T08:00:00.000Z", "2027-01-01T08:00:00.000Z", "2027-01-15T08:00:00.000Z"]);
  });
  it("passes over a month without the chosen day, and finds each month's last day", () => {
    const thirtyFirst: RoutineSchedule = {
      every: 1,
      unit: "month",
      monthDays: [31],
      times: ["08:00"],
    };
    expect(from("2027-01-01T00:00:00Z", london(thirtyFirst), 2)).toEqual([
      "2027-01-31T08:00:00.000Z",
      "2027-03-31T07:00:00.000Z",
    ]);
    expect(
      from("2027-01-31T12:00:00Z", london({ ...thirtyFirst, monthDays: [LAST_DAY] }), 2),
    ).toEqual(["2027-02-28T08:00:00.000Z", "2027-03-31T07:00:00.000Z"]);
    expect(next(london({ ...thirtyFirst, monthDays: [29] }), "2028-02-28T12:00:00Z")).toBe(
      "2028-02-29T08:00:00.000Z",
    );
  });
  it("repeats every N minutes within the stretch of the chosen days", () => {
    const rule: RoutineSchedule = {
      every: 30,
      unit: "minute",
      from: "09:00",
      to: "10:00",
      weekdays: [1, 5],
    };
    expect(from("2026-11-06T09:20:00Z", london(rule), 4)).toEqual([
      "2026-11-06T09:30:00.000Z",
      "2026-11-06T10:00:00.000Z",
      "2026-11-09T09:00:00.000Z",
      "2026-11-09T09:30:00.000Z",
    ]);
  });
  it("counts hours afresh each day, as an every-few-hours routine always has", () => {
    expect(from("2026-11-06T20:30:00Z", london(hours(6, "08:30")), 3)).toEqual([
      "2026-11-07T08:30:00.000Z",
      "2026-11-07T14:30:00.000Z",
      "2026-11-07T20:30:00.000Z",
    ]);
  });
  it("finishes when nothing can ever fall due", () => {
    expect(
      nextDue(
        london(
          { every: 1, unit: "month", monthDays: [31], times: ["08:00"] },
          {
            start: "2026-02-01",
            until: "2026-02-28",
          },
        ),
        at("2026-02-01T00:00:00Z"),
      ),
    ).toBeNull();
  });
  it("reads a thousand catch-up days of five-minute slots quickly", () => {
    const began = performance.now();
    const times = dueTimesBetween(
      london({ every: 5, unit: "minute" }),
      at("2026-01-01T00:00:00Z"),
      at("2026-04-01T00:00:00Z"),
      100_000,
    );
    expect(times).toHaveLength(90 * 288);
    expect(performance.now() - began).toBeLessThan(2000);
  });
});

describe("clock changes", () => {
  const between = (schedule: RoutineTiming, after: string, until: string) =>
    dueTimesBetween(schedule, at(after), at(until)).map(iso);

  // 2026-03-08 02:00 EST jumps to 03:00 EDT in New York; 2026-11-01 02:00 EDT falls to 01:00 EST.
  it("moves a time the clocks skip, once, without doubling a time already there", () => {
    expect(
      between(
        newYork(daily("02:30", "03:30", "04:00")),
        "2026-03-08T05:00:00Z",
        "2026-03-08T12:00:00Z",
      ),
    ).toEqual(["2026-03-08T07:30:00.000Z", "2026-03-08T08:00:00.000Z"]);
  });
  it("runs a time the clocks repeat once, the first time", () => {
    expect(
      between(newYork(daily("01:30")), "2026-11-01T04:00:00Z", "2026-11-01T08:00:00Z"),
    ).toEqual(["2026-11-01T05:30:00.000Z"]);
  });
  it("steps minutes through a skipped hour without a double", () => {
    const rule: RoutineSchedule = { every: 30, unit: "minute", from: "01:00", to: "04:00" };
    const times = between(newYork(rule), "2026-03-08T05:59:00Z", "2026-03-08T09:00:00Z");
    expect(times).toEqual([
      "2026-03-08T06:00:00.000Z",
      "2026-03-08T06:30:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "2026-03-08T08:00:00.000Z",
    ]);
  });
  it("steps minutes through a repeated hour without a double", () => {
    const rule: RoutineSchedule = { every: 30, unit: "minute", from: "00:30", to: "02:30" };
    const times = between(newYork(rule), "2026-11-01T04:00:00Z", "2026-11-01T08:00:00Z");
    expect(times).toEqual([
      "2026-11-01T04:30:00.000Z",
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      // 02:00 EST: the second 01:00 and 01:30 pass without a run.
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T07:30:00.000Z",
    ]);
  });
  it("keeps every N days on the wall clock across a change", () => {
    const rule: RoutineSchedule = { every: 2, unit: "day", times: ["09:00"] };
    expect(
      between(
        newYork(rule, { start: "2026-03-06" }),
        "2026-03-06T00:00:00Z",
        "2026-03-10T23:00:00Z",
      ),
    ).toEqual(["2026-03-06T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-10T13:00:00.000Z"]);
  });
});

describe("schedule rules", () => {
  it.each([
    [{ every: 1, unit: "minute" }, "A step in minutes must be from 5 to 720."],
    [{ every: 24, unit: "hour" }, "A step in hours must be from 1 to 23."],
    [{ every: 1, unit: "day" }, "Say what time it runs."],
    [
      { every: 1, unit: "hour", times: ["09:00"] },
      "A step in hours has no set times: use from and to.",
    ],
    [
      { every: 1, unit: "day", times: ["09:00"], from: "09:00" },
      "From and to work with minutes and hours.",
    ],
    [
      { every: 1, unit: "hour", from: "17:00", to: "09:00" },
      "The end of the day's stretch must come after its start.",
    ],
    [
      { every: 1, unit: "week", times: ["09:00"], monthDays: [1] },
      "Days of the month work with months.",
    ],
    [
      { every: 1, unit: "month", times: ["09:00"], weekdays: [1] },
      "Weekdays don't work with months.",
    ],
    [{ every: 1, unit: "day", times: ["09:00", "09:00"] }, "A time repeats."],
  ])("refuses %j in plain words", (rule, message) => {
    const parsed = RoutineSchedule.safeParse(rule);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(message);
  });
});

describe("describe", () => {
  const NOW = at("2026-11-04T12:00:00Z");
  it.each([
    [london(weekdays("08:30")), "Weekdays at 8:30 · London time"],
    [london(daily("08:30")), "Every day at 8:30 · London time"],
    [newYork(weekly([1, 4], "09:00")), "Mondays and Thursdays at 9:00 · New York time"],
    [london(weekly([5, 1, 3], "09:00")), "Mondays, Wednesdays and Fridays at 9:00 · London time"],
    [london(weekly([0, 6], "10:00")), "Weekends at 10:00 · London time"],
    [london(weekly([0, 1, 2, 3, 4, 5, 6], "10:00")), "Every day at 10:00 · London time"],
    [london(hours(1)), "Every hour · London time"],
    [london(hours(4, "09:00")), "Every 4 hours from 9:00 · London time"],
    [
      london(daily("15:00"), { start: "2026-11-12", until: "2026-11-12" }),
      "Once on 12 Nov at 15:00 · London time",
    ],
    [
      london(daily("15:00"), { start: "2027-01-12", until: "2027-01-12" }),
      "Once on 12 Jan 2027 at 15:00 · London time",
    ],
    [
      london(daily("08:30"), { until: "2026-12-31" }),
      "Every day at 8:30 until 31 Dec · London time",
    ],
    [
      london(weekdays("09:00", "17:00"), { start: "2026-11-10" }),
      "Weekdays at 9:00 and 17:00, from 10 Nov · London time",
    ],
    [
      london(weekdays("09:00"), { start: "2026-11-10", until: "2026-12-20" }),
      "Weekdays at 9:00, from 10 Nov until 20 Dec · London time",
    ],
    [london(weekdays("09:00"), { start: "2026-11-04" }), "Weekdays at 9:00 · London time"],
    [
      london([weekdays("09:00"), weekly([6], "10:00", "11:30")]),
      "Weekdays at 9:00; Saturdays at 10:00 and 11:30 · London time",
    ],
    [
      london({ every: 2, unit: "week", weekdays: [1], times: ["09:00"] }),
      "Every 2 weeks on Mondays at 9:00 · London time",
    ],
    [london({ every: 3, unit: "day", times: ["09:00"] }), "Every 3 days at 9:00 · London time"],
    [
      london({ every: 1, unit: "month", monthDays: [LAST_DAY, 2, 1, 21], times: ["09:00"] }),
      "Every month on the 1st, the 2nd, the 21st and the last day at 9:00 · London time",
    ],
    [
      london({ every: 3, unit: "month", monthDays: [13], times: ["09:00"] }),
      "Every 3 months on the 13th at 9:00 · London time",
    ],
    [
      london({ every: 30, unit: "minute", from: "09:00", to: "17:00", weekdays: [1, 2, 3, 4, 5] }),
      "Every 30 minutes on weekdays from 9:00 to 17:00 · London time",
    ],
    [timing("UTC", daily("08:30")), "Every day at 8:30 · UTC"],
    [timing("Asia/Ho_Chi_Minh", daily("08:30")), "Every day at 8:30 · Ho Chi Minh time"],
  ])("%j", (schedule, text) => {
    expect(describeSchedules(schedule, NOW)).toBe(text);
  });
  it("stays within what a routine's summary may hold", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      weekly([1, 2, 3, 4, 5, 6].slice(index % 3), "09:00", "10:00", "11:00", "12:00", "13:00"),
    );
    const text = describeSchedules(london(many), NOW);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toMatch(/ and \d+ more · London time$/);
  });
});
