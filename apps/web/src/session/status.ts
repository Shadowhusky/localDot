import {
  type Attention,
  msToSeconds,
  type PauseSnapshot,
  SESSION_PAUSE_REASONS,
} from "@localdot/protocol";
import {
  type ActionState,
  type AgentStateAt,
  agentStateAt,
  type SessionModel,
  type StepState,
  screenAt,
  startedCount,
  stepAt,
} from "@localdot/stage";
import type { AgentModel } from "../agent/model.ts";
import type { ComputerPhase, HudActionKind, HudState } from "../cells/hud-state.ts";
import type { DotState } from "../dot/engine/states.ts";

// What the live task feed knows beyond the timeline. Replay has only the timeline.
export interface TaskFacts {
  readonly approval: boolean;
  readonly question: string | null;
  readonly takeover: string | null;
  readonly pause: PauseSnapshot["phase"] | null;
  // The reason on the latest agent.state.
  readonly reason: string | null;
  readonly result: boolean;
}

export type TaskRow =
  | "approval"
  | "question"
  | "takeover"
  | "waiting"
  | "pausing"
  | "paused"
  | "resuming"
  | "recovery"
  | "acting"
  | "thinking"
  | "observing"
  | "working"
  | "done"
  | "ready"
  | "stopped"
  | "failed";

export interface TaskHud {
  readonly row: TaskRow;
  // running: dot is working and the clock counts; waiting: the task waits and keeps its Stop;
  // finished: the task is over, so the computer's own control returns.
  readonly phase: "running" | "waiting" | "finished";
  readonly label: string;
  readonly caption: string;
  readonly elapsedS: number | null;
  readonly control: boolean;
}

export function taskFacts(model: AgentModel): TaskFacts {
  return {
    approval: !!model.approval,
    question: model.pendingAsk ? (model.questions.get(model.pendingAsk)?.question ?? "") : null,
    takeover: model.pendingTakeover
      ? (model.takeovers.get(model.pendingTakeover)?.note ?? "")
      : null,
    pause: model.safetyPause?.phase ?? null,
    reason: model.state?.reason ?? null,
    result: model.results.length > 0,
  };
}

const PROGRESSIVE: [RegExp, string][] = [
  [/^Click\b/, "Clicking"],
  [/^Type\b/, "Typing"],
  [/^Press\b/, "Pressing"],
  [/^Scroll\b/, "Scrolling"],
  [/^Open\b/, "Opening"],
  [/^Wait\b/, "Waiting"],
];
const PAST: [RegExp, string][] = [
  [/^Click\b/, "Clicked"],
  [/^Type\b/, "Typed"],
  [/^Press\b/, "Pressed"],
  [/^Scroll\b/, "Scrolled"],
  [/^Open\b/, "Opened"],
  [/^Wait\b/, "Waited"],
];
const tense = (label: string, table: [RegExp, string][]) =>
  table.reduce((l, [re, to]) => l.replace(re, to), label);
export const progressive = (label: string) => tense(label, PROGRESSIVE);
export const past = (label: string) => tense(label, PAST);

// Reasons the daemon and brain give a paused state that the Pause, question or approval owns,
// rather than a recovery such as the spending limit. Once that control is settled, so is the pause.
const OWNED_REASONS = new Set([...SESSION_PAUSE_REASONS, "Waiting for explicit Resume"]);
export const ownedPause = (reason: string | null | undefined) =>
  reason != null && OWNED_REASONS.has(reason);

// Approving, answering, handing back and Resume publish no state of their own, so a wait whose
// control has settled is over and the task carries on until the brain next reports.
function settled(state: string | undefined, facts: TaskFacts): string | undefined {
  const pending =
    facts.approval || facts.question !== null || facts.takeover !== null || facts.pause !== null;
  return !pending && (state === "waiting_user" || (state === "paused" && ownedPause(facts.reason)))
    ? "acting"
    : state;
}
export const liveState = (model: AgentModel) => settled(model.state?.state, taskFacts(model));

// Replay has only the timeline: a wait is over once the user settles it or a new step starts.
const SETTLES = new Set(["approval.resolve", "ask.answer", "takeover.end"]);
function settledSince(model: SessionModel, at: AgentStateAt, nowMs: number): boolean {
  for (let i = model.marks.length - 1; i >= 0; i--) {
    const mark = model.marks[i];
    if (!mark || mark.t <= at.t) return false;
    if (mark.t <= nowMs && SETTLES.has(mark.type)) return true;
  }
  return false;
}
// A Pause publishes its paused state as soon as it is asked for, and the step in flight runs on.
// Live shows pausing until the Pause next changes. Replay has no phase, so it shows pausing while
// the step the Pause was asked in is still open and that request is the Pause's only change since
// the step began. A held Pause republishes its paused state, so that state's time cannot tell.
function pausing(model: SessionModel, step: StepState, at: AgentStateAt, nowMs: number): boolean {
  if ((step.endT ?? Number.POSITIVE_INFINITY) <= nowMs) return false;
  let requestT: number | undefined;
  for (let i = model.marks.length - 1; i >= 0; i--) {
    const mark = model.marks[i];
    if (!mark || mark.t < step.startT) break;
    if (mark.t > nowMs || mark.type !== "safety.pause") continue;
    if (requestT !== undefined) return false;
    requestT = mark.t;
  }
  return requestT !== undefined && requestT <= at.t;
}
function replayState(model: SessionModel, at: AgentStateAt, nowMs: number): string {
  if (at.state !== "waiting_user" && at.state !== "paused") return at.state;
  const step = stepAt(model, nowMs);
  if ((step?.startT ?? Number.NEGATIVE_INFINITY) > at.t) return "acting";
  if (at.state === "waiting_user") return settledSince(model, at, nowMs) ? "acting" : at.state;
  return step && pausing(model, step, at, nowMs) ? "pausing" : at.state;
}

