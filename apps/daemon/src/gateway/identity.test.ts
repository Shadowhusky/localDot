import type { Target } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { type NativeActionIdentity, sameNativeIdentity, sameTarget } from "./identity.ts";

const FRAME = { x: 0, y: 166, w: 1192, h: 792 };
const BOX = { x: 1272, y: 1376, w: 264, h: 68 };
const cancel: Target = {
  point: { x: 1404, y: 1410 },
  bbox: BOX,
  source: "ax",
  role: "push button",
  name: "Cancel",
  app: "Gimp",
  window: "Change Foreground Color",
};
const read = (over: Partial<NativeActionIdentity> = {}): NativeActionIdentity => ({
  target: cancel,
  window: 21,
  point: cancel.point,
  windowFrame: FRAME,
  ...over,
});
// What desktopd answers when the element lookup ran out of time: the window, nothing below it.
const late = (over: Partial<NativeActionIdentity> = {}): NativeActionIdentity =>
  read({
    target: { point: cancel.point, source: "coords", app: "Gimp", window: cancel.window },
    unknown: true,
    ...over,
  });
const shifted = (dx: number) =>
  read({
    target: { ...cancel, bbox: { ...BOX, x: BOX.x + dx, w: BOX.w - dx } },
  });

describe("sameNativeIdentity", () => {
  it("accepts the same element read twice, within a toolkit's rounding", () => {
    expect(sameNativeIdentity(read(), read())).toBe(true);
    expect(sameNativeIdentity(read(), shifted(1))).toBe(true);
    expect(sameNativeIdentity(read(), shifted(2))).toBe(true);
    expect(sameNativeIdentity(read(), shifted(3))).toBe(false);
    const nudged = read({ target: { ...cancel, point: { x: 1405, y: 1409 } } });
    expect(sameNativeIdentity(read(), nudged)).toBe(true);
  });

  it.each([
    ["name", { name: "OK" }],
    ["role", { role: "toggle button" }],
    ["secret flag", { secret: true }],
    ["source", { source: "dom" as const }],
    ["app", { app: "Mousepad" }],
    ["window title", { window: "Export Image" }],
    ["point", { point: { x: 1404, y: 1413 } }],
    ["url", { url: "https://example.com/delete" }],
    ["editable flag", { editable: true }],
    ["mark", { mark: 3 }],
  ])("refuses a changed %s", (_field, change) => {
    expect(sameNativeIdentity(read(), read({ target: { ...cancel, ...change } }))).toBe(false);
  });

  it("refuses a button swapped under the cursor in the same place", () => {
    const send = { ...cancel, name: "Send" };
    expect(sameNativeIdentity(read(), read({ target: send }))).toBe(false);
    expect(sameNativeIdentity(read({ target: send }), read())).toBe(false);
  });

  it("refuses another window, a moved or resized window, and an element that came or went", () => {
    expect(sameNativeIdentity(read(), read({ window: 11 }))).toBe(false);
    expect(sameNativeIdentity(read(), read({ windowFrame: { ...FRAME, x: 40 } }))).toBe(false);
    expect(sameNativeIdentity(read(), read({ windowFrame: { ...FRAME, h: 700 } }))).toBe(false);
    expect(sameNativeIdentity(read(), read({ target: null }))).toBe(false);
  });

  it("never confirms an approved element with a read that ran out of time", () => {
    expect(sameNativeIdentity(read(), late())).toBe(false);
    // Even one that repeats the element: it did not finish checking it.
    expect(sameNativeIdentity(read(), read({ unknown: true }))).toBe(false);
  });

  it("binds only the window when the approved read itself ran out of time", () => {
    expect(sameNativeIdentity(late(), late())).toBe(true);
    expect(sameNativeIdentity(late(), read())).toBe(true);
    expect(sameNativeIdentity(late(), late({ window: 11 }))).toBe(false);
    expect(sameNativeIdentity(late(), read({ window: 11 }))).toBe(false);
    expect(sameNativeIdentity(late(), late({ windowFrame: { ...FRAME, y: 200 } }))).toBe(false);
  });

  it("binds only the window when focus was on no element at approval", () => {
    // A window that has just opened takes focus a moment later: keys go to that window still.
    const before = read({ target: null, point: null });
    expect(sameNativeIdentity(before, read())).toBe(true);
    expect(sameNativeIdentity(before, read({ window: 11 }))).toBe(false);
    expect(sameNativeIdentity(before, read({ windowFrame: { ...FRAME, y: 200 } }))).toBe(false);
    // No window under the point binds that there is none.
    const nowhere = read({ target: null, window: null, windowFrame: undefined });
    expect(sameNativeIdentity(nowhere, read())).toBe(false);
  });

  it("binds no window when the approved lookup never answered, and refuses one that appears", () => {
    const silent = late({ target: null, window: null, windowFrame: undefined });
    expect(sameNativeIdentity(silent, silent)).toBe(true);
    expect(sameNativeIdentity(silent, read())).toBe(false);
    expect(sameNativeIdentity(silent, late())).toBe(false);
  });

  it("binds the focused element's point within rounding", () => {
    const moved = read({ point: { x: cancel.point.x + 3, y: cancel.point.y } });
    expect(sameNativeIdentity(read(), moved)).toBe(false);
    const jitter = read({ point: { x: cancel.point.x + 1, y: cancel.point.y } });
    expect(sameNativeIdentity(read(), jitter)).toBe(true);
  });
});

describe("sameTarget", () => {
  it("compares two empty answers equal and an empty one with an element unequal", () => {
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget(cancel, null)).toBe(false);
    expect(sameTarget(cancel, { ...cancel, bbox: undefined })).toBe(false);
  });
});
