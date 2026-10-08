import type { LocalDotEvent, Point } from "@localdot/protocol";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { APPEARANCE_EVENT } from "../onboarding/appearance.ts";
import type { FrameSource } from "./frame-source.ts";
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
  manualPoint(point: Point, screen: { w: number; h: number }): Point | null;
  oracle(command: OracleRequest): Promise<unknown>;
}

export interface StageCanvasProps {
  onStats?(stats: PumpStats): void;
  onFlip?(flip: Flip): void;
}

export const reducedMotionQuery = () => window.matchMedia("(prefers-reduced-motion: reduce)");

export const StageCanvas = forwardRef<StageCanvasHandle, StageCanvasProps>(function StageCanvas(
  { onStats, onFlip },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const sourceRef = useRef<FrameSource | null>(null);
  const sourceId = useRef(0);
  const viewport = useRef({ w: 1, h: 1 });
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const onFlipRef = useRef(onFlip);
  onFlipRef.current = onFlip;
  const pendingOracle = useRef(
    new Map<
      number,
      { resolve(v: unknown): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }
    >(),
  );
  const oracleSeq = useRef(0);
  const replayListeners = useRef(new Set<(message: ReplayMessage) => void>());
  const pendingReplay = useRef(
    new Map<
      number,
      {
        resolve(value: unknown): void;
        reject(error: unknown): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const replaySeq = useRef(0);
  const [stats, setStats] = useState<PumpStats | null>(null);

  // The worker owns the canvas for the component's lifetime. It starts with the theme's colours,
  // the device pixel ratio and the motion preference, read here: the canvas renders only where
  // frames can be tapped, so jsdom and browsers without WebCodecs never reach them. A change of the
  // motion preference is a message.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const theme = readTheme(getComputedStyle(document.documentElement));
    const motion = reducedMotionQuery();
    const worker = new Worker(new URL("./render-worker.ts", import.meta.url), { type: "module" });
    const offscreen = canvas.transferControlToOffscreen();
    viewport.current = {
      w: Math.max(1, Math.round(rect.width * dpr)),
      h: Math.max(1, Math.round(rect.height * dpr)),
    };
    worker.postMessage(
      {
        type: "init",
        canvas: offscreen,
        width: Math.max(1, Math.round(rect.width * dpr)),
        height: Math.max(1, Math.round(rect.height * dpr)),
        dpr,
        theme,
        reducedMotion: motion.matches,
      } satisfies WorkerIn,
      [offscreen],
    );
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === "stats") {
        if (!sourceRef.current || m.sourceId !== sourceId.current) return;
        setStats(m.stats);
        onStatsRef.current?.(m.stats);
      } else if (m.type === "flip") onFlipRef.current?.(m.flip);
      else if (m.type === "oracle-reply") {
        const pending = pendingOracle.current.get(m.id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(m.reply);
        }
        pendingOracle.current.delete(m.id);
      } else if (m.type === "warn") console.warn(`stage worker: ${m.message}`);
      else if (m.type === "error") console.error(`stage worker: ${m.message}`);
      else if (
        m.type === "replay-time" ||
        m.type === "replay-status" ||
        m.type === "replay-ended"
      ) {
        for (const listener of replayListeners.current) listener(m);
      } else if (m.type === "replay-probe-reply") {
        const pending = pendingReplay.current.get(m.id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(m.reply);
          pendingReplay.current.delete(m.id);
        }
      }
    };
    const onMotion = () =>
      worker.postMessage({
        type: "view",
        view: { reducedMotion: motion.matches },
      } satisfies WorkerIn);
    motion.addEventListener("change", onMotion);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      // Explicit DPR also respects Chromium's emulated HiDPI: its devicePixelContentBoxSize
      // describes native display pixels and can disagree with the page's devicePixelRatio.
      const width = Math.round((entry?.contentRect.width ?? 0) * dpr);
      const height = Math.round((entry?.contentRect.height ?? 0) * dpr);
      if (width > 0 && height > 0) {
        viewport.current = { w: width, h: height };
        worker.postMessage({ type: "resize", width, height } satisfies WorkerIn);
      }
    });
    observer.observe(canvas);
    workerRef.current = worker;
    const onAppearance = () =>
      worker.postMessage({
        type: "theme",
        theme: readTheme(getComputedStyle(document.documentElement)),
      } satisfies WorkerIn);
    window.addEventListener(APPEARANCE_EVENT, onAppearance);
    return () => {
      window.removeEventListener(APPEARANCE_EVENT, onAppearance);
      motion.removeEventListener("change", onMotion);
      observer.disconnect();
      sourceRef.current?.stop();
      sourceRef.current = null;
      for (const pending of pendingOracle.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("stage closed"));
      }
      pendingOracle.current.clear();
      for (const pending of pendingReplay.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("stage closed"));
      }
      pendingReplay.current.clear();
      replayListeners.current.clear();
      worker.postMessage({ type: "replay-close" } satisfies WorkerIn);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    replay: {
      open(source) {
        sourceId.current++;
        sourceRef.current?.stop();
        sourceRef.current = null;
        workerRef.current?.postMessage({ type: "replay-open", source } satisfies WorkerIn);
      },
      transport(transport) {
        workerRef.current?.postMessage({ type: "replay-transport", transport } satisfies WorkerIn);
      },
      seek(tMs, mode) {
        workerRef.current?.postMessage({ type: "replay-seek", tMs, mode } satisfies WorkerIn);
      },
      close() {
        workerRef.current?.postMessage({ type: "replay-close" } satisfies WorkerIn);
      },
      onReplay(listener) {
        replayListeners.current.add(listener);
        return () => {
          replayListeners.current.delete(listener);
        };
      },
      probe(command) {
        if (new URLSearchParams(window.location.search).get("replayProbe") !== "1")
          return Promise.reject(new Error("Replay probe is disabled."));
        const worker = workerRef.current;
        if (!worker) return Promise.reject(new Error("stage not ready"));
        const id = ++replaySeq.current;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingReplay.current.delete(id);
            reject(new Error("Replay probe timed out."));
          }, 10_000);
          pendingReplay.current.set(id, { resolve, reject, timer });
          try {
            worker.postMessage({
              type: "replay-probe",
              command: { ...command, id } as ReplayProbeCommand,
            } satisfies WorkerIn);
          } catch (error) {
            clearTimeout(timer);
            pendingReplay.current.delete(id);
            reject(error);
          }
        });
      },
    },
    attach(source) {
      const id = ++sourceId.current;
      sourceRef.current?.stop();
      sourceRef.current = source;
      const worker = workerRef.current;
      if (!worker) {
        source.stop();
        sourceRef.current = null;
        return;
      }
      // S8's seed frame travels with the readable; both are transferred.
      const transfer: Transferable[] = source.first
        ? [source.readable, source.first]
        : [source.readable];
      try {
        worker.postMessage(
          {
            type: "frames",
            sourceId: id,
            readable: source.readable,
            first: source.first,
          } satisfies WorkerIn,
          transfer,
        );
      } catch (err) {
        source.stop();
        sourceRef.current = null;
        void source.readable.cancel().catch(() => {});
        console.warn("could not attach desktop frames", err);
      }
    },
    detach() {
      sourceId.current += 1;
      sourceRef.current?.stop();
      sourceRef.current = null;
      workerRef.current?.postMessage({ type: "stop" } satisfies WorkerIn);
    },
    probe(rect, threshold = 128) {
      workerRef.current?.postMessage({ type: "probe", rect, threshold } satisfies WorkerIn);
    },
    pushEvents(events) {
      workerRef.current?.postMessage({ type: "events", events } satisfies WorkerIn);
    },
    resetSession() {
      workerRef.current?.postMessage({ type: "session-reset" } satisfies WorkerIn);
    },
    setClock(clock) {
      workerRef.current?.postMessage({ type: "clock", clock } satisfies WorkerIn);
    },
    setView(view) {
      workerRef.current?.postMessage({ type: "view", view } satisfies WorkerIn);
    },
    // A theme pack restyles the stage by sending its parsed tokens (the stage reads theme.css once).
    setTheme(theme) {
      workerRef.current?.postMessage({ type: "theme", theme } satisfies WorkerIn);
    },
    manualPoint(point, screen) {
      const rect = canvasRef.current?.getBoundingClientRect();
      return rect ? manualPoint(rect, screen, point, viewport.current) : null;
    },
    oracle(command) {
      const worker = workerRef.current;
      if (!worker) return Promise.reject(new Error("stage not ready"));
      const id = ++oracleSeq.current;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingOracle.current.delete(id);
          reject(new Error("stage oracle timed out"));
        }, 10_000);
        pendingOracle.current.set(id, { resolve, reject, timer });
        try {
          worker.postMessage({
            type: "oracle",
            command: { ...command, id } as OracleCommand,
          } satisfies WorkerIn);
        } catch (err) {
          clearTimeout(timer);
          pendingOracle.current.delete(id);
          reject(err);
        }
      });
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      className="stage-canvas"
      data-frames={stats?.presented ?? 0}
      data-fps={stats?.fps ?? 0}
      data-size={stats ? `${stats.width}x${stats.height}` : ""}
      aria-label="The virtual computer"
    />
  );
});
