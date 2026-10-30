import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { emptyManifest, RECORDING_VIDEO, type RecordingManifest } from "@localdot/protocol";
import { SYNTH_CODEC, synthFrame } from "@localdot/stage/testing";
import { writeManifest } from "../manifest.ts";
import { RecordingWriter } from "../writer.ts";

export const TRACK_SYNTH = { widthMbs: 16, heightMbs: 10, keyEvery: 12 };

// A finished, finalized recording of synthetic frames at the given session times.
export async function writeFinishedTrack(
  dir: string,
  times: readonly number[],
  end: number,
): Promise<RecordingManifest> {
  mkdirSync(dir, { recursive: true });
  const writer = new RecordingWriter({ dir, codec: SYNTH_CODEC, width: 256, height: 160 });
  await writer.start();
  for (const [i, t] of times.entries()) {
    const frame = synthFrame(TRACK_SYNTH, i);
    await writer.push({ tMicros: t, key: frame.key, data: frame.data });
  }
  await writer.finish(end);
  writer.close();
  const manifest: RecordingManifest = {
    ...emptyManifest("complete"),
    codec: SYNTH_CODEC,
    width: 256,
    height: 160,
    firstMicros: times[0] ?? null,
    lastMicros: times.at(-1) ?? null,
    bytes: statSync(join(dir, RECORDING_VIDEO)).size,
    fragments: writer.entries.length,
    finalized: true,
  };
  writeManifest(dir, manifest);
  return manifest;
}

// Bursts of frames separated by still stretches, starting well after session time 0.
export function burstTimes(n: number, start = 2_345_678): number[] {
  const t: number[] = [];
  let at = start;
  for (let i = 0; i < n; i++) {
    t.push(at);
    at += i % 30 === 29 ? 4_000_000 + i * 11 : 16_000 + ((i * 7919) % 1500);
  }
  return t;
}
