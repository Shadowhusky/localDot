import { describe, expect, it } from "vitest";
import { microsToMs, msToMicros, msToSeconds, requireFinite, sessionMsOf } from "./time.ts";

describe("time units", () => {
  it("converts session microseconds to render and helper milliseconds", () => {
    expect(microsToMs(1_635_100)).toBe(1635.1);
    expect(msToMicros(1635.1)).toBe(1_635_100);
    expect(msToMicros(0.0004)).toBe(0);
    expect(msToMicros(-2.5)).toBe(-2500);
    expect(sessionMsOf({ t: 2_500_000 })).toBe(2500);
    expect(msToSeconds(310)).toBe(0.31);
  });
  it("refuses non-finite input", () => {
    expect(() => microsToMs(Number.NaN)).toThrow(RangeError);
    expect(() => msToMicros(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => requireFinite(Number.NaN, "distance")).toThrow("distance must be finite");
    expect(requireFinite(-2, "distance")).toBe(-2);
  });
});
