import { describe, expect, it } from "vitest";
import { NEUTRAL_PARAMS } from "../params.ts";
import { eyePath, mascotGeometry } from "./geometry.ts";

describe("mascotGeometry", () => {
  it("centres a round body with two open eyes and no mouth at rest", () => {
    const g = mascotGeometry(NEUTRAL_PARAMS);
    expect(g.body.cx).toBe(50);
    expect(g.eyes).toHaveLength(2);
    expect(g.eyes[0].height).toBeCloseTo(12, 12);
    expect(g.mouth.visible).toBe(false);
  });

  it("slides the eyes toward the gaze and shortens them as they close", () => {
    const g = mascotGeometry({ ...NEUTRAL_PARAMS, eyeX: 1, eyeOpenL: 0 });
    expect(g.eyes[0].cx).toBeGreaterThan(mascotGeometry(NEUTRAL_PARAMS).eyes[0].cx);
    expect(g.eyes[0].height).toBeCloseTo(3, 12);
  });

  it("opens a mouth sized by the shape while speaking", () => {
    const a = mascotGeometry({ ...NEUTRAL_PARAMS, mouthShape: "A", mouthOpen: 1 });
    const i = mascotGeometry({ ...NEUTRAL_PARAMS, mouthShape: "I", mouthOpen: 1 });
    expect(a.mouth.visible).toBe(true);
    expect(a.mouth.ry).toBeGreaterThan(i.mouth.ry * 0.9);
    expect(i.mouth.rx).toBeGreaterThan(a.mouth.rx);
  });

  it("curves the eyes into a smile", () => {
    const g = mascotGeometry({ ...NEUTRAL_PARAMS, expressions: { smile: 1 } });
    expect(eyePath(g.eyes[0])).toContain("Q");
    expect(eyePath(mascotGeometry(NEUTRAL_PARAMS).eyes[0])).not.toContain("Q");
  });
});
