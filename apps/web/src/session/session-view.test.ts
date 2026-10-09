import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { stepRows } from "./session-view.ts";

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
const log = [
  ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "Demo" }),
  ev("agent.state", 1, { state: "acting" }),
  ev("step.start", 10, { kind: "gui" }, "s1"),
  ev(
    "action.intent",
    20,
    { verb: "click", label: 'Click "Name Box"', point: { x: 100, y: 200 }, risk: "none" },
    "s1",
  ),
  ev(
    "action.target",
    30,
    {
      target: {
        point: { x: 100, y: 200 },
        bbox: { x: 80, y: 190, w: 40, h: 20 },
        source: "ax",
        role: "text",
        name: "Name Box",
      },
    },
    "s1",
  ),
  ev(
    "action.dispatch",
    600,
    {
      input: { kind: "click", button: "left", count: 1, at: { x: 100, y: 200 } },
      pressT: 598_000,
      ringAt: 621_100,
      injector: "xtest",
    },
    "s1",
  ),
  ev("observe", 1000, { frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", width: 1280, height: 800 }, "s1"),
  ev("action.result", 1010, { ok: true }, "s1"),
  ev("step.end", 1020, { status: "ok" }, "s1"),
  ev("step.start", 1100, { kind: "gui" }, "s2"),
  ev(
    "action.intent",
    1110,
    { verb: "type", label: 'Type "B2"', point: { x: 100, y: 200 }, risk: "none" },
    "s2",
  ),
];
describe("stepRows", () => {
  it("keeps a step's earliest action time for interleaved key uses", () => {
    const model = foldEvents(emptyModel(), [
      ...log,
      ev("action.intent", 1500, { verb: "key", label: "Press Return", risk: "none" }, "s2"),
    ]);
    expect(stepRows(model).map(({ id, startT }) => ({ id, startT }))).toEqual([
      { id: "s1", startT: 20 },
      { id: "s2", startT: 1110 },
    ]);
  });

  it("lists steps with their thumbnail and target", () => {
    const rows = stepRows(foldEvents(emptyModel(), log));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "s1",
      label: 'Clicked "Name Box"',
      status: "ok",
      frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
      target: { x: 80, y: 190, w: 40, h: 20 },
      durationMs: 990,
    });
    expect(rows[1]).toMatchObject({ id: "s2", label: 'Typing "B2"', status: "doing" });
  });
});

it("completes a successful wait without claiming input, while cancelled waits remain proposed", () => {
  for (const cancelled of [false, true]) {
    const events = [ev("action.intent", 0, { verb: "wait", label: "Wait 500 ms", risk: "none" })];
    events.push(
      cancelled
        ? ev("action.cancel", 500, { reason: "user" })
        : ev("action.result", 500, { ok: true }),
    );
    const row = stepRows(foldEvents(emptyModel(), events))[0];
    expect(row).toMatchObject({
      label: cancelled ? "Wait 500 ms" : "Waited 500 ms",
      delivery: "proposed",
      status: cancelled ? "cancelled" : "ok",
    });
  }
});

it("says what a delivered step tried, not that it finished, when it stopped part-way", () => {
  const events = [
    ev("action.intent", 0, { verb: "key", label: "Hold Delete for 10 s", risk: "none" }),
    ev("action.dispatch", 100, {
      input: { kind: "key", combo: ["Delete"], holdMs: 10_000 },
      pressT: 90_000,
      ringAt: 120_000,
      injector: "xtest",
    }),
    ev("action.result", 3200, { ok: false, error: "Stopped after holding for 3.1 s of 10 s" }),
  ];
  expect(stepRows(foldEvents(emptyModel(), events))[0]).toMatchObject({
    label: "Hold Delete for 10 s",
    delivery: "delivered",
    status: "failed",
  });
});

it("says plainly that a drag cancelled after its press dropped nothing", () => {
  for (const [reason, status, text] of [
    ["user", "cancelled", "Stopped before the drop. The drag was cancelled."],
    ["stale", "failed", "Another window was at the drop point. The drag was cancelled."],
  ] as const) {
    const events = [
      ev("action.intent", 0, { verb: "drag", label: 'Drag "report.txt" to "Trash"', risk: "none" }),
      ev("action.dispatch", 100, {
        input: { kind: "drag", from: { x: 1, y: 1 }, to: { x: 9, y: 9 }, button: "left" },
        pressT: 90_000,
        ringAt: 120_000,
        injector: "xtest",
      }),
      ev("action.cancel", 900, { reason }),
    ];
    expect(stepRows(foldEvents(emptyModel(), events))[0]).toMatchObject({
      label: 'Drag "report.txt" to "Trash"',
      delivery: "delivered",
      status,
      reason: text,
    });
  }
});
