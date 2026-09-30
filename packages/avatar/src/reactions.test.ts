import { describe, expect, it } from "vitest";
import { REACTIONS, ReactionMixer } from "./reactions.ts";

describe("ReactionMixer", () => {
  it("rises, holds and releases a reaction within its duration", () => {
    const mixer = new ReactionMixer();
    mixer.trigger("hmph", 0);
    expect(mixer.sample(0).expressions.annoyed ?? 0).toBe(0);
    expect(mixer.sample(300).expressions.annoyed).toBe(1);
    expect(mixer.sample(300).offsets.bodyX).toBeCloseTo(REACTIONS.hmph.offsets.bodyX ?? 0, 12);
    expect(mixer.sample(REACTIONS.hmph.durationMs + 1)).toEqual({ offsets: {}, expressions: {} });
  });

  it("allows at most one cheer every 5 s", () => {
    const mixer = new ReactionMixer();
    expect(mixer.trigger("cheer", 0)).toBe(true);
    expect(mixer.trigger("cheer", 4000)).toBe(false);
    expect(mixer.trigger("cheer", 5000)).toBe(true);
  });

  it("adds overlapping reactions together", () => {
    const mixer = new ReactionMixer();
    mixer.trigger("nod", 0);
    mixer.trigger("surprise", 0);
    const s = mixer.sample(120);
    expect(s.offsets.headY).toBeLessThan(0);
    expect(s.offsets.brow).toBeGreaterThan(0);
  });
});
