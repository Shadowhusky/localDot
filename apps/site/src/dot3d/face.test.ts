import type { EyePose } from "@app/dot/engine/engine.ts";
import { R } from "@app/dot/engine/sphere.ts";
import { eyeGeometry } from "@app/dot/render/eye-geometry.ts";
import { LOD_DETAIL } from "@app/dot/render/lod.ts";
import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { eyeUniforms, faceQuaternion, perspectiveTip, tippedFace, tippedHead } from "./face.ts";

const front = () => new Vector3(0, 0, 1);

describe("faceQuaternion", () => {
  it("turns the face right and down for a gaze right and down, as the app's eyes go", () => {
    const right = front().applyQuaternion(faceQuaternion(6, 0, 0));
    expect(right.x).toBeCloseTo(6 / R, 6);
    const down = front().applyQuaternion(faceQuaternion(0, 4, 0));
    expect(down.y).toBeCloseTo(-4 / R, 6);
  });

  it("rolls clockwise for a positive roll, as screen y points down", () => {
    const up = new Vector3(0, 1, 0).applyQuaternion(faceQuaternion(0, 0, 10));
    expect(up.x).toBeGreaterThan(0);
  });
});

describe("tippedFace", () => {
  it("keeps the face looking where it did while the head tips its top toward the camera", () => {
    const turn = faceQuaternion(6, -3, 0);
    const head = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.1);
    const seen = front().applyQuaternion(head.multiply(tippedFace(turn, 0.1)));
    const wanted = front().applyQuaternion(turn);
    expect(seen.distanceTo(wanted)).toBeLessThan(1e-9);
  });

  it("tips the head by the angle the camera's perspective takes off its top", () => {
    expect(perspectiveTip(0, 5)).toBe(0);
    expect(perspectiveTip(1, 10)).toBeCloseTo(Math.atan(0.1), 9);
  });
});

describe("tippedHead", () => {
  it("turns what the head wears as the face turns, keeping the head's tip", () => {
    const turn = faceQuaternion(6, -3, 0);
    const head = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.1);
    for (const axis of [front(), new Vector3(0, 1, 0)]) {
      const seen = axis.clone().applyQuaternion(head.clone().multiply(tippedHead(turn, 0.1)));
      const wanted = axis.clone().applyQuaternion(head).applyQuaternion(turn);
      expect(seen.distanceTo(wanted)).toBeLessThan(1e-9);
    }
  });
});

const pose = (over: Partial<EyePose>): EyePose => ({
  frame: { cx: 5.5, cy: -4.5, z: 1, a: 1, b: 0, c: 0, d: 1 },
  up: 0,
  lo: 0,
  loArch: 0,
  tilt: 0,
  scale: 1,
  sy: 1,
  happy: 0,
  closed: 0,
  opacity: 1,
  ...over,
});

describe("eyeUniforms", () => {
  it("shows the capsule when open and only the sleeping arc when closed", () => {
    const open = eyeUniforms(eyeGeometry(pose({}), LOD_DETAIL.hero, 4));
    expect(open.caps[2]).toBe(1);
    expect(open.arcs).toEqual([0, 0]);
    const shut = eyeUniforms(eyeGeometry(pose({ closed: 1 }), LOD_DETAIL.hero, 4));
    expect(shut.caps[2]).toBe(0);
    expect(shut.arcs[1]).toBe(1);
  });
});
