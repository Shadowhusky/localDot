import type { LocalDotEvent, Point } from "@localdot/protocol";
import { APPEARANCE_EVENT } from "../onboarding/appearance.ts";
import type { FrameSource } from "./frame-source.ts";
import { KEEP_MS } from "./live-stream.ts";
import { manualPoint } from "./manual-point.ts";
import type { Flip, ProbeRect } from "./probe.ts";
import type { PumpStats } from "./pump.ts";
import { readTheme, type StageTheme } from "./theme.ts";
import type {
  OracleCommand,
  OracleRequest,
  ReplayProbeCommand,
  ReplayProbeRequest,
  ReplaySource,
  ReplayTransport,
  StageClock,
  StageViewPatch,
  WorkerIn,
  WorkerOut,
} from "./worker-protocol.ts";

export type ReplayMessage = Extract<
  WorkerOut,
  { type: "replay-time" | "replay-status" | "replay-ended" }
>;
export interface ReplayHandle {
  open(source: ReplaySource): void;
  transport(transport: ReplayTransport): void;
  seek(tMs: number, mode: "exact" | "preview"): void;
  close(): void;
  onReplay(listener: (message: ReplayMessage) => void): () => void;
  probe(command: ReplayProbeRequest): Promise<unknown>;
}

export interface StageCanvasHandle {
  replay: ReplayHandle;
  attach(source: FrameSource): void;
  detach(): void;
  probe(rect: ProbeRect | null, threshold?: number): void;
  pushEvents(events: LocalDotEvent[]): void;
  resetSession(): void;
  setClock(clock: StageClock): void;
  setView(view: StageViewPatch): void;
  setTheme(theme: StageTheme): void;
  manualPoint(point: Point, screen: { w: number; h: number }, follow?: boolean): Point | null;
  oracle(command: OracleRequest): Promise<unknown>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const reducedMotionQuery = () => window.matchMedia("(prefers-reduced-motion: reduce)");

// The stage's canvas and the worker that owns it. It lives apart from React, so a stage that moves
// to another container or remounts keeps its picture, its overlays and its frame pump.
export class StageEngine implements StageCanvasHandle {
  readonly canvas = document.createElement("canvas");
  readonly replay: ReplayHandle;
  #worker: Worker | null = null;
  #closed = false;
  #anchor: Element | null = null;
  #source: FrameSource | null = null;
  #sourceId = 0;
  #viewport = { w: 1, h: 1 };
  #pendingOracle = new Map<number, Pending>();
  #oracleSeq = 0;
  #pendingReplay = new Map<number, Pending>();
  #replaySeq = 0;
  #replayListeners = new Set<(message: ReplayMessage) => void>();
  #statsListeners = new Set<(stats: PumpStats) => void>();
  #flipListeners = new Set<(flip: Flip) => void>();
  #teardown: () => void = () => {};

  constructor() {
    this.canvas.className = "stage-canvas";
    this.canvas.setAttribute("aria-label", "The virtual computer");
    this.#mark(null);
    this.replay = {
      open: (source) => {
        this.#sourceId++;
        this.#source?.stop();
        this.#source = null;
        this.#post({ type: "replay-open", source });
      },
      transport: (transport) => this.#post({ type: "replay-transport", transport }),
      seek: (tMs, mode) => this.#post({ type: "replay-seek", tMs, mode }),
      close: () => this.#post({ type: "replay-close" }),
      onReplay: (listener) => {
        this.#replayListeners.add(listener);
        return () => this.#replayListeners.delete(listener);
      },
      probe: (command) => {
        if (new URLSearchParams(window.location.search).get("replayProbe") !== "1")
          return Promise.reject(new Error("Replay probe is disabled."));
        return this.#ask(
          this.#pendingReplay,
          ++this.#replaySeq,
          "Replay probe timed out.",
          (id) => ({
            type: "replay-probe",
            command: { ...command, id } as ReplayProbeCommand,
          }),
        );
      },
    };
  }

  onStats(listener: (stats: PumpStats) => void): () => void {
    this.#statsListeners.add(listener);
    return () => this.#statsListeners.delete(listener);
  }

