import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { expect, it } from "vitest";
import { emptyModel, foldEvents } from "../model.ts";
import { chapters, stepBounds, ticks } from "./timeline.ts";

let seq = 0;
const ev = (type: string, t: number, data: Record<string, unknown>, step?: string): LocalDotEvent =>
  ({
    v: 1,
    id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
    seq: seq++,
    agent: "main",
    t: msToMicros(t),
    type,
    data,
    ...(step ? { step } : {}),
  }) as LocalDotEvent;
it("makes one chapter per step labelled by its last action", () => {
  const m = foldEvents(emptyModel(), [
    ev("step.start", 10, { kind: "gui" }, "s1"),
    ev("action.intent", 20, { verb: "click", label: "Click A", risk: "none" }, "s1"),
    ev("step.end", 100, { status: "ok" }, "s1"),
    ev("step.start", 200, { kind: "gui" }, "s2"),
    ev("action.intent", 210, { verb: "type", label: 'Type "B2"', risk: "none" }, "s2"),
  ]);
  expect(chapters(m, 500)).toEqual([
    { id: "s1", label: "Click A", startT: 10, endT: 100, status: "ok" },
    { id: "s2", label: 'Type "B2"', startT: 200, endT: 500, status: "doing" },
  ]);
});
it("labels steps without actions by plan item or kind and clips overlap", () => {
  const m = foldEvents(emptyModel(), [
    ev("plan.set", 0, { items: [{ id: "p", text: "Open sheet", status: "todo" }] }),
    ev("step.start", 10, { kind: "shell", planItem: "p" }, "s1"),
    ev("step.start", 20, { kind: "shell" }, "s2"),
    ev("step.end", 30, { status: "failed" }, "s1"),
  ]);
  expect(chapters(m, 100)).toEqual([
    { id: "s1", label: "Open sheet", startT: 10, endT: 20, status: "failed" },
    { id: "s2", label: "Shell", startT: 20, endT: 100, status: "doing" },
  ]);
});
it("ticks dispatches by input kind, each cancel as failure and each mark", () => {
  const m = foldEvents(emptyModel(), [
    ev("action.intent", 10, { verb: "click", label: "Click", risk: "none" }, "s1"),
    ev(
      "action.dispatch",
      20,
      {
        input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 1 } },
        pressT: 20000,
        ringAt: 20000,
      },
      "s1",
    ),
    ev("action.cancel", 30, { reason: "stale" }, "s1"),
    ev("approval.request", 40, { title: "Send" }),
    ev("action.intent", 50, { verb: "type", label: "Type", risk: "none" }, "s2"),
    ev("action.intent", 60, { verb: "key", label: "Key", risk: "none" }, "s3"),
  ]);
  expect(ticks(m)).toEqual([
    { t: 20, kind: "click", label: "Click", tone: "neutral", step: "s1" },
    { t: 30, kind: "cancel", label: "stale", tone: "failure", step: "s1" },
    { t: 40, kind: "approval", label: "Asked to approve: Send", tone: "attention" },
    { t: 50, kind: "type", label: "Type", tone: "neutral", step: "s2" },
    { t: 60, kind: "key", label: "Key", tone: "neutral", step: "s3" },
  ]);
});
it("keeps original event order when markers and dispatches share a time", () => {
  const m = foldEvents(emptyModel(), [
    ev("action.intent", 10, { verb: "click", label: "Click", risk: "none" }, "s"),
    ev("pause.change", 20, { paused: true, atStepBoundary: true }),
    ev(
      "action.dispatch",
      20,
      {
        input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 1 } },
        pressT: 20000,
        ringAt: 20000,
      },
      "s",
    ),
    ev("control.change", 20, { holder: "user", reason: "user_takeover" }),
    ev("action.cancel", 20, { reason: "stale" }, "s"),
  ]);
  expect(ticks(m).map((t) => t.kind)).toEqual(["pause", "click", "takeover", "cancel"]);
});
it("includes movement inputs and uses session or next-step bounds", () => {
  const m = foldEvents(emptyModel(), [
    ev("step.start", 10, { kind: "gui" }, "s1"),
    ev("action.intent", 10, { verb: "move", label: "Move", risk: "none" }, "s1"),
    ev("step.start", 100, { kind: "gui" }, "s2"),
    ev("session.end", 500, { reason: "done" }),
  ]);
  expect(ticks(m)[0]?.kind).toBe("move");
  expect(stepBounds(m, "s1")).toEqual({ startT: 10, endT: 100 });
  expect(stepBounds(m, "s2")).toEqual({ startT: 100, endT: 500 });
  expect(stepBounds(m, "missing")).toBeUndefined();
});
it("keeps empty timelines empty", () => {
  expect(ticks(emptyModel())).toEqual([]);
  expect(chapters(emptyModel(), 10)).toEqual([]);
});
