import type { HostExport } from "@localdot/protocol";
import { useSyncExternalStore } from "react";
import { ApiError } from "../lib/api.ts";
import { suggestedExportName } from "../replay/replay-view.ts";
import type { ExportContext } from "./export-context.ts";
import {
  calibrationFrom,
  type ExportEstimate,
  keepCalibration,
  storedCalibration,
} from "./export-estimate.ts";
import type { ExportRequest } from "./export-plan.ts";
import { type ExportHandle, startExport } from "./exporter.ts";
import { type HostExports, hostCanMake } from "./host-exports.ts";
import {
  downloadFile,
  type ExportSink,
  exportFileName,
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
  // How long it took to make.
  ms: number;
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
  // Made by the host, which goes on when this page closes, or by this page, which has to stay open.
  where: "host" | "page" | null;
  // The host makes another video first.
  waiting: boolean;
}

// An export outlives the popover that started it, and Replay itself, so it lives here and the
// popover and the Export button read it.
export interface ExportJob {
  snapshot(): ExportJobState;
  subscribe(listener: () => void): () => void;
  start(context: ExportContext, request: ExportRequest, expected: ExpectedExport): Promise<void>;
  cancel(): void;
  save(): void;
  // The popover was put away: a saved or downloaded file or a note has been seen and goes, and so
  // does a host's finished video, which stays in the host's exports; a running export or a video
  // only this page holds stays.
  dismiss(): void;
  reset(): void;
  dispose(): void;
}

export interface ExpectedExport {
  durationS: number;
  // The fitted estimate, before this browser's own calibration.
  fitted: ExportEstimate;
}

export const CANCELLED_NOTE = "Cancelled. Nothing was saved.";
const NOT_STARTED = "The video couldn't be started. Try again.";
// The host's video this tab shows, kept across a reload (a phone may reload a page it put away).
const FOLLOWING_KEY = "localdot.export.following";

function remembered(): string | null {
  try {
    return sessionStorage.getItem(FOLLOWING_KEY);
  } catch {
    return null;
  }
}

function remember(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(FOLLOWING_KEY, id);
    else sessionStorage.removeItem(FOLLOWING_KEY);
  } catch {
    // The video is still followed while this page stays open.
  }
}
const OPEN_FAILED = "The file could not be opened for saving. Choose another place and try again.";
const IDLE: ExportJobState = {
  phase: "options",
  done: 0,
  total: 0,
  startedAt: null,
  file: null,
  note: null,
  context: null,
  where: null,
  waiting: false,
};

export function busy(phase: ExportPhase): boolean {
  return phase === "picking" || phase === "exporting";
}

