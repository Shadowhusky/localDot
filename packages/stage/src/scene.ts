import {
  clipText,
  keyDisplayName,
  type LocalDotEvent,
  msToSeconds,
  type Point,
  type Rect,
} from "@localdot/protocol";
import {
  type ActionState,
  agentStateAt,
  emptyModel,
  foldEvents,
  type SessionModel,
} from "./model.ts";
import { pointerAt } from "./pointer-path.ts";
import { springValue } from "./spring.ts";
import {
  CANCEL_SHAKE_MS,
  CARET_PERIOD_MS,
  CHIP_FADE_MS,
  CHIP_SHOW_MS,
  CURSOR_DIM_AFTER_MS,
  CURSOR_HIDE_AFTER_MS,
  DOUBLE_CLICK_GAP_MS,
  KEYCAP_FADE_MS,
  KEYCAP_IN_MS,
  KEYCAP_LINGER_MS,
  PRESS_MS,
  RING_FADE_MS,
  TARGET_FADE_MS,
  TARGET_HOLD_MS,
  TARGET_IN_MS,
  TARGET_SPRING,
  TYPING_HOLD_MS,
} from "./timing.ts";

export const CURSOR_NAME = "dot";
const CROSSHAIR_PX = 36;
const FADE_MS = 180;
const RELEASE_MS = 150;
const REDUCED_FADE_MS = 120;
const INSTANT_FADE_MS = 150;
const CANCEL_CHIP_MS = 1500;
const PILL_MAX = 60;
const CLICKABLE = new Set([
  "button",
  "link",
  "push button",
  "menu item",
  "check box",
  "radio button",
  "toggle button",
  "tab",
  "page tab",
  "menu",
]);
const KEYCAP_RISE_PX = 20;

export interface View {
  reducedMotion: boolean;
}

export interface CursorScene {
  x: number;
  y: number;
  visible: boolean;
  alpha: number;
  press: number;
  hand: boolean;
  chipAlpha: number;
  name: string;
  floating: boolean;
}

export interface TargetScene {
  style: "acting" | "looking";
  rect: Rect | null;
  point: Point;
  alpha: number;
  chip?: string;
}

export interface RingScene {
  x: number;
  y: number;
  p: number;
  style: "left" | "right";
}

export interface TypingScene {
  anchor: Point;
  text: string;
  more: number;
  masked: boolean;
  caretOn: boolean;
  alpha: number;
}

export interface KeycapsScene {
  keys: string[];
  alpha: number;
  scale: number;
  dy: number;
}

export interface CancelScene {
  x: number;
  y: number;
  dx: number;
  reason: string;
  alpha: number;
}

export interface HudScene {
  label: string;
  state: "idle" | "working" | "done" | "stopped" | "error";
  control: boolean;
  elapsedMs: number;
}

