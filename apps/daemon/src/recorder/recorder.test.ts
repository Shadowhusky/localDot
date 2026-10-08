import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest } from "@localdot/protocol";
import { synthFrame } from "@localdot/stage/testing";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { readManifest, writeManifest } from "./manifest.ts";
import { Recorder } from "./recorder.ts";
import { FakeFeed } from "./testing/fake-feed.ts";

const roots: { home: string; log: EventLog; recorder: Recorder }[] = [];
function setup(enabled = true) {
  const home = mkdtempSync(join(tmpdir(), "recorder-service-"));
  const clock = { now: 0, nowMicros: () => clock.now };
  const log = new EventLog(home, clock);
  const id = log.createSession("recording service");
  const feed = new FakeFeed();
  let finished = 0;
  const recorder = new Recorder({
    home,
    eventLog: log,
    clock,
    cells: { get: () => undefined, endpoints: () => undefined },
    enabled,
    feedFor: (_cell, h) => feed.attach(h),
    freeBytes: () => 1024 ** 4,
    startTimeoutMs: 5,
    onFinished: () => {
      finished++;
    },
  });
  roots.push({ home, log, recorder });
  return {
    home,
    clock,
    log,
    id,
    feed,
    recorder,
    finished: () => finished,
    dir: join(home, "sessions", id, "recording"),
  };
}
afterEach(async () => {
  for (const s of roots.splice(0)) {
    await s.recorder.stopAll();
    s.log.close();
    rmSync(s.home, { recursive: true, force: true });
  }
});
function digests(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) {
      const p = join(e.parentPath, e.name);
      out[p.slice(dir.length)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  }
  return out;
}
describe("Recorder service", () => {
  it("records independently of viewers and calls finalization once", async () => {
    const s = setup();
    await s.recorder.start("cell", s.id);
    expect(s.recorder.isLive(s.id)).toBe(true);
    const o = { widthMbs: 4, heightMbs: 4, keyEvery: 15 };
    for (let i = 0; i < 20; i++) s.feed.frame(synthFrame(o, i), i * 16_667, 64, 64);
    s.clock.now = 400_000;
    await Promise.all([s.recorder.stop(s.id), s.recorder.stop(s.id)]);
    expect(s.finished()).toBe(1);
    expect(s.recorder.info(s.id)).toMatchObject({
      live: false,
      manifest: { state: "complete", finalized: true },
    });
    expect(s.recorder.info(s.id)?.entries.length).toBe(2);
    expect(existsSync(join(s.dir, "journal"))).toBe(false);
  });
  it("writes an explicit none manifest when disabled and never starts the feed", async () => {
    const s = setup(false);
    await s.recorder.start("cell", s.id);
    expect(s.feed.started).toBe(false);
    expect(s.recorder.info(s.id)?.manifest).toMatchObject({
      state: "none",
      note: "recording is off",
    });
    expect(s.recorder.isLive(s.id)).toBe(false);
  });
  it("quarantines invalid or absent format metadata without changing recording bytes", async () => {
    const s = setup();
    mkdirSync(join(s.dir, "journal"), { recursive: true });
    writeFileSync(join(s.dir, "video.mp4"), "retained video");
    writeFileSync(join(s.dir, "journal", "0000000000000001.bin"), "retained tail");
    for (const mode of ["missing", "invalid", "future"]) {
      if (mode === "missing") rmSync(join(s.dir, "manifest.json"), { force: true });
      else
        writeFileSync(
          join(s.dir, "manifest.json"),
          mode === "invalid" ? "{" : JSON.stringify({ ...emptyManifest("recording"), v: 2 }),
        );
      const before = digests(s.dir);
      expect(await s.recorder.recoverAll()).toEqual({ recovered: 0, failed: 0, quarantined: 1 });
      expect(digests(s.dir)).toEqual(before);
      expect(s.recorder.info(s.id)?.manifest).toMatchObject({
        state: "failed",
        note: "the recording's manifest is missing or unreadable",
      });
    }
  });
  it("cleans only an absent empty recording directory", async () => {
    const s = setup();
    mkdirSync(s.dir, { recursive: true });
    expect(await s.recorder.recoverAll()).toEqual({ recovered: 0, failed: 0, quarantined: 0 });
    expect(existsSync(s.dir)).toBe(false);
  });
  it("marks an unfinished no-frame recording failed and leaves a bounded recovery gap", async () => {
    const s = setup();
    writeManifest(s.dir, emptyManifest("recording"));
    expect(await s.recorder.recoverAll()).toEqual({ recovered: 0, failed: 1, quarantined: 0 });
    const read = readManifest(s.dir);
    expect(read?.ok && read.manifest).toMatchObject({
      state: "failed",
      gaps: [{ from: 0, to: null, reason: "recorder-error" }],
    });
  });
  it("rejects invalid session paths without reading or writing outside the home", async () => {
    const s = setup();
    await s.recorder.start("cell", "../escape");
    expect(s.recorder.info("../escape")).toBeUndefined();
    expect(s.recorder.isLive("../escape")).toBe(false);
  });
});
