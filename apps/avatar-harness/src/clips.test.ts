import { describe, expect, it } from "vitest";
import { CLIPS } from "./clips.ts";

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
});
