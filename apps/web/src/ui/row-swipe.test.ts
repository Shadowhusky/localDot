import { describe, expect, it } from "vitest";
import { SWIPE_FACE, swipeRest } from "./row-swipe.ts";

describe("where a swiped row comes to rest", () => {
  it("opens past half its face and closes short of it when let go still", () => {
    expect(swipeRest(-SWIPE_FACE / 2 - 1, 0)).toBe("open");
    expect(swipeRest(-SWIPE_FACE / 2 + 1, 0)).toBe("closed");
  });

  it("projects a flick forward, so a short fast swipe opens and a flick back closes", () => {
    expect(swipeRest(-12, -600)).toBe("open");
    expect(swipeRest(-80, 600)).toBe("closed");
  });
});
