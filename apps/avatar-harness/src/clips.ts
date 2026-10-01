import type { AvatarController } from "@localdot/avatar";
import { sampleTrack } from "./samples.ts";

export type ClipName = "blink" | "talk" | "turn" | "idle";

export interface ClipStep {
  atMs: number;
  act: (controller: AvatarController, nowMs: number) => void;
}

export interface Clip {
  durationMs: number;
  seed: number;
  steps: ClipStep[];
}

const BEYOND_REACH = 10_000;

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
    // Points are head-relative (record.ts puts the head at the origin) and beyond the reach, so
    // the gaze clamps and the head turns through the controller's full range.
    steps: [
      { atMs: 0, act: (c) => c.setAttention({ x: -BEYOND_REACH, y: 0 }) },
      { atMs: 1200, act: (c) => c.setAttention({ x: BEYOND_REACH, y: 0 }) },
      { atMs: 2400, act: (c) => c.setAttention({ x: 0, y: -BEYOND_REACH }) },
      { atMs: 3600, act: (c) => c.setAttention({ x: 0, y: BEYOND_REACH }) },
    ],
  },
  // Nothing scripted: breathing, blinks, the gaze wander, the sway, roll and lean, and the breeze.
  // Seed 247 looks both ways, glances back at the user and tips the head both ways within 12 s.
  idle: { durationMs: 12_000, seed: 247, steps: [] },
};
