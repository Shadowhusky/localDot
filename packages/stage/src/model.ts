import {
  type EventOf,
  type Input,
  type LocalDotEvent,
  microsToMs,
  type Point,
  type PointerPlan,
  sessionMsOf,
  type Target,
} from "@localdot/protocol";

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
}

export interface SessionModel {
  screen: { w: number; h: number; scale: number } | null;
  title: string | null;
  startT: number | null;
  // Every agent.state in log order: a scene at any t reads the state in effect then, so replay
  // equals live (research §4.1).
  agentStates: AgentStateAt[];
  ended: { t: number; reason: string } | null;
  actions: ActionState[];
  lastSeq: number;
  frames: Map<string, string>;
}

export function emptyModel(): SessionModel {
  return {
    screen: null,
    title: null,
    startT: null,
    agentStates: [],
    ended: null,
    actions: [],
    lastSeq: -1,
    frames: new Map(),
  };
}

export function agentStateAt(model: SessionModel, t: number): AgentStateAt | undefined {
  for (let i = model.agentStates.length - 1; i >= 0; i--) {
    const s = model.agentStates[i];
    if (s && s.t <= t) return s;
  }
  return undefined;
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
        if (e.step) model.frames.set(e.step, e.data.frameId);
        break;
      case "session.start":
        model.screen = e.data.screen;
        model.title = e.data.title ?? null;
        model.startT = t;
        break;
      case "session.end":
        model.ended = { t, reason: e.data.reason };
        break;
      case "agent.state":
        model.agentStates.push({ state: e.data.state, t });
        break;
      case "action.intent":
        model.actions.push({
          id: e.id,
          ...(e.step ? { step: e.step } : {}),
          verb: e.data.verb,
          label: e.data.label,
          intentT: t,
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
        if (a)
          a.dispatch = {
            t,
            input: e.data.input,
            pressT: microsToMs(e.data.pressT),
            ringAt: microsToMs(e.data.ringAt),
          };
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
        if (a) a.cancel = { t, reason: e.data.reason };
        break;
      }
      default:
        break;
    }
  }
  return model;
}

function current(model: SessionModel, step: string | undefined): ActionState | undefined {
  if (step) {
    for (let i = model.actions.length - 1; i >= 0; i--) {
      const a = model.actions[i];
      if (a?.step === step) return a;
    }
  }
  return model.actions.at(-1);
}
