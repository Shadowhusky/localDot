import { describe, expect, it } from "vitest";
import { playMsAt, REPLAY_SPEEDS, retime } from "./clock.ts";
import {
  buildPlaybackMap,
  idleAt,
  mergeSpans,
  playAt,
  playDuration,
  sessionAt,
} from "./playback-map.ts";

describe("playback time", () => {
  it("plays at real time when idle is not skipped", () => {
    const m = buildPlaybackMap(0, 10000, [{ from: 1000, to: 2000 }], false);
    expect(playDuration(m)).toBe(10000);
    for (const t of [0, 999, 1500, 9999, 10000]) expect(sessionAt(m, playAt(m, t))).toBe(t);
    expect(idleAt(m, 3000)).toBe(false);
  });
  it("compresses long quiet stretches to 400 ms and keeps shorter ones", () => {
    const m = buildPlaybackMap(
      0,
      20000,
      [
        { from: 0, to: 1000 },
        { from: 2000, to: 3000 },
        { from: 13000, to: 14000 },
      ],
      true,
    );
    expect(playDuration(m)).toBe(4800);
    expect(playAt(m, 13000)).toBe(3400);
    expect(sessionAt(m, 3200)).toBe(8000);
    expect(idleAt(m, 8000)).toBe(true);
    expect(idleAt(m, 1500)).toBe(false);
    expect(idleAt(m, 13000)).toBe(false);
  });
  it("is monotonic and round-trips inside 200 irregular busy stretches", () => {
    const busy = Array.from({ length: 200 }, (_, i) => ({
      from: i * 3100 + 100,
      to: i * 3100 + 1000 + i,
    }));
    const m = buildPlaybackMap(0, 620000, busy, true);
    let last = 0;
    for (let p = 0; p <= playDuration(m); p += 37) {
      const t = sessionAt(m, p);
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
    for (const b of busy) expect(sessionAt(m, playAt(m, b.from + 1))).toBeCloseTo(b.from + 1, 8);
  });
  it("clips, sorts and merges touching spans without mutating its input", () => {
    const spans = [
      { from: 90, to: 120 },
      { from: -5, to: 10 },
      { from: 10, to: 20 },
      { from: 30, to: 30 },
      { from: 15, to: 17 },
    ];
    const copy = structuredClone(spans);
    expect(mergeSpans(spans, 0, 100)).toEqual([
      { from: 0, to: 20 },
      { from: 90, to: 100 },
    ]);
    expect(spans).toEqual(copy);
  });
  it("handles empty recordings, clips outside times and marks only in-range idle", () => {
    const e = buildPlaybackMap(123, 123, [], true);
    expect(playDuration(e)).toBe(0);
    expect(sessionAt(e, 99)).toBe(123);
    expect(playAt(e, 999)).toBe(0);
    const m = buildPlaybackMap(100, 3100, [], true);
    expect(playDuration(m)).toBe(400);
    expect(sessionAt(m, -1)).toBe(100);
    expect(sessionAt(m, 401)).toBe(3100);
    expect(playAt(m, 0)).toBe(0);
    expect(playAt(m, 4000)).toBe(400);
    expect(idleAt(m, 99)).toBe(false);
    expect(idleAt(m, 3100)).toBe(false);
    expect(idleAt(m, 100)).toBe(true);
  });
  it("refuses reversed or nonfinite ranges and keeps exactly threshold-sized gaps", () => {
    for (const [a, b] of [
      [2, 1],
      [Number.NaN, 1],
      [0, Number.POSITIVE_INFINITY],
    ] as [number, number][])
      expect(() => buildPlaybackMap(a, b, [], true)).toThrow(RangeError);
    expect(playDuration(buildPlaybackMap(0, 1499, [], true))).toBe(1499);
    expect(playDuration(buildPlaybackMap(0, 1500, [], true))).toBe(400);
  });
  it("advances by wall time times speed without jumps on speed change, pause or seek", () => {
    const c = { playing: true, speed: 1 as const, anchorWallMs: 100, anchorPlayMs: 300 };
    expect(REPLAY_SPEEDS).toEqual([0.5, 1, 2, 4, 8]);
    expect(playMsAt(c, 200)).toBe(400);
    const fast = retime(c, 200, { speed: 8 });
    expect(playMsAt(fast, 200)).toBe(400);
    expect(playMsAt(fast, 300)).toBe(1200);
    const paused = retime(fast, 300, { playing: false });
    expect(playMsAt(paused, 900)).toBe(1200);
    const seek = retime(paused, 900, { anchorPlayMs: 200, playing: true, speed: 0.5 });
    expect(playMsAt(seek, 900)).toBe(200);
    expect(playMsAt(seek, 1100)).toBe(300);
  });
});
