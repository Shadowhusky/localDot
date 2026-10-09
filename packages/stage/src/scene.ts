import {
  type Input,
  keyDisplayName,
  type LocalDotEvent,
  type Point,
  type Rect,
  type ScreenName,
} from "@localdot/protocol";
import { type MotionSample, motionSamples } from "@localdot/protocol/motion";
import {
  type ActionState,
  agentStateAt,
  emptyModel,
  foldEvents,
  type SessionModel,
  screenAt,
  startedCount,
} from "./model.ts";
import { glideAt, pointerAt } from "./pointer-path.ts";
import { type SpringStep, springProgress, springTrack } from "./spring.ts";
import {
  CANCEL_SHAKE_MS,
  CARET_PERIOD_MS,
  CHIP_FADE_MS,
  CHIP_IN_MS,
  CHIP_SHOW_MS,
  CLICK_HOLD_MS,
  CURSOR_HIDE_AFTER_MS,
  CURSOR_LEAN_MAX_DEG,
  DISC_FADE_MS,
  DRAG_FADE_MS,
  DRAG_TAIL_MS,
  FADE_IN_MS,
  FADE_OUT_MS,
  KEYCAP_FADE_MS,
  KEYCAP_IN_MS,
  KEYCAP_LINGER_MS,
  KEYCAP_SPRING,
  LEAN_SPRING,
  PRESS_SPRING,
  REDUCED_CURSOR_IN_MS,
  REDUCED_CURSOR_OUT_MS,
  REDUCED_FADE_MS,
  REDUCED_RING_PX,
  RELEASE_SPRING,
  RIGHT_CLICK_CHIP_MS,
  RIGHT_RIPPLE_TO,
  RING_FADE_MS,
  RIPPLE_FROM,
  RIPPLE_GAP_MS,
  RIPPLE_SPRING,
  RIPPLE_TO,
  SCROLL_FADE_MS,
  SCROLL_NUDGE_PX,
  SCROLL_SPRING,
  SCROLL_STEP_MS,
  TARGET_FADE_MS,
  TARGET_HOLD_MS,
  TARGET_SPRING,
  TYPING_HOLD_MS,
  TYPING_MAX_CHARS,
  TYPING_OUT_MS,
  TYPING_SPRING,
} from "./timing.ts";

export const CURSOR_NAME = "dot";
export const RING_LOOKBACK = 8;
export interface SceneOptions {
  ringLookback?: number;
}
const FADE_MS = 180;
const CANCEL_CHIP_MS = 1500;
// desktopd starts a drag's motion this long after its press.
const DRAG_PRESS_MS = 50;
const SCROLL_STEPS_SHOWN = 8;
const KEYCAP_RISE_PX = 8;
const TYPING_RISE_PX = 4;
const TARGET_FROM_SCALE = 1.06;
const TARGET_TO_SCALE = 1.02;
const RIPPLE_ALPHA = 0.6;

export interface View {
  reducedMotion: boolean;
  screen?: ScreenName;
  screenRevision?: number;
}

export interface CursorScene {
  x: number;
  y: number;
  visible: boolean;
  alpha: number;
  // How far a held button has pressed the hand in: 0 up, 1 fully down.
  press: number;
  // Radians, positive leaning right.
  lean: number;
  chipAlpha: number;
  name: string;
}

// A known element's box, or only the point dot aims at.
export interface TargetScene {
  rect: Rect | null;
  point: Point;
  alpha: number;
  scale: number;
}

// The disc under the hotspot while a button is down.
export interface PressScene {
  x: number;
  y: number;
  scale: number;
  alpha: number;
}

// A release ripple; `d` is its diameter in CSS px.
export interface RingScene {
  x: number;
  y: number;
  d: number;
  alpha: number;
  style: "left" | "right";
}

export interface TypingScene {
  anchor: Point;
  field: Rect | null;
  text: string;
  more: number;
  masked: boolean;
  caretOn: boolean;
  alpha: number;
  dy: number;
}

export interface KeycapsScene {
  keys: string[];
  alpha: number;
  scale: number;
  dy: number;
}

export interface DragScene {
  // The way a held button has gone so far, in desktop device px, and how long ago it reached each
  // point.
  points: Point[];
  ages: number[];
  alpha: number;
}

export interface ScrollScene {
  x: number;
  y: number;
  direction: "up" | "down" | "left" | "right";
  nudge: number;
  alpha: number;
}

