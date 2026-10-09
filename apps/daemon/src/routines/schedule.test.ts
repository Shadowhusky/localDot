import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  dueTimesBetween,
  nextDue,
  type Schedule,
  zonedToUtc,
} from "./schedule.ts";

const at = (iso: string) => Date.parse(iso);
const next = (schedule: Schedule, after: string) => {
  const value = nextDue(schedule, at(after));
  return value === null ? null : new Date(value).toISOString();
};
const london = (when: Schedule["when"], extra: Partial<Schedule> = {}): Schedule => ({
  when,
  tz: "Europe/London",
  ...extra,
});
const newYork = (when: Schedule["when"]): Schedule => ({ when, tz: "America/New_York" });

describe("next due time", () => {
  it.each([
    [
      "London spring forward keeps 08:30 local",
      london({ kind: "daily", time: "08:30" }),
      "2026-03-28T08:30:00Z",
      "2026-03-29T07:30:00.000Z",
    ],
    [
      "London fall back keeps 08:30 local",
      london({ kind: "daily", time: "08:30" }),
      "2026-10-24T07:30:00Z",
      "2026-10-25T08:30:00.000Z",
    ],
    [
      "New York spring forward keeps 08:30 local",
      newYork({ kind: "daily", time: "08:30" }),
      "2026-03-07T13:30:00Z",
      "2026-03-08T12:30:00.000Z",
    ],
    [
      "New York fall back keeps 08:30 local",
      newYork({ kind: "daily", time: "08:30" }),
      "2026-10-31T12:30:00Z",
      "2026-11-01T13:30:00.000Z",
    ],
    [
      "London 01:30 in the gap runs at 02:30 BST",
      london({ kind: "daily", time: "01:30" }),
      "2026-03-28T01:30:00Z",
      "2026-03-29T01:30:00.000Z",
    ],
    [
      "London 01:30 twice runs at the first",
      london({ kind: "daily", time: "01:30" }),
      "2026-10-24T00:30:00Z",
      "2026-10-25T00:30:00.000Z",
    ],
    [
      "New York 02:30 in the gap runs at 03:30 EDT",
      newYork({ kind: "daily", time: "02:30" }),
      "2026-03-07T07:30:00Z",
      "2026-03-08T07:30:00.000Z",
    ],
    [
      "weekdays at 08:30 from Friday 09:00 is Monday",
      london({ kind: "weekdays", time: "08:30" }),
      "2026-10-09T08:00:00Z",
      "2026-10-12T07:30:00.000Z",
    ],
    [
      "weekly Monday and Thursday",
      newYork({ kind: "weekly", days: [1, 4], time: "09:00" }),
      "2026-10-09T13:00:00Z",
      "2026-10-12T13:00:00.000Z",
    ],
    [
      "weekly continues to Thursday",
      newYork({ kind: "weekly", days: [1, 4], time: "09:00" }),
      "2026-10-12T13:00:00Z",
      "2026-10-15T13:00:00.000Z",
    ],
    [
      "every 4 hours from 09:00 rolls to the next morning",
      london({ kind: "hours", every: 4, from: "09:00" }),
      "2026-10-09T20:00:00Z",
      "2026-10-10T08:00:00.000Z",
    ],
    [
      "once, before it",
      london({ kind: "once", date: "2026-10-12", time: "15:00" }),
      "2026-10-01T00:00:00Z",
      "2026-10-12T14:00:00.000Z",
    ],
    [
      "once, after it",
      london({ kind: "once", date: "2026-10-12", time: "15:00" }),
      "2026-10-12T14:00:00Z",
      null,
    ],
    [
      "end date, last day",
      london({ kind: "daily", time: "08:30" }, { until: "2026-10-10" }),
      "2026-10-09T08:00:00Z",
      "2026-10-10T07:30:00.000Z",
    ],
    [
      "end date, after it",
      london({ kind: "daily", time: "08:30" }, { until: "2026-10-10" }),
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
      london({ kind: "hours", every: 1 }),
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
      london({ kind: "hours", every: 1 }),
      at("2026-10-24T22:59:00Z"),
      at("2026-10-25T23:59:00Z"),
    );
    expect(times).toHaveLength(24);
    expect(new Set(times).size).toBe(24);
  });
  it("is bounded", () => {
    expect(
      dueTimesBetween(london({ kind: "hours", every: 1 }), 0, at("2026-10-01T00:00:00Z"), 100),
    ).toHaveLength(100);
  });
});

describe("describe", () => {
  it.each([
    [london({ kind: "weekdays", time: "08:30" }), "Weekdays at 08:30 · London time"],
    [london({ kind: "daily", time: "08:30" }), "Every day at 08:30 · London time"],
    [
      newYork({ kind: "weekly", days: [1, 4], time: "09:00" }),
      "Mondays and Thursdays at 09:00 · New York time",
    ],
    [
      london({ kind: "weekly", days: [5, 1, 3], time: "09:00" }),
      "Mondays, Wednesdays and Fridays at 09:00 · London time",
    ],
    [london({ kind: "hours", every: 1 }), "Every hour · London time"],
    [london({ kind: "hours", every: 4, from: "09:00" }), "Every 4 hours from 09:00 · London time"],
    [
      london({ kind: "once", date: "2026-10-12", time: "15:00" }),
      "Once on 12 Oct 2026 at 15:00 · London time",
    ],
    [
      london({ kind: "daily", time: "08:30" }, { until: "2026-12-31" }),
      "Every day at 08:30 until 31 Dec 2026 · London time",
    ],
    [{ when: { kind: "daily", time: "08:30" }, tz: "UTC" } as Schedule, "Every day at 08:30 · UTC"],
    [
      { when: { kind: "daily", time: "08:30" }, tz: "Asia/Ho_Chi_Minh" } as Schedule,
      "Every day at 08:30 · Ho Chi Minh time",
    ],
  ])("describes the zone in words: %j", (schedule, text) => {
    expect(describeSchedule(schedule)).toBe(text);
  });
});
