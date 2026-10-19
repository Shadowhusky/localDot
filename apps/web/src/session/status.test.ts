import { type Attention, type LocalDotEvent, msToMicros, sessionMsOf } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { emptyAgentModel } from "../agent/model.ts";
import { projectAgentEvent } from "../agent/reducer.ts";
import { type HudState, hudFor } from "../cells/hud-state.ts";
import type { CellSummary } from "../cells/types.ts";
import type { DotState } from "../dot/engine/states.ts";
import {
  footWork,
  liveState,
  past,
  progressive,
  type Status,
  type StatusRow,
  statusFor,
  type TaskFacts,
  taskFacts,
  taskHud,
  withSending,
} from "./status.ts";

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
// The live status as App derives it: the timeline plus the facts from the same events.
function view(events: LocalDotEvent[], nowMs: number, hud: HudState = live) {
  const task = taskHud(foldEvents(emptyModel(), events), nowMs, facts(events));
  return { task, status: statusFor({ computer: hud, task }) };
}
// The task's own Stop, in place of the computer's controls.
const stopsTask = [{ kind: "stop-task", enabled: true }];
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
// The live HUD at nowMs, from the events that had arrived by then.
const liveAt = (events: LocalDotEvent[], nowMs: number) =>
  view(
    events.filter((e) => sessionMsOf(e) <= nowMs),
    nowMs,
  ).task;

