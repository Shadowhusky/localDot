import { describe, expect, it } from "vitest";
import { lineAbove, nextLine } from "./poke.ts";

describe("lineAbove", () => {
  it("puts dot's words above its head when they fit under the bar", () => {
    expect(lineAbove({ y: 500, r: 100, height: 40, top: 80 })).toBe(true);
  });

  it("puts them under dot when its head is near the top", () => {
    expect(lineAbove({ y: 200, r: 100, height: 40, top: 80 })).toBe(false);
  });

  it("leaves room for a hat", () => {
    expect(lineAbove({ y: 250, r: 100, height: 40, top: 80 })).toBe(false);
  });
});

describe("nextLine", () => {
  it("goes through the dot's own lines in turn", () => {
    const lines = ["one", "two"];
    expect([0, 1, 2].map((n) => nextLine(lines, n))).toEqual(["one", "two", "one"]);
  });
});
