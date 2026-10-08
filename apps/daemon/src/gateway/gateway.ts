import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  clipText,
  type Input,
  type InputResult,
  microsToMs,
  type Point,
  type Rect,
  type Target,
} from "@localdot/protocol";
import { toDevice } from "@localdot/providers";
import {
  dwellMs,
  INSTANT_LEAD_MS,
  intentLeadMs,
  SETTLE_CAP_MS,
  SETTLE_QUIET_MS,
  type Speed,
  travelDurationMs,
  typingPaceMs,
} from "@localdot/stage";
import type { CellApi } from "../cells/orchestrator.ts";
import type { StreamState } from "../cells/types.ts";
import { DesktopdError } from "../desktopd/client.ts";
import type { DesktopdRegistry, NativeDevice } from "../desktopd/registry.ts";
import type { EventLog } from "../event-log.ts";
import type { FrameStore } from "./frames.ts";
import { animationKeepsTarget, frameLuma, lumaRegionChanged } from "./freshness.ts";
import { type NativeActionIdentity, sameNativeIdentity } from "./identity.ts";
import { type OnsetTable, onsetKind } from "./onset-table.ts";
import type { RingOnsetPolicy } from "./ring-onset.ts";
import {
  buttonLabel,
  clickLabel,
  clipTarget,
  dragLabel,
  keyLabel,
  moveLabel,
  scrollLabel,
  typeLabel,
} from "./text.ts";

export const DEFAULT_AGENT = "main";
const MODEL_SCREEN = { width: 1280, height: 800 } as const;
// How long settle waits for a first screen change before it reports none, by verb: a key shows
// its effect within a frame or two, a click may first have to open a menu or a dialog. A hover
// rarely changes much, and a stroke's every point waits for it.
const SETTLE_FIRST_MS = { key: 400, type: 400, click: 800, scroll: 800, move: 400 } as const;
// A button the agent holds down between actions is let go after this long without another
// pointer action.
export const HELD_BUTTON_MS = 60_000;
// A backstop for desktopd's own lookup budget; a lookup past it is unknown, not "no element".
const LOOKUP_TIMEOUT_MS = 1000;
// Fitts' W in CSS px, multiplied by the cell's scale: the distance it divides is in device px.
const UNKNOWN_TARGET_PX = 24;
const MIN_TARGET_PX = 16;

export type GuiAction =
  | {
      verb: "click";
      label?: string;
      point?: Point;
      find?: { name: string; role?: string; app?: string };
      button?: "left" | "right" | "middle";
      count?: 1 | 2 | 3;
      // Modifier keys held down through the click.
      mods?: string[];
      speed?: Speed | "auto";
      basedOn?: string;
    }
  | { verb: "type"; label?: string; text: string; masked?: boolean; speed?: Speed | "auto" }
  | {
      verb: "key";
      label?: string;
      combo: string[];
      // Presses of the combo in one input, or how long it stays down; never both.
      repeat?: number;
      holdMs?: number;
      speed?: Speed | "auto";
    }
  | {
      verb: "scroll";
      label?: string;
      point?: Point;
      dx: number;
      dy: number;
      mods?: string[];
      speed?: Speed | "auto";
      basedOn?: string;
    }
  | {
      verb: "drag";
      label?: string;
      // Model pixels, start first; the approval binds every point.
      path: Point[];
      button?: "left" | "right" | "middle";
      mods?: string[];
      durationMs?: number;
      speed?: Speed | "auto";
      basedOn?: string;
    }
  | { verb: "move"; label?: string; point: Point; speed?: Speed | "auto" }
  // A button that stays down between actions (down) and its release (up); without a point, where
  // the cursor is.
  | {
      verb: "down" | "up";
      label?: string;
      point?: Point;
      button?: "left" | "right" | "middle";
      mods?: string[];
      speed?: Speed | "auto";
      basedOn?: string;
    }
  | { verb: "wait"; label?: string; ms: number };

export type { NativeActionIdentity } from "./identity.ts";

type Lookup = Omit<NativeActionIdentity, "point">;
const UNKNOWN: Lookup = { target: null, window: null, unknown: true };

export interface NativeActionPermit {
  // `fresh` is the read just before input: it may name an element the approved read did not.
  consume(action: GuiAction, approved: NativeActionIdentity, fresh: NativeActionIdentity): boolean;
}
export interface NativeActionRequest {
  readonly action: GuiAction;
  readonly identity: NativeActionIdentity;
  revalidate(): Promise<boolean>;
}
// Daemon-owned binding to one admitted physical screen. Never accepted from a tool body.
export interface NativeScreenBinding {
  readonly cellId: string;
  readonly parentCellId: string;
  readonly scale: 1 | 2;
  readonly device: NativeDevice;
  readonly signal: AbortSignal;
  check(): void;
  stream(): StreamState;
  subscribe(listener: () => void): () => void;
}
export interface ActionContext {
  // Constructed by the daemon caller; model tool bodies cannot select their authority.
  source?: "manual" | "agent";
  redact?(value: string): string;
  authorizeAgent?(request: NativeActionRequest): Promise<NativeActionPermit | undefined>;
  // Private daemon callback at the last synchronous boundary before physical input.
  beforeEffect?(action: GuiAction, identity: NativeActionIdentity): boolean;
  // The outcome of the input beforeEffect admitted, once it settled: whether the screen changed.
  afterEffect?(action: GuiAction, identity: NativeActionIdentity, changed: boolean): void;
  // Private daemon callback: a button now stays down past this action. The owner calls `release`
  // before anyone else gets the screen; the returned function forgets it once it is up.
  holdInput?(release: () => Promise<void>): () => void;
  sessionId: string;
  cellId: string;
  agent?: string;
  step?: string;
  signal?: AbortSignal;
  screen?: NativeScreenBinding;
}

