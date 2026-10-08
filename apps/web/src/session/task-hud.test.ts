import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { emptyAgentModel } from "../agent/model.ts";
import { projectAgentEvent } from "../agent/reducer.ts";
import { type HudState, hudFor } from "../cells/hud-state.ts";
import { mergeHud, past, progressive, type TaskFacts, taskFacts, taskHud } from "./task-hud.ts";

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
const pause = (phase: "pausing" | "paused" | "resuming" | "uncertain") => ({
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
const approvalRequest = (tMs: number) =>
  ev("approval.request", tMs, {
    approvalId: ID,
    generation: 1,
    revision: 1,
    expiresAt: 9_999_999_999,
    actionClass: "send",
    risk: "high",
    title: "Send the report",
    kind: "send",
    preview: { fields: [["To", "team@example.test"]] },
  });
// Replay has the timeline only, with no live facts.
const replay = (events: LocalDotEvent[], nowMs: number) =>
  taskHud(foldEvents(emptyModel(), events), nowMs);

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
    const requested = [...start(), approvalRequest(1500)];
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

  it("in Replay, ends a wait once the user settles it or a new step starts", () => {
    const approved = [
      ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux" }),
      ev("agent.state", 1, { state: "acting" }),
      ev("step.start", 10, { kind: "gui" }, "s1"),
      approvalRequest(100),
      ev("agent.state", 101, { state: "waiting_user", reason: "approval" }),
      ev("approval.resolve", 3000, { approvalId: ID, decision: "approve", by: "user" }),
      ev(
        "action.intent",
        3020,
        { verb: "type", label: "Type the report", point: { x: 1, y: 1 }, risk: "high" },
        "s1",
      ),
    ];
    expect(replay(approved, 2000)).toMatchObject({ row: "waiting", control: false });
    expect(replay(approved, 3010)).toMatchObject({ row: "working", control: true });
    expect(replay(approved, 5000)).toMatchObject({ label: "Typing the report", control: true });
    const shell = [
      ...approved.slice(0, 3),
      approvalRequest(100),
      ev("agent.state", 101, { state: "waiting_user", reason: "approval" }),
      ev("step.start", 3000, { kind: "shell" }, "s2"),
    ];
    expect(replay(shell, 2000).row).toBe("waiting");
    expect(replay(shell, 60_000)).toMatchObject({ row: "working", control: true });
    const answered = [
      ...start(),
      ev("ask.request", 100, { askId: ID, question: "Which?", options: [], allowText: true }),
      ev("agent.state", 101, { state: "waiting_user", reason: "question" }),
      ev("ask.answer", 2000, { askId: ID, text: "This one", by: "user" }),
    ];
    expect(replay(answered, 1500).row).toBe("waiting");
    expect(replay(answered, 2500).control).toBe(true);
    const handedBack = [
      ...start(),
      ev("takeover.request", 100, { requestId: ID, reason: "login", note: "Sign in" }),
      ev("agent.state", 101, { state: "waiting_user", reason: "takeover" }),
      ev("takeover.end", 4000, { requestId: ID, by: "user" }),
    ];
    expect(replay(handedBack, 3000).row).toBe("waiting");
    expect(replay(handedBack, 4500).control).toBe(true);
    const resumed = [
      ...start(),
      ev("safety.pause", 300, pause("pausing")),
      ev("agent.state", 300, { state: "paused", reason: "user" }),
      ev("action.result", 400, { ok: true }, "s1"),
      ev("step.end", 410, { status: "ok" }, "s1"),
      ev("safety.pause", 420, pause("paused")),
      ev("safety.pause", 9000, { revision: 2 }),
      ev("step.start", 9100, { kind: "gui" }, "s2"),
    ];
    expect(replay(resumed, 350).label).toBe("Paused");
    expect(replay(resumed, 5000).label).toBe("Paused");
    expect(replay(resumed, 9200)).toMatchObject({ row: "working", control: true });
  });

  it("leaves a recovery pause standing in Replay until a new step starts", () => {
    const budget = [
      ...typed(),
      ev("agent.state", 1500, { state: "paused", reason: "budget" }),
      ev("approval.resolve", 1600, { approvalId: ID, decision: "deny", by: "timeout" }),
      ev("step.start", 9000, { kind: "gui" }, "s2"),
    ];
    expect(replay(budget, 8000)).toMatchObject({ row: "recovery", control: false });
    expect(replay(budget, 9100)).toMatchObject({ row: "working", control: true });
  });

  it("gives a takeover the user's turn and keeps the task's Stop", () => {
    const requested = [
      ...typed(),
      ev("takeover.request", 1500, { requestId: ID, reason: "login", note: "Sign in for me" }),
      ev("agent.state", 1501, { state: "waiting_user", reason: "takeover" }),
    ];
    expect(view(requested, 9500)).toMatchObject({
      task: { row: "takeover", phase: "waiting", label: "Your turn" },
      merged: { caption: "Sign in for me", stop: true, control: false, elapsedS: null },
    });
    const ended = [...requested, ev("takeover.end", 4000, { requestId: ID, by: "user" })];
    expect(view(ended, 4500).task).toMatchObject({ row: "working", control: true });
  });

  it("names the Pause's resuming and unconfirmed phases", () => {
    expect(
      view([...typed(), ev("safety.pause", 1100, pause("resuming"))], 9500).merged,
    ).toMatchObject({ label: "Resuming…", control: false, elapsedS: 9, stop: true });
    expect(view([...typed(), ev("safety.pause", 1100, pause("uncertain"))], 9500)).toMatchObject({
      task: { row: "paused", phase: "waiting", label: "Pause unconfirmed" },
      merged: { stop: true, control: false, elapsedS: null },
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
    const settling = [...typed(), ev("safety.pause", 1100, pause("pausing"))];
    expect(view(settling, 9500).merged).toMatchObject({
      label: "Pausing after this step",
      control: false,
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

  it("tells a held or repeated key in the tense of its moment", () => {
    expect(progressive("Hold Shift for 1.5 s")).toBe("Holding Shift for 1.5 s");
    expect(past("Hold Shift for 1.5 s")).toBe("Held Shift for 1.5 s");
    expect(progressive("Press ] 5 times")).toBe("Pressing ] 5 times");
    expect(past("Press ] 5 times")).toBe("Pressed ] 5 times");
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
