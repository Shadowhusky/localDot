import { describe, expect, it } from "vitest";
import { type Frame, fitFrame, frameRect } from "./layout.ts";

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

const closeRect = (x: number, y: number, w: number, h: number) => ({
  x: expect.closeTo(x, 6),
  y: expect.closeTo(y, 6),
  w: expect.closeTo(w, 6),
  h: expect.closeTo(h, 6),
});

const fitted = (frame: Frame, width: number, height: number) => {
  const placement = fitFrame(frame, root, width, height);
  if (!placement) throw new Error(`no placement for ${width}x${height}`);
  return frameRect(frame, root, placement);
};

describe("frameRect", () => {
  it("puts a frame centred on the root around the placement point", () => {
    const rect = frameRect({ x: 100, y: 500, w: 200, h: 200 }, root, { x: 50, y: 80, scale: 2 });
    expect(rect).toEqual(closeRect(-150, -120, 400, 400));
  });

  it("offsets a frame by its distance from the root, scaled", () => {
    const rect = frameRect({ x: 70, y: 90, w: 260, h: 300 }, root, { x: 120, y: 400, scale: 0.5 });
    expect(rect).toEqual(closeRect(55, 145, 130, 150));
  });

  it("fills the height of a view wider than the frame and centres it across", () => {
    expect(fitted({ x: 0, y: 60, w: 400, h: 540 }, 800, 270)).toEqual(closeRect(300, 0, 200, 270));
  });

  it("fills the width of a view taller than the frame and centres it down", () => {
    expect(fitted({ x: 0, y: 60, w: 400, h: 540 }, 200, 600)).toEqual(closeRect(0, 165, 200, 270));
  });

  it("matches fitFrame: centred in the view, filling it on the constraining axis", () => {
    const cases: { frame: Frame; view: [number, number]; fills: "width" | "height" | "both" }[] = [
      { frame: { x: 0, y: 60, w: 400, h: 540 }, view: [240, 298], fills: "height" },
      { frame: { x: 70, y: 90, w: 260, h: 300 }, view: [240, 360], fills: "width" },
      { frame: { x: 300, y: 10, w: 120, h: 90 }, view: [500, 200], fills: "height" },
      { frame: { x: -50, y: 0, w: 100, h: 100 }, view: [64, 64], fills: "both" },
    ];
    for (const { frame, view, fills } of cases) {
      const [width, height] = view;
      const rect = fitted(frame, width, height);
      expect(rect.x + rect.w / 2).toBeCloseTo(width / 2, 6);
      expect(rect.y + rect.h / 2).toBeCloseTo(height / 2, 6);
      expect(rect.w).toBeLessThanOrEqual(width + 1e-9);
      expect(rect.h).toBeLessThanOrEqual(height + 1e-9);
      if (fills !== "height") expect(rect.w).toBeCloseTo(width, 6);
      if (fills !== "width") expect(rect.h).toBeCloseTo(height, 6);
    }
  });
});
