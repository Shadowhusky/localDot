import { describe, expect, it } from "vitest";
import { GazeWander, type Look } from "./wander.ts";

const isGlance = (look: Look) => look.x === 0 && look.y === 0;

const held = (looks: Look[]) =>
  looks.slice(0, -1).map((look, i) => ({ look, ms: (looks[i + 1] as Look).at - look.at }));

describe("GazeWander", () => {
  it("is deterministic for a seed", () => {
    expect(new GazeWander(7).looksUntil(60_000)).toEqual(new GazeWander(7).looksUntil(60_000));
    expect(new GazeWander(7).looksUntil(60_000)).not.toEqual(new GazeWander(8).looksUntil(60_000));
  });

  it("opens with a glance at the user", () => {
    expect(new GazeWander(3).looksUntil(0)).toEqual([{ at: 0, x: 0, y: 0 }]);
  });

  it("holds each look 2–5 s and each glance at the user 1–2 s", () => {
    const looks = new GazeWander(11).looksUntil(600_000);
    expect(looks.length).toBeGreaterThan(120);
    for (const { look, ms } of held(looks)) {
      const [min, max] = isGlance(look) ? [1000, 2000] : [2000, 5000];
      expect(ms).toBeGreaterThanOrEqual(min);
      expect(ms).toBeLessThanOrEqual(max);
    }
  });

  it("glances at the user about one look in four, never twice running", () => {
    const looks = new GazeWander(5).looksUntil(3_600_000);
    const share = looks.filter(isGlance).length / looks.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
    for (const [i, look] of looks.slice(1).entries()) {
      expect(isGlance(look) && isGlance(looks[i] as Look)).toBe(false);
    }
  });

  it("looks away within 60% of the reach across and 30% up or down, a visible shift each time", () => {
    const looks = new GazeWander(9).looksUntil(600_000);
    for (const [i, look] of looks.entries()) {
      expect(Math.abs(look.x)).toBeLessThanOrEqual(0.6);
      expect(Math.abs(look.y)).toBeLessThanOrEqual(0.3);
      if (!isGlance(look)) expect(Math.abs(look.x)).toBeGreaterThanOrEqual(0.25);
      if (i > 0) expect(Math.abs(look.x - (looks[i - 1] as Look).x)).toBeGreaterThanOrEqual(0.25);
    }
    const xs = looks.map((look) => look.x);
    expect(Math.min(...xs)).toBeLessThan(-0.5);
    expect(Math.max(...xs)).toBeGreaterThan(0.5);
  });

  it("gives the look in progress at any time", () => {
    const wander = new GazeWander(13);
    const looks = wander.looksUntil(30_000);
    expect(looks.length).toBeGreaterThan(5);
    for (const { look, ms } of held(looks)) {
      expect(wander.at(look.at)).toEqual({ x: look.x, y: look.y });
      expect(wander.at(look.at + ms - 1)).toEqual({ x: look.x, y: look.y });
    }
    expect(wander.at(-5)).toEqual({ x: 0, y: 0 });
    expect(wander.at(Number.NaN)).toEqual({ x: 0, y: 0 });
  });

  it("stays cheap ten hours into a session", () => {
    const wander = new GazeWander(5);
    const started = performance.now();
    const t = 10 * 3600 * 1000;
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const look = wander.at(t + i * 16);
      expect(Math.abs(look.x)).toBeLessThanOrEqual(0.6);
      seen.add(look.x);
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
