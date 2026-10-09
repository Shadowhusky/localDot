import { describe, expect, it } from "vitest";
import { dayLabel, initials, personLine, sourceLine } from "./memory-copy.ts";

const now = new Date(2026, 9, 8);
const day = (y: number, m: number, d: number, year = false) =>
  new Date(y, m - 1, d)
    .toLocaleDateString([], {
      day: "numeric",
      month: "short",
      ...(year ? { year: "numeric" } : {}),
    })
    .replace(/\s/g, "\u00a0");
const dot = "\u00a0·\u00a0";
const TASK = "01JXYZ0000000000000000TASK";
describe("memory copy", () => {
  it("names a fact's source and day", () => {
    expect(
      sourceLine(
        {
          at: "2026-09-03",
          source: { kind: "task", sessionId: TASK, title: "Renew the car insurance" },
        },
        now,
      ),
    ).toEqual({
      text: "From Renew the car insurance",
      day: `${dot}${day(2026, 9, 3)}`,
      sessionId: TASK,
    });
    expect(
      sourceLine({ at: "2026-09-03", source: { kind: "task", sessionId: TASK, title: null } }, now),
    ).toEqual({ text: "From a deleted task", day: `${dot}${day(2026, 9, 3)}` });
    expect(sourceLine({ at: "2025-12-24", source: { kind: "user" } }, now)).toEqual({
      text: "Added by you",
      day: `${dot}${day(2025, 12, 24, true)}`,
    });
    expect(sourceLine({ at: null, source: { kind: "unknown" } }, now)).toEqual({
      text: "Source unknown",
      day: "",
    });
  });
  it("labels a day in this year without the year, as one unbreakable piece", () => {
    expect(dayLabel("2026-10-08", now)).toBe(day(2026, 10, 8));
    expect(dayLabel("2025-10-08", now)).not.toMatch(/\s(?<!\u00a0)/);
    expect(dayLabel("2026-10-08", now)).not.toContain("2026");
    expect(dayLabel("2025-10-08", now)).toContain("2025");
  });
  it("says how the user reaches someone and when last", () => {
    const henry = {
      id: TASK,
      name: "Henry Liu",
      app: "WeChat",
      handle: "henry_l",
      note: null,
      lastAt: "2026-10-08",
      source: { kind: "user" as const },
      revision: "0123456789abcdef",
    };
    expect(personLine(henry, now)).toBe(`WeChat · henry_l · last ${day(2026, 10, 8)}`);
    expect(personLine({ ...henry, handle: null, lastAt: null }, now)).toBe("WeChat");
    expect(initials("Henry Liu")).toBe("HL");
    expect(initials("小明")).toBe("小");
  });
});
