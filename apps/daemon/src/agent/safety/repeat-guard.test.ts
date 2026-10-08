import { describe, expect, it } from "vitest";
import type { GuiAction, NativeActionIdentity } from "../../gateway/gateway.ts";
import { RepeatGuard } from "./repeat-guard.ts";

const target = {
  point: { x: 20, y: 40 },
  bbox: { x: 10, y: 20, w: 40, h: 40 },
  source: "ax" as const,
  role: "button",
  name: "Next",
  app: "Chromium",
  window: "Draft",
  url: "https://example.test/",
  mark: 1,
  secret: false,
};
const identity: NativeActionIdentity = { window: 77, point: { x: 20, y: 40 }, target };
const key: GuiAction = { verb: "key", combo: ["Ctrl", "c"] };
let calls = 0;
// A fresh tool call each time, unless a test names the call.
const next = () => `call-${calls++}`;
describe("private actual native action repetition", () => {
  it("refuses the third identical key before its effect", () => {
    const guard = new RepeatGuard();
    let effects = 0;
    for (let i = 0; i < 5; i++) {
      if (guard.admit(key, identity, next())) effects++;
    }
    expect(effects).toBe(2);
  });
  it("refuses a third click despite invented labels, new frame IDs and motion speed", () => {
    const guard = new RepeatGuard();
    let effects = 0;
    for (let i = 0; i < 3; i++) {
      if (
        guard.admit(
          {
            verb: "click",
            label: `model label ${i}`,
            basedOn: `frame ${i}`,
            speed: i === 1 ? "fast" : "auto",
            point: { x: 10, y: 20 },
          },
          identity,
          next(),
        )
      )
        effects++;
    }
    expect(effects).toBe(2);
  });
  it("binds complete target/window identity with a positive changed-target control", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity, next())).toBe(true);
    expect(guard.admit(key, identity, next())).toBe(true);
    expect(guard.admit(key, { ...identity, window: 78 }, next())).toBe(true);
    expect(guard.admit(key, { ...identity, window: 78 }, next())).toBe(true);
    expect(guard.admit(key, { ...identity, window: 78 }, next())).toBe(false);
  });
  it("binds target metadata and full effect arguments", () => {
    const guard = new RepeatGuard();
    for (const changed of [
      { ...key, combo: ["Ctrl", "x"] },
      { verb: "type", text: "one" },
      { verb: "type", text: "two" },
      { verb: "click", button: "right", count: 1 },
    ] as GuiAction[]) {
      expect(guard.admit(changed, identity, next())).toBe(true);
      expect(guard.admit(changed, identity, next())).toBe(true);
    }
    expect(
      guard.admit(
        { verb: "click", button: "right", count: 1 },
        { ...identity, target: { ...target, mark: 2 } },
        next(),
      ),
    ).toBe(true);
  });
  it("does not let observation/wait activity reset the last actual input", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity, next())).toBe(true);
    expect(guard.admit({ verb: "wait", ms: 5 }, identity, next())).toBe(true);
    expect(guard.admit(key, identity, next())).toBe(true);
    expect(guard.admit({ verb: "wait", ms: 10 }, identity, next())).toBe(true);
    expect(guard.admit(key, identity, next())).toBe(false);
  });
  it("canonicalizes property ordering without changing authority", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity, next())).toBe(true);
    expect(
      guard.admit(
        { combo: ["Ctrl", "c"], verb: "key" },
        { target: identity.target, point: identity.point, window: 77 },
        next(),
      ),
    ).toBe(true);
    expect(guard.admit(key, identity, next())).toBe(false);
  });
  it("copies only a private digest, so later object mutation changes identity instead of rewriting the counter", () => {
    const guard = new RepeatGuard();
    const value: { -readonly [K in keyof NativeActionIdentity]: NativeActionIdentity[K] } =
      structuredClone(identity);
    expect(guard.admit(key, value, next())).toBe(true);
    expect(guard.admit(key, value, next())).toBe(true);
    value.window = 78;
    expect(guard.admit(key, value, next())).toBe(true);
    expect(guard.admit(key, identity, next())).toBe(true);
  });
  it("an explicit owner reset is the positive Resume boundary", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity, next())).toBe(true);
    expect(guard.admit(key, identity, next())).toBe(true);
    expect(guard.admit(key, identity, next())).toBe(false);
    guard.reset();
    expect(guard.admit(key, identity, next())).toBe(true);
  });
  it("counts the presses of one call's repeat once", () => {
    const guard = new RepeatGuard();
    for (let i = 0; i < 5; i++) expect(guard.admit(key, identity, "repeat")).toBe(true);
    expect(guard.admit(key, identity, next())).toBe(true);
    expect(guard.admit(key, identity, next())).toBe(false);
  });
  it("stops a repeat at its first press after two identical calls", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity, next())).toBe(true);
    expect(guard.admit(key, identity, next())).toBe(true);
    expect(guard.admit(key, identity, "repeat")).toBe(false);
  });
  it("a changed target inside one call starts a new streak", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity, "repeat")).toBe(true);
    expect(guard.admit(key, { ...identity, window: 78 }, "repeat")).toBe(true);
    expect(guard.admit(key, { ...identity, window: 78 }, next())).toBe(true);
    expect(guard.admit(key, { ...identity, window: 78 }, next())).toBe(false);
  });
});
