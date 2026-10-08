import type { ActivitySpan, RecordingGap } from "@localdot/protocol";
import type { SessionModel } from "@localdot/stage";
import { readTheme } from "../stage/theme.ts";
import type { ReplaySource } from "../stage/worker-protocol.ts";
import type { ExportRequest } from "./export-plan.ts";
import {
  EXPORT_MAX_INFLIGHT_CHUNKS,
  type ExportIn,
  type ExportOut,
  type ExportSourceSample,
} from "./export-protocol.ts";
import { type ExportSink, ExportTooLongError, LONG_EXPORT } from "./sink.ts";

type ExportResult = Extract<ExportOut, { type: "done" | "cancelled" | "error" }>;
type ExportProgress = Extract<ExportOut, { type: "progress" }>;

export interface ExportHandle {
  done: Promise<ExportResult>;
  cancel(): void;
  onProgress(callback: (progress: ExportProgress) => void): void;
}

export function startExport(options: {
  request: ExportRequest;
  source: ReplaySource;
  model: SessionModel;
  activity: ActivitySpan[];
  gaps: RecordingGap[];
  sink: ExportSink;
  hashes?: boolean;
  onSources?(entries: ExportSourceSample[]): void;
}): ExportHandle {
  let worker: Worker | undefined;
  let resolveDone: (result: ExportResult) => void;
  const done = new Promise<ExportResult>((resolve) => {
    resolveDone = resolve;
  });
  let state: "running" | "cancelling" | "closing" | "finished" = "running";
  let cancelTimeout: ReturnType<typeof setTimeout> | undefined;
  let progressCallback: ((progress: ExportProgress) => void) | undefined;
  let progress: ExportProgress | undefined;
  let pendingWrites = Promise.resolve();
  const pendingChunks = new Set<number>();
  let nextChunk = 0;
  const finish = async (result: ExportResult) => {
    if (state !== "running" && !(state === "cancelling" && result.type === "cancelled")) return;
    state = "closing";
    clearTimeout(cancelTimeout);
    worker?.terminate();
    worker = undefined;
    try {
      if (result.type === "done") {
        await pendingWrites;
        await options.sink.close();
      } else {
        await options.sink.abort();
      }
    } catch {
      await options.sink.abort().catch(() => {});
      result = { type: "error", message: "The export file could not be saved. Please try again." };
    }
    state = "finished";
    resolveDone(result);
  };
  const fail = (error?: unknown) =>
    finish({
      type: "error",
      message:
        error instanceof ExportTooLongError
          ? LONG_EXPORT
          : "The export could not finish. Please try again.",
    });
  const post = (message: ExportIn) => worker?.postMessage(message);
  const writeChunk = (message: Extract<ExportOut, { type: "chunk" }>) => {
    if (
      message.chunk !== nextChunk ||
      pendingChunks.size >= EXPORT_MAX_INFLIGHT_CHUNKS ||
      !Number.isSafeInteger(message.position) ||
      message.position < 0 ||
      !(message.data instanceof ArrayBuffer) ||
      message.data.byteLength > 4 * 1024 * 1024 ||
      !Number.isSafeInteger(message.position + message.data.byteLength)
    ) {
      void fail();
      return;
    }
    nextChunk++;
    pendingChunks.add(message.chunk);
    pendingWrites = pendingWrites.then(async () => {
      if (state !== "running") return;
      await options.sink.write(message.position, new Uint8Array(message.data));
      pendingChunks.delete(message.chunk);
      if (state === "running") post({ type: "ack", chunk: message.chunk });
    });
    void pendingWrites.catch((error: unknown) => fail(error));
  };
  try {
    const theme = readTheme(getComputedStyle(document.documentElement));
    worker = new Worker(new URL("./mp4-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<ExportOut>) => {
      if (state === "cancelling") {
        if (event.data.type === "cancelled") void finish(event.data);
        return;
      }
      if (state !== "running") return;
      const message = event.data;
      if (message.type === "sources") options.onSources?.(message.entries);
      else if (message.type === "chunk") writeChunk(message);
      else if (message.type === "progress") {
        progress = message;
        progressCallback?.(message);
      } else if (message.type === "done") {
        if (pendingChunks.size) void fail();
        else void finish(message);
      } else if (message.type === "error" || message.type === "cancelled") {
        void finish(message);
      }
    };
    const broken = () => void (state === "cancelling" ? finish({ type: "cancelled" }) : fail());
    worker.onerror = broken;
    worker.onmessageerror = broken;
    post({
      type: "start",
      request: options.request,
      source: options.source,
      model: options.model,
      activity: options.activity,
      gaps: options.gaps,
      theme,
      hashes:
        options.hashes === true && new URLSearchParams(location.search).get("exportProbe") === "1",
      probe: !!options.onSources && new URLSearchParams(location.search).get("exportProbe") === "1",
    });
  } catch {
    void fail();
  }
  return {
    done,
    cancel() {
      if (state !== "running") return;
      state = "cancelling";
      post({ type: "cancel" });
      cancelTimeout = setTimeout(() => void finish({ type: "cancelled" }), 1000);
    },
    onProgress(callback) {
      progressCallback = callback;
      if (progress) callback(progress);
    },
  };
}
