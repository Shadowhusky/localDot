import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { emptyAgentModel } from "../agent/model.ts";
import { projectAgentEvent } from "../agent/reducer.ts";
import { type HudState, hudFor } from "../cells/hud-state.ts";
import { mergeHud, type TaskFacts, taskFacts, taskHud } from "./task-hud.ts";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
let seq = 0;
const ev = (
  type: string,
  tMs: number,
  data: Record<string, unknown>,
  step?: string,
): LocalDotEvent =>
  ({
    v: 1,
    id: ID,
    seq: seq++,
    t: msToMicros(tMs),
    agent: "main",
    ...(step ? { step } : {}),
    type,
    data,
  }) as LocalDotEvent;
const start = () => [
  ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "Demo" }),
  ev("agent.state", 1, { state: "acting" }),
  ev("step.start", 10, { kind: "gui" }, "s1"),
  ev(
    "action.intent",
    20,
    { verb: "type", label: "Type =SUM(F2:F13)", point: { x: 100, y: 200 }, risk: "none" },
    "s1",
  ),
];
const typed = () => [
  ...start(),
  ev(
    "action.dispatch",
    600,
    {
      input: { kind: "type", chars: 12, masked: false },
      pressT: 598_000,
      ringAt: 621_100,
      injector: "xtest",
    },
    "s1",
  ),
  ev("action.result", 1010, { ok: true }, "s1"),
  ev("step.end", 1020, { status: "ok" }, "s1"),
];
const cell = {
  id: "01JXYZ0000000000000000ABCD",
  state: "ready" as const,
  scale: 2 as const,
  createdAt: "",
  stream: { connection: "live" as const, viewers: 1, lastUpstreamAt: null },
};
const live = hudFor({ cell, status: "known", pending: null });
const facts = (events: LocalDotEvent[]): TaskFacts =>
  taskFacts(events.reduce(projectAgentEvent, emptyAgentModel()));
// The live HUD as App derives it: the timeline plus the facts from the same events.
function view(events: LocalDotEvent[], nowMs: number, hud: HudState = live) {
  const task = taskHud(foldEvents(emptyModel(), events), nowMs, facts(events));
  return { task, merged: mergeHud(hud, task) };
}
const pause = (phase: "pausing" | "paused") => ({
  revision: 1,
  pause: {
    requestId: ID,
    revision: 1,
    phase,
    reason: "user",
    atStepBoundary: phase === "paused",
    resumeAvailable: phase === "paused",
  },
});

