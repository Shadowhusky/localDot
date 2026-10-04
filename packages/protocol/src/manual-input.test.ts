import { describe, expect, it } from "vitest";
import { TypeRequest } from "./desktopd.ts";
import { ulid } from "./ids.ts";
import { TakeoverInputRequest } from "./manual-input.ts";

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
