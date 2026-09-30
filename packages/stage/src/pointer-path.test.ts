import { describe, expect, it } from "vitest";
import { type PointerPlan, pointerAt } from "./pointer-path.ts";

const plan: PointerPlan = {
  from: { x: 0, y: 0 },
  to: { x: 500, y: 0 },
  startsAt: 1000,
  durationMs: 500,
  seed: 7,
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

  it("overshoots by at most 3% and corrects back", () => {
    const xs = samples(plan).map((p) => p.x);
    expect(Math.max(...xs)).toBeGreaterThan(500);
    expect(Math.max(...xs)).toBeLessThanOrEqual(500 * 1.03 + 1e-9);
  });

  it("bows sideways by at most min(5% of distance, 36 px)", () => {
    const ys = samples(plan).map((p) => Math.abs(p.y));
    expect(Math.max(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(25 + 1e-9);
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
});
