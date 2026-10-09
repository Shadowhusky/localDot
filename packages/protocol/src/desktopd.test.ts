import { describe, expect, it } from "vitest";
import {
  HitTestResult,
  InputRequest,
  LaunchRequest,
  SettleRequest,
  TypeRequest,
  WindowInfo,
  ZoomRequest,
} from "./desktopd.ts";

describe("desktopd wire schemas", () => {
  it("defaults the injector to xtest and the hold to 0", () => {
    const req = InputRequest.parse({
      input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 2 } },
    });
    expect(req.injector).toBe("xtest");
    expect(req.holdMs).toBe(0);
  });

  it("bounds a key's repeat to 2-100 presses and its hold to 30 s", () => {
    const key = (more: object) =>
      InputRequest.safeParse({ input: { kind: "key", combo: ["a"], ...more } }).success;
    expect([key({ repeat: 2 }), key({ repeat: 100 }), key({ holdMs: 30_000 })]).toEqual([
      true,
      true,
      true,
    ]);
    expect([key({ repeat: 1 }), key({ repeat: 101 }), key({ repeat: 2.5 })]).toEqual([
      false,
      false,
      false,
    ]);
    expect([key({ holdMs: 0 }), key({ holdMs: 30_001 })]).toEqual([false, false]);
  });

  it("bounds a drag's path and time, and needs a point for a button press or release", () => {
    const input = (value: object) => InputRequest.safeParse({ input: value }).success;
    const at = { x: 1, y: 2 };
    const path = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: i }));
    const drag = (more: object) =>
      input({ kind: "drag", from: at, to: at, button: "left", durationMs: 500, ...more });
    expect([
      drag({}),
      drag({ path: path(62), mods: ["Shift_L"] }),
      drag({ durationMs: 10_000 }),
      input({ kind: "move", to: at, durationMs: 300 }),
      input({ kind: "down", button: "right", at, mods: ["Control_L"] }),
      input({ kind: "up", button: "left", at }),
      input({ kind: "scroll", at, dx: 0, dy: 2, mods: ["Control_L"] }),
    ]).toEqual([true, true, true, true, true, true, true]);
    expect([
      drag({ path: path(63) }),
      drag({ durationMs: 10_001 }),
      drag({ durationMs: undefined }),
      drag({ mods: ["a", "b", "c", "d", "e"] }),
      input({ kind: "down", button: "left" }),
      input({ kind: "up", button: "left" }),
    ]).toEqual([false, false, false, false, false, false]);
    expect(
      InputRequest.parse({
        input: { kind: "drag", from: at, to: at, button: "left", durationMs: 500 },
        dropWindow: 0,
      }).dropWindow,
    ).toBe(0);
  });

  it("caps typed text and rejects an unknown app", () => {
    expect(() =>
      TypeRequest.parse({
        text: "x".repeat(4001),
        masked: false,
        pace: { firstMs: 35, firstCount: 60, restMs: 6 },
      }),
    ).toThrow();
    expect(() => LaunchRequest.parse({ app: "bash" })).toThrow();
    expect(LaunchRequest.parse({ app: "terminal" }).args).toEqual([]);
  });

  it("defaults settle to 250 ms quiet, 1500 ms first change, 3 s cap", () => {
    expect(SettleRequest.parse({})).toEqual({ quietMs: 250, firstMs: 1500, timeoutMs: 3000 });
  });

  it("names the input a settle follows from a fixed set", () => {
    expect(SettleRequest.parse({ verb: "key", firstMs: 400 })).toMatchObject({
      verb: "key",
      firstMs: 400,
    });
    expect(() => SettleRequest.parse({ verb: "drag" })).toThrow();
  });

  it("zooms a frame by its id and a region", () => {
    const region = { x: 10, y: 20, w: 100, h: 50 };
    expect(ZoomRequest.parse({ frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", region }).region).toEqual(
      region,
    );
    expect(() => ZoomRequest.parse({ frameId: "../frame", region })).toThrow();
  });

  it("carries a target name of any length for the gateway to cut", () => {
    const long = {
      point: { x: 1, y: 2 },
      source: "ax",
      name: "n".repeat(300),
      window: "w".repeat(400),
    };
    expect(HitTestResult.parse({ target: long, window: 7, ms: 3 }).target?.name).toHaveLength(300);
  });

  it("keeps a window's frame and an unfinished lookup apart from no element", () => {
    const frame = { x: 0, y: 54, w: 1604, h: 1258 };
    const timedOut = HitTestResult.parse({
      target: null,
      window: 7,
      windowFrame: frame,
      unknown: true,
      ms: 300,
    });
    expect(timedOut).toMatchObject({ windowFrame: frame, unknown: true });
    expect(HitTestResult.parse({ target: null, window: null, ms: 1 }).unknown).toBeUndefined();
    expect(() => HitTestResult.parse({ target: null, window: 7, unknown: false, ms: 1 })).toThrow();
  });

  it("describes popups and transient windows, and still reads a window list without them", () => {
    const base = {
      id: 9,
      pid: 2,
      cls: "Gimp",
      title: "",
      rect: { x: 0, y: 0, w: 10, h: 10 },
      frame: { x: 0, y: 0, w: 10, h: 10 },
      active: false,
    };
    expect(WindowInfo.parse({ ...base, overrideRedirect: true, transientFor: 7 })).toMatchObject({
      overrideRedirect: true,
      transientFor: 7,
    });
    expect(WindowInfo.parse(base).overrideRedirect).toBeUndefined();
  });
});
