import { describe, expect, it } from "vitest";
import { motionSamples } from "./motion.ts";

describe("motionSamples", () => {
  const way = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 100 },
  ];

  it("visits every waypoint, ending on the last, at whole pixels", () => {
    const samples = motionSamples(way, 400);
    const points = samples.map((s) => s.at);
    expect(points).toContainEqual({ x: 300, y: 0 });
    expect(points.at(-1)).toEqual({ x: 300, y: 100 });
    for (const p of points)
      expect([Number.isInteger(p.x), Number.isInteger(p.y)]).toEqual([true, true]);
  });

  it("shares the time by length and eases each segment in and out", () => {
    const samples = motionSamples(way, 400);
    const corner = samples.findIndex((s) => s.at.x === 300 && s.at.y === 0);
    expect(samples[corner]?.t).toBeGreaterThan(270);
    expect(samples[corner]?.t).toBeLessThanOrEqual(300);
    expect(samples.at(-1)?.t).toBeCloseTo(400, 0);
    const steps = samples.slice(0, corner + 1).map((s, i, all) => s.at.x - (all[i - 1]?.at.x ?? 0));
    const middle = steps[Math.floor(steps.length / 2)] as number;
    expect(steps[0]).toBeLessThan(middle);
    expect(steps.at(-1)).toBeLessThan(middle);
  });

  it("moves at 60 to 120 motions a second, slowing a dense path down rather than going faster", () => {
    const rate = (points: { x: number; y: number }[], ms: number) => {
      const samples = motionSamples(points, ms);
      return samples.length / ((samples.at(-1)?.t ?? 0) / 1000);
    };
    expect(rate(way, 1000)).toBeGreaterThanOrEqual(60);
    expect(rate(way, 1000)).toBeLessThanOrEqual(120);
    const dense = Array.from({ length: 64 }, (_, i) => ({ x: i * 10, y: (i % 2) * 10 }));
    expect(rate(dense, 200)).toBeLessThanOrEqual(120.5);
    for (const [i, s] of motionSamples(dense, 200).entries())
      expect(s.t).toBeGreaterThan(motionSamples(dense, 200)[i - 1]?.t ?? -1);
  });

  it("leaves out samples that would not move the cursor", () => {
    const samples = motionSamples(
      [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
        { x: 7, y: 5 },
      ],
      300,
    );
    expect(samples.map((s) => s.at)).toEqual([
      { x: 6, y: 5 },
      { x: 7, y: 5 },
    ]);
  });
});