// With the host's exports at hand, a video is made there and this page only shows its progress
// and saves the file, also after a reload. Without them, this page makes it, as before.
export function createExportJob(host?: HostExports): ExportJob {
  let state = IDLE;
  let handle: ExportHandle | null = null;
  // The host's video this job shows, and the estimate it was started with, if this page started it.
  let following: { id: string; expected?: ExpectedExport } | null = null;
  let cancelling = false;
  // Cancel was pressed before the host said which video it is.
  let cancelSoon = false;
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
  const unfollow = () => {
    following = null;
    remember(null);
  };
  const reset = () => {
    if (busy(state.phase)) return;
    release();
    unfollow();
    set(IDLE);
  };
  const follow = (record: HostExport) => {
    if (record.phase === "queued" || record.phase === "making") {
      set({
        phase: "exporting",
        done: record.done,
        total: record.total,
        startedAt: performance.now() - record.elapsedMs,
        where: "host",
        waiting: record.phase === "queued",
      });
      return;
    }
    if (record.phase === "failed") {
      unfollow();
      set({ ...IDLE, note: record.error ?? NOT_STARTED });
      return;
    }
    if (state.phase === "ready" || state.phase === "downloaded") return;
    const expected = following?.expected;
    if (expected)
      keepCalibration(
        calibrationFrom(
          expected.fitted,
          { bytes: record.bytes, ms: record.elapsedMs },
          storedCalibration(),
        ),
      );
    set({
      phase: "ready",
      done: record.done,
      total: record.total,
      where: "host",
      waiting: false,
      file: {
        name: record.name,
        bytes: record.bytes,
        durationS: record.durationS ?? expected?.durationS ?? 0,
        ms: record.elapsedMs,
      },
    });
  };
  // Each change the host reports: the followed video moves on, or this tab's video is taken up
  // again after a reload. Videos other pages started are only listed with the host's exports.
  const fromHost = () => {
    if (!host) return;
    const { exports } = host.view();
    if (!following) {
      if (state.phase !== "options" || state.note) return;
      const kept = remembered();
      const taken = exports.find((entry) => entry.id === kept && entry.phase !== "failed");
      if (!taken) return;
      following = { id: taken.id };
      remember(taken.id);
    }
    const record = exports.find((entry) => entry.id === following?.id);
    if (record) {
      follow(record);
      return;
    }
    if (state.phase === "options" && !state.note) return;
    unfollow();
    set({ ...IDLE, note: cancelling || busy(state.phase) ? CANCELLED_NOTE : null });
    cancelling = false;
  };
  const unsubscribe = host?.subscribe(fromHost);
  fromHost();
  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(context, request, { durationS, fitted }) {
      if (busy(state.phase)) return;
      if (host && hostCanMake(host.view())) {
        const mine = ++run;
        release();
        unfollow();
        cancelSoon = false;
        set({ ...IDLE, phase: "exporting", startedAt: performance.now(), context, where: "host" });
        try {
          const made = await host.start({
            request,
            screen: context.source.screen ?? "desktop",
          });
          if (mine !== run) {
            if (cancelSoon) void host.cancel(made.id).catch(() => {});
            return;
          }
          following = { id: made.id, expected: { durationS, fitted } };
          remember(made.id);
          if (cancelSoon) {
            cancelSoon = false;
            cancelling = true;
            void host.cancel(made.id).catch(() => {
              cancelling = false;
            });
          }
          fromHost();
        } catch (error) {
          if (mine !== run) return;
          set({
            ...IDLE,
            note: cancelSoon
              ? CANCELLED_NOTE
              : error instanceof ApiError && error.status !== 500
                ? error.message
                : NOT_STARTED,
          });
          cancelSoon = false;
        }
        return;
      }
      const support = exportSupport();
      if (!support.ok) {
        set({ note: support.reason });
        return;
      }
      const mine = ++run;
      release();
      const suggested = suggestedExportName(new Date());
      let name = exportFileName(
        context.source.screen === "browser"
          ? suggested.replace(/\.mp4$/, "-browser.mp4")
          : suggested,
        request.format,
      );
      set({
        ...IDLE,
        phase: support.save === "picker" ? "picking" : "exporting",
        context,
        where: "page",
      });
      let sink: ExportSink | MemorySink | null;
      try {
        if (support.save === "picker") {
          const picked = await pickFileSink(name, request.format);
          sink = picked;
          if (picked) name = picked.name;
        } else sink = memorySink(undefined, request.format);
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
      const startedAt = performance.now();
      set({ phase: "exporting", startedAt });
      const exporting = startExport({ request, ...context, sink });
      handle = exporting;
      exporting.onProgress((progress) => {
        if (mine === run) set({ done: progress.done, total: progress.total });
      });
      const result = await exporting.done;
      if (mine !== run) return;
      handle = null;
      const ms = performance.now() - startedAt;
      if (result.type === "done" && "blob" in sink) {
        held = sink.blob();
        keepCalibration(calibrationFrom(fitted, { bytes: held.size, ms }, storedCalibration()));
        set({ phase: "ready", file: { name, bytes: held.size, durationS, ms } });
      } else if (result.type === "done") {
        keepCalibration(calibrationFrom(fitted, { bytes: result.bytes, ms }, storedCalibration()));
        set({ phase: "saved", file: { name, bytes: result.bytes, durationS, ms } });
      } else {
        set({
          phase: "options",
          note: result.type === "cancelled" ? CANCELLED_NOTE : result.message,
          context: null,
        });
      }
    },
    cancel() {
      if (host && following) {
        cancelling = true;
        void host.cancel(following.id).catch(() => {
          cancelling = false;
        });
        return;
      }
      if (state.where === "host" && state.phase === "exporting") {
        cancelSoon = true;
        return;
      }
      handle?.cancel();
    },
    save() {
      const file = state.file;
      if ((state.phase !== "ready" && state.phase !== "downloaded") || !file) return;
      if (state.where === "host" && host && following) {
        const mine = run;
        void host
          .link(following.id)
          .then((href) => {
            if (mine !== run) return;
            downloadFile(href, file.name);
            set({ phase: "downloaded" });
          })
          .catch(() => {
            if (mine === run) set({ note: "The video couldn't be saved. Try again." });
          });
        return;
      }
      if (!held) return;
      heldUrl ??= URL.createObjectURL(held);
      downloadFile(heldUrl, file.name);
      set({ phase: "downloaded" });
    },
    dismiss() {
      if (
        state.phase === "saved" ||
        state.phase === "downloaded" ||
        state.note ||
        (state.phase === "ready" && state.where === "host")
      )
        reset();
    },
    reset,
    // A video the host makes goes on without this page.
    dispose() {
      run++;
      unsubscribe?.();
      handle?.cancel();
      handle = null;
      following = null;
      release();
      state = IDLE;
    },
  };
}

export function useExportJob(job: ExportJob): ExportJobState {
  return useSyncExternalStore(job.subscribe, job.snapshot);
}
