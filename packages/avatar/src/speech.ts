import { clamp, type MouthShape } from "./params.ts";

export interface Viseme {
  t: number;
  shape: MouthShape;
}

export interface SpeechTrack {
  lang: "zh" | "en" | "ja";
  startsAt: number;
  visemes: Viseme[];
  envelope?: Float32Array;
  envelopeRateHz?: number;
}

export interface Mouth {
  shape: MouthShape;
  open: number;
}

export const MOUTH_FPS = 12;
export const MOUTH_STEP_MS = 1000 / MOUTH_FPS;
export const MOUTH_LEAD_MS = 150;
export const MOUTH_TAIL_MS = 400;
const PRE_OPEN = 0.3;
const ENVELOPE_FLOOR = 0.3;

export const SHAPE_OPENNESS: Record<MouthShape, number> = {
  A: 1,
  O: 0.8,
  E: 0.6,
  U: 0.45,
  I: 0.35,
  N: 0.1,
  rest: 0,
};

const REST: Mouth = { shape: "rest", open: 0 };

export function prepareTrack(track: SpeechTrack): SpeechTrack {
  const visemes = track.visemes.filter((v) => Number.isFinite(v.t)).sort((a, b) => a.t - b.t);
  return { ...track, visemes };
}

export function mouthAt(track: SpeechTrack | null, tMs: number): Mouth {
  const first = track?.visemes[0];
  const last = track?.visemes[track.visemes.length - 1];
  if (!track || !first || !last || !Number.isFinite(track.startsAt)) return { ...REST };
  const rel = tMs - track.startsAt;
  if (rel < first.t - MOUTH_LEAD_MS) return { ...REST };
  if (rel < first.t) {
    const progress = 1 - (first.t - rel) / MOUTH_LEAD_MS;
    return { shape: first.shape, open: SHAPE_OPENNESS[first.shape] * PRE_OPEN * progress };
  }
  // A track that forgot its closing "rest" must not leave the mouth hanging open.
  if (last.shape !== "rest" && rel > last.t + MOUTH_TAIL_MS) return { ...REST };
  // Integer frame index first, so 500 ms lands exactly on frame 6 instead of 499.99….
  const quantized = Math.max((Math.floor((rel * MOUTH_FPS) / 1000) * 1000) / MOUTH_FPS, first.t);
  const current = latestAtOrBefore(track.visemes, quantized) ?? first;
  return { shape: current.shape, open: SHAPE_OPENNESS[current.shape] * envelopeScale(track, rel) };
}

export function speechSpan(track: SpeechTrack | null): { from: number; to: number } | null {
  const first = track?.visemes[0];
  const last = track?.visemes[track.visemes.length - 1];
  if (!track || !first || !last || !Number.isFinite(track.startsAt)) return null;
  return {
    from: track.startsAt + first.t - MOUTH_LEAD_MS,
    to: track.startsAt + last.t + (last.shape === "rest" ? 0 : MOUTH_TAIL_MS),
  };
}

function latestAtOrBefore(visemes: Viseme[], t: number): Viseme | undefined {
  let found: Viseme | undefined;
  for (const v of visemes) {
    if (v.t > t) break;
    found = v;
  }
  return found;
}

function envelopeScale(track: SpeechTrack, relMs: number): number {
  if (!track.envelope || !track.envelopeRateHz) return 1;
  const index = Math.floor((relMs / 1000) * track.envelopeRateHz);
  const level = clamp(track.envelope[index] ?? 0, 0, 1);
  return ENVELOPE_FLOOR + (1 - ENVELOPE_FLOOR) * level;
}