const PAST_HOLD_MS = 1200;
const WORKING = new Set(["acting", "observing", "thinking"]);
// Replay folds the whole recording, so an action's end may still lie ahead of nowMs.
const ended = (a: ActionState, nowMs: number) => {
  const t = a.cancel?.t ?? a.resultT;
  return t !== undefined && t <= nowMs;
};

export function taskHud(model: SessionModel, nowMs: number, facts?: TaskFacts): TaskHud {
  const n = startedCount(model, nowMs);
  const first = screenAt(model, nowMs)?.firstAction ?? 0;
  const current = n > first ? model.actions[n - 1] : undefined;
  const acting = current !== undefined && !ended(current, nowMs);
  const elapsedMs = model.startT === null ? 0 : Math.max(0, nowMs - model.startT);
  const elapsedS = elapsedMs >= 5000 ? Math.floor(msToSeconds(elapsedMs)) : null;
  const finished = (row: TaskRow, label: string, caption: string): TaskHud => ({
    row,
    phase: "finished",
    label,
    caption,
    elapsedS: null,
    control: false,
  });
  const waiting = (row: TaskRow, label: string, caption: string): TaskHud => ({
    row,
    phase: "waiting",
    label,
    caption,
    elapsedS: null,
    control: false,
  });
  const running = (row: TaskRow, label: string, caption: string, control: boolean): TaskHud => ({
    row,
    phase: "running",
    label,
    caption,
    elapsedS,
    control,
  });

  if (model.ended && model.ended.t <= nowMs) {
    if (model.ended.reason === "done") return finished("done", "Done", "Done.");
    if (model.ended.reason === "stopped") return finished("stopped", "Task stopped", "Stopped.");
    return finished("failed", "Task failed", "The task failed.");
  }
  const at = agentStateAt(model, nowMs);
  const state = facts ? settled(at?.state, facts) : at && replayState(model, at, nowMs);
  if (facts?.approval) return waiting("approval", "Needs your OK", "Waiting for your OK.");
  if (facts?.question != null)
    return waiting("question", "Has a question", facts.question || "Waiting for your answer.");
  if (facts?.takeover != null)
    return waiting("takeover", "Your turn", facts.takeover || "Your turn to use the computer.");
  if (facts?.pause === "pausing" || state === "pausing")
    return running("pausing", "Pausing after this step", "Pausing after this step.", acting);
  if (facts?.pause === "resuming") return running("resuming", "Resuming…", "Resuming…", false);
  if (facts?.pause === "uncertain")
    return waiting("paused", "Pause unconfirmed", "Pause is unconfirmed.");
  if (facts?.pause) return waiting("paused", "Paused", "Paused.");

  if (state === "waiting_user") return waiting("waiting", "Waiting for you", "Waiting for you.");
  if (state === "paused")
    return facts?.reason === "budget"
      ? waiting("recovery", "Paused · Limit reached", "Paused at the spending limit.")
      : waiting("recovery", "Paused", "Paused.");
  if (state === "error") return waiting("recovery", "Needs attention", "The task needs attention.");
  if (state === "done") return finished("done", "Done", "Done.");
  if (state === "idle")
    return facts?.result
      ? finished("done", "Done", "Done.")
      : finished("ready", "Ready", "Ready for a follow-up.");

  const control = state !== undefined && WORKING.has(state);
  if (current && acting)
    return running("acting", progressive(current.label), current.label, control);
  if (current?.resultT !== undefined && current.ok && !current.cancel) {
    const done = past(current.label);
    if (done !== current.label && nowMs - current.resultT < PAST_HOLD_MS)
      return running("acting", done, done, control);
  }
  if (state === "thinking") return running("thinking", "Thinking…", "Thinking…", control);
  if (state === "observing")
    return running("observing", "Checking the screen", "Checking the screen.", control);
  return running("working", "Working", model.actions.length ? "Working…" : "Starting…", control);
}

export type StatusRow = TaskRow | "computer" | "stopping";

export interface HudAction {
  // stop-task stops the task; the others are the computer's own.
  readonly kind: "stop-task" | HudActionKind;
  readonly enabled: boolean;
  readonly busy?: true;
}

