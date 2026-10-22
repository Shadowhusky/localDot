import {
  type EventOf,
  type Input,
  type LocalDotEvent,
  microsToMs,
  type Point,
  type PointerPlan,
  type ScreenName,
  type ScreenSwitchData,
  sessionMsOf,
  type Target,
} from "@localdot/protocol";
import { markOf, type TimelineMark } from "./marks.ts";
import { lastSentence } from "./said.ts";

export interface Progress {
  t: number;
  count: number;
  chunk?: string;
  masked: boolean;
}

export interface Dispatch {
  t: number;
  input: Input;
  pressT: number;
  ringAt: number;
}

export interface ActionState {
  id: string;
  step?: string;
  verb: EventOf<"action.intent">["data"]["verb"];
  label: string;
  intentT: number;
  // Kept for stable timeline ordering when events share a timestamp. Optional for old fixtures.
  intentSeq?: number;
  dispatchSeq?: number;
  cancelSeq?: number;
  point?: Point;
  plan?: PointerPlan;
  target?: Target;
  targetT?: number;
  dispatch?: Dispatch;
  progress: Progress[];
  settleT?: number;
  resultT?: number;
  ok?: boolean;
  cancel?: { t: number; reason: string };
}

export interface AgentStateAt {
  state: string;
  t: number;
  reason?: string;
}

// Audit history for the step rail; never drawn on the stage. Request fields stay plain text.
export interface KeyUseState {
  id: string;
  t: number;
  secretId: string;
  host: string;
  method: string;
  path: string;
  decision: "allow" | "deny" | "ask";
}

export interface ObserveAt {
  t: number;
  frameId: string;
  screen?: ScreenName;
  step?: string;
}
export interface StepState {
  id: string;
  kind: string;
  startT: number;
  endT?: number;
  status?: string;
  planItem?: string;
  // dot's line for the user about the call this step starts.
  intent?: string;
  // The tool the step runs and its title (a command, "write notes.md"), from tool.start.
  tool?: string;
  title?: string;
  // When its output arrived, at most one time per OUTPUT_GAP_MS and OUTPUT_CAP times in all.
  outputs?: number[];
}
// What dot has said to the user, by message: the tail of its words, and each sentence it finished
// with when, so a moment in Replay shows the line the live band showed then.
export interface SaidState {
  id: string;
  text: string;
  final: boolean;
  lines: SaidLine[];
}
export interface SaidLine {
  t: number;
  text: string;
}
// A sub-agent dot started: when it ran, and whether its work went well once it ended.
export interface SubagentRun {
  runId: string;
  startT: number;
  endT?: number;
  ok?: boolean;
}
export interface PlanItemState {
  id: string;
  text: string;
  status: string;
}
export interface PlanSnapshot {
  t: number;
  items: PlanItemState[];
}

export interface SessionModel {
  screenChanges: (ScreenSwitchData & { t: number; firstAction: number })[];
  screen: { w: number; h: number; scale: number } | null;
  title: string | null;
  startT: number | null;
  // Every agent.state in log order: a scene at any t reads the state in effect then, so replay
  // equals live (research §4.1).
  agentStates: AgentStateAt[];
  ended: { t: number; reason: string } | null;
  actions: ActionState[];
  keyUses: KeyUseState[];
  lastSeq: number;
  frames: Map<string, string>;
  observes: ObserveAt[];
  steps: StepState[];
  plans: PlanSnapshot[];
  subagents: SubagentRun[];
  said: SaidState[];
  // When the user gave dot a task or a follow-up: each starts a turn of work.
  turns: number[];
  marks: TimelineMark[];
  byStep: Map<string, number>;
  stepIndex: Map<string, number>;
}

const OUTPUT_GAP_MS = 120;
const OUTPUT_CAP = 400;

export function emptyModel(): SessionModel {
  return {
    screenChanges: [],
    screen: null,
    title: null,
    startT: null,
    agentStates: [],
    ended: null,
    actions: [],
    keyUses: [],
    lastSeq: -1,
    frames: new Map(),
    observes: [],
    steps: [],
    plans: [],
    subagents: [],
    said: [],
    turns: [],
    marks: [],
    byStep: new Map(),
    stepIndex: new Map(),
  };
}

// Only a message's last sentence is ever shown, so only its tail is kept.
const SAID_TAIL = 600;