describe("the task HUD tells the task's state before its last action (QA-D6)", () => {
  it("says Done for a finished task in the follow-up window, with no clock and the computer's control", () => {
    const done = [
      ...typed(),
      ev("message.assistant", 1500, { messageId: ID, text: "Report ready" }),
      ev("task.result", 1600, { summary: "done", files: [] }),
      ev("agent.state", 1700, { state: "done" }),
    ];
    const { task, merged } = view(done, 9500);
    expect(task).toMatchObject({ row: "done", phase: "finished", label: "Done", control: false });
    expect(merged).toMatchObject({ label: "Done", action: { kind: "stop" }, control: false });
    expect(merged.stop).toBeUndefined();
    expect(merged.elapsedS).toBeUndefined();
    const idle = [...done.slice(0, -1), ev("agent.state", 1700, { state: "idle" })];
    expect(view(idle, 9500).merged.label).toBe("Done");
    const noResult = [...typed(), ev("agent.state", 1700, { state: "idle", reason: "gave up" })];
    expect(view(noResult, 9500).task).toMatchObject({ row: "ready", label: "Ready" });
  });

  it("puts a question first, keeps the task's Stop and shows no clock", () => {
    const asked = [
      ...typed(),
      ev("ask.request", 1500, {
        askId: ID,
        question: "Which format?",
        options: [{ key: "A", text: "Markdown" }],
        allowText: true,
      }),
      ev("agent.state", 1510, { state: "waiting_user", reason: "question" }),
    ];
    const { task, merged } = view(asked, 9500);
    expect(task).toMatchObject({ row: "question", label: "Has a question", control: false });
    expect(merged).toMatchObject({ caption: "Which format?", stop: true, control: false });
    expect(merged.elapsedS).toBeNull();
    const answered = [...asked, ev("ask.answer", 2000, { askId: ID, option: "A", by: "user" })];
    expect(view(answered, 3000).task).toMatchObject({ row: "working", control: true });
  });

  it("puts an approval first, before the daemon's waiting state arrives", () => {
    const requested = [
      ...start(),
      ev("approval.request", 1500, {
        approvalId: ID,
        generation: 1,
        revision: 1,
        expiresAt: 9_999_999_999,
        actionClass: "send",
        risk: "high",
        title: "Send the report",
        kind: "send",
        preview: { fields: [["To", "team@example.test"]] },
      }),
    ];
    expect(view(requested, 9500).merged).toMatchObject({
      label: "Needs your OK",
      stop: true,
      control: false,
      elapsedS: null,
    });
    const recorded = [
      ...requested,
      ev("agent.state", 1501, { state: "waiting_user", reason: "approval" }),
    ];
    expect(taskHud(foldEvents(emptyModel(), recorded), 9500)).toMatchObject({
      row: "waiting",
      label: "Waiting for you",
      control: false,
    });
  });

  it("names a budget pause and shows no clock", () => {
    const budget = [...typed(), ev("agent.state", 1500, { state: "paused", reason: "budget" })];
    const { task, merged } = view(budget, 9500);
    expect(task).toMatchObject({
      row: "recovery",
      phase: "waiting",
      label: "Paused · Limit reached",
    });
    expect(merged).toMatchObject({ stop: true, control: false, elapsedS: null });
    const keyLayer = [
      ...typed(),
      ev("agent.state", 1500, { state: "paused", reason: "keyd unavailable" }),
    ];
    expect(view(keyLayer, 9500).task.label).toBe("Paused");
  });

  it("follows a user Pause from pausing to paused, then back to work after Resume", () => {
    const pausing = [...start(), ev("safety.pause", 300, pause("pausing"))];
    expect(view(pausing, 9500).merged).toMatchObject({
      label: "Pausing after this step",
      control: true,
      elapsedS: 9,
      stop: true,
    });
    const paused = [
      ...typed(),
      ev("safety.pause", 1100, pause("pausing")),
      ev("agent.state", 1100, { state: "paused", reason: "user" }),
      ev("safety.pause", 1200, pause("paused")),
    ];
    expect(view(paused, 18500)).toMatchObject({
      task: { row: "paused", phase: "waiting", label: "Paused" },
      merged: { label: "Paused", stop: true, control: false, elapsedS: null },
    });
    const resumed = [...paused, ev("safety.pause", 20000, { revision: 2 })];
    expect(view(resumed, 20100).task).toMatchObject({
      row: "working",
      phase: "running",
      control: true,
    });
  });

  it("after Stop, a computer that is live again keeps the stopped verdict with its own control", () => {
    const stopped = [...typed(), ev("session.end", 1500, { reason: "stopped" })];
    const { task, merged } = view(stopped, 9500);
    expect(task).toMatchObject({ row: "stopped", label: "Task stopped", control: false });
    expect(merged).toMatchObject({
      label: "Task stopped",
      live: true,
      action: { kind: "stop", enabled: true },
      control: false,
    });
    expect(merged.stop).toBeUndefined();
    const frozen = hudFor({ cell: { ...cell, paused: true }, status: "known", pending: null });
    expect(view(stopped, 9500, frozen).merged).toMatchObject({ label: "Paused", control: false });
    const off = hudFor({
      cell: { ...cell, state: "stopped", stream: { ...cell.stream, connection: "none" } },
      status: "known",
      pending: null,
    });
    expect(view(stopped, 9500, off).merged.label).toBe("Stopped");
    const done = [...typed(), ev("session.end", 1500, { reason: "done" })];
    expect(view(done, 9500).merged).toMatchObject({ label: "Done", caption: "Done." });
  });

  it("never uses the present tense for an action whose result arrived", () => {
    expect(view(start(), 7200).merged).toMatchObject({
      label: "Typing =SUM(F2:F13)",
      control: true,
      elapsedS: 7,
    });
    expect(view(typed(), 1500).task).toMatchObject({ row: "acting", label: "Typed =SUM(F2:F13)" });
    expect(view(typed(), 9500).task).toMatchObject({ row: "working", label: "Working" });
    const thinking = [...typed(), ev("agent.state", 1100, { state: "thinking" })];
    expect(view(thinking, 9500).task).toMatchObject({ row: "thinking", label: "Thinking…" });
    const unknownVerb = [
      ...typed(),
      ev(
        "action.intent",
        1110,
        { verb: "click", label: "Select the Net total cell", point: { x: 1, y: 1 }, risk: "none" },
        "s2",
      ),
      ev("action.result", 1300, { ok: true }, "s2"),
    ];
    expect(view(unknownVerb, 1400).task.label).toBe("Working");
  });

  it("keeps the frozen computer authoritative over any task verdict", () => {
    const frozen = hudFor({ cell: { ...cell, paused: true }, status: "known", pending: null });
    for (const events of [
      start(),
      [...typed(), ev("session.end", 1500, { reason: "done" })],
      [...typed(), ev("session.end", 1500, { reason: "error" })],
    ]) {
      const merged = view(events, 2000, frozen).merged;
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
      mergeHud({ ...frozen, caption: "The key layer is offline." }, view(start(), 2000).task)
        .caption,
    ).toBe("The key layer is offline.");
    const paused = { ...cell, paused: true as const };
    for (const hud of [
      hudFor({ cell: paused, status: "known", pending: "list" }),
      hudFor({ cell: { ...paused, state: "starting" }, status: "known", pending: null }),
    ]) {
      const merged = view(start(), 1200, hud).merged;
      expect(merged).toMatchObject({ label: "Paused", control: false, live: false });
      expect(merged.stop).toBeUndefined();
    }
  });

  it("gives the computer's own HUD back when there is no task", () => {
    expect(mergeHud(live, null)).toMatchObject({
      label: "Live",
      action: { kind: "stop", enabled: true },
      control: false,
    });
  });
});
