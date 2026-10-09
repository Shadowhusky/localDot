import { useEffect, useRef } from "react";
import type { ApiClient } from "../lib/api.ts";
import type { ReplayState } from "../replay/useReplay.ts";
import { exportContext } from "./export-context.ts";
import type { ExportProbe } from "./export-probe.ts";
import type { ExportSourceSample } from "./export-protocol.ts";
import { type ExportHandle, startExport } from "./exporter.ts";
import { opfsSink } from "./sink.ts";

export function useExportProbe(api: ApiClient, sessionId: string, replay: ReplayState): void {
  const current = useRef(replay);
  current.current = replay;
  useEffect(() => {
    if (new URLSearchParams(location.search).get("exportProbe") !== "1") return;
    let disposed = false;
    let running = false;
    let handle: ExportHandle | null = null;
    let sources: ExportSourceSample[] = [];
    const probe: ExportProbe = {
      async run(options) {
        if (disposed || running)
          throw new Error("An export is already running or Replay was closed.");
        running = true;
        try {
          const context = exportContext(api, sessionId, current.current);
          const sink = await opfsSink("localdot-export-probe.mp4");
          if (disposed) {
            await sink.abort();
            throw new Error("Replay was closed.");
          }
          sources = [];
          const startedAt = performance.now();
          let peakOpenFrames = 0;
          let peakEncodeQueue = 0;
          handle = startExport({
            ...context,
            request: {
              sessionId,
              ...context.whole,
              speed: 1,
              skipIdle: true,
              captions: true,
              overlays: true,
              size: { w: 1280, h: 800 },
              fps: 30,
              quality: "high",
              format: "mp4",
              ...options,
            },
            sink,
            hashes: options.hashes,
            onSources(entries) {
              sources.push(...entries);
            },
          });
          handle.onProgress((progress) => {
            peakOpenFrames = Math.max(peakOpenFrames, progress.openFrames);
            peakEncodeQueue = Math.max(peakEncodeQueue, progress.encodeQueue);
          });
          const result = await handle.done;
          if (result.type !== "done")
            throw new Error(result.type === "error" ? result.message : "Export cancelled.");
          return {
            frames: result.frames,
            bytes: result.bytes,
            hashes: result.hashes,
            peakOpenFrames,
            peakEncodeQueue,
            ms: performance.now() - startedAt,
          };
        } finally {
          handle = null;
          running = false;
        }
      },
      cancel() {
        handle?.cancel();
      },
      sourcesBetween(fromMs, toMs) {
        return sources
          .filter((sample) => sample.tMs >= fromMs && sample.tMs < toMs)
          .map((sample) => sample.source);
      },
    };
    window.__localdot ??= {};
    window.__localdot.exportProbe = probe;
    return () => {
      disposed = true;
      handle?.cancel();
      if (window.__localdot?.exportProbe === probe) delete window.__localdot.exportProbe;
    };
  }, [api, sessionId]);
}
