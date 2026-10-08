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
describe("private actual native action repetition", () => {
  it("refuses the third identical key before its effect", () => {
    const guard = new RepeatGuard();
    let effects = 0;
    for (let i = 0; i < 5; i++) {
      if (guard.admit(key, identity)) effects++;
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
        )
      )
        effects++;
    }
    expect(effects).toBe(2);
  });
  it("binds complete target/window identity with a positive changed-target control", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity)).toBe(true);
    expect(guard.admit(key, identity)).toBe(true);
    expect(guard.admit(key, { ...identity, window: 78 })).toBe(true);
    expect(guard.admit(key, { ...identity, window: 78 })).toBe(true);
    expect(guard.admit(key, { ...identity, window: 78 })).toBe(false);
  });
  it("binds target metadata and full effect arguments", () => {
    const guard = new RepeatGuard();
    for (const changed of [
      { ...key, combo: ["Ctrl", "x"] },
      { verb: "type", text: "one" },
      { verb: "type", text: "two" },
      { verb: "click", button: "right", count: 1 },
    ] as GuiAction[]) {
      expect(guard.admit(changed, identity)).toBe(true);
      expect(guard.admit(changed, identity)).toBe(true);
    }
    expect(
      guard.admit(
        { verb: "click", button: "right", count: 1 },
        { ...identity, target: { ...target, mark: 2 } },
      ),
    ).toBe(true);
  });
  it("does not let observation/wait activity reset the last actual input", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity)).toBe(true);
    expect(guard.admit({ verb: "wait", ms: 5 }, identity)).toBe(true);
    expect(guard.admit(key, identity)).toBe(true);
    expect(guard.admit({ verb: "wait", ms: 10 }, identity)).toBe(true);
    expect(guard.admit(key, identity)).toBe(false);
  });
  it("canonicalizes property ordering without changing authority", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity)).toBe(true);
    expect(
      guard.admit(
        { combo: ["Ctrl", "c"], verb: "key" },
        { target: identity.target, point: identity.point, window: 77 },
      ),
    ).toBe(true);
    expect(guard.admit(key, identity)).toBe(false);
  });
  it("copies only a private digest, so later object mutation changes identity instead of rewriting the counter", () => {
    const guard = new RepeatGuard();
    const value: { -readonly [K in keyof NativeActionIdentity]: NativeActionIdentity[K] } =
      structuredClone(identity);
    expect(guard.admit(key, value)).toBe(true);
    expect(guard.admit(key, value)).toBe(true);
    value.window = 78;
    expect(guard.admit(key, value)).toBe(true);
    expect(guard.admit(key, identity)).toBe(true);
  });
  it("counts an identical input only after one that changed nothing on the screen", () => {
    const guard = new RepeatGuard();
    for (let i = 0; i < 6; i++) {
      expect(guard.admit(key, identity)).toBe(true);
      guard.settle(true);
    }
    expect(guard.admit(key, identity)).toBe(true);
    guard.settle(false);
    expect(guard.admit(key, identity)).toBe(true);
    guard.settle(false);
    expect(guard.admit(key, identity)).toBe(false);
  });
  it("pauses on the third identical input when the two before it had no effect", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity)).toBe(true);
    guard.settle(false);
    expect(guard.admit(key, identity)).toBe(true);
    guard.settle(false);
    expect(guard.admit(key, identity)).toBe(false);
  });
  it("a visible change between no-effect inputs restarts the count", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity)).toBe(true);
    guard.settle(false);
    expect(guard.admit(key, identity)).toBe(true);
    guard.settle(true);
    expect(guard.admit(key, identity)).toBe(true);
    guard.settle(false);
    expect(guard.admit(key, identity)).toBe(true);
    guard.settle(false);
    expect(guard.admit(key, identity)).toBe(false);
  });
  it("an input whose effect never arrived counts as one without effect", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity)).toBe(true);
    guard.settle(true);
    expect(guard.admit(key, identity)).toBe(true);
    expect(guard.admit(key, identity)).toBe(true);
    expect(guard.admit(key, identity)).toBe(false);
  });
  it("a repeated or held combo is the same input as its single press", () => {
    const guard = new RepeatGuard();
    expect(guard.admit({ ...key, repeat: 5 }, identity)).toBe(true);
    expect(guard.admit({ ...key, repeat: 3 }, identity)).toBe(true);
    expect(guard.admit({ ...key, holdMs: 500 }, identity)).toBe(false);
  });
  it("an explicit owner reset is the positive Resume boundary", () => {
    const guard = new RepeatGuard();
    expect(guard.admit(key, identity)).toBe(true);
    expect(guard.admit(key, identity)).toBe(true);
    expect(guard.admit(key, identity)).toBe(false);
    guard.reset();
    expect(guard.admit(key, identity)).toBe(true);
  });
});
