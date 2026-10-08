import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_THUMBS, ULID_PATTERN } from "@localdot/protocol";
import sharp from "sharp";
import type { FrameStore } from "../gateway/frames.ts";
export const THUMB_W = 320,
  THUMB_H = 200,
  THUMB_CONCURRENCY = 2;
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
  path(id: string, frameId: string): Promise<string | undefined> {
    if (!ULID_PATTERN.test(id) || !ULID_PATTERN.test(frameId)) return Promise.resolve(undefined);
    const key = `${id}/${frameId}`;
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const work = this.#make(id, frameId).finally(() => this.#pending.delete(key));
    this.#pending.set(key, work);
    return work;
  }
  async #make(id: string, frameId: string): Promise<string | undefined> {
    const source = this.#frames.path(id, frameId);
    if (!source) return undefined;
    const dir = join(this.#home, "sessions", id, SESSION_THUMBS),
      file = join(dir, `${frameId}.webp`);
    if (existsSync(file)) return file;
    await this.#acquire();
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      if (!existsSync(source)) return undefined;
      if (existsSync(file)) return file;
      const bytes = await sharp(source)
        .resize(THUMB_W, THUMB_H, { fit: "fill", background: { r: 0, g: 0, b: 0, alpha: 1 } })
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
