import { describe, expect, it } from "vitest";
import { AttentionEngine } from "./attention.ts";

describe("AttentionEngine", () => {
  it("has nothing to attend to before any source is set", () => {
    expect(new AttentionEngine().resolve(0)).toEqual({ source: "idle", point: null });
  });

  it("follows the priority order and lets each source expire", () => {
    const a = new AttentionEngine();
    a.set("target", { x: 1, y: 1 }, 0);
    a.set("pointer", { x: 2, y: 2 }, 0);
    a.set("changed", { x: 3, y: 3 }, 2000);
    expect(a.resolve(100)).toEqual({ source: "pointer", point: { x: 2, y: 2 } });
    expect(a.resolve(2100)).toEqual({ source: "target", point: { x: 1, y: 1 } });
    expect(a.resolve(2600)).toEqual({ source: "changed", point: { x: 3, y: 3 } });
    expect(a.resolve(3300)).toEqual({ source: "idle", point: null });
  });

  it("keeps looking at the user during an approval until it is cleared", () => {
    const a = new AttentionEngine();
    a.set("target", { x: 1, y: 1 }, 0);
    a.set("approval", "user", 0);
    expect(a.resolve(100_000)).toEqual({ source: "approval", point: "user" });
    a.clear("approval");
    expect(a.resolve(100)).toEqual({ source: "target", point: { x: 1, y: 1 } });
  });

  it("ignores non-finite points", () => {
    const a = new AttentionEngine();
    a.set("target", { x: Number.NaN, y: 0 }, 0);
    expect(a.resolve(10).source).toBe("idle");
  });
});
