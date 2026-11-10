import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_THUMBS, ULID_PATTERN } from "@localdot/protocol";
import type { FrameStore } from "../gateway/frames.ts";
import { raster } from "../raster.ts";
export const THUMB_W = 320,
  THUMB_H = 200,
  THUMB_CONCURRENCY = 2;
// The widths a thumbnail is made at: Replay's strip, and the overview's tiles drawn wide or on a
// dense screen. A screenshot is 1280 wide, so the larger is still a quarter of its pixels.
export const THUMB_WIDTHS = [THUMB_W, 640] as const;
export type ThumbWidth = (typeof THUMB_WIDTHS)[number];
export const isThumbWidth = (width: number): width is ThumbWidth =>
  (THUMB_WIDTHS as readonly number[]).includes(width);
export class Thumbnails {
  readonly #home: string;
  readonly #frames: FrameStore;
  readonly #pending = new Map<string, Promise<string | undefined>>();
  readonly #waiting: (() => void)[] = [];
  #active = 0;
  constructor(home: string, frames: FrameStore) {
    this.#home = home;
    this.#frames = frames;
  }
  async #acquire(): Promise<void> {
    if (this.#active < THUMB_CONCURRENCY) {
      this.#active++;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }
  #release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#active--;
  }
  path(id: string, frameId: string, width: ThumbWidth = THUMB_W): Promise<string | undefined> {
    if (!ULID_PATTERN.test(id) || !ULID_PATTERN.test(frameId) || !isThumbWidth(width))
      return Promise.resolve(undefined);
    const key = `${id}/${frameId}/${width}`;
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const work = this.#make(id, frameId, width).finally(() => this.#pending.delete(key));
    this.#pending.set(key, work);
    return work;
  }
  // A thumbnail made earlier outlives its screenshot, which goes with age.
  async #make(id: string, frameId: string, width: ThumbWidth): Promise<string | undefined> {
    const dir = join(this.#home, "sessions", id, SESSION_THUMBS),
      file = join(dir, width === THUMB_W ? `${frameId}.webp` : `${frameId}-${width}.webp`);
    if (existsSync(file)) return file;
    const source = this.#frames.path(id, frameId);
    if (!source) return undefined;
    await this.#acquire();
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      if (!existsSync(source)) return undefined;
      if (existsSync(file)) return file;
      const bytes = await (await raster(readFileSync(source)))
        .resize(width, (width * THUMB_H) / THUMB_W, {
          fit: "fill",
          background: { r: 0, g: 0, b: 0, alpha: 1 },
        })
        .webp({ quality: 70 })
        .toBuffer();
      if (!existsSync(source)) return undefined;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
      renameSync(temp, file);
      return file;
    } catch (error) {
      if (!existsSync(source)) return undefined;
      throw error;
    } finally {
      rmSync(temp, { force: true });
      this.#release();
    }
  }
}
