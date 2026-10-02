import {
  clipText,
  type Input,
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
import type { CellDesktopd, DesktopdRegistry } from "../desktopd/registry.ts";
import type { EventLog } from "../event-log.ts";
import type { FrameStore } from "./frames.ts";
import { type OnsetTable, onsetKind } from "./onset-table.ts";
import type { RingOnsetPolicy } from "./ring-onset.ts";
import { clickLabel, clipTarget, keyLabel, scrollLabel, typeLabel } from "./text.ts";

export const DEFAULT_AGENT = "main";
const MODEL_SCREEN = { width: 1280, height: 800 } as const;
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
      speed?: Speed | "auto";
    }
  | { verb: "type"; label?: string; text: string; masked?: boolean; speed?: Speed | "auto" }
  | { verb: "key"; label?: string; combo: string[]; speed?: Speed | "auto" }
  | { verb: "scroll"; label?: string; point: Point; dx: number; dy: number; speed?: Speed | "auto" }
  | { verb: "wait"; label?: string; ms: number };

export interface ActionContext {
  sessionId: string;
  cellId: string;
  agent?: string;
  step?: string;
  signal?: AbortSignal;
}

export interface ActionOutcome {
  ok: boolean;
  frameId?: string;
  target?: Target;
  error?: string;
  cancelled?: "preflight" | "user" | "timeout";
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
}

class Cancelled extends Error {
  constructor(
    readonly reason: "preflight" | "user" | "timeout",
    message: string,
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

export class ActionGateway {
  readonly #cursor = new Map<string, Point>();
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: GatewayDeps) {}

  cursorOf(cellId: string): Point | undefined {
    return this.#cursor.get(cellId);
  }

  // A fresh frame for the brain (M4) and for the step thumbnails; also where the cursor starts.
  async observe(ctx: ActionContext): Promise<{ frameId: string; pointer: Point }> {
    const d = await this.#ready(ctx);
    const o = await d.client.observe(ctx.signal);
    this.#check(ctx);
    this.deps.frames.save(ctx.sessionId, o.frameId, Buffer.from(o.image, "base64"));
    this.#append(ctx, "observe", { frameId: o.frameId, width: o.width, height: o.height });
    this.#cursor.set(ctx.cellId, o.pointer);
    return { frameId: o.frameId, pointer: o.pointer };
  }

  async run(ctx: ActionContext, action: GuiAction): Promise<ActionOutcome> {
    const before = this.#queues.get(ctx.cellId) ?? Promise.resolve();
    const task = before.catch(() => {}).then(() => this.#run(ctx, action));
    this.#queues.set(ctx.cellId, task);
    try {
      return await task;
    } finally {
      if (this.#queues.get(ctx.cellId) === task) this.#queues.delete(ctx.cellId);
    }
  }

  async #run(ctx: ActionContext, action: GuiAction): Promise<ActionOutcome> {
    const cell = this.deps.cells.get(ctx.cellId);
    if (!cell) throw new Error(`unknown cell ${ctx.cellId}`);
    const scale = cell.scale;
    const speed: Speed =
      "speed" in action && action.speed && action.speed !== "auto"
        ? action.speed
        : cell.stream.viewers > 0
          ? "watch"
          : "fast";
    let dispatched = false;
    try {
      this.#check(ctx);
      switch (action.verb) {
        case "wait": {
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
          return await this.#pointerAction(ctx, action, scale, speed, (v) => {
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
    action: Extract<GuiAction, { verb: "click" | "scroll" }>,
    scale: 1 | 2,
    speed: Speed,
    mark: (v: boolean) => void,
  ): Promise<ActionOutcome> {
    const d = await this.#ready(ctx);
    const t0 = this.deps.now();
    let found: { target: Target | null; window: number | null } | undefined;
    let point: Point;
    if (action.verb === "click" && action.find) {
      found = await d.client.find(action.find);
      if (!found.target)
        throw new Cancelled("preflight", `no element named ${JSON.stringify(action.find.name)}`);
      point = found.target.point;
    } else if (action.point) {
      point = toDevice(action.point, { ...MODEL_SCREEN, scale });
    } else throw new Cancelled("preflight", "click needs a point or a find");

    const from = this.#cursor.get(ctx.cellId) ?? {
      x: (MODEL_SCREEN.width * scale) / 2,
      y: (MODEL_SCREEN.height * scale) / 2,
    };
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
    const verb = action.verb === "click" ? "click" : "scroll";
    const label =
      action.label ??
      (action.verb === "click"
        ? clickLabel(found?.target ?? null, point)
        : scrollLabel(action.dx, action.dy));
    this.#append(ctx, "action.intent", {
      verb,
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
    const lookup: Promise<{ target: Target | null; window: number | null }> = found
      ? Promise.resolve(found)
      : Promise.race([
          d.client.hitTest(point).catch(() => ({ target: null, window: null })),
          timeoutAfter<{ target: Target | null; window: number | null }>(
            this.deps.hitTestTimeoutMs ?? 2500,
            { target: null, window: null },
          ),
        ]);
    let known: { target: Target | null; window: number | null } | undefined = found;
    const targetKnown = lookup.then((r) => {
      known = r;
      if (r.target && !ended) this.#append(ctx, "action.target", { target: clipTarget(r.target) });
      return r;
    });
    let frameId: string;
    try {
      const pressAtMs =
        speed === "instant" ? startsAt + INSTANT_LEAD_MS : startsAt + durationMs + dwellMs(speed);
      await this.#sleepUntil(ctx, pressAtMs);
      await this.#waitForStream(ctx);
      const input: Input =
        action.verb === "click"
          ? { kind: "click", button: action.button ?? "left", count: action.count ?? 1, at: point }
          : { kind: "scroll", at: point, dx: action.dx, dy: action.dy };
      this.#check(ctx);
      const res = await d.client.input(
        {
          input,
          injector: "xtest",
          holdMs: 0,
          ...(known?.window ? { window: known.window } : {}),
        },
        ctx.signal,
      );
      mark(true);
      const pressT = this.#pressT(ctx, d, res.pressMono);
      const ringAt = await this.deps.ringOnset.onset({
        pressT,
        injector: res.injector,
        kind: onsetKind(input),
        scale,
      });
      this.#append(ctx, "action.dispatch", { input, pressT, ringAt, injector: res.injector });
      this.#cursor.set(ctx.cellId, point);
      frameId = await this.#finish(ctx, d);
    } finally {
      ended = true;
    }
    const outcome = await targetKnown;
    return { ok: true, frameId, ...(outcome.target ? { target: outcome.target } : {}) };
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
    const hit = await Promise.race([
      d.client.focused().catch(() => ({ target: null, window: null })),
      timeoutAfter<{ target: Target | null; window: number | null }>(
        this.deps.hitTestTimeoutMs ?? 2500,
        { target: null, window: null },
      ),
    ]);
    this.#check(ctx);
    const masked = action.masked === true || hit.target === null || hit.target.secret === true;
    if (hit.target) at = hit.target.point;
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
    if (hit.target) this.#append(ctx, "action.target", { target: clipTarget(hit.target) });
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
      ...(hit.window ? { window: hit.window } : {}),
    };
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
    const frameId = await this.#finish(ctx, d);
    return { ok: true, frameId, ...(hit.target ? { target: hit.target } : {}) };
  }

  async #keyAction(
    ctx: ActionContext,
    action: Extract<GuiAction, { verb: "key" }>,
    scale: 1 | 2,
    speed: Speed,
    mark: (v: boolean) => void,
  ): Promise<ActionOutcome> {
    const d = await this.#ready(ctx);
    this.#append(ctx, "action.intent", {
      verb: "key",
      label: clipText(action.label ?? keyLabel(action.combo), 80),
      risk: "none",
    });
    await this.deps.sleep(dwellMs(speed), ctx.signal);
    await this.#waitForStream(ctx);
    const input: Input = { kind: "key", combo: action.combo };
    const res = await d.client.input({ input, injector: "xtest", holdMs: 0 }, ctx.signal);
    mark(true);
    const pressT = this.#pressT(ctx, d, res.pressMono);
    const ringAt = await this.deps.ringOnset.onset({
      pressT,
      injector: res.injector,
      kind: "key",
      scale,
    });
    this.#append(ctx, "action.dispatch", { input, pressT, ringAt, injector: res.injector });
    const frameId = await this.#finish(ctx, d);
    return { ok: true, frameId };
  }