describe("the task HUD tells the task's state before its last action (QA-D6)", () => {
  it("says Done for a finished task in the follow-up window, with no clock and the computer's control", () => {
    const done = [
      ...typed(),
      ev("message.assistant", 1500, { messageId: ID, text: "Report ready" }),
      ev("task.result", 1600, { summary: "done", files: [] }),
      ev("agent.state", 1700, { state: "done" }),
    ];
    const { task, status } = view(done, 9500);
    expect(task).toMatchObject({ row: "done", phase: "finished", label: "Done", control: false });
    expect(status).toMatchObject({
      label: "Done",
      actions: [{ kind: "stop" }],
      control: false,
      elapsedS: null,
    });
    const idle = [...done.slice(0, -1), ev("agent.state", 1700, { state: "idle" })];
    expect(view(idle, 9500).status.label).toBe("Done");
    const noResult = [...typed(), ev("agent.state", 1700, { state: "idle", reason: "gave up" })];
    expect(view(noResult, 9500).task).toMatchObject({ row: "failed", label: "Couldn’t finish" });
  });

  it("shows unfinished work honestly while idle and after retirement, live and in replay", () => {
    const blocked = [
      ...typed(),
      ev("task.result", 1600, {
        outcome: "blocked",
        summary: "The game is unavailable.",
        files: [],
      }),
      ev("agent.state", 1700, { state: "idle", reason: "blocked" }),
    ];
    const unfinished = {
      row: "failed",
      phase: "finished",
      label: "Couldn’t finish",
      control: false,
    };
    expect(view(blocked, 2000).task).toMatchObject(unfinished);
    expect(replay(blocked, 2000)).toMatchObject(unfinished);
    for (const reason of ["stopped", "done"]) {
      const ended = [...blocked, ev("session.end", 3000, { reason })];
      expect(view(ended, 4000).task).toMatchObject(unfinished);
      expect(replay(ended, 4000)).toMatchObject(unfinished);
      expect(replay(ended, 1500).phase).toBe("running");
    }
    // A caller's generic done state cannot override an explicit unsuccessful result.
    const beforeRetirement = [
      ...blocked.slice(0, -1),
      ev("agent.state", 1650, { state: "thinking" }),
      ev("agent.state", 1700, { state: "done" }),
    ];
    expect(view(beforeRetirement, 2000).task).toMatchObject(unfinished);
  });

  it.each(["complete", undefined] as const)(
    "clears a blocked result on resumed work and accepts a later %s completion",
    (outcome) => {
      const blocked = [
        ...typed(),
        ev("task.result", 1600, {
          outcome: "blocked",
          summary: "The game is unavailable.",
          files: [],
        }),
        ev("agent.state", 1700, { state: "idle", reason: "blocked" }),
        ev("message.user", 2100, {
          messageId: `${ID}followup`,
          text: "Try again",
          kind: "followup",
        }),
        ev("agent.state", 2200, { state: "thinking" }),
      ];
      expect(facts(blocked)).toMatchObject({ result: false, outcome: undefined });
      expect(view(blocked, 2300).task).toMatchObject({ row: "thinking", phase: "running" });
      expect(replay(blocked, 2300)).toMatchObject({ row: "thinking", phase: "running" });
      const completed = [
        ...blocked,
        ev("task.result", 2600, {
          ...(outcome ? { outcome } : {}),
          summary: "The game finished.",
          files: [],
        }),
        ev("agent.state", 2700, { state: "done" }),
        ev("session.end", 3000, { reason: "done" }),
      ];
      expect(facts(completed)).toMatchObject({ result: true, outcome: "complete" });
      expect(view(completed, 4000).task).toMatchObject({ row: "done", label: "Done" });
      expect(replay(completed, 4000)).toMatchObject({ row: "done", label: "Done" });
    },
  );

  it("does not reuse an earlier successful result when a follow-up gives up", () => {
    const events = [
      ...typed(),
      ev("task.result", 1600, { summary: "First task finished.", files: [] }),
      ev("agent.state", 1700, { state: "done" }),
      ev("agent.state", 2200, { state: "thinking" }),
      ev("agent.state", 2700, { state: "idle", reason: "gave up" }),
    ];
    expect(view(events, 2800).task).toMatchObject({ row: "failed", label: "Couldn’t finish" });
    expect(
      view([...events, ev("session.end", 3000, { reason: "stopped" })], 4000).task,
    ).toMatchObject({
      row: "stopped",
      label: "Task stopped",
    });
  });

  it("puts a question first, keeps the task's Stop and counts the wait from the question", () => {
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
    const { task, status } = view(asked, 9500);
    expect(task).toMatchObject({ row: "question", label: "Needs your answer", control: true });
    expect(status).toMatchObject({
      caption: { speaker: "dot", text: "Which format?" },
      actions: stopsTask,
      control: true,
      elapsedS: 8,
    });
    const answered = [...asked, ev("ask.answer", 2000, { askId: ID, option: "A", by: "user" })];
    expect(view(answered, 3000).task).toMatchObject({ row: "working", control: true });
  });

  it("puts an approval first, before the daemon's waiting state arrives", () => {
    const requested = [...start(), approvalRequest(1500)];
    expect(view(requested, 9500).status).toMatchObject({
      label: "Needs your OK",
      actions: stopsTask,
      control: true,
      elapsedS: 8,
    });
    expect(view(requested, 3_662_000).status.elapsedS).toBe(3660);
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

  it("says an app's connection waits for the user's OK, then goes back to dot's work", () => {
    const begun = start();
    const card = ev("approval.request", 1500, {
      approvalId: ID,
      generation: 1,
      revision: 1,
      expiresAt: 9_999_999_999,
      actionClass: "network",
      risk: "medium",
      title: "WeChat wants to connect to long.example.com on port 8080",
      kind: "permission",
      preview: { fields: [["App", "WeChat"]] },
    });
    expect(view([...begun, card], 9500).task).toMatchObject({
      row: "approval",
      label: "Needs your OK",
      caption: "Waiting for your OK to connect.",
    });
    const answered = ev("approval.resolve", 1600, {
      approvalId: ID,
      decision: "approve",
      by: "user",
    });
    expect(view([...begun, card, answered], 9500).task.row).not.toBe("approval");
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
    expect(replay(resumed, 350)).toMatchObject({
      label: "Pausing after this step",
      control: true,
    });
    expect(replay(resumed, 415).label).toBe("Paused");
    expect(replay(resumed, 5000).label).toBe("Paused");
    expect(replay(resumed, 9200)).toMatchObject({ row: "working", control: true });
  });

  it("in Replay, reads Pausing after this step until the step a Pause waits on ends, as live does", () => {
    const typing = [
      ...start(),
      ev("safety.pause", 300, pause("pausing")),
      ev("agent.state", 300, { state: "paused", reason: "user" }),
      ev("action.result", 3010, { ok: true }, "s1"),
      ev("step.end", 3020, { status: "ok" }, "s1"),
      ev("safety.pause", 3030, pause("paused")),
    ];
    expect(replay(typing, 2000)).toMatchObject({
      row: "pausing",
      phase: "running",
      label: "Pausing after this step",
      control: true,
    });
    expect(replay(typing, 3020)).toMatchObject({ label: "Paused", phase: "waiting" });
    const shell = [
      ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux" }),
      ev("agent.state", 1, { state: "acting" }),
      ev("step.start", 10, { kind: "shell" }, "s1"),
      ev("tool.start", 20, { tool: "shell", title: "npm test" }, "s1"),
      ev("safety.pause", 300, pause("pausing")),
      ev("agent.state", 300, { state: "paused", reason: "user" }),
      ev("tool.end", 90_000, { ok: true, exitCode: 0 }, "s1"),
      ev("step.end", 90_010, { status: "ok" }, "s1"),
      ev("safety.pause", 90_020, pause("paused")),
    ];
    expect(replay(shell, 60_000)).toMatchObject({
      label: "Pausing after this step",
      control: false,
      elapsedS: 60,
    });
    // A step whose end never reached the log (a takeover cut it short) is pausing only until the
    // Pause next changes.
    const cut = [
      ...start(),
      ev("action.cancel", 100, { reason: "user" }, "s1"),
      ev("takeover.request", 100, { requestId: ID, reason: "login", note: "Sign in" }),
      ev("agent.state", 101, { state: "waiting_user", reason: "takeover" }),
      ev("takeover.end", 4000, { requestId: ID, by: "user" }),
      ev("safety.pause", 5000, pause("pausing")),
      ev("agent.state", 5000, { state: "paused", reason: "user" }),
      ev("safety.pause", 5010, pause("paused")),
    ];
    expect(replay(cut, 5005).label).toBe("Pausing after this step");
    expect(replay(cut, 6000)).toMatchObject({ label: "Paused", phase: "waiting" });
    // A held Pause's paused state is published again, so a later one cannot reopen the pausing.
    const republished = [
      ...cut,
      ev("agent.state", 5100, { state: "paused", reason: "Waiting for explicit Resume" }),
    ];
    for (const at of [6000, 60_000])
      expect(replay(republished, at)).toMatchObject({
        label: "Paused",
        phase: "waiting",
        control: false,
      });
    const retired = [
      ...start(),
      ev("agent.state", 3000, { state: "thinking" }),
      ev("safety.pause", 5000, pause("pausing")),
      ev("agent.state", 5000, { state: "paused", reason: "user" }),
      ev("safety.pause", 5010, pause("paused")),
      ev("agent.state", 5100, { state: "paused", reason: "Waiting for explicit Resume" }),
    ];
    expect(replay(retired, 5005)).toMatchObject({
      label: "Pausing after this step",
      control: true,
    });
    expect(replay(retired, 6000)).toMatchObject({ label: "Paused", control: false });
    const unconfirmed = [
      ...start(),
      ev("safety.pause", 300, pause("pausing")),
      ev("agent.state", 300, { state: "paused", reason: "user" }),
      ev("safety.pause", 1000, pause("uncertain")),
      ev("agent.state", 1001, { state: "paused", reason: "keyd unavailable" }),
    ];
    expect(replay(unconfirmed, 500).label).toBe("Pausing after this step");
    // Replay has no Pause phase, so an unconfirmed Pause reads as the pause that followed it; it
    // waits all the same.
    for (const at of [2000, 60_000]) {
      const { phase, control } = liveAt(unconfirmed, at);
      expect(replay(unconfirmed, at)).toMatchObject({ label: "Keys are offline", phase, control });
    }
    // A recovery pause is no Pause request, even over a cut step or after an earlier Pause.
    const recovery = [
      ...cut.slice(0, 8),
      ev("agent.state", 5000, { state: "paused", reason: "keyd unavailable" }),
    ];
    expect(replay(recovery, 6000)).toMatchObject({ label: "Keys are offline", phase: "waiting" });
    const reentry = [
      ...cut.slice(0, 8),
      ev("agent.state", 5000, { state: "paused", reason: "key needs re-entering", detail: "x" }),
    ];
    expect(replay(reentry, 6000)).toMatchObject({
      label: "A key needs re-entering",
      phase: "waiting",
    });
    const afterPause = [
      ...typed(),
      ev("safety.pause", 1100, pause("pausing")),
      ev("agent.state", 1100, { state: "paused", reason: "user" }),
      ev("safety.pause", 1110, pause("paused")),
      ev("safety.pause", 2000, { revision: 2 }),
      ev("step.start", 2100, { kind: "gui" }, "s2"),
      ev("agent.state", 5000, { state: "paused", reason: "keyd unavailable" }),
    ];
    expect(replay(afterPause, 6000).label).toBe("Keys are offline");
    const secondPause = [
      ...afterPause.slice(0, -1),
      ev(
        "action.intent",
        2200,
        { verb: "click", label: "Click Save", point: { x: 1, y: 1 }, risk: "none" },
        "s2",
      ),
      ev("safety.pause", 3000, pause("pausing")),
      ev("agent.state", 3000, { state: "paused", reason: "user" }),
    ];
    expect(replay(secondPause, 4000)).toMatchObject({
      label: "Pausing after this step",
      control: true,
    });
    // A Pause asked for while a recovery holds the task publishes no state, and no step runs on.
    const heldThenPaused = [
      ...recovery,
      ev("safety.pause", 7000, pause("pausing")),
      ev("safety.pause", 7010, pause("paused")),
    ];
    expect(replay(heldThenPaused, 7005)).toMatchObject({ label: "Paused", phase: "waiting" });
    for (const [events, at] of [
      [typing, 2000],
      [typing, 4000],
      [shell, 60_000],
      [shell, 95_000],
      [cut, 5005],
      [cut, 6000],
      [republished, 6000],
      [republished, 60_000],
      [retired, 5005],
      [retired, 6000],
      [retired, 60_000],
      [unconfirmed, 500],
      [recovery, 6000],
      [afterPause, 6000],
      [secondPause, 4000],
      [heldThenPaused, 8000],
    ] as const) {
      const { label, phase, control } = liveAt(events, at);
      expect(replay(events, at)).toMatchObject({ label, phase, control });
    }
  });

  it("leaves a recovery pause standing in Replay until a new step starts", () => {
    const budget = [
      ...typed(),
      ev("agent.state", 1500, { state: "paused", reason: "budget" }),
      ev("approval.resolve", 1600, { approvalId: ID, decision: "deny", by: "timeout" }),
      ev("step.start", 9000, { kind: "gui" }, "s2"),
    ];
    expect(replay(budget, 8000)).toMatchObject({
      row: "limit",
      label: "Spending limit reached",
      control: false,
    });
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
      status: {
        caption: { speaker: "dot", text: "Sign in for me" },
        actions: stopsTask,
        control: false,
        elapsedS: 8,
      },
    });
    const ended = [...requested, ev("takeover.end", 4000, { requestId: ID, by: "user" })];
    expect(view(ended, 4500).task).toMatchObject({ row: "working", control: true });
  });

  it("puts the user in control of a computer they took, or took from dot's hand-over", () => {
    const took = [
      ...typed(),
      ev("takeover.request", 1500, { requestId: ID, reason: "other", note: "", by: "user" }),
      ev("agent.state", 1501, { state: "waiting_user", reason: "takeover" }),
    ];
    expect(view(took, 9500)).toMatchObject({
      task: { row: "control", phase: "waiting", label: "You're in control" },
      status: {
        caption: { speaker: "dot", text: "I'll wait here until you hand back." },
        actions: stopsTask,
        control: false,
        attention: null,
        dotPose: "your-turn",
        elapsedS: 8,
      },
    });
    const handed = [
      ...typed(),
      ev("takeover.request", 1500, { requestId: ID, reason: "login", note: "Sign in for me" }),
    ];
    expect(view(handed, 9500).task).toMatchObject({ row: "takeover", label: "Your turn" });
    const taken = [
      ...handed,
      ev("control.change", 2000, { holder: "user", reason: "handoff_request" }),
    ];
    expect(view(taken, 9500).task).toMatchObject({
      row: "control",
      caption: "Your turn. I'll wait here and pick up after you sign in.",
    });
    const back = [...took, ev("takeover.end", 4000, { requestId: ID, by: "user" })];
    expect(view(back, 4500).task).toMatchObject({ row: "working", control: true });
  });

  it("leaves the thread's foot quiet while the user has the computer, even from a finished task", () => {
    const finished = [...typed(), ev("agent.state", 1100, { state: "done" })];
    const took = [
      ...finished,
      ev("takeover.request", 1500, { requestId: ID, reason: "other", note: "", by: "user" }),
    ];
    expect(view(took, 9500).task?.row).toBe("control");
    expect(footWork(view(took, 9500).task)).toBeNull();
    expect(footWork(view(typed(), 900).task)).toMatchObject({ row: "acting" });
  });

  it("names the Pause's resuming and unconfirmed phases", () => {
    expect(
      view([...typed(), ev("safety.pause", 1100, pause("resuming"))], 9500).status,
    ).toMatchObject({ label: "Resuming…", control: false, elapsedS: 9, actions: stopsTask });
    expect(view([...typed(), ev("safety.pause", 1100, pause("uncertain"))], 9500)).toMatchObject({
      task: { row: "paused", phase: "waiting", label: "Pause not confirmed" },
      status: { actions: stopsTask, control: false, elapsedS: null },
    });
  });

  it("keeps a live wait while its control is pending, and ends it once that control settles", () => {
    const stateOf = (events: LocalDotEvent[]) =>
      liveState(events.reduce(projectAgentEvent, emptyAgentModel()));
    const approval = [
      ...typed(),
      approvalRequest(1500),
      ev("agent.state", 1501, { state: "waiting_user", reason: "approval" }),
    ];
    const question = [
      ...typed(),
      ev("ask.request", 1500, { askId: ID, question: "Which?", options: [], allowText: true }),
      ev("agent.state", 1501, { state: "waiting_user", reason: "question" }),
    ];
    const takeover = [
      ...typed(),
      ev("takeover.request", 1500, { requestId: ID, reason: "login", note: "Sign in" }),
      ev("agent.state", 1501, { state: "waiting_user", reason: "takeover" }),
    ];
    const paused = [
      ...typed(),
      ev("safety.pause", 1500, pause("pausing")),
      ev("agent.state", 1500, { state: "paused", reason: "user" }),
    ];
    for (const [pending, state, settle] of [
      [
        approval,
        "waiting_user",
        ev("approval.resolve", 2000, { approvalId: ID, decision: "approve", by: "user" }),
      ],
      [question, "waiting_user", ev("ask.answer", 2000, { askId: ID, text: "This", by: "user" })],
      [takeover, "waiting_user", ev("takeover.end", 2000, { requestId: ID, by: "user" })],
      [paused, "paused", ev("safety.pause", 2000, { revision: 2 })],
    ] as const) {
      expect(stateOf(pending)).toBe(state);
      expect(stateOf([...pending, settle])).toBe("acting");
    }
  });

  it("names a budget pause and shows no clock", () => {
    const budget = [...typed(), ev("agent.state", 1500, { state: "paused", reason: "budget" })];
    const { task, status } = view(budget, 9500);
    expect(task).toMatchObject({
      row: "limit",
      phase: "waiting",
      label: "Spending limit reached",
    });
    expect(status).toMatchObject({
      actions: stopsTask,
      control: false,
      elapsedS: null,
      attention: "needs_you",
    });
    const keyLayer = [
      ...typed(),
      ev("agent.state", 1500, { state: "paused", reason: "keyd unavailable" }),
    ];
    expect(view(keyLayer, 9500).task.label).toBe("Keys are offline");
  });

  describe("never silent: every stall has its own status", () => {
    const retry = (tMs: number, waitMs: number, status?: number) =>
      ev("model.retry", tMs, {
        role: "main",
        attempt: 3,
        waitMs,
        ...(status ? { status } : {}),
        message: "overloaded",
      });
    it("counts down to a busy model's next try, then says it is retrying", () => {
      const busy = [
        ...typed(),
        retry(2000, 20_000, 529),
        ev("agent.state", 2001, { state: "paused", reason: "model busy" }),
      ];
      expect(view(busy, 2500)).toMatchObject({
        task: { row: "retrying", phase: "running", label: "Model busy · retrying", countdownS: 20 },
        status: { label: "Model busy · retrying", countdownS: 20, elapsedS: null },
      });
      expect(view(busy, 21_100).task.countdownS).toBe(1);
      expect(view(busy, 22_100).task).toMatchObject({ label: "Retrying…", countdownS: null });
      expect(
        view([...busy, ev("agent.state", 22_200, { state: "thinking" })], 22_300).task,
      ).toMatchObject({
        row: "thinking",
        countdownS: null,
      });
    });
    it("says when the model can't be reached, and waits out even a short retry out loud", () => {
      const lost = [...typed(), retry(2000, 4000)];
      expect(view(lost, 2000).task).toMatchObject({
        label: "Can't reach the model · retrying",
        countdownS: 4,
      });
      expect(view([...lost, ev("agent.state", 6000, { state: "thinking" })], 6100).task.row).toBe(
        "thinking",
      );
    });
    it.each([
      ["model refused", "Provider request failed", "recovery"],
      ["model unavailable", "Model not answering", "recovery"],
      ["keyd unavailable", "Keys are offline", "recovery"],
      ["budget", "Spending limit reached", "limit"],
    ])("names a pause for %s", (reason, label, row) => {
      const stalled = [
        ...typed(),
        ev("agent.state", 1500, { state: "paused", reason, detail: "400: bad image" }),
      ];
      expect(view(stalled, 9500).task).toMatchObject({ row, label, phase: "waiting" });
    });
    it("says the user's action limit stopped the task, and that it waits for them", () => {
      const limit = [
        ...typed(),
        ev("agent.state", 1500, { state: "idle", reason: "action limit" }),
      ];
      expect(view(limit, 9500)).toMatchObject({
        task: { row: "limit", phase: "waiting", label: "Reached your action limit" },
        status: { attention: "needs_you", actions: stopsTask },
      });
    });
    it("says dot is starting again after its process stopped", () => {
      const restart = [
        ...typed(),
        ev("agent.state", 1500, {
          state: "error",
          reason: "the brain stopped; restarting from saved history",
        }),
      ];
      expect(view(restart, 9500).task).toMatchObject({
        row: "working",
        phase: "running",
        label: "Starting again…",
      });
    });
  });

  it("follows a user Pause from pausing to paused, then back to work after Resume", () => {
    const pausing = [...start(), ev("safety.pause", 300, pause("pausing"))];
    expect(view(pausing, 9500).status).toMatchObject({
      label: "Pausing after this step",
      control: true,
      elapsedS: 9,
      actions: stopsTask,
    });
    const settling = [...typed(), ev("safety.pause", 1100, pause("pausing"))];
    expect(view(settling, 9500).status).toMatchObject({
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
      status: { label: "Paused", actions: stopsTask, control: false, elapsedS: null },
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
    const { task, status } = view(stopped, 9500);
    expect(task).toMatchObject({ row: "stopped", label: "Task stopped", control: false });
    expect(status).toMatchObject({
      label: "Task stopped",
      computer: "live",
      actions: [{ kind: "stop", enabled: true }],
      control: false,
    });
    const frozen = hudFor({ cell: { ...cell, paused: true }, status: "known", pending: null });
    expect(view(stopped, 9500, frozen).status).toMatchObject({ label: "Paused", control: false });
    const off = hudFor({
      cell: { ...cell, state: "stopped", stream: { ...cell.stream, connection: "none" } },
      status: "known",
      pending: null,
    });
    expect(view(stopped, 9500, off).status.label).toBe("Stopped");
    const done = [...typed(), ev("session.end", 1500, { reason: "done" })];
    expect(view(done, 9500).status).toMatchObject({
      label: "Done",
      caption: { speaker: "system", text: "Done." },
    });
  });

  it("never uses the present tense for an action whose result arrived", () => {
    expect(view(start(), 7200).status).toMatchObject({
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
    expect(progressive('Drag "report.txt" to "Trash"')).toBe('Dragging "report.txt" to "Trash"');
    expect(past('Drag "report.txt" to "Trash"')).toBe('Dragged "report.txt" to "Trash"');
    expect(progressive("Move to (40, 60)")).toBe("Moving to (40, 60)");
    expect(past("Move to (40, 60)")).toBe("Moved to (40, 60)");
    expect(progressive("Hold down the left button at (7, 8)")).toBe(
      "Holding down the left button at (7, 8)",
    );
    expect(past("Hold down the left button at (7, 8)")).toBe("Held down the left button at (7, 8)");
    expect(progressive("Release the left button at (7, 8)")).toBe(
      "Releasing the left button at (7, 8)",
    );
    expect(past("Release the left button at (7, 8)")).toBe("Released the left button at (7, 8)");
  });

  it("in Replay, keeps an action in flight until the time of its result", () => {
    expect(replay(typed(), 700)).toMatchObject({
      row: "acting",
      label: "Typing =SUM(F2:F13)",
      control: true,
    });
    expect(replay(typed(), 1010).label).toBe("Typed =SUM(F2:F13)");
    expect(replay(typed(), 1500).label).toBe("Typed =SUM(F2:F13)");
    const cancelled = [...start(), ev("action.cancel", 900, { reason: "user" }, "s1")];
    expect(replay(cancelled, 700).label).toBe("Typing =SUM(F2:F13)");
    expect(replay(cancelled, 1000).label).toBe("Working");
  });

  it("keeps the frozen computer authoritative over any task verdict", () => {
    const frozen = hudFor({ cell: { ...cell, paused: true }, status: "known", pending: null });
    for (const events of [
      start(),
      [...typed(), ev("session.end", 1500, { reason: "done" })],
      [...typed(), ev("session.end", 1500, { reason: "error" })],
    ]) {
      expect(view(events, 2000, frozen).status).toMatchObject({
        label: "Paused",
        computer: "frozen",
        caption: { speaker: "system", text: frozen.caption },
        control: false,
        actions: [{ kind: "resume" }, { kind: "stop" }],
      });
    }
    expect(
      statusFor({
        computer: { ...frozen, caption: "The key layer is offline." },
        task: view(start(), 2000).task,
      }).caption.text,
    ).toBe("The key layer is offline.");
    const paused = { ...cell, paused: true as const };
    for (const hud of [
      hudFor({ cell: paused, status: "known", pending: "list" }),
      hudFor({ cell: { ...paused, state: "starting" }, status: "known", pending: null }),
    ]) {
      const { status } = view(start(), 1200, hud);
      expect(status).toMatchObject({ label: "Paused", computer: "frozen", control: false });
      expect(status.actions.map((action) => action.kind)).not.toContain("stop-task");
    }
  });

  it("gives the computer's own HUD back when there is no task", () => {
    expect(statusFor({ computer: live, task: null })).toMatchObject({
      row: "ready",
      label: "Ready",
      actions: [{ kind: "stop", enabled: true }],
      control: false,
    });
  });
});

const computerIn = (summary: Partial<CellSummary>) =>
  hudFor({ cell: { ...cell, ...summary }, status: "known", pending: null });
const noCell = (status: "listing" | "known" | "unknown") =>
  hudFor({ cell: null, status, pending: status === "listing" ? "list" : null });
const stream = (connection: "connecting" | "stalled" | "none") =>
  computerIn({ stream: { ...cell.stream, connection } });
const RESTART_NOTE = "desktop container exited with 137; restarting (attempt 2 of 5)";
const asked = (tMs: number) =>
  ev("ask.request", tMs, { askId: ID, question: "Which format?", options: [], allowText: true });
const takeoverRequest = (tMs: number) =>
  ev("takeover.request", tMs, { requestId: ID, reason: "login", note: "Sign in for me" });
const paused = [
  ...typed(),
  ev("safety.pause", 1100, pause("pausing")),
  ev("agent.state", 1100, { state: "paused", reason: "user" }),
  ev("safety.pause", 1200, pause("paused")),
];
const budget = [...typed(), ev("agent.state", 1500, { state: "paused", reason: "budget" })];
const ended = (reason: string) => [...typed(), ev("session.end", 1500, { reason })];
const at = (events: LocalDotEvent[], nowMs = 9500, computer: HudState = live) =>
  view(events, nowMs, computer).status;
const alone = (computer: HudState) => statusFor({ computer, task: null });
const typing = () => view(start(), 2000).task;
// dot mid-action on a computer in the given state.
const underTask = (computer: HudState) => at(start(), 2000, computer);
const FAILED = { state: "failed", error: "not ready after 120 s" } as const;
const FENCED = { fenced: { revision: 1 } } as const;

// One fixture per state the status model knows.
const STATES: Record<string, Status> = {
  checking: alone(noCell("listing")),
  "no computer": alone(noCell("known")),
  "list failed": alone(noCell("unknown")),
  starting: alone(computerIn({ state: "starting" })),
  restarting: alone(computerIn({ state: "starting", error: RESTART_NOTE })),
  connecting: alone(stream("connecting")),
  reconnecting: alone(stream("stalled")),
  frozen: at(start(), 2000, computerIn({ paused: true })),
  "shutting down": alone(computerIn({ state: "stopping" })),
  off: alone(computerIn({ state: "stopped" })),
  "off after a task": at(ended("done"), 9500, computerIn({ state: "stopped", ...stream("none") })),
  "failed to start": alone(computerIn(FAILED)),
  fenced: alone(computerIn(FENCED)),
  "no computer, task open": underTask(noCell("known")),
  "list failed, task open": underTask(noCell("unknown")),
  "starting, task open": underTask(computerIn({ state: "starting" })),
  "restarting, task open": underTask(computerIn({ state: "starting", error: RESTART_NOTE })),
  "shutting down, task open": underTask(computerIn({ state: "stopping" })),
  "off, task open": underTask(computerIn({ state: "stopped" })),
  "failed, task open": underTask(computerIn(FAILED)),
  "fenced, task open": underTask(computerIn(FENCED)),
  "reconnecting, task running": underTask(stream("stalled")),
  "approval, reconnecting": at([...start(), approvalRequest(1500)], 9500, stream("stalled")),
  "question, reconnecting": at([...typed(), asked(1500)], 9500, stream("stalled")),
  "task stopping": statusFor({ computer: live, task: typing(), stop: "stopping" }),
  "stop unconfirmed": statusFor({ computer: live, task: typing(), stop: "unconfirmed" }),
  "out of touch": statusFor({ computer: live, task: typing(), link: "lost" }),
  "frozen by Stop": statusFor({
    computer: computerIn({ paused: true }),
    task: null,
    stop: "stopped",
  }),
  approval: at([...start(), approvalRequest(1500)]),
  question: at([...typed(), asked(1500)]),
  takeover: at([...typed(), takeoverRequest(1500)]),
  "waiting in Replay": statusFor({
    computer: live,
    task: replay(
      [
        ...start(),
        approvalRequest(1500),
        ev("agent.state", 1501, { state: "waiting_user", reason: "approval" }),
      ],
      9500,
    ),
  }),
  pausing: at([...start(), ev("safety.pause", 300, pause("pausing"))]),
  paused: at(paused, 18_500),
  "pause unconfirmed": at([...typed(), ev("safety.pause", 1100, pause("uncertain"))]),
  resuming: at([...typed(), ev("safety.pause", 1100, pause("resuming"))]),
  "spending limit": at(budget),
  "needs attention": at([...typed(), ev("agent.state", 1500, { state: "error" })]),
  acting: at(start(), 7200),
  "just acted": at(typed(), 1500),
  thinking: at([...typed(), ev("agent.state", 1100, { state: "thinking" })]),
  observing: at([...typed(), ev("agent.state", 1100, { state: "observing" })]),
  working: at(typed()),
  done: at(ended("done")),
  stopped: at(ended("stopped")),
  interrupted: statusFor({
    computer: live,
    task: taskHud(
      { ...foldEvents(emptyModel(), typed()), ended: { t: 1500, reason: "interrupted" } },
      9500,
    ),
  }),
  failed: at(ended("error")),
  "ready for more": at([...typed(), ev("agent.state", 1700, { state: "idle" })]),
  ready: alone(live),
};

// The audit's status table, first match wins from the top, behind a task Stop in flight: the HUD
// label, dot's pose, the attention and who speaks the caption for every state.
const TABLE: [string, StatusRow, string, DotState, Attention | null, "dot" | "system"][] = [
  // A task Stop outranks every row.
  ["task stopping", "stopping", "Stopping…", "resting", "working", "dot"],
  ["stop unconfirmed", "stopping", "Stop not confirmed", "error", "blocked", "dot"],
  // A Stop that paused the computer names what happened, and leaves the computer's own controls.
  ["frozen by Stop", "computer", "Stopped", "resting", null, "system"],
  // A running task whose feed has been out of touch for a moment keeps its row and says so.
  ["out of touch", "acting", "Reconnecting…", "reconnecting", "working", "dot"],
  // 1. The computer is not live, or nothing runs on it. A computer that is off, failing or not
  // up yet holds the row over an open task; a late picture or a list check does not.
  ["checking", "computer", "Checking…", "waking", null, "system"],
  ["no computer", "computer", "No computer", "sleeping", null, "system"],
  ["list failed", "computer", "Unavailable", "error", "blocked", "system"],
  ["starting", "computer", "Starting…", "waking", null, "system"],
  ["restarting", "computer", "Reconnecting…", "waking", null, "system"],
  ["connecting", "computer", "Connecting…", "waking", null, "system"],
  ["reconnecting", "computer", "Reconnecting…", "reconnecting", null, "system"],
  ["frozen", "computer", "Paused", "resting", null, "system"],
  ["shutting down", "computer", "Stopping…", "sleeping", null, "system"],
  ["off", "computer", "Stopped", "sleeping", null, "system"],
  ["off after a task", "computer", "Stopped", "sleeping", null, "system"],
  ["failed to start", "computer", "Failed", "error", "blocked", "system"],
  ["fenced", "computer", "Unavailable", "error", "blocked", "system"],
  ["no computer, task open", "computer", "No computer", "sleeping", null, "system"],
  ["list failed, task open", "computer", "Unavailable", "error", "blocked", "system"],
  ["starting, task open", "computer", "Starting…", "waking", null, "system"],
  ["restarting, task open", "computer", "Reconnecting…", "waking", null, "system"],
  ["shutting down, task open", "computer", "Stopping…", "sleeping", null, "system"],
  ["off, task open", "computer", "Stopped", "sleeping", null, "system"],
  ["failed, task open", "computer", "Failed", "error", "blocked", "system"],
  ["fenced, task open", "computer", "Unavailable", "error", "blocked", "system"],
  // A reconnect leaves dot in charge, but the label says why the picture holds still.
  ["reconnecting, task running", "acting", "Reconnecting…", "acting", "working", "dot"],
  // What waits on the user keeps its label through a reconnect.
  ["approval, reconnecting", "approval", "Needs your OK", "waiting", "needs_you", "system"],
  ["question, reconnecting", "question", "Needs your answer", "waiting", "needs_you", "dot"],
  // 2–4. Approval, question, takeover.
  ["approval", "approval", "Needs your OK", "waiting", "needs_you", "system"],
  ["question", "question", "Needs your answer", "waiting", "needs_you", "dot"],
  ["takeover", "takeover", "Your turn", "your-turn", "needs_you", "dot"],
  ["waiting in Replay", "waiting", "Waiting for you", "waiting", "needs_you", "system"],
  // 5. The user's Pause.
  ["pausing", "pausing", "Pausing after this step", "thinking", "working", "system"],
  ["paused", "paused", "Paused", "resting", null, "system"],
  ["pause unconfirmed", "paused", "Pause not confirmed", "resting", null, "system"],
  ["resuming", "resuming", "Resuming…", "thinking", "working", "system"],
  // 6. Budget or plan recovery.
  ["spending limit", "limit", "Spending limit reached", "waiting", "needs_you", "dot"],
  ["needs attention", "recovery", "Needs attention", "resting", "blocked", "dot"],
  // 7–9. dot at work.
  ["acting", "acting", "Typing =SUM(F2:F13)", "acting", "working", "dot"],
  ["just acted", "acting", "Typed =SUM(F2:F13)", "acting", "working", "dot"],
  ["thinking", "thinking", "Thinking…", "thinking", "working", "dot"],
  ["observing", "observing", "Checking the screen", "observing", "working", "dot"],
  ["working", "working", "Working", "acting", "working", "dot"],
  // 10–11. The task is over, or there is none.
  ["done", "done", "Done", "idle", "done", "system"],
  ["stopped", "stopped", "Task stopped", "idle", null, "system"],
  // A task localDot went away under: dot says so and offers to carry on.
  ["interrupted", "interrupted", "Task interrupted", "idle", null, "dot"],
  ["failed", "failed", "Task failed", "error", "blocked", "system"],
  ["ready for more", "ready", "Ready", "idle", null, "system"],
  ["ready", "ready", "Ready", "idle", null, "system"],
];

describe("one status model for every surface (T10)", () => {
  it.each(TABLE)("%s", (name, row, label, dotPose, attention, speaker) => {
    const status = STATES[name] as Status;
    expect(status).toMatchObject({
      row,
      label,
      dotPose,
      attention,
      caption: { speaker },
      title: `localDot — ${label}`,
    });
    expect(status.actions.length).toBeGreaterThan(0);
  });

  it("has a row in the table for every fixture, and every row and phase the model gives", () => {
    expect(TABLE.map(([name]) => name).sort()).toEqual(Object.keys(STATES).sort());
    const rows = new Set(Object.values(STATES).map((status) => status.row));
    expect(rows.size).toBe(20);
    const phases = new Set(Object.values(STATES).map((status) => status.computer));
    expect(phases.size).toBe(12);
  });

  it("never names an action in the present tense once it has ended", () => {
    for (const [name, status] of Object.entries(STATES))
      if (name !== "acting")
        expect(status.label, name).not.toMatch(/^(Clicking|Typing|Pressing|Scrolling|Opening)\b/);
  });

  it("ranks the rows: Stop, a computer that can't carry the task, the verdict, then what waits for the user", () => {
    const frozen = computerIn({ paused: true });
    const pairs: [string, Status, StatusRow][] = [
      [
        "Stop over a frozen computer",
        statusFor({ computer: frozen, task: null, stop: "stopping" }),
        "stopping",
      ],
      [
        "Stop over a failed computer",
        statusFor({ computer: computerIn(FAILED), task: typing(), stop: "stopping" }),
        "stopping",
      ],
      [
        "a frozen computer over an approval",
        at([...start(), approvalRequest(1500)], 9500, frozen),
        "computer",
      ],
      [
        "an unavailable computer over an approval",
        at([...start(), approvalRequest(1500)], 9500, computerIn(FENCED)),
        "computer",
      ],
      [
        "a computer that is off over a running task",
        underTask(computerIn({ state: "stopped" })),
        "computer",
      ],
      [
        "a verdict over an approval",
        at([...start(), approvalRequest(1500), ev("session.end", 1600, { reason: "done" })]),
        "done",
      ],
      [
        "an approval over a question",
        at([...typed(), approvalRequest(1500), asked(1500)]),
        "approval",
      ],
      [
        "a question over a takeover",
        at([...typed(), asked(1500), takeoverRequest(1500)]),
        "question",
      ],
      ["a takeover over a Pause", at([...paused, takeoverRequest(1300)]), "takeover"],
      [
        "a Pause over the spending limit",
        at([...budget, ev("safety.pause", 1600, pause("paused"))]),
        "paused",
      ],
      [
        "the spending limit over an action in flight",
        at([...start(), ev("agent.state", 100, { state: "paused", reason: "budget" })], 500),
        "limit",
      ],
      [
        "an action in flight over thinking",
        at([...start(), ev("agent.state", 100, { state: "thinking" })], 500),
        "acting",
      ],
      // The computer is up and dot works on it, whatever the picture does.
      ["the task over a stalled picture", at(start(), 500, stream("stalled")), "acting"],
      [
        "the task over a picture still connecting",
        at(start(), 500, stream("connecting")),
        "acting",
      ],
      [
        "the task over a list check",
        at(start(), 500, hudFor({ cell, status: "known", pending: "list" })),
        "acting",
      ],
    ];
    for (const [name, status, row] of pairs) expect(status.row, name).toBe(row);
  });

  it("lets a computer that can't carry the task speak for it, with no clock and no control", () => {
    const fenced = computerIn(FENCED);
    expect(at(start(), 7200, fenced)).toMatchObject({
      caption: { speaker: "system", text: fenced.caption },
      elapsedS: null,
      control: false,
    });
    expect(at(start(), 7200, stream("stalled"))).toMatchObject({ elapsedS: 7, control: true });
  });

  it("gives dot control only while it works or waits on the user's word, and the app allows it", () => {
    expect(statusFor({ computer: live, task: typing(), mayControl: false }).control).toBe(false);
    const working = [
      "acting",
      "just acted",
      "thinking",
      "observing",
      "working",
      "pausing",
      "approval",
      "question",
      "out of touch",
      "reconnecting, task running",
      "approval, reconnecting",
      "question, reconnecting",
    ];
    const stopping = ["task stopping", "stop unconfirmed"];
    for (const [name, status] of Object.entries(STATES))
      expect(status.control, name).toBe([...working, ...stopping].includes(name));
  });

  it("offers the task's Stop while it runs, and the computer's own controls otherwise", () => {
    expect(statusFor({ computer: live, task: typing(), canStop: false }).actions).toEqual([
      { kind: "stop-task", enabled: false },
    ]);
    expect(STATES["task stopping"]?.actions).toEqual([
      { kind: "stop-task", enabled: false, busy: true },
    ]);
    expect(statusFor({ computer: live, task: null, stop: "unconfirmed" }).actions).toEqual(
      stopsTask,
    );
    const frozen = computerIn({ paused: true });
    const held = { ...frozen, action: { kind: "resume" as const, enabled: false } };
    expect(statusFor({ computer: held, task: typing() }).actions).toEqual([
      { kind: "resume", enabled: false },
      { kind: "stop", enabled: false },
    ]);
    expect(STATES["frozen by Stop"]?.actions.map((action) => action.kind)).toEqual([
      "resume",
      "stop",
    ]);
    expect(STATES.off?.actions).toEqual([{ kind: "start", enabled: true }]);
    // The task keeps its Stop on a computer that can't carry it. With no computer, that Stop is
    // the only control, so Welcome's Turn on waits until the task ends.
    for (const [name, status] of Object.entries(STATES))
      if (name.endsWith(", task open")) expect(status.actions, name).toEqual(stopsTask);
    expect(STATES.done?.actions).toEqual([{ kind: "stop", enabled: true }]);
  });
});

it("says nothing about a lost link once the task is over", () => {
  expect(statusFor({ computer: live, task: null, link: "lost" }).label).toBe("Ready");
});

it("keeps task status when only its viewer is suspended, but still reports a lost task feed", () => {
  const computer = hudFor({ cell, status: "known", pending: null, picture: "suspended" });
  for (const task of [
    null,
    typing(),
    view([...typed(), asked(1500)], 9500).task,
    view([...start(), approvalRequest(1500)], 9500).task,
    view([...typed(), ev("task.result", 1500, { summary: "Done", files: [] })], 9500).task,
  ]) {
    const expected = statusFor({ computer: live, task, mayControl: false });
    const hidden = statusFor({ computer, task, mayControl: false });
    expect(hidden.title).toBe(expected.title);
    expect(hidden.attention).toBe(expected.attention);
    expect(hidden.control).toBe(false);
  }
  expect(statusFor({ computer, task: typing(), link: "lost" })).toMatchObject({
    label: "Reconnecting…",
    title: "localDot — Reconnecting…",
  });
});

it("never leaves an interrupted task silent: dot says so and asks to carry on", () => {
  const status = STATES.interrupted as Status;
  expect(status.caption).toEqual({
    speaker: "dot",
    text: "I was cut off before I finished. Shall I continue?",
  });
  expect(status.actions).toEqual([{ kind: "stop", enabled: true }]);
});

it("says dot is starting until its first action, even in a Replay that holds them all", () => {
  const model = foldEvents(emptyModel(), typed());
  expect(taskHud(model, 5)).toMatchObject({ row: "working", caption: "Starting…" });
  expect(taskHud(model, 5000)).toMatchObject({ row: "working", caption: "Working…" });
});

describe("a message just sent", () => {
  const ready = statusFor({ computer: live, task: null });
  it("shows dot thinking at once while the computer is otherwise ready", () => {
    const shown = withSending(ready, true);
    expect(shown.label).toBe("Thinking…");
    expect(shown.dotPose).toBe("thinking");
    expect(shown.row).toBe("thinking");
  });
  it("leaves every other state alone", () => {
    expect(withSending(ready, false)).toBe(ready);
    const asking = { ...ready, row: "question" as const, label: "Needs your answer" };
    expect(withSending(asking, true)).toBe(asking);
  });
});

it("shows active tool intent even when the provider still reports thinking, then clears it at completion", () => {
  const model = foldEvents(emptyModel(), [
    ev("session.start", 0, { screen: { w: 1280, h: 800, scale: 1 }, os: "linux", title: "Test" }),
    ev("agent.state", 1, { state: "thinking" }),
    ev("step.start", 10, { kind: "shell", intent: "Checking the installed applications" }, "tool"),
    ev("tool.start", 11, { tool: "shell", title: "command -v firefox" }, "tool"),
  ]);
  expect(taskHud(model, 100).label).toBe("Checking the installed applications");
  foldEvents(model, [ev("step.end", 200, { status: "ok" }, "tool")]);
  expect(taskHud(model, 300).label).toBe("Thinking…");
});
