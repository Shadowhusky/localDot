import { describe, expect, it } from "vitest";
import {
  arrowRect,
  awayFromRectEdge,
  countColour,
  crosshairMask,
  firstChange,
  locateTemplate,
  outsideRect,
  type Rgba,
  ringBandMask,
} from "./oracle-check.ts";

function image(
  w: number,
  h: number,
  paint: (x: number, y: number) => [number, number, number, number] | null,
): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = paint(x, y);
      if (!px) continue;
      data.set(px, (y * w + x) * 4);
    }
  return { data, w, h };
}
// A 9×12 right triangle whose tip is its top-left pixel, like the arrow.
const arrow = (ox: number, oy: number) => (x: number, y: number) =>
  x >= ox && y >= oy && x - ox <= (y - oy) * 0.75 && y - oy < 12
    ? ([255, 255, 255, 255] as [number, number, number, number])
    : null;

describe("locateTemplate", () => {
  it("finds the arrow's tip within a pixel, ignoring a translucent halo", () => {
    const template = image(
      16,
      16,
      (x, y) => arrow(3, 3)(x, y) ?? (Math.hypot(x - 8, y - 9) < 7 ? [0, 0, 0, 46] : null),
    );
    const crop = image(48, 48, (x, y) => arrow(20, 17)(x, y) ?? [40, 120, 200, 255]);
    const hit = locateTemplate(crop, template, { x: 3, y: 3 });
    expect(hit).not.toBeNull();
    expect(Math.abs((hit?.tip.x ?? 0) - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs((hit?.tip.y ?? 0) - 17)).toBeLessThanOrEqual(1);
  });

  it("reports nothing when the sprite is absent", () => {
    const template = image(16, 16, arrow(3, 3));
    const empty = image(48, 48, () => [0, 0, 0, 0]);
    expect(locateTemplate(empty, template, { x: 3, y: 3 })).toBeNull();
  });
});

describe("countColour and masks", () => {
  it("counts accent pixels inside a ring band, away from a rectangle's edges", () => {
    const crop = image(48, 48, (x, y) =>
      Math.abs(Math.hypot(x - 24, y - 24) - 14) < 1.2
        ? [63, 181, 222, 255]
        : x > 40
          ? [63, 181, 222, 255]
          : null,
    );
    expect(countColour(crop, [63, 181, 222], 6)).toBeGreaterThan(60);
    expect(countColour(crop, [63, 181, 222], 6, ringBandMask(24, 24, 8, 26))).toBeGreaterThan(40);
    const away = awayFromRectEdge({ x: 10, y: 10, w: 20, h: 20 }, 3);
    expect(away(20, 20)).toBe(true);
    expect(away(11, 20)).toBe(false);
    expect(away(31, 20)).toBe(false);
    expect(away(40, 40)).toBe(true);
    const masked = (x: number, y: number) =>
      ringBandMask(24, 24, 8, 26)(x, y) && awayFromRectEdge({ x: 0, y: 0, w: 48, h: 10 }, 2)(x, y);
    expect(countColour(crop, [63, 181, 222], 6, masked)).toBeLessThan(
      countColour(crop, [63, 181, 222], 6, ringBandMask(24, 24, 8, 26)),
    );
  });

  it("excludes the arrow's footprint and the crosshair's own pixels", () => {
    const out = outsideRect({ x: 10, y: 10, w: 20, h: 20 }, 2);
    expect(out(5, 5)).toBe(true);
    expect(out(9, 20)).toBe(false);
    expect(out(33, 20)).toBe(true);
    const arrow = arrowRect({ x: 40, y: 40 }, 2);
    expect(outsideRect(arrow, 0)(41, 60)).toBe(false);
    expect(outsideRect(arrow, 0)(30, 40)).toBe(true);
    expect(outsideRect(arrow, 0)(40, 100)).toBe(true);
    const cross = crosshairMask(48, 48, 1);
    expect(cross(48 + 18, 48)).toBe(true);
    expect(cross(48, 48 - 22)).toBe(true);
    // Diagonals miss the arms: r = 14.1 lies between the dot and the ring, r = 22.6 outside it.
    expect(cross(48 + 10, 48 + 10)).toBe(false);
    expect(cross(48 + 16, 48 + 16)).toBe(false);
    expect(cross(48 + 1, 48)).toBe(true);
  });
});

describe("firstChange", () => {
  it("returns the first frame that differs from the baseline frames beyond the threshold", () => {
    const flat = new Uint8Array(64 * 64).fill(10);
    const lit = new Uint8Array(64 * 64).fill(200);
    const frames = [flat, flat, flat, lit, lit].map((luma, i) => ({
      t: i * 16,
      presented: 100 + i,
      actionId: "a",
      luma,
    }));
    expect(firstChange(frames, 2)?.presented).toBe(103);
    expect(firstChange([frames[0] as (typeof frames)[number]], 1)).toBeUndefined();
    // A still screen: the window's one baseline crop, then the frame the press brought.
    expect(firstChange([frames[0], frames[3]] as typeof frames, 1)?.presented).toBe(103);
  });
});
