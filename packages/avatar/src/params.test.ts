import { describe, expect, it } from "vitest";
import { NEUTRAL_PARAMS, sanitizeParams } from "./params.ts";

describe("sanitizeParams", () => {
  it("clamps every field into its range", () => {
    const p = sanitizeParams({
      ...NEUTRAL_PARAMS,
      headX: 3,
      eyeOpenL: -1,
      brow: -9,
      mouthOpen: 2,
      expressions: { smile: 1.5 },
    });
    expect(p.headX).toBe(1);
    expect(p.eyeOpenL).toBe(0);
    expect(p.brow).toBe(-1);
    expect(p.mouthOpen).toBe(1);
    expect(p.expressions.smile).toBe(1);
  });

  it("replaces non-finite values with neutral ones", () => {
    const p = sanitizeParams({
      ...NEUTRAL_PARAMS,
      headX: Number.NaN,
      eyeOpenR: Number.POSITIVE_INFINITY,
    });
    expect(p.headX).toBe(0);
    expect(p.eyeOpenR).toBe(1);
  });

  it("keeps the head roll within ±1 and reads a missing or invalid roll as level", () => {
    expect(NEUTRAL_PARAMS.headRoll).toBe(0);
    expect(sanitizeParams({ ...NEUTRAL_PARAMS, headRoll: 3 }).headRoll).toBe(1);
    expect(sanitizeParams({ ...NEUTRAL_PARAMS, headRoll: -0.4 }).headRoll).toBe(-0.4);
    expect(sanitizeParams({ ...NEUTRAL_PARAMS, headRoll: Number.NaN }).headRoll).toBe(0);
    expect(sanitizeParams({ ...NEUTRAL_PARAMS, headRoll: undefined }).headRoll).toBe(0);
  });

  it("keeps the wind within ±1 and reads a missing or invalid wind as still air", () => {
    expect(NEUTRAL_PARAMS.wind).toBe(0);
    expect(sanitizeParams({ ...NEUTRAL_PARAMS, wind: -2 }).wind).toBe(-1);
    expect(sanitizeParams({ ...NEUTRAL_PARAMS, wind: Number.NaN }).wind).toBe(0);
    expect(sanitizeParams({ ...NEUTRAL_PARAMS, wind: undefined }).wind).toBe(0);
  });

  it("drops expressions whose weight is zero or invalid", () => {
    const p = sanitizeParams({
      ...NEUTRAL_PARAMS,
      expressions: { smile: 0, smug: Number.NaN, blush: 0.4 },
    });
    expect(p.expressions).toEqual({ blush: 0.4 });
  });
});
