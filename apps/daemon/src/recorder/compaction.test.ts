import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECORDING_DIR, RECORDING_VIDEO, type RecordingManifest, ulid } from "@localdot/protocol";
import { SYNTH_CODEC, synthFrame } from "@localdot/stage/testing";
import {
  BufferTarget,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  BufferSource as MediaBuffer,
  MP4,
  Mp4OutputFormat,
  Output,
  StreamSource,
} from "mediabunny";
import { afterEach, describe, expect, it } from "vitest";
import { sweepRecordings } from "../sessions/retention.ts";
import { recordingCard } from "../sessions/summary.ts";
import { avccToAnnexB, parseAvcC } from "./annexb.ts";
import {
  COMPACTION_DIR,
  compactionSource,
  compactTrack,
  decodeArgs,
  decodedFrames,
  encodeArgs,
} from "./compaction.ts";
import { readManifest, writeManifest } from "./manifest.ts";
import { hasFinalMfra, readFragments } from "./recover.ts";
import { FakeEncoder } from "./testing/fake-encoder.ts";
import { burstTimes, TRACK_SYNTH, writeFinishedTrack } from "./testing/finished-track.ts";
import { openRecordingView } from "./view.ts";

const synth = TRACK_SYNTH;
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Track {
  home: string;
  id: string;
  dir: string;
  times: number[];
  end: number;
  manifest: RecordingManifest;
}

async function finishedTrack(): Promise<Track> {
  const home = mkdtempSync(join(tmpdir(), "local dot's compaction-"));
  roots.push(home);
  const id = ulid();
  const dir = join(home, "sessions", id, RECORDING_DIR);
  const times = burstTimes(120);
  const end = (times.at(-1) as number) + 250_000;
  const written = await writeFinishedTrack(dir, times, end);
  const manifest: RecordingManifest = {
    ...written,
    activity: [{ from: times[0] as number, to: times[29] as number }],
    gaps: [{ from: 3_000_000, to: 3_500_000, reason: "user-control" }],
  };
  writeManifest(dir, manifest);
  return { home, id, dir, times, end, manifest };
}

// Whole GOPs, a third of them: what an encoder that drops repeats keeps of a mostly still screen.
const everyThirdGop = (index: number) => Math.floor(index / synth.keyEvery) % 3 === 0;
const keptOf = (times: number[]) =>
  times.flatMap((t, i) => (everyThirdGop(i) ? [{ t, key: i % synth.keyEvery === 0 }] : []));
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const signal = () => new AbortController().signal;

