import { describe, expect, it } from "vitest";
import { panelCorners, panelPose } from "./panel.ts";

const keys = [
  { at: 0.1, x: 0.5, y: 1.2, h: 0.8, yaw: 0.4, o: 0 },
  { at: 0.2, x: 0.5, y: 0.5, h: 0.8, yaw: 0.1, o: 1 },
  { at: 0.4, x: 0.9, y: 0.6, h: 0.5, yaw: 0, o: 1 },
];

describe("a picture's place", () => {
  it("holds at the ends and passes through its keys", () => {
    expect(panelPose(keys, 0).y).toBe(1.2);
    expect(panelPose(keys, 0.2)).toMatchObject({ x: 0.5, y: 0.5, o: 1 });
    expect(panelPose(keys, 1).x).toBe(0.9);
  });

  it("eases between keys", () => {
    const y = panelPose(keys, 0.15).y;
    expect(y).toBeGreaterThan(0.5);
    expect(y).toBeLessThan(1.2);
  });

  it("stands square when not turned, at its height and shape on the stage", () => {
    const [a, b, c, d] = panelCorners(
      { x: 0.5, y: 0.5, h: 0.5, yaw: 0, o: 1 },
      { w: 1000, h: 800 },
      0.5,
    );
    expect(a).toEqual([400, 200]);
    expect(b).toEqual([600, 200]);
    expect(c).toEqual([600, 600]);
    expect(d).toEqual([400, 600]);
  });

  it("draws its far edge shorter when turned", () => {
    const [a, b, c, d] = panelCorners(
      { x: 0.5, y: 0.5, h: 0.5, yaw: 0.3, o: 1 },
      { w: 1000, h: 800 },
      0.5,
    );
    expect(c[1] - b[1]).toBeLessThan(d[1] - a[1]);
  });
});
