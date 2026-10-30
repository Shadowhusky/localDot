import { describe, expect, it } from "vitest";
import { crown } from "./wearables.ts";

describe("what dot wears on its head", () => {
  it("rises above the ball by the tallest hat it wears, and nothing else counts", () => {
    expect(crown([])).toBe(0);
    expect(crown(["hoodie", "sunglasses", "bow"])).toBe(0);
    expect(crown(["hoodie", "cap"])).toBe(5.5);
    expect(crown(["headphones", "mortarboard"])).toBe(3);
  });
});
