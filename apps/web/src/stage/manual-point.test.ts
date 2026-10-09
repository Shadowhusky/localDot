import { cameraFor, toCanvas } from "@localdot/stage";
import { expect, it } from "vitest";
import { videoPlacement } from "./geometry.ts";
import { manualPoint } from "./manual-point.ts";

it("uses actual letterboxed backing-store coordinates across DPR changes and touch-sized layouts", () => {
  const screen = { w: 2560, h: 1600 },
    rect = { left: 11, top: 20, width: 390, height: 400 };
  for (const dpr of [1, 2]) {
    const backing = { w: 390 * dpr, h: 400 * dpr };
    expect(manualPoint(rect, screen, { x: 206, y: 220 }, backing)).toEqual({ x: 1280, y: 800 });
    expect(manualPoint(rect, screen, { x: 11, y: 20 }, backing)).toBeNull();
    expect(manualPoint(rect, screen, { x: 401, y: 220 }, backing)).toBeNull();
    expect(manualPoint(rect, screen, { x: 11, y: 98.125 }, backing)).toEqual({ x: 0, y: 0 });
  }
  expect(manualPoint(rect, screen, { x: Number.NaN, y: 20 }, { w: 390, h: 400 })).toBeNull();
  expect(
    manualPoint({ ...rect, width: 0 }, screen, { x: 11, y: 20 }, { w: 390, h: 400 }),
  ).toBeNull();
});
it("follows a pressed pointer to the desktop's edge instead of dropping it", () => {
  const screen = { w: 2560, h: 1600 },
    rect = { left: 0, top: 0, width: 640, height: 400 },
    backing = { w: 640, h: 400 };
  expect(manualPoint(rect, screen, { x: -50, y: 200 }, backing)).toBeNull();
  expect(manualPoint(rect, screen, { x: -50, y: 200 }, backing, true)).toEqual({ x: 0, y: 800 });
  expect(manualPoint(rect, screen, { x: 900, y: 900 }, backing, true)).toEqual({
    x: 2559,
    y: 1599,
  });
});
it("maps a touch on a phone stage to the desktop pixel the worker draws under it, at any frame size", () => {
  const screen = { w: 2560, h: 1600 };
  const rect = { left: 8, top: 24, width: 374, height: 233.75 };
  const backing = { w: Math.round(rect.width * 3), h: Math.round(rect.height * 3) };
  const camera = cameraFor({
    stageW: backing.w,
    stageH: backing.h,
    desktopW: screen.w,
    desktopH: screen.h,
    zoom: 1,
  });
  for (const frame of [screen, { w: 1280, h: 800 }]) {
    const { sx, sy } = videoPlacement(frame, screen);
    for (const [fx, fy] of [
      [0, 0],
      [frame.w / 2, frame.h / 2],
      [frame.w - 1, frame.h - 1],
    ] as const) {
      const world = { x: (fx + 0.25) * sx, y: (fy + 0.25) * sy };
      const drawn = toCanvas(camera, world);
      const touch = {
        x: rect.left + (drawn.x * rect.width) / backing.w,
        y: rect.top + (drawn.y * rect.height) / backing.h,
      };
      expect(manualPoint(rect, screen, touch, backing)).toEqual({
        x: Math.floor(world.x),
        y: Math.floor(world.y),
      });
    }
  }
});