export interface Status {
  readonly row: StatusRow;
  // Where the computer is in its life, whatever the row.
  readonly computer: ComputerPhase;
  readonly label: string;
  readonly caption: { readonly speaker: "dot" | "system"; readonly text: string };
  readonly elapsedS: number | null;
  // The HUD's controls, in order; never empty.
  readonly actions: readonly HudAction[];
  // dot has control: the xenon rim.
  readonly control: boolean;
  readonly dotPose: DotState;
  // How urgently this asks for the user, on the scale every surface shares. "done" marks any
  // finished task; the surface that shows it drops it once the user has seen it.
  readonly attention: Attention | null;
  readonly title: string;
}

export interface StatusInput {
  // The computer's own HUD, its action already gated on the requests in flight.
  readonly computer: HudState;
  // The task on this computer; null when there is none, or once a task Stop froze or stopped it.
  readonly task: TaskHud | null;
  // A task Stop in flight, or one whose outcome is not confirmed.
  readonly stop?: "stopping" | "unconfirmed" | null;
  readonly canStop?: boolean;
  // False while the task feed is stale, a takeover waits or the computer is fenced.
  readonly mayControl?: boolean;
}

const COMPUTER_POSE: Record<ComputerPhase, DotState> = {
  checking: "idle",
  none: "sleeping",
  starting: "waking",
  restarting: "waking",
  connecting: "waking",
  live: "idle",
  reconnecting: "reconnecting",
  frozen: "resting",
  stopping: "sleeping",
  stopped: "sleeping",
  failed: "error",
  unavailable: "error",
};
const TASK_POSE: Record<TaskRow, DotState> = {
  approval: "waiting",
  question: "waiting",
  waiting: "waiting",
  takeover: "your-turn",
  pausing: "thinking",
  paused: "resting",
  resuming: "thinking",
  recovery: "resting",
  acting: "acting",
  working: "acting",
  thinking: "thinking",
  observing: "observing",
  done: "idle",
  stopped: "idle",
  ready: "idle",
  failed: "error",
};
const TASK_ATTENTION: Record<TaskRow, Attention | null> = {
  approval: "needs_you",
  question: "needs_you",
  waiting: "needs_you",
  takeover: "needs_you",
  pausing: "working",
  paused: null,
  resuming: "working",
  recovery: "blocked",
  acting: "working",
  working: "working",
  thinking: "working",
  observing: "working",
  done: "done",
  stopped: null,
  ready: null,
  failed: "blocked",
};
// Rows whose caption is dot's own words: its narration, its question or its note to the user.
const DOT_SPEAKS = new Set<TaskRow>([
  "question",
  "takeover",
  "acting",
  "working",
  "thinking",
  "observing",
]);

// Computers that can't carry a task: off, failing or not up yet. A late picture (connecting,
// reconnecting) or a list check leaves the task in charge, since dot works on the computer itself.
const DOWN = new Set<ComputerPhase>([
  "none",
  "starting",
  "restarting",
  "stopping",
  "stopped",
  "failed",
  "unavailable",
]);

// The one place status is decided: the HUD, the caption, dot's pose and the tab title all read it.
// A task Stop outranks everything. A frozen computer outranks any task, its Stop included; a
// computer that is down outranks it too but leaves its Stop. A finished task keeps its verdict
// only while the computer is live.
export function statusFor({
  computer,
  task,
  stop = null,
  canStop = true,
  mayControl = true,
}: StatusInput): Status {
  const held = computer.paused ? null : task;
  const own = DOWN.has(computer.phase) ? null : held;
  const running = own && own.phase !== "finished" ? own : null;
  const shown = running ?? (own && computer.live ? own : null);
  const row: StatusRow = stop
    ? "stopping"
    : (shown?.row ?? (computer.phase === "live" ? "ready" : "computer"));
  const label =
    stop === "stopping"
      ? "Stopping…"
      : stop === "unconfirmed"
        ? "Stop unconfirmed"
        : (shown ?? computer).label;
  const actions: HudAction[] =
    stop || (held && held.phase !== "finished")
      ? [
          stop === "stopping"
            ? { kind: "stop-task", enabled: false, busy: true }
            : { kind: "stop-task", enabled: canStop },
        ]
      : computer.action.kind === "resume"
        ? [computer.action, { kind: "stop", enabled: computer.action.enabled }]
        : [computer.action];
  return {
    row,
    computer: computer.phase,
    label,
    caption: {
      speaker: own && DOT_SPEAKS.has(own.row) ? "dot" : "system",
      text: own?.caption ?? computer.caption,
    },
    elapsedS: running?.elapsedS ?? null,
    actions,
    control: (running?.control ?? false) && mayControl,
    dotPose:
      stop === "unconfirmed"
        ? "error"
        : stop
          ? "resting"
          : shown
            ? TASK_POSE[shown.row]
            : COMPUTER_POSE[computer.phase],
    attention:
      stop === "unconfirmed"
        ? "blocked"
        : stop
          ? "working"
          : shown
            ? TASK_ATTENTION[shown.row]
            : computer.phase === "failed" || computer.phase === "unavailable"
              ? "blocked"
              : null,
    title: `localDot — ${label}`,
  };
}
