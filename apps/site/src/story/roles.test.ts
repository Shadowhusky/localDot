import { describe, expect, it } from "vitest";
import { pinned, roleAt } from "./roles.ts";

const order = ["coder", "research", "finance"] as const;
// Three dots between 0.2 and 0.8: each has 0.2 of the chapter.
const at = (c: number) => roleAt(c, order, 0.2, 0.8);

describe("roleAt", () => {
  it("shows the everyday dot before the first", () => {
    expect(at(0.1)).toBe("everyday");
    expect(at(0.19)).toBe("everyday");
  });

  it("shows each dot for its share of the chapter", () => {
    expect(at(0.2)).toBe("coder");
    expect(at(0.39)).toBe("coder");
    expect(at(0.41)).toBe("research");
  });

  it("keeps the last dot after the others", () => {
    expect(at(0.79)).toBe("finance");
    expect(at(0.95)).toBe("finance");
  });
});

describe("pinned", () => {
  it("adds the star pin to what dot wears, once", () => {
    expect(pinned(["hoodie"])).toEqual(["hoodie", "star-pin"]);
    expect(pinned(["star-pin"])).toEqual(["star-pin"]);
  });
});
