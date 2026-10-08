import { msToSeconds, type PauseSnapshot } from "@localdot/protocol";
import {
  type ActionState,
  agentStateAt,
  type SessionModel,
  screenAt,
  startedCount,
} from "@localdot/stage";
import type { AgentModel } from "../agent/model.ts";
import type { HudState } from "../cells/hud-state.ts";

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
const OWNED_REASONS = new Set([
  "user",
  "repeated_action",
  "Waiting for explicit Resume",
  "question",
  "approval",
]);
export const ownedPause = (reason: string | null | undefined) =>
  reason != null && OWNED_REASONS.has(reason);

const PAST_HOLD_MS = 1200;
const WORKING = new Set(["acting", "observing", "thinking"]);
const ended = (a: ActionState) => a.cancel?.t ?? a.resultT;

export function taskHud(model: SessionModel, nowMs: number, facts?: TaskFacts): TaskHud {
  const n = startedCount(model, nowMs);
  const first = screenAt(model, nowMs)?.firstAction ?? 0;
  const current = n > first ? model.actions[n - 1] : undefined;
  const acting = current !== undefined && ended(current) === undefined;
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
  if (facts?.approval) return waiting("approval", "Needs your OK", "Waiting for your OK.");
  if (facts?.question != null)
    return waiting("question", "Has a question", facts.question || "Waiting for your answer.");
  if (facts?.takeover != null)
    return waiting("takeover", "Your turn", facts.takeover || "Your turn to use the computer.");
  if (facts?.pause === "pausing")
    return running("pausing", "Pausing after this step", "Pausing after this step.", acting);
  if (facts?.pause === "resuming") return running("resuming", "Resuming…", "Resuming…", false);
  if (facts?.pause) return waiting("paused", "Paused", "Paused.");

  let state = agentStateAt(model, nowMs)?.state;
  // Live, a wait the controls above no longer show has ended, and the task carries on.
  if (facts && (state === "waiting_user" || (state === "paused" && ownedPause(facts.reason))))
    state = "acting";
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

export function mergeHud(
  hud: HudState,
  task: TaskHud | null,
): HudState & { control: boolean; elapsedS?: number | null; stop?: boolean } {
  // Pause is authoritative even when the session-end event arrives after cell status.
  if (!task || hud.paused) return { ...hud, control: false };
  if (task.phase === "finished") {
    // A finished task keeps its verdict while the computer is live; the computer's controls return.
    return {
      ...hud,
      ...(hud.live ? { label: task.label } : {}),
      caption: task.caption,
      control: false,
    };
  }
  return {
    ...hud,
    label: task.label,
    caption: task.caption,
    control: task.control,
    elapsedS: task.elapsedS,
    stop: true,
  };
}
