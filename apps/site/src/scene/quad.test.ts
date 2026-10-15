import { describe, expect, it } from "vitest";
import { applyMatrix3d, quadCss, quadMatrix } from "./quad.ts";

const W = 1000;
const H = 800;
const corners = (pts: [number, number][]) => pts;

describe("quadMatrix", () => {
  it("maps an element's corners onto any four screen points", () => {
    const quad = corners([
      [120, 80],
      [860, 140],
      [820, 700],
      [150, 640],
    ]);
    const m = quadMatrix(W, H, quad);
    const source: [number, number][] = [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ];
    source.forEach(([x, y], i) => {
      const [sx, sy] = applyMatrix3d(m, x, y);
      expect(sx).toBeCloseTo(quad[i]?.[0] ?? 0, 6);
      expect(sy).toBeCloseTo(quad[i]?.[1] ?? 0, 6);
    });
  });
});

describe("quadCss", () => {
  it("is no transform at all while the element fills its own box, so its text stays sharp", () => {
    expect(
      quadCss(W, H, [
        [0.2, -0.1],
        [W, 0.3],
        [W - 0.2, H],
        [0, H + 0.4],
      ]),
    ).toBe("none");
  });

  it("is a matrix3d once the element has moved", () => {
    expect(
      quadCss(W, H, [
        [100, 50],
        [600, 50],
        [600, 450],
        [100, 450],
      ]),
    ).toMatch(/^matrix3d\(/);
  });
});
