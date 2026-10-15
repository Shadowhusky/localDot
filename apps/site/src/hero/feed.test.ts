import type { LocalDotEvent } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { DemoFeed } from "./feed.ts";

let seq = 0;
const at = (ms: number, type: string, data: Record<string, unknown>, step?: string) =>
  ({
    v: 1,
    id: `01M4P3Q306RKQ4XWM5SMWV${String(seq).padStart(4, "0")}`,
    seq: seq++,
    t: ms * 1000,
    agent: "main",
    type,
    data,
    ...(step ? { step } : {}),
  }) as unknown as LocalDotEvent;

const S1 = "01M4P3Q3V001H02KFP4YF18HAA";
const S2 = "01M4P3Q3V001H02KFP4YF18HAB";
const events = [
  at(0, "session.start", { screen: { w: 1280, h: 800, scale: 1 }, os: "linux", title: "Draw" }),
  at(2, "message.user", {
    messageId: "01M4P3Q3088WFG1JFZ2XR8PGY7",
    text: "Draw a face",
    kind: "task",
  }),
  at(1000, "step.start", { kind: "shell", intent: "Find a drawing app" }, S1),
  at(1001, "tool.start", { tool: "shell", title: "command -v gimp" }, S1),
  at(1500, "tool.end", { ok: true, exitCode: 0 }, S1),
  at(1501, "step.end", { status: "ok" }, S1),
  at(2000, "message.assistant", { messageId: "01M4P3Q6CVE6P22X1RSHEMFN4D", text: "Opening GIMP." }),
  at(9000, "step.start", { kind: "shell", intent: "Open GIMP" }, S2),
];

describe("DemoFeed", () => {
  it("shows what had happened by a moment, and nothing after it", () => {
    const feed = new DemoFeed(events);
    feed.advance(1600);
    expect([...feed.agent.messages.values()].map((m) => m.text)).toEqual(["Draw a face"]);
    expect([...feed.agent.steps.keys()]).toEqual([S1]);
    expect(feed.stage.steps.map((s) => s.id)).toEqual([S1]);
  });

  it("starts over when time goes back", () => {
    const feed = new DemoFeed(events);
    feed.advance(10_000);
    expect(feed.agent.steps.size).toBe(2);
    const version = feed.version;
    feed.advance(1600);
    expect(feed.agent.steps.size).toBe(1);
    expect(feed.stage.steps).toHaveLength(1);
    expect(feed.version).toBeGreaterThan(version);
  });

  it("only counts a change when an event was folded", () => {
    const feed = new DemoFeed(events);
    feed.advance(1600);
    const version = feed.version;
    feed.advance(1700);
    expect(feed.version).toBe(version);
  });
});
