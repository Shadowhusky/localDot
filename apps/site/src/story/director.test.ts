import { describe, expect, it } from "vitest";
import { Director, layout } from "./director.ts";

const chapters = layout([
  ["app", 0.25],
  ["out", 1.5],
  ["watch", 2],
]);

describe("layout", () => {
  it("places each chapter after the one before it, in screens", () => {
    expect(chapters).toEqual([
      { name: "app", from: 0, to: 0.25 },
      { name: "out", from: 0.25, to: 1.75 },
      { name: "watch", from: 1.75, to: 3.75 },
    ]);
  });
});

describe("Director", () => {
  it("reads scroll as screens into the story, clamped to its length", () => {
    const d = new Director(chapters, { reduced: true });
    d.measure(100, 800);
    d.scroll(50);
    expect(d.raw).toBe(0);
    d.scroll(100 + 800);
    expect(d.raw).toBe(1);
    d.scroll(100 + 800 * 10);
    expect(d.raw).toBe(3.75);
    expect(d.screens).toBe(3.75);
  });

  it("gives each chapter 0 before it, 1 after it and its share in between", () => {
    const d = new Director(chapters, { reduced: true });
    d.measure(0, 1000);
    d.scroll(1000);
    expect(d.chapter("app")).toBe(1);
    expect(d.chapter("out")).toBeCloseTo(0.5);
    expect(d.chapter("watch")).toBe(0);
  });

  it("follows scroll smoothly, and at once when motion is reduced", () => {
    const smooth = new Director(chapters, { halfLifeMs: 100 });
    smooth.measure(0, 1000);
    smooth.scroll(2000);
    expect(smooth.at).toBe(0);
    smooth.update(100);
    expect(smooth.at).toBeCloseTo(1);
    expect(smooth.settled()).toBe(false);
    smooth.update(5000);
    expect(smooth.settled()).toBe(true);
    const reduced = new Director(chapters, { reduced: true });
    reduced.measure(0, 1000);
    reduced.scroll(2000);
    expect(reduced.at).toBe(2);
  });

  it("lands on a far scroll at once when snapped, without gliding through what lies between", () => {
    const d = new Director(chapters, { halfLifeMs: 100 });
    d.measure(0, 1000);
    d.scroll(3000);
    d.snap();
    expect(d.at).toBe(3);
    expect(d.settled()).toBe(true);
  });

  it("tells how far before or past a chapter the story is", () => {
    const d = new Director(chapters, { reduced: true });
    d.measure(0, 1000);
    d.scroll(0);
    expect(d.local("watch")).toBeCloseTo(-0.875);
    // The story ends at 3.75 screens: 3.5 screens past the start of "out", which lasts 1.5.
    d.scroll(4750);
    expect(d.local("out")).toBeCloseTo(3.5 / 1.5);
  });
});
