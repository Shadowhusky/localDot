import {
  agentStateAt,
  type PlanItemState,
  plainText,
  type SessionModel,
  startedCount,
  stepAt,
  turnAt,
} from "@localdot/stage";
import { past, progressive, STATE_CAPTIONS, type StatusRow } from "../session/status.ts";

// Rows where dot is at work: its words say what it is doing, never a word for its state.
const AT_WORK = new Set<StatusRow>(["acting", "working", "thinking", "observing"]);
export const atWork = (row: StatusRow) => AT_WORK.has(row);
// Thinking this long with nothing new to say, dot says what it is still working out.
export const LONG_THINK_MS = 6000;
// Each line stays at least this long, time to read it, so a quick run of steps never flickers.
export const LINE_HOLD_MS = 1500;

// The band's line. While dot works: its newest own words in this turn (the line it gave its latest
// call, or the last sentence it said), unless it has since moved on to a plan item, then the plan
// item it is on, else what it last did on the screen. Its state (thinking,
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
  // A plan item dot moved on to after its last line is newer news than that line.
  const newest = item && own && item.t > own.t ? item : (own ?? item);
  return (
    (pondering ? stillLine(item?.text, own?.text) : undefined) ??
    newest?.text ??
    actionLine(model, t, from)
  );
}

interface Line {
  text: string;
  t: number;
}

// dot's newest words in this turn: the line it gave its latest call, or the last sentence it
// finished saying to the user since.
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
  for (let i = model.said.length - 1; i >= 0; i--) {
    const line = model.said[i]?.lines.findLast((entry) => entry.t <= t);
    if (!line) continue;
    if (line.t < from || (intent && line.t <= intent.t)) break;
    return line;
  }
  return intent;
}

// The plan item dot is on in this turn, and when it started on it.
function planItem(model: SessionModel, t: number, from: number): Line | undefined {
  let index = -1;
  for (let i = model.plans.length - 1; i >= 0; i--) {
    const plan = model.plans[i];
    if (!plan || plan.t < from) break;
    if (plan.t <= t) {
      index = i;
      break;
    }
  }
  const doing = doingIn(model.plans[index]?.items);
  const text = doing && plainText(doing.text);
  if (!doing || !text) return undefined;
  let since = model.plans[index]?.t ?? t;
  for (let i = index - 1; i >= 0; i--) {
    const plan = model.plans[i];
    const earlier = doingIn(plan?.items);
    if (!plan || plan.t < from || earlier?.id !== doing.id || earlier.text !== doing.text) break;
    since = plan.t;
  }
  return { text, t: since };
}

const doingIn = (items: PlanItemState[] | undefined) =>
  items?.find((item) => item.status === "doing");

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
    const first = firstWord(item);
    if (STEP_VERBS.has(first)) return `Still working out how to ${lowerFirst(item)}`;
    if (doingWord(first)) return `Still ${lowerFirst(item)}`;
    return `Still working on ${ARTICLES.has(first) ? lowerFirst(item) : item}`;
  }
  return line && doingWord(firstWord(line)) ? `Still ${lowerFirst(line)}` : undefined;
}

const firstWord = (text: string) => (/^[A-Za-z]+/.exec(text)?.[0] ?? "").toLowerCase();

// "Checking", "writing", "running": a step verb's -ing form, not any word ending in -ing
// ("Morning", "Spring").
function doingWord(word: string): boolean {
  if (!word.endsWith("ing")) return false;
  const stem = word.slice(0, -3);
  return (
    STEP_VERBS.has(stem) ||
    STEP_VERBS.has(`${stem}e`) ||
    (/([^aeiou])\1$/.test(stem) && STEP_VERBS.has(stem.slice(0, -1)))
  );
}

const lowerFirst = (text: string) =>
  /^[A-Z][a-z]/.test(text) ? `${text[0]?.toLowerCase()}${text.slice(1)}` : text;
