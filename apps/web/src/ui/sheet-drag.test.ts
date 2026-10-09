import { describe, expect, it } from "vitest";
import {
  DISMISS_AT,
  detentStops,
  project,
  restingStop,
  rubberband,
  velocityOf,
} from "./sheet-drag.ts";

describe("sheet drag", () => {
  it("projects a release the way a scroll view decelerates", () => {
    expect(project(0)).toBe(0);
    expect(project(1000)).toBeCloseTo(499, 0);
    expect(project(-500)).toBeCloseTo(-249.5, 1);
  });

  it("resists more the further it is pulled past the open position", () => {
    const near = rubberband(20, 600);
    const far = rubberband(200, 600);
    expect(near).toBeLessThan(20);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeLessThan(200);
    expect(far / 200).toBeLessThan(near / 20);
    expect(rubberband(10_000, 600)).toBeLessThan(600);
  });

  it("closes on a release projected past 30% of the height and springs back otherwise", () => {
    const height = 600;
    expect(DISMISS_AT).toBe(0.3);
    expect(restingStop(100, 0, [0], height)).toBe(0);
    expect(restingStop(181, 0, [0], height)).toBe("dismiss");
    // A flick from near the top still closes; a slow push back up does not.
    expect(restingStop(40, 900, [0], height)).toBe("dismiss");
    expect(restingStop(300, -800, [0], height)).toBe(0);
  });

  it("rests medium 174 px under large, and a lone detent at the top", () => {
    expect(detentStops(["medium", "large"])).toEqual([174, 0]);
    expect(detentStops(["large"])).toEqual([0]);
    expect(detentStops(["fit"])).toEqual([0]);
  });

  it("settles a release into the detent nearest where it would land", () => {
    const stops = detentStops(["medium", "large"]);
    const height = 804;
    // Let go still, nearer large: back to large; nearer medium: medium.
    expect(restingStop(60, 0, stops, height)).toBe(1);
    expect(restingStop(120, 0, stops, height)).toBe(0);
    // A flick up from medium throws it to large; a gentle one down from large lands in medium.
    expect(restingStop(174, -900, stops, height)).toBe(1);
    expect(restingStop(10, 400, stops, height)).toBe(0);
    // Past medium by 30 % of what shows there, it closes.
    expect(restingStop(174 + 180, 0, stops, height)).toBe(0);
    expect(restingStop(174 + 195, 0, stops, height)).toBe("dismiss");
  });

  it("reads velocity over the last 100 ms of movement", () => {
    expect(velocityOf([])).toBe(0);
    expect(velocityOf([{ t: 0, y: 0 }])).toBe(0);
    const samples = [
      { t: 0, y: 0 },
      { t: 400, y: 10 },
      { t: 450, y: 60 },
      { t: 500, y: 110 },
    ];
    expect(velocityOf(samples)).toBe(1000);
  });
});
