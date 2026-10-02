import type { PointerPlan } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { OVERSHOOT_CAP_PX, pointerAt } from "./pointer-path.ts";

const plan: PointerPlan = {
  from: { x: 0, y: 0 },
  to: { x: 500, y: 0 },
  startsAt: 1000,
  durationMs: 500,
  seed: 7,
  curve: "minjerk-bow-v1",
};
const samples = (p: PointerPlan) =>
  Array.from({ length: 501 }, (_, i) => pointerAt(p, p.startsAt + i));

describe("pointerAt", () => {
  it("sits at the start before travel and exactly on the target after it", () => {
    expect(pointerAt(plan, 0)).toEqual(plan.from);
    expect(pointerAt(plan, 1000)).toEqual(plan.from);
    expect(pointerAt(plan, 1500)).toEqual(plan.to);
    expect(pointerAt(plan, 9999)).toEqual(plan.to);
  });

  it("caps overshoot at 12 px even on long moves", () => {
    const xs = samples(plan).map((p) => p.x);
    expect(Math.max(...xs)).toBeGreaterThan(500);
    expect(Math.max(...xs)).toBeLessThanOrEqual(500 + OVERSHOOT_CAP_PX + 1e-9);
    const long = { ...plan, to: { x: 2000, y: 0 }, durationMs: 700 };
    const far = Array.from({ length: 701 }, (_, i) => pointerAt(long, long.startsAt + i).x);
    expect(Math.max(...far)).toBeLessThanOrEqual(2000 + OVERSHOOT_CAP_PX + 1e-9);
  });

  it("falls back to a straight line for a future curve", () => {
    const future = { ...plan, curve: "unknown-v9" as unknown as PointerPlan["curve"] };
    const point = pointerAt(future, 1250);
    expect(point.y).toBe(0);
    expect(point.x).toBeGreaterThan(0);
    expect(point.x).toBeLessThan(500);
    expect(pointerAt(future, 1500)).toEqual(plan.to);
  });

  it("refuses non-finite plans and times", () => {
    expect(() => pointerAt({ ...plan, to: { x: Number.NaN, y: 0 } }, 1200)).toThrow(RangeError);
    expect(() => pointerAt({ ...plan, durationMs: Number.POSITIVE_INFINITY }, 1200)).toThrow(
      RangeError,
    );
    expect(() => pointerAt(plan, Number.NaN)).toThrow(RangeError);
  });

  it("bows sideways by at most min(5% of distance, 36 px)", () => {
    const ys = samples(plan).map((p) => Math.abs(p.y));
    expect(Math.max(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(25 + 1e-9);
  });

  it("eases the bow in and out with no sideways velocity at departure or at the overshoot", () => {
    const primaryEnd = plan.startsAt + 0.85 * plan.durationMs;
    expect(Math.abs(pointerAt(plan, plan.startsAt + 1).y)).toBeLessThan(0.01);
    expect(Math.abs(pointerAt(plan, primaryEnd - 1).y)).toBeLessThan(0.01);
  });

  it("is deterministic for a seed and varies across seeds", () => {
    expect(pointerAt(plan, 1200)).toEqual(pointerAt(plan, 1200));
    const other = { ...plan, seed: 8 };
    expect(pointerAt(other, 1200)).not.toEqual(pointerAt(plan, 1200));
  });

  it("stays put when start and target coincide", () => {
    const still = { ...plan, to: { x: 0, y: 0 } };
    for (const p of samples(still)) expect(p).toEqual({ x: 0, y: 0 });
  });

  it("jumps straight to the target when the duration is zero", () => {
    expect(pointerAt({ ...plan, durationMs: 0 }, 1000)).toEqual(plan.to);
  });

  it("holds an instant plan at the start until it begins", () => {
    const instant = { ...plan, durationMs: 0 };
    expect(pointerAt(instant, 0)).toEqual(plan.from);
    expect(pointerAt(instant, 999)).toEqual(plan.from);
    expect(pointerAt(instant, 1000)).toEqual(plan.to);
  });
});
