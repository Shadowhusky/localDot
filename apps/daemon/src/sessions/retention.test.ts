import {
  cpSync,
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
import { emptyManifest, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { readManifest, writeManifest } from "../recorder/manifest.ts";
import {
  FRAMES_MAX_AGE_DAYS,
  framesMaxAgeFromEnv,
  recordingStorage,
  retentionFromEnv,
  sweepFrames,
  sweepRecordings,
} from "./retention.ts";

const roots: string[] = [];
const megabyte = 1024 * 1024;
const now = new Date("2026-10-05T00:00:00.000Z");
function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-retention-"));
  roots.push(home);
  mkdirSync(join(home, "sessions"));
  return home;
}
function recording(home: string, bytes: number, startedAt: string) {
  const id = ulid();
  const session = join(home, "sessions", id);
  const directory = join(session, "recording");
  mkdirSync(join(directory, "journal"), { recursive: true });
  writeFileSync(
    join(session, "session.json"),
    JSON.stringify({ id, title: "Retained history", startedAt }),
  );
  writeFileSync(join(directory, "video.mp4"), Buffer.alloc(bytes, 17));
  writeFileSync(join(directory, "fragments.jsonl"), "recorded index\n");
  writeFileSync(join(directory, "journal", "0000000000000000.bin"), "owned journal");
  writeFileSync(join(session, "events.jsonl"), "retained events");
  mkdirSync(join(session, "frames"));
  mkdirSync(join(session, "thumbs"));
  writeFileSync(join(session, "frames", "observe.webp"), "retained frame");
  writeFileSync(join(session, "thumbs", "observe.webp"), "retained thumbnail");
  writeFileSync(join(session, "summary.json"), "retained summary");
  const manifest = {
    ...emptyManifest("complete"),
    bytes,
    fragments: 3,
    finalized: true,
    codec: "avc1.42c01e",
    width: 64,
    height: 64,
    activity: [{ from: 0, to: 1000 }],
    gaps: [{ from: 1000, to: 2000, reason: "user-control" as const }],
  };
  writeManifest(directory, manifest);
  return { id, session, directory, manifest };
}
afterEach(() => {
  for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("recording retention", () => {
  it("counts both screens against one budget and expires a session together", () => {
    const home = setup(),
      old = recording(home, megabyte, "2026-10-01T00:00:00.000Z");
    const browser = join(old.session, "recording-browser");
    cpSync(old.directory, browser, { recursive: true });
    const fresh = recording(home, megabyte, "2026-10-04T00:00:00.000Z");
    const result = sweepRecordings({
      home,
      now,
      policy: { maxBytes: 2 * megabyte, maxAgeDays: 30 },
      isLive: () => false,
    });
    expect(result).toEqual({ expired: [old.id], freedBytes: 2 * megabyte });
    for (const dir of [old.directory, browser]) {
      expect(existsSync(join(dir, "video.mp4"))).toBe(false);
      expect(readManifest(dir)).toMatchObject({
        ok: true,
        manifest: { state: "expired", bytes: 0 },
      });
    }
    expect(existsSync(join(fresh.directory, "video.mp4"))).toBe(true);
  });

  it("retains both screens while a browser track is unfinished or damaged", () => {
    const home = setup(),
      item = recording(home, 128, "2026-01-01T00:00:00.000Z");
    const browser = join(item.session, "recording-browser");
    cpSync(item.directory, browser, { recursive: true });
    for (const content of [
      JSON.stringify({ ...item.manifest, state: "recording", finalized: false }),
      "{damaged",
    ]) {
      writeFileSync(join(browser, "manifest.json"), content);
      expect(
        sweepRecordings({ home, now, policy: { maxBytes: 1, maxAgeDays: 1 }, isLive: () => false })
          .expired,
      ).toEqual([]);
      expect(existsSync(join(item.directory, "video.mp4"))).toBe(true);
      expect(existsSync(join(browser, "video.mp4"))).toBe(true);
    }
  });

  it("expires the oldest completed videos until the non-live total fits", () => {
    const home = setup();
    const oldest = recording(home, megabyte, "2026-10-01T00:00:00.000Z");
    const middle = recording(home, 2 * megabyte, "2026-10-02T00:00:00.000Z");
    const newest = recording(home, 3 * megabyte, "2026-10-03T00:00:00.000Z");
    mkdirSync(join(oldest.directory, ".compact"));
    writeFileSync(join(oldest.directory, ".compact", "encoded.mp4"), "a compaction under way");
    const result = sweepRecordings({
      home,
      now,
      policy: { maxBytes: 4 * megabyte, maxAgeDays: 30 },
      isLive: () => false,
    });
    expect(result).toEqual({ expired: [oldest.id, middle.id], freedBytes: 3 * megabyte });
    expect(existsSync(join(newest.directory, "video.mp4"))).toBe(true);
    const expired = readManifest(oldest.directory);
    expect(expired?.ok && expired.manifest).toMatchObject({
      state: "expired",
      bytes: 0,
      fragments: 3,
      activity: oldest.manifest.activity,
      gaps: oldest.manifest.gaps,
      codec: oldest.manifest.codec,
      width: 64,
      height: 64,
    });
    expect(existsSync(join(oldest.directory, "journal"))).toBe(false);
    expect(existsSync(join(oldest.directory, "fragments.jsonl"))).toBe(false);
    expect(existsSync(join(oldest.directory, ".compact"))).toBe(false);
    for (const path of [
      "events.jsonl",
      "frames/observe.webp",
      "thumbs/observe.webp",
      "summary.json",
    ])
      expect(readFileSync(join(oldest.session, path), "utf8")).toContain("retained");
  });

  it("totals what finished videos take and what re-encoding them saved", () => {
    const home = setup();
    recording(home, megabyte, "2026-10-03T00:00:00.000Z");
    const compacted = recording(home, 2 * megabyte, "2026-10-04T00:00:00.000Z");
    writeManifest(compacted.directory, {
      ...compacted.manifest,
      compacted: { sourceBytes: 5 * megabyte },
    });
    recording(home, megabyte, "2026-08-01T00:00:00.000Z");
    const policy = { maxBytes: 20 * megabyte, maxAgeDays: 30 };
    sweepRecordings({ home, now, policy, isLive: () => false });
    expect(recordingStorage(home, policy)).toEqual({
      videos: 2,
      bytes: 3 * megabyte,
      savedBytes: 3 * megabyte,
      ...policy,
      framesBytes: 3 * "retained frame".length,
      framesMaxAgeDays: FRAMES_MAX_AGE_DAYS,
    });
    expect(recordingStorage(join(home, "missing"), policy).videos).toBe(0);
  });

  it("expires old recordings but never touches a live session", () => {
    const home = setup();
    const old = recording(home, megabyte, "2026-08-01T00:00:00.000Z");
    const live = recording(home, megabyte, "2026-07-01T00:00:00.000Z");
    const result = sweepRecordings({
      home,
      now,
      policy: { maxBytes: 20 * megabyte, maxAgeDays: 30 },
      isLive: (id) => id === live.id,
    });
    expect(result.expired).toEqual([old.id]);
    expect(readFileSync(join(live.directory, "video.mp4"))).toEqual(Buffer.alloc(megabyte, 17));
    expect(readManifest(live.directory)).toEqual({ ok: true, manifest: live.manifest });
  });

  it("leaves missing, damaged and future-version manifests with their media intact", () => {
    const home = setup();
    for (const content of [
      undefined,
      "{broken",
      JSON.stringify({ ...emptyManifest("complete"), v: 2 }),
    ]) {
      const fixture = recording(home, 128, "2026-01-01T00:00:00.000Z");
      const manifest = join(fixture.directory, "manifest.json");
      if (content === undefined) rmSync(manifest);
      else writeFileSync(manifest, content);
      expect(
        sweepRecordings({ home, now, policy: { maxBytes: 0, maxAgeDays: 0 }, isLive: () => false })
          .expired,
      ).toEqual([]);
      expect(readFileSync(join(fixture.directory, "video.mp4"))).toEqual(Buffer.alloc(128, 17));
      expect(existsSync(join(fixture.directory, "journal", "0000000000000000.bin"))).toBe(true);
      if (content !== undefined) expect(readFileSync(manifest, "utf8")).toBe(content);
    }
  });

  it("uses bounded positive environment values and rejects invalid sweep policies", () => {
    expect(retentionFromEnv({})).toEqual({ maxBytes: 20 * 1024 ** 3, maxAgeDays: 30 });
    expect(
      retentionFromEnv({ LOCALDOT_RECORDINGS_MAX_GB: "2", LOCALDOT_RECORDINGS_MAX_DAYS: "7" }),
    ).toEqual({ maxBytes: 2 * 1024 ** 3, maxAgeDays: 7 });
    expect(
      retentionFromEnv({
        LOCALDOT_RECORDINGS_MAX_GB: "Infinity",
        LOCALDOT_RECORDINGS_MAX_DAYS: "-1",
      }),
    ).toEqual(retentionFromEnv({}));
    expect(() =>
      sweepRecordings({
        home: setup(),
        now,
        policy: { maxBytes: NaN, maxAgeDays: 30 },
        isLive: () => false,
      }),
    ).toThrow(RangeError);
  });
});

describe("screenshot retention", () => {
  function task(home: string, startedAt: string, summary: unknown = undefined) {
    const id = ulid();
    const session = join(home, "sessions", id);
    const [cover, a, b] = [ulid(), ulid(), ulid()];
    mkdirSync(join(session, "frames"), { recursive: true });
    mkdirSync(join(session, "thumbs"));
    writeFileSync(join(session, "session.json"), JSON.stringify({ id, startedAt }));
    writeFileSync(join(session, "events.jsonl"), "kept events");
    for (const frame of [cover, a, b])
      writeFileSync(join(session, "frames", `${frame}.webp`), "a screenshot");
    writeFileSync(join(session, "thumbs", `${a}.webp`), "a thumbnail");
    writeFileSync(
      join(session, "summary.json"),
      JSON.stringify(summary === undefined ? { id, coverFrameId: cover } : summary),
    );
    const frames = () => readdirSync(join(session, "frames")).sort();
    return { id, session, cover, frames };
  }

  it("keeps only the cover of a finished task's screenshots past their age, and nothing else goes", () => {
    const home = setup();
    const old = task(home, "2026-03-01T00:00:00.000Z");
    const recent = task(home, "2026-09-01T00:00:00.000Z");
    const live = task(home, "2026-03-01T00:00:00.000Z");
    const unsummarized = task(home, "2026-03-01T00:00:00.000Z", "not yet");
    const coverless = task(home, "2026-03-01T00:00:00.000Z", { coverFrameId: ulid() });
    const before = [recent, live, unsummarized, coverless].map((each) => each.frames());
    const swept = sweepFrames({ home, maxAgeDays: 180, now, isLive: (id) => id === live.id });
    expect(swept).toEqual({ sessions: [old.id], freedBytes: 2 * "a screenshot".length });
    expect(old.frames()).toEqual([`${old.cover}.webp`]);
    expect(readdirSync(join(old.session, "thumbs"))).toHaveLength(1);
    expect(readFileSync(join(old.session, "events.jsonl"), "utf8")).toBe("kept events");
    expect([recent, live, unsummarized, coverless].map((each) => each.frames())).toEqual(before);
    expect(sweepFrames({ home, maxAgeDays: 180, now, isLive: () => false })).toEqual({
      sessions: [live.id],
      freedBytes: 2 * "a screenshot".length,
    });
    expect(
      sweepFrames({ home: join(home, "missing"), maxAgeDays: 180, now, isLive: () => false }),
    ).toEqual({ sessions: [], freedBytes: 0 });
  });

  it("takes its age from the environment, and refuses an invalid one", () => {
    expect(framesMaxAgeFromEnv({})).toBe(180);
    expect(framesMaxAgeFromEnv({ LOCALDOT_FRAMES_MAX_DAYS: "365" })).toBe(365);
    expect(framesMaxAgeFromEnv({ LOCALDOT_FRAMES_MAX_DAYS: "0" })).toBe(180);
    expect(() => sweepFrames({ home: setup(), maxAgeDays: 0, now, isLive: () => false })).toThrow(
      RangeError,
    );
  });
});