// EventLog stamps nondecreasing session times; equal times resolve to the last entry.
function upperBound<T>(items: T[], t: number, time: (item: T) => number): number {
  let lo = 0,
    hi = items.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const item = items[mid];
    if (item === undefined) throw new RangeError("sparse replay index");
    if (time(item) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const intentTime = (a: ActionState) => a.intentT;
const atTime = (a: { t: number }) => a.t;
const stepTime = (s: StepState) => s.startT;
const observationIndexes = new WeakMap<
  SessionModel,
  {
    source: ObserveAt[];
    count: number;
    desktop: ObserveAt[];
    browser: ObserveAt[];
  }
>();
export function screenAt(
  model: SessionModel,
  t: number,
): SessionModel["screenChanges"][number] | undefined {
  return model.screenChanges[upperBound(model.screenChanges, t, atTime) - 1];
}
export function startedCount(model: SessionModel, t: number): number {
  return upperBound(model.actions, t, intentTime);
}
export function observeAt(
  model: SessionModel,
  t: number,
  screen?: ScreenName,
): ObserveAt | undefined {
  if (screen === undefined) return model.observes[upperBound(model.observes, t, atTime) - 1];
  let index = observationIndexes.get(model);
  if (!index || index.source !== model.observes || index.count > model.observes.length) {
    index = { source: model.observes, count: 0, desktop: [], browser: [] };
    observationIndexes.set(model, index);
  }
  // The event model is append-only. Build once per model/worker, then extend as live history arrives.
  // An inactive track must not scan the whole log on every exported frame.
  while (index.count < model.observes.length) {
    const observation = model.observes[index.count++];
    if (observation) index[observation.screen ?? "desktop"].push(observation);
  }
  const observations = index[screen];
  return observations[upperBound(observations, t, atTime) - 1];
}
export function stepAt(model: SessionModel, t: number): StepState | undefined {
  return model.steps[upperBound(model.steps, t, stepTime) - 1];
}
export function planAt(model: SessionModel, t: number): PlanItemState[] {
  return model.plans[upperBound(model.plans, t, atTime) - 1]?.items ?? [];
}
export function agentStateAt(model: SessionModel, t: number): AgentStateAt | undefined {
  return model.agentStates[upperBound(model.agentStates, t, atTime) - 1];
}
// When the turn of work in progress at t began: the user's latest task or follow-up.
export function turnAt(model: SessionModel, t: number): number {
  return model.turns[upperBound(model.turns, t, (turn) => turn) - 1] ?? Number.NEGATIVE_INFINITY;
}

// Mutates and returns `model`; events already folded (seq ≤ lastSeq) are skipped, so a stream
// that replays its backlog is harmless.
export function foldEvents(model: SessionModel, events: Iterable<LocalDotEvent>): SessionModel {
  for (const e of events) {
    if (e.seq <= model.lastSeq) continue;
    model.lastSeq = e.seq;
    const t = sessionMsOf(e);
    switch (e.type) {
      case "observe":
        model.observes.push({
          t,
          frameId: e.data.frameId,
          screen: model.screenChanges.at(-1)?.screen ?? "desktop",
          ...(e.step ? { step: e.step } : {}),
        });
        if (e.step) model.frames.set(e.step, e.data.frameId);
        break;
      case "step.start":
        if (e.step) {
          model.stepIndex.set(e.step, model.steps.length);
          model.steps.push({
            id: e.step,
            kind: e.data.kind,
            startT: t,
            ...(e.data.planItem !== undefined ? { planItem: e.data.planItem } : {}),
            ...(e.data.intent ? { intent: e.data.intent } : {}),
          });
        }
        break;
      case "step.end": {
        const index = e.step ? model.stepIndex.get(e.step) : undefined;
        const step = index === undefined ? undefined : model.steps[index];
        if (step) {
          step.endT = t;
          step.status = e.data.status;
        }
        break;
      }
      case "tool.start": {
        const step = stepOf(model, e.step);
        if (step) {
          step.tool = e.data.tool;
          step.title = e.data.title;
        }
        const mark = markOf(e);
        if (mark) model.marks.push(mark);
        break;
      }
      case "tool.output": {
        const step = stepOf(model, e.step);
        if (!step) break;
        step.outputs ??= [];
        const outputs = step.outputs;
        const last = outputs.at(-1);
        if (outputs.length < OUTPUT_CAP && (last === undefined || t - last >= OUTPUT_GAP_MS))
          outputs.push(t);
        break;
      }
      case "plan.set":
        model.plans.push({ t, items: e.data.items.map((item) => ({ ...item })) });
        break;
      case "message.user": {
        if (e.data.kind !== "steer") model.turns.push(t);
        const mark = markOf(e);
        if (mark) model.marks.push(mark);
        break;
      }
      case "message.delta":
      case "message.assistant": {
        const said = model.said.findLast((entry) => entry.id === e.data.messageId);
        if (said?.final) break;
        const final = e.type === "message.assistant";
        const text = (final ? e.data.text : (said?.text ?? "") + e.data.text).slice(-SAID_TAIL);
        const entry = said ?? { id: e.data.messageId, text, final, lines: [] };
        if (said) Object.assign(said, { text, final });
        else model.said.push(entry);
        const line = lastSentence(text, final);
        if (line && line !== entry.lines.at(-1)?.text) entry.lines.push({ t, text: line });
        const mark = markOf(e);
        if (mark) model.marks.push(mark);
        break;
      }
      case "plan.update":
        model.plans.push({
          t,
          items: (model.plans.at(-1)?.items ?? []).map((item) => ({
            ...item,
            ...(item.id === e.data.id ? { status: e.data.status } : {}),
          })),
        });
        break;
      case "session.start":
        model.screen = e.data.screen;
        model.title = e.data.title ?? null;
        model.startT = t;
        break;
      case "screen.switch":
        model.screenChanges.push({ ...e.data, t, firstAction: model.actions.length });
        break;
      case "session.end":
        model.ended = { t, reason: e.data.reason };
        break;
      case "subagent.state": {
        const run = model.subagents.findLast((s) => s.runId === e.data.runId);
        if (e.data.state === "running") {
          if (!run) model.subagents.push({ runId: e.data.runId, startT: t });
        } else if (run && run.endT === undefined) {
          run.endT = t;
          run.ok = e.data.state === "completed";
        }
        const mark = markOf(e);
        if (mark) model.marks.push(mark);
        break;
      }
      case "agent.state":
        model.agentStates.push({
          state: e.data.state,
          t,
          ...(e.data.reason === undefined ? {} : { reason: e.data.reason }),
        });
        break;
      case "key.use": {
        model.keyUses.push({ id: e.id, t, ...e.data });
        // Existing audit history is retained, and replay needs its timeline marker as well.
        const mark = markOf(e);
        if (mark) model.marks.push(mark);
        break;
      }
      case "action.intent":
        if (e.step) model.byStep.set(e.step, model.actions.length);
        model.actions.push({
          id: e.id,
          ...(e.step ? { step: e.step } : {}),
          verb: e.data.verb,
          label: e.data.label,
          intentT: t,
          intentSeq: e.seq,
          ...(e.data.point ? { point: e.data.point } : {}),
          ...(e.data.pointer ? { plan: e.data.pointer } : {}),
          progress: [],
        });
        break;
      case "action.target": {
        const a = current(model, e.step);
        if (a) {
          a.target = e.data.target;
          a.targetT = t;
        }
        break;
      }
      case "action.dispatch": {
        const a = current(model, e.step);
        if (a) {
          a.dispatchSeq = e.seq;
          a.dispatch = {
            t,
            input: e.data.input,
            pressT: microsToMs(e.data.pressT),
            ringAt: microsToMs(e.data.ringAt),
          };
        }
        break;
      }
      case "text.progress": {
        const a = current(model, e.step);
        if (a)
          a.progress.push({
            t,
            count: e.data.count,
            masked: e.data.masked,
            ...(e.data.chunk !== undefined ? { chunk: e.data.chunk } : {}),
          });
        break;
      }
      case "screen.settle": {
        const a = current(model, e.step);
        if (a) a.settleT = t;
        break;
      }
      case "action.result": {
        const a = current(model, e.step);
        if (a) {
          a.resultT = t;
          a.ok = e.data.ok;
        }
        break;
      }
      case "action.cancel": {
        const a = current(model, e.step);
        if (a) {
          a.cancelSeq = e.seq;
          a.cancel = { t, reason: e.data.reason };
        }
        break;
      }
      default: {
        const mark = markOf(e);
        if (mark) model.marks.push(mark);
        break;
      }
    }
  }
  return model;
}

function stepOf(model: SessionModel, id: string | undefined): StepState | undefined {
  const index = id ? model.stepIndex.get(id) : undefined;
  return index === undefined ? undefined : model.steps[index];
}

function current(model: SessionModel, step: string | undefined): ActionState | undefined {
  const index = step ? model.byStep.get(step) : undefined;
  return index === undefined ? model.actions.at(-1) : model.actions[index];
}