  // settle → observe → result; returns this action's own frame, never a concurrent action's.
  async #finish(ctx: ActionContext, d: CellDesktopd): Promise<string> {
    this.#check(ctx);
    const s = await d.client.settle({ quietMs: SETTLE_QUIET_MS, timeoutMs: SETTLE_CAP_MS });
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
    this.#append(ctx, "action.result", { ok: true });
    return o.frameId;
  }

  #fail(ctx: ActionContext, err: unknown, dispatched: boolean): ActionOutcome {
    const message = err instanceof Error ? err.message : String(err);
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
    return { ok: false, error: message, cancelled: reason };
  }

  #desktopd(cellId: string): CellDesktopd {
    const d = this.deps.registry.for(cellId);
    if (!d) throw new Cancelled("preflight", `cell ${cellId} has no desktopd endpoint`);
    return d;
  }

  // The clock map must be synced before a press time is mapped: the registry re-syncs on a timer,
  // the first action on a cell syncs here.
  async #ready(ctx: ActionContext): Promise<CellDesktopd> {
    this.#check(ctx);
    const d = this.#desktopd(ctx.cellId);
    if (!d.clocks.sample) await d.clocks.sync();
    this.#check(ctx);
    return d;
  }

  #pressT(ctx: ActionContext, d: CellDesktopd, pressMono: number): number {
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
    const stream = this.deps.cells.get(ctx.cellId)?.stream;
    if (!stream || !holding(stream)) return;
    await new Promise<void>((resolve, reject) => {
      let off = () => {};
      const clean = () => {
        off();
        ctx.signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        clean();
        reject(new Cancelled("user", "stopped while holding for the stream"));
      };
      const check = () => {
        try {
          this.#check(ctx);
          const current = this.deps.cells.get(ctx.cellId);
          if (current && !holding(current.stream)) {
            clean();
            resolve();
          }
        } catch (err) {
          clean();
          reject(err);
        }
      };
      off = this.deps.cells.subscribe((cell) => {
        if (cell.id === ctx.cellId) check();
      });
      ctx.signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  #check(ctx: ActionContext): void {
    if (ctx.signal?.aborted) throw new Cancelled("user", "session stopped");
    const cell = this.deps.cells.get(ctx.cellId);
    if (cell?.state !== "ready")
      throw new Cancelled("preflight", `cell is ${cell?.state ?? "missing"}`);
  }

  #append(ctx: ActionContext, type: string, data: Record<string, unknown>): void {
    this.deps.eventLog.append(ctx.sessionId, {
      type,
      agent: ctx.agent ?? DEFAULT_AGENT,
      ...(ctx.step ? { step: ctx.step } : {}),
      data,
    } as never);
  }
}

function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

// A real timer, never the injected sleep: tests drive a fake clock through `sleep`, and a hit-test
// timeout must not advance the presentation clock.
function timeoutAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms).unref());
}
