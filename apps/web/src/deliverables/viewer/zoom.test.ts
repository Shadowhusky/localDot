import { describe, expect, it } from "vitest";
import {
  centred,
  dragged,
  fitScale,
  project,
  settle,
  swipeTurn,
  zoomAt,
  zoomedIn,
} from "./zoom.ts";

const stage = { w: 1000, h: 600 };

describe("picture zoom", () => {
  it("shows a picture whole without enlarging a small one", () => {
    expect(fitScale({ w: 1600, h: 1000 }, stage)).toBeCloseTo(552 / 1000);
    expect(fitScale({ w: 100, h: 50 }, stage)).toBe(1);
    expect(centred({ w: 100, h: 50 }, stage, 1)).toEqual({ scale: 1, x: 450, y: 275 });
  });

  it("keeps the point under the pointer still while zooming", () => {
    const view = { scale: 1, x: 100, y: 50 };
    const zoomed = zoomAt(view, 2, 300, 250);
    // The picture point under (300, 250) was (200, 200) and stays there.
    expect((300 - zoomed.x) / zoomed.scale).toBe(200);
    expect((250 - zoomed.y) / zoomed.scale).toBe(200);
  });

  it("centres an axis the picture does not fill and keeps a filled one edge to edge", () => {
    const picture = { w: 2000, h: 200 };
    expect(settle({ scale: 1, x: 300, y: 0 }, picture, stage)).toEqual({ scale: 1, x: 0, y: 200 });
    expect(settle({ scale: 1, x: -5000, y: 0 }, picture, stage).x).toBe(-1000);
    expect(zoomedIn({ scale: 1, x: 0, y: 0 }, picture, stage)).toBe(true);
    expect(zoomedIn({ scale: 0.4, x: 0, y: 0 }, picture, stage)).toBe(false);
  });

  it("resists a drag past the edge more the further it goes", () => {
    const picture = { w: 2000, h: 600 };
    const near = dragged({ scale: 1, x: 50, y: 0 }, picture, stage).x;
    const far = dragged({ scale: 1, x: 500, y: 0 }, picture, stage).x;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(50);
    expect(far).toBeLessThan(500);
    expect(far / 500).toBeLessThan(near / 50);
  });
});

describe("swiping between files", () => {
  it("turns on a long drag or a short flick, and stays on a short slow one", () => {
    expect(swipeTurn(-200, 0, 390)).toBe(1);
    expect(swipeTurn(160, 0, 390)).toBe(-1);
    expect(swipeTurn(-40, 0, 390)).toBe(0);
    expect(swipeTurn(-40, -800, 390)).toBe(1);
    // A flick back cancels a long drag.
    expect(swipeTurn(-200, 900, 390)).toBe(0);
    expect(project(1000)).toBeCloseTo(499, 0);
  });
});