  onFlip(listener: (flip: Flip) => void): () => void {
    this.#flipListeners.add(listener);
    return () => this.#flipListeners.delete(listener);
  }

  // Shows the canvas just before `anchor`. The first placement starts the worker at the size the
  // canvas has there; the worker owns the canvas from then on.
  place(anchor: Element): void {
    this.#anchor = anchor;
    anchor.before(this.canvas);
    if (!this.#worker && !this.#closed) this.#start();
  }

  // Takes the canvas out of `anchor`'s place, unless a newer placement has it.
  unplace(anchor: Element): void {
    if (this.#anchor !== anchor) return;
    this.#anchor = null;
    this.canvas.remove();
  }

  close(): void {
    this.#closed = true;
    this.canvas.remove();
    this.#teardown();
  }

  #start(): void {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const motion = reducedMotionQuery();
    const worker = new Worker(new URL("./render-worker.ts", import.meta.url), { type: "module" });
    const offscreen = canvas.transferControlToOffscreen();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    this.#viewport = { w: width, h: height };
    worker.postMessage(
      {
        type: "init",
        canvas: offscreen,
        width,
        height,
        dpr,
        theme: readTheme(getComputedStyle(document.documentElement)),
        reducedMotion: motion.matches,
      } satisfies WorkerIn,
      [offscreen],
    );
    worker.onmessage = (e: MessageEvent<WorkerOut>) => this.#receive(e.data);
    const onMotion = () => this.#post({ type: "view", view: { reducedMotion: motion.matches } });
    motion.addEventListener("change", onMotion);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      // Explicit DPR also respects Chromium's emulated HiDPI: its devicePixelContentBoxSize
      // describes native display pixels and can disagree with the page's devicePixelRatio.
      const w = Math.round((entry?.contentRect.width ?? 0) * dpr);
      const h = Math.round((entry?.contentRect.height ?? 0) * dpr);
      if (w > 0 && h > 0) {
        this.#viewport = { w, h };
        this.#post({ type: "resize", width: w, height: h });
      }
    });
    observer.observe(canvas);
    const onAppearance = () =>
      this.#post({ type: "theme", theme: readTheme(getComputedStyle(document.documentElement)) });
    window.addEventListener(APPEARANCE_EVENT, onAppearance);
    this.#worker = worker;
    this.#teardown = () => {
      window.removeEventListener(APPEARANCE_EVENT, onAppearance);
      motion.removeEventListener("change", onMotion);
      observer.disconnect();
      this.#source?.stop();
      this.#source = null;
      for (const pending of [...this.#pendingOracle.values(), ...this.#pendingReplay.values()]) {
        clearTimeout(pending.timer);
        pending.reject(new Error("stage closed"));
      }
      this.#pendingOracle.clear();
      this.#pendingReplay.clear();
      this.#replayListeners.clear();
      this.#statsListeners.clear();
      this.#flipListeners.clear();
      worker.postMessage({ type: "replay-close" } satisfies WorkerIn);
      worker.terminate();
      this.#worker = null;
    };
  }

  #receive(m: WorkerOut): void {
    if (m.type === "stats") {
      if (!this.#source || m.sourceId !== this.#sourceId) return;
      this.#mark(m.stats);
      for (const listener of this.#statsListeners) listener(m.stats);
    } else if (m.type === "flip") for (const listener of this.#flipListeners) listener(m.flip);
    else if (m.type === "oracle-reply") this.#settle(this.#pendingOracle, m.id, m.reply);
    else if (m.type === "replay-probe-reply") this.#settle(this.#pendingReplay, m.id, m.reply);
    else if (m.type === "warn") console.warn(`stage worker: ${m.message}`);
    else if (m.type === "error") console.error(`stage worker: ${m.message}`);
    else for (const listener of this.#replayListeners) listener(m);
  }

  #mark(stats: PumpStats | null): void {
    this.canvas.dataset.frames = String(stats?.presented ?? 0);
    this.canvas.dataset.fps = String(stats?.fps ?? 0);
    this.canvas.dataset.size = stats ? `${stats.width}x${stats.height}` : "";
  }

  #post(message: WorkerIn, transfer?: Transferable[]): void {
    this.#worker?.postMessage(message, transfer ?? []);
  }

  #settle(pending: Map<number, Pending>, id: number, reply: unknown): void {
    const waiting = pending.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    pending.delete(id);
    waiting.resolve(reply);
  }

  #ask(
    pending: Map<number, Pending>,
    id: number,
    timeout: string,
    message: (id: number) => WorkerIn,
  ): Promise<unknown> {
    const worker = this.#worker;
    if (!worker) return Promise.reject(new Error("stage not ready"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(timeout));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage(message(id));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  attach(source: FrameSource): void {
    const id = ++this.#sourceId;
    this.#source?.stop();
    this.#source = source;
    const worker = this.#worker;
    if (!worker) {
      source.stop();
      this.#source = null;
      return;
    }
    // S8's seed frame travels with the readable; both are transferred.
    if (source.readable) {
      const transfer: Transferable[] = source.first
        ? [source.readable, source.first]
        : [source.readable];
      try {
        worker.postMessage(
          { type: "frames", sourceId: id, readable: source.readable, first: source.first },
          transfer,
        );
      } catch (err) {
        source.stop();
        this.#source = null;
        void source.readable.cancel().catch(() => {});
        console.warn("could not attach desktop frames", err);
      }
      return;
    }
    if (!source.frames) {
      source.stop();
      this.#source = null;
      return;
    }
    worker.postMessage(
      { type: "frames", sourceId: id, pushed: true, first: source.first } satisfies WorkerIn,
      source.first ? [source.first] : [],
    );
    source.frames((frame) => {
      if (this.#sourceId !== id) {
        frame.close();
        return;
      }
      try {
        worker.postMessage({ type: "frame", sourceId: id, frame } satisfies WorkerIn, [frame]);
      } catch {
        frame.close();
      }
    });
  }

  detach(): void {
    this.#sourceId += 1;
    this.#source?.stop();
    this.#source = null;
    this.#post({ type: "stop" });
  }

  probe(rect: ProbeRect | null, threshold = 128): void {
    this.#post({ type: "probe", rect, threshold });
  }

  pushEvents(events: LocalDotEvent[]): void {
    this.#post({ type: "events", events });
  }

  resetSession(): void {
    this.#post({ type: "session-reset" });
  }

  setClock(clock: StageClock): void {
    this.#post({ type: "clock", clock });
  }

  setView(view: StageViewPatch): void {
    this.#post({ type: "view", view });
  }

  // A theme pack restyles the stage by sending its parsed tokens (the stage reads tokens once).
  setTheme(theme: StageTheme): void {
    this.#post({ type: "theme", theme });
  }

  manualPoint(point: Point, screen: { w: number; h: number }, follow = false): Point | null {
    if (!this.canvas.isConnected) return null;
    return manualPoint(this.canvas.getBoundingClientRect(), screen, point, this.#viewport, follow);
  }

  oracle(command: OracleRequest): Promise<unknown> {
    return this.#ask(this.#pendingOracle, ++this.#oracleSeq, "stage oracle timed out", (id) => ({
      type: "oracle",
      command: { ...command, id } as OracleCommand,
    }));
  }
}

interface Kept {
  engine: StageEngine;
  holders: number;
  timer?: ReturnType<typeof setTimeout>;
}

const kept = new WeakMap<object, Kept>();

// A stage engine. With a `keep` key, the engine is shared under that key and outlives its last
// holder by KEEP_MS, so the live stage survives a remount; without one it closes with its holder.
export function holdEngine(keep: object | null): { engine: StageEngine; release(): void } {
  if (!keep) {
    const engine = new StageEngine();
    return { engine, release: () => engine.close() };
  }
  let entry = kept.get(keep);
  if (!entry) {
    entry = { engine: new StageEngine(), holders: 0 };
    kept.set(keep, entry);
  }
  const own = entry;
  clearTimeout(own.timer);
  own.holders++;
  let released = false;
  return {
    engine: own.engine,
    release() {
      if (released) return;
      released = true;
      if (--own.holders > 0) return;
      own.timer = setTimeout(() => {
        if (kept.get(keep) === own) kept.delete(keep);
        own.engine.close();
      }, KEEP_MS);
    },
  };
}
