import { R } from "@app/dot/engine/sphere.ts";
import type { EyeGeometry } from "@app/dot/render/eye-geometry.ts";
import { Quaternion, Vector3 } from "three";

const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);
const clampAsin = (v: number) => Math.asin(Math.min(0.9, Math.max(-0.9, v)));

// The app's face turn (apps/web/src/dot/engine/sphere.ts eyeFrame): yaw, then pitch, then roll, in
// its frame where y points down. Here y points up, so pitch keeps its sign on the x axis and roll
// turns the other way about z.
export function faceQuaternion(gx: number, gy: number, rollDeg: number): Quaternion {
  const yaw = new Quaternion().setFromAxisAngle(Y, clampAsin(gx / R));
  const pitch = new Quaternion().setFromAxisAngle(X, clampAsin(gy / R));
  const roll = new Quaternion().setFromAxisAngle(Z, (-rollDeg * Math.PI) / 180);
  return roll.multiply(pitch).multiply(yaw);
}

// The plates' camera is orthographic, so it sees a hat's top as far down as the face. A perspective
// camera this close looks up at what sits on dot's head by about this angle; tipping the head's top
// toward the camera by it shows hats as the plates do.
export function perspectiveTip(radius: number, distance: number): number {
  return Math.atan(radius / distance);
}

// The face's turn inside a head tipped forward by `tip`, so it still looks where `turn` does.
export function tippedFace(turn: Quaternion, tip: number): Quaternion {
  return new Quaternion().setFromAxisAngle(X, -tip).multiply(turn);
}

// One eye's shape for the body's shader, in the eye's own frame units (y down), as eyeGeometry
// gives it to the app's SVG.
export interface EyeUniformValues {
  // Half width, half height, how much of the capsule shows, and the eye's opacity.
  caps: [number, number, number, number];
  // The lids: their half width, the upper lid's and the lower lid's heights, and the upper's slope.
  lidA: [number, number, number, number];
  // The upper lid's dip and the lower lid's arch.
  lidB: [number, number];
  happy: [number, number, number, number];
  closed: [number, number, number, number];
  // How much the happy and the sleeping arcs show.
  arcs: [number, number];
  gloss: [number, number, number, number];
  glossAlpha: number;
}

export function eyeUniforms(g: EyeGeometry): EyeUniformValues {
  return {
    caps: [g.hw, g.hh, g.capsule, g.opacity],
    lidA: [g.lid.W, g.lid.top, g.lid.bottom, g.lid.slope],
    lidB: [g.lid.dip, g.lid.arch],
    happy: [g.happy.aw, g.happy.y, g.happy.peak, g.happy.stroke],
    closed: [g.closed.aw, g.closed.y, g.closed.peak, g.closed.stroke],
    arcs: [g.happy.opacity, g.closed.opacity],
    gloss: g.gloss ? [g.gloss.cx, g.gloss.cy, g.gloss.rx, g.gloss.ry] : [0, 0, 1, 1],
    glossAlpha: g.gloss?.opacity ?? 0,
  };
}
