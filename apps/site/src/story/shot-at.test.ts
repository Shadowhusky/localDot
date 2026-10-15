import { describe, expect, it } from "vitest";
import { layout } from "./director.ts";
import { shotAt } from "./shot-at.ts";
import type { Shot } from "./shots.ts";

const chapters = layout([
  ["out", 2],
  ["watch", 2],
]);
const base = { target: [0, 0, 0] as const, screen: 1 };
const shots: Shot[] = [
  {
    ...base,
    chapter: "out",
    at: 0.5,
    camera: [0, 0, 10],
    dot: { x: 0.5, y: 0.5, r: 0.1, depth: 0.5 },
  },
  {
    ...base,
    chapter: "watch",
    at: 0.5,
    camera: [4, 0, 10],
    dot: { x: 0.1, y: 0.5, r: 0.2, depth: 0.5 },
  },
];

describe("shotAt", () => {
  it("holds the first shot before it and the last after it", () => {
    expect(shotAt(shots, chapters, 0).camera.x).toBe(0);
    expect(shotAt(shots, chapters, 3.9).camera.x).toBe(4);
  });

  it("eases between two shots at their places in the story", () => {
    // The shots sit at 1 and 3 screens; halfway between is halfway, eased in and out.
    const half = shotAt(shots, chapters, 2);
    expect(half.camera.x).toBeCloseTo(2);
    expect(half.dot.r).toBeCloseTo(0.15);
    expect(shotAt(shots, chapters, 1.5).camera.x).toBeLessThan(1);
  });
});
