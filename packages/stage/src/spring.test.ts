import { describe, expect, it } from "vitest";
import { SPRING_DEFAULT, springProgress, springTrack, springValue } from "./spring.ts";

const range = (end: number, step: number) =>
  Array.from({ length: Math.round(end / step) + 1 }, (_, i) => i * step);

describe("springValue", () => {
  it("refuses invalid physics parameters and non-finite inputs", () => {
    for (const response of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => springValue(0, 1, 0, 0.1, { dampingRatio: 1, response })).toThrow(RangeError);
    }
    for (const dampingRatio of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => springValue(0, 1, 0, 0.1, { dampingRatio, response: 0.4 })).toThrow(RangeError);
    }
    expect(() => springValue(Number.NaN, 1, 0, 0.1, SPRING_DEFAULT)).toThrow(RangeError);
  });
  it("starts at the current value", () => {
    expect(springValue(0, 1, 0, 0, SPRING_DEFAULT)).toBe(0);
  });

  it("never overshoots when critically damped", () => {
    let previous = 0;
    for (const t of range(2, 0.01)) {
      const v = springValue(0, 1, 0, t, { dampingRatio: 1, response: 0.4 });
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
      expect(v).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = v;
    }
  });

  it("overshoots when underdamped", () => {
    const peak = Math.max(
      ...range(2, 0.005).map((t) => springValue(0, 1, 0, t, { dampingRatio: 0.5, response: 0.4 })),
    );
    expect(peak).toBeGreaterThan(1);
  });

  it("settles on the target for every damping regime", () => {
    for (const dampingRatio of [0.5, 0.8, 1, 1.5]) {
      expect(Math.abs(springValue(0, 1, 0, 3, { dampingRatio, response: 0.4 }) - 1)).toBeLessThan(
        1e-3,
      );
    }
  });

  it("carries initial velocity", () => {
    const withVelocity = springValue(0, 1, 10, 0.05, SPRING_DEFAULT);
    const atRest = springValue(0, 1, 0, 0.05, SPRING_DEFAULT);
    expect(withVelocity).toBeGreaterThan(atRest);
  });
});

describe("springTrack", () => {
  const p = { dampingRatio: 1, response: 0.2 };

  it("holds its start before the first step and settles exactly on the last target", () => {
    const steps = [{ at: 100, to: 1, spring: p }];
    expect(springTrack(0, steps, 50)).toBe(0);
    expect(springTrack(0, steps, 100)).toBe(0);
    expect(springTrack(0, steps, 200)).toBeGreaterThan(0.5);
    expect(springTrack(0, steps, 100 + 400)).toBe(1);
  });

  it("reverses from where it is, carrying its velocity, without a jump", () => {
    const steps = [
      { at: 0, to: 1, spring: p },
      { at: 60, to: 0, spring: p },
    ];
    const before = springTrack(0, steps, 59.9);
    const after = springTrack(0, steps, 60.1);
    expect(Math.abs(after - before)).toBeLessThan(0.01);
    // Still rising just after the reversal: the velocity it had carries on for a moment.
    expect(springTrack(0, steps, 65)).toBeGreaterThan(springTrack(0, steps, 60));
    expect(springTrack(0, steps, 60 + 400)).toBe(0);
  });

  it("kicks out and back to rest", () => {
    const steps = [{ at: 0, to: 0, spring: p, kick: 100 }];
    expect(springTrack(0, steps, 30)).toBeGreaterThan(0);
    expect(springTrack(0, steps, 400)).toBe(0);
  });
});

describe("springProgress", () => {
  it("runs 0 → 1 without overshoot and reports exactly 1 once settled", () => {
    expect(springProgress(0, 0.35)).toBe(0);
    expect(springProgress(350, 0.35)).toBeGreaterThan(0.95);
    expect(springProgress(350, 0.35)).toBeLessThan(1);
    expect(springProgress(700, 0.35)).toBe(1);
  });
});
