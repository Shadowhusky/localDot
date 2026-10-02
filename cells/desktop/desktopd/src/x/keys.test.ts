import { describe, expect, it } from "vitest";
import { keyName } from "./keys.ts";

describe("keyName", () => {
  it("maps the common aliases onto X keysym names", () => {
    expect(["ctrl", "control", "Control"].map(keyName)).toEqual([
      "Control_L",
      "Control_L",
      "Control_L",
    ]);
    expect(
      [
        "enter",
        "Return",
        "esc",
        "cmd",
        "super",
        "win",
        "alt",
        "shift",
        "pageup",
        "pagedown",
        "backspace",
        "tab",
        "space",
        "delete",
      ].map(keyName),
    ).toEqual([
      "Return",
      "Return",
      "Escape",
      "Super_L",
      "Super_L",
      "Super_L",
      "Alt_L",
      "Shift_L",
      "Prior",
      "Next",
      "BackSpace",
      "Tab",
      "space",
      "Delete",
    ]);
    expect(keyName("F5")).toBe("F5");
    expect(keyName("f12")).toBe("F12");
  });

  it("lower-cases letters and passes other single characters through", () => {
    expect(keyName("L")).toBe("l");
    expect(keyName("é")).toBe("é");
    expect(keyName("/")).toBe("/");
  });

  it("rejects names it does not know", () => {
    expect(() => keyName("hyperkey")).toThrow(/unknown key/);
  });
});
