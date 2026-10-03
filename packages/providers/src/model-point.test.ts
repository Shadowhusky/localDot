import { describe, expect, it } from "vitest";
import { modelPoint, toModelSpace } from "./model-point.ts";

describe("modelPoint", () => {
  it("maps the 0–1000 grid onto 1280×800 (S5: Gemini's [773, 802] is (989, 642))", () => {
    expect(modelPoint([773, 802], "per1000")).toEqual({ ok: true, point: { x: 989, y: 642 } });
    expect(modelPoint([1000, 1000], "per1000")).toEqual({ ok: true, point: { x: 1279, y: 799 } });
    expect(modelPoint([0, 0], "per1000")).toEqual({ ok: true, point: { x: 0, y: 0 } });
  });

  it("keeps screenshot pixels as they are", () => {
    expect(modelPoint([640.4, 399.6], "pixels")).toEqual({ ok: true, point: { x: 640, y: 400 } });
  });

  it("refuses coordinates outside the declared space instead of clamping them", () => {
    for (const [c, space] of [
      [[1001, 10], "per1000"],
      [[-1, 10], "per1000"],
      [[1280, 10], "pixels"],
      [[10, 800], "pixels"],
      [[Number.NaN, 1], "pixels"],
      [[1, 2, 3], "pixels"],
    ] as const) {
      expect(modelPoint(c, space).ok, JSON.stringify(c)).toBe(false);
    }
    expect(modelPoint(undefined, "pixels")).toEqual({
      ok: false,
      error: "coordinate must be [x, y]",
    });
  });

  it("converts a cursor position back into the model's space", () => {
    expect(toModelSpace({ x: 640, y: 400 }, "per1000")).toEqual([500, 500]);
    expect(toModelSpace({ x: 640, y: 400 }, "pixels")).toEqual([640, 400]);
  });
});

it("keeps fractional points inside the final screenshot pixel", () => {
  expect(modelPoint([1279.9, 799.9], "pixels")).toEqual({
    ok: true,
    point: { x: 1279, y: 799 },
  });
  expect(modelPoint([1280, 799.9], "pixels").ok).toBe(false);
});
