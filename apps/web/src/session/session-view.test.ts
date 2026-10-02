import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { hudFor } from "../cells/hud-state.ts";
import { mergeHud, sessionHud, stepRows } from "./session-view.ts";

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
const cell = {
  id: "01JXYZ0000000000000000ABCD",
  state: "ready" as const,
  scale: 2 as const,
  createdAt: "",
  stream: { connection: "live" as const, viewers: 1, lastUpstreamAt: null },
};

describe("sessionHud", () => {
  it("labels the current action in the present progressive with the elapsed time after 5 s", () => {
    const m = foldEvents(emptyModel(), log);
    expect(sessionHud(m, 1200)).toMatchObject({
      label: 'Typing "B2"',
      control: true,
      state: "working",
      elapsedS: null,
    });
    expect(sessionHud(m, 7200)).toMatchObject({ elapsedS: 7 });
    expect(
      sessionHud(
        foldEvents(emptyModel(), [...log, ev("session.end", 2000, { reason: "done" })]),
        2500,
      ),
    ).toMatchObject({ label: "Done", control: false, state: "done" });
  });

  it("merges into the cell HUD: the session owns the label and the Stop while live", () => {
    const merged = mergeHud(
      hudFor({ cell, status: "known", pending: null }),
      sessionHud(foldEvents(emptyModel(), log), 1200),
    );
    expect(merged).toMatchObject({
      label: 'Typing "B2"',
      action: { kind: "stop", enabled: true },
      stop: true,
      control: true,
      live: true,
    });
    expect(mergeHud(hudFor({ cell, status: "known", pending: null }), null)).toMatchObject({
      label: "Live",
      action: { kind: "stop", enabled: true },
      control: false,
    });
    // A finished session keeps its verdict on the HUD while the computer is live, and gives the
    // computer's own Stop back.
    const done = sessionHud(
      foldEvents(emptyModel(), [...log, ev("session.end", 2000, { reason: "done" })]),
      2500,
    );
    expect(mergeHud(hudFor({ cell, status: "known", pending: null }), done)).toMatchObject({
      label: "Done",
      caption: "Done.",
      action: { kind: "stop", enabled: true },
      control: false,
    });
    expect(mergeHud(hudFor({ cell, status: "known", pending: null }), done).stop).toBeUndefined();
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
