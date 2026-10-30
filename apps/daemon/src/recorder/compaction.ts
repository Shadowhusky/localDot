import * as nodeFs from "node:fs";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BROWSER_RECORDING_DIR,
  RECORDING_DIR,
  RECORDING_FRAGMENTS,
  RECORDING_JOURNAL,
  RECORDING_MANIFEST,
  RECORDING_VIDEO,
  RecordingManifest,
  ULID_PATTERN,
} from "@localdot/protocol";
import { EncodedPacketSink, FilePathSource, Input, MP4 } from "mediabunny";
import { z } from "zod";
import { avccToAnnexB, parseAvcC } from "./annexb.ts";
import { readManifest, writeManifest } from "./manifest.ts";
import { hasFinalMfra, readFragments } from "./recover.ts";
import { type RecordingFs, RecordingWriter } from "./writer.ts";

// A finished track's staging folder. Without READY in it, it is scrap; with READY, the verified
// files in it replace the track's own.
export const COMPACTION_DIR = ".compact";
export const ENCODED = "encoded.mp4";
const READY = "ready.json";
const Ready = z.object({
  sourceBytes: z.number().int().positive(),
  bytes: z.number().int().positive(),
});

// Tracks smaller than this are left alone, and a re-encode must save at least a tenth.
export const MIN_SOURCE_BYTES = 8 * 1024 ** 2;
export const MAX_KEPT_RATIO = 0.9;
// A key frame comes at least this often while the screen changes, so a drag of the timeline (which
// shows key frames) stays close to the picture. Still stretches carry no frames and no key frames.
export const KEY_SECONDS = 10;
// The most frames an exact seek decodes from its key frame.
export const KEY_FRAMES = 240;
const SEEK_SAMPLES = 128;

export class CompactionRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CompactionRejected";
  }
}

// The re-encode, run by ffmpeg in a helper container: H.264 High (or High 4:4:4 for a full-colour
// stream) with still-image tuning and no B-frames, at the source's size and timestamps.
export function encodeArgs(input: string, output: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-xerror",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map_metadata",
    "-1",
    // A frame goes only when no 8×8 block differs from the last kept one by more than one level a
    // pixel on average: a repeat of the screen, never a change to it.
    "-vf",
    "mpdecimate=hi=64:lo=64:frac=0",
    "-fps_mode",
    "passthrough",
    "-enc_time_base",
    "1:1000000",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-tune",
    "stillimage",
    "-crf",
    "26",
    "-bf",
    "0",
    "-g",
    String(KEY_FRAMES),
    "-force_key_frames",
    `expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+${KEY_SECONDS}))`,
    "-threads",
    "1",
    "-video_track_timescale",
    "1000000",
    "-f",
    "mp4",
    output,
  ];
}

// Decodes every frame and reports how many, failing on the first decoding error.
export function decodeArgs(input: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-xerror",
    "-err_detect",
    "explode",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-f",
    "null",
    "-",
  ];
}

export function decodedFrames(progress: string): number {
  const frames = [...progress.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1];
  if (frames === undefined || !progress.includes("progress=end"))
    throw new Error("the decoder did not finish");
  return Number(frames);
}

export interface TrackEncoder {
  // Writes the re-encoded video to <outDir>/encoded.mp4.
  encode(video: string, outDir: string, signal: AbortSignal): Promise<void>;
  // Decodes all of a video and resolves with its frame count.
  decode(video: string, signal: AbortSignal): Promise<number>;
}

export interface TrackSource {
  manifest: RecordingManifest;
  size: number;
  ino: number;
  mtimeMs: number;
}

