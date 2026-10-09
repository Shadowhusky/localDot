import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  emptyModel,
  foldEvents,
  observeAt,
  planAt,
  startedCount,
  stepAt,
  turnAt,
} from "./model.ts";

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

describe("what dot says", () => {
  const MESSAGE = "01J9ZQ3V8Y7X6W5T4S3R2Q1P1A";
  it("keeps each call's line on its step, and the tail of each message with when each sentence ended", () => {
    const model = foldEvents(emptyModel(), [
      ev("step.start", 10, { kind: "shell", intent: "Checking which apps are installed" }, "s1"),
      ev("step.start", 20, { kind: "gui" }, "s2"),
      ev("message.delta", 30, { messageId: MESSAGE, text: `${"x".repeat(700)}. Found the ` }),
      ev("message.delta", 40, { messageId: MESSAGE, text: "report." }),
      ev("message.delta", 45, { messageId: MESSAGE, text: " Opening it now." }),
    ]);
    expect(model.steps.map((step) => step.intent)).toEqual([
      "Checking which apps are installed",
      undefined,
    ]);
    expect(model.said).toHaveLength(1);
    expect(model.said[0]).toMatchObject({ id: MESSAGE, final: false });
    expect(model.said[0]?.text).toHaveLength(600);
    expect(model.said[0]?.text.endsWith(" Opening it now.")).toBe(true);
    expect(model.said[0]?.lines.slice(1)).toEqual([
      { t: 40, text: "Found the report." },
      { t: 45, text: "Opening it now." },
    ]);
    foldEvents(model, [
      ev("message.assistant", 50, { messageId: MESSAGE, text: "Opened it." }),
      ev("message.delta", 60, { messageId: MESSAGE, text: " late" }),
    ]);
    expect(model.said[0]).toMatchObject({ text: "Opened it.", final: true });
    expect(model.said[0]?.lines.at(-1)).toEqual({ t: 50, text: "Opened it." });
    expect(model.said[0]?.lines).toHaveLength(4);
  });

  it("starts a turn at each task or follow-up, not at a steer", () => {
    const model = foldEvents(emptyModel(), [
      ev("message.user", 5, { messageId: MESSAGE, text: "Text Mum", kind: "task" }),
      ev("message.user", 50, { messageId: MESSAGE, text: "and Dad", kind: "steer" }),
      ev("message.user", 90, { messageId: MESSAGE, text: "Now Gran", kind: "followup" }),
    ]);
    expect(turnAt(model, 4)).toBe(Number.NEGATIVE_INFINITY);
    expect(turnAt(model, 60)).toBe(5);
    expect(turnAt(model, 90)).toBe(90);
    expect(model.marks.filter((mark) => mark.type === "message.user")).toHaveLength(3);
  });
});

describe("tool steps", () => {
  it("keeps the step's tool and title, and when its output arrived, coalesced", () => {
    const m = foldEvents(emptyModel(), [
      ev("step.start", 10, { kind: "shell" }, "s1"),
      ev("tool.start", 11, { tool: "shell", title: "npm test" }, "s1"),
      ...[20, 60, 200, 210, 400].map((t) =>
        ev("tool.output", t, { stream: "stdout", chunk: "." }, "s1"),
      ),
      ev("tool.end", 500, { ok: true }, "s1"),
    ]);
    expect(m.steps[0]).toMatchObject({ tool: "shell", title: "npm test", outputs: [20, 200, 400] });
    expect(m.marks.map((mark) => mark.label)).toContain("npm test");
  });
});

