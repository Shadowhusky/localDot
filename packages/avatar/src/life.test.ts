import { describe, expect, it } from "vitest";
import { BLINK_MS, BlinkSchedule, breathAt, DOUBLE_BLINK_GAP_MS, swayAt } from "./life.ts";

describe("breathAt", () => {
  it("cycles between 0 and 1 every 4 s", () => {
    expect(breathAt(0)).toBeCloseTo(0, 12);
    expect(breathAt(2000)).toBeCloseTo(1, 12);
    expect(breathAt(4000)).toBeCloseTo(0, 12);
    for (let t = 0; t < 8000; t += 37) {
      expect(breathAt(t)).toBeGreaterThanOrEqual(0);
      expect(breathAt(t)).toBeLessThanOrEqual(1);
    }
  });
});

describe("BlinkSchedule", () => {
  it("is deterministic for a seed", () => {
    expect(new BlinkSchedule(7).startsUntil(60_000)).toEqual(
      new BlinkSchedule(7).startsUntil(60_000),
    );
    expect(new BlinkSchedule(7).startsUntil(60_000)).not.toEqual(
      new BlinkSchedule(8).startsUntil(60_000),
    );
  });

  it("spaces blinks 2–6 s apart, with occasional double blinks", () => {
    const starts = new BlinkSchedule(11).startsUntil(600_000);
    const gaps = starts.slice(1).map((s, i) => s - (starts[i] as number));
    const isDouble = (gap: number) => Math.abs(gap - DOUBLE_BLINK_GAP_MS) < 1e-9;
    for (const gap of gaps) expect(isDouble(gap) || (gap >= 2000 && gap <= 6000)).toBe(true);
    expect(gaps.some(isDouble)).toBe(true);
  });

  it("closes and reopens within one blink and is open between blinks", () => {
    const schedule = new BlinkSchedule(3);
    const [first] = schedule.startsUntil(10_000);
    expect(first).toBeDefined();
    const s = first as number;
    expect(schedule.closure(s - 1)).toBe(0);
    expect(schedule.closure(s + 30)).toBeGreaterThan(0);
    expect(schedule.closure(s + 70)).toBe(1);
    expect(schedule.closure(s + BLINK_MS + 1)).toBe(0);
  });

  it("stays cheap and correct ten hours into a session", () => {
    const schedule = new BlinkSchedule(5);
    const started = performance.now();
    const t = 10 * 3600 * 1000;
    for (let i = 0; i < 1000; i++) {
      const c = schedule.closure(t + i * 16);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("swayAt", () => {
  const RANGE = { x: 0.12, y: 0.08, body: 0.45, roll: 0.75, wind: 1 };
  // Largest change in 16 ms: every component is a sine of 6 s or slower.
  const STEP = { x: 0.002, y: 0.002, body: 0.008, roll: 0.011, wind: 0.016 };
  const KEYS = ["x", "y", "body", "roll", "wind"] as const;

  it("stays in range across, up, in lean and in roll, deterministic and slow", () => {
    for (let t = 0; t < 60_000; t += 16) {
      const a = swayAt(t, 9);
      const b = swayAt(t + 16, 9);
      for (const key of KEYS) {
        expect(Math.abs(a[key])).toBeLessThanOrEqual(RANGE[key]);
        expect(Math.abs(b[key] - a[key])).toBeLessThan(STEP[key]);
      }
    }
    expect(swayAt(1234, 9)).toEqual(swayAt(1234, 9));
    expect(swayAt(1234, 9)).not.toEqual(swayAt(1234, 10));
  });

  it("drifts far enough within a minute to read on a rig", () => {
    for (const seed of [1, 3, 5, 7, 9]) {
      const peak = { x: 0, y: 0, body: 0, roll: 0, wind: 0 };
      for (let t = 0; t < 60_000; t += 100) {
        const s = swayAt(t, seed);
        for (const key of KEYS) peak[key] = Math.max(peak[key], Math.abs(s[key]));
      }
      for (const key of KEYS) expect(peak[key]).toBeGreaterThan(RANGE[key] * 0.83);
    }
  });
});