export interface ActionOutcome {
  ok: boolean;
  frameId?: string;
  target?: Target;
  error?: string;
  cancelled?: "preflight" | "user" | "timeout" | "stale";
  // Settle saw a change and the result frame differs from the frame before the input.
  changed?: boolean;
  // Typing and keys: the element that had keyboard focus just before the input.
  focus?: { target: Target | null; unknown?: true };
  // A repeat or a hold that stopped after its first press: the presses made, or how long the
  // keys were down.
  partial?: { presses: number; heldMs?: number };
  // A release of a button that was not down.
  notDown?: true;
}

export interface GatewayDeps {
  eventLog: EventLog;
  cells: CellApi;
  registry: DesktopdRegistry;
  onset: OnsetTable;
  ringOnset: RingOnsetPolicy;
  frames: FrameStore;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  hitTestTimeoutMs?: number;
  heldButtonMs?: number;
}

class Cancelled extends Error {
  constructor(
    readonly reason: "preflight" | "user" | "timeout" | "stale",
    message: string,
    readonly frameId?: string,
  ) {
    super(message);
    this.name = "Cancelled";
  }
}

// Only a viewer's stream can hold dispatch: with nobody attached, a `disconnected` left behind by a
// closed tab is not a stall.
const holding = (s: StreamState) =>
  s.viewers > 0 &&
  (s.connection === "stalled" || s.connection === "disconnected" || s.connection === "connecting");

interface HeldButton {
  button: "left" | "right" | "middle";
  device: NativeDevice;
  timer: NodeJS.Timeout;
  forget?: () => void;
}

// How long a drag's motion takes when the action does not say: longer paths take longer.
function dragDurationMs(way: readonly Point[], scale: 1 | 2, speed: Speed): number {
  const length = way
    .slice(1)
    .reduce(
      (sum, p, i) => sum + Math.hypot(p.x - (way[i] as Point).x, p.y - (way[i] as Point).y),
      0,
    );
  const perPx = speed === "watch" ? 1.2 : 0.6;
  return Math.round(Math.min(3000, Math.max(300, 250 + (length / scale) * perPx)));
}

export class ActionGateway {
  readonly #cursor = new Map<string, Point>();
  readonly #queues = new Map<string, Promise<unknown>>();
  // Buttons the agent left down between actions, by screen.
  readonly #held = new Map<string, HeldButton>();
  // Each screen's newest frame: its desktopd keeps that frame's device-resolution pixels.
  readonly #lastFrame = new Map<
    string,
    { frameId: string; sessionId: string; device: NativeDevice; digest: string }
  >();

  constructor(private readonly deps: GatewayDeps) {}

  cursorOf(cellId: string): Point | undefined {
    return this.#cursor.get(cellId);
  }

  // Lets go of a button the agent left down on the screen: every key and button the desktop has
  // down comes up.
  async releaseHeld(cellId: string): Promise<void> {
    const held = this.#held.get(cellId);
    if (!held) return;
    this.#forget(cellId);
    await held.device.client.release?.().catch(() => undefined);
  }

