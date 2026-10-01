import { describe, expect, it } from "vitest";
import { fitFrame } from "./layout.ts";

const root = { x: 200, y: 600 };

describe("fitFrame", () => {
  it("scales a tall frame by height and centres it", () => {
    const p = fitFrame({ x: 0, y: 0, w: 400, h: 600 }, root, 800, 300);
    expect(p?.scale).toBeCloseTo(0.5, 6);
    expect(p?.x).toBeCloseTo(400, 6);
    expect(p?.y).toBeCloseTo(300, 6);
  });

  it("zooms into a head-and-shoulders frame", () => {
    const p = fitFrame({ x: 100, y: 100, w: 200, h: 200 }, root, 200, 200);
    expect(p?.scale).toBeCloseTo(1, 6);
    expect(p?.y).toBeCloseTo(100 - (200 - 600), 6);
  });

  it("returns null for an empty element or frame instead of NaN", () => {
    expect(fitFrame({ x: 0, y: 0, w: 400, h: 600 }, root, 0, 300)).toBeNull();
    expect(fitFrame({ x: 0, y: 0, w: 0, h: 600 }, root, 800, 300)).toBeNull();
    expect(fitFrame({ x: 0, y: 0, w: 400, h: 600 }, root, Number.NaN, 300)).toBeNull();
  });
});
