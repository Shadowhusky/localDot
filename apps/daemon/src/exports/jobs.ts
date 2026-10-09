import { type FileHandle, open, rename, rm } from "node:fs/promises";
import {
  type ExportHost,
  type ExportHostCheck,
  type ExportStart,
  type ExportsState,
  type HostExport,
  ulid,
} from "@localdot/protocol";
import { type ExportStore, INTERRUPTED } from "./store.ts";

export interface RenderIo {
  progress(done: number, total: number): void;
  // Resolves once the bytes are on disk; the renderer waits before it sends more.
  write(position: number, data: Uint8Array): Promise<void>;
}

export interface RenderResult {
  frames: number;
}

// What makes the videos: it says once whether it can, then makes one at a time.
export interface ExportRenderer {
  check(): Promise<ExportHostCheck | null>;
  render(job: HostExport, io: RenderIo, signal: AbortSignal): Promise<RenderResult>;
}

// A reason in plain words, shown to the person as it is.
export class ExportFailure extends Error {}

export class ExportRefused extends Error {
  constructor(
    readonly status: 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

export const NO_RENDERER = "This computer can't make videos in the background.";
const FAILED = "The video couldn't be made. Try again.";
const TOO_BIG = "The video grew past the space kept for exports.";
const MAX_WAITING = 4;
// A host that couldn't make videos is asked again after this long, in case a browser was installed.
const RECHECK_MS = 10 * 60 * 1000;
// Progress reaches viewers at most this often; changes of phase go at once.
const PROGRESS_MS = 250;
// Time left is guessed once this many frames and this much time have gone by.
const ESTIMATE_AFTER = { frames: 15, ms: 1000 };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function exportName(at: Date, screen: string, format: string, taken: Set<string>): string {
  const base = `localdot-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${screen === "browser" ? "-browser" : ""}`;
  for (let n = 1; ; n++) {
    const name = `${base}${n > 1 ? `-${n}` : ""}.${format}`;
    if (!taken.has(name)) return name;
  }
}

interface Running {
  id: string;
  abort: AbortController;
  startedAt: number;
  cancelled: boolean;
}

export class ExportJobs {
  readonly #store: ExportStore;
  readonly #renderer: ExportRenderer;
  readonly #now: () => number;
  readonly #clock: () => number;
  #host: ExportHost = { state: "checking", maxPixels: { mp4: 0, webm: 0 } };
  #checked = Number.NEGATIVE_INFINITY;
  #checking: Promise<void> | null = null;
  #running: Running | null = null;
  #closed = false;
  #listeners = new Set<(state: ExportsState) => void>();
  #progressTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    store: ExportStore;
    renderer: ExportRenderer;
    now?: () => number;
    clock?: () => number;
  }) {
    this.#store = options.store;
    this.#renderer = options.renderer;
    this.#now = options.now ?? Date.now;
    this.#clock = options.clock ?? (() => performance.now());
    this.#sweep();
  }

