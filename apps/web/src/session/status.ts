import {
  type Attention,
  microsToMs,
  msToSeconds,
  type PauseSnapshot,
  type RequestTakeoverInput,
  SESSION_PAUSE_REASONS,
  STALL,
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
import { markdownToPlain } from "../agent/markdown.ts";
import { type AgentModel, heldByUser } from "../agent/model.ts";
import type { ComputerPhase, HudActionKind, HudState } from "../cells/hud-state.ts";
import type { DotState } from "../dot/engine/states.ts";

type TakeoverReason = RequestTakeoverInput["reason"];

// What the live task feed knows beyond the timeline. Replay has only the timeline.
export interface TaskFacts {
  readonly approval: boolean;
  // An app's connection waits on a card; dot itself carries on.
  readonly connection: boolean;
  readonly question: string | null;
  readonly takeover: string | null;
  // The user has the computer: "user" when they asked for it, or the reason dot handed it over once
  // they took that.
  readonly yours: TakeoverReason | "user" | null;
  readonly pause: PauseSnapshot["phase"] | null;
  // The reason on the latest agent.state.
  readonly reason: string | null;
  readonly result: boolean;
  // A model call waiting to be tried again: when, in session ms, and whether the model could be
  // reached at all.
  readonly retry: { readonly atMs: number; readonly unreachable: boolean } | null;
}

export type TaskRow =
  | "approval"
  | "question"
  | "takeover"
  | "control"
  | "waiting"
  | "pausing"
  | "paused"
  | "resuming"
  | "recovery"
  | "retrying"
  | "limit"
  | "acting"
  | "thinking"
  | "observing"
  | "working"
  | "done"
  | "ready"
  | "stopped"
  | "interrupted"
  | "failed";

export interface TaskHud {
  readonly row: TaskRow;
  // running: dot is working and the clock counts; waiting: the task waits and keeps its Stop;
  // finished: the task is over, so the computer's own control returns.
  readonly phase: "running" | "waiting" | "finished";
  readonly label: string;
  readonly caption: string;
  readonly elapsedS: number | null;
  // Seconds until dot tries again, while it waits on a busy model.
  readonly countdownS: number | null;
  readonly control: boolean;
}

export function taskFacts(model: AgentModel): TaskFacts {
  const yours = heldByUser(model);
  return {
    approval: !!model.approval,
    connection: !!model.connection,
    question: model.pendingAsk
      ? markdownToPlain(model.questions.get(model.pendingAsk)?.question ?? "")
      : null,
    takeover: model.pendingTakeover
      ? markdownToPlain(model.takeovers.get(model.pendingTakeover)?.note ?? "")
      : null,
    yours: !yours ? null : yours.by === "user" ? "user" : yours.reason,
    pause: model.safetyPause?.phase ?? null,
    reason: model.state?.reason ?? null,
    result: model.results.length > 0,
    retry:
      model.retrying && model.retry
        ? {
            atMs: microsToMs(model.retry.at) + model.retry.data.waitMs,
            unreachable: model.retry.data.status === undefined,
          }
        : null,
  };
}

const PROGRESSIVE: [RegExp, string][] = [
  [/^Click\b/, "Clicking"],
  [/^Type\b/, "Typing"],
  [/^Press\b/, "Pressing"],
  [/^Hold\b/, "Holding"],
  [/^Drag\b/, "Dragging"],
  [/^Move\b/, "Moving"],
  [/^Release\b/, "Releasing"],
  [/^Scroll\b/, "Scrolling"],
  [/^Open\b/, "Opening"],
  [/^Wait\b/, "Waiting"],
];
const PAST: [RegExp, string][] = [
  [/^Click\b/, "Clicked"],
  [/^Type\b/, "Typed"],
  [/^Press\b/, "Pressed"],
  [/^Hold\b/, "Held"],
  [/^Drag\b/, "Dragged"],
  [/^Move\b/, "Moved"],
  [/^Release\b/, "Released"],
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
const OWNED_REASONS = new Set(SESSION_PAUSE_REASONS);
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
// A Pause asked for after a recovery pause publishes no state of its own, and holds the task.
function replayReason(model: SessionModel, at: AgentStateAt, nowMs: number): string | null {
  for (let i = model.marks.length - 1; i >= 0; i--) {
    const mark = model.marks[i];
    if (!mark || mark.t <= at.t) break;
    if (mark.t <= nowMs && mark.type === "safety.pause") return null;
  }
  return at.reason ?? null;
}
function replayState(model: SessionModel, at: AgentStateAt, nowMs: number): string {
  if (at.state !== "waiting_user" && at.state !== "paused") return at.state;
  const step = stepAt(model, nowMs);
  if ((step?.startT ?? Number.NEGATIVE_INFINITY) > at.t) return "acting";
  if (at.state === "waiting_user") return settledSince(model, at, nowMs) ? "acting" : at.state;
  return step && pausing(model, step, at, nowMs) ? "pausing" : at.state;
}

// A task whose log stops short of its end: localDot went away under it.
const INTERRUPTED_CAPTION = "I was cut off before I finished. Shall I continue?";

// What a task paused on, other than its own Pause or a question, says on the HUD.
const STALLED: Record<string, { row: TaskRow; label: string; caption: string }> = {
  [STALL.budget]: {
    row: "limit",
    label: "Spending limit reached",
    caption: "I stopped at the spending limit you set.",
  },
  [STALL.modelBusy]: {
    row: "retrying",
    label: "Model busy · retrying",
    caption: "The model is busy. I'll try again in a moment.",
  },
  [STALL.modelUnavailable]: {
    row: "recovery",
    label: "Model not answering",
    caption: "The model isn't answering. Try again, or change the model.",
  },
  [STALL.modelRefused]: {
    row: "recovery",
    label: "Model turned down a request",
    caption: "The model turned down my request. Try again, or change the model.",
  },
  [STALL.keyd]: { row: "recovery", label: "Keys are offline", caption: "I can't reach your keys." },
  [STALL.keyReenter]: {
    row: "recovery",
    label: "A key needs re-entering",
    caption: "A key needs entering again. The chat says which one.",
  },
  [STALL.keyRebound]: {
    row: "recovery",
    label: "Key changed elsewhere",
    caption: "A key was changed outside localDot. The chat says which one.",
  },
};

// A wait for the user counts from dot's request, so the island shows how long dot has waited.
const REQUEST: Partial<Record<TaskRow, string>> = {
  approval: "approval.request",
  question: "ask.request",
  takeover: "takeover.request",
  control: "takeover.request",
};
// What dot says while the user has the computer, by why it is theirs.
const YOUR_TURN: Record<TakeoverReason | "user", string> = {
  user: "I'll wait here until you hand back.",
  login: "Your turn. I'll wait here and pick up after you sign in.",
  "2fa": "Your turn. I'll wait here and pick up after you enter the code.",
  captcha: "Your turn. I'll wait here and pick up after you finish the check.",
  payment: "Your turn. I'll wait here and pick up after you enter the payment details.",
  other: "Your turn. I'll wait here until you hand back.",
};
function waitedS(model: SessionModel, row: TaskRow, nowMs: number): number | null {
  const type = REQUEST[row];
  if (!type) return null;
  for (let i = model.marks.length - 1; i >= 0; i--) {
    const mark = model.marks[i];
    if (mark?.type === type && mark.t <= nowMs)
      return Math.floor(msToSeconds(Math.max(0, nowMs - mark.t)));
  }
  return null;
}

// Captions that only name dot's state. The band never says them: dot's pose and the island do.
const THINKING = "Thinking…";
const CHECKING = "Checking the screen.";
const WORKING_ON = "Working…";
const STARTING_OUT = "Starting…";
export const STATE_CAPTIONS: ReadonlySet<string> = new Set([
  THINKING,
  CHECKING,
  WORKING_ON,
  STARTING_OUT,
]);

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
    countdownS: null,
    control: false,
  });
  const waiting = (row: TaskRow, label: string, caption: string, control = false): TaskHud => ({
    row,
    phase: "waiting",
    label,
    caption,
    elapsedS: waitedS(model, row, nowMs),
    countdownS: null,
    control,
  });
  const running = (row: TaskRow, label: string, caption: string, control: boolean): TaskHud => ({
    row,
    phase: "running",
    label,
    caption,
    elapsedS,
    countdownS: null,
    control,
  });

  if (model.ended && model.ended.t <= nowMs) {
    if (model.ended.reason === "done") return finished("done", "Done", "Done.");
    if (model.ended.reason === "stopped") return finished("stopped", "Task stopped", "Stopped.");
    if (model.ended.reason === "interrupted")
      return finished("interrupted", "Task interrupted", INTERRUPTED_CAPTION);
    return finished("failed", "Task failed", "The task failed.");
  }
  const at = agentStateAt(model, nowMs);
  const state = facts ? settled(at?.state, facts) : at && replayState(model, at, nowMs);
  const reason = facts ? facts.reason : at ? replayReason(model, at, nowMs) : null;
  if (facts?.yours) return waiting("control", "You're in control", YOUR_TURN[facts.yours]);
  // dot keeps the computer while it waits on an OK or an answer, so the rim keeps its light.
  if (facts?.approval) return waiting("approval", "Needs your OK", "Waiting for your OK.", true);
  if (facts?.connection)
    return waiting("approval", "Needs your OK", "Waiting for your OK to connect.", true);
  if (facts?.question != null)
    return waiting(
      "question",
      "Needs your answer",
      facts.question || "Waiting for your answer.",
      true,
    );
  if (facts?.takeover != null)
    return waiting("takeover", "Your turn", facts.takeover || "Your turn to use the computer.");
  if (facts?.pause === "pausing" || state === "pausing")
    return running("pausing", "Pausing after this step", "Pausing after this step.", acting);
  if (facts?.pause === "resuming") return running("resuming", "Resuming…", "Resuming…", false);
  if (facts?.pause === "uncertain")
    return waiting(
      "paused",
      "Pause not confirmed",
      "Couldn't confirm the pause. Use Stop to be sure.",
    );
  if (facts?.pause) return waiting("paused", "Paused", "Paused.");

  // A busy or unreachable model is tried again by itself, and the wait counts down.
  if (facts?.retry) {
    const leftS = Math.ceil((facts.retry.atMs - nowMs) / 1000);
    const why = facts.retry.unreachable ? "Can't reach the model" : "Model busy";
    return {
      ...running(
        "retrying",
        leftS > 0 ? `${why} · retrying` : "Retrying…",
        facts.retry.unreachable
          ? "I can't reach the model. I'll try again in a moment."
          : "The model is busy. I'll try again in a moment.",
        false,
      ),
      elapsedS: null,
      countdownS: leftS > 0 ? leftS : null,
    };
  }
  if (state === "waiting_user") return waiting("waiting", "Waiting for you", "Waiting for you.");
  if (state === "paused") {
    const stall = STALLED[reason ?? ""];
    return stall
      ? waiting(stall.row, stall.label, stall.caption)
      : waiting("recovery", "Paused", "I've paused. The chat says how to go on.");
  }
  if (state === "error")
    return /restarting/.test(reason ?? "")
      ? running("working", "Starting again…", "Starting again where I left off.", false)
      : waiting(
          "recovery",
          "Needs attention",
          "I can't go on by myself. The chat says what to do.",
        );
  if (state === "done") return finished("done", "Done", "Done.");
  if (state === "idle" && reason === STALL.actionLimit)
    return waiting("limit", "Reached your action limit", "I stopped at the action limit you set.");
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
  if (state === "thinking") return running("thinking", "Thinking…", THINKING, control);
  if (state === "observing") return running("observing", "Checking the screen", CHECKING, control);
  return running("working", "Working", n ? WORKING_ON : STARTING_OUT, control);
}

