import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameStore } from "../gateway/frames.ts";
import { Thumbnails } from "./thumbs.ts";

const roots: string[] = [];
async function setup(count = 1) {
  const home = mkdtempSync(join(tmpdir(), "localdot-thumbnails-"));
  roots.push(home);
  const frames = new FrameStore(home);
  const sessionId = ulid();
  const bytes = await sharp({
    create: { width: 1280, height: 800, channels: 3, background: "blue" },
  })
    .webp()
    .toBuffer();
  const ids = Array.from({ length: count }, () => ulid());
  for (const frameId of ids) frames.save(sessionId, frameId, bytes);
  return { home, sessionId, ids, thumbs: new Thumbnails(home, frames) };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
});
describe("observation thumbnails", () => {
  it("creates a private 320 by 200 WebP and reuses it for concurrent and later requests", async () => {
    const { sessionId, ids, thumbs } = await setup();
    const paths = await Promise.all(
      Array.from({ length: 5 }, () => thumbs.path(sessionId, ids[0] as string)),
    );
    expect(new Set(paths).size).toBe(1);
    const path = paths[0] as string;
    expect(await sharp(path).metadata()).toMatchObject({ width: 320, height: 200, format: "webp" });
    const before = statSync(path);
    expect(before.mode & 0o777).toBe(0o600);
    expect(await thumbs.path(sessionId, ids[0] as string)).toBe(path);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
  });
  it("returns no thumbnail for missing or invalid frame ids", async () => {
    const { sessionId, thumbs } = await setup();
    expect(await thumbs.path(sessionId, ulid())).toBeUndefined();
    expect(await thumbs.path(sessionId, "../frame")).toBeUndefined();
  });
  it("runs at most two conversions at once", async () => {
    const { sessionId, ids, thumbs } = await setup(8);
    const prototype = sharp.prototype as { toBuffer(): Promise<Buffer> };
    const original = prototype.toBuffer;
    let active = 0;
    let peak = 0;
    vi.spyOn(prototype, "toBuffer").mockImplementation(async function (this: typeof prototype) {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return await original.call(this);
      } finally {
        active--;
      }
    });
    await Promise.all(ids.map((frameId) => thumbs.path(sessionId, frameId)));
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });
  it("does not recreate a deleted session when an in-flight thumbnail finishes", async () => {
    const { home, sessionId, ids, thumbs } = await setup(3);
    const sessionDirectory = join(home, "sessions", sessionId);
    const prototype = sharp.prototype as { toBuffer(): Promise<Buffer> };
    const original = prototype.toBuffer;
    const converted = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let completed = 0;
    vi.spyOn(prototype, "toBuffer").mockImplementation(async function (this: typeof prototype) {
      const bytes = await original.call(this);
      completed++;
      if (completed === 2) converted.resolve();
      await resume.promise;
      return bytes;
    });
    const requests = ids.map((frameId) => thumbs.path(sessionId, frameId));
    try {
      await converted.promise;
      rmSync(sessionDirectory, { recursive: true });
    } finally {
      resume.resolve();
    }
    const results = await Promise.allSettled(requests);
    expect(results).toEqual(ids.map(() => ({ status: "fulfilled", value: undefined })));
    expect(existsSync(sessionDirectory)).toBe(false);
  });
});
