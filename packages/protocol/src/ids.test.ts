import { describe, expect, it } from "vitest";
import { ULID_PATTERN, ulid, ulidTime } from "./ids.ts";

describe("ulid", () => {
  it("is 26 Crockford base32 characters", () => {
    expect(ulid()).toMatch(ULID_PATTERN);
  });

  it("sorts by time", () => {
    const zeros = (n: number) => new Uint8Array(n);
    expect(ulid(1_000, zeros) < ulid(2_000, zeros)).toBe(true);
  });

  it("is deterministic for a fixed clock and randomness", () => {
    const fixed = (n: number) => new Uint8Array(n).fill(7);
    expect(ulid(1_700_000_000_000, fixed)).toBe(ulid(1_700_000_000_000, fixed));
  });
});

describe("ulidTime", () => {
  it("reads the millisecond timestamp back out of a ULID", () => {
    const now = 1_759_312_800_000;
    expect(ulidTime(ulid(now))).toBe(now);
    expect(ulidTime("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(1_469_922_850_259);
  });

  it("rejects strings that are not ULIDs", () => {
    expect(() => ulidTime("nope")).toThrow(RangeError);
  });
});
