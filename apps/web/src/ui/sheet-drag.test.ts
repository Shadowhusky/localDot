import { describe, expect, it } from "vitest";
import { DISMISS_AT, project, releaseTo, rubberband, velocityOf } from "./sheet-drag.ts";

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
    expect(releaseTo(100, 0, height)).toBe("rest");
    expect(releaseTo(181, 0, height)).toBe("dismiss");
    // A flick from near the top still closes; a slow push back up does not.
    expect(releaseTo(40, 900, height)).toBe("dismiss");
    expect(releaseTo(300, -800, height)).toBe("rest");
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
