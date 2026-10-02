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

describe("degenerate spaces and screens", () => {
  it("rejects a zero-size model space instead of guessing a corner", () => {
    const zero: CoordSpace = { kind: "pixels", width: 0, height: 0 };
    expect(() => toScreen(0, 0, zero, screen)).toThrow(RangeError);
    expect(() => toScreen(5, 5, zero, screen)).toThrow(RangeError);
  });

  it("rejects a model space with a missing size", () => {
    const missing = { kind: "pixels" } as unknown as CoordSpace;
    expect(() => toScreen(10, 10, missing, screen)).toThrow(RangeError);
  });

  it("rejects a model space with a NaN size", () => {
    const nan: CoordSpace = { kind: "pixels", width: Number.NaN, height: 640 };
    expect(() => toScreen(10, 10, nan, screen)).toThrow(RangeError);
  });

  it("rejects a zero-size screen", () => {
    const zero: Screen = { width: 0, height: 0, scale: 1 };
    expect(() => toScreen(500, 500, per1000, zero)).toThrow(RangeError);
    expect(() => toModel({ x: 0, y: 0 }, per1000, zero)).toThrow(RangeError);
    expect(() => toDevice({ x: 0, y: 0 }, zero)).toThrow(RangeError);
  });

  it("rejects a screen with a NaN size", () => {
    const nan: Screen = { ...screen, width: Number.NaN };
    expect(() => toScreen(500, 500, per1000, nan)).toThrow(RangeError);
    expect(() => toModel({ x: 10, y: 10 }, per1000, nan)).toThrow(RangeError);
  });

  it("rejects a non-integer screen size", () => {
    const fractional: Screen = { ...screen, width: 1280.5 };
    expect(() => toScreen(500, 500, per1000, fractional)).toThrow(RangeError);
  });

  it("rejects a NaN device scale", () => {
    const nan: Screen = { ...screen, scale: Number.NaN };
    expect(() => toDevice({ x: 640, y: 400 }, nan)).toThrow(RangeError);
    expect(() => toModel({ x: 640, y: 400 }, per1000, nan)).toThrow(RangeError);
  });

  it("rejects a zero device scale", () => {
    expect(() => toDevice({ x: 640, y: 400 }, { ...screen, scale: 0 })).toThrow(RangeError);
  });
});