export interface Scene {
  control: boolean;
  cursor: CursorScene | null;
  target: TargetScene | null;
  rings: RingScene[];
  typing: TypingScene | null;
  keycaps: KeycapsScene | null;
  cancel: CancelScene | null;
  hud: HudScene;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const ended = (a: ActionState) => a.cancel?.t ?? a.resultT;
const planEnd = (a: ActionState) => (a.plan ? a.plan.startsAt + a.plan.durationMs : a.intentT);

export function keycapNames(combo: string[]): string[] {
  return combo.slice(0, 5).map(keyDisplayName);
}

export function render(log: LocalDotEvent[], tMs: number, view: View): Scene {
  return sceneAt(foldEvents(emptyModel(), log), tMs, view);
}

export function sceneAt(model: SessionModel, t: number, view: View): Scene {
  if (!Number.isFinite(t)) throw new RangeError("scene time must be finite");
  const started = model.actions.filter((a) => a.intentT <= t);
  const current = started.at(-1);
  const control = controlAt(model, t);
  return {
    control,
    cursor: cursorAt(model, started, current, t, view, control),
    target: current ? targetAt(current, t, view) : null,
    rings: ringsAt(started, t),
    typing: current ? typingAt(current, t, view) : null,
    keycaps: current ? keycapsAt(current, t, view) : null,
    cancel: current ? cancelAt(current, started, t, view) : null,
    hud: hudAt(model, current, t, control),
  };
}

function controlAt(model: SessionModel, t: number): boolean {
  if (model.ended && model.ended.t <= t) return false;
  const s = agentStateAt(model, t)?.state;
  return s === "acting" || s === "observing" || s === "thinking";
}

// Where the cursor rests after an action: its dispatch point, or where a cancel froze it.
function restingPoint(a: ActionState | undefined): Point | undefined {
  if (a?.plan) return a.cancel ? pointerAt(a.plan, a.cancel.t) : a.plan.to;
  return a?.point;
}

function cursorAt(
  model: SessionModel,
  started: ActionState[],
  current: ActionState | undefined,
  t: number,
  view: View,
  control: boolean,
): CursorScene | null {
  if (!current) return null;
  let pos: Point | undefined;
  let floating = false;
  for (const a of started) {
    const p = a === current && a.plan ? positionOnPlan(a, t, view) : restingPoint(a);
    if (p) pos = p;
  }
  if (!pos) return null;
  const idleSince = current.cancel?.t ?? current.resultT;
  const state = agentStateAt(model, t);
  const thinking = state?.state === "thinking";
  // Resting (research §4.5): dimmed and floating while thinking, or after 1.2 s with nothing to do.
  const restSince = Math.min(
    thinking && state ? state.t : Number.POSITIVE_INFINITY,
    idleSince === undefined ? Number.POSITIVE_INFINITY : idleSince + CURSOR_DIM_AFTER_MS,
  );
  let alpha = 1;
  if (t > restSince) alpha = 0.7;
  if (t > restSince && !view.reducedMotion) {
    floating = true;
    const phase = (2 * Math.PI * (t - restSince)) / 4000;
    pos = { x: pos.x + 2.5 * Math.sin(phase), y: pos.y + 3 * Math.cos(phase) - 2.5 };
  }
  const hideAt = idleSince === undefined ? undefined : idleSince + CURSOR_HIDE_AFTER_MS;
  const lostControlAt = model.ended?.t;
  const fadeStart = Math.min(
    hideAt ?? Number.POSITIVE_INFINITY,
    lostControlAt ?? Number.POSITIVE_INFINITY,
  );
  if (t >= fadeStart) {
    alpha *= 1 - clamp01((t - fadeStart) / FADE_MS);
    if (alpha <= 0)
      return {
        x: pos.x,
        y: pos.y,
        visible: false,
        alpha: 0,
        press: 0,
        hand: false,
        chipAlpha: 0,
        name: CURSOR_NAME,
        floating: false,
      };
  }
  if (current.plan && (view.reducedMotion || current.plan.durationMs === 0))
    alpha *= crossfadeAlpha(current, t, view.reducedMotion ? REDUCED_FADE_MS : INSTANT_FADE_MS);
  const press = pressAt(current, t, view);
  const chipSince = t - current.intentT;
  const chipAlpha =
    chipSince < CHIP_SHOW_MS ? 1 : 1 - clamp01((chipSince - CHIP_SHOW_MS) / CHIP_FADE_MS);
  const arrived = current.plan ? t >= planEnd(current) : true;
  const hand = arrived && CLICKABLE.has(current.target?.role ?? "") && control;
  return {
    x: pos.x,
    y: pos.y,
    visible: true,
    alpha,
    press,
    hand,
    chipAlpha,
    name: CURSOR_NAME,
    floating,
  };
}

// Reduced motion: no travel, a 120 ms cross-fade at departure and at arrival (apple-design §14).
// Instant (a plan with durationMs 0, spec "Timing"): no travel either; the cursor appears at the
// target and fades in over 150 ms, the research's fade-teleport (§4.3).
function positionOnPlan(a: ActionState, t: number, view: View): Point {
  const plan = a.plan as NonNullable<ActionState["plan"]>;
  const stop = a.cancel ? Math.min(t, a.cancel.t) : t;
  if (!view.reducedMotion && plan.durationMs > 0) return pointerAt(plan, stop);
  return stop < planEnd(a) ? { x: plan.from.x, y: plan.from.y } : { x: plan.to.x, y: plan.to.y };
}

function crossfadeAlpha(a: ActionState, t: number, fadeMs: number): number {
  const plan = a.plan as NonNullable<ActionState["plan"]>;
  const out = clamp01((t - plan.startsAt) / fadeMs);
  const inn = clamp01((t - planEnd(a)) / fadeMs);
  if (t < plan.startsAt) return 1;
  if (t < planEnd(a)) return 1 - out;
  return inn;
}

// Squash 0.85 over 80 ms ending at the raw press, spring back over 150 ms; replay sees all of it,
// the live view joins once the dispatch arrives.
function pressAt(a: ActionState, t: number, view: View): number {
  const d = a.dispatch;
  if (!d || d.input.kind === "type" || d.input.kind === "key" || d.input.kind === "wait") return 0;
  if (view.reducedMotion) return 0;
  if (t < d.pressT - PRESS_MS) return 0;
  if (t <= d.pressT) return clamp01((t - (d.pressT - PRESS_MS)) / PRESS_MS);
  return 1 - clamp01((t - d.pressT) / RELEASE_MS);
}

function targetAt(a: ActionState, t: number, view: View): TargetScene | null {
  const point = a.target?.point ?? a.point;
  if (!point || t < a.intentT) return null;
  const holdFrom = a.dispatch?.t ?? ended(a);
  if (holdFrom !== undefined && t >= holdFrom + TARGET_HOLD_MS + TARGET_FADE_MS) return null;
  let alpha = clamp01((t - a.intentT) / TARGET_IN_MS);
  if (holdFrom !== undefined && t > holdFrom + TARGET_HOLD_MS)
    alpha *= 1 - clamp01((t - holdFrom - TARGET_HOLD_MS) / TARGET_FADE_MS);
  const bbox = a.target?.bbox;
  const known = bbox && a.targetT !== undefined && t >= a.targetT;
  let rect: Rect | null = null;
  if (known) {
    const from: Rect = {
      x: point.x - CROSSHAIR_PX / 2,
      y: point.y - CROSSHAIR_PX / 2,
      w: CROSSHAIR_PX,
      h: CROSSHAIR_PX,
    };
    const s = msToSeconds(t - (a.targetT as number));
    const morph = (k: keyof Rect) =>
      view.reducedMotion ? bbox[k] : springValue(from[k], bbox[k], 0, s, TARGET_SPRING);
    rect = { x: morph("x"), y: morph("y"), w: morph("w"), h: morph("h") };
  }
  const chip =
    known && (a.target?.role || a.target?.name)
      ? clipText([a.target?.role, a.target?.name].filter(Boolean).join(" · "), 32)
      : undefined;
  return { style: "acting", rect, point, alpha, ...(chip ? { chip } : {}) };
}

function ringsAt(started: ActionState[], t: number): RingScene[] {
  const rings: RingScene[] = [];
  for (const a of started) {
    const d = a.dispatch;
    if (d?.input.kind !== "click") continue;
    const style = d.input.button === "right" ? "right" : "left";
    for (let i = 0; i < d.input.count; i++) {
      const at = d.ringAt + i * DOUBLE_CLICK_GAP_MS;
      if (t >= at && t < at + RING_FADE_MS)
        rings.push({ x: d.input.at.x, y: d.input.at.y, p: (t - at) / RING_FADE_MS, style });
    }
  }
  return rings;
}

function typingAt(a: ActionState, t: number, view: View): TypingScene | null {
  const d = a.dispatch;
  if (d?.input.kind !== "type" || t < d.ringAt) return null;
  const shown = a.progress.filter((p) => p.t <= t);
  const last = shown.at(-1);
  // One rule: the pill stays while the action runs and for TYPING_HOLD_MS after whichever came
  // last, the action's end or the last progress line.
  const stop = ended(a);
  if (stop !== undefined && t > Math.max(stop, last?.t ?? 0) + TYPING_HOLD_MS) return null;
  const count = last?.count ?? 0;
  const text = d.input.masked ? "•".repeat(count) : shown.map((p) => p.chunk ?? "").join("");
  const chars = [...text];
  const more = Math.max(0, chars.length - PILL_MAX);
  const caretOn = view.reducedMotion
    ? true
    : Math.floor((t - d.t) / (CARET_PERIOD_MS / 2)) % 2 === 0;
  const anchor = a.target?.bbox
    ? { x: a.target.bbox.x, y: a.target.bbox.y }
    : (a.target?.point ?? a.point ?? { x: 0, y: 0 });
  return {
    anchor,
    text: chars.slice(-PILL_MAX).join(""),
    more,
    masked: d.input.masked,
    caretOn,
    alpha: 1,
  };
}

function keycapsAt(a: ActionState, t: number, view: View): KeycapsScene | null {
  const d = a.dispatch;
  if (d?.input.kind !== "key" || t < d.ringAt) return null;
  const since = t - d.ringAt;
  if (since > KEYCAP_IN_MS + KEYCAP_LINGER_MS + KEYCAP_FADE_MS) return null;
  const inn = clamp01(since / KEYCAP_IN_MS);
  const scale = view.reducedMotion ? 1 : lerp(0.5, 1, inn);
  const dy = view.reducedMotion ? 0 : lerp(KEYCAP_RISE_PX, 0, inn);
  const alpha =
    since <= KEYCAP_IN_MS + KEYCAP_LINGER_MS
      ? inn
      : 1 - clamp01((since - KEYCAP_IN_MS - KEYCAP_LINGER_MS) / KEYCAP_FADE_MS);
  return { keys: keycapNames(d.input.combo), alpha, scale, dy };
}

function cancelAt(
  a: ActionState,
  started: ActionState[],
  t: number,
  view: View,
): CancelScene | null {
  if (!a.cancel || t < a.cancel.t || t > a.cancel.t + CANCEL_CHIP_MS) return null;
  const since = t - a.cancel.t;
  const pos = restingPoint(a) ?? restingPoint(started.at(-2)) ?? { x: 0, y: 0 };
  const dx =
    view.reducedMotion || since > CANCEL_SHAKE_MS
      ? 0
      : 5 * Math.sin((2 * Math.PI * 2 * since) / CANCEL_SHAKE_MS);
  return {
    x: pos.x,
    y: pos.y,
    dx,
    reason: a.cancel.reason,
    alpha: 1 - clamp01((since - CANCEL_CHIP_MS + 300) / 300),
  };
}

function hudAt(
  model: SessionModel,
  current: ActionState | undefined,
  t: number,
  control: boolean,
): HudScene {
  const elapsedMs = model.startT === null ? 0 : Math.max(0, t - model.startT);
  if (model.ended && model.ended.t <= t) {
    return {
      label: current?.label ?? "",
      state:
        model.ended.reason === "done"
          ? "done"
          : model.ended.reason === "stopped"
            ? "stopped"
            : "error",
      control: false,
      elapsedMs,
    };
  }
  const working = current !== undefined && ended(current) === undefined;
  const thinking = agentStateAt(model, t)?.state === "thinking";
  return {
    label: current?.label ?? (thinking ? "Thinking…" : ""),
    state: working || control ? "working" : "idle",
    control,
    elapsedMs,
  };
}
