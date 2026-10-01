import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOUTH_FPS, MOUTH_STEP_MS, mouthAt, type Viseme } from "@localdot/avatar";
import { describe, expect, it } from "vitest";
import { FULL_SCALE_RMS } from "./envelope.ts";
import { buildTrack, type ChunkTiming, START_LEAD_S } from "./player.ts";

interface Fixture {
  lang: "zh" | "en" | "ja";
  samples: number;
  sample_rate: number;
  rms: number[];
  visemes: Viseme[];
}

const DIR = fileURLToPath(new URL("../../../apps/voiced/tests/fixtures/lipsync/", import.meta.url));
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();
const CHUNK = 7680;
const START_S = 10;
const LATENCY_MS = 50;

// Plays a recorded sentence the way voiced streams it and the player schedules it: 0.32 s chunks
// back to back, the first START_LEAD_S after it arrives.
function trackOf(fixture: Fixture) {
  const chunks: ChunkTiming[] = [];
  for (let sample = 0; sample < fixture.samples; sample += CHUNK) {
    chunks.push({
      sample,
      samples: Math.min(CHUNK, fixture.samples - sample),
      at: START_S + START_LEAD_S + sample / fixture.sample_rate,
    });
  }
  const levels = fixture.rms.map((r) => Math.min(1, r / FULL_SCALE_RMS));
  const sentence = {
    id: 1,
    lang: fixture.lang,
    chunks,
    levels,
    visemes: fixture.visemes,
    samples: fixture.samples,
    ended: true,
  };
  const track = buildTrack([sentence], (t) => t * 1000 + LATENCY_MS);
  if (!track) throw new Error("no track");
  return track;
}

describe("lip-sync against recorded voiced output", () => {
  it("has the six recorded sentences", () => {
    expect(FILES).toEqual([
      "en-1.json",
      "en-2.json",
      "ja-1.json",
      "ja-2.json",
      "zh-1.json",
      "zh-2.json",
    ]);
  });

  for (const file of FILES) {
    it(`${file}: every mouth change lands within one anime frame of its aligner onset`, () => {
      const fixture = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Fixture;
      const track = trackOf(fixture);
      const onsets = fixture.visemes.map((v) => ({ at: track.startsAt + v.t, shape: v.shape }));
      const first = onsets[0];
      const last = onsets.at(-1);
      if (!first || !last) throw new Error("empty fixture");
      const changes: { at: number; shape: string }[] = [];
      let previous = mouthAt(track, first.at).shape;
      for (let t = first.at; t <= last.at + 500; t++) {
        const shape = mouthAt(track, t).shape;
        if (shape !== previous) changes.push({ at: t, shape });
        previous = shape;
      }
      // The mouth steps on a 12 fps grid counted from the track's start.
      const frameOf = (at: number) =>
        track.startsAt +
        (Math.floor(((at - track.startsAt) * MOUTH_FPS) / 1000) * 1000) / MOUTH_FPS;
      for (const change of changes) {
        const frame = frameOf(change.at);
        const source = onsets.filter((o) => o.at <= frame + 1e-6).at(-1);
        expect(source?.shape).toBe(change.shape);
        expect(frame - (source?.at ?? Number.NEGATIVE_INFINITY)).toBeLessThan(MOUTH_STEP_MS);
      }
      // A shape that lasts past the next frame boundary is on screen from that boundary.
      onsets.forEach((onset, i) => {
        const nextFrame = frameOf(onset.at - 1e-6) + MOUTH_STEP_MS;
        const next = onsets[i + 1];
        if (!next || next.at <= nextFrame + 0.5) return;
        expect(mouthAt(track, nextFrame + 0.5).shape).toBe(onset.shape);
      });
    });
  }
});
