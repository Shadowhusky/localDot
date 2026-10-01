import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FrameSource } from "./frame-source.ts";
import type { PumpStats } from "./pump.ts";
import type { WorkerIn, WorkerOut } from "./render-worker.ts";

export interface StageCanvasHandle {
  attach(source: FrameSource): void;
  detach(): void;
}

export const StageCanvas = forwardRef<StageCanvasHandle>(function StageCanvas(_props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const sourceRef = useRef<FrameSource | null>(null);
  const [stats, setStats] = useState<PumpStats | null>(null);

  // The worker owns the canvas for the component's lifetime.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const worker = new Worker(new URL("./render-worker.ts", import.meta.url), { type: "module" });
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: "init", canvas: offscreen } satisfies WorkerIn, [offscreen]);
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      if (e.data.type === "stats") setStats(e.data.stats);
      else console.error(`stage worker: ${e.data.message}`);
    };
    workerRef.current = worker;
    return () => {
      sourceRef.current?.stop();
      sourceRef.current = null;
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    attach(source) {
      sourceRef.current?.stop();
      sourceRef.current = null;
      const worker = workerRef.current;
      if (!worker) {
        source.stop();
        return;
      }
      // The readable and the seed frame move to the worker; the source keeps its track to stop.
      const { readable, first } = source;
      try {
        worker.postMessage(
          { type: "frames", readable, first } satisfies WorkerIn,
          first ? [readable, first] : [readable],
        );
        sourceRef.current = source;
      } catch (err) {
        source.stop();
        console.error(`stage worker: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    detach() {
      sourceRef.current?.stop();
      sourceRef.current = null;
      workerRef.current?.postMessage({ type: "stop" } satisfies WorkerIn);
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
