import { describe, expect, it } from "vitest";
import { type CoordSpace, type Screen, toDevice, toModel, toScreen } from "./coordinates.ts";

const screen: Screen = { width: 1280, height: 800, scale: 1 };
const claude: CoordSpace = { kind: "pixels", width: 1280, height: 800 };
const downscaled: CoordSpace = { kind: "pixels", width: 1024, height: 640 };
const per1000: CoordSpace = { kind: "per1000" };

describe("toScreen", () => {
  it("maps same-size screenshot pixels 1:1", () => {
    expect(toScreen(640, 400, claude, screen)).toEqual({ x: 640, y: 400 });
  });

  it("scales pixels from a downscaled screenshot", () => {
    expect(toScreen(512, 320, downscaled, screen)).toEqual({ x: 640, y: 400 });
  });

  it("maps the 0-1000 grid used by Gemini and Qwen", () => {
    expect(toScreen(500, 500, per1000, screen)).toEqual({ x: 640, y: 400 });
  });

  it("clamps coordinates past the far edge onto the last pixel", () => {
    expect(toScreen(1000, 1000, per1000, screen)).toEqual({ x: 1279, y: 799 });
    expect(toScreen(5000, 900, claude, screen)).toEqual({ x: 1279, y: 799 });
  });

  it("clamps negative coordinates to zero", () => {
    expect(toScreen(-20, -1, claude, screen)).toEqual({ x: 0, y: 0 });
  });

  it("throws on non-finite coordinates instead of guessing", () => {
    expect(() => toScreen(Number.NaN, 10, claude, screen)).toThrow(RangeError);
    expect(() => toScreen(10, Number.POSITIVE_INFINITY, per1000, screen)).toThrow(RangeError);
  });
});

describe("toModel", () => {
  it("round-trips through the 0-1000 grid within one pixel", () => {
    const p = { x: 333, y: 777 };
    const model = toModel(p, per1000, screen);
    const back = toScreen(model.x, model.y, per1000, screen);
    expect(Math.abs(back.x - p.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.y - p.y)).toBeLessThanOrEqual(1);
  });

  it("converts to a downscaled screenshot's pixels", () => {
    expect(toModel({ x: 640, y: 400 }, downscaled, screen)).toEqual({ x: 512, y: 320 });
  });
});

describe("toDevice", () => {
  it("multiplies by the device scale for a 2x desktop", () => {
    expect(toDevice({ x: 640, y: 400 }, { ...screen, scale: 2 })).toEqual({ x: 1280, y: 800 });
  });
});
