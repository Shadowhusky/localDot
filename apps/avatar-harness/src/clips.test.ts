import {
  AvatarController,
  type AvatarParams,
  DEFAULT_GAZE_LIMITS,
  HEAD_SHARE,
} from "@localdot/avatar";
import { describe, expect, it } from "vitest";
import { CLIPS, type Clip } from "./clips.ts";

const FPS = 30;
const FULL_TURN = HEAD_SHARE * DEFAULT_GAZE_LIMITS.head;

// Plays a clip the way record.ts does: head at the origin, 700 px reach, one frame per tick.
function play(clip: Clip, reducedMotion = false): AvatarParams[] {
  let now = 0;
  const controller = new AvatarController(
    { seed: clip.seed, headCenter: { x: 0, y: 0 }, reach: 700, reducedMotion },
    () => now,
  );
  const pending = [...clip.steps];
  const frames: AvatarParams[] = [];
  for (let frame = 0; (frame * 1000) / FPS < clip.durationMs; frame++) {
    now = (frame * 1000) / FPS;
    while (pending[0] && pending[0].atMs <= now) pending.shift()?.act(controller, now);
    frames.push(controller.frame());
  }
  return frames;
}

describe("CLIPS", () => {
  it("defines blink, talk and turn within 8 seconds, steps in time order", () => {
    for (const name of ["blink", "talk", "turn"] as const) {
      const clip = CLIPS[name];
      expect(clip.durationMs).toBeGreaterThan(0);
      expect(clip.durationMs).toBeLessThanOrEqual(8000);
      const times = clip.steps.map((s) => s.atMs);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(times.every((t) => t >= 0 && t < clip.durationMs)).toBe(true);
    }
  });

  it("turns the head across the controller's full range both ways", () => {
    // Reduced motion removes the sway and leaves the gaze alone.
    const frames = play(CLIPS.turn, true);
    for (const axis of ["headX", "headY"] as const) {
      const values = frames.map((p) => p[axis]);
      expect(Math.min(...values)).toBeLessThanOrEqual(-(FULL_TURN - 0.005));
      expect(Math.max(...values)).toBeGreaterThanOrEqual(FULL_TURN - 0.005);
    }
  });
});
