import { describe, expect, it } from "vitest";
import { MAX_RATE, travelRate } from "./usePlayer.ts";

describe("speeding through a recording to a moment ahead", () => {
  it("sets off at the recording's own speed", () => {
    expect(travelRate(10, 0)).toBe(1);
  });

  it("gathers speed, up to what browsers play", () => {
    expect(travelRate(10, 0.1)).toBeGreaterThan(1);
    expect(travelRate(10, 2)).toBe(MAX_RATE);
  });

  it("never plays slower than itself, even on a frame stamped before the trip began", () => {
    expect(travelRate(10, -0.1)).toBe(1);
  });

  it("slows as it arrives, never below the recording's own speed", () => {
    expect(travelRate(1, 2)).toBeLessThan(travelRate(3, 2));
    expect(travelRate(0.05, 2)).toBe(1);
  });
});
