import { describe, expect, it, vi } from "vitest";
import { nativeReply, nativeRequest } from "./native-schema.ts";

describe("native inert argument capture", () => {
  it("captures plain and null-prototype data without keeping caller arrays", () => {
    const args = Object.assign(Object.create(null), { combo: ["Shift_L", "Tab"] });
    const captured = nativeRequest("keys", args, 2);
    args.combo[0] = "Control_L";
    expect(captured).toEqual({ combo: ["Shift_L", "Tab"] });
    expect(nativeRequest("char", { ch: "𠮷" }, 2)).toEqual({ ch: "𠮷" });
  });

  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => "中");
    const args = Object.defineProperty({}, "ch", { get: getter, enumerable: true });
    expect(nativeRequest("char", args, 2)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects argument proxies before invoking any trap", () => {
    const trap = vi.fn(() => {
      throw new Error("private-canary");
    });
    const args = new Proxy({ ch: "中" }, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    expect(nativeRequest("char", args, 2)).toBeUndefined();
    expect(trap).not.toHaveBeenCalled();
  });

  it("rejects nested array accessors and proxies without invoking them", () => {
    const getter = vi.fn(() => "Tab");
    const combo = Object.defineProperty(["Tab"], "0", { get: getter });
    expect(nativeRequest("keys", { combo }, 2)).toBeUndefined();
    const proxy = new Proxy(["Tab"], { get: getter });
    expect(nativeRequest("keys", { combo: proxy }, 2)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it("refuses inherited, symbolic, hidden, sparse and cyclic input data", () => {
    expect(nativeRequest("char", Object.create({ ch: "中" }), 2)).toBeUndefined();
    expect(nativeRequest("char", { ch: "中", [Symbol("hidden")]: "secret" }, 2)).toBeUndefined();
    expect(
      nativeRequest("char", Object.defineProperty({}, "ch", { value: "中" }), 2),
    ).toBeUndefined();
    expect(nativeRequest("keys", { combo: new Array(2) }, 2)).toBeUndefined();
    const cyclic: Record<string, unknown> = {};
    cyclic.ch = cyclic;
    expect(nativeRequest("char", cyclic, 2)).toBeUndefined();
  });

  it("refuses oversized own-data capture before schema traversal", () => {
    expect(nativeRequest("char", { ch: "x".repeat(65) }, 2)).toBeUndefined();
    expect(
      nativeRequest(
        "ping",
        Object.fromEntries(Array.from({ length: 9 }, (_, position) => [String(position), 1])),
        2,
      ),
    ).toBeUndefined();
    expect(nativeRequest("keys", { combo: ["a", "b", "c", "d"] }, 2)).toBeUndefined();
  });
});

describe("native replies for a held button", () => {
  it("accepts a press, a release or a cancel only for the button asked about", () => {
    const at = { x: 10, y: 20 };
    expect(nativeReply("down", { button: 1 }, { ...at, button: 1, mods: [] })).toEqual({
      button: 1,
    });
    expect(nativeReply("down", { button: 3 }, { ...at, button: 1, mods: [] })).toBeUndefined();
    expect(nativeReply("up", { button: 1, released: true }, { ...at, button: 1 })).toEqual({
      button: 1,
      released: true,
    });
    expect(nativeReply("up", { button: 2, released: true }, { ...at, button: 1 })).toBeUndefined();
    expect(nativeReply("cancel", { buttons: 1, escaped: true }, {})).toEqual({
      buttons: 1,
      escaped: true,
    });
    expect(nativeRequest("cancel", { x: 1 }, 2)).toBeUndefined();
  });
});
