import { describe, expect, it } from "vitest";
import { TypeRequest } from "./desktopd.ts";
import { ulid } from "./ids.ts";
import { ManualStreamInput, TakeoverInputRequest } from "./manual-input.ts";

describe("strict manual input requests", () => {
  it("accepts4000 Unicode code points consistently at both typing boundaries", () => {
    const text = "🙂".repeat(3998) + "中文";
    expect(
      TakeoverInputRequest.parse({ requestId: ulid(), input: { kind: "text", text } }).input.kind,
    ).toBe("text");
    expect(
      TypeRequest.parse({ text, masked: true, pace: { firstMs: 0, firstCount: 0, restMs: 0 } })
        .text,
    ).toBe(text);
  });
  it("refuses held-input shapes, extra authority and malformed/oversized text", () => {
    const requestId = ulid();
    for (const input of [
      { kind: "move", to: { x: 1, y: 2 } },
      { kind: "key", combo: ["ctrl"], holdMs: 500 },
      { kind: "text", text: "x", masked: false },
      { kind: "text", text: "" },
      { kind: "text", text: "x".repeat(4001) },
      { kind: "text", text: "\ud800" },
      { kind: "text", text: "x\0y" },
      { kind: "key", combo: [] },
      { kind: "scroll", at: { x: 0, y: 0 }, dx: 0, dy: 0 },
      { kind: "click", at: { x: -1, y: 0 }, button: "left", count: 1 },
    ])
      expect(TakeoverInputRequest.safeParse({ requestId, input }).success).toBe(false);
    expect(
      TakeoverInputRequest.safeParse({
        requestId,
        cellId: ulid(),
        input: { kind: "text", text: "x" },
      }).success,
    ).toBe(false);
  });
});
describe("the direct control stream", () => {
  it("carries pointer moves, presses and releases and scrolls with modifiers", () => {
    for (const input of [
      { kind: "move", at: { x: 1, y: 2 } },
      { kind: "down", at: { x: 1, y: 2 }, button: "left", mods: ["shift"] },
      { kind: "up", at: { x: 1, y: 2 }, button: "right" },
      { kind: "scroll", at: { x: 1, y: 2 }, dx: 0, dy: -3, mods: ["ctrl"] },
      { kind: "key", combo: ["ctrl", "shift", "t"] },
      { kind: "text", text: "pass word!" },
    ])
      expect(ManualStreamInput.parse(input)).toEqual(input);
  });
  it("refuses held keys, unmasked text, timings and points off any screen", () => {
    for (const input of [
      { kind: "key", combo: ["shift"], holdMs: 500 },
      { kind: "text", text: "x", masked: false },
      { kind: "move", at: { x: 1, y: 2 }, durationMs: 100 },
      { kind: "down", at: { x: -1, y: 0 }, button: "left" },
      { kind: "up", at: { x: 0, y: 0 } },
      { kind: "scroll", at: { x: 0, y: 0 }, dx: 0, dy: 0 },
      { kind: "drag", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
    ])
      expect(ManualStreamInput.safeParse(input).success).toBe(false);
    // The atomic route never takes the stream's held or modified shapes.
    expect(
      TakeoverInputRequest.safeParse({
        requestId: ulid(),
        input: { kind: "scroll", at: { x: 0, y: 0 }, dx: 0, dy: 1, mods: ["ctrl"] },
      }).success,
    ).toBe(false);
  });
});
