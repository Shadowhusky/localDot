import type { AvatarController } from "@localdot/avatar";
import { sampleTrack } from "./samples.ts";

export type ClipName = "blink" | "talk" | "turn";

export interface ClipStep {
  atMs: number;
  act: (controller: AvatarController, nowMs: number) => void;
}

export interface Clip {
  durationMs: number;
  seed: number;
  steps: ClipStep[];
}

// Blinks come every 2–6 s, so 7 s of idle always holds at least one.
export const CLIPS: Record<ClipName, Clip> = {
  blink: { durationMs: 7000, seed: 3, steps: [] },
  talk: {
    durationMs: 3600,
    seed: 5,
    steps: [0, 1200, 2400].map((atMs) => ({ atMs, act: (c, now) => c.speak(sampleTrack(now)) })),
  },
  turn: {
    durationMs: 4800,
    seed: 9,
    steps: [
      { atMs: 0, act: (c) => c.setAttention({ x: -400, y: 0 }) },
      { atMs: 1200, act: (c) => c.setAttention({ x: 400, y: 0 }) },
      { atMs: 2400, act: (c) => c.setAttention({ x: 0, y: -400 }) },
      { atMs: 3600, act: (c) => c.setAttention({ x: 0, y: 400 }) },
    ],
  },
};
