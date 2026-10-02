import { describe, expect, it } from "vitest";
import {
  dwellMs,
  INSTANT_LEAD_MS,
  intentLeadMs,
  travelDurationMs,
  typingPaceMs,
} from "./travel.ts";

describe("travelDurationMs", () => {
  it("follows 150 + 100·log2(D/W + 1) in watch mode", () => {
    expect(travelDurationMs(100, 24, "watch")).toBeCloseTo(150 + 100 * Math.log2(100 / 24 + 1), 6);
  });

  it("clamps short moves to 220 ms and long moves to 700 ms", () => {
    expect(travelDurationMs(0, 24, "watch")).toBe(220);
    expect(travelDurationMs(10_000, 10, "watch")).toBe(700);
  });

  it("halves in fast mode and is zero when instant", () => {
    expect(travelDurationMs(10_000, 10, "fast")).toBe(350);
    expect(travelDurationMs(500, 40, "instant")).toBe(0);
  });

  it("assumes a 24 px target when the width is unknown", () => {
    expect(travelDurationMs(300, undefined, "watch")).toBe(travelDurationMs(300, 24, "watch"));
  });
});

describe("timing guards and pace", () => {
  it("refuses invalid distances and target widths, including instant mode", () => {
    expect(() => travelDurationMs(Number.NaN, 24, "watch")).toThrow(RangeError);
    expect(() => travelDurationMs(-1, 24, "instant")).toThrow(RangeError);
    expect(() => travelDurationMs(100, Number.NaN, "watch")).toThrow(RangeError);
  });
  it("leads the cursor and paces typing at each playback speed", () => {
    expect(
      ["watch", "fast", "instant"].map((s) => intentLeadMs(s as "watch" | "fast" | "instant")),
    ).toEqual([120, 60, 0]);
    expect(typingPaceMs("watch", 0)).toBe(35);
    expect(typingPaceMs("watch", 59)).toBe(35);
    expect(typingPaceMs("watch", 60)).toBe(6);
    expect(typingPaceMs("fast", 0)).toBe(8);
    expect(typingPaceMs("instant", 0)).toBe(0);
  });
});

describe("dwellMs", () => {
  it("is 90 ms when watching, 45 ms fast, 0 instant", () => {
    expect(dwellMs("watch")).toBe(90);
    expect(dwellMs("fast")).toBe(45);
    expect(dwellMs("instant")).toBe(0);
    expect(INSTANT_LEAD_MS).toBe(60);
  });
});