  state(): ExportsState {
    const running = this.#running;
    return {
      host: this.#host,
      exports: this.#store
        .list()
        .map((record) => (running?.id === record.id ? this.#timed(record, running) : record)),
    };
  }

  subscribe(listener: (state: ExportsState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // Asks the renderer whether it can make videos, once, and again later if it couldn't.
  check(): Promise<void> {
    if (this.#checking) return this.#checking;
    if (this.#host.state === "ready") return Promise.resolve();
    if (this.#host.state === "unavailable" && this.#clock() - this.#checked < RECHECK_MS)
      return Promise.resolve();
    this.#checking = (async () => {
      let found: ExportHostCheck | null = null;
      try {
        found = await this.#renderer.check();
      } catch {
        found = null;
      }
      this.#checked = this.#clock();
      this.#host = found
        ? { state: "ready", maxPixels: found.maxPixels }
        : { state: "unavailable", maxPixels: { mp4: 0, webm: 0 } };
      this.#checking = null;
      this.#emit();
      this.#pump();
    })();
    this.#emit();
    return this.#checking;
  }

  start({ request, screen }: ExportStart): HostExport {
    if (this.#closed || this.#host.state !== "ready") throw new ExportRefused(503, NO_RENDERER);
    if (this.#store.list().filter((record) => record.phase === "queued").length >= MAX_WAITING)
      throw new ExportRefused(
        409,
        "Several videos are waiting already. Try again when one is done.",
      );
    const pixels = request.size.w * request.size.h;
    if (pixels > this.#host.maxPixels[request.format])
      throw new ExportRefused(409, "This computer can't make video that large in this format.");
    const now = this.#now();
    const record: HostExport = {
      id: ulid(now),
      sessionId: request.sessionId,
      screen,
      name: exportName(
        new Date(now),
        screen,
        request.format,
        new Set(this.#store.list().map((entry) => entry.name)),
      ),
      phase: "queued",
      createdAt: now,
      done: 0,
      total: 0,
      elapsedMs: 0,
      leftMs: null,
      bytes: 0,
      durationS: null,
      error: null,
      request,
    };
    this.#store.set(record);
    this.#store.save();
    this.#emit();
    this.#pump();
    return this.#store.get(record.id) ?? record;
  }

  // A video waiting or being made stops and leaves nothing behind.
  cancel(id: string): void {
    const record = this.#store.get(id);
    if (!record) throw new ExportRefused(404, "That video is gone.");
    if (record.phase === "done" || record.phase === "failed")
      throw new ExportRefused(409, "That video isn't being made.");
    if (this.#running?.id === id) {
      this.#running.cancelled = true;
      this.#running.abort.abort();
      return;
    }
    this.#store.remove(id);
    this.#emit();
  }

  retry(id: string): HostExport {
    const record = this.#store.get(id);
    if (!record) throw new ExportRefused(404, "That video is gone.");
    if (record.phase !== "failed")
      throw new ExportRefused(409, "Only a video that failed can be tried again.");
    if (this.#closed || this.#host.state !== "ready") throw new ExportRefused(503, NO_RENDERER);
    const again: HostExport = {
      ...record,
      phase: "queued",
      done: 0,
      total: 0,
      elapsedMs: 0,
      leftMs: null,
      bytes: 0,
      durationS: null,
      error: null,
    };
    this.#store.set(again);
    this.#store.save();
    this.#emit();
    this.#pump();
    return this.#store.get(id) ?? again;
  }

  remove(id: string): void {
    const record = this.#store.get(id);
    if (!record) throw new ExportRefused(404, "That video is gone.");
    if (this.#running?.id === id) {
      this.#running.cancelled = true;
      this.#running.abort.abort();
      return;
    }
    this.#store.remove(id);
    this.#emit();
  }

  // The finished file, for a download.
  file(id: string): { record: HostExport; path: string } | undefined {
    const record = this.#store.get(id);
    return record?.phase === "done" ? { record, path: this.#store.file(record) } : undefined;
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#progressTimer);
    this.#running?.abort.abort();
  }

  #timed(record: HostExport, running: Running): HostExport {
    const elapsedMs = Math.max(0, Math.round(this.#clock() - running.startedAt));
    const known =
      record.total > 0 && record.done >= ESTIMATE_AFTER.frames && elapsedMs >= ESTIMATE_AFTER.ms;
    return {
      ...record,
      elapsedMs,
      leftMs: known ? Math.max(0, Math.round(elapsedMs * (record.total / record.done - 1))) : null,
    };
  }

  #sweep(): void {
    try {
      this.#store.sweep(this.#now());
    } catch {
      console.error("exports: old videos could not be cleared");
    }
  }

  #emit(): void {
    clearTimeout(this.#progressTimer);
    this.#progressTimer = undefined;
    const state = this.state();
    for (const listener of this.#listeners) listener(state);
  }

  #emitProgress(): void {
    this.#progressTimer ??= setTimeout(() => this.#emit(), PROGRESS_MS);
  }

  #pump(): void {
    if (this.#running || this.#closed || this.#host.state !== "ready") return;
    const next = this.#store
      .list()
      .filter((record) => record.phase === "queued")
      .at(-1);
    if (!next) return;
    const running: Running = {
      id: next.id,
      abort: new AbortController(),
      startedAt: this.#clock(),
      cancelled: false,
    };
    this.#running = running;
    this.#store.set({ ...next, phase: "making" });
    this.#store.save();
    this.#emit();
    void this.#make(next, running)
      .catch(() => console.error("exports: a video could not be put away"))
      .finally(() => {
        this.#running = null;
        this.#sweep();
        this.#emit();
        this.#pump();
      });
  }

  async #make(job: HostExport, running: Running): Promise<void> {
    const part = this.#store.partFile(job);
    let handle: FileHandle | undefined;
    let size = 0;
    let failure: string | null = null;
    let frames = 0;
    try {
      handle = await open(part, "w", 0o600);
      const file = handle;
      const io: RenderIo = {
        progress: (done, total) => {
          const record = this.#store.get(job.id);
          if (!record || running.abort.signal.aborted) return;
          this.#store.set({ ...record, done: Math.min(done, total), total, bytes: size });
          this.#emitProgress();
        },
        write: async (position, data) => {
          running.abort.signal.throwIfAborted();
          const end = position + data.byteLength;
          if (!Number.isSafeInteger(end) || end > this.#store.limits.maxBytes) {
            failure = TOO_BIG;
            running.abort.abort();
            throw new ExportFailure(TOO_BIG);
          }
          await file.write(data, 0, data.byteLength, position);
          size = Math.max(size, end);
        },
      };
      ({ frames } = await this.#renderer.render(job, io, running.abort.signal));
      running.abort.signal.throwIfAborted();
      await file.sync();
      await file.close();
      handle = undefined;
      await rename(part, this.#store.file(job));
    } catch (error) {
      if (!running.cancelled)
        failure ??= this.#closed
          ? INTERRUPTED
          : error instanceof ExportFailure
            ? error.message
            : FAILED;
    } finally {
      await handle?.close().catch(() => {});
    }
    const record = this.#store.get(job.id);
    if (!record) return;
    if (running.cancelled) {
      this.#store.remove(job.id);
      return;
    }
    const timed = this.#timed(record, running);
    if (failure !== null) {
      await rm(part, { force: true });
      this.#store.set({ ...timed, phase: "failed", leftMs: null, error: failure });
    } else {
      this.#store.set({
        ...timed,
        phase: "done",
        done: frames,
        total: frames,
        leftMs: null,
        bytes: size,
        durationS: frames / job.request.fps,
      });
    }
    this.#store.save();
  }
}