describe("compacting a finished recording", () => {
  it("writes the recorder's own format at the source's times, with an index and both sizes", async () => {
    const track = await finishedTrack();
    const result = await compactTrack(
      track.dir,
      new FakeEncoder({ keep: everyThirdGop }),
      signal(),
      1,
    );
    const size = statSync(join(track.dir, RECORDING_VIDEO)).size;
    expect(result).toEqual({
      outcome: "compacted",
      sourceBytes: track.manifest.bytes,
      bytes: size,
    });
    expect(size).toBeLessThan(track.manifest.bytes / 2);
    const read = readManifest(track.dir);
    const entries = readFragments(track.dir);
    expect(read?.ok && read.manifest).toEqual({
      ...track.manifest,
      bytes: size,
      fragments: entries.length,
      compacted: { sourceBytes: track.manifest.bytes },
    });
    expect(entries.length).toBe(keptOf(track.times).filter((frame) => frame.key).length);
    expect(entries[0]?.startMicros).toBe(track.times[0]);
    expect(hasFinalMfra(join(track.dir, RECORDING_VIDEO), entries.at(-1)?.endOffset ?? 0)).toBe(
      true,
    );
    expect(existsSync(join(track.dir, COMPACTION_DIR))).toBe(false);
    // What Replay and retention see: the new size, and nothing more to compact.
    expect(recordingCard(track.home, track.id)).toEqual({ state: "complete", bytes: size });
    expect(compactionSource(track.dir, 1)).toBeNull();
    const total = sweepRecordings({
      home: track.home,
      policy: { maxBytes: size, maxAgeDays: 30 },
      now: new Date(),
      isLive: () => false,
    });
    expect(total.expired).toEqual([]);
  });

  it("seeks like the original through the served file: the frame on screen and its key frame", async () => {
    const track = await finishedTrack();
    await compactTrack(track.dir, new FakeEncoder({ keep: everyThirdGop }), signal(), 1);
    const view = openRecordingView(track.dir, { complete: true });
    const input = new Input({
      formats: [MP4],
      source: new StreamSource({ getSize: () => view.size, read: (s, e) => view.read(s, e) }),
    });
    try {
      const track1 = await input.getPrimaryVideoTrack();
      if (!track1) throw new Error("no track");
      const sink = new EncodedPacketSink(track1);
      const kept = keptOf(track.times);
      let key = 0;
      for (const [i, frame] of kept.entries()) {
        if (frame.key) key = frame.t;
        const next = kept[i + 1]?.t ?? track.end;
        for (const q of [frame.t, Math.floor((frame.t + next) / 2), next - 1]) {
          expect((await sink.getPacket(q / 1e6))?.microsecondTimestamp).toBe(frame.t);
          expect((await sink.getKeyPacket(q / 1e6))?.microsecondTimestamp).toBe(key);
        }
      }
      expect(await sink.getPacket((track.times[0] as number) / 1e6 - 1e-6)).toBeNull();
      const last = await sink.getPacket(Number.POSITIVE_INFINITY);
      expect((last?.microsecondTimestamp ?? 0) + (last?.microsecondDuration ?? 0)).toBe(track.end);
    } finally {
      input.dispose();
      view.close();
    }
  });

  it("keeps the original, and does not try again, when the result moves a frame, does not decode whole or saves too little", async () => {
    for (const encoder of [
      new FakeEncoder({ keep: everyThirdGop, shiftMicros: 1 }),
      new FakeEncoder({ keep: everyThirdGop, decoded: (frames) => frames - 1 }),
      new FakeEncoder(),
    ]) {
      const track = await finishedTrack();
      const before = digest(join(track.dir, RECORDING_VIDEO));
      const result = await compactTrack(track.dir, encoder, signal(), 1);
      expect(result.outcome).toBe("kept");
      expect(digest(join(track.dir, RECORDING_VIDEO))).toBe(before);
      const read = readManifest(track.dir);
      expect(read?.ok && read.manifest).toEqual({
        ...track.manifest,
        compacted: { sourceBytes: track.manifest.bytes },
      });
      expect(existsSync(join(track.dir, COMPACTION_DIR))).toBe(false);
      expect(compactionSource(track.dir, 1)).toBeNull();
    }
  });

  it("leaves alone a recording that is live, unfinished, expired, already compacted or small", async () => {
    const track = await finishedTrack();
    expect(compactionSource(track.dir, 1)?.size).toBe(track.manifest.bytes);
    expect(compactionSource(track.dir)).toBeNull();
    for (const patch of [
      { state: "recording" as const, finalized: false },
      { state: "recovered" as const, finalized: false },
      { state: "failed" as const },
      { state: "expired" as const },
      { compacted: { sourceBytes: track.manifest.bytes } },
      { bytes: track.manifest.bytes - 1 },
    ]) {
      writeManifest(track.dir, { ...track.manifest, ...patch });
      expect(compactionSource(track.dir, 1)).toBeNull();
    }
    writeManifest(track.dir, track.manifest);
    mkdirSync(join(track.dir, "journal"));
    expect(compactionSource(track.dir, 1)).toBeNull();
  });

  it("swaps nothing in when the track changed while it was encoded", async () => {
    const track = await finishedTrack();
    const before = digest(join(track.dir, RECORDING_VIDEO));
    const changed = { ...track.manifest, note: "changed meanwhile" };
    const result = await compactTrack(
      track.dir,
      new FakeEncoder({ keep: everyThirdGop, after: () => writeManifest(track.dir, changed) }),
      signal(),
      1,
    );
    expect(result).toEqual({ outcome: "changed" });
    expect(digest(join(track.dir, RECORDING_VIDEO))).toBe(before);
    const read = readManifest(track.dir);
    expect(read?.ok && read.manifest).toEqual(changed);
    expect(existsSync(join(track.dir, COMPACTION_DIR))).toBe(false);
  });

  it("never brings back a task deleted, or a video expired, while it is encoded", async () => {
    const deleted = await finishedTrack();
    const session = join(deleted.home, "sessions", deleted.id);
    await expect(
      compactTrack(
        deleted.dir,
        new FakeEncoder({ keep: everyThirdGop, after: () => rmSync(session, { recursive: true }) }),
        signal(),
        1,
      ),
    ).rejects.toThrow();
    expect(existsSync(session)).toBe(false);

    const expired = await finishedTrack();
    const outcome = await compactTrack(
      expired.dir,
      new FakeEncoder({
        keep: everyThirdGop,
        after: () => {
          sweepRecordings({
            home: expired.home,
            policy: { maxBytes: 0, maxAgeDays: 30 },
            now: new Date(),
            isLive: () => false,
          });
        },
      }),
      signal(),
      1,
    ).catch(() => null);
    expect(outcome?.outcome ?? "failed").not.toBe("compacted");
    const read = readManifest(expired.dir);
    expect(read?.ok && read.manifest.state).toBe("expired");
    expect(existsSync(join(expired.dir, RECORDING_VIDEO))).toBe(false);
    expect(existsSync(join(expired.dir, COMPACTION_DIR))).toBe(false);
  });

  it("stops when cancelled and keeps the original", async () => {
    const track = await finishedTrack();
    const before = digest(join(track.dir, RECORDING_VIDEO));
    const controller = new AbortController();
    await expect(
      compactTrack(
        track.dir,
        new FakeEncoder({ keep: everyThirdGop, after: () => controller.abort() }),
        controller.signal,
        1,
      ),
    ).rejects.toThrow();
    expect(digest(join(track.dir, RECORDING_VIDEO))).toBe(before);
    const read = readManifest(track.dir);
    expect(read?.ok && read.manifest).toEqual(track.manifest);
    expect(existsSync(join(track.dir, COMPACTION_DIR))).toBe(false);
  });
});