export interface CancelScene {
  x: number;
  y: number;
  dx: number;
  text: string;
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
  press: PressScene | null;
  rings: RingScene[];
  drag: DragScene | null;
  typing: TypingScene | null;
  keycaps: KeycapsScene | null;
  scroll: ScrollScene | null;
  cancel: CancelScene | null;
  hud: HudScene;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ended = (a: ActionState) => a.cancel?.t ?? a.resultT;
const planEnd = (a: ActionState) => (a.plan ? a.plan.startsAt + a.plan.durationMs : a.intentT);
const fadeOut = (t: number, from: number, ms: number) => 1 - clamp01((t - from) / ms);

export function keycapNames(combo: string[]): string[] {
  return combo.slice(0, 5).map((key) => {
    const name = keyDisplayName(key);
    return name === "Super" ? "⌘" : name;
  });
}

// A drawn segment's opacity by how long ago the pointer passed it: full for the last 600 ms, then
// down to .15 over the next 600 ms.
export function dragSegmentAlpha(ageMs: number): number {
  return 0.85 - 0.7 * clamp01((ageMs - DRAG_TAIL_MS) / DRAG_TAIL_MS);
}

export function render(log: LocalDotEvent[], tMs: number, view: View): Scene {
  return sceneAt(foldEvents(emptyModel(), log), tMs, view);
}

export function sceneAt(
  model: SessionModel,
  t: number,
  view: View,
  opts: SceneOptions = {},
): Scene {
  if (!Number.isFinite(t)) throw new RangeError("scene time must be finite");
  const n = startedCount(model, t);
  const selected = screenAt(model, t);
  const matches =
    (view.screen === undefined || view.screen === (selected?.screen ?? "desktop")) &&
    (view.screenRevision === undefined || view.screenRevision === (selected?.revision ?? 0));
  const first = matches ? (selected?.firstAction ?? 0) : n;
  const current = n > first ? model.actions[n - 1] : undefined;
  const lookback = opts.ringLookback ?? RING_LOOKBACK;
  if (lookback !== Number.POSITIVE_INFINITY && !(Number.isInteger(lookback) && lookback >= 0))
    throw new RangeError("ring lookback must be a nonnegative integer or Infinity");
  const control = controlAt(model, t);
  const drag = dragAt(model, n, current, t, view, first);
  const cancel = current
    ? cancelAt(current, n - 2 >= first ? model.actions[n - 2] : undefined, t, view)
    : null;
  const gesture = gestureAt(model, n, t, first);
  const cursor = cursorAt(model, n, current, t, view, first, drag?.head, gesture, cancel);
  return {
    control,
    cursor,
    target: current ? targetAt(current, t, view) : null,
    press: cursor?.visible && gesture ? discAt(gesture, cursor, t, view) : null,
    rings: ringsAt(model, n, t, lookback, first, view),
    drag: drag && { points: drag.points, ages: drag.ages, alpha: drag.alpha },
    typing: current ? typingAt(current, t, view) : null,
    keycaps: current ? keycapsAt(current, t, view) : null,
    scroll: scrollAt(model, n, t, view, first),
    cancel,
    hud: hudAt(model, current, t, control),
  };
}

function controlAt(model: SessionModel, t: number): boolean {
  if (model.ended && model.ended.t <= t) return false;
  const s = agentStateAt(model, t)?.state;
  return s === "acting" || s === "observing" || s === "thinking";
}

// When a one-step drag lets go: its motion's end, or where it was stopped.
function dropT(a: ActionState, input: Extract<Input, { kind: "drag" }>): number {
  const press = a.dispatch?.pressT ?? a.intentT;
  const motionMs = samplesFor(input).at(-1)?.t ?? input.durationMs;
  const drop = press + DRAG_PRESS_MS + motionMs;
  return a.cancel ? Math.min(a.cancel.t, drop) : drop;
}

// Where the cursor rests after an action: its dispatch point, or where a cancel froze it. A drag
// rests at its drop, or where it was stopped.
function restingPoint(a: ActionState | undefined): Point | undefined {
  const input = a?.dispatch?.input;
  if (a && input?.kind === "drag")
    return a.cancel ? dragWay(a, input, a.cancel.t).at(-1) : input.to;
  if (a?.plan) return a.cancel ? glideAt(a.plan, a.cancel.t) : a.plan.to;
  return a?.point;
}

function cursorAt(
  model: SessionModel,
  n: number,
  current: ActionState | undefined,
  t: number,
  view: View,
  first: number,
  dragging: Point | undefined,
  gesture: Gesture | null,
  cancel: CancelScene | null,
): CursorScene | null {
  if (!current) return null;
  let pos: Point | undefined = dragging;
  for (let i = n - 1; i >= first && !pos; i--) {
    const a = model.actions[i];
    if (!a) continue;
    const input = a.dispatch?.input;
    const dropped = input?.kind === "drag" && t >= dropT(a, input);
    pos = a === current && a.plan && !dropped ? positionOnPlan(a, t, view) : restingPoint(a);
  }
  if (!pos) return null;
  const idleSince = current.cancel?.t ?? current.resultT;
  const hideAt = idleSince === undefined ? undefined : idleSince + CURSOR_HIDE_AFTER_MS;
  const fadeStart = Math.min(
    hideAt ?? Number.POSITIVE_INFINITY,
    model.ended?.t ?? Number.POSITIVE_INFINITY,
  );
  let alpha = t >= fadeStart ? fadeOut(t, fadeStart, FADE_MS) : 1;
  const name = rightClickChip(model, n, t, first) ? `${CURSOR_NAME} · right-click` : CURSOR_NAME;
  if (alpha <= 0)
    return { x: pos.x, y: pos.y, visible: false, alpha: 0, press: 0, lean: 0, chipAlpha: 0, name };
  if (current.plan && view.reducedMotion) alpha *= reducedAlpha(current.plan, t);
  else if (current.plan && current.plan.durationMs === 0)
    alpha *= t < current.plan.startsAt ? 1 : clamp01((t - current.plan.startsAt) / FADE_IN_MS);
  const press = gesture && !view.reducedMotion ? pressAt(gesture, t) : 0;
  return {
    x: pos.x,
    y: pos.y,
    visible: true,
    alpha,
    press,
    lean: view.reducedMotion ? 0 : leanAt(current, t),
    chipAlpha: chipAlphaAt(model, n, t, first) * (1 - (cancel?.alpha ?? 0)),
    name,
  };
}

// Reduced motion (design-v2 §12): no travel; the cursor fades out at the old point in 60 ms and in
// at the new one over 120 ms. Instant (a plan with no duration) appears at the target and fades in.
function positionOnPlan(a: ActionState, t: number, view: View): Point {
  const plan = a.plan as NonNullable<ActionState["plan"]>;
  const stop = a.cancel ? Math.min(t, a.cancel.t) : t;
  if (!view.reducedMotion) return glideAt(plan, stop);
  return stop < plan.startsAt + REDUCED_CURSOR_OUT_MS
    ? { x: plan.from.x, y: plan.from.y }
    : { x: plan.to.x, y: plan.to.y };
}

function reducedAlpha(plan: NonNullable<ActionState["plan"]>, t: number): number {
  const jump = plan.startsAt + REDUCED_CURSOR_OUT_MS;
  if (t < plan.startsAt) return 1;
  if (t < jump) return fadeOut(t, plan.startsAt, REDUCED_CURSOR_OUT_MS);
  return clamp01((t - jump) / REDUCED_CURSOR_IN_MS);
}

// Leans up to 4° toward the travel and back upright at rest, on its own spring.
function leanAt(a: ActionState, t: number): number {
  const plan = a.plan;
  if (!plan || plan.durationMs <= 0) return 0;
  const dx = plan.to.x - plan.from.x;
  const distance = Math.hypot(dx, plan.to.y - plan.from.y);
  if (distance === 0) return 0;
  const lean = ((CURSOR_LEAN_MAX_DEG * Math.PI) / 180) * (dx / distance);
  const stop = a.cancel ? Math.min(a.cancel.t, planEnd(a)) : planEnd(a);
  return springTrack(
    0,
    [
      { at: plan.startsAt, to: lean, spring: LEAN_SPRING },
      { at: stop, to: 0, spring: LEAN_SPRING },
    ],
    t,
  );
}

// The name chip fades in as the cursor sets off and out once it has been still for 2 s; one
// travel's chip carries into the next, so it never blinks between actions.
function chipAlphaAt(model: SessionModel, n: number, t: number, first: number): number {
  let alpha = 0;
  for (let i = n - 1; i >= Math.max(first, n - 3); i--) {
    const a = model.actions[i];
    if (!a?.plan) continue;
    const input = a.dispatch?.input;
    const moved = input?.kind === "drag" ? dropT(a, input) : planEnd(a);
    const still = a.cancel ? Math.min(a.cancel.t, moved) : moved;
    const shown = clamp01((t - a.plan.startsAt) / CHIP_IN_MS);
    alpha = Math.max(alpha, shown * fadeOut(t, still + CHIP_SHOW_MS, CHIP_FADE_MS));
  }
  return alpha;
}

function rightClickChip(model: SessionModel, n: number, t: number, first: number): boolean {
  const d = n - 1 >= first ? model.actions[n - 1]?.dispatch : undefined;
  if (d?.input.kind !== "click" || d.input.button !== "right") return false;
  const release = clickTimes(d).ups[0] as number;
  return t >= release && t < release + RIGHT_CLICK_CHIP_MS;
}

// A press as the hand shows it: the times the button went down and came up again. Each click
// holds its disc for CLICK_HOLD_MS before the release ripple; a double click's second cycle
// releases RIPPLE_GAP_MS after the first.
interface Gesture {
  downs: number[];
  ups: number[];
}

function clickTimes(d: NonNullable<ActionState["dispatch"]>): Gesture {
  const count = d.input.kind === "click" ? d.input.count : 1;
  const release = Math.max(d.ringAt, d.pressT + CLICK_HOLD_MS);
  const ups = Array.from({ length: count }, (_, i) => release + i * RIPPLE_GAP_MS);
  return { downs: ups.map((up, i) => (i === 0 ? d.pressT : up - CLICK_HOLD_MS)), ups };
}

// The latest press within reach: a click, a one-step drag, or a button held since its press
// through moves and scrolls, until its release.
function gestureAt(model: SessionModel, n: number, t: number, first: number): Gesture | null {
  let up: number | undefined;
  for (let i = n - 1; i >= Math.max(first, n - RING_LOOKBACK); i--) {
    const a = model.actions[i];
    const d = a?.dispatch;
    if (!a || !d || d.pressT > t) continue;
    const input = d.input;
    if (input.kind === "click") return up === undefined ? clickTimes(d) : null;
    if (input.kind === "drag")
      return up === undefined ? { downs: [d.pressT], ups: [dropT(a, input)] } : null;
    if (input.kind === "down") return { downs: [d.pressT], ups: up === undefined ? [] : [up] };
    if (input.kind === "up") up = d.ringAt;
    else if (input.kind !== "move" && input.kind !== "scroll") return null;
  }
  return null;
}

function pressAt(g: Gesture, t: number): number {
  const steps: SpringStep[] = [
    ...g.downs.map((at) => ({ at, to: 1, spring: PRESS_SPRING })),
    ...g.ups.map((at) => ({ at, to: 0, spring: RELEASE_SPRING })),
  ].sort((a, b) => a.at - b.at);
  return clamp01(springTrack(0, steps, t));
}

function discAt(g: Gesture, cursor: CursorScene, t: number, view: View): PressScene | null {
  const down = g.downs[0];
  if (down === undefined || t < down) return null;
  const last = g.ups.length === g.downs.length ? g.ups.at(-1) : undefined;
  const alpha = last === undefined || t <= last ? 1 : fadeOut(t, last, DISC_FADE_MS);
  if (alpha <= 0) return null;
  const press = view.reducedMotion ? 0 : pressAt(g, t);
  return { x: cursor.x, y: cursor.y, scale: 1 - 0.18 * press, alpha };
}

function targetAt(a: ActionState, t: number, view: View): TargetScene | null {
  const point = a.target?.point ?? a.point;
  if (!point || t < a.intentT) return null;
  const holdFrom = a.dispatch?.t ?? ended(a);
  const out = holdFrom === undefined ? undefined : holdFrom + TARGET_HOLD_MS;
  if (out !== undefined && t >= out + TARGET_FADE_MS) return null;
  const bbox = a.target?.bbox;
  const known = bbox !== undefined && a.targetT !== undefined && t >= a.targetT;
  const since = t - (known ? (a.targetT as number) : a.intentT);
  const shown = view.reducedMotion
    ? clamp01(since / FADE_IN_MS)
    : springProgress(since, TARGET_SPRING.response);
  let alpha = shown;
  let scale = view.reducedMotion ? 1 : TARGET_FROM_SCALE - (TARGET_FROM_SCALE - 1) * shown;
  if (out !== undefined && t > out) {
    const leaving = clamp01((t - out) / TARGET_FADE_MS);
    alpha *= 1 - leaving;
    if (!view.reducedMotion) scale = 1 + (TARGET_TO_SCALE - 1) * leaving;
  }
  return { rect: known ? bbox : null, point, alpha, scale };
}

interface Release {
  t: number;
  at: Point;
  style: RingScene["style"];
  index: number;
}

function releasesOf(a: ActionState): Release[] {
  const d = a.dispatch;
  const input = d?.input;
  if (!d || !input) return [];
  if (input.kind === "click")
    return clickTimes(d).ups.map((t, index) => ({
      t,
      at: input.at,
      style: input.button === "right" ? "right" : "left",
      index,
    }));
  if (input.kind === "up") return [{ t: d.ringAt, at: input.at, style: "left", index: 0 }];
  if (input.kind === "drag" && !a.cancel)
    return [{ t: dropT(a, input), at: input.to, style: "left", index: 0 }];
  return [];
}

function ringsAt(
  model: SessionModel,
  n: number,
  t: number,
  lookback: number,
  first: number,
  view: View,
): RingScene[] {
  const rings: RingScene[] = [];
  // A click's last ripple ends by ringAt + its hold, two gaps and the fade.
  const clickReach = CLICK_HOLD_MS + 2 * RIPPLE_GAP_MS + RING_FADE_MS;
  for (let i = Math.max(first, n - lookback); i < n; i++) {
    const a = model.actions[i];
    const d = a?.dispatch;
    if (!a || !d || d.pressT > t) continue;
    if (d.input.kind !== "drag" && t > d.ringAt + clickReach) continue;
    for (const r of releasesOf(a)) {
      const since = t - r.t;
      if (since < 0) continue;
      if (view.reducedMotion) {
        if (since < REDUCED_FADE_MS)
          rings.push({
            x: r.at.x,
            y: r.at.y,
            d: REDUCED_RING_PX,
            alpha: RIPPLE_ALPHA * fadeOut(t, r.t, REDUCED_FADE_MS),
            style: r.style,
          });
        continue;
      }
      if (since >= RING_FADE_MS) continue;
      const from = RIPPLE_FROM + 8 * r.index;
      const to = (r.style === "right" ? RIGHT_RIPPLE_TO : RIPPLE_TO) + 12 * r.index;
      rings.push({
        x: r.at.x,
        y: r.at.y,
        d: from + (to - from) * springProgress(since, RIPPLE_SPRING.response),
        alpha: RIPPLE_ALPHA * fadeOut(t, r.t, RING_FADE_MS),
        style: r.style,
      });
    }
  }
  return rings;
}

// A one-step drag from its press, or the press of a button held between actions and the moves,
// scrolls and release since: the way the button has gone so far, which fades after the drop.
// `head` is where the pointer is on it while it moves. Under reduced motion the way appears whole
// at the drop and only fades.
function dragAt(
  model: SessionModel,
  n: number,
  current: ActionState | undefined,
  t: number,
  view: View,
  first: number,
): (DragScene & { head?: Point }) | null {
  const input = current?.dispatch?.input;
  let way: Way | null = null;
  if (current && input?.kind === "drag") {
    if (t < (current.dispatch?.pressT ?? 0)) return null;
    const drop = dropT(current, input);
    way = { ...timedDragWay(current, input, t), end: drop, moving: t < drop };
  } else way = heldWay(model, n, t, view, first);
  if (!way || way.points.length < 2) return null;
  const end = way.end ?? (model.ended && model.ended.t <= t ? model.ended.t : undefined);
  if (view.reducedMotion) {
    if (end === undefined || t < end) return null;
    const alpha = fadeOut(t, end, REDUCED_FADE_MS);
    return alpha > 0 ? { points: way.points, ages: way.points.map(() => 0), alpha } : null;
  }
  const alpha = end === undefined || t < end ? 1 : fadeOut(t, end, DRAG_FADE_MS);
  if (alpha <= 0) return null;
  return {
    points: way.points,
    ages: way.times.map((at) => Math.max(0, t - at)),
    alpha,
    ...(way.moving ? { head: way.points.at(-1) as Point } : {}),
  };
}

interface Way {
  points: Point[];
  times: number[];
  end?: number;
  moving: boolean;
}

const fullWay = (input: Extract<Input, { kind: "drag" }>) => [
  input.from,
  ...(input.path ?? []),
  input.to,
];
const samplesOf = new WeakMap<Input, MotionSample[]>();
function samplesFor(input: Extract<Input, { kind: "drag" }>): MotionSample[] {
  let samples = samplesOf.get(input);
  if (!samples) {
    samples = motionSamples(fullWay(input), input.durationMs);
    samplesOf.set(input, samples);
  }
  return samples;
}

// A one-step drag's way as far as its motion got at t, the way desktopd samples it, with the time
// it reached each point.
function timedDragWay(
  a: ActionState,
  input: Extract<Input, { kind: "drag" }>,
  t: number,
): { points: Point[]; times: number[] } {
  const press = a.dispatch?.pressT ?? t;
  const stop = a.cancel ? Math.min(t, a.cancel.t) : t;
  const shown = samplesFor(input).filter((s) => press + DRAG_PRESS_MS + s.t <= stop);
  return {
    points: [input.from, ...shown.map((s) => s.at)],
    times: [press, ...shown.map((s) => press + DRAG_PRESS_MS + s.t)],
  };
}

const dragWay = (a: ActionState, input: Extract<Input, { kind: "drag" }>, t: number) =>
  timedDragWay(a, input, t).points;

// A button held between actions: from its press through each move, scroll and the release since,
// the current one as far as its glide got. None once a release before the current action ended it.
function heldWay(model: SessionModel, n: number, t: number, view: View, first: number): Way | null {
  let press = -1;
  for (let i = n - 1; i >= first && press < 0; i--) {
    const kind = model.actions[i]?.dispatch?.input.kind;
    if (kind === "down") press = i;
    else if ((kind === "up" && i < n - 1) || kind === "drag" || kind === "click") return null;
  }
  if (press < 0) return null;
  const points: Point[] = [];
  const times: number[] = [];
  const add = (p: Point, at: number) => {
    points.push(p);
    times.push(at);
  };
  let end: number | undefined;
  let moving = false;
  for (let i = press; i < n; i++) {
    const a = model.actions[i] as ActionState;
    const d = a.dispatch;
    const input = d?.input;
    const plan = i > press && i === n - 1 && !a.cancel ? a.plan : undefined;
    if (plan && (!input || t < planEnd(a))) {
      if (t >= plan.startsAt) add(view.reducedMotion ? plan.to : pointerAt(plan, t, true), t);
      moving = t < planEnd(a);
    } else if (d && (input?.kind === "down" || input?.kind === "scroll")) add(input.at, d.pressT);
    else if (d && input?.kind === "move") add(input.to, a.plan ? planEnd(a) : d.t);
    else if (d && input?.kind === "up") {
      add(input.at, d.pressT);
      end = d.ringAt;
    }
  }
  return { points, times, ...(end === undefined ? {} : { end }), moving };
}

function typingAt(a: ActionState, t: number, view: View): TypingScene | null {
  const d = a.dispatch;
  if (d?.input.kind !== "type" || t < d.ringAt) return null;
  const shown = a.progress.filter((p) => p.t <= t);
  const last = shown.at(-1);
  // The pill stays while the action runs and for TYPING_HOLD_MS after whichever came last, the
  // action's end or the last progress line, then fades.
  const stop = ended(a);
  const out = stop === undefined ? undefined : Math.max(stop, last?.t ?? 0) + TYPING_HOLD_MS;
  if (out !== undefined && t >= out + TYPING_OUT_MS) return null;
  const count = last?.count ?? 0;
  const text = d.input.masked ? "•".repeat(count) : shown.map((p) => p.chunk ?? "").join("");
  const chars = [...text];
  const since = t - d.ringAt;
  const entered = view.reducedMotion
    ? clamp01(since / FADE_IN_MS)
    : springProgress(since, TYPING_SPRING.response);
  const leaving = out === undefined ? 0 : clamp01((t - out) / TYPING_OUT_MS);
  return {
    anchor: a.target?.bbox
      ? { x: a.target.bbox.x, y: a.target.bbox.y }
      : (a.target?.point ?? a.point ?? { x: 0, y: 0 }),
    field: a.target?.bbox ?? null,
    text: chars.slice(-TYPING_MAX_CHARS).join(""),
    more: Math.max(0, chars.length - TYPING_MAX_CHARS),
    masked: d.input.masked,
    caretOn: view.reducedMotion || Math.floor((t - d.t) / (CARET_PERIOD_MS / 2)) % 2 === 0,
    alpha: entered * (1 - leaving),
    dy: view.reducedMotion ? 0 : TYPING_RISE_PX * (1 - entered),
  };
}

function keycapsAt(a: ActionState, t: number, view: View): KeycapsScene | null {
  const d = a.dispatch;
  if (d?.input.kind !== "key" || t < d.ringAt) return null;
  const since = t - d.ringAt;
  const out = KEYCAP_IN_MS + KEYCAP_LINGER_MS;
  if (since > out + KEYCAP_FADE_MS) return null;
  const settled = view.reducedMotion ? 1 : springProgress(since, KEYCAP_SPRING.response);
  return {
    keys: keycapNames(d.input.combo),
    alpha: clamp01(since / KEYCAP_IN_MS) * fadeOut(since, out, KEYCAP_FADE_MS),
    scale: 0.9 + 0.1 * settled,
    dy: KEYCAP_RISE_PX * (1 - settled),
  };
}

// The scroll pill beside the hotspot: one nudge per wheel notch (desktopd sends them at once, so
// they are paced here), fading 600 ms after the last.
function scrollAt(
  model: SessionModel,
  n: number,
  t: number,
  view: View,
  first: number,
): ScrollScene | null {
  for (let i = n - 1; i >= Math.max(first, n - 2); i--) {
    const d = model.actions[i]?.dispatch;
    if (d?.input.kind !== "scroll") continue;
    const { at, dx, dy } = d.input;
    if (t < d.ringAt) return null;
    const notches = Math.abs(Math.trunc(dx)) + Math.abs(Math.trunc(dy));
    const steps = Array.from(
      { length: Math.max(1, Math.min(notches, SCROLL_STEPS_SHOWN)) },
      (_, k) => d.ringAt + k * SCROLL_STEP_MS,
    );
    const out = (steps.at(-1) as number) + SCROLL_FADE_MS;
    if (t >= out + FADE_OUT_MS) return null;
    // A kick that peaks at SCROLL_NUDGE_PX on a critically damped spring and settles back.
    const omega = (2 * Math.PI) / SCROLL_SPRING.response;
    const kick = SCROLL_NUDGE_PX * omega * Math.E;
    return {
      x: at.x,
      y: at.y,
      direction:
        Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? "down" : "up") : dx > 0 ? "right" : "left",
      nudge: view.reducedMotion
        ? 0
        : springTrack(
            0,
            steps.map((s) => ({ at: s, to: 0, spring: SCROLL_SPRING, kick })),
            t,
          ),
      alpha: clamp01((t - d.ringAt) / FADE_IN_MS) * fadeOut(t, out, FADE_OUT_MS),
    };
  }
  return null;
}

