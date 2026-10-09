import {
  agentStateAt,
  type PlanItemState,
  type SessionModel,
  startedCount,
  stepAt,
  turnAt,
} from "@localdot/stage";
import { past, progressive, STATE_CAPTIONS, type StatusRow } from "../session/status.ts";

// Rows where dot is at work: its words say what it is doing, never a word for its state.
const AT_WORK = new Set<StatusRow>(["acting", "working", "thinking", "observing"]);
// The band clamps the line to its own lines at whatever width it has; this only stops a runaway
// sentence, at about two lines beside dot on the widest stage.
const MAX_CHARS = 240;
const STOP = /[.!?…]["'”’)\]]*$/;
// Thinking this long with nothing new to say, dot says what it is still working out.
export const LONG_THINK_MS = 6000;
// Each line stays at least this long, time to read it, so a quick run of steps never flickers.
export const LINE_HOLD_MS = 1500;

// The band's line. While dot works: its own line for the current action, else its last line in this
// turn, else the plan item it is on, else what it last did on the screen. Its state (thinking,
// acting, looking) is never the line: dot's pose and the island show that. A wait for the user, an
// error or the end keeps the status caption, and so does a moment the caption names for itself.
export function narrationLine(
  row: StatusRow,
  caption: string,
  model: SessionModel | null,
  t: number,
): string {
  if (!AT_WORK.has(row) || !model) return caption;
  if (row !== "acting" && !STATE_CAPTIONS.has(caption)) return caption;
  return workLine(model, t);
}

function workLine(model: SessionModel, t: number): string {
  const from = turnAt(model, t);
  const own = ownLine(model, t, from);
  const item = planItem(model, t, from);
  const state = agentStateAt(model, t);
  const pondering =
    state?.state === "thinking" &&
    t - state.t >= LONG_THINK_MS &&
    (own?.t ?? Number.NEGATIVE_INFINITY) <= state.t;
  return (
    (pondering ? stillLine(item, own?.text) : undefined) ??
    own?.text ??
    item ??
    actionLine(model, t, from)
  );
}

interface Line {
  text: string;
  t: number;
}

// dot's newest words in this turn: the line it gave its latest call, or the last sentence of what
// it said to the user since.
function ownLine(model: SessionModel, t: number, from: number): Line | undefined {
  let intent: Line | undefined;
  const at = stepAt(model, t);
  for (let i = at ? (model.stepIndex.get(at.id) ?? -1) : -1; i >= 0; i--) {
    const step = model.steps[i];
    if (!step || step.startT < from) break;
    const text = step.intent && plainText(step.intent);
    if (text) {
      intent = { text, t: step.startT };
      break;
    }
  }
  let said: Line | undefined;
  for (let i = model.said.length - 1; i >= 0; i--) {
    const entry = model.said[i];
    if (!entry || entry.t < from || (intent && entry.t <= intent.t)) break;
    const text = entry.t <= t ? lastSentence(entry.text, entry.final) : "";
    if (text) {
      said = { text, t: entry.t };
      break;
    }
  }
  return said ?? intent;
}

function planItem(model: SessionModel, t: number, from: number): string | undefined {
  let items: PlanItemState[] | undefined;
  for (let i = model.plans.length - 1; i >= 0; i--) {
    const plan = model.plans[i];
    if (!plan || plan.t < from) break;
    if (plan.t <= t) {
      items = plan.items;
      break;
    }
  }
  const doing = items?.find((item) => item.status === "doing");
  return (doing && plainText(doing.text)) || undefined;
}

// What dot is doing or last did on the screen, for a turn in which it has said nothing.
function actionLine(model: SessionModel, t: number, from: number): string {
  const n = startedCount(model, t);
  const action = n > 0 ? model.actions[n - 1] : undefined;
  if (!action || action.intentT < from) return "";
  const end = action.cancel?.t ?? action.resultT;
  if (end === undefined || end > t) return progressive(action.label);
  return action.ok && !action.cancel ? past(action.label) : action.label;
}

const STEP_VERBS = new Set(
  (
    "open close find search look check read write draft send reply sign log create make draw " +
    "paint save export download upload install fill enter type pick choose select compare review " +
    "summarize summarise edit update change set add remove delete move copy rename book buy order " +
    "pay get go visit start run test fix build collect gather list share post schedule confirm " +
    "verify finish prepare sort clean organize organise translate calculate convert print attach " +
    "call message email ask tell play record take use try launch load sync turn switch scroll"
  ).split(" "),
);
const ARTICLES = new Set(["the", "a", "an", "your", "my", "this", "that", "some", "each", "all"]);

// The line for a long think: what dot is still working out, from the plan item it is on or the
// line it last gave.
function stillLine(item: string | undefined, line: string | undefined): string | undefined {
  if (item) {
    const first = (item.split(" ", 1)[0] ?? "").toLowerCase();
    if (STEP_VERBS.has(first)) return `Still working out how to ${lowerFirst(item)}`;
    if (first.endsWith("ing")) return `Still ${lowerFirst(item)}`;
    return `Still working on ${ARTICLES.has(first) ? lowerFirst(item) : item}`;
  }
  return line && /^[A-Z][a-z]+ing\b/.test(line) ? `Still ${lowerFirst(line)}` : undefined;
}

const lowerFirst = (text: string) =>
  /^[A-Z][a-z]/.test(text) ? `${text[0]?.toLowerCase()}${text.slice(1)}` : text;

// A line dot gave as plain words on one line.
function plainText(text: string): string {
  return cut(plainLine(text));
}

// The last whole sentence of dot's words as one plain line, cut at a word with an ellipsis when
// long. Words still streaming without a stop may yet go on, so they wait.
export function lastSentence(text: string, closed: boolean): string {
  const lines = text.replace(/```[\s\S]*?(?:```|$)/g, "\n").split("\n");
  const ended = closed || text.endsWith("\n");
  const units: string[] = [];
  lines.forEach((line, index) => {
    const plain = plainLine(line);
    if (!plain) return;
    // Two runs of words can meet without a space: "returns.Checking".
    const parts = plain.split(/(?<=[.!?…]["'”’)\]]*)(?:\s+(?=\S)|(?=[A-Z][a-z]))/);
    const last = index === lines.length - 1 && !ended ? parts.pop() : undefined;
    units.push(...parts);
    if (last && STOP.test(last)) units.push(last);
  });
  return cut(units.at(-1) ?? "");
}

// A runaway line cut at a word, with an ellipsis.
function cut(line: string): string {
  if (line.length <= MAX_CHARS) return line;
  const head = line.slice(0, MAX_CHARS);
  const space = head.lastIndexOf(" ");
  return `${(space > MAX_CHARS / 2 ? head.slice(0, space) : head).replace(/[\s,;:.–—-]+$/, "")}…`;
}

function plainLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("|")) return "";
  return trimmed
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[\s(])[*_]([^*_]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
