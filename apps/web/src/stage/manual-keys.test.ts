import { describe, expect, it } from "vitest";
import { type KeyLike, routeKey, textEdit, textInputs } from "./manual-keys.ts";

const press = (key: string, over: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...over,
});

describe("keys on the computer view", () => {
  it("lets printable text, Shift and Option characters and composition reach the keyboard field", () => {
    for (const key of ["a", "Z", "@", " ", "中", "!", "1"])
      expect(routeKey(press(key), false)).toEqual({ kind: "text" });
    expect(routeKey(press("P", { shiftKey: true }), false)).toEqual({ kind: "text" });
    // A Mac's Option makes characters; AltGr (Ctrl+Alt on Windows) makes them too.
    expect(routeKey(press("™", { altKey: true }), true)).toEqual({ kind: "text" });
    expect(routeKey(press("@", { ctrlKey: true, altKey: true }), false)).toEqual({ kind: "text" });
    for (const composing of [
      press("Process"),
      press("Dead", { altKey: true }),
      press("Unidentified"),
      press("a", { isComposing: true }),
      press("Enter", { keyCode: 229 }),
    ])
      expect(routeKey(composing, true)).toEqual({ kind: "text" });
  });

  it("sends Tab, Enter, editing and function keys to the computer instead of the page", () => {
    expect(routeKey(press("Tab"), false)).toEqual({ kind: "key", combo: ["tab"] });
    expect(routeKey(press("Tab", { shiftKey: true }), false)).toEqual({
      kind: "key",
      combo: ["shift", "tab"],
    });
    expect(routeKey(press("Enter"), false)).toEqual({ kind: "key", combo: ["enter"] });
    expect(routeKey(press("Backspace"), false)).toEqual({ kind: "key", combo: ["backspace"] });
    expect(routeKey(press("Escape"), false)).toEqual({ kind: "key", combo: ["esc"] });
    expect(routeKey(press("ArrowLeft", { shiftKey: true }), false)).toEqual({
      kind: "key",
      combo: ["shift", "left"],
    });
    expect(routeKey(press("F11"), false)).toEqual({ kind: "key", combo: ["F11"] });
    expect(routeKey(press("F24"), false)).toEqual({ kind: "key", combo: ["F24"] });
  });

  it("turns Control, Command and Alt with a key into shortcuts, Command as Control on a Mac", () => {
    expect(routeKey(press("a", { ctrlKey: true }), false)).toEqual({
      kind: "key",
      combo: ["ctrl", "a"],
    });
    expect(routeKey(press("a", { metaKey: true }), true)).toEqual({
      kind: "key",
      combo: ["ctrl", "a"],
    });
    expect(routeKey(press("a", { metaKey: true }), false)).toEqual({
      kind: "key",
      combo: ["super", "a"],
    });
    expect(routeKey(press("T", { ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: "key",
      combo: ["ctrl", "shift", "t"],
    });
    expect(routeKey(press("=", { ctrlKey: true }), false)).toEqual({
      kind: "key",
      combo: ["ctrl", "equal"],
    });
    expect(routeKey(press("f", { altKey: true }), false)).toEqual({
      kind: "key",
      combo: ["alt", "f"],
    });
    expect(routeKey(press(" ", { ctrlKey: true }), false)).toEqual({
      kind: "key",
      combo: ["ctrl", "space"],
    });
  });

  it("pastes the local clipboard for Command-V, Control-V and Shift-Insert", () => {
    expect(routeKey(press("v", { metaKey: true }), true)).toEqual({ kind: "paste" });
    expect(routeKey(press("v", { ctrlKey: true }), false)).toEqual({ kind: "paste" });
    expect(routeKey(press("V", { ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: "paste",
    });
    expect(routeKey(press("Insert", { shiftKey: true }), false)).toEqual({ kind: "paste" });
  });

  it("keeps a modifier or lock pressed on its own in the browser", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", "AudioVolumeUp"])
      expect(routeKey(press(key), true)).toEqual({ kind: "local" });
  });

  it("reads keyboard corrections and backspaces as erase-then-type edits", () => {
    expect(textEdit("", "u")).toEqual({ erase: 0, text: "u" });
    expect(textEdit("hel", "hello ")).toEqual({ erase: 0, text: "lo " });
    expect(textEdit("teh", "the ")).toEqual({ erase: 2, text: "he " });
    expect(textEdit("pass", "pas")).toEqual({ erase: 1, text: "" });
    expect(textEdit("ni", "你")).toEqual({ erase: 2, text: "你" });
    expect(textEdit("🙂a", "🙂")).toEqual({ erase: 1, text: "" });
  });

  it("splits long text by characters into typing calls the daemon accepts", () => {
    const text = `${"🙂".repeat(4000)}中文`;
    expect(textInputs(text)).toEqual([
      { kind: "text", text: "🙂".repeat(4000) },
      { kind: "text", text: "中文" },
    ]);
    expect(textInputs("")).toEqual([]);
    expect(textInputs("one\r\ntwo\rthree")).toEqual([{ kind: "text", text: "one\ntwo\nthree" }]);
  });
});