const VERB_WORDS: Record<ActionState["verb"], string> = {
  click: "click",
  move: "move",
  drag: "drag",
  scroll: "scroll",
  type: "type",
  key: "press the keys",
  wait: "wait",
};
const WHY: Record<string, string> = {
  stale: "the screen changed",
  timeout: "it took too long",
  preflight: "it wasn't there",
  policy: "it isn't allowed",
};

function cancelText(verb: ActionState["verb"], reason: string): string {
  if (reason === "user") return "Stopped";
  const why = WHY[reason];
  return why ? `Couldn't ${VERB_WORDS[verb]}: ${why}` : `Didn't ${VERB_WORDS[verb]}`;
}

function cancelAt(
  a: ActionState,
  previous: ActionState | undefined,
  t: number,
  view: View,
): CancelScene | null {
  if (!a.cancel || t < a.cancel.t || t > a.cancel.t + CANCEL_CHIP_MS) return null;
  const since = t - a.cancel.t;
  const pos = restingPoint(a) ?? restingPoint(previous) ?? { x: 0, y: 0 };
  const dx =
    view.reducedMotion || since > CANCEL_SHAKE_MS
      ? 0
      : 5 * Math.sin((2 * Math.PI * 2 * since) / CANCEL_SHAKE_MS);
  return {
    x: pos.x,
    y: pos.y,
    dx,
    text: cancelText(a.verb, a.cancel.reason),
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
