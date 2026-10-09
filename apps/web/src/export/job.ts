import { useSyncExternalStore } from "react";
import { suggestedExportName } from "../replay/replay-view.ts";
import type { ExportContext } from "./export-context.ts";
import type { ExportRequest } from "./export-plan.ts";
import { type ExportHandle, startExport } from "./exporter.ts";
import {
  downloadFile,
  type ExportSink,
  exportSupport,
  type MemorySink,
  memorySink,
  pickFileSink,
} from "./sink.ts";

// options → (picking) → exporting → saved, or → ready → downloaded where the browser has no save
// picker and the finished file waits for the person to save it. A download can be cancelled at the
// browser's prompt, so the file stays to be saved again until the popover is put away.
export type ExportPhase = "options" | "picking" | "exporting" | "ready" | "downloaded" | "saved";

export interface ExportFile {
  name: string;
  bytes: number;
  durationS: number;
}

export interface ExportJobState {
  phase: ExportPhase;
  done: number;
  total: number;
  startedAt: number | null;
  file: ExportFile | null;
  // Why the last attempt saved nothing: it failed or was cancelled.
  note: string | null;
  // What is being exported, from the task it was started in.
  context: ExportContext | null;
}

// An export outlives the popover that started it, and Replay itself, so it lives here and the
// popover and the Export button read it.
export interface ExportJob {
  snapshot(): ExportJobState;
  subscribe(listener: () => void): () => void;
  start(context: ExportContext, request: ExportRequest, durationS: number): Promise<void>;
  cancel(): void;
  save(): void;
  // The popover was put away: a saved or downloaded file or a note has been seen and goes; a running
  // export or a video waiting to be saved stays.
  dismiss(): void;
  reset(): void;
  dispose(): void;
}

export const CANCELLED_NOTE = "Cancelled. Nothing was saved.";
const OPEN_FAILED = "The file could not be opened for saving. Choose another place and try again.";
const IDLE: ExportJobState = {
  phase: "options",
  done: 0,
  total: 0,
  startedAt: null,
  file: null,
  note: null,
  context: null,
};

export function busy(phase: ExportPhase): boolean {
  return phase === "picking" || phase === "exporting";
}

export function createExportJob(): ExportJob {
  let state = IDLE;
  let handle: ExportHandle | null = null;
  let held: Blob | null = null;
  let heldUrl: string | null = null;
  // Each start and each dispose takes a new run; a run that is no longer current goes quiet.
  let run = 0;
  const listeners = new Set<() => void>();
  const set = (next: Partial<ExportJobState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const release = () => {
    if (heldUrl) URL.revokeObjectURL(heldUrl);
    heldUrl = null;
    held = null;
  };
  const reset = () => {
    if (busy(state.phase)) return;
    release();
    set(IDLE);
  };
  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(context, request, durationS) {
      if (busy(state.phase)) return;
      const support = exportSupport();
      if (!support.ok) {
        set({ note: support.reason });
        return;
      }
      const mine = ++run;
      release();
      const suggested = suggestedExportName(new Date());
      let name =
        context.source.screen === "browser"
          ? suggested.replace(/\.mp4$/, "-browser.mp4")
          : suggested;
      set({ ...IDLE, phase: support.save === "picker" ? "picking" : "exporting", context });
      let sink: ExportSink | MemorySink | null;
      try {
        if (support.save === "picker") {
          const picked = await pickFileSink(name);
          sink = picked;
          if (picked) name = picked.name;
        } else sink = memorySink();
      } catch {
        if (mine === run) set({ phase: "options", note: OPEN_FAILED, context: null });
        return;
      }
      if (mine !== run) {
        await sink?.abort();
        return;
      }
      if (!sink) {
        set({ phase: "options", context: null });
        return;
      }
      set({ phase: "exporting", startedAt: performance.now() });
      const exporting = startExport({ request, ...context, sink });
      handle = exporting;
      exporting.onProgress((progress) => {
        if (mine === run) set({ done: progress.done, total: progress.total });
      });
      const result = await exporting.done;
      if (mine !== run) return;
      handle = null;
      if (result.type === "done" && "blob" in sink) {
        held = sink.blob();
        set({ phase: "ready", file: { name, bytes: held.size, durationS } });
      } else if (result.type === "done") {
        set({ phase: "saved", file: { name, bytes: result.bytes, durationS } });
      } else {
        set({
          phase: "options",
          note: result.type === "cancelled" ? CANCELLED_NOTE : result.message,
          context: null,
        });
      }
    },
    cancel() {
      handle?.cancel();
    },
    save() {
      if ((state.phase !== "ready" && state.phase !== "downloaded") || !held || !state.file) return;
      heldUrl ??= URL.createObjectURL(held);
      downloadFile(heldUrl, state.file.name);
      set({ phase: "downloaded" });
    },
    dismiss() {
      if (state.phase === "saved" || state.phase === "downloaded" || state.note) reset();
    },
    reset,
    dispose() {
      run++;
      handle?.cancel();
      handle = null;
      release();
      state = IDLE;
    },
  };
}

export function useExportJob(job: ExportJob): ExportJobState {
  return useSyncExternalStore(job.subscribe, job.snapshot);
}
