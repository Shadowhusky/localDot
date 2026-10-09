import { cameraFor, toCanvas } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { cursorPolygon, cursorSizePx, targetRadius, videoPlacement } from "./geometry.ts";

describe("stage geometry", () => {
  it("builds the macOS arrow with its tip at the origin, 18.1 px tall in its 22 px box", () => {
    const pts = cursorPolygon();
    expect(pts.slice(0, 2)).toEqual([0, 0]);
    const ys = pts.filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys)).toBeCloseTo(18.1, 6);
    expect(Math.min(...pts)).toBe(0);
  });

  it("sizes the cursor by the stage: 22 px from 800, 18 from 600, 16 below", () => {
    expect(cursorSizePx(1024)).toBe(22);
    expect(cursorSizePx(800)).toBe(22);
    expect(cursorSizePx(799)).toBe(18);
    expect(cursorSizePx(600)).toBe(18);
    expect(cursorSizePx(374)).toBe(16);
  });

  it("rounds a focus ring's padded box by 9 px, or half its height when smaller", () => {
    expect(targetRadius(40)).toBe(9);
    expect(targetRadius(10)).toBe(8);
  });

  it("places a frame of another size into the session screen and flags it", () => {
    expect(videoPlacement({ w: 2560, h: 1600 }, { w: 2560, h: 1600 })).toEqual({
      sx: 1,
      sy: 1,
      mismatch: false,
    });
    expect(videoPlacement({ w: 1280, h: 800 }, { w: 2560, h: 1600 })).toEqual({
      sx: 2,
      sy: 2,
      mismatch: true,
    });
  });

  it("builds the camera from the session screen, not the frame", () => {
    // A 1280×800 frame in a 2560×1600 session on a 1280×800 stage: the camera halves the desktop,
    // the frame is doubled into it, the picture fills the stage unstretched and a desktop point
    // lands where the session's geometry says, whatever the frame's size.
    const screen = { w: 2560, h: 1600 };
    const cam = cameraFor({
      stageW: 1280,
      stageH: 800,
      desktopW: screen.w,
      desktopH: screen.h,
      zoom: 1,
    });
    const p = videoPlacement({ w: 1280, h: 800 }, screen);
    expect(cam.scale).toBe(0.5);
    expect(1280 * p.sx * cam.scale).toBe(1280);
    expect(800 * p.sy * cam.scale).toBe(800);
    expect(toCanvas(cam, { x: 2560, y: 1600 })).toEqual({ x: 1280, y: 800 });
    // The frame's pixel (150, 200) shows desktop (300, 400): drawn ×2 into the session it lands
    // under that point's overlay. A camera built from the frame would put the overlay at (300, 400).
    expect(toCanvas(cam, { x: 150 * p.sx, y: 200 * p.sy })).toEqual({ x: 150, y: 200 });
    expect(toCanvas(cam, { x: 300, y: 400 })).toEqual({ x: 150, y: 200 });
    expect(
      toCanvas(cameraFor({ stageW: 1280, stageH: 800, desktopW: 1280, desktopH: 800, zoom: 1 }), {
        x: 300,
        y: 400,
      }),
    ).toEqual({ x: 300, y: 400 });
  });
});
