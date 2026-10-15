import { describe, expect, it } from "vitest";
import { ease, follow, span, track } from "./tracks.ts";

describe("span", () => {
  it("is 0 before its range, 1 after it, and linear inside", () => {
    expect(span(0.1, 0.2, 0.6)).toBe(0);
    expect(span(0.4, 0.2, 0.6)).toBeCloseTo(0.5);
    expect(span(0.9, 0.2, 0.6)).toBe(1);
  });
});

describe("track", () => {
  const linear = track(
    [
      [0, 10],
      [1, 20],
      [3, 0],
    ],
    ease.linear,
  );

  it("holds its first and last values outside its keys", () => {
    expect(linear(-1)).toBe(10);
    expect(linear(5)).toBe(0);
  });

  it("interpolates within the segment the progress falls in", () => {
    expect(linear(0.5)).toBeCloseTo(15);
    expect(linear(2)).toBeCloseTo(10);
  });

  it("eases in and out by default, symmetric about the middle", () => {
    const eased = track([
      [0, 0],
      [1, 1],
    ]);
    expect(eased(0.5)).toBeCloseTo(0.5);
    expect(eased(0.25)).toBeLessThan(0.25);
    expect(eased(0.75)).toBeGreaterThan(0.75);
  });
});

describe("follow", () => {
  it("does not move in no time and converges over time", () => {
    expect(follow(0, 1, 0, 100)).toBe(0);
    expect(follow(0, 1, 100, 100)).toBeCloseTo(0.5);
    expect(follow(0, 1, 2000, 100)).toBeCloseTo(1, 5);
  });

  it("is the same in two short steps as in one long one", () => {
    const twice = follow(follow(0, 1, 8, 90), 1, 8, 90);
    expect(twice).toBeCloseTo(follow(0, 1, 16, 90), 9);
  });
});