describe("replay model indexes", () => {
  it("keeps observes, steps and plans in order and indexes the current action by step", () => {
    const events = [
      ev("step.start", 10, { kind: "gui", planItem: "p1" }, "s1"),
      ev("action.intent", 20, { verb: "click", label: "A", risk: "none" }, "s1"),
      ev("observe", 30, { frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", width: 1280, height: 800 }, "s1"),
      ev("step.end", 40, { status: "failed" }, "s1"),
      ev("plan.set", 50, {
        items: [
          { id: "p1", text: "First", status: "todo" },
          { id: "p2", text: "Second", status: "doing" },
        ],
      }),
      ev("plan.update", 60, { id: "p2", status: "done" }),
    ];
    const m = foldEvents(emptyModel(), events);
    expect(m.observes).toEqual([
      { t: 30, frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", step: "s1", screen: "desktop" },
    ]);
    expect(m.steps[0]).toEqual({
      id: "s1",
      kind: "gui",
      startT: 10,
      endT: 40,
      status: "failed",
      planItem: "p1",
    });
    expect(m.byStep.get("s1")).toBe(0);
    expect(m.stepIndex.get("s1")).toBe(0);
    expect(stepAt(m, 9)).toBeUndefined();
    expect(stepAt(m, 10)).toBe(m.steps[0]);
    expect(stepAt(m, 70)).toBe(m.steps[0]);
    expect(observeAt(m, 29)).toBeUndefined();
    expect(observeAt(m, 30)).toBe(m.observes[0]);
    expect(planAt(m, 49)).toEqual([]);
    expect(planAt(m, 50)[1]?.status).toBe("doing");
    expect(planAt(m, 59)[1]?.status).toBe("doing");
    expect(planAt(m, 60)[1]?.status).toBe("done");
    expect(startedCount(m, 19)).toBe(0);
    expect(startedCount(m, 20)).toBe(1);
    expect(foldEvents(foldEvents(emptyModel(), events.slice(0, 4)), events.slice(4))).toEqual(m);
    expect(structuredClone(m)).toEqual(m);
    expect(m.frames.get("s1")).toBe(m.observes[0]?.frameId);
  });
  it("preserves each plan snapshot and the input event's data independently", () => {
    const set = ev("plan.set", 10, { items: [{ id: "p", text: "Original", status: "todo" }] });
    const m = foldEvents(emptyModel(), [
      set,
      ev("plan.update", 20, { id: "p", status: "done" }),
      ev("plan.update", 30, { id: "missing", status: "done" }),
    ]);
    if (set.type === "plan.set") {
      const item = set.data.items[0];
      if (item) item.text = "Changed";
    }
    expect(planAt(m, 10)).toEqual([{ id: "p", text: "Original", status: "todo" }]);
    expect(planAt(m, 20)).toEqual([{ id: "p", text: "Original", status: "done" }]);
    expect(m.plans).toHaveLength(3);
  });
  it("attaches late step-specific results to the indexed action, retains key history and mark", () => {
    const m = foldEvents(emptyModel(), [
      ev("action.intent", 10, { verb: "wait", label: "First", risk: "none" }, "s1"),
      ev("action.intent", 20, { verb: "wait", label: "Second", risk: "none" }, "s2"),
      ev("action.result", 30, { ok: false }, "s1"),
      ev("action.result", 40, { ok: true }, "unknown"),
      ev("key.use", 50, {
        secretId: "k",
        host: "api.example.com",
        method: "GET",
        path: "/",
        decision: "ask",
      }),
    ]);
    expect(m.actions[0]?.ok).toBe(false);
    expect(m.actions[1]?.ok).toBe(true);
    expect(m.keyUses).toHaveLength(1);
    expect(m.marks).toMatchObject([{ kind: "key", tone: "attention", t: 50 }]);
  });
  it("binary-searches equal timestamps, empty models and nearest earlier observations", () => {
    const m = foldEvents(emptyModel(), [
      ev("action.intent", 10, { verb: "wait", label: "A", risk: "none" }),
      ev("action.intent", 10, { verb: "wait", label: "B", risk: "none" }),
      ev("observe", 10, { frameId: "a", width: 1, height: 1 }),
      ev("observe", 10, { frameId: "b", width: 1, height: 1 }),
      ev("observe", 20, { frameId: "c", width: 1, height: 1 }),
    ]);
    expect(startedCount(emptyModel(), 0)).toBe(0);
    expect(startedCount(m, 9)).toBe(0);
    expect(startedCount(m, 10)).toBe(2);
    expect(observeAt(m, 10)?.frameId).toBe("b");
    expect(observeAt(m, 19)?.frameId).toBe("b");
    expect(observeAt(m, 20)?.frameId).toBe("c");
  });
});

it("retains event sequence numbers for equal-time action and marker ordering", () => {
  const intent = ev("action.intent", 10, { verb: "click", label: "A", risk: "none" }, "s1");
  const dispatch = ev(
    "action.dispatch",
    10,
    {
      input: { kind: "click", button: "left", count: 1, at: { x: 1, y: 1 } },
      pressT: msToMicros(10),
      ringAt: msToMicros(10),
    },
    "s1",
  );
  const cancel = ev("action.cancel", 10, { reason: "stale" }, "s1");
  const m = foldEvents(emptyModel(), [intent, dispatch, cancel]);
  expect(m.actions[0]).toMatchObject({
    intentSeq: intent.seq,
    dispatchSeq: dispatch.seq,
    cancelSeq: cancel.seq,
  });
});
