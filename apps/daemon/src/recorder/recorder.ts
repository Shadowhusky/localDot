import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BROWSER_RECORDING_DIR,
  emptyManifest,
  FragmentEntry,
  type LocalDotEvent,
  RECORDING_DIR,
  RECORDING_FRAGMENTS,
  RECORDING_VIDEO,
  type RecordingManifest,
  ULID_PATTERN,
} from "@localdot/protocol";
import type { StreamCells } from "../cells/stream-proxy.ts";
import type { Clock } from "../clock.ts";
import type { EventLog } from "../event-log.ts";
import type { RecordingUsage } from "./budget.ts";
import { freeBytes as diskFreeBytes } from "./disk.ts";
import { type FeedHandlers, type FrameFeed, SelkiesFeed } from "./feed.ts";
import { hasRecordingData, readManifest, writeManifest } from "./manifest.ts";
import { recoverRecording } from "./recover.ts";
import { SessionRecorder, TICK_MS } from "./session-recorder.ts";

export const RECORDER_START_TIMEOUT_MS = 3000;
export const SHUTDOWN_FINALIZE_MS = 5000;
export interface RecorderDeps {
  home: string;
  eventLog: EventLog;
  cells: Pick<StreamCells, "get" | "endpoints">;
  clock: Clock;
  enabled?: boolean;
  freeBytes?(dir: string): number;
  feedFor?(cellId: string, handlers: FeedHandlers): FrameFeed;
  startTimeoutMs?: number;
  screen?: "desktop" | "browser";
  usageFor?(sessionId: string): RecordingUsage;
  onFinished?(sessionId: string): void | Promise<void>;
}
export interface LiveRecording {
  manifest: RecordingManifest;
  live: boolean;
  entries: readonly FragmentEntry[];
}
export type RecordingAttachment = "ready" | "disabled" | "unavailable";
export interface SessionEventTap {
  backlog: readonly LocalDotEvent[];
  subscribe(listener: (e: LocalDotEvent) => void): () => void;
}
export function tapSessionEvents(
  eventLog: Pick<EventLog, "subscribe" | "read">,
  sessionId: string,
): SessionEventTap {
  const buffered: LocalDotEvent[] = [];
  let receiver: ((e: LocalDotEvent) => void) | undefined;
  let consumed = false;
  const unsubscribe = eventLog.subscribe((id, event) => {
    if (id !== sessionId) return;
    if (receiver) receiver(event);
    else buffered.push(event);
  });
  let backlog: readonly LocalDotEvent[];
  try {
    backlog = eventLog.read(sessionId);
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return {
    backlog,
    subscribe(listener) {
      if (consumed) throw new Error("session event tap already subscribed");
      consumed = true;
      receiver = listener;
      for (const event of buffered.splice(0)) listener(event);
      return unsubscribe;
    },
  };
}
function entriesIn(dir: string): FragmentEntry[] {
  // Only complete, validated JSONL entries are visible to a replay reader.
  const out: FragmentEntry[] = [];
  try {
    const videoSize = statSync(join(dir, RECORDING_VIDEO)).size;
    const bytes = requireIndex(dir);
    for (let at = 0; at < bytes.length; ) {
      const end = bytes.indexOf(10, at);
      if (end < 0) break;
      const parsed = FragmentEntry.safeParse(JSON.parse(bytes.subarray(at, end).toString("utf8")));
      const prev = out.at(-1);
      if (
        !parsed.success ||
        parsed.data.seq !== out.length + 1 ||
        parsed.data.endOffset > videoSize ||
        (prev &&
          (parsed.data.moofOffset < prev.endOffset || parsed.data.startMicros < prev.endMicros))
      )
        break;
      out.push(parsed.data);
      at = end + 1;
    }
  } catch {
    /* an invalid tail is excluded */
  }
  return out;
}

import { readFileSync as requireIndexFile } from "node:fs";

function requireIndex(dir: string): Buffer {
  return requireIndexFile(join(dir, RECORDING_FRAGMENTS));
}

export class Recorder {
  readonly #deps: RecorderDeps;
  readonly #held = new Map<string, number>();
  readonly #live = new Map<
    string,
    {
      cellId: string;
      recorder: SessionRecorder;
      timer: ReturnType<typeof setInterval>;
      stopping?: Promise<void>;
    }
  >();
  constructor(deps: RecorderDeps) {
    this.#deps = deps;
  }
  #dir(sessionId: string): string {
    return join(
      this.#deps.home,
      "sessions",
      sessionId,
      this.#deps.screen === "browser" ? BROWSER_RECORDING_DIR : RECORDING_DIR,
    );
  }
  isLive(sessionId: string): boolean {
    return this.#live.has(sessionId);
  }
  async start(cellId: string, sessionId: string): Promise<void> {
    await this.attach(cellId, sessionId);
  }
  async attach(cellId: string, sessionId: string): Promise<RecordingAttachment> {
    if (!ULID_PATTERN.test(sessionId)) return "unavailable";
    const existing = this.#live.get(sessionId);
    if (existing) {
      if (existing.cellId !== cellId || existing.stopping) return "unavailable";
      return this.#ready(sessionId, existing.recorder);
    }
    const dir = this.#dir(sessionId);
    try {
      if (this.#deps.enabled === false) {
        writeManifest(dir, emptyManifest("none", "recording is off"));
        return "disabled";
      }
      // Reattachment must never recreate/truncate a completed track or an uncertain tail.
      if (readManifest(dir) || hasRecordingData(dir)) return "unavailable";
      // This subscription and backlog fold happen before the first await or feed startup.
      const tap = tapSessionEvents(this.#deps.eventLog, sessionId);
      const recorder = new SessionRecorder({
        sessionId,
        dir,
        feed: (handlers) =>
          this.#deps.feedFor?.(cellId, handlers) ??
          new SelkiesFeed({
            endpoint: () => this.#deps.cells.endpoints(cellId)?.stream,
            clock: this.#deps.clock,
            handlers,
          }),
        toSessionT: (us) => this.#deps.eventLog.toSessionT(sessionId, us),
        freeBytes: this.#deps.freeBytes ?? diskFreeBytes,
        ...(this.#deps.usageFor ? { usage: this.#deps.usageFor(sessionId) } : {}),
        backlog: tap.backlog,
        subscribe: tap.subscribe,
      });
      const heldAt = this.#held.get(sessionId);
      if (heldAt !== undefined) void recorder.hold(heldAt);
      const timer = setInterval(() => {
        void recorder.tick(this.#deps.clock.nowMicros());
      }, TICK_MS);
      timer.unref();
      this.#live.set(sessionId, { cellId, recorder, timer });
      await recorder.start();
      return this.#ready(sessionId, recorder);
    } catch {
      console.error("the session recorder could not start");
      return "unavailable";
    }
  }
  async #ready(sessionId: string, recorder: SessionRecorder): Promise<RecordingAttachment> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        recorder.ready(),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(
            () => resolve(false),
            this.#deps.startTimeoutMs ?? RECORDER_START_TIMEOUT_MS,
          );
        }),
      ]);
      const owner = this.#live.get(sessionId);
      return ready && owner?.recorder === recorder && !owner.stopping && recorder.active
        ? "ready"
        : "unavailable";
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  hold(sessionId: string): Promise<void> {
    if (!ULID_PATTERN.test(sessionId)) return Promise.resolve();
    const at = this.#deps.clock.nowMicros();
    this.#held.set(sessionId, at);
    return this.#live.get(sessionId)?.recorder.hold(at) ?? Promise.resolve();
  }
  release(sessionId: string): void {
    this.#held.delete(sessionId);
    this.#live.get(sessionId)?.recorder.release(this.#deps.clock.nowMicros());
  }
  async stop(sessionId: string): Promise<void> {
    const entry = this.#live.get(sessionId);
    if (!entry) return;
    if (entry.stopping) return entry.stopping;
    clearInterval(entry.timer);
    entry.stopping = (async () => {
      await entry.recorder.stop(this.#deps.clock.nowMicros());
      if (this.#live.get(sessionId) === entry) this.#live.delete(sessionId);
      try {
        await this.#deps.onFinished?.(sessionId);
      } catch {
        console.error("recording finalization follow-up failed");
      }
    })().catch(() => {
      if (this.#live.get(sessionId) === entry) this.#live.delete(sessionId);
      console.error("the session recording could not finalize");
    });
    return entry.stopping;
  }
  async stopAll(timeoutMs = SHUTDOWN_FINALIZE_MS): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.#live.keys()].map((id) => this.stop(id))),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  info(sessionId: string): LiveRecording | undefined {
    if (!ULID_PATTERN.test(sessionId)) return undefined;
    const live = this.#live.get(sessionId);
    if (live)
      return { manifest: live.recorder.manifest, live: true, entries: live.recorder.entries };
    const dir = this.#dir(sessionId);
    const read = readManifest(dir);
    if (read?.ok) return { manifest: read.manifest, live: false, entries: entriesIn(dir) };
    if (read || hasRecordingData(dir))
      return {
        manifest: emptyManifest("failed", "the recording's manifest is missing or unreadable"),
        live: false,
        entries: [],
      };
    return undefined;
  }
  async recoverAll(): Promise<{ recovered: number; failed: number; quarantined: number }> {
    const result = { recovered: 0, failed: 0, quarantined: 0 };
    const sessions = join(this.#deps.home, "sessions");
    let ids: string[];
    try {
      ids = readdirSync(sessions);
    } catch {
      return result;
    }
    for (const id of ids) {
      if (!ULID_PATTERN.test(id) || this.isLive(id)) continue;
      const dir = this.#dir(id);
      if (!existsSync(dir)) continue;
      const read = readManifest(dir);
      if (!read?.ok) {
        if (read || hasRecordingData(dir)) {
          result.quarantined++;
          console.error(`recording ${id} was quarantined: manifest unavailable`);
        } else {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* recording cleanup is optional */
          }
        }
        continue;
      }
      const m = read.manifest;
      if (m.state !== "recording" && !(["recovered", "failed"].includes(m.state) && !m.finalized))
        continue;
      try {
        const recovered = await recoverRecording(dir);
        const gaps = m.gaps.map((gap) => ({ ...gap }));
        if (m.state === "recording")
          gaps.push({
            from: recovered.lastMicros ?? m.lastMicros ?? 0,
            to: null,
            reason: "recorder-error",
          });
        const next = {
          ...m,
          ...recovered,
          gaps,
          ...(recovered.state === "failed"
            ? { note: "the daemon stopped before the first frame" }
            : {}),
        };
        writeManifest(dir, next);
        result[recovered.state]++;
      } catch {
        result.failed++;
        console.error(`recording ${id} could not be recovered`);
      }
    }
    return result;
  }
}
