import { describe, expect, it } from "vitest";
import { swipeOutcome } from "./toast-swipe.ts";

const SIZE = { width: 360, height: 44 };

describe("toast swipe", () => {
  it("sends a toast away once dragged far enough sideways or up", () => {
    expect(swipeOutcome("x", 150, 0, SIZE)).toBe("away");
    expect(swipeOutcome("x", -150, 0, SIZE)).toBe("away");
    expect(swipeOutcome("up", -30, 0, SIZE)).toBe("away");
  });

  it("brings it back from a short, slow drag", () => {
    expect(swipeOutcome("x", 100, 0, SIZE)).toBe("back");
    expect(swipeOutcome("up", -15, 0, SIZE)).toBe("back");
  });

  it("carries a short flick on to where it was going", () => {
    expect(swipeOutcome("x", 40, 600, SIZE)).toBe("away");
    expect(swipeOutcome("up", -8, -400, SIZE)).toBe("away");
  });

  it("brings it back when the flick turns against the drag", () => {
    expect(swipeOutcome("x", 120, -900, SIZE)).toBe("back");
    expect(swipeOutcome("up", -20, 500, SIZE)).toBe("back");
  });
});
