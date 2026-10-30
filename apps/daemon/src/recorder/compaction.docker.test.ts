import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyManifest, RECORDING_DIR, RECORDING_VIDEO, ulid } from "@localdot/protocol";
import { EncodedPacketSink, Input, MP4, StreamSource } from "mediabunny";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerClient } from "../cells/docker.ts";
import { DOCKER_TESTS } from "../cells/testing/docker-cli.ts";
import { findDockerSocket } from "../doctor-socket.ts";
import { avcCodecString, isRandomAccess } from "./annexb.ts";
import { compactTrack } from "./compaction.ts";
import { DockerTrackEncoder } from "./compactor.ts";
import { readManifest, writeManifest } from "./manifest.ts";
import { readFragments } from "./recover.ts";
import { openRecordingView } from "./view.ts";
import { RecordingWriter } from "./writer.ts";

const IMAGE = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
const START = 1_234_567;
const FRAME = 33_333;
const FRAMES = 180;
// Frames 60–149 repeat frame 59: a still screen in the middle of six seconds of motion.
const STILL = { first: 60, last: 149 };
let root = "";

// Splits an Annex B stream at its access unit delimiters.
function accessUnits(stream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 4 < stream.length; i++)
    if (
      stream[i] === 0 &&
      stream[i + 1] === 0 &&
      stream[i + 2] === 1 &&
      ((stream[i + 3] ?? 0) & 0x1f) === 9
    )
      starts.push(i > 0 && stream[i - 1] === 0 ? i - 1 : i);
  return starts.map((start, n) => stream.subarray(start, starts[n + 1] ?? stream.length));
}

// ffmpeg from the desktop image over the test's folder; its log is the result.
function ffmpeg(...args: string[]): string {
  const run = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${root}:/work`,
      "--entrypoint",
      "ffmpeg",
      IMAGE,
    ].concat(["-hide_banner", "-nostdin", ...args]),
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`ffmpeg exited ${run.status}: ${run.stderr}`);
  return run.stderr;
}

describe.skipIf(!DOCKER_TESTS)("compacting a real recording in the helper container", () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "localdot-compaction-docker-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("re-encodes it smaller at the same times, and it seeks and decodes like the original", async () => {
    // The live stream's kind of H.264: Constrained Baseline at a high rate, a key frame every two
    // seconds, and the repeated frames a still screen sends.
    ffmpeg(
      "-loglevel",
      "error",
      "-filter_complex",
      `testsrc2=size=1280x800:rate=30:duration=${FRAMES / 30},split[a][b];[a][b]freezeframes=first=${STILL.first}:last=${STILL.last}:replace=${STILL.first - 1}`,
      "-c:v",
      "libx264",
      "-profile:v",
      "baseline",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-g",
      "60",
      "-b:v",
      "8M",
      "-pix_fmt",
      "yuv420p",
      "-bsf:v",
      "h264_metadata=aud=insert",
      "-f",
      "h264",
      "/work/clip.h264",
    );
    const units = accessUnits(new Uint8Array(readFileSync(join(root, "clip.h264"))));
    expect(units).toHaveLength(FRAMES);
    const codec = avcCodecString(units[0] as Uint8Array);
    if (!codec) throw new Error("the clip has no SPS");
    const dir = join(root, "sessions", ulid(), RECORDING_DIR);
    mkdirSync(dir, { recursive: true });
    const writer = new RecordingWriter({ dir, codec, width: 1280, height: 800 });
    await writer.start();
    const times = units.map((_, i) => START + i * FRAME);
    for (const [i, unit] of units.entries())
      await writer.push({ tMicros: times[i] as number, key: isRandomAccess(unit), data: unit });
    const end = START + FRAMES * FRAME;
    await writer.finish(end);
    writer.close();
    const source = {
      ...emptyManifest("complete"),
      codec,
      width: 1280,
      height: 800,
      firstMicros: START,
      lastMicros: times.at(-1) as number,
      bytes: statSync(join(dir, RECORDING_VIDEO)).size,
      fragments: writer.entries.length,
      finalized: true,
    };
    writeManifest(dir, source);
    copyFileSync(join(dir, RECORDING_VIDEO), join(root, "original.mp4"));

    const encoder = new DockerTrackEncoder(new DockerClient(findDockerSocket().path), IMAGE, root);
    const result = await compactTrack(dir, encoder, new AbortController().signal, 1);
    expect(result.outcome).toBe("compacted");
    const read = readManifest(dir);
    if (!read?.ok) throw new Error("unreadable manifest");
    const size = statSync(join(dir, RECORDING_VIDEO)).size;
    expect(read.manifest).toMatchObject({
      state: "complete",
      finalized: true,
      bytes: size,
      firstMicros: START,
      lastMicros: source.lastMicros,
      fragments: readFragments(dir).length,
      compacted: { sourceBytes: source.bytes },
    });
    expect(read.manifest.codec).toMatch(/^avc1\.64/);
    expect(size).toBeLessThan(source.bytes / 4);

    // Replay's reader over the daemon's byte ranges: each moment shows the original's frame then,
    // with a key frame to decode it from, and the still stretch is one held frame.
    const kept: number[] = [];
    const view = openRecordingView(dir, { complete: true });
    const input = new Input({
      formats: [MP4],
      source: new StreamSource({ getSize: () => view.size, read: (s, e) => view.read(s, e) }),
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("no track");
      expect(await track.getCodecParameterString()).toBe(read.manifest.codec);
      const sink = new EncodedPacketSink(track);
      for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true }))
        kept.push(packet.microsecondTimestamp);
      expect(kept[0]).toBe(START);
      expect(kept.every((t) => times.includes(t))).toBe(true);
      const stillFrom = times[STILL.first] as number;
      const stillTo = times[STILL.last] as number;
      // The stream's own refinements and key frames of the still picture stay; its repeats go.
      expect(kept.filter((t) => t >= stillFrom && t <= stillTo).length).toBeLessThanOrEqual(10);
      const last = await sink.getPacket(Number.POSITIVE_INFINITY);
      expect((last?.microsecondTimestamp ?? 0) + (last?.microsecondDuration ?? 0)).toBe(end);
      for (const t of [START, times[30], times[STILL.first + 40], times[FRAMES - 10], end - 1]) {
        const at = t as number;
        const shown = await sink.getPacket(at / 1e6);
        const key = await sink.getKeyPacket(at / 1e6);
        expect(shown?.microsecondTimestamp).toBe(kept.findLast((k) => k <= at));
        expect(key?.type).toBe("key");
        expect(key?.microsecondTimestamp).toBeLessThanOrEqual(shown?.microsecondTimestamp ?? 0);
      }
    } finally {
      input.dispose();
      view.close();
    }

    // ffmpeg seeks both files to frames the compacted one kept: in motion, in the still stretch
    // and near the end. Both decode the same picture there.
    const track = dir.slice(root.length);
    const stillKept = kept.find((t) => t >= (times[STILL.first] as number)) as number;
    for (const t of [kept[15], stillKept, kept.at(-10)]) {
      const seconds = (((t as number) - START) / 1e6).toFixed(6);
      const log = ffmpeg(
        "-ss",
        seconds,
        "-i",
        "/work/original.mp4",
        "-ss",
        seconds,
        "-i",
        `/work${track}/${RECORDING_VIDEO}`,
        "-lavfi",
        "[0:v][1:v]ssim",
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      );
      const ssim = Number(/All:([0-9.]+)/.exec(log)?.[1]);
      expect(ssim).toBeGreaterThan(0.95);
    }
  });
});
