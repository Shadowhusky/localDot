import { describe, expect, it } from "vitest";
import {
  BALL_FRAMES,
  BURST_AT,
  burstDrops,
  CLOSES_AT,
  dropsFor,
  POP_MS,
  rippleDelays,
  wornFrames,
} from "./pop.ts";

const numbers = (transform: unknown) =>
  [...String(transform).matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
const functions = (transform: unknown) =>
  [...String(transform).matchAll(/([a-zA-Z]+)\(/g)].map((match) => match[1]);
const ascending = (frames: Keyframe[]) => {
  const offsets = frames.map((frame) => frame.offset as number);
  expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  expect(offsets[0]).toBe(0);
  expect(offsets.at(-1)).toBe(1);
};

describe("the burst's timing", () => {
  it("finishes fast: the row can close while the drops fly, within half a second or so", () => {
    expect(POP_MS).toBeGreaterThanOrEqual(350);
    expect(POP_MS).toBeLessThanOrEqual(550);
    expect(CLOSES_AT).toBeGreaterThan(BURST_AT);
    expect(CLOSES_AT).toBeLessThan(POP_MS);
  });

  it("ripples down the list at a set pace, then tightens to end within a second", () => {
    expect(rippleDelays(0)).toEqual([]);
    expect(rippleDelays(1)).toEqual([0]);
    expect(rippleDelays(3)).toEqual([0, 55, 110]);
    for (const n of [2, 5, 8, 9, 20, 60]) {
      const delays = rippleDelays(n);
      expect(delays).toEqual([...delays].sort((a, b) => a - b));
      const last = delays.at(-1) as number;
      expect(last + POP_MS).toBeLessThanOrEqual(1000);
    }
  });

  it("gives each dot fewer drops the more there are, never none", () => {
    expect(dropsFor(1)).toBe(8);
    expect(dropsFor(4)).toBe(8);
    expect(dropsFor(20)).toBe(3);
    expect(dropsFor(200)).toBe(3);
    for (const n of [1, 5, 10, 20]) expect(n * dropsFor(n)).toBeLessThanOrEqual(60);
  });
});

describe("the ball", () => {
  it("squashes on its foot, stretches up, and is gone at the end", () => {
    ascending(BALL_FRAMES);
    const scale = (frame: Keyframe) => numbers(frame.transform).slice(1);
    const squash = BALL_FRAMES[1] as Keyframe;
    const stretch = BALL_FRAMES[2] as Keyframe;
    const [squashX, squashY] = scale(squash) as [number, number];
    expect(squashX).toBeGreaterThan(1);
    expect(squashY).toBeLessThan(1);
    // Its foot stays where it stood: (1 - y) of the way from its middle, a frame's 37.5% away.
    expect(numbers(squash.transform)[0]).toBeCloseTo((1 - squashY) * 37.5, 1);
    const [stretchX, stretchY] = scale(stretch) as [number, number];
    expect(stretchX).toBeLessThan(1);
    expect(stretchY).toBeGreaterThan(1);
    expect(BALL_FRAMES.at(-1)?.opacity).toBe(0);
  });

  it("only ever writes transform and opacity, which the compositor can run on its own", () => {
    const allowed = new Set(["offset", "easing", "transform", "opacity"]);
    const frames = [
      ...BALL_FRAMES,
      ...burstDrops("seed", 32, 8).flatMap((drop) => drop.frames),
      ...wornFrames("seed", "top-hat", 32),
      ...wornFrames("seed", "sunglasses", 32),
    ];
    for (const frame of frames)
      for (const key of Object.keys(frame)) expect(allowed.has(key), key).toBe(true);
  });
});

describe("the drops", () => {
  it("are the same for the same conversation, and differ between them", () => {
    expect(burstDrops("one", 32, 8)).toEqual(burstDrops("one", 32, 8));
    expect(burstDrops("one", 32, 8)).not.toEqual(burstDrops("two", 32, 8));
  });

  it("start at the middle, stay near the dot, fall and fade out", () => {
    for (const size of [32, 64, 72]) {
      const drops = burstDrops("seed", size, 8);
      expect(drops).toHaveLength(8);
      for (const drop of drops) {
        ascending(drop.frames);
        const at = drop.frames.map((frame) => numbers(frame.transform));
        expect((at[0] as number[])[0]).toBeCloseTo(0);
        expect((at[0] as number[])[1]).toBeCloseTo(0);
        for (const [x, y] of at as [number, number][])
          expect(Math.hypot(x, y)).toBeLessThanOrEqual(size * 1.7);
        expect(drop.frames.at(-1)?.opacity).toBe(0);
        expect(drop.frames[0]?.opacity).toBe(1);
        // A list of the same functions on every frame interpolates on the compositor.
        for (const frame of drop.frames)
          expect(functions(frame.transform)).toEqual(["translate", "rotate", "scale"]);
      }
    }
  });

  it("go all the way round, with a sparkle or two among them", () => {
    const drops = burstDrops("seed", 32, 8);
    const ends = drops.map((drop) => numbers(drop.frames.at(-1)?.transform));
    expect(ends.some(([x]) => (x as number) > 4)).toBe(true);
    expect(ends.some(([x]) => (x as number) < -4)).toBe(true);
    expect(drops.filter((drop) => drop.spark).length).toBe(2);
    expect(burstDrops("seed", 32, 3).filter((drop) => drop.spark).length).toBe(0);
  });

  it("stay big enough to see on the smallest dot", () => {
    for (const drop of burstDrops("seed", 24, 8)) expect(drop.size).toBeGreaterThanOrEqual(3);
  });
});

describe("what dot wears", () => {
  const riseOf = (frames: Keyframe[]) =>
    Math.min(...frames.map((frame) => (numbers(frame.transform)[1] as number) ?? 0));
  const fallOf = (frames: Keyframe[]) => numbers(frames.at(-1)?.transform)[1] as number;

  it("a hat is tossed up, hangs, and fades on its way back down", () => {
    const frames = wornFrames("seed", "top-hat", 64);
    ascending(frames);
    expect(riseOf(frames)).toBeLessThan(-0.5 * 64);
    expect(fallOf(frames)).toBeGreaterThan(riseOf(frames));
    expect(frames.at(-1)?.opacity).toBe(0);
    for (const frame of frames.slice(0, -1)) expect(frame.opacity).toBe(1);
  });

  it("clothes with nothing to hold them just fall", () => {
    const frames = wornFrames("seed", "suit", 64);
    ascending(frames);
    expect(riseOf(frames)).toBeGreaterThan(-0.1 * 64);
    expect(fallOf(frames)).toBeGreaterThan(0.3 * 64);
    expect(frames.at(-1)?.opacity).toBe(0);
  });

  it("rides the ball's squash until the burst", () => {
    for (const name of ["top-hat", "suit"] as const) {
      const frames = wornFrames("seed", name, 64);
      const free = frames[2] as Keyframe;
      expect(free.offset).toBeCloseTo(BURST_AT / POP_MS, 5);
      expect(frames[1]?.transform).toContain("scale(1.16, 0.8)");
      expect(free.transform).toContain("scale(0.9, 1.19)");
    }
  });
});
