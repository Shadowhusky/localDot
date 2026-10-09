import {
  type ActionState,
  type SessionModel,
  type StepState,
  startedCount,
  stepAt,
} from "@localdot/stage";
import {
  type Status,
  type StatusRow,
  TASK_POSE,
  type TaskHud,
  taskHud,
} from "../session/status.ts";
import { atWork, narrationLine } from "../shell/narration.ts";
import type { Point } from "./engine/engine.ts";
import type { DotState } from "./engine/states.ts";
import type { DotTool } from "./engine/tools.ts";

// What drives the one live dot: its state, the xenon rim, the attention mark and where its work is.
export interface DotFeed {
  state: DotState;
  control: boolean;
  // dot needs the user: an approval, a question or a limit it can't pass.
  attention: boolean;
  // The action point on the picture, as fractions of the stage's width and height.
  focus: Point | null;
  // The action whose input has gone to the computer, for the nod that goes with it.
  dispatched: string | null;
  // The task has just finished well.
  done: boolean;
  // Changes when dot should blink that it heard, as each setup step arrives.
  nod?: string;
  // The tool dot is using, for its prop and pose; none between tasks.
  tool?: DotTool | null;
  // Progress on that tool: characters typed into the action, or output arrivals of the command.
  beat?: { key: string; n: number } | null;
  // The action that just failed, for a wince.
  failed?: string | null;
}

const ATTENTION = new Set<StatusRow>(["approval", "question", "waiting", "recovery", "limit"]);
const NEEDS_YOU = new Set<StatusRow>([...ATTENTION, "takeover"]);
const THINKING = new Set<StatusRow>(["thinking", "retrying", "pausing", "resuming"]);
const WORK = new Set<StatusRow>(["acting", "working"]);
const SEND = /\b(send|post|publish|submit|upload|share|reply|tweet)\b/i;
const SAVE = /\b(ctrl|cmd|command|super|meta)\s*\+\s*s\b/i;
const CODE =
  /\.(c|cc|cpp|cs|css|go|h|html?|java|jsx?|json|kt|lua|mjs|php|py|rb|rs|sh|sql|swift|tsx?|ya?ml|toml|vue)\b/i;
// A shell command that writes text into a file is typing, not watching output.
const SHELL_WRITES = /<<\s*['"]?\w|\btee\b|\b(cat|printf|echo)\b[^|]*>/;
const FAILED_MS = 900;

export function dotFeed(
  status: Pick<Status, "dotPose" | "control" | "row">,
  model: SessionModel | null,
  nowMs: number,
): DotFeed {
  const action = model ? currentAction(model, nowMs) : undefined;
  // An action that waits on the computer (a page load, a download) is watched, not acted out.
  const state =
    status.dotPose === "acting" && action?.verb === "wait" ? "watching" : status.dotPose;
  const screen = model?.screen;
  const point = action?.target?.point ?? action?.point;
  const step = model ? stepAt(model, nowMs) : undefined;
  const tool = toolFor(status.row, step, action);
  return {
    state,
    control: status.control,
    attention: ATTENTION.has(status.row),
    focus:
      point && screen && screen.w > 0 && screen.h > 0
        ? { x: point.x / screen.w, y: point.y / screen.h }
        : null,
    dispatched: action?.dispatch ? action.id : null,
    done: status.row === "done",
    tool,
    beat: beatOf(tool, step, action, nowMs),
    failed:
      action?.ok === false && action.resultT !== undefined && nowMs - action.resultT < FAILED_MS
        ? action.id
        : null,
  };
}

// What dot is working with, from the status row, the step in progress and its latest action.
export function toolFor(
  row: StatusRow,
  step: StepState | undefined,
  action: ActionState | undefined,
): DotTool | null {
  if (NEEDS_YOU.has(row)) return "needs-you";
  if (THINKING.has(row)) return "thinking";
  if (row === "observing") return "looking";
  if (!WORK.has(row)) return null;
  const own = action && (!step || action.step === step.id || action.intentT >= step.startT);
  if (own) return toolOfAction(action);
  return step ? toolOfStep(step) : null;
}

function toolOfAction(a: ActionState): DotTool {
  switch (a.verb) {
    case "type":
      return "typing";
    case "key":
      return SAVE.test(a.label) ? "filing" : "typing";
    case "click":
    case "move":
      return SEND.test(a.label) ? "sending" : "pointing";
    case "drag":
      return "dragging";
    case "scroll":
      return "browsing";
    case "wait":
      return "waiting";
  }
}

function toolOfStep(step: StepState): DotTool | null {
  const title = step.title ?? "";
  switch (step.tool) {
    case "shell":
      return SHELL_WRITES.test(title) ? "typing" : "terminal";
    case "files":
      return /^(write|edit)\b/.test(title) && CODE.test(title)
        ? "typing"
        : /^(write|edit)\b/.test(title)
          ? "filing"
          : "looking";
    case "browser_read":
    case "browser_navigate":
    case "switch_screen":
      return "browsing";
    case "browser_upload":
      return "sending";
    case "find":
      return "looking";
    case "remember":
    case "recall":
    case "people":
    case "routine":
    case "follow_up_at":
      return "recalling";
    case "update_plan":
      return "thinking";
    case "ask_user":
    case "request_takeover":
      return "needs-you";
  }
  switch (step.kind) {
    case "shell":
      return "terminal";
    case "file":
      return "filing";
    case "browser":
      return "browsing";
    case "think":
      return "thinking";
    case "ask":
      return "needs-you";
    default:
      return null;
  }
}

function beatOf(
  tool: DotTool | null,
  step: StepState | undefined,
  action: ActionState | undefined,
  nowMs: number,
): DotFeed["beat"] {
  if (tool === "typing" && action) {
    const typed = action.progress.findLast((p) => p.t <= nowMs);
    return { key: action.id, n: typed?.count ?? 0 };
  }
  if ((tool === "terminal" || tool === "browsing") && step) {
    let n = 0;
    for (const t of step.outputs ?? []) if (t <= nowMs) n++;
    return { key: step.id, n: tool === "browsing" ? n + 1 : n };
  }
  return null;
}

export interface RecordedPresence {
  feed: DotFeed;
  line: string;
  // The line is for the user (a question, an approval, a problem, the end), not about dot's work.
  forUser: boolean;
}

// What dot did and said at a moment of a recording: Replay's band and an exported video show the
// same states, gaze and line.
export function recordedPresence(
  model: SessionModel,
  tMs: number,
  hud: TaskHud = taskHud(model, tMs),
): RecordedPresence {
  return {
    feed: dotFeed({ dotPose: TASK_POSE[hud.row], control: hud.control, row: hud.row }, model, tMs),
    line: narrationLine(hud.row, hud.caption, model, tMs),
    forUser: !atWork(hud.row),
  };
}

function currentAction(model: SessionModel, nowMs: number) {
  const n = startedCount(model, nowMs);
  return n > 0 ? model.actions[n - 1] : undefined;
}

// A line dot says for about as long as it would take to say it.
export const sayMs = (line: string) =>
  Math.min(2200, Math.max(500, line.trim().split(/\s+/).length * 170));
