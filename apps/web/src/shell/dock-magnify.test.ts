import { describe, expect, it } from "vitest";
import {
  falloff,
  lens,
  MAX_SCALE,
  NAME_ROWS,
  nameOpacity,
  REACH_ROWS,
  type Span,
  spread,
} from "./dock-magnify.ts";

// The collapsed rail's marks: 36 px tall, 2 px apart, under a 32 px group label.
const MARK = 36;
const REACH = REACH_ROWS * MARK;
const marks = (count: number, first = 32): Span[] =>
  Array.from({ length: count }, (_, n) => ({
    top: first + n * (MARK + 2),
    bottom: first + n * (MARK + 2) + MARK,
  }));
const middle = (span: Span) => (span.top + span.bottom) / 2;
const placed = (spans: readonly Span[], look: ReturnType<typeof lens>) =>
  spans.map((span, n) => {
    const { scale = 1, offset = 0 } = look.spans[n] ?? {};
    const half = ((span.bottom - span.top) * scale) / 2;
    return { top: middle(span) + offset - half, bottom: middle(span) + offset + half };
  });

describe("the falloff", () => {
  it("is whole under the pointer, half at half its reach and nothing from its reach on", () => {
    expect(falloff(0, REACH)).toBe(1);
    expect(falloff(REACH / 2, REACH)).toBeCloseTo(0.5);
    expect(falloff(-REACH / 2, REACH)).toBeCloseTo(0.5);
    expect(falloff(REACH, REACH)).toBe(0);
    expect(falloff(REACH * 2, REACH)).toBe(0);
  });

  it("falls steadily, with no corner at the pointer or at its reach", () => {
    const step = REACH / 100;
    for (let d = 0; d < REACH; d += step)
      expect(falloff(d + step, REACH)).toBeLessThanOrEqual(falloff(d, REACH));
    expect(1 - falloff(step, REACH)).toBeLessThan(0.001);
    expect(falloff(REACH - step, REACH)).toBeLessThan(0.001);
  });

  it("sums to the room the growth takes: half the reach on each side", () => {
    expect(spread(0, REACH)).toBe(0);
    expect(spread(REACH, REACH)).toBeCloseTo(REACH / 2);
    expect(spread(-REACH * 3, REACH)).toBeCloseTo(-REACH / 2);
    const d = REACH / 3;
    const slope = (spread(d + 0.01, REACH) - spread(d - 0.01, REACH)) / 0.02;
    expect(slope).toBeCloseTo(falloff(d, REACH), 4);
  });
});

describe("the lens", () => {
  const view = { top: 0, bottom: 800 };

  it("leaves the rail as it is until it eases in", () => {
    const spans = marks(7);
    const look = lens(spans, middle(spans[3] as Span), 0, view, REACH);
    expect(look.spans.every((span) => span.scale === 1 && span.offset === 0)).toBe(true);
    expect(look.focus).toBe(middle(spans[3] as Span));
  });

  it("grows the mark under the pointer most and its neighbours less, the further the less", () => {
    const spans = marks(15, 32);
    const pointer = middle(spans[7] as Span);
    const room = { top: -1000, bottom: 2000 };
    const scales = lens(spans, pointer, 1, room, REACH).spans.map((span) => span.scale);
    expect(scales[7]).toBeGreaterThan(MAX_SCALE - 0.05);
    expect(scales[7]).toBeLessThanOrEqual(MAX_SCALE);
    for (let n = 7; n < 14; n++) {
      expect(scales[n + 1]).toBeLessThanOrEqual(scales[n] as number);
      expect(scales[14 - n - 1]).toBeCloseTo(scales[n + 1] as number, 4);
    }
    expect(scales[2]).toBe(1);
    expect(scales[12]).toBe(1);
  });

  it("parts the marks so none overlaps, and keeps the one under the pointer under it", () => {
    const spans = marks(15);
    for (let pointer = 40; pointer < 600; pointer += 7) {
      const look = lens(spans, pointer, 1, { top: 0, bottom: 2000 }, REACH);
      const shown = placed(spans, look);
      for (let n = 1; n < shown.length; n++)
        expect(shown[n]?.top).toBeGreaterThanOrEqual((shown[n - 1]?.bottom ?? 0) - 1e-6);
      const under = spans.findIndex((span) => span.top <= look.focus && look.focus < span.bottom);
      if (under === -1) continue;
      expect(shown[under]?.top).toBeLessThanOrEqual(pointer + 1e-6);
      expect(shown[under]?.bottom).toBeGreaterThan(pointer);
    }
  });

  it("keeps a short list wholly in view, growing it into the room below", () => {
    const spans = marks(7);
    const room = { top: 0, bottom: 700 };
    for (const n of [0, 3, 6]) {
      const shown = placed(spans, lens(spans, middle(spans[n] as Span), 1, room, REACH));
      expect(shown[0]?.top).toBeGreaterThanOrEqual(-1e-6);
      expect(shown.at(-1)?.bottom).toBeLessThanOrEqual(700 + 1e-6);
    }
  });

  // A long list scrolled half way, and the list in short windows: its first label and seven marks
  // in 232 px, then in 192.
  const scrolling = [
    { spans: marks(40, 0), room: { top: 380, bottom: 760 } },
    { spans: marks(7), room: { top: 0, bottom: 232 } },
    { spans: marks(7), room: { top: 0, bottom: 192 } },
  ];

  it("keeps the grown marks in view at the ends of a list that scrolls", () => {
    for (const { spans, room } of scrolling.slice(0, 2)) {
      const inView = spans.filter((span) => span.top >= room.top && span.bottom <= room.bottom);
      for (const span of [inView[0], inView.at(-1)] as Span[]) {
        const look = lens(spans, middle(span), 1, room, REACH);
        const shown = placed(spans, look);
        const n = spans.indexOf(span);
        expect(look.spans[n]?.scale).toBeGreaterThan(1.5);
        expect(shown[n]?.top).toBeGreaterThanOrEqual(room.top - 1e-6);
        expect(shown[n]?.bottom).toBeLessThanOrEqual(room.bottom + 1e-6);
      }
    }
  });

  it("moves the marks smoothly as the pointer moves", () => {
    for (const { spans, room } of scrolling) {
      let was = lens(spans, room.top, 1, room, REACH);
      for (let pointer = room.top + 1; pointer < room.bottom; pointer++) {
        const look = lens(spans, pointer, 1, room, REACH);
        const moved = look.spans.map((span, n) =>
          Math.abs(span.offset - (was.spans[n]?.offset ?? 0)),
        );
        expect(Math.max(...moved)).toBeLessThan(4);
        was = look;
      }
    }
  });
});

describe("the names", () => {
  const reach = NAME_ROWS * MARK;
  const spans = marks(7);
  const on = middle(spans[3] as Span);

  it("show whole beside the mark under the pointer and fade with each mark further", () => {
    const shown = spans.map((span) => nameOpacity(span, on, reach));
    expect(shown[3]).toBe(1);
    expect(shown[2]).toBeCloseTo(shown[4] as number);
    expect(shown[2]).toBeLessThan(1);
    expect(shown[1]).toBeLessThan(shown[2] as number);
    expect(shown[0]).toBe(0);
    expect(shown[6]).toBe(0);
  });
});
