import { describe, expect, it } from "vitest";
import { gazeTargets, gazeToward } from "./gaze.ts";

const head = { x: 200, y: 300 };

describe("gazeTargets", () => {
  it("looks straight ahead with no attention point", () => {
    expect(gazeTargets(null, head, 500)).toEqual({ eyeX: 0, eyeY: 0, headX: 0, headY: 0 });
  });

  it("turns eyes more than the head toward a point on the right", () => {
    const g = gazeTargets({ x: 450, y: 300 }, head, 500);
    expect(g.eyeX).toBeCloseTo(0.5, 12);
    expect(g.headX).toBeGreaterThan(0);
    expect(g.headX).toBeLessThan(g.eyeX);
    expect(g.eyeY).toBe(0);
  });

  it("treats a point above the head as looking up", () => {
    expect(gazeTargets({ x: 200, y: 50 }, head, 500).eyeY).toBeCloseTo(0.5, 12);
  });

  it("clamps far-away points to the limits", () => {
    const g = gazeTargets({ x: 5000, y: -5000 }, head, 500, { head: 0.6, eye: 1 });
    expect(g.eyeX).toBe(1);
    expect(g.eyeY).toBe(1);
    expect(g.headX).toBeCloseTo(0.36, 12);
  });

  it("ignores non-finite points and a non-positive reach", () => {
    const zero = { eyeX: 0, eyeY: 0, headX: 0, headY: 0 };
    expect(gazeTargets({ x: Number.NaN, y: 1 }, head, 500)).toEqual(zero);
    expect(gazeTargets({ x: 10, y: 10 }, head, 0)).toEqual(zero);
  });
});

describe("gazeToward", () => {
  it("maps a direction onto the eye range and a share of the head range", () => {
    const g = gazeToward({ x: 0.5, y: -0.25 }, { head: 0.6, eye: 0.8 });
    expect(g.eyeX).toBeCloseTo(0.4, 12);
    expect(g.eyeY).toBeCloseTo(-0.2, 12);
    expect(g.headX).toBeCloseTo(0.18, 12);
    expect(g.headY).toBeCloseTo(-0.09, 12);
  });

  it("clamps a direction past the edge of the reach", () => {
    const g = gazeToward({ x: 3, y: -2 });
    expect(g.eyeX).toBe(1);
    expect(g.eyeY).toBe(-1);
    expect(g.headX).toBeCloseTo(0.36, 12);
    expect(g.headY).toBeCloseTo(-0.36, 12);
  });
});
