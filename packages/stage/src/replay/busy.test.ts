import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { expect, it } from "vitest";
import { emptyModel, foldEvents } from "../model.ts";
import { TARGET_FADE_MS, TARGET_HOLD_MS } from "../timing.ts";
import { ACTIVITY_TAIL_MS, busySpans } from "./busy.ts";
import { buildPlaybackMap, idleAt } from "./playback-map.ts";

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
it("keeps an action busy through target hold and thinking idle", () => {
  const m = foldEvents(emptyModel(), [
    ev("session.start", 0, { screen: { w: 1, h: 1, scale: 1 }, os: "linux" }),
    ev("action.intent", 10000, { verb: "click", label: "A", risk: "none" }),
    ev("action.result", 11000, { ok: true }),
    ev("agent.state", 11500, { state: "thinking" }),
    ev("control.change", 40000, { holder: "user", reason: "user_takeover" }),
    ev("session.end", 60000, { reason: "done" }),
  ]);
  const spans = busySpans(m, [{ from: 10600000, to: 10900000 }], 60000);
  expect(spans).toEqual([
    { from: 0, to: 1000 },
    { from: 10000, to: 11000 + TARGET_HOLD_MS + TARGET_FADE_MS },
    { from: 40000, to: 41200 },
  ]);
  const map = buildPlaybackMap(0, 60000, spans, true);
  expect(idleAt(map, 20000)).toBe(true);
  expect(idleAt(map, 10500)).toBe(false);
});
it("keeps a typing burst through its last progress line", () => {
  const m = foldEvents(emptyModel(), [
    ev("action.intent", 10000, { verb: "type", label: "Type", risk: "none" }),
    ev("text.progress", 12000, { count: 1, chunk: "x", masked: false }),
    ev("text.progress", 13000, { count: 2, chunk: "y", masked: false }),
    ev("action.result", 13100, { ok: true }),
  ]);
  expect(busySpans(m, [], 20000)).toContainEqual({ from: 10000, to: 14300 });
});
it("keeps an unfinished action busy until session end and clips its tail", () => {
  const m = foldEvents(emptyModel(), [
    ev("action.intent", 10000, { verb: "wait", label: "Wait", risk: "none" }),
    ev("session.end", 60000, { reason: "stopped" }),
  ]);
  expect(busySpans(m, [], 60000)).toContainEqual({ from: 10000, to: 60000 });
});
it("keeps video activity and step edges, while clipping and merging overlap", () => {
  const m = foldEvents(emptyModel(), [
    ev("session.start", 2000, { screen: { w: 1, h: 1, scale: 1 }, os: "linux" }),
    ev("step.start", 3500, { kind: "shell" }, "s"),
    ev("step.end", 5000, { status: "ok" }, "s"),
  ]);
  expect(
    busySpans(
      m,
      [
        { from: 3900000, to: 4200000 },
        { from: 7000000, to: 9900000 },
      ],
      8000,
    ),
  ).toEqual([
    { from: 2000, to: 3000 },
    { from: 3500, to: 4300 },
    { from: 5000, to: 5600 },
    { from: 7000, to: 8000 },
  ]);
});
it("skips screen changes while dot is only thinking, and keeps them during and just after an action", () => {
  const m = foldEvents(emptyModel(), [
    ev("session.start", 0, { screen: { w: 1, h: 1, scale: 1 }, os: "linux" }),
    ev("action.intent", 10000, { verb: "click", label: "A", risk: "none" }),
    ev("action.result", 11000, { ok: true }),
    ev("agent.state", 11500, { state: "thinking" }),
    ev("session.end", 60000, { reason: "done" }),
  ]);
  const caretBlinks = Array.from({ length: 40 }, (_, i) => ({
    from: (13000 + i * 1000) * 1000,
    to: (13000 + i * 1000 + 50) * 1000,
  }));
  const spans = busySpans(m, [{ from: 11200000, to: 12200000 }, ...caretBlinks], 60000);
  expect(spans).toEqual([
    { from: 0, to: 1000 },
    { from: 10000, to: 12200 + ACTIVITY_TAIL_MS },
  ]);
  const map = buildPlaybackMap(0, 60000, spans, true);
  expect(idleAt(map, 30000)).toBe(true);
});
it("ends cancellation at its target tail and merges repeated marks", () => {
  const m = foldEvents(emptyModel(), [
    ev("action.intent", 10000, { verb: "click", label: "A", risk: "none" }),
    ev("action.cancel", 10200, { reason: "stale" }),
    ev("pause.change", 11000, { paused: true, atStepBoundary: true }),
    ev("pause.change", 11200, { paused: false, atStepBoundary: true }),
  ]);
  expect(busySpans(m, [], 20000)).toEqual([
    { from: 0, to: 1000 },
    { from: 10000, to: 12400 },
  ]);
});
