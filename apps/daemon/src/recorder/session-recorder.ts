import * as nodeFs from "node:fs";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_JOIN_MICROS,
  emptyManifest,
  FragmentEntry,
  type LocalDotEvent,
  RECORDING_VIDEO,
  type RecordingGap,
  type RecordingGapReason,
  type RecordingManifest,
} from "@localdot/protocol";
import { avcCodecString } from "./annexb.ts";
import type { RecordingUsage } from "./budget.ts";
import { ControlGate } from "./control-gate.ts";
import {
  type FeedFrame,
  type FeedHandlers,
  type FeedState,
  type FrameFeed,
  PIPELINE_RESET,
} from "./feed.ts";
import { ACTIVITY_SOFT_CAP, capActivity, writeManifest } from "./manifest.ts";
import { NOMINAL_FRAME_MICROS, recoverRecording } from "./recover.ts";
import { type RecordingFs, RecordingWriter } from "./writer.ts";

export const KEYFRAME_EVERY_MICROS = 2_000_000;
export const IDLE_FLUSH_MICROS = 500_000;
export const MAX_GOP_MICROS = 10_000_000;
export const KEY_RETRY_MICROS = 500_000;
export const MAX_GAPS = 5_000;
export const MIN_FREE_START_BYTES = 2 * 1024 ** 3;
export const MIN_FREE_RUN_BYTES = 1024 ** 3;
export const SESSION_CAP_BYTES = 8 * 1024 ** 3;
export const MAX_QUEUED_BYTES = 64 * 1024 ** 2;
export const TICK_MS = 100;
export const DISK_CHECK_MICROS = 10_000_000;
export const MANIFEST_WRITE_MICROS = 1_000_000;
export interface FrameGate {
  observe(e: LocalDotEvent): "took" | "returned" | null;
  admit(tMicros: number, key: boolean): boolean;
  readonly gaps: RecordingGap[];
  readonly userHasControl: boolean;
}
export interface SessionRecorderDeps {
  sessionId: string;
  dir: string;
  feed(handlers: FeedHandlers): FrameFeed;
  toSessionT(daemonMicros: number): number;
  freeBytes(dir: string): number;
  fs?: RecordingFs;
  backlog?: readonly LocalDotEvent[];
  subscribe?(listener: (e: LocalDotEvent) => void): () => void;
  gate?: FrameGate;
  queueLimitBytes?: number;
  sizeCapBytes?: number;
  usage?: RecordingUsage;
  activitySoftCap?: number;
}
export class SessionRecorder {
  readonly #deps: SessionRecorderDeps;
  readonly #gate: FrameGate;
  readonly #authority = new ControlGate();
  readonly #seen = new Set<number>();
  readonly #ready: Promise<boolean>;
  #resolveReady!: (ready: boolean) => void;
  #unsub: (() => void) | undefined;
  #feed: FrameFeed | undefined;
  #writer: RecordingWriter | undefined;
  #manifest = emptyManifest("recording");
  #ownGaps: RecordingGap[] = [];
  #openGap: RecordingGap | undefined;
  #entries: readonly FragmentEntry[] = [];
  #tail: Promise<void> = Promise.resolve();
  #stopPromise: Promise<RecordingManifest> | undefined;
  #started = false;
  #running = false;
  #stopping = false;
  #queuedBytes = 0;
  #overflowQueued = false;
  #dropUntilKey = false;
  #resetPending = false;
  #idle = false;
  #lastT: number | null = null;
  #lastKeyT = 0;
  #lastRequest = -Infinity;
  #lastDiskCheck = 0;
  #lastManifestWrite = 0;
  #sizeLimitAt: number | null = null;
  constructor(deps: SessionRecorderDeps) {
    this.#deps = deps;
    this.#gate = deps.gate ?? new ControlGate();
    this.#ready = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
    for (const event of deps.backlog ?? []) this.#observe(event);
    this.#unsub = deps.subscribe?.((event) => this.#observe(event));
    try {
      this.#feed = deps.feed({
        onFrame: (frame) => this.#acceptFrame(frame),
        onState: (state, detail) => this.#acceptState(state, detail),
      });
    } catch (error) {
      this.#unsub?.();
      throw error;
    }
  }
  #observe(event: LocalDotEvent): void {
    if (this.#gate.gaps.length > MAX_GAPS || this.#seen.has(event.seq)) return;
    this.#seen.add(event.seq);
    if (this.#gate.observe(event) === "returned") {
      this.#dropUntilKey = true;
      this.#request(event.t, 0);
    }
    if (this.#gate.gaps.length > MAX_GAPS)
      this.#queue(async () => {
        await this.#end("recorder-error", event.t, "the stream dropped too often");
      });
  }
  get manifest(): RecordingManifest {
    const gaps = [...this.#ownGaps, ...this.#gate.gaps, ...this.#authority.gaps]
      .map((gap) => ({ ...gap }))
      .sort((a, b) => a.from - b.from);
    return {
      ...this.#manifest,
      activity: this.#manifest.activity.map((span) => ({ ...span })),
      gaps,
    };
  }
  get entries(): readonly FragmentEntry[] {
    return this.#writer?.entries ?? this.#entries;
  }
  ready(): Promise<boolean> {
    return this.#ready;
  }
  get active(): boolean {
    return this.#running && !this.#stopping;
  }
  hold(nowDaemonMicros: number): Promise<void> {
    this.#authority.hold(this.#deps.toSessionT(nowDaemonMicros));
    return this.drain();
  }
  release(nowDaemonMicros: number): void {
    const t = this.#deps.toSessionT(nowDaemonMicros);
    if (this.#authority.release(t)) {
      this.#dropUntilKey = true;
      this.#request(t, 0);
    }
  }
  drain(): Promise<void> {
    return this.#tail;
  }
  #queue(task: () => Promise<void>): void {
    this.#tail = this.#tail.then(task).catch(async (error: unknown) => {
      await this.#fail(
        (error as NodeJS.ErrnoException)?.code === "ENOSPC" ? "disk-full" : "recorder-error",
        this.#lastT ?? 0,
      );
    });
  }
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    try {
      mkdirSync(this.#deps.dir, { recursive: true });
      if (this.#stopping || this.#deps.freeBytes(this.#deps.dir) < MIN_FREE_START_BYTES) {
        this.#manifest = emptyManifest("none", "not enough free disk space");
        this.#detach();
        this.#resolveReady(false);
        this.#save();
        return;
      }
      this.#save();
      this.#running = true;
      this.#feed?.start();
    } catch {
      await this.#fail("recorder-error", 0);
    }
  }
  #request(t: number, interval = KEY_RETRY_MICROS): void {
    if (this.#stopping || t - this.#lastRequest < interval) return;
    try {
      this.#feed?.requestKeyframe();
      this.#lastRequest = t;
    } catch {
      /* recording errors stay outside the session */
    }
  }
  #gap(reason: RecordingGapReason, from: number): void {
    if (!this.#openGap) {
      this.#openGap = { from, to: null, reason };
      this.#ownGaps.push(this.#openGap);
    }
    this.#dropUntilKey = true;
  }
  #acceptState(state: FeedState, detail?: string): void {
    if (!this.#running || this.#stopping) return;
    this.#queue(async () => {
      if (!this.#running) return;
      if (state === "lost") this.#gap("stream-lost", this.#lastT ?? 0);
      else if (state === "live") {
        if (detail === PIPELINE_RESET) {
          this.#dropUntilKey = true;
          this.#resetPending = true;
        }
        if (this.#dropUntilKey) this.#request(this.#lastT ?? 0, 0);
      }
    });
  }
  #acceptFrame(frame: FeedFrame): void {
    if (!this.#running || this.#stopping) return;
    const t = this.#deps.toSessionT(frame.arrivalMicros);
    if (this.#queuedBytes + frame.data.length > (this.#deps.queueLimitBytes ?? MAX_QUEUED_BYTES)) {
      if (!this.#overflowQueued) {
        this.#overflowQueued = true;
        this.#queue(async () => {
          this.#overflowQueued = false;
          if (this.#running) {
            this.#gap("recorder-error", t);
            this.#request(t, 0);
          }
        });
      }
      return;
    }
    const owned = { ...frame, data: new Uint8Array(frame.data) };
    this.#queuedBytes += owned.data.length;
    this.#queue(async () => {
      try {
        await this.#frame(owned, t);
      } finally {
        this.#queuedBytes -= owned.data.length;
      }
    });
  }
  async #frame(frame: FeedFrame, t: number): Promise<void> {
    if (!this.#running) return;
    if (this.#deps.usage?.exhausted()) {
      await this.#end("size-cap", t);
      return;
    }
    // Control changes are observed synchronously; evaluate each queued frame's own time before any disk write.
    if (!this.#gate.admit(t, frame.key) || !this.#authority.admit(t, frame.key)) return;
    if (this.manifest.gaps.length > MAX_GAPS) {
      await this.#end("recorder-error", t, "the stream dropped too often");
      return;
    }
    if (this.#dropUntilKey) {
      if (!frame.key) {
        if (this.#resetPending) this.#gap("stream-lost", t);
        this.#request(t);
        return;
      }
      this.#dropUntilKey = false;
      this.#resetPending = false;
      if (this.#openGap) {
        this.#openGap.to = Math.max(this.#openGap.from, t);
        this.#openGap = undefined;
      }
    }
    if (!this.#writer) {
      if (!frame.key) {
        this.#request(t);
        return;
      }
      const codec = avcCodecString(frame.data);
      if (!codec) throw new Error("missing recording codec");
      this.#manifest = {
        ...this.#manifest,
        codec,
        width: frame.width,
        height: frame.height,
        firstMicros: t,
      };
      this.#save();
      this.#writer = new RecordingWriter({
        dir: this.#deps.dir,
        codec,
        width: frame.width,
        height: frame.height,
        ...(this.#deps.fs ? { fs: this.#deps.fs } : {}),
        onCommit: (entry) => {
          const sharedLimit = this.#deps.usage?.commit(entry.endOffset) ?? false;
          if (sharedLimit || entry.endOffset >= (this.#deps.sizeCapBytes ?? SESSION_CAP_BYTES))
            this.#sizeLimitAt = entry.endMicros;
        },
      });
      await this.#writer.start();
    } else if (
      frame.key &&
      (avcCodecString(frame.data) !== this.#manifest.codec ||
        frame.width !== this.#manifest.width ||
        frame.height !== this.#manifest.height)
    ) {
      await this.#end("recorder-error", t, "the stream changed format");
      return;
    }
    if (!frame.key && t - this.#lastKeyT > MAX_GOP_MICROS) {
      this.#gap("recorder-error", t);
      this.#request(t);
      return;
    }
    await this.#writer.push({ tMicros: t, key: frame.key, data: frame.data });
    this.#lastT = t;
    this.#manifest.lastMicros = this.#writer.lastMicros;
    this.#resolveReady(true);
    if (frame.key) this.#lastKeyT = t;
    if (this.#idle && frame.key) await this.#writer.flushIdle(t + NOMINAL_FRAME_MICROS);
    else {
      if (!frame.key) this.#idle = false;
      this.#activity(t);
      if (KEYFRAME_EVERY_MICROS > 0 && t - this.#lastKeyT >= KEYFRAME_EVERY_MICROS)
        this.#request(t, KEYFRAME_EVERY_MICROS / 2);
    }
    this.#counts();
    if (this.#sizeLimitAt !== null) await this.#end("size-cap", this.#sizeLimitAt);
  }
  #activity(t: number): void {
    const spans = this.#manifest.activity;
    const last = spans.at(-1);
    if (last && t - last.to <= ACTIVITY_JOIN_MICROS) last.to = Math.max(last.to, t);
    else spans.push({ from: t, to: t });
    if (spans.length > (this.#deps.activitySoftCap ?? ACTIVITY_SOFT_CAP))
      this.#manifest.activity = capActivity(spans, this.#deps.activitySoftCap ?? ACTIVITY_SOFT_CAP);
  }
  #counts(): void {
    this.#manifest.fragments = this.entries.length;
    this.#manifest.bytes = this.#writer?.committedBytes ?? this.#manifest.bytes;
  }
  #save(): void {
    writeManifest(this.#deps.dir, this.manifest);
  }
  #detach(): void {
    try {
      this.#feed?.stop();
    } catch {
      /* sanitized */
    }
    try {
      this.#unsub?.();
    } catch {
      /* sanitized */
    }
    this.#unsub = undefined;
  }
  tick(nowDaemonMicros: number): Promise<void> {
    const now = this.#deps.toSessionT(nowDaemonMicros);
    this.#queue(async () => {
      if (!this.#running) return;
      if (this.#deps.usage?.exhausted()) {
        await this.#end("size-cap", now);
        return;
      }
      if (this.manifest.gaps.length > MAX_GAPS) {
        await this.#end("recorder-error", now, "the stream dropped too often");
        return;
      }
      // A request can be throttled or lost. The privacy gates must keep dropping deltas,
      // so retry independently of frame admission, including when the screen is idle.
      if (this.#dropUntilKey && !this.#gate.userHasControl && !this.#authority.userHasControl)
        this.#request(now);
      if (
        this.#writer &&
        this.#lastT !== null &&
        !this.#idle &&
        now - this.#lastT >= IDLE_FLUSH_MICROS
      ) {
        this.#idle = true;
        await this.#writer.flushIdle(now);
        this.#request(now, 0);
        this.#counts();
      }
      if (now - this.#lastDiskCheck >= DISK_CHECK_MICROS || this.#lastDiskCheck === 0) {
        this.#lastDiskCheck = now;
        if (this.#deps.freeBytes(this.#deps.dir) < MIN_FREE_RUN_BYTES) {
          await this.#end("disk-full", now);
          return;
        }
      }
      if (this.#sizeLimitAt !== null) {
        await this.#end("size-cap", this.#sizeLimitAt);
        return;
      }
      if (now - this.#lastManifestWrite >= MANIFEST_WRITE_MICROS) {
        this.#lastManifestWrite = now;
        this.#save();
      }
    });
    return this.drain();
  }
  async #end(reason: RecordingGapReason | undefined, at: number, note?: string): Promise<void> {
    if (!this.#running && this.#manifest.state !== "recording") return;
    this.#running = false;
    this.#detach();
    this.#resolveReady(false);
    if (reason) this.#ownGaps.push({ from: at, to: null, reason });
    try {
      if (this.#writer) {
        await this.#writer.finish(Math.max(at, (this.#lastT ?? 0) + 1));
        this.#counts();
        this.#manifest.state = "complete";
        this.#manifest.finalized = true;
        this.#manifest.bytes = statSync(join(this.#deps.dir, RECORDING_VIDEO)).size;
      } else {
        this.#manifest.state = "failed";
        this.#manifest.note = "no key frame arrived";
      }
      if (note) this.#manifest.note = note;
      this.#save();
    } catch (error) {
      await this.#fail(
        (error as NodeJS.ErrnoException)?.code === "ENOSPC" ? "disk-full" : "recorder-error",
        at,
      );
    }
  }
  async #fail(reason: RecordingGapReason, at: number): Promise<void> {
    this.#running = false;
    this.#detach();
    this.#resolveReady(false);
    this.#writer?.close();
    try {
      const { codec, width, height } = this.#manifest;
      const result = await recoverRecording(
        this.#deps.dir,
        codec && width && height ? { codec, width, height } : undefined,
        this.#deps.fs,
      );
      Object.assign(this.#manifest, result);
      this.#ownGaps.push({ from: result.lastMicros ?? at, to: null, reason });
      this.#writer = undefined;
      this.#entries = this.#readRecoveredEntries();
      this.#save();
    } catch {
      this.#manifest.state = "failed";
      this.#manifest.note = "the recorder failed";
      this.#manifest.finalized = false;
      this.#ownGaps.push({ from: this.#lastT ?? at, to: null, reason });
      try {
        this.#save();
      } catch {
        /* a full disk cannot prevent the session from settling */
      }
    }
  }
  #readRecoveredEntries(): readonly FragmentEntry[] {
    const fs = this.#deps.fs ?? nodeFs;
    try {
      return fs
        .readFileSync(join(this.#deps.dir, "fragments.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => FragmentEntry.parse(JSON.parse(line)));
    } catch {
      return [];
    }
  }
  stop(endDaemonMicros: number): Promise<RecordingManifest> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    const end = this.#deps.toSessionT(endDaemonMicros);
    this.#stopPromise = this.#tail
      .then(async () => {
        if (this.#running || this.#manifest.state === "recording") await this.#end(undefined, end);
        return this.manifest;
      })
      .catch(() => this.manifest);
    this.#tail = this.#stopPromise.then(() => undefined);
    return this.#stopPromise;
  }
}
