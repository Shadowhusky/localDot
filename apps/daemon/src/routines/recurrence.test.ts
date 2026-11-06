import { describe, expect, it } from "vitest";
import { parseRule, RecurrenceError } from "./recurrence.ts";

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
});
