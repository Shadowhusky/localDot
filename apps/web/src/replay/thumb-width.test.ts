import { describe, expect, it } from "vitest";
import { thumbWidth } from "./ReplayImage.tsx";

describe("step thumbnail widths", () => {
  it("asks for as many pixels as the place has on this display", () => {
    expect(thumbWidth(104, 1)).toBe(320);
    expect(thumbWidth(104, 2)).toBe(320);
    expect(thumbWidth(360, 2)).toBe(1280);
    expect(thumbWidth(300, 2)).toBe(640);
    expect(thumbWidth(900, 3)).toBe(1280);
    expect(thumbWidth(0, 2)).toBe(320);
  });
});
