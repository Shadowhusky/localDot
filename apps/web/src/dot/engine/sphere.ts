import { clamp } from "./math.ts";

// The face lives in a 64-unit frame: a sphere of radius R centred at (32, 32).
export const R = 24;
export const EYE_ANCHORS = [
  [-5.5, -4.5],
  [5.5, -4.5],
] as const;
// The furthest the eyes travel across the face, in frame units.
export const GAZE_MAX = { x: 7, y: 5 } as const;

export interface EyeFrame {
  // Decal centre relative to the body centre, and its depth (1 faces the viewer).
  cx: number;
  cy: number;
  z: number;
  // The Jacobian mapping the eye's local units to screen units: matrix(a b c d cx cy).
  a: number;
  b: number;
  c: number;
  d: number;
}

type Vec3 = [number, number, number];

// An eye is a decal on the sphere: gaze turns the sphere (yaw, pitch, roll) and the decal is
// projected along the view axis. At rest this matches the flat face exactly; a turn foreshortens
// the far eye with no special case.
export function eyeFrame(
  anchor: readonly [number, number],
  gx: number,
  gy: number,
  rollDeg: number,
): EyeFrame {
  const yaw = Math.asin(clamp(gx / R, -0.9, 0.9));
  const pitch = Math.asin(clamp(gy / R, -0.9, 0.9));
  const roll = (rollDeg * Math.PI) / 180;
  const [cy, sy] = [Math.cos(yaw), Math.sin(yaw)];
  const [cp, sp] = [Math.cos(pitch), Math.sin(pitch)];
  const [cr, sr] = [Math.cos(roll), Math.sin(roll)];
  const rotate = ([x0, y0, z0]: Vec3): Vec3 => {
    const x1 = x0 * cy + z0 * sy;
    const z1 = -x0 * sy + z0 * cy;
    const y2 = y0 * cp + z1 * sp;
    const z2 = -y0 * sp + z1 * cp;
    return [x1 * cr - y2 * sr, x1 * sr + y2 * cr, z2];
  };
  const x0 = anchor[0] / R;
  const y0 = anchor[1] / R;
  const z0 = Math.sqrt(1 - x0 * x0 - y0 * y0);
  const p = rotate([x0, y0, z0]);
  const u = rotate([1, 0, -x0 / z0]);
  const v = rotate([0, 1, -y0 / z0]);
  return { cx: p[0] * R, cy: p[1] * R, z: p[2], a: u[0], b: u[1], c: v[0], d: v[1] };
}
