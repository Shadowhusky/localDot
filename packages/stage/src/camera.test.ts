import { describe, expect, it } from "vitest";
import { cameraFor, toCanvas, toWorld } from "./camera.ts";

describe("cameraFor", () => {
  it("letterboxes the desktop into the stage at zoom 1", () => {
    const cam = cameraFor({ stageW: 1888, stageH: 1180, desktopW: 2560, desktopH: 1600, zoom: 1 });
    expect(cam.scale).toBeCloseTo(1888 / 2560, 9);
    expect(toCanvas(cam, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(toCanvas(cam, { x: 2560, y: 1600 }).x).toBeCloseTo(1888, 6);
    expect(toWorld(cam, toCanvas(cam, { x: 300, y: 400 }))).toEqual({ x: 300, y: 400 });
  });

  it("centres a 2x zoom on the focus and clamps at the desktop edges", () => {
    const centred = cameraFor({
      stageW: 1888,
      stageH: 1180,
      desktopW: 2560,
      desktopH: 1600,
      zoom: 2,
      focus: { x: 1280, y: 800 },
    });
    expect(toCanvas(centred, { x: 1280, y: 800 })).toEqual({ x: 944, y: 590 });
    const corner = cameraFor({
      stageW: 1888,
      stageH: 1180,
      desktopW: 2560,
      desktopH: 1600,
      zoom: 2,
      focus: { x: 0, y: 0 },
    });
    expect(toCanvas(corner, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});
