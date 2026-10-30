import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECORDING_DIR,
  RECORDING_MANIFEST,
  RECORDING_VIDEO,
  type RecordingManifest,
  ulid,
} from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPACTION_DIR,
  compactionSource,
  compactTrack,
  resumeCompaction,
  resumeCompactions,
} from "./compaction.ts";
import { readManifest, writeManifest } from "./manifest.ts";
import { hasFinalMfra, readFragments } from "./recover.ts";
import { FakeEncoder } from "./testing/fake-encoder.ts";
import { burstTimes, TRACK_SYNTH, writeFinishedTrack } from "./testing/finished-track.ts";

// The daemon stops at a chosen rename: the one into the named file fails like a power cut.
const crash = vi.hoisted(() => ({ at: null as string | null }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const renameSync: typeof fs.renameSync = (from, to) => {
    if (crash.at && String(to).endsWith(crash.at)) {
      crash.at = null;
      throw new Error("the daemon stopped");
    }
    fs.renameSync(from, to);
  };
  return { ...fs, default: { ...fs, renameSync }, renameSync };
});

const roots: string[] = [];
afterEach(() => {
  crash.at = null;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function finishedTrack(): Promise<{
  home: string;
  dir: string;
  manifest: RecordingManifest;
}> {
  const home = mkdtempSync(join(tmpdir(), "local dot's compaction crash-"));
  roots.push(home);
  const dir = join(home, "sessions", ulid(), RECORDING_DIR);
  const times = burstTimes(96);
  return {
    home,
    dir,
    manifest: await writeFinishedTrack(dir, times, (times.at(-1) as number) + 1),
  };
}

const encoder = () =>
  new FakeEncoder({ keep: (index) => Math.floor(index / TRACK_SYNTH.keyEvery) % 2 === 0 });

function expectWhole(dir: string, compacted: boolean, source: RecordingManifest): void {
  const read = readManifest(dir);
  if (!read?.ok) throw new Error("unreadable manifest");
  const size = statSync(join(dir, RECORDING_VIDEO)).size;
  const entries = readFragments(dir);
  expect(read.manifest.bytes).toBe(size);
  expect(read.manifest.fragments).toBe(entries.length);
  expect(hasFinalMfra(join(dir, RECORDING_VIDEO), entries.at(-1)?.endOffset ?? 0)).toBe(true);
  expect(read.manifest.compacted).toEqual(compacted ? { sourceBytes: source.bytes } : undefined);
  expect(compacted ? size < source.bytes : size === source.bytes).toBe(true);
  expect(existsSync(join(dir, COMPACTION_DIR))).toBe(false);
}

describe("a restart during compaction", () => {
  it("keeps the original when it stops before the commit point", async () => {
    const track = await finishedTrack();
    crash.at = "ready.json";
    await expect(
      compactTrack(track.dir, encoder(), new AbortController().signal, 1),
    ).rejects.toThrow("the daemon stopped");
    resumeCompaction(track.dir);
    expectWhole(track.dir, false, track.manifest);
  });

  for (const at of ["fragments.jsonl", RECORDING_VIDEO, RECORDING_MANIFEST]) {
    it(`finishes the swap when it stops at moving ${at} into place`, async () => {
      const track = await finishedTrack();
      crash.at = join(RECORDING_DIR, at);
      await expect(
        compactTrack(track.dir, encoder(), new AbortController().signal, 1),
      ).rejects.toThrow("the daemon stopped");
      expect(existsSync(join(track.dir, COMPACTION_DIR, "ready.json"))).toBe(true);
      expect(compactionSource(track.dir, 1)).toBeNull();
      resumeCompactions(track.home);
      expectWhole(track.dir, true, track.manifest);
    });
  }

  it("drops a committed swap whose recording retention expired meanwhile", async () => {
    const track = await finishedTrack();
    crash.at = join(RECORDING_DIR, RECORDING_VIDEO);
    await expect(
      compactTrack(track.dir, encoder(), new AbortController().signal, 1),
    ).rejects.toThrow();
    rmSync(join(track.dir, RECORDING_VIDEO));
    writeManifest(track.dir, { ...track.manifest, state: "expired", bytes: 0, finalized: false });
    resumeCompaction(track.dir);
    expect(existsSync(join(track.dir, RECORDING_VIDEO))).toBe(false);
    expect(existsSync(join(track.dir, COMPACTION_DIR))).toBe(false);
  });

  it("drops staging from an encode that never finished", async () => {
    const track = await finishedTrack();
    mkdirSync(join(track.dir, COMPACTION_DIR));
    writeFileSync(join(track.dir, COMPACTION_DIR, "encoded.mp4"), "partial");
    resumeCompaction(track.dir);
    expectWhole(track.dir, false, track.manifest);
  });
});