  #forget(cellId: string): void {
    const held = this.#held.get(cellId);
    if (!held) return;
    this.#held.delete(cellId);
    clearTimeout(held.timer);
    held.forget?.();
  }

  #hold(ctx: ActionContext, device: NativeDevice, button: HeldButton["button"]): void {
    this.#forget(ctx.cellId);
    const timer = setTimeout(
      () => void this.releaseHeld(ctx.cellId),
      this.deps.heldButtonMs ?? HELD_BUTTON_MS,
    );
    timer.unref();
    const held: HeldButton = { button, device, timer };
    this.#held.set(ctx.cellId, held);
    // The owner may let go at once (the task stopped as the button went down): set it first.
    const forget = ctx.holdInput?.(() => this.releaseHeld(ctx.cellId));
    if (forget) {
      if (this.#held.get(ctx.cellId) === held) held.forget = forget;
      else forget();
    }
  }

  // Another pointer action while a button is down restarts its time.
  #touch(cellId: string): void {
    this.#held.get(cellId)?.timer.refresh();
  }

  // A fresh frame for the brain (M4) and for the step thumbnails; also where the cursor starts.
  async observe(ctx: ActionContext): Promise<{ frameId: string; pointer: Point }> {
    ctx = this.#owner(ctx);
    const d = await this.#ready(ctx);
    const o = await d.client.observe(ctx.signal);
    this.#check(ctx);
    const image = Buffer.from(o.image, "base64");
    this.deps.frames.save(ctx.sessionId, o.frameId, image);
    this.#append(ctx, "observe", { frameId: o.frameId, width: o.width, height: o.height });
    this.#cursor.set(ctx.cellId, o.pointer);
    this.#lastFrame.set(ctx.cellId, {
      frameId: o.frameId,
      sessionId: ctx.sessionId,
      device: d,
      digest: createHash("sha256").update(image).digest("hex"),
    });
    return { frameId: o.frameId, pointer: o.pointer };
  }

  // A model-pixel region of the session's frame at the screen's device resolution (PNG), while
  // that frame is still its screen's newest; undefined otherwise or on a screen without one.
  async zoom(
    sessionId: string,
    frameId: string,
    region: Rect,
    signal?: AbortSignal,
  ): Promise<Buffer | undefined> {
    for (const [cellId, last] of this.#lastFrame) {
      if (last.frameId !== frameId) continue;
      const cell = this.deps.cells.get(cellId);
      if (!cell) {
        this.#lastFrame.delete(cellId);
        return undefined;
      }
      if (last.sessionId !== sessionId || !last.device.client.zoom) return undefined;
      if (cell.state !== "ready" || cell.paused || cell.fenced || cell.replacementPending)
        return undefined;
      return await last.device.client.zoom({ frameId, region }, signal);
    }
    return undefined;
  }

  async run(ctx: ActionContext, action: GuiAction): Promise<ActionOutcome> {
    const owner = this.#owner(ctx);
    const input = frozenSnapshot(action);
    const before = this.#queues.get(ctx.cellId) ?? Promise.resolve();
    const task = before.catch(() => {}).then(() => this.#run(owner, input));
    this.#queues.set(ctx.cellId, task);
    try {
      return await task;
    } finally {
      if (this.#queues.get(ctx.cellId) === task) this.#queues.delete(ctx.cellId);
    }
  }

  async #run(ctx: ActionContext, action: GuiAction): Promise<ActionOutcome> {
    let dispatched = false;
    try {
      this.#check(ctx);
      const scale = ctx.screen?.scale ?? this.deps.cells.get(ctx.cellId)?.scale;
      if (!scale) throw new Cancelled("preflight", "the selected screen is unavailable");
      const speed: Speed =
        "speed" in action && action.speed && action.speed !== "auto"
          ? action.speed
          : (this.#stream(ctx)?.viewers ?? 0) > 0
            ? "watch"
            : "fast";
      if (ctx.source !== "manual" && (ctx.source !== "agent" || !ctx.authorizeAgent))
        throw new Cancelled("preflight", "this native action has no admitted owner");
      switch (action.verb) {
        case "wait": {
          const identity = frozenSnapshot({ target: null, window: null, point: null });
          const permit = await this.#authorize(ctx, action, identity, async () => identity);
          await this.#consume(ctx, action, identity, permit, async () => identity);
          this.#append(ctx, "action.intent", {
            verb: "wait",
            label: clipText(action.label ?? `Wait ${action.ms} ms`, 80),
            risk: "none",
          });
          await this.deps.sleep(action.ms, ctx.signal);
          this.#append(ctx, "action.result", { ok: true });
          return { ok: true };
        }
        case "click":
        case "scroll":
        case "move":
        case "down":
        case "up":
          return await this.#pointerAction(ctx, action, scale, speed, (v) => {
            dispatched = v;
          });
        case "drag":
          return await this.#dragAction(ctx, action, scale, speed, (v) => {
            dispatched = v;
          });
        case "type":
          return await this.#typeAction(ctx, action, scale, speed, (v) => {
            dispatched = v;
          });
        case "key":
          return await this.#keyAction(ctx, action, scale, speed, (v) => {
            dispatched = v;
          });
      }
    } catch (err) {
      return this.#fail(ctx, err, dispatched);
    }
  }

  async #pointerAction(
    ctx: ActionContext,
    action: Extract<GuiAction, { verb: "click" | "scroll" | "move" | "down" | "up" }>,
    scale: 1 | 2,
    speed: Speed,
    mark: (v: boolean) => void,
  ): Promise<ActionOutcome> {
    const d = await this.#ready(ctx);
    const held = this.#held.get(ctx.cellId);
    if (held && (action.verb === "click" || action.verb === "down"))
      throw new Cancelled(
        "preflight",
        `the ${held.button} button is still down; let go of it with left_mouse_up first`,
      );
    const centre = { x: (MODEL_SCREEN.width * scale) / 2, y: (MODEL_SCREEN.height * scale) / 2 };
    const cursor = this.#cursor.get(ctx.cellId) ?? centre;
    let found: Lookup | undefined;
    let point: Point;
    if (action.verb === "click" && action.find) {
      found = await d.client.find(action.find);
      if (!found.target)
        throw new Cancelled("preflight", `no element named ${JSON.stringify(action.find.name)}`);
      point = found.target.point;
    } else if (action.point) {
      point = toDevice(action.point, { ...MODEL_SCREEN, scale });
    } else point = cursor;

    const readIdentity = async (): Promise<NativeActionIdentity> =>
      frozenSnapshot({ ...(await this.#lookup(ctx, d, point)), point });
    const identity = ctx.source === "agent" ? await readIdentity() : undefined;
    const permit = identity
      ? await this.#authorize(ctx, action, identity, readIdentity)
      : undefined;
    if (identity) found = identity;
    const t0 = this.deps.now();
    const from = cursor;
    const width = found?.target?.bbox
      ? Math.max(MIN_TARGET_PX * scale, Math.min(found.target.bbox.w, found.target.bbox.h))
      : UNKNOWN_TARGET_PX * scale;
    const durationMs = travelDurationMs(
      Math.hypot(point.x - from.x, point.y - from.y),
      width,
      speed,
    );
    const leadMs = speed === "instant" ? 0 : intentLeadMs(speed);
    const startsAt = Math.round(microsToMs(this.#sessionT(ctx.sessionId, t0))) + leadMs;
    const target = found?.target ?? null;
    const label =
      action.label ??
      (action.verb === "click"
        ? clickLabel(target, point)
        : action.verb === "scroll"
          ? scrollLabel(action.dx, action.dy)
          : action.verb === "move"
            ? moveLabel(target, point)
            : buttonLabel(action.verb, action.button ?? "left", target, point));
    this.#append(ctx, "action.intent", {
      verb: action.verb === "down" || action.verb === "up" ? "click" : action.verb,
      label: clipText(label, 80),
      point,
      risk: "none",
      pointer: {
        from,
        to: point,
        startsAt,
        durationMs,
        seed: Math.floor(Math.random() * 2 ** 31),
        curve: "minjerk-bow-v1",
      },
    });

    // The hit test runs beside the travel: it often takes longer than the cursor (S2), so the
    // target box may arrive after the cursor; a result after the action has ended is dropped.
    let ended = false;
    const lookup = found ? Promise.resolve(found) : this.#read(d, point);
    let known: Lookup | undefined = found;
    const targetKnown = lookup.then((r) => {
      known = r;
      if (r.target && !ended) this.#append(ctx, "action.target", { target: clipTarget(r.target) });
      return r;
    });
    // While a button is down, the cursor glides along with the travel instead of jumping at its
    // end: the app sees the drag.
    const glideMs = Math.max(1, Math.round(durationMs));
    const glide = held && (action.verb === "move" || action.verb === "up") && durationMs > 0;
    // A release or a hover keeps no basis: the press it ends was checked, and the screen under a
    // drag changes as it goes.
    const fresh = action.verb === "click" || action.verb === "scroll" || action.verb === "down";
    let result: { frameId: string; changed: boolean };
    let notDown = false;
    try {
      const pressAtMs = glide
        ? startsAt
        : speed === "instant"
          ? startsAt + INSTANT_LEAD_MS
          : startsAt + durationMs + dwellMs(speed);
      await this.#sleepUntil(ctx, pressAtMs);
      for (;;) {
        await this.#waitForStream(ctx);
        // A stream can stall during the asynchronous comparison. After recovery, compare again
        // with the same model basis: an earlier allow cannot authorize a delayed press.
        if (fresh && action.basedOn) {
          await this.#checkFresh(ctx, action.basedOn, point, scale, d, targetKnown);
        }
        this.#check(ctx);
        const stream = this.#stream(ctx);
        if (!stream || !holding(stream)) break;
      }
      const mods = "mods" in action && action.mods?.length ? { mods: action.mods } : {};
      const input: Input =
        action.verb === "click"
          ? {
              kind: "click",
              button: action.button ?? "left",
              count: action.count ?? 1,
              ...mods,
              at: point,
            }
          : action.verb === "scroll"
            ? { kind: "scroll", at: point, dx: action.dx, dy: action.dy, ...mods }
            : action.verb === "move"
              ? { kind: "move", to: point, ...(glide ? { durationMs: glideMs } : {}) }
              : action.verb === "down"
                ? { kind: "down", button: action.button ?? "left", at: point, ...mods }
                : { kind: "up", button: action.button ?? "left", at: point };
      this.#check(ctx);
      if (identity) await this.#consume(ctx, action, identity, permit, readIdentity);
      this.#check(ctx);
      const window =
        known?.window !== undefined && known.window !== null && action.verb !== "up"
          ? { window: known.window }
          : {};
      let res: InputResult;
      try {
        if (glide && action.verb === "up" && (point.x !== from.x || point.y !== from.y)) {
          mark(true);
          await d.client.input(
            {
              input: { kind: "move", to: point, durationMs: glideMs },
              injector: "xtest",
              holdMs: 0,
            },
            ctx.signal,
          );
        }
        res = await d.client.input({ input, injector: "xtest", holdMs: 0, ...window }, ctx.signal);
      } catch (error) {
        // A press that failed may have left its button down; nothing else may.
        if (action.verb === "down") await d.client.release?.().catch(() => undefined);
        throw error;
      }
      mark(true);
      if (action.verb === "down") this.#hold(ctx, d, action.button ?? "left");
      else if (action.verb === "up") {
        this.#forget(ctx.cellId);
        notDown = res.releaseMono === undefined;
      } else this.#touch(ctx.cellId);
      const pressT = this.#pressT(ctx, d, res.pressMono);
      const ringAt = await this.deps.ringOnset.onset({
        pressT,
        injector: res.injector,
        kind: onsetKind(input),
        scale,
      });
      this.#append(ctx, "action.dispatch", { input, pressT, ringAt, injector: res.injector });
      this.#cursor.set(ctx.cellId, point);
      result = await this.#finish(
        ctx,
        d,
        action.verb === "move" ? "move" : action.verb === "scroll" ? "scroll" : "click",
        identity && { action, identity },
      );
    } finally {
      ended = true;
    }
    const outcome = await targetKnown;
    return {
      ok: true,
      ...result,
      ...(outcome.target ? { target: outcome.target } : {}),
      ...(notDown ? { notDown: true as const } : {}),
    };
  }

  // Press at the start, follow the path, let go at the end: one approval binds every point. The
  // start is checked against the model's screenshot; desktopd lets go only over the window the
  // drop point was in when it was approved, and where the drag started when it stops early.
  async #dragAction(
    ctx: ActionContext,
    action: Extract<GuiAction, { verb: "drag" }>,
    scale: 1 | 2,
    speed: Speed,
    mark: (v: boolean) => void,
  ): Promise<ActionOutcome> {
    const d = await this.#ready(ctx);
    const held = this.#held.get(ctx.cellId);
    if (held)
      throw new Cancelled(
        "preflight",
        `the ${held.button} button is still down; let go of it with left_mouse_up first`,
      );
    if (action.path.length < 2) throw new Cancelled("preflight", "a drag needs two points");
    const way = action.path.map((p) => toDevice(p, { ...MODEL_SCREEN, scale }));
    const start = way[0] as Point;
    const end = way.at(-1) as Point;
    const readIdentity = async (): Promise<NativeActionIdentity> => {
      const [at, drop] = await Promise.all([
        this.#lookup(ctx, d, start),
        this.#lookup(ctx, d, end),
      ]);
      return frozenSnapshot({ ...at, point: start, drop: { ...drop, point: end } });
    };
    const identity = ctx.source === "agent" ? await readIdentity() : undefined;
    const permit = identity
      ? await this.#authorize(ctx, action, identity, readIdentity)
      : undefined;
    const t0 = this.deps.now();
    const from = this.#cursor.get(ctx.cellId) ?? {
      x: (MODEL_SCREEN.width * scale) / 2,
      y: (MODEL_SCREEN.height * scale) / 2,
    };
    const width = identity?.target?.bbox
      ? Math.max(MIN_TARGET_PX * scale, Math.min(identity.target.bbox.w, identity.target.bbox.h))
      : UNKNOWN_TARGET_PX * scale;
    const travelMs = travelDurationMs(Math.hypot(start.x - from.x, start.y - from.y), width, speed);
    const leadMs = speed === "instant" ? 0 : intentLeadMs(speed);
    const startsAt = Math.round(microsToMs(this.#sessionT(ctx.sessionId, t0))) + leadMs;
    this.#append(ctx, "action.intent", {
      verb: "drag",
      label: clipText(
        action.label ??
          dragLabel(
            { target: identity?.target, point: start },
            { target: identity?.drop?.target, point: end },
          ),
        80,
      ),
      point: start,
      risk: "none",
      pointer: {
        from,
        to: start,
        startsAt,
        durationMs: travelMs,
        seed: Math.floor(Math.random() * 2 ** 31),
        curve: "minjerk-bow-v1",
      },
    });
    if (identity?.target)
      this.#append(ctx, "action.target", { target: clipTarget(identity.target) });
    // The animation exception compares the start's element with a fresh read of it alone.
    const startKnown: Promise<Lookup> = identity
      ? Promise.resolve({
          target: identity.target,
          window: identity.window,
          ...(identity.windowFrame ? { windowFrame: identity.windowFrame } : {}),
          ...(identity.unknown ? { unknown: true as const } : {}),
        })
      : this.#read(d, start);
    await this.#sleepUntil(
      ctx,
      speed === "instant" ? startsAt + INSTANT_LEAD_MS : startsAt + travelMs + dwellMs(speed),
    );
    for (;;) {
      await this.#waitForStream(ctx);
      if (action.basedOn) await this.#checkFresh(ctx, action.basedOn, start, scale, d, startKnown);
      this.#check(ctx);
      const stream = this.#stream(ctx);
      if (!stream || !holding(stream)) break;
    }
    const input: Input = {
      kind: "drag",
      from: start,
      to: end,
      ...(way.length > 2 ? { path: way.slice(1, -1) } : {}),
      button: action.button ?? "left",
      ...(action.mods?.length ? { mods: action.mods } : {}),
      durationMs: action.durationMs ?? dragDurationMs(way, scale, speed),
    };
    this.#check(ctx);
    if (identity) await this.#consume(ctx, action, identity, permit, readIdentity);
    this.#check(ctx);
    let dispatched = false;
    const dispatch = async (pressMono: number, injector: InputResult["injector"]) => {
      if (dispatched) return;
      dispatched = true;
      mark(true);
      const pressT = this.#pressT(ctx, d, pressMono);
      const ringAt = await this.deps.ringOnset.onset({ pressT, injector, kind: "click", scale });
      this.#append(ctx, "action.dispatch", { input, pressT, ringAt, injector });
    };
    let res: InputResult;
    try {
      res = await d.client.input(
        {
          input,
          injector: "xtest",
          holdMs: 0,
          ...(identity?.window !== undefined && identity.window !== null
            ? { window: identity.window }
            : {}),
          ...(identity?.drop?.window !== undefined && identity.drop.window !== null
            ? { dropWindow: identity.drop.window }
            : {}),
        },
        ctx.signal,
        (p) => dispatch(p.pressMono, "xtest"),
      );
    } catch (error) {
      // desktopd lets go where the drag started; this waits for every button to be up before
      // Stop or a takeover goes on.
      await d.client.release?.().catch(() => undefined);
      throw error;
    }
    await dispatch(res.pressMono, res.injector);
    this.#cursor.set(ctx.cellId, end);
    const settled = await this.#finish(ctx, d, "click", identity && { action, identity });
    return { ok: true, ...settled, ...(identity?.target ? { target: identity.target } : {}) };
  }

  async #typeAction(
    ctx: ActionContext,
    action: Extract<GuiAction, { verb: "type" }>,
    scale: 1 | 2,
    speed: Speed,
    mark: (v: boolean) => void,
  ): Promise<ActionOutcome> {
    const d = await this.#ready(ctx);
    let at = this.#cursor.get(ctx.cellId) ?? {
      x: (MODEL_SCREEN.width * scale) / 2,
      y: (MODEL_SCREEN.height * scale) / 2,
    };
    // Tab and keyboard navigation can move focus without moving the cursor.
    const readIdentity = async (): Promise<NativeActionIdentity> => {
      const fresh = await this.#lookup(ctx, d);
      return frozenSnapshot({ ...fresh, point: fresh.target?.point ?? null });
    };
    const identity = await readIdentity();
    const permit = await this.#authorize(ctx, action, identity, readIdentity);
    const masked =
      action.masked === true || identity.target === null || identity.target.secret === true;
    if (identity.target) at = identity.target.point;
    const chars = [...action.text].length;
    this.#append(ctx, "action.intent", {
      verb: "type",
      label: clipText(
        masked ? typeLabel(action.text, true) : (action.label ?? typeLabel(action.text, false)),
        80,
      ),
      point: at,
      risk: "none",
    });
    if (identity.target)
      this.#append(ctx, "action.target", { target: clipTarget(identity.target) });
    await this.#waitForStream(ctx);
    const pace = {
      firstMs: typingPaceMs(speed, 0),
      firstCount: 60,
      restMs: typingPaceMs(speed, 60),
    };
    let first = true;
    // Stop reaches the request itself: desktopd stops typing at the next key, however long the text.
    const typing = {
      text: action.text,
      masked,
      pace,
      injector: "xtest" as const,
      ...(identity.window ? { window: identity.window } : {}),
    };
    const fresh = await this.#consume(ctx, action, identity, permit, readIdentity);
    this.#check(ctx);
    const result = await d.client.type(
      typing,
      async (p) => {
        if (first) {
          first = false;
          mark(true);
          const pressT = this.#pressT(ctx, d, p.pressMono);
          const ringAt = await this.deps.ringOnset.onset({
            pressT,
            injector: "xtest",
            kind: "key",
            scale,
          });
          this.#append(ctx, "action.dispatch", {
            input: { kind: "type", chars, masked },
            pressT,
            ringAt,
            injector: "xtest",
          });
        }
        this.#append(ctx, "text.progress", {
          count: p.count,
          masked,
          ...(masked || p.chunk === undefined ? {} : { chunk: p.chunk }),
        });
      },
      ctx.signal,
    );
    if (result.count === 0) throw new Cancelled("timeout", "nothing was typed");
    const settled = await this.#finish(ctx, d, "type", { action, identity });
    return {
      ok: true,
      ...settled,
      ...(identity.target ? { target: identity.target } : {}),
      ...(fresh ? { focus: focusOf(fresh) } : {}),
    };
  }

  async #keyAction(
    ctx: ActionContext,
    action: Extract<GuiAction, { verb: "key" }>,
    scale: 1 | 2,
    speed: Speed,
    mark: (v: boolean) => void,
  ): Promise<ActionOutcome> {
    const d = await this.#ready(ctx);
    const readIdentity = async (): Promise<NativeActionIdentity> => {
      const hit = await this.#lookup(ctx, d);
      return frozenSnapshot({ ...hit, point: hit.target?.point ?? null });
    };
    const identity = ctx.source === "agent" ? await readIdentity() : undefined;
    const permit = identity
      ? await this.#authorize(ctx, action, identity, readIdentity)
      : undefined;
    this.#append(ctx, "action.intent", {
      verb: "key",
      label: clipText(action.label ?? keyLabel(action.combo, action), 80),
      risk: "none",
    });
    await this.deps.sleep(dwellMs(speed), ctx.signal);
    await this.#waitForStream(ctx);
    const input: Input = {
      kind: "key",
      combo: action.combo,
      ...(action.repeat && action.repeat > 1 ? { repeat: action.repeat } : {}),
      ...(action.holdMs ? { holdMs: action.holdMs } : {}),
    };
    const fresh = identity
      ? await this.#consume(ctx, action, identity, permit, readIdentity)
      : undefined;
    this.#check(ctx);
    // The input is dispatched once its first press is down: a repeat or a hold that stops later
    // still pressed keys. `downAt` is when a hold's keys went down, in daemon time.
    let dispatched = false;
    let presses = 0;
    let downAt = 0;
    const dispatch = async (pressMono: number, injector: InputResult["injector"]) => {
      if (dispatched) return;
      dispatched = true;
      downAt = this.deps.now();
      mark(true);
      const pressT = this.#pressT(ctx, d, pressMono);
      const ringAt = await this.deps.ringOnset.onset({ pressT, injector, kind: "key", scale });
      this.#append(ctx, "action.dispatch", { input, pressT, ringAt, injector });
    };
    let res: InputResult;
    try {
      res = await d.client.input(
        {
          input,
          injector: "xtest",
          holdMs: 0,
          ...(identity?.window !== undefined && identity.window !== null
            ? { window: identity.window }
            : {}),
        },
        ctx.signal,
        async (p) => {
          presses = p.presses;
          await dispatch(p.pressMono, "xtest");
        },
      );
    } catch (error) {
      // A hold that was stopped, or keys that failed partway, may still be down. desktopd and its
      // helper release them too; this waits for it before Stop or a takeover goes on.
      await d.client.release?.().catch(() => undefined);
      if (!dispatched) throw error;
      const heldMs = action.holdMs
        ? Math.min(action.holdMs, Math.round((this.deps.now() - downAt) / 1000))
        : undefined;
      const cause = ctx.signal?.aborted ? ctx.signal.reason : error;
      const raw = cause instanceof Error ? cause.message : "stopped";
      const why = ctx.redact ? ctx.redact(raw) : raw;
      const done =
        heldMs === undefined
          ? `${presses} of ${action.repeat ?? 1} presses`
          : `holding for ${seconds(heldMs)} s of ${seconds(action.holdMs ?? 0)} s`;
      return {
        ...this.#fail(ctx, new Error(`Stopped after ${done}: ${why}`), true),
        error: why,
        partial: { presses, ...(heldMs === undefined ? {} : { heldMs }) },
        ...(fresh ? { focus: focusOf(fresh) } : {}),
      };
    }
    await dispatch(res.pressMono, res.injector);
    const settled = await this.#finish(ctx, d, "key", identity && { action, identity });
    return { ok: true, ...settled, ...(fresh ? { focus: focusOf(fresh) } : {}) };
  }

  // The element under a point, or keyboard focus without one. A lookup that failed or ran out of
  // time is unknown: it never reads as "no element".
  async #read(d: NativeDevice, point?: Point): Promise<Lookup> {
    const hit = await Promise.race([
      (point ? d.client.hitTest(point) : d.client.focused()).catch(() => UNKNOWN),
      timeoutAfter(this.deps.hitTestTimeoutMs ?? LOOKUP_TIMEOUT_MS, UNKNOWN),
    ]);
    return {
      target: hit.target,
      window: hit.window,
      ...(hit.windowFrame ? { windowFrame: hit.windowFrame } : {}),
      ...(hit.unknown ? { unknown: true as const } : {}),
    };
  }

  async #lookup(ctx: ActionContext, d: NativeDevice, point?: Point): Promise<Lookup> {
    const hit = await this.#read(d, point);
    this.#check(ctx);
    return hit;
  }

  async #authorize(
    ctx: ActionContext,
    action: GuiAction,
    identity: NativeActionIdentity,
    read: () => Promise<NativeActionIdentity>,
  ): Promise<NativeActionPermit | undefined> {
    this.#check(ctx);
    if (ctx.source === "manual") return undefined;
    if (ctx.source !== "agent" || !ctx.authorizeAgent)
      throw new Cancelled("preflight", "this native action has no admitted owner");
    const permit = await ctx.authorizeAgent({
      action,
      identity,
      revalidate: async () => {
        const fresh = await read();
        this.#check(ctx);
        return sameNativeIdentity(identity, fresh);
      },
    });
    this.#check(ctx);
    if (!permit)
      throw new Cancelled("user", "this action was not authorized; do not retry automatically");
    return permit;
  }

  // The read just before input, once it confirmed the approved identity; none for manual input.
  async #consume(
    ctx: ActionContext,
    action: GuiAction,
    identity: NativeActionIdentity,
    permit: NativeActionPermit | undefined,
    read: () => Promise<NativeActionIdentity>,
  ): Promise<NativeActionIdentity | undefined> {
    this.#check(ctx);
    if (ctx.source === "manual") return undefined;
    const fresh = await read();
    this.#check(ctx);
    // The permit and the repeat guard bind the approved identity; the fresh read only confirms it.
    if (!sameNativeIdentity(identity, fresh) || !permit?.consume(action, identity, fresh))
      throw new Cancelled(
        "stale",
        "the approved action or target changed; look again before acting",
      );
    if (ctx.beforeEffect?.(action, identity) !== true)
      throw new Cancelled(
        "user",
        "this input was paused before dispatch; wait for explicit Resume",
      );
    return fresh;
  }

  // settle → observe → result; returns this action's own frame, never a concurrent action's, and
  // whether the screen changed: settle saw a change and the frame differs from the one before.
  // `admitted` is the input beforeEffect admitted, which afterEffect hears about.
  async #finish(
    ctx: ActionContext,
    d: NativeDevice,
    verb: keyof typeof SETTLE_FIRST_MS,
    admitted?: { action: GuiAction; identity: NativeActionIdentity },
  ): Promise<{ frameId: string; changed: boolean }> {
    this.#check(ctx);
    const before = this.#lastFrame.get(ctx.cellId)?.digest;
    const s = await d.client.settle({
      verb: verb === "move" ? "click" : verb,
      quietMs: SETTLE_QUIET_MS,
      firstMs: SETTLE_FIRST_MS[verb],
      timeoutMs: SETTLE_CAP_MS,
    });
    const frameT =
      s.lastChangeMono === null
        ? this.#sessionT(ctx.sessionId, this.deps.now())
        : this.#sessionT(ctx.sessionId, d.clocks.toDaemonMicros(s.lastChangeMono));
    this.#append(ctx, "screen.settle", {
      frameT,
      changed: s.changed.map(roundRect),
      noVisibleChange: s.noVisibleChange,
    });
    const o = await this.observe(ctx);
    const changed = !s.noVisibleChange && this.#lastFrame.get(ctx.cellId)?.digest !== before;
    if (admitted) ctx.afterEffect?.(admitted.action, admitted.identity, changed);
    this.#append(ctx, "action.result", { ok: true });
    return { frameId: o.frameId, changed };
  }

  #fail(ctx: ActionContext, err: unknown, dispatched: boolean): ActionOutcome {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = ctx.redact ? ctx.redact(rawMessage) : rawMessage;
    if (dispatched) {
      this.#append(ctx, "action.result", { ok: false, error: message.slice(0, 500) });
      return {
        ok: false,
        error: message,
        ...(ctx.signal?.aborted ? { cancelled: "user" as const } : {}),
      };
    }
    const reason =
      err instanceof Cancelled
        ? err.reason
        : err instanceof DesktopdError && err.status === 504
          ? "timeout"
          : ctx.signal?.aborted
            ? "user"
            : "preflight";
    this.#append(ctx, "action.cancel", { reason, detail: message.slice(0, 500) });
    return {
      ok: false,
      error: message,
      cancelled: reason,
      ...(err instanceof Cancelled && err.frameId ? { frameId: err.frameId } : {}),
    };
  }

  async #checkFresh(
    ctx: ActionContext,
    basedOn: string,
    devicePoint: Point,
    scale: 1 | 2,
    desktop: NativeDevice,
    firstTarget: Promise<Lookup>,
  ): Promise<void> {
    const basisPath = this.deps.frames.path(ctx.sessionId, basedOn);
    if (!basisPath) return; // Preserve the original optional, best-effort basis contract.
    const point = { x: devicePoint.x / scale, y: devicePoint.y / scale };
    let basis: Buffer;
    let first: Buffer;
    let freshId: string | undefined;
    try {
      this.#check(ctx);
      const observed = await this.observe(ctx);
      freshId = observed.frameId;
      const firstPath = this.deps.frames.path(ctx.sessionId, freshId);
      if (!firstPath) return;
      [basis, first] = await Promise.all([
        readFile(basisPath).then(frameLuma),
        readFile(firstPath).then(frameLuma),
      ]);
      this.#check(ctx);
      if (!lumaRegionChanged(basis, first, point).changed) return;
    } catch (error) {
      this.#check(ctx); // Stop is never converted into a best-effort allow.
      if (error instanceof Cancelled) throw error;
      return;
    }
    // Once change is established, a missing/error/aborted second observation cannot authorize
    // an animation exception. The model receives the newest successfully stored full frame.
    try {
      const initialTarget = await firstTarget;
      this.#check(ctx);
      await this.deps.sleep(100, ctx.signal);
      this.#check(ctx);
      const observed = await this.observe(ctx);
      freshId = observed.frameId;
      const secondPath = this.deps.frames.path(ctx.sessionId, freshId);
      if (!secondPath) throw new Error("missing second freshness frame");
      const second = await readFile(secondPath).then(frameLuma);
      this.#check(ctx);
      const nextTarget = await this.#lookup(ctx, desktop, devicePoint);
      if (
        !sameNativeIdentity(
          { ...initialTarget, point: devicePoint },
          { ...nextTarget, point: devicePoint },
        )
      )
        throw new Error("the target changed");
      const bounds = initialTarget.target?.bbox;
      const modelBounds = bounds
        ? { x: bounds.x / scale, y: bounds.y / scale, w: bounds.w / scale, h: bounds.h / scale }
        : undefined;
      if (animationKeepsTarget(basis, first, second, point, modelBounds)) return;
    } catch (error) {
      this.#check(ctx);
      if (error instanceof Cancelled) throw error;
    }
    throw new Cancelled("stale", "the target changed since the model's screenshot", freshId);
  }

  #desktopd(cellId: string): NativeDevice {
    const d = this.deps.registry.for(cellId);
    if (!d) throw new Cancelled("preflight", `cell ${cellId} has no desktopd endpoint`);
    return d;
  }

  // The clock map must be synced before a press time is mapped: the registry re-syncs on a timer,
  // the first action on a cell syncs here.
  async #ready(ctx: ActionContext): Promise<NativeDevice> {
    this.#check(ctx);
    const d = ctx.screen?.device ?? this.#desktopd(ctx.cellId);
    if (!d.clocks.sample) await d.clocks.sync();
    this.#check(ctx);
    return d;
  }

  #pressT(ctx: ActionContext, d: NativeDevice, pressMono: number): number {
    if (!d.clocks.sample) throw new Cancelled("preflight", "desktopd clock not synced");
    // The press happened before this call returned; a mapping error of a millisecond must not put
    // it after the event that records it.
    return Math.min(
      this.#sessionT(ctx.sessionId, d.clocks.toDaemonMicros(pressMono)),
      this.#sessionT(ctx.sessionId, this.deps.now()),
    );
  }

  #sessionT(sessionId: string, daemonMicros: number): number {
    return this.deps.eventLog.toSessionT(sessionId, daemonMicros);
  }

  async #sleepUntil(ctx: ActionContext, sessionMs: number): Promise<void> {
    const remaining = sessionMs - microsToMs(this.#sessionT(ctx.sessionId, this.deps.now()));
    if (remaining > 0) await this.deps.sleep(remaining, ctx.signal);
    ctx.signal?.throwIfAborted();
  }

  // Spec, error handling: the gateway holds dispatch until the connection is back.
  async #waitForStream(ctx: ActionContext): Promise<void> {
    this.#check(ctx);
    const stream = this.#stream(ctx);
    if (!stream || !holding(stream)) return;
    await new Promise<void>((resolve, reject) => {
      const subscriptions: (() => void)[] = [];
      let settled = false;
      const clean = () => {
        settled = true;
        for (const off of subscriptions.splice(0)) off();
        ctx.signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        clean();
        reject(new Cancelled("user", "stopped while holding for the stream"));
      };
      const check = () => {
        if (settled) return;
        try {
          this.#check(ctx);
          const current = this.#stream(ctx);
          if (current && !holding(current)) {
            clean();
            resolve();
          }
        } catch (err) {
          clean();
          reject(err);
        }
      };
      const add = (off: () => void) => {
        if (settled) off();
        else subscriptions.push(off);
      };
      try {
        add(
          this.deps.cells.subscribe((cell) => {
            if (cell.id === (ctx.screen?.parentCellId ?? ctx.cellId)) check();
          }),
        );
        if (ctx.screen) add(ctx.screen.subscribe(check));
        ctx.signal?.addEventListener("abort", abort, { once: true });
        check();
        if (settled) ctx.signal?.removeEventListener("abort", abort);
      } catch (error) {
        clean();
        reject(error);
      }
    });
  }

  #check(ctx: ActionContext): void {
    if (ctx.signal?.aborted) throw new Cancelled("user", "session stopped");
    if (ctx.screen) {
      if (ctx.screen.cellId !== ctx.cellId || ![1, 2].includes(ctx.screen.scale))
        throw new Cancelled("preflight", "the screen does not match the admitted action");
      ctx.screen.check();
    }
    const cell = this.deps.cells.get(ctx.screen?.parentCellId ?? ctx.cellId);
    if (cell?.state !== "ready")
      throw new Cancelled("preflight", `cell is ${cell?.state ?? "missing"}`);
    if (cell.fenced || cell.replacementPending)
      throw new Cancelled(
        "preflight",
        "the computer is fenced or awaiting replacement confirmation",
      );
    if (cell.paused) throw new Cancelled("preflight", "the computer is paused");
  }

  #owner(ctx: ActionContext): ActionContext {
    const screen = ctx.screen ? Object.freeze({ ...ctx.screen }) : undefined;
    return Object.freeze({
      ...ctx,
      ...(screen
        ? {
            screen,
            signal: AbortSignal.any([screen.signal, ...(ctx.signal ? [ctx.signal] : [])]),
          }
        : {}),
    });
  }

  #stream(ctx: ActionContext): StreamState | undefined {
    return ctx.screen ? ctx.screen.stream() : this.deps.cells.get(ctx.cellId)?.stream;
  }

  #append(ctx: ActionContext, type: string, data: Record<string, unknown>): void {
    const clean = (value: unknown): unknown =>
      typeof value === "string"
        ? ctx.redact
          ? ctx.redact(value)
          : value
        : Array.isArray(value)
          ? value.map(clean)
          : value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]))
            : value;
    this.deps.eventLog.append(ctx.sessionId, {
      type,
      agent: ctx.agent ?? DEFAULT_AGENT,
      ...(ctx.step ? { step: ctx.step } : {}),
      data: clean(data),
    } as never);
  }
}

const seconds = (ms: number) => Number((ms / 1000).toFixed(1));

function focusOf(read: NativeActionIdentity): NonNullable<ActionOutcome["focus"]> {
  return { target: read.target, ...(read.unknown ? { unknown: true as const } : {}) };
}

function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

// A real timer, never the injected sleep: tests drive a fake clock through `sleep`, and a hit-test
// timeout must not advance the presentation clock.
function timeoutAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms).unref());
}

function frozenSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
