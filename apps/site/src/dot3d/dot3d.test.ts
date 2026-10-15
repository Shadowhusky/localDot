import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { Dot3D } from "./dot3d.ts";

const seen = (dot: Dot3D, axis: Vector3) =>
  axis.clone().applyQuaternion(dot.head.getWorldQuaternion(new Quaternion()));

const height = (dot: Dot3D) => dot.head.getWorldPosition(new Vector3()).y;

describe("Dot3D on a clock of its own", () => {
  it("moves by the clock it is given, and replays the same after a restart", () => {
    let t = 1000;
    const dot = new Dot3D({ seed: 3, now: () => t });
    dot.hop();
    t = 1150;
    dot.update(100);
    dot.group.updateMatrixWorld(true);
    const during = height(dot);
    t = 1000;
    dot.restart();
    dot.hop();
    t = 1150;
    dot.update(100);
    dot.group.updateMatrixWorld(true);
    expect(height(dot)).toBeCloseTo(during, 9);
    t = 4000;
    dot.update(100);
    dot.group.updateMatrixWorld(true);
    expect(during).toBeGreaterThan(height(dot) + 0.01);
  });
});

describe("Dot3D", () => {
  it("brings no lights of its own when it never takes control", () => {
    const lights = (dot: Dot3D) => {
      let n = 0;
      dot.group.traverse((node) => {
        if ((node as { isLight?: boolean }).isLight) n++;
      });
      return n;
    };
    expect(lights(new Dot3D())).toBeGreaterThan(0);
    expect(lights(new Dot3D({ control: false }))).toBe(0);
  });

  it("turns on the turntable about its own tipped axis, its top still toward the camera", () => {
    const dot = new Dot3D({ reducedMotion: true });
    dot.tip = 0.1;
    for (const spin of [0, Math.PI / 2, Math.PI]) {
      dot.spin = spin;
      dot.update(100);
      dot.group.updateMatrixWorld(true);
      expect(seen(dot, new Vector3(0, 0, 1)).x).toBeCloseTo(Math.sin(spin), 6);
      const up = seen(dot, new Vector3(0, 1, 0));
      expect(up.x).toBeCloseTo(0, 6);
      expect(up.z).toBeCloseTo(Math.sin(0.1), 6);
    }
  });
});
