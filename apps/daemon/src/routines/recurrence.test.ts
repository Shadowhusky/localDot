import { describe, expect, it } from "vitest";
import { parseRule, RecurrenceError } from "./recurrence.ts";
import { nextDue, type Schedule } from "./schedule.ts";

const custom = (rule: string, anchor: string): Schedule => ({
  when: { kind: "custom", rule },
  tz: "Europe/London",
  anchor,
});
const chain = (schedule: Schedule, from: string, n: number) => {
  const out: string[] = [];
  let cursor = Date.parse(from);
  for (let i = 0; i < n; i++) {
    const value = nextDue(schedule, cursor);
    if (value === null) break;
    out.push(new Date(value).toISOString());
    cursor = value;
  }
  return out;
};

describe("custom rules", () => {
  it("parses the supported subset", () => {
    expect(parseRule("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=15")).toEqual({
      freq: "WEEKLY",
      interval: 1,
      byDay: [1, 3],
      byHour: [9],
      byMinute: 15,
    });
  });
  it.each([
    "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;COUNT=3",
    "FREQ=DAILY;BYHOUR=9;UNTIL=20261231T000000Z",
    "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9",
    "FREQ=HOURLY;BYHOUR=9",
    "FREQ=WEEKLY;BYDAY=MO",
    "FREQ=WEEKLY;BYDAY=1MO;BYHOUR=9",
    "FREQ=DAILY;INTERVAL=0;BYHOUR=9",
    "FREQ=DAILY;BYHOUR=24",
    "FREQ=DAILY;BYHOUR=9;BYHOUR=10",
    "FREQ=DAILY;BYHOUR=1,2,3,4,5,6,7",
    "FREQ=DAILY;BYHOUR=9;COLOUR=blue",
  ])("refuses %s", (rule) => {
    expect(() => parseRule(rule)).toThrow(RecurrenceError);
  });
  it.each([
    ["FREQ=MONTHLY;BYDAY=MO;BYHOUR=9", "For a monthly routine, use BYMONTHDAY"],
    ["FREQ=DAILY;BYMONTHDAY=1;BYHOUR=9", "BYMONTHDAY works only with FREQ=MONTHLY"],
    ["FREQ=WEEKLY;BYDAY=MO;BYMONTHDAY=1;BYHOUR=9", "BYMONTHDAY works only with FREQ=MONTHLY"],
  ])("refuses %s instead of running on days nobody asked for", (rule, message) => {
    expect(() => parseRule(rule)).toThrow(message);
  });
  it("counts INTERVAL weeks from the creation date", () => {
    expect(
      chain(
        custom("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;BYHOUR=8", "2026-10-05"),
        "2026-10-05T00:00:00Z",
        3,
      ),
    ).toEqual(["2026-10-06T07:00:00.000Z", "2026-10-20T07:00:00.000Z", "2026-11-03T08:00:00.000Z"]);
  });
  it("skips months without the requested day", () => {
    expect(
      chain(custom("FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=7", "2026-10-01"), "2026-10-01T00:00:00Z", 2),
    ).toEqual(["2026-10-31T07:00:00.000Z", "2026-12-31T07:00:00.000Z"]);
  });
  it("runs every third day", () => {
    expect(
      chain(
        custom("FREQ=DAILY;INTERVAL=3;BYHOUR=6;BYMINUTE=30", "2026-10-10"),
        "2026-10-10T00:00:00Z",
        3,
      ),
    ).toEqual(["2026-10-10T05:30:00.000Z", "2026-10-13T05:30:00.000Z", "2026-10-16T05:30:00.000Z"]);
  });
  it("needs an anchor", () => {
    expect(() =>
      nextDue({ when: { kind: "custom", rule: "FREQ=DAILY;BYHOUR=6" }, tz: "Europe/London" }, 0),
    ).toThrow(RecurrenceError);
  });
});
