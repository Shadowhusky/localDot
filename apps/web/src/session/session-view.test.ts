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
  it("keeps paused controls and caption even if session end is delayed or an old verdict remains", () => {
    const frozen = hudFor({ cell: { ...cell, paused: true }, status: "known", pending: null });
    const working = sessionHud(foldEvents(emptyModel(), log), 1200);
    for (const state of ["working", "idle", "done", "stopped", "error"] as const) {
      const merged = mergeHud(frozen, { ...working, state });
      expect(merged).toMatchObject({
        label: "Paused",
        caption: frozen.caption,
        control: false,
        live: false,
        action: { kind: "resume" },
      });
      expect(merged.stop).toBeUndefined();
    }
    expect(
      mergeHud(
        { ...frozen, caption: "The key layer is offline." },
        { ...working, state: "stopped" },
      ).caption,
    ).toBe("The key layer is offline.");
  });

  it("keeps pause authoritative while relisting after a lost Resume response and during gate recovery", () => {
    const working = sessionHud(foldEvents(emptyModel(), log), 1200);
    const paused = { ...cell, paused: true as const };
    for (const view of [
      { cell: paused, status: "known" as const, pending: "list" as const },
      { cell: { ...paused, state: "starting" as const }, status: "known" as const, pending: null },
    ]) {
      const hud = hudFor(view);
      expect(hud.paused).toBe(true);
      const merged = mergeHud(hud, working);
      expect(merged).toMatchObject({ label: "Paused", control: false, live: false });
      expect(merged.stop).toBeUndefined();
      expect(merged.caption).toBe(hud.caption);
    }
    expect(hudFor({ cell: paused, status: "known", pending: "list" }).action.enabled).toBe(false);
  });

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
