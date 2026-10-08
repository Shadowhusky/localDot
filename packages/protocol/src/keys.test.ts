import { describe, expect, it } from "vitest";
import { keyName, keysymOf } from "./keys.ts";

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

  it("knows every X keysym name in any letter case, with xdotool's names", () => {
    expect(
      [
        "Page_Up",
        "page_down",
        "KP_Enter",
        "kp_add",
        "KP_1",
        "F13",
        "f24",
        "Caps_Lock",
        "plus",
        "minus",
        "equal",
        "bracketleft",
        "BRACKETRIGHT",
        "asciitilde",
        "comma",
        "period",
        "Super_R",
        "Num_Lock",
        "XF86AudioRaiseVolume",
        "xf86audiomute",
        "ISO_Left_Tab",
        "dead_acute",
      ].map(keyName),
    ).toEqual([
      "Prior",
      "Next",
      "KP_Enter",
      "KP_Add",
      "KP_1",
      "F13",
      "F24",
      "Caps_Lock",
      "plus",
      "minus",
      "equal",
      "bracketleft",
      "bracketright",
      "asciitilde",
      "comma",
      "period",
      "Super_R",
      "Num_Lock",
      "XF86AudioRaiseVolume",
      "XF86AudioMute",
      "ISO_Left_Tab",
      "dead_acute",
    ]);
  });

  it("takes the unshifted name when two differ only in case", () => {
    expect(keyName("AACUTE")).toBe("aacute");
    expect(keyName("Aacute")).toBe("Aacute");
    expect(keyName("ArrowUp")).toBe("Up");
  });

  it("lower-cases letters and passes other single characters through", () => {
    expect(keyName("L")).toBe("l");
    expect(keyName("é")).toBe("é");
    expect(keyName("/")).toBe("/");
    expect(keyName("+")).toBe("+");
  });

  it("rejects names it does not know, naming the close ones", () => {
    expect(() => keyName("hyperkey")).toThrow(/unknown key "hyperkey"; did you mean .*hyper/i);
    expect(() => keyName("PageUpp")).toThrow(/did you mean .*(Prior|Page_Up|pageup)/);
    expect(() => keyName("Kp_Entr")).toThrow(/did you mean KP_Enter/);
    expect(() => keyName("qqqqqqqq")).toThrow(/^unknown key "qqqqqqqq"$/);
  });
});

describe("keysymOf", () => {
  it("gives the value xhelper presses for a name or a character", () => {
    expect(keysymOf("Prior")).toBe(0xff55);
    expect(keysymOf("KP_Enter")).toBe(0xff8d);
    expect(keysymOf("F24")).toBe(0xffd5);
    expect(keysymOf("XF86AudioMute")).toBe(0x1008ff12);
    expect(keysymOf("+")).toBe(0x2b);
    expect(keysymOf("é")).toBe(0xe9);
    expect(keysymOf("€")).toBe(0x10020ac);
    expect(keysymOf("\n")).toBe(0xff0d);
  });
});
