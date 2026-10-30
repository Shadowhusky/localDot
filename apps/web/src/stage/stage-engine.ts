import type { LocalDotEvent, Point } from "@localdot/protocol";
import { APPEARANCE_EVENT } from "../onboarding/appearance.ts";
import { type FrameSource, framePath } from "./frame-source.ts";
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

// The canvas keeps at most this many pixels for each CSS pixel: beyond it a stage-sized picture
// shows little more, and every frame costs the GPU for each pixel.
export const MAX_BACKING_SCALE = 1.5;

// A stage whose box keeps changing, as when a rail slides open beside it, keeps its canvas's size,
// its picture scaled to the box, until the box has been still this long: each new size costs the
// worker a fresh backing store and a full redraw.
export const RESIZE_SETTLE_MS = 100;

// Whether some of the canvas is in the viewport with a size, and the share of the viewport it
// covers.
export interface StageView {
  onScreen: boolean;
  share: number;
}

// The stage's canvas and the worker that owns it. It lives apart from React, so a stage that moves
// to another container or remounts keeps its picture, its overlays and its frame pump.
export class StageEngine implements StageCanvasHandle {
  readonly canvas = document.createElement("canvas");
  readonly replay: ReplayHandle;
  #worker: Worker | null = null;
  #closed = false;
  #anchor: Element | null = null;
  #themeStale = false;
  #source: FrameSource | null = null;
  #sourceId = 0;
  // The source whose frames the worker was last told how to take.
  #fed = 0;
  // Whether the worker reads a track handed to it; null until it says.
  #workerTracks: boolean | null = null;
  #viewport = { w: 1, h: 1 };
  #pendingOracle = new Map<number, Pending>();
  #oracleSeq = 0;
  #pendingReplay = new Map<number, Pending>();
  #replaySeq = 0;
  #replayListeners = new Set<(message: ReplayMessage) => void>();
  #statsListeners = new Set<(stats: PumpStats) => void>();
  #flipListeners = new Set<(flip: Flip) => void>();
  #viewListeners = new Set<(view: StageView) => void>();
  #view: StageView = { onScreen: true, share: 0 };
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

  // Tells `listener` the canvas's view now, then whenever it changes.
  onView(listener: (view: StageView) => void): () => void {
    this.#viewListeners.add(listener);
    listener(this.#view);
    return () => this.#viewListeners.delete(listener);
  }

  #viewed(view: StageView): void {
    if (view.onScreen === this.#view.onScreen && Math.abs(view.share - this.#view.share) < 0.01)
      return;
    this.#view = view;
    for (const listener of this.#viewListeners) listener(view);
  }

  // Shows the canvas just before `anchor`. The first placement starts the worker at the size the
  // canvas has there; the worker owns the canvas from then on.
  place(anchor: Element): void {
    this.#anchor = anchor;
    anchor.before(this.canvas);
    if (!this.#worker && !this.#closed) this.#start();
    else if (this.#themeStale) this.#readTheme();
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
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_BACKING_SCALE);
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
    // The observers' first reports, after the canvas is laid out, say where it is: a stage that is
    // still being placed has no size yet.
    let box = { w: rect.width, h: rect.height };
    let inView = true;
    const view = () =>
      this.#viewed({
        onScreen: inView && box.w > 0 && box.h > 0,
        share: (box.w * box.h) / Math.max(1, window.innerWidth * window.innerHeight),
      });
    // Explicit DPR also respects Chromium's emulated HiDPI: its devicePixelContentBoxSize
    // describes native display pixels and can disagree with the page's devicePixelRatio.
    const resize = () => {
      const w = Math.round(box.w * dpr);
      const h = Math.round(box.h * dpr);
      if (w <= 0 || h <= 0 || (w === this.#viewport.w && h === this.#viewport.h)) return;
      this.#viewport = { w, h };
      this.#post({ type: "resize", width: w, height: h });
    };
    // A still box's first change is taken at once; one that keeps changing waits to settle.
    let settling: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      box = { w: entry?.contentRect.width ?? 0, h: entry?.contentRect.height ?? 0 };
      view();
      if (settling === undefined) resize();
      else clearTimeout(settling);
      settling = setTimeout(() => {
        settling = undefined;
        resize();
      }, RESIZE_SETTLE_MS);
    });
    observer.observe(canvas);
    // Clipped away counts as out of sight: a folded phone screen keeps its size at no height.
    const sight =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            (entries) => {
              const entry = entries.at(-1);
              inView = !!entry?.isIntersecting && entry.intersectionRatio > 0;
              view();
            },
            { threshold: [0, 0.01] },
          )
        : null;
    sight?.observe(canvas);
    window.addEventListener("resize", view);
    // A kept stage that is not on the page reads the appearance when it is placed again.
    const onAppearance = () => {
      if (this.#anchor) this.#readTheme();
      else this.#themeStale = true;
    };
    window.addEventListener(APPEARANCE_EVENT, onAppearance);
    this.#worker = worker;
    this.#teardown = () => {
      window.removeEventListener(APPEARANCE_EVENT, onAppearance);
      window.removeEventListener("resize", view);
      motion.removeEventListener("change", onMotion);
      clearTimeout(settling);
      observer.disconnect();
      sight?.disconnect();
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
      this.#viewListeners.clear();
      worker.postMessage({ type: "replay-close" } satisfies WorkerIn);
      worker.terminate();
      this.#worker = null;
    };
  }

  #receive(m: WorkerOut): void {
    if (m.type === "caps") {
      this.#workerTracks = m.tracks;
      if (this.#source && this.#fed !== this.#sourceId) this.#feed(this.#sourceId, this.#source);
    } else if (m.type === "stats") {
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
    if (!this.#worker) {
      source.stop();
      this.#source = null;
      return;
    }
    // A track waits for the worker to say whether it reads tracks, which it does as it starts.
    if (!source.readable && source.track && this.#workerTracks === null) return;
    this.#feed(id, source);
  }

  #feed(id: number, source: FrameSource): void {
    const worker = this.#worker;
    if (!worker) return;
    this.#fed = id;
    const path = framePath(source, this.#workerTracks);
    if (path) this.canvas.dataset.path = path;
    // S8's seed frame travels with the readable; both are transferred.
    if (path === "stream" && source.readable) {
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
    if (path === "track" && source.track) {
      const track = source.track;
      try {
        worker.postMessage({ type: "frames", sourceId: id, track } satisfies WorkerIn, [track]);
        source.track = undefined;
        return;
      } catch {
        // This browser cannot hand a track over: its frames are copied on the page instead.
        this.#workerTracks = false;
        this.canvas.dataset.path = "presented";
      }
    }
    source.track?.stop();
    source.track = undefined;
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

  #readTheme(): void {
    this.#themeStale = false;
    this.#post({ type: "theme", theme: readTheme(getComputedStyle(document.documentElement)) });
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
