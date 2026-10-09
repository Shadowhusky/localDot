import { describe, expect, it } from "vitest";
import { type Box, Flight } from "./flight.ts";

const HERO: Box = { x: 420, y: 217, size: 224 };
const DOCK: Box = { x: 8, y: 716, size: 96 };
const FRAME = 1000 / 60;

function path(flight: Flight, from: number, to: number) {
  const frames: (Box & { settled: boolean; t: number })[] = [];
  for (let t = from; t <= to; t += FRAME) frames.push({ ...flight.at(t), t });
  return frames;
}

const progress = (a: number, b: number, v: number) => (v - a) / (b - a);

describe("dot's flight between places", () => {
  it("settles in its seat within 0.8 s and never jumps further than most of its ball", () => {
    const flight = new Flight(HERO);
    flight.fly(DOCK, 0);
    const frames = path(flight, 0, 1200);
    const landed = frames.find((f) => f.settled);
    expect(landed?.t).toBeLessThan(800);
    expect(landed).toMatchObject(DOCK);
    for (let i = 1; i < frames.length; i++) {
      const [a, b] = [frames[i - 1], frames[i]] as [Box, Box];
      const step = Math.hypot(b.x - a.x, b.y - a.y);
      expect(step).toBeLessThanOrEqual(0.75 * 0.75 * Math.min(a.size, b.size));
    }
  });

  it("drops first on the way down and retraces the curve on the way up", () => {
    const down = new Flight(HERO);
    down.fly(DOCK, 0);
    const d = down.at(150);
    expect(progress(HERO.y, DOCK.y, d.y)).toBeGreaterThan(progress(HERO.x, DOCK.x, d.x) + 0.1);
    const up = new Flight(DOCK);
    up.fly(HERO, 0);
    const u = up.at(150);
    expect(progress(DOCK.x, HERO.x, u.x)).toBeGreaterThan(progress(DOCK.y, HERO.y, u.y) + 0.1);
  });

  it("turns back mid-flight from where it is drawn, without a jump", () => {
    const flight = new Flight(HERO);
    flight.fly(DOCK, 0);
    const before = flight.at(200);
    flight.fly(HERO, 200);
    const after = flight.at(200 + FRAME);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(40);
    expect(path(flight, 200, 1400).at(-1)).toMatchObject({ ...HERO, settled: true });
  });

  it("grows out of the badge before it travels", () => {
    const badge: Box = { x: 300, y: 60, size: 32 };
    const flight = new Flight(badge);
    flight.fly(DOCK, 0, true);
    const early = flight.at(100);
    expect(early.x).toBe(badge.x);
    expect(early.y).toBe(badge.y);
    expect(early.size).toBeGreaterThan(40);
    expect(flight.at(300).y).toBeGreaterThan(badge.y + 50);
  });

  it("keeps its velocity through a change of place, so the turn has no corner", () => {
    const flight = new Flight(HERO);
    flight.fly(DOCK, 0);
    const T = 180;
    const v = (a: Box, b: Box, dt: number) => ({ x: (b.x - a.x) / dt, y: (b.y - a.y) / dt });
    const dt = 0.01;
    const before = v(flight.at(T - dt), flight.at(T), dt);
    flight.fly({ x: 900, y: 100, size: 120 }, T);
    const after = v(flight.at(T), flight.at(T + dt), dt);
    expect(Math.hypot(before.x, before.y)).toBeGreaterThan(0.5);
    expect(Math.abs(after.x - before.x)).toBeLessThan(0.01);
    expect(Math.abs(after.y - before.y)).toBeLessThan(0.01);
  });

  it("keeps its curve when its seat shifts mid-flight", () => {
    const plain = new Flight(HERO);
    plain.fly(DOCK, 0);
    const shifted = new Flight(HERO);
    shifted.fly(DOCK, 0);
    shifted.follow({ ...DOCK, y: DOCK.y + 2 }, 200);
    for (const t of [250, 320, 400]) {
      expect(Math.abs(shifted.at(t).x - plain.at(t).x), `x at ${t}`).toBeLessThan(1);
      expect(Math.abs(shifted.at(t).y - plain.at(t).y), `y at ${t}`).toBeLessThan(3);
    }
  });

  it("reads its path without changing it, so the path can be drawn ahead", () => {
    const badge: Box = { x: 300, y: 60, size: 32 };
    const ahead = new Flight(badge);
    const fresh = new Flight(badge);
    ahead.fly(DOCK, 0, true);
    fresh.fly(DOCK, 0, true);
    for (let t = 0; t <= 1200; t += FRAME) ahead.at(t);
    ahead.fly(HERO, 60);
    fresh.fly(HERO, 60);
    for (const t of [60, 200, 400, 900]) expect(ahead.at(t)).toEqual(fresh.at(t));
  });

  it("follows a place that moves under it", () => {
    const flight = new Flight(DOCK);
    flight.follow({ ...DOCK, y: DOCK.y + 30 }, 0);
    expect(flight.at(1000)).toMatchObject({ y: DOCK.y + 30, settled: true });
  });
});