describe("the encode and its checks", () => {
  it("keeps every frame's time, drops only repeats and bounds the key frame interval", () => {
    const args = encodeArgs("/in/video.mp4", "/out/encoded.mp4");
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("-vf")).toBe("mpdecimate=hi=64:lo=64:frac=0");
    expect(after("-fps_mode")).toBe("passthrough");
    expect(after("-enc_time_base")).toBe("1:1000000");
    expect(after("-video_track_timescale")).toBe("1000000");
    expect(after("-bf")).toBe("0");
    expect(after("-g")).toBe("240");
    expect(after("-force_key_frames")).toContain("prev_forced_t+10");
    expect(args.at(-1)).toBe("/out/encoded.mp4");
    expect(decodeArgs("/in/video.mp4")).toContain("-xerror");
  });

  it("counts decoded frames only from a decoder that finished", () => {
    expect(decodedFrames("frame=10\nprogress=continue\nframe=86\nprogress=end\n")).toBe(86);
    expect(() => decodedFrames("frame=10\nprogress=continue\n")).toThrow();
  });

  it("turns MP4 samples back into the live stream's access units", async () => {
    const frames = Array.from({ length: 30 }, (_, i) => synthFrame(synth, i));
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat(), target });
    const source = new EncodedVideoPacketSource("avc");
    output.addVideoTrack(source, { frameRate: 30 });
    await output.start();
    for (const [i, frame] of frames.entries())
      await source.add(
        new EncodedPacket(frame.data, frame.key ? "key" : "delta", i / 30, 1 / 30),
        i === 0
          ? { decoderConfig: { codec: SYNTH_CODEC, codedWidth: 256, codedHeight: 160 } }
          : undefined,
      );
    await output.finalize();
    const input = new Input({
      formats: [MP4],
      source: new MediaBuffer(target.buffer as ArrayBuffer),
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      const config = await track?.getDecoderConfig();
      if (!track || !config?.description) throw new Error("no avcC");
      const avcC = parseAvcC(new Uint8Array(config.description as ArrayBuffer));
      expect(avcC.lengthSize).toBe(4);
      let i = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        const frame = frames[i++];
        expect(avccToAnnexB(packet.data, avcC, packet.type === "key")).toEqual(frame?.data);
      }
      expect(i).toBe(frames.length);
    } finally {
      input.dispose();
    }
    expect(() => parseAvcC(new Uint8Array([0, 1, 2]))).toThrow(RangeError);
    expect(() =>
      avccToAnnexB(new Uint8Array([0, 0, 0, 9, 1]), { lengthSize: 4, parameterSets: [] }, false),
    ).toThrow(RangeError);
  });
});
