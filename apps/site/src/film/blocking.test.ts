import { describe, expect, it } from "vitest";
import { LAND, SWAP } from "../dot3d/jump.ts";
import { blockAt } from "./blocking.ts";
import { M } from "./cues.ts";

describe("blockAt", () => {
  it("drops dot in from above the frame onto its mark on the first landing", () => {
    expect(blockAt(0).spot.y).toBeLessThan(0);
    expect(blockAt(M.land).spot.y).toBeCloseTo(0.55, 6);
    expect(blockAt(M.land + 0.04).squash).toBeGreaterThan(0.1);
  });

  it("docks dot in the app while it works and frees it for the models", () => {
    expect(blockAt(M.watch).docked).toBe(1);
    expect(blockAt(M.models + 2).docked).toBe(0);
    expect(blockAt(M.share).docked).toBe(1);
  });

  it("changes outfit facing away, halfway round the turntable", () => {
    const away = 18.5 - LAND + SWAP;
    expect(blockAt(M.jobs).persona).toBe("everyday");
    expect(blockAt(away - 0.01).persona).toBe("everyday");
    expect(blockAt(away + 0.01).persona).toBe("coder");
    expect(blockAt(away).spin).toBeCloseTo(Math.PI, 1);
    expect(blockAt(22.6).persona).toBe("design");
    expect(blockAt(M.jobs).spin).toBe(0);
  });

  it("lands each new dot on its beat", () => {
    for (const at of [18.5, 19.5, 22.5]) {
      expect(blockAt(at - 0.2).spot.y).toBeLessThan(blockAt(at).spot.y - 0.01);
      expect(blockAt(at).spot.y).toBeCloseTo(0.5, 3);
    }
  });

  it("has the models gone before dot's first jump", () => {
    expect(blockAt(M.jobs - 0.3).ring.shown).toBe(0);
  });

  it("winds the line-up back to before it came by the replay", () => {
    const seen = blockAt(M.rewind + 0.1);
    const back = blockAt(M.rewind - 0.5);
    expect(seen.lineup.shown).toBeCloseTo(back.lineup.shown, 9);
    expect(seen.lineup.hops).toEqual(back.lineup.hops);
    expect(seen.spot.x).toBeCloseTo(back.spot.x, 9);
    expect(seen.spot.y).toBeCloseTo(back.spot.y, 9);
    expect(blockAt(M.replay - 1e-4).lineup.shown).toBeCloseTo(0, 2);
  });

  it("shrinks dot into the dock while the app arrives, not after", () => {
    expect(blockAt(M.screen + 0.4).docked).toBeGreaterThan(0.3);
    expect(blockAt(M.screen + 0.4).app.back).toBeGreaterThan(0);
    expect(blockAt(M.screen + 0.85).docked).toBe(1);
  });

  it("sends a wave along the line-up from the left before they all smile", () => {
    const peak = (i: number) => {
      let best = 0;
      let when = 0;
      for (let t = M.lineup; t < M.rewind; t += 0.005) {
        const lift = blockAt(t).lineup.hops[i]?.lift ?? 0;
        if (lift > best) [best, when] = [lift, t];
      }
      return when;
    };
    const peaks = [0, 1, 2, 3, 4, 5].map(peak);
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]).toBeGreaterThan(peaks[i - 1] as number);
    expect(peaks[5]).toBeLessThan(M.smile);
    expect(blockAt(M.smile + 0.3).lineup.hops.every((h) => h.lift === 0)).toBe(true);
  });

  it("swaps the app to the visitor's control between Take control and Hand back", () => {
    expect(blockAt(M.take - 0.01).app.yours).toBe(false);
    expect(blockAt(M.take + 0.01).app.yours).toBe(true);
    expect(blockAt(M.handBack + 0.01).app.yours).toBe(false);
  });
});
