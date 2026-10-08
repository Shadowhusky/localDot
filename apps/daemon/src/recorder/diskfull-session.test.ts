import { rmSync as cleanupDir, existsSync, mkdtempSync as makeTemp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "mediabunny";
import { afterEach, describe, expect, it } from "vitest";
import {
  MIN_FREE_RUN_BYTES,
  MIN_FREE_START_BYTES,
  SessionRecorder as ProductionSessionRecorder,
} from "./session-recorder.ts";
import { FakeFeed } from "./testing/fake-feed.ts";
import { fullAfter } from "./testing/full-fs.ts";

const o = { widthMbs: 4, heightMbs: 4, keyEvery: 10 };
const GiB = 1024 ** 3;
const at = (i: number) => 1_000_000 + i * 16_667;

async function packetsIn(file: string): Promise<number[]> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  const sink = new EncodedPacketSink((await input.getPrimaryVideoTrack()) as never);
  const t: number[] = [];
  for await (const p of sink.packets()) t.push(p.microsecondTimestamp);
  input.dispose();
  return t;
}

describe("disk full (Review Focus 3), the session", () => {
  it("stops the recording at ENOSPC, never the session, and keeps a playable prefix marked disk-full", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "local dot's full-session-")), "recording");
    const feed = new FakeFeed();
    const rec = new SessionRecorder({
      sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
      dir,
      feed: (h) => feed.attach(h),
      toSessionT: (us) => us,
      freeBytes: () => 50 * GiB,
      fs: fullAfter(400_000),
    });
    await rec.start();
    // Frames keep coming after the disk fills: none of them may throw into the feed.
    for (let i = 0; i < 2000; i++) feed.frame(synthFrame(o, i), at(i), 64, 64);
    await rec.drain();
    const m = rec.manifest;
    expect(m.state).toBe("recovered");
    expect(feed.stopped).toBe(true);
    const gap = m.gaps.find((g) => g.reason === "disk-full");
    expect(gap).toMatchObject({ to: null });
    const recorded = await packetsIn(join(dir, "video.mp4"));
    expect(recorded.length).toBeGreaterThan(50);
    expect(recorded.at(-1)).toBeLessThanOrEqual(gap?.from as number);
    expect(recorded).toEqual(Array.from({ length: recorded.length }, (_, i) => at(i)));
    // Ending the session afterwards reports the same manifest and does not throw.
    expect((await rec.stop(at(2001))).state).toBe("recovered");
  });

  it("does not start below the free-space floor and says why", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "local dot's floor-")), "recording");
    const feed = new FakeFeed();
    const rec = new SessionRecorder({
      sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
      dir,
      feed: (h) => feed.attach(h),
      toSessionT: (us) => us,
      freeBytes: () => MIN_FREE_START_BYTES - 1,
    });
    await rec.start();
    expect(feed.started).toBe(false);
    expect(rec.manifest).toMatchObject({ state: "none", note: "not enough free disk space" });
    expect(existsSync(join(dir, "video.mp4"))).toBe(false);
  });

  it("finishes the recording cleanly when free space falls below the running floor", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "local dot's low-")), "recording");
    const feed = new FakeFeed();
    let free = 50 * GiB;
    const rec = new SessionRecorder({
      sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
      dir,
      feed: (h) => feed.attach(h),
      toSessionT: (us) => us,
      freeBytes: () => free,
    });
    await rec.start();
    for (let i = 0; i < 100; i++) feed.frame(synthFrame(o, i), at(i), 64, 64);
    await rec.drain();
    free = MIN_FREE_RUN_BYTES - 1;
    await rec.tick(at(100));
    expect(feed.stopped).toBe(true);
    expect(rec.manifest.state).toBe("complete");
    expect(rec.manifest.gaps).toEqual([{ from: at(100), to: null, reason: "disk-full" }]);
    expect(await packetsIn(join(dir, "video.mp4"))).toHaveLength(100);
  });
});

const ownedRoots: string[] = [];
const ownedRecorders: ProductionSessionRecorder[] = [];
function mkdtempSync(prefix: string): string {
  const dir = makeTemp(prefix);
  ownedRoots.push(dir);
  return dir;
}
class SessionRecorder extends ProductionSessionRecorder {
  constructor(...args: ConstructorParameters<typeof ProductionSessionRecorder>) {
    super(...args);
    ownedRecorders.push(this);
  }
}
afterEach(async () => {
  for (const rec of ownedRecorders.splice(0)) await rec.stop(8_000_000_000);
  for (const dir of ownedRoots.splice(0)) cleanupRoot(dir);
});

function cleanupRoot(dir: string): void {
  cleanupDir(dir, { recursive: true, force: true });
}