// A finished, finalized and untouched track that is big enough to be worth re-encoding.
export function compactionSource(dir: string, minBytes = MIN_SOURCE_BYTES): TrackSource | null {
  const video = statSync(join(dir, RECORDING_VIDEO), { throwIfNoEntry: false });
  if (!video?.isFile() || video.size < minBytes) return null;
  const read = readManifest(dir);
  if (!read?.ok) return null;
  const m = read.manifest;
  if (
    video.size !== m.bytes ||
    !["complete", "recovered"].includes(m.state) ||
    !m.finalized ||
    m.compacted ||
    !m.codec ||
    !m.width ||
    !m.height ||
    m.firstMicros === null ||
    existsSync(join(dir, RECORDING_JOURNAL)) ||
    existsSync(join(dir, COMPACTION_DIR, READY))
  )
    return null;
  return { manifest: m, size: video.size, ino: video.ino, mtimeMs: video.mtimeMs };
}

// Whether the track is still exactly what the compaction read, so nothing changed it meanwhile.
function unchanged(dir: string, source: TrackSource): boolean {
  const read = readManifest(dir);
  const video = statSync(join(dir, RECORDING_VIDEO), { throwIfNoEntry: false });
  return (
    !!read?.ok &&
    JSON.stringify(read.manifest) === JSON.stringify(source.manifest) &&
    video?.ino === source.ino &&
    video.size === source.size &&
    video.mtimeMs === source.mtimeMs
  );
}

interface Timeline {
  times: number[];
  end: number;
}

async function timelineOf(video: string): Promise<Timeline> {
  const input = new Input({ formats: [MP4], source: new FilePathSource(video) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new CompactionRejected("the recording has no video track");
    const times: number[] = [];
    let end = 0;
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, {
      metadataOnly: true,
    })) {
      if (packet.microsecondTimestamp <= (times.at(-1) ?? -1))
        throw new CompactionRejected("the recording's frames are out of order");
      times.push(packet.microsecondTimestamp);
      end = packet.microsecondTimestamp + packet.microsecondDuration;
    }
    return { times, end };
  } finally {
    input.dispose();
  }
}

function includes(sorted: readonly number[], value: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = sorted[mid] as number;
    if (at === value) return true;
    if (at < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

interface Kept {
  t: number;
  key: boolean;
}

// The writer makes its folder's parents; a task deleted meanwhile must stay deleted.
const inPlace: RecordingFs = {
  ...nodeFs,
  mkdirSync: (path: nodeFs.PathLike) => {
    nodeFs.mkdirSync(path);
    return undefined;
  },
};

// The encoder's output as a recording of its own: the same fragmented layout, index and session
// timestamps the recorder writes, from the same writer. Every frame must be one of the source's.
async function remux(
  work: string,
  source: TrackSource,
  timeline: Timeline,
): Promise<{ codec: string; kept: Kept[] }> {
  const input = new Input({ formats: [MP4], source: new FilePathSource(join(work, ENCODED)) });
  let writer: RecordingWriter | undefined;
  try {
    const track = await input.getPrimaryVideoTrack();
    const config = await track?.getDecoderConfig();
    if (track?.codec !== "avc" || !config?.description)
      throw new CompactionRejected("the re-encode is not H.264");
    const codec = config.codec;
    if (
      !/^avc1\.[0-9a-f]{6}$/.test(codec) ||
      track.codedWidth !== source.manifest.width ||
      track.codedHeight !== source.manifest.height
    )
      throw new CompactionRejected("the re-encode changed the picture format");
    const description = config.description;
    const avcC = parseAvcC(
      ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description),
    );
    writer = new RecordingWriter({
      dir: work,
      codec,
      width: source.manifest.width as number,
      height: source.manifest.height as number,
      fs: inPlace,
    });
    await writer.start();
    const first = timeline.times[0] as number;
    const kept: Kept[] = [];
    let offset: number | null = null;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      offset ??= first - packet.microsecondTimestamp;
      const t = packet.microsecondTimestamp + offset;
      const key = packet.type === "key";
      if (
        !includes(timeline.times, t) ||
        (kept.length === 0 && !key) ||
        t <= (kept.at(-1)?.t ?? -1)
      )
        throw new CompactionRejected("the re-encode moved a frame");
      await writer.push({ tMicros: t, key, data: avccToAnnexB(packet.data, avcC, key) });
      kept.push({ t, key });
    }
    if (!kept.length) throw new CompactionRejected("the re-encode has no frames");
    await writer.finish(timeline.end);
    return { codec, kept };
  } finally {
    writer?.close();
    input.dispose();
  }
}

