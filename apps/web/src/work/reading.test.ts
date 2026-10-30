import { describe, expect, it } from "vitest";
import { dragged, movesByKey, movesByWheel } from "./reading.ts";

const output = (scrollTop: number, scrollHeight = 900, scrollLeft = 0, scrollWidth = 400) => ({
  scrollTop,
  scrollLeft,
  scrollHeight,
  scrollWidth,
  clientHeight: 300,
  clientWidth: 400,
});
const wheel = (deltaY: number, deltaX = 0, ctrlKey = false) => ({ deltaX, deltaY, ctrlKey });

describe("movesByWheel", () => {
  it("moves the output only toward more of it", () => {
    expect(movesByWheel(output(0), wheel(40))).toBe(true);
    expect(movesByWheel(output(0), wheel(-40))).toBe(false);
    expect(movesByWheel(output(600), wheel(40))).toBe(false);
    expect(movesByWheel(output(600), wheel(-40))).toBe(true);
    expect(movesByWheel(output(300), wheel(0))).toBe(false);
  });

  it("does not move output that fits, whichever way it turns", () => {
    expect(movesByWheel(output(0, 300), wheel(120))).toBe(false);
    expect(movesByWheel(output(0, 300), wheel(0, 80))).toBe(false);
  });

  it("moves sideways through a wide line", () => {
    expect(movesByWheel(output(0, 300, 0, 900), wheel(0, 60))).toBe(true);
  });

  it("counts a trackpad pinch", () => {
    expect(movesByWheel(output(0, 300), wheel(3, 0, true))).toBe(true);
  });
});

describe("movesByKey", () => {
  it("counts the keys that scroll, not focus moves, modifiers or typing", () => {
    for (const key of ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "])
      expect(movesByKey(key)).toBe(true);
    for (const key of ["Tab", "Shift", "Meta", "Escape", "Enter", "a"])
      expect(movesByKey(key)).toBe(false);
  });
});

describe("dragged", () => {
  it("leaves a click's or a tap's jitter alone", () => {
    expect(dragged({ x: 100, y: 100 }, { x: 104, y: 106 })).toBe(false);
    expect(dragged({ x: 100, y: 100 }, { x: 100, y: 112 })).toBe(true);
  });
});
