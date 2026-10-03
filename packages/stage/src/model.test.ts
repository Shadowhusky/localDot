import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { emptyModel, foldEvents } from "./model.ts";

let seq = 0;
const ev = (
  type: string,
  tMs: number,
  data: Record<string, unknown>,
  step?: string,
): LocalDotEvent =>
  ({
    v: 1,
    id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
    seq: seq++,
    t: msToMicros(tMs),
    agent: "main",
    ...(step ? { step } : {}),
    type,
    data,
  }) as LocalDotEvent;

const click = (startMs: number, step: string): LocalDotEvent[] => [
  ev(
    "action.intent",
    startMs,
    {
      verb: "click",
      label: "Click A",
      point: { x: 300, y: 400 },
      risk: "none",
      pointer: {
        from: { x: 100, y: 100 },
        to: { x: 300, y: 400 },
        startsAt: startMs + 120,
        durationMs: 400,
        seed: 1,
        curve: "minjerk-bow-v1",
      },
    },
    step,
  ),
  ev(
    "action.target",
    startMs + 50,
    {
      target: {
        point: { x: 300, y: 400 },
        bbox: { x: 280, y: 380, w: 40, h: 40 },
        source: "ax",
        role: "button",
        name: "A",
      },
    },
    step,
  ),
  ev(
    "action.dispatch",
    startMs + 615,
    {
      input: { kind: "click", button: "left", count: 1, at: { x: 300, y: 400 } },
      pressT: msToMicros(startMs + 612),
      ringAt: msToMicros(startMs + 635.1),
      injector: "xtest",
    },
    step,
  ),
  ev(
    "screen.settle",
    startMs + 900,
    { frameT: msToMicros(startMs + 700), changed: [], noVisibleChange: false },
    step,
  ),
  ev(
    "observe",
    startMs + 1200,
    { frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", width: 1280, height: 800 },
    step,
  ),
  ev("action.result", startMs + 1210, { ok: true }, step),
];

describe("foldEvents", () => {
  it("folds keyd use in milliseconds beside actions without retaining event data aliases", () => {
    const first = ev("key.use", 1500, {
      secretId: "weather",
      host: "api.weather.example",
      method: "GET",
      path: "/now",
      decision: "allow",
    });
    const second = ev("key.use", 2500, {
      secretId: "weather",
      host: "api.weather.example",
      method: "POST",
      path: "/later",
      decision: "deny",
    });
    const m = foldEvents(emptyModel(), [first]);
    expect(m.actions).toEqual([]);
    expect(m.keyUses).toEqual([
      {
        id: first.id,
        t: 1500,
        secretId: "weather",
        host: "api.weather.example",
        method: "GET",
        path: "/now",
        decision: "allow",
      },
    ]);
    const previousUse = structuredClone(m.keyUses[0]);
    expect(foldEvents(m, [first, second])).toBe(m);
    expect(m.keyUses).toHaveLength(2);
    expect(m.keyUses[0]).toEqual(previousUse);
    expect(m.keyUses[1]).toMatchObject({ t: 2500, decision: "deny" });
    if (first.type === "key.use") first.data.path = "/mutated-source-event";
    expect(m.keyUses[0]?.path).toBe("/now");
  });

  it("keeps key history independent across models and incremental folds", () => {
    const events = [
      ev("key.use", 100, {
        secretId: "one",
        host: "a.example",
        method: "GET",
        path: "/",
        decision: "allow",
      }),
      ev("key.use", 200, {
        secretId: "two",
        host: "b.example",
        method: "GET",
        path: "/",
        decision: "ask",
      }),
    ];
    const whole = foldEvents(emptyModel(), events);
    const halves = foldEvents(foldEvents(emptyModel(), events.slice(0, 1)), events.slice(1));
    expect(halves).toEqual(whole);
    expect(halves.keyUses).not.toBe(whole.keyUses);
    expect(halves.keyUses[0]).not.toBe(whole.keyUses[0]);
    expect(emptyModel().keyUses).toEqual([]);
  });

  it("builds one action per intent and attaches the rest by step, converting times to ms", () => {
    const m = foldEvents(emptyModel(), [
      ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "t" }),
      ev("agent.state", 1, { state: "acting" }),
      ...click(1000, "s1"),
      ...click(3000, "s2"),
    ]);
    expect(m.screen).toEqual({ w: 2560, h: 1600, scale: 2 });
    expect(m.actions).toHaveLength(2);
    const a = m.actions[0];
    expect(a).toMatchObject({
      verb: "click",
      label: "Click A",
      intentT: 1000,
      step: "s1",
      ok: true,
      resultT: 2210,
      settleT: 1900,
    });
    expect(a?.plan?.startsAt).toBe(1120);
    expect(a?.target?.name).toBe("A");
    expect(a?.dispatch).toMatchObject({ t: 1615, pressT: 1612, ringAt: 1635.1 });
    expect(m.actions[1]?.intentT).toBe(3000);
  });

  it("is incremental: folding in two halves equals folding at once", () => {
    const events = [
      ev("agent.state", 1, { state: "acting" }),
      ...click(1000, "s1"),
      ev("text.progress", 2300, { count: 2, chunk: "hi", masked: false }, "s1"),
      ev("session.end", 5000, { reason: "done" }),
    ];
    const whole = foldEvents(emptyModel(), events);
    const halves = foldEvents(foldEvents(emptyModel(), events.slice(0, 4)), events.slice(4));
    expect(halves).toEqual(whole);
    expect(whole.ended).toEqual({ t: 5000, reason: "done" });
  });

  it("attaches events without a step to the latest action and records cancels", () => {
    const m = foldEvents(emptyModel(), [
      ev("action.intent", 10, { verb: "key", label: "Press Return", risk: "none" }),
      ev("action.cancel", 50, { reason: "timeout", detail: "no press" }),
    ]);
    expect(m.actions[0]?.cancel).toEqual({ t: 50, reason: "timeout" });
  });
});
