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
  it("defines blink, talk, turn and idle within 12 seconds, steps in time order", () => {
    for (const name of ["blink", "talk", "turn", "idle"] as const) {
      const clip = CLIPS[name];
      expect(clip.durationMs).toBeGreaterThan(0);
      expect(clip.durationMs).toBeLessThanOrEqual(12_000);
      const times = clip.steps.map((s) => s.atMs);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(times.every((t) => t >= 0 && t < clip.durationMs)).toBe(true);
    }
  });

  it("idles for 12 s: looks both ways, glances back at the user, drifts and blinks", () => {
    expect(CLIPS.idle.steps).toEqual([]);
    expect(CLIPS.idle.durationMs).toBe(12_000);
    const frames = play(CLIPS.idle);
    const eyeX = frames.map((p) => p.eyeX);
    expect(Math.min(...eyeX)).toBeLessThan(-0.4);
    expect(Math.max(...eyeX)).toBeGreaterThan(0.4);
    // Eyes held on the user for most of a second, after the opening look at them.
    const onUser = frames.map((p) => Math.abs(p.eyeX) < 0.02 && Math.abs(p.eyeY) < 0.02);
    const glance = onUser.findIndex(
      (_, i) => i > 2 * FPS && onUser.slice(i, i + 24).every(Boolean),
    );
    expect(glance).toBeGreaterThan(0);
    const range = (key: "headX" | "bodyX") =>
      Math.max(...frames.map((p) => p[key])) - Math.min(...frames.map((p) => p[key]));
    expect(range("headX")).toBeGreaterThan(0.3);
    expect(range("bodyX")).toBeGreaterThan(0.1);
    expect(frames.some((p) => p.eyeOpenL < 0.3)).toBe(true);
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