// The thread's foot follows dot's own work. While the user has the computer it says nothing: the
// turn's line stays in the thread as it was, with the change of hands after it.
export const footWork = (task: TaskHud | null): TaskHud | null =>
  task?.row === "control" ? null : task;

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
  readonly countdownS: number | null;
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
  // A task Stop in flight, one whose outcome is not confirmed, or one that left the computer paused.
  readonly stop?: "stopping" | "unconfirmed" | "stopped" | null;
  readonly canStop?: boolean;
  // The running task's feed has been out of touch for a moment.
  readonly link?: "lost" | null;
  // False while the task feed is stale, a takeover waits or the computer is fenced.
  readonly mayControl?: boolean;
}

const COMPUTER_POSE: Record<ComputerPhase, DotState> = {
  checking: "waking",
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
export const TASK_POSE: Record<TaskRow, DotState> = {
  approval: "waiting",
  question: "waiting",
  waiting: "waiting",
  takeover: "your-turn",
  control: "your-turn",
  pausing: "thinking",
  paused: "resting",
  resuming: "thinking",
  recovery: "resting",
  retrying: "thinking",
  limit: "waiting",
  acting: "acting",
  working: "acting",
  thinking: "thinking",
  observing: "observing",
  done: "idle",
  stopped: "idle",
  interrupted: "idle",
  ready: "idle",
  failed: "error",
};
const TASK_ATTENTION: Record<TaskRow, Attention | null> = {
  approval: "needs_you",
  question: "needs_you",
  waiting: "needs_you",
  takeover: "needs_you",
  control: null,
  pausing: "working",
  paused: null,
  resuming: "working",
  recovery: "blocked",
  retrying: "working",
  limit: "needs_you",
  acting: "working",
  working: "working",
  thinking: "working",
  observing: "working",
  done: "done",
  stopped: null,
  interrupted: null,
  ready: null,
  failed: "blocked",
};
// Rows whose caption is dot's own words: its narration, its question or its note to the user.
const DOT_SPEAKS = new Set<TaskRow>([
  "interrupted",
  "limit",
  "retrying",
  "recovery",
  "question",
  "takeover",
  "control",
  "acting",
  "working",
  "thinking",
  "observing",
]);

const AT_WORK = new Set<TaskRow>(["acting", "working", "thinking", "observing"]);

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
const LOST_CAPTION = "I've lost touch with your Mac. Reconnecting…";
const UNCONFIRMED_CAPTION = "I couldn't confirm that I stopped. Press Stop again to be sure.";

export function statusFor({
  computer,
  task,
  stop = null,
  canStop = true,
  link = null,
  mayControl = true,
}: StatusInput): Status {
  const held = computer.paused ? null : task;
  const own = DOWN.has(computer.phase) ? null : held;
  const running = own && own.phase !== "finished" ? own : null;
  const shown = running ?? (own && computer.live ? own : null);
  const halting = stop === "stopped" ? null : stop;
  const lost = link === "lost" && !!running && !halting;
  const row: StatusRow = halting
    ? "stopping"
    : (shown?.row ?? (computer.phase === "live" ? "ready" : "computer"));
  // A reconnecting stream holds its last picture still, so dot's work names why; anything that
  // waits on the user keeps its own label.
  const label =
    halting === "stopping"
      ? "Stopping…"
      : halting === "unconfirmed"
        ? "Stop not confirmed"
        : lost
          ? "Reconnecting…"
          : computer.phase === "reconnecting" && shown && AT_WORK.has(shown.row)
            ? computer.label
            : stop === "stopped" && computer.phase === "frozen"
              ? "Stopped"
              : (shown ?? computer).label;
  const actions: HudAction[] =
    halting || (held && held.phase !== "finished")
      ? [
          halting === "stopping"
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
    caption: lost
      ? { speaker: "dot", text: LOST_CAPTION }
      : halting === "unconfirmed"
        ? { speaker: "dot", text: UNCONFIRMED_CAPTION }
        : {
            speaker: own && DOT_SPEAKS.has(own.row) ? "dot" : "system",
            text: own?.caption ?? computer.caption,
          },
    elapsedS: running?.elapsedS ?? null,
    countdownS: halting ? null : (running?.countdownS ?? null),
    actions,
    control: (running?.control ?? false) && mayControl,
    dotPose:
      halting === "unconfirmed"
        ? "error"
        : halting
          ? "resting"
          : lost
            ? "reconnecting"
            : shown
              ? TASK_POSE[shown.row]
              : COMPUTER_POSE[computer.phase],
    attention:
      halting === "unconfirmed"
        ? "blocked"
        : halting
          ? "working"
          : shown
            ? TASK_ATTENTION[shown.row]
            : computer.phase === "failed" || computer.phase === "unavailable"
              ? "blocked"
              : null,
    title: `localDot — ${label}`,
  };
}
