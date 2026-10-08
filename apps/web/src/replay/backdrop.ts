import { ULID_PATTERN } from "@localdot/protocol";
import { observeAt, type SessionModel } from "@localdot/stage";
import type { ReplaySource } from "../stage/worker-protocol.ts";
import { replayRequestInit, sessionResourceUrl } from "./recording-source.ts";

export const BACKDROP_CACHE = 6;

export class ObserveBackdrop {
  readonly #source: ReplaySource;
  readonly #cache = new Map<string, ImageBitmap>();
  #pending: { id: string; abort: AbortController; result: Promise<ImageBitmap | null> } | null =
    null;
  #generation = 0;
  #closed = false;

  constructor(source: ReplaySource) {
    this.#source = source;
  }

  async frameAt(model: SessionModel, tMs: number): Promise<VideoFrame | null> {
    const generation = ++this.#generation;
    if (this.#closed) return null;
    const observation = observeAt(model, tMs, this.#source.screen ?? "desktop");
    if (!observation) {
      this.#pending?.abort.abort();
      return null;
    }
    const bitmap = await this.#bitmap(observation.frameId);
    if (!bitmap || this.#closed || generation !== this.#generation) return null;
    return new VideoFrame(bitmap, { timestamp: Math.round(tMs * 1000) });
  }

  async #bitmap(frameId: string): Promise<ImageBitmap | null> {
    if (!ULID_PATTERN.test(frameId)) throw new RangeError("Invalid observation frame.");
    const cached = this.#cache.get(frameId);
    if (cached) {
      this.#cache.delete(frameId);
      this.#cache.set(frameId, cached);
      return cached;
    }
    if (this.#pending?.id === frameId && !this.#pending.abort.signal.aborted)
      return this.#pending.result;
    this.#pending?.abort.abort();
    const abort = new AbortController();
    const result = this.#load(frameId, abort.signal);
    const pending = { id: frameId, abort, result };
    this.#pending = pending;
    try {
      return await result;
    } finally {
      if (this.#pending === pending) this.#pending = null;
    }
  }

  async #load(frameId: string, signal: AbortSignal): Promise<ImageBitmap | null> {
    try {
      const response = await fetch(sessionResourceUrl(this.#source, `frames/${frameId}`), {
        ...replayRequestInit(this.#source),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Observation request failed (${response.status}).`);
      }
      const blob = await response.blob();
      if (signal.aborted || this.#closed) return null;
      const bitmap = await createImageBitmap(blob);
      if (signal.aborted || this.#closed) {
        bitmap.close();
        return null;
      }
      this.#cache.set(frameId, bitmap);
      while (this.#cache.size > BACKDROP_CACHE) {
        const oldest = this.#cache.keys().next().value;
        if (oldest === undefined) break;
        this.#cache.get(oldest)?.close();
        this.#cache.delete(oldest);
      }
      return bitmap;
    } catch (error) {
      if (signal.aborted || this.#closed) return null;
      throw error;
    }
  }

  close(): void {
    this.#closed = true;
    this.#generation++;
    this.#pending?.abort.abort();
    this.#pending = null;
    for (const bitmap of this.#cache.values()) bitmap.close();
    this.#cache.clear();
  }
}
