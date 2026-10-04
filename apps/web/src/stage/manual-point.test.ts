import { expect, it } from "vitest";
import { manualKey, manualPoint } from "./manual-point.ts";

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
it("maps navigation only and lets plain text, composition and Tab stay with native DOM controls", () => {
  const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  expect(manualKey("ArrowLeft", mods)).toEqual(["left"]);
  expect(manualKey("a", { ...mods, ctrlKey: true })).toEqual(["ctrl", "a"]);
  for (const key of ["a", "中", "Process", "Tab", "Shift"]) expect(manualKey(key, mods)).toBeNull();
});
