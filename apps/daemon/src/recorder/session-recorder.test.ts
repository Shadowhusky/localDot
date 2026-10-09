import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalDotEvent } from "@localdot/protocol";
import { type SynthFrame, synthFrame } from "@localdot/stage/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeJournal } from "./journal.ts";
import { readManifest } from "./manifest.ts";
import { MAX_GOP_MICROS, SessionRecorder, type SessionRecorderDeps } from "./session-recorder.ts";
import { FakeFeed } from "./testing/fake-feed.ts";

const opts = { widthMbs: 4, heightMbs: 4, keyEvery: 15 };
const owned: { root: string; rec: SessionRecorder }[] = [];
async function setup(extra: Partial<SessionRecorderDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "session-policies-"));
  const dir = join(root, "recording");
  const feed = new FakeFeed();
  const rec = new SessionRecorder({
    sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
    dir,
    feed: (h) => feed.attach(h),
    toSessionT: (us) => us,
    freeBytes: () => 1024 ** 4,
    ...extra,
  });
  owned.push({ root, rec });
  await rec.start();
  return { root, dir, feed, rec };
}
afterEach(async () => {
  for (const { root, rec } of owned.splice(0)) {
    await rec.stop(20_000_000);
    rmSync(root, { recursive: true, force: true });
  }
});
function journalTimes(dir: string): number[] {
  try {
    return readdirSync(join(dir, "journal")).flatMap((name) =>
      decodeJournal(readFileSync(join(dir, "journal", name))).map((p) => p.tMicros),
    );
  } catch {
    return [];
  }
}
function withLevel(frame: SynthFrame, level: number): SynthFrame {
  const data = frame.data.slice();
  for (let i = 0; i + 6 < data.length; i++)
    if (
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 1 &&
      ((data[i + 3] ?? 0) & 0x1f) === 7
    ) {
      data[i + 6] = level;
      return { ...frame, data };
    }
  throw new Error("the frame has no SPS");
}
describe("session recording policy", () => {
  it.each(["authority", "event"] as const)(
    "retries a lost %s handback key request without admitting private or dependent frames",
    async (control) => {
      let observe!: (event: LocalDotEvent) => void;
      const { rec, dir, feed } = await setup({
        subscribe: (listener) => {
          observe = listener;
          return () => {};
        },
      });
      feed.frame(synthFrame(opts, 0), 0, 64, 64);
      await rec.drain();
      await rec.tick(600_000);
      const change = async (holder: "user" | "agent", t: number) => {
        if (control === "authority") {
          if (holder === "user") await rec.hold(t);
          else rec.release(t);
        } else {
          observe({
            v: 1,
            id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
            seq: holder === "user" ? 1 : 2,
            agent: "main",
            t,
            type: "control.change",
            data: { holder, reason: holder === "user" ? "user_takeover" : "resume" },
          });
        }
      };
      await change("user", 700_000);
      feed.frame(synthFrame(opts, 15), 800_000, 64, 64);
      await rec.drain();
      await change("agent", 900_000);
      const requested = feed.keyRequests.length;
      // Simulate a stream that drops the first request. Its delta cannot resume the video.
      feed.frame(synthFrame(opts, 1), 1_000_000, 64, 64);
      await rec.drain();
      await rec.tick(1_399_999);
      expect(feed.keyRequests).toHaveLength(requested);
      expect(journalTimes(dir)).toEqual([0]);
      await rec.tick(1_400_000);
      expect(feed.keyRequests).toHaveLength(requested + 1);
      feed.frame(synthFrame(opts, 30), 1_600_000, 64, 64);
      await rec.drain();
      // The new key commits the earlier fragment and retires its journal.
      expect(journalTimes(dir)).toEqual([1_600_000]);
      expect(rec.manifest.firstMicros).toBe(0);
      expect(rec.manifest.gaps).toEqual([{ from: 700_000, to: 1_600_000, reason: "user-control" }]);
      await rec.tick(1_950_000);
      expect(feed.keyRequests).toHaveLength(requested + 1);
    },
  );
  it("writes its format manifest before the first packet reaches the journal", async () => {
    const { rec, dir, feed } = await setup();
    feed.frame(synthFrame(opts, 0), 100_000, 64, 64);
    await rec.drain();
    const read = readManifest(dir);
    expect(read?.ok && read.manifest).toMatchObject({
      state: "recording",
      codec: "avc1.42c01e",
      width: 64,
      height: 64,
      firstMicros: 100_000,
      finalized: false,
    });
    expect(journalTimes(dir)).toEqual([100_000]);
    expect(await rec.ready()).toBe(true);
  });
  it("drops an overlong GOP until a fresh key closes its error gap", async () => {
    const { rec, dir, feed } = await setup();
    feed.frame(synthFrame(opts, 0), 0, 64, 64);
    await rec.drain();
    const dropped = MAX_GOP_MICROS + 1;
    feed.frame(synthFrame(opts, 1), dropped, 64, 64);
    feed.frame(synthFrame(opts, 2), dropped + 1, 64, 64);
    await rec.drain();
    expect(journalTimes(dir)).toEqual([0]);
    feed.frame(synthFrame(opts, 15), dropped + 20, 64, 64);
    await rec.drain();
    expect(rec.manifest.gaps).toEqual([
      { from: dropped, to: dropped + 20, reason: "recorder-error" },
    ]);
    expect(feed.keyRequests.length).toBeGreaterThan(0);
  });
  it("checks the gap limit on every frame and tick without copying the manifest", async () => {
    const { rec, feed } = await setup();
    feed.frame(synthFrame(opts, 0), 0, 64, 64);
    await rec.drain();
    const manifest = vi.spyOn(rec, "manifest", "get");
    for (let n = 1; n < 15; n++) feed.frame(synthFrame(opts, n), n * 33_000, 64, 64);
    await rec.drain();
    await rec.tick(500_000);
    expect(manifest).not.toHaveBeenCalled();
  });
  it("bounds the queue and resumes after overflow only on a key frame", async () => {
    const key = synthFrame(opts, 0);
    const { rec, feed } = await setup({ queueLimitBytes: key.data.length + 10 });
    feed.frame(key, 10, 64, 64);
    feed.frame(synthFrame(opts, 1), 20, 64, 64);
    await rec.drain();
    feed.frame(synthFrame(opts, 2), 30, 64, 64);
    await rec.drain();
    feed.frame(synthFrame(opts, 15), 40, 64, 64);
    await rec.drain();
    expect(rec.manifest.gaps).toEqual([{ from: 20, to: 40, reason: "recorder-error" }]);
    expect(feed.keyRequests.length).toBeGreaterThan(0);
  });
  it("ends at a changed stream format without writing the new format", async () => {
    const { rec, feed } = await setup();
    feed.frame(synthFrame(opts, 0), 10, 64, 64);
    await rec.drain();
    feed.frame(synthFrame(opts, 15), 20, 128, 64);
    await rec.drain();
    expect(rec.manifest).toMatchObject({
      state: "complete",
      finalized: true,
      width: 64,
      note: "the stream changed format",
    });
    expect(feed.stopped).toBe(true);
  });
  // A viewer that asks for fewer frames makes the encoder pick a lower level for the same picture.
  it("keeps recording when only the stream's level changes", async () => {
    const { rec, feed } = await setup();
    feed.frame(synthFrame(opts, 0), 10, 64, 64);
    await rec.drain();
    const relevelled = withLevel(synthFrame(opts, 15), 0x1f);
    feed.frame(relevelled, 20, 64, 64);
    feed.frame(synthFrame(opts, 16), 30, 64, 64);
    await rec.drain();
    expect(rec.manifest).toMatchObject({ state: "recording", codec: "avc1.42c01e", width: 64 });
    expect(rec.manifest.note).toBeUndefined();
    expect(rec.manifest.lastMicros).toBe(30);
    expect(feed.stopped).toBe(false);
  });
  it("ends cleanly after the first committed fragment crosses the size cap", async () => {
    const { rec, feed } = await setup({ sizeCapBytes: 1 });
    for (let i = 0; i < 20; i++) feed.frame(synthFrame(opts, i), 100_000 + i * 16_667, 64, 64);
    await rec.drain();
    expect(rec.manifest).toMatchObject({ state: "complete", finalized: true });
    expect(rec.manifest.gaps.at(-1)?.reason).toBe("size-cap");
    expect(feed.stopped).toBe(true);
  });
  it("reports a failed recording when Stop arrives before a key frame", async () => {
    const { rec, feed } = await setup();
    feed.frame(synthFrame(opts, 1), 10, 64, 64);
    await rec.drain();
    expect((await rec.stop(100)).note).toBe("no key frame arrived");
    expect(await rec.ready()).toBe(false);
  });
  it("keeps all activity covered while enforcing the configured soft cap", async () => {
    const { rec, feed } = await setup({ activitySoftCap: 3 });
    for (let i = 0; i < 12; i++) {
      feed.frame(synthFrame(opts, 0), i * 1_000_000, 64, 64);
      await rec.drain();
    }
    expect(rec.manifest.activity).toHaveLength(3);
    for (let i = 0; i < 12; i++)
      expect(
        rec.manifest.activity.some((s) => s.from <= i * 1_000_000 && s.to >= i * 1_000_000),
      ).toBe(true);
  });
  it("waits for a key after lost and avoids a synthetic gap for an immediate pipeline-reset key", async () => {
    const { rec, feed } = await setup();
    feed.frame(synthFrame(opts, 0), 10, 64, 64);
    await rec.drain();
    feed.handlers?.onState("live", "pipeline-reset");
    feed.frame(synthFrame(opts, 15), 20, 64, 64);
    await rec.drain();
    expect(rec.manifest.gaps).toEqual([]);
    feed.handlers?.onState("lost");
    feed.handlers?.onState("live");
    feed.frame(synthFrame(opts, 1), 30, 64, 64);
    feed.frame(synthFrame(opts, 15), 40, 64, 64);
    await rec.drain();
    expect(rec.manifest.gaps).toEqual([{ from: 20, to: 40, reason: "stream-lost" }]);
  });
});
