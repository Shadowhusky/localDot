import { describe, expect, it } from "vitest";
import { clipText, keyDisplayName } from "./text.ts";

describe("clipText", () => {
  it("strips control characters, collapses whitespace and cuts with an ellipsis", () => {
    expect(clipText("  Save\tAs\n\u0007now  ", 80)).toBe("Save As now");
    expect(clipText("a".repeat(100), 10)).toBe("aaaaaaaaa…");
    expect(clipText("short", 10)).toBe("short");
    expect(clipText("", 10)).toBe("");
  });

  it("counts code points, not UTF-16 units", () => {
    expect(clipText("😀".repeat(5), 3)).toBe("😀😀…");
  });
});

describe("keyDisplayName", () => {
  it("names keys the way labels and keycaps show them", () => {
    expect(
      ["ctrl", "Control_L", "shift", "s", "Return", "space", "backspace", "F5"].map(keyDisplayName),
    ).toEqual(["Ctrl", "Ctrl", "Shift", "S", "Return", "Space", "Backspace", "F5"]);
  });
});
