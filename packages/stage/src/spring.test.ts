import { describe, expect, it } from "vitest";
import { SPRING_DEFAULT, springValue } from "./spring.ts";

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