// Replay's own questions of the staged file: for any time, the frame on screen then and the key
// frame to decode it from; and where the video starts and ends.
async function checkSeeks(video: string, kept: readonly Kept[], end: number): Promise<void> {
  const input = new Input({ formats: [MP4], source: new FilePathSource(video) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new CompactionRejected("the staged video has no track");
    const sink = new EncodedPacketSink(track);
    const fail = () => new CompactionRejected("the staged video does not seek like the original");
    const first = kept[0] as Kept;
    const last = await sink.getPacket(Number.POSITIVE_INFINITY, { metadataOnly: true });
    if (
      (await sink.getPacket((first.t - 1) / 1e6, { metadataOnly: true })) !== null ||
      !last ||
      last.microsecondTimestamp !== kept.at(-1)?.t ||
      Math.abs(last.microsecondTimestamp + last.microsecondDuration - end) > 1000
    )
      throw fail();
    const step = Math.max(1, Math.floor(kept.length / SEEK_SAMPLES));
    let key = first.t;
    for (let i = 0; i < kept.length; i++) {
      const frame = kept[i] as Kept;
      if (frame.key) key = frame.t;
      if (i % step !== 0 && i !== kept.length - 1) continue;
      const next = kept[i + 1]?.t ?? end;
      for (const q of new Set([frame.t, Math.floor((frame.t + next) / 2), next - 1])) {
        const packet = await sink.getPacket(q / 1e6, { metadataOnly: true });
        const keyPacket = await sink.getKeyPacket(q / 1e6, { metadataOnly: true });
        if (packet?.microsecondTimestamp !== frame.t || keyPacket?.microsecondTimestamp !== key)
          throw fail();
      }
    }
  } finally {
    input.dispose();
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readReady(work: string): z.infer<typeof Ready> | null {
  try {
    return Ready.parse(JSON.parse(readFileSync(join(work, READY), "utf8")));
  } catch {
    return null;
  }
}

// Each rename replaces one file whole, and a reader holding the old video keeps reading it.
function finishSwap(dir: string): void {
  const work = join(dir, COMPACTION_DIR);
  for (const name of [RECORDING_FRAGMENTS, RECORDING_VIDEO, RECORDING_MANIFEST])
    if (existsSync(join(work, name))) renameSync(join(work, name), join(dir, name));
  syncPath(dir);
  rmSync(work, { recursive: true, force: true });
}

// Synchronous from the last check to the swap, so no task, deletion or retention sweep can run in
// between. READY is the commit point: from there a restart finishes the swap.
function swap(dir: string, source: TrackSource, codec: string): boolean {
  if (!unchanged(dir, source)) return false;
  const work = join(dir, COMPACTION_DIR);
  const bytes = statSync(join(work, RECORDING_VIDEO)).size;
  const manifest = RecordingManifest.parse({
    ...source.manifest,
    codec,
    bytes,
    fragments: readFragments(work).length,
    compacted: { sourceBytes: source.size },
  });
  writeFileSync(join(work, RECORDING_MANIFEST), `${JSON.stringify(manifest)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  for (const name of [RECORDING_VIDEO, RECORDING_FRAGMENTS, RECORDING_MANIFEST])
    syncPath(join(work, name));
  const temp = join(work, `${READY}.tmp`);
  writeFileSync(temp, `${JSON.stringify({ sourceBytes: source.size, bytes })}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  syncPath(temp);
  renameSync(temp, join(work, READY));
  syncPath(work);
  finishSwap(dir);
  return true;
}

// The original stays: recorded as considered so it is not tried again.
function keep(dir: string, source: TrackSource): boolean {
  if (!unchanged(dir, source)) return false;
  writeManifest(dir, { ...source.manifest, compacted: { sourceBytes: source.size } });
  rmSync(join(dir, COMPACTION_DIR), { recursive: true, force: true });
  return true;
}

export type CompactionResult =
  | { outcome: "compacted"; sourceBytes: number; bytes: number }
  | { outcome: "kept"; reason: string }
  | { outcome: "changed" };

// Re-encodes one finished track and swaps it in only once the result decodes, starts and ends
// where the original does and seeks like it. Anything short of that keeps the original.
export async function compactTrack(
  dir: string,
  encoder: TrackEncoder,
  signal: AbortSignal,
  minBytes = MIN_SOURCE_BYTES,
): Promise<CompactionResult> {
  const source = compactionSource(dir, minBytes);
  if (!source) return { outcome: "changed" };
  const work = join(dir, COMPACTION_DIR);
  rmSync(work, { recursive: true, force: true });
  nodeFs.mkdirSync(work, { mode: 0o700 });
  try {
    const timeline = await timelineOf(join(dir, RECORDING_VIDEO));
    if (!timeline.times.length || timeline.times[0] !== source.manifest.firstMicros)
      throw new CompactionRejected("the recording's frames do not match its manifest");
    signal.throwIfAborted();
    await encoder.encode(join(dir, RECORDING_VIDEO), work, signal);
    signal.throwIfAborted();
    const { codec, kept } = await remux(work, source, timeline);
    rmSync(join(work, ENCODED));
    const video = join(work, RECORDING_VIDEO);
    const entries = readFragments(work);
    if (!entries.length || !hasFinalMfra(video, entries.at(-1)?.endOffset ?? 0))
      throw new CompactionRejected("the staged video has no complete index");
    await checkSeeks(video, kept, timeline.end);
    if ((await encoder.decode(video, signal)) !== kept.length)
      throw new CompactionRejected("the staged video does not decode whole");
    signal.throwIfAborted();
    const bytes = statSync(video).size;
    if (bytes > source.size * MAX_KEPT_RATIO)
      return keep(dir, source)
        ? { outcome: "kept", reason: "the re-encode saved too little" }
        : { outcome: "changed" };
    return swap(dir, source, codec)
      ? { outcome: "compacted", sourceBytes: source.size, bytes }
      : { outcome: "changed" };
  } catch (error) {
    if (error instanceof CompactionRejected && !signal.aborted)
      return keep(dir, source)
        ? { outcome: "kept", reason: error.message }
        : { outcome: "changed" };
    throw error;
  } finally {
    if (!existsSync(join(work, READY))) rmSync(work, { recursive: true, force: true });
  }
}

// After a restart: finish a swap that passed its commit point, and drop any other staging.
export function resumeCompaction(dir: string): void {
  const work = join(dir, COMPACTION_DIR);
  if (!existsSync(work)) return;
  const ready = readReady(work);
  const read = readManifest(dir);
  if (ready && read?.ok && read.manifest.state !== "expired") {
    const staged = statSync(join(work, RECORDING_VIDEO), { throwIfNoEntry: false })?.size;
    const current = statSync(join(dir, RECORDING_VIDEO), { throwIfNoEntry: false })?.size;
    const manifestStaged = existsSync(join(work, RECORDING_MANIFEST));
    if (
      (staged ?? current) === ready.bytes &&
      (manifestStaged || read.manifest.compacted?.sourceBytes === ready.sourceBytes)
    ) {
      finishSwap(dir);
      return;
    }
  }
  rmSync(work, { recursive: true, force: true });
}

export function resumeCompactions(home: string): void {
  let ids: string[];
  try {
    ids = readdirSync(join(home, "sessions")).filter((id) => ULID_PATTERN.test(id));
  } catch {
    return;
  }
  for (const id of ids)
    for (const name of [RECORDING_DIR, BROWSER_RECORDING_DIR]) {
      try {
        resumeCompaction(join(home, "sessions", id, name));
      } catch {
        console.error(`recording ${id} could not finish its compaction`);
      }
    }
}
