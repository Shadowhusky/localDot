import type { LocalDotEvent } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { prune, type Segment, toSession, toVideo } from "./demo.ts";

// Two cuts of a task: 10–70 s of the session at 8×, then 200–230 s at 2×.
const segments: Segment[] = [
  { from: 10_000, to: 70_000, speed: 8, at: 0 },
  { from: 200_000, to: 230_000, speed: 2, at: 7_500 },
];

describe("toSession", () => {
  it("maps video time into the session through each cut's speed", () => {
    expect(toSession(0, segments)).toBe(10_000);
    expect(toSession(1_000, segments)).toBe(18_000);
    expect(toSession(7_500, segments)).toBe(200_000);
    expect(toSession(8_500, segments)).toBe(202_000);
  });

  it("holds the start before the video and the end after it", () => {
    expect(toSession(-50, segments)).toBe(10_000);
    expect(toSession(99_000, segments)).toBe(230_000);
  });
});

describe("toVideo", () => {
  it("is the inverse inside the cuts", () => {
    for (const v of [0, 1_234, 7_499, 7_500, 21_999])
      expect(toVideo(toSession(v, segments), segments)).toBeCloseTo(v, 6);
  });

  it("has no video time for what was cut", () => {
    expect(toVideo(100_000, segments)).toBeNull();
    expect(toVideo(5_000, segments)).toBeNull();
  });
});

const event = (type: string, t: number, data: Record<string, unknown> = {}) =>
  ({ v: 1, id: `e${t}`, seq: t, t, agent: "main", type, data }) as unknown as LocalDotEvent;

describe("prune", () => {
  it("drops what a visitor never sees and what names the owner's keys", () => {
    const kept = prune([
      event("session.start", 1),
      event("thought.delta", 2, { text: "hmm" }),
      event("message.delta", 3, { messageId: "m", text: "I" }),
      event("heartbeat", 4),
      event("key.use", 5, { secretId: "deepseek" }),
      event("safety.taint", 6),
      event("message.assistant", 7, { messageId: "m", text: "I'll start." }),
      event("model.spend", 8, { costUSD: 0.01 }),
    ]);
    expect(kept.map((e) => e.type)).toEqual(["session.start", "message.assistant", "model.spend"]);
  });
});
