import {
  type ActionState,
  type PlanItemState,
  type PlanSnapshot,
  planAt,
  type SessionModel,
  type StepState,
  startedCount,
  stepAt,
} from "@localdot/stage";
import { isConnectorToolName, toolAccess } from "../../../../packages/protocol/src/connectors.ts";
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
  // Progress on that tool: characters typed into the action, or the step's output arrivals (a
  // plan's items done), and whether the step went well once it has ended.
  beat?: { key: string; n: number; ok?: boolean } | null;
  // The sub-agents at work beside dot, and any that finished a moment ago, with how.
  helpers?: readonly { id: string; ok?: boolean }[];
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
const FAILED_MS = 900;
// A step is still dot's work this long after it ends, so one over between two frames still shows.
const RECENT_MS = 600;
// One plan update can arrive as several events this close together.
const PLAN_BATCH_MS = 50;
// A sub-agent that has finished stays beside dot this long, to go back with how it went.
const HELPER_LEAVE_MS = 800;
// Tools that come from what dot is doing rather than from a step's progress.
const QUIET: ReadonlySet<DotTool> = new Set([
  "thinking",
  "looking",
  "waiting",
  "needs-you",
  "delegating",
]);

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
  const latest = model ? stepAt(model, nowMs) : undefined;
  const planned = model ? planChange(model, nowMs) : undefined;
  const step = planned && (!latest || planned.startT >= latest.startT) ? planned : latest;
  const helpers = model ? helpersAt(model, nowMs) : [];
  const busy = helpers.some((helper) => helper.ok === undefined);
  const tool = toolFor(status.row, step, action, nowMs, busy);
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
    beat: beatOf(tool, step, action, model, nowMs),
    helpers,
    failed:
      action?.ok === false && action.resultT !== undefined && nowMs - action.resultT < FAILED_MS
        ? action.id
        : null,
  };
}

// What dot is working with: the user when it needs them; else the action it is on, or the step,
// which stays dot's work for a moment after it ends; else its sub-agents at work; else thinking or
// looking at the screen, as the status row says.
export function toolFor(
  row: StatusRow,
  step: StepState | undefined,
  action: ActionState | undefined,
  nowMs: number,
  delegating = false,
): DotTool | null {
  if (NEEDS_YOU.has(row)) return "needs-you";
  if (!WORK.has(row) && !THINKING.has(row) && row !== "observing") return null;
  const current = step !== undefined && (step.endT === undefined || nowMs < step.endT + RECENT_MS);
  const own = action && (!step || action.step === step.id || action.intentT >= step.startT);
  if (own && (WORK.has(row) || current)) return toolOfAction(action);
  const work = current ? toolOfStep(step, nowMs) : null;
  if (work) return work;
  if (delegating) return "delegating";
  if (THINKING.has(row)) return "thinking";
  return row === "observing" ? "looking" : null;
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

function toolOfStep(step: StepState, nowMs: number): DotTool | null {
  const title = step.title ?? "";
  // A connected app: reading from it is reading a page, a change to it flies off as a message.
  if (step.tool && isConnectorToolName(step.tool)) {
    const tool = step.tool.slice(step.tool.indexOf("__") + 2);
    return toolAccess({ name: tool }).access === "read" ? "browsing" : "sending";
  }
  switch (step.tool) {
    case "shell":
      return "terminal";
    // Writing code is typing; any other file goes into its folder; reading one turns its pages.
    case "files":
      return /^(write|edit)\b/.test(title) ? (CODE.test(title) ? "typing" : "filing") : "reading";
    case "browser_read":
    case "browser_navigate":
    case "switch_screen":
      return "browsing";
    case "browser_upload":
    case "api_request":
      return "sending";
    case "web_search":
    case "find":
      return "searching";
    // Reading the web is browsing; a picture from it is looked at closely.
    case "web_fetch":
      return title.startsWith("Looked at") ? "inspecting" : "browsing";
    // Research reads PDFs like pages, and writes its report at the keyboard.
    case "research":
      return title.startsWith("Writing") ? "typing" : "browsing";
    case "work_context":
      return "inspecting";
    case "recall":
      return "recalling";
    case "people":
      return title.startsWith("Remember") ? "remembering" : "recalling";
    case "remember":
      return "remembering";
    case "routine":
    case "follow_up_at":
      return "scheduling";
    case "update_plan":
      return "planning";
    case "done":
      return "waiting";
    case "ask_user":
    case "request_takeover":
    case "credentials":
      return "needs-you";
  }
  switch (step.kind) {
    case "shell":
      return "terminal";
    case "file":
      return "filing";
    case "browser":
      return "browsing";
    case "app":
      return "sending";
    // A look at the screen that took no action of its own: a screenshot, a zoom, the cursor. Until
    // the step is over its action may yet come.
    case "gui":
      return step.endT !== undefined && step.endT <= nowMs ? "inspecting" : null;
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
  model: SessionModel | null,
  nowMs: number,
): DotFeed["beat"] {
  if (!tool || QUIET.has(tool)) return null;
  if (tool === "typing" && action) {
    const typed = action.progress.findLast((p) => p.t <= nowMs);
    return { key: action.id, n: typed?.count ?? 0 };
  }
  if (!step) return null;
  let n = 0;
  for (const t of step.outputs ?? []) if (t <= nowMs) n++;
  if (tool === "planning" && model)
    n = planAt(model, nowMs).filter((item) => item.status === "done").length;
  // A page shows its load from the start; a note is written as it is saved.
  else if (tool === "browsing" || tool === "remembering") n += 1;
  const ended = step.endT !== undefined && step.endT <= nowMs;
  return { key: step.id, n, ...(ended ? { ok: step.status === "ok" } : {}) };
}

// A plan update that set out a new plan or got items done, as a step of its own while it is recent,
// so the checklist comes out for it.
function planChange(model: SessionModel, nowMs: number): StepState | undefined {
  const plans = model.plans;
  let i = plans.length - 1;
  while (i >= 0 && (plans[i] as PlanSnapshot).t > nowMs) i--;
  const now = plans[i];
  if (!now || nowMs - now.t >= RECENT_MS) return undefined;
  let j = i - 1;
  while (j >= 0 && now.t - (plans[j] as PlanSnapshot).t < PLAN_BATCH_MS) j--;
  const before = plans[j]?.items ?? [];
  const done = (items: readonly PlanItemState[]) =>
    items.filter((item) => item.status === "done").length;
  const set =
    now.items.length !== before.length ||
    now.items.some((item, k) => item.text !== before[k]?.text);
  if (!set && done(now.items) <= done(before)) return undefined;
  const t = now.t;
  return { id: `plan-${t}`, kind: "think", startT: t, endT: t, status: "ok", tool: "update_plan" };
}

// The sub-agents at work at a moment, and those that finished just before it, with how.
function helpersAt(model: SessionModel, nowMs: number): NonNullable<DotFeed["helpers"]> {
  const out: { id: string; ok?: boolean }[] = [];
  for (const run of model.subagents) {
    if (run.startT > nowMs) continue;
    if (run.endT === undefined || run.endT > nowMs) out.push({ id: run.runId });
    else if (nowMs - run.endT < HELPER_LEAVE_MS) out.push({ id: run.runId, ok: run.ok === true });
  }
  return out;
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
