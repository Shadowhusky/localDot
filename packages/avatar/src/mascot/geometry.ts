import type { AvatarParams, MouthShape } from "../params.ts";

export interface MascotEye {
  cx: number;
  cy: number;
  height: number;
  smile: number;
}

export interface MascotGeometry {
  body: { cx: number; cy: number; rx: number; ry: number };
  tiltDeg: number;
  eyes: [MascotEye, MascotEye];
  mouth: { cx: number; cy: number; rx: number; ry: number; visible: boolean };
  blushOpacity: number;
}

const MOUTH_WIDTH: Record<MouthShape, number> = {
  A: 1,
  E: 1.1,
  I: 1.25,
  O: 0.6,
  U: 0.5,
  N: 0.8,
  rest: 0.8,
};
const EYE_MIN = 3;
const EYE_RANGE = 9;

export function mascotGeometry(p: AvatarParams): MascotGeometry {
  const smile = p.expressions.smile ?? 0;
  const breathe = 1 + 0.025 * p.breath;
  const shiftX = p.eyeX * 7 + p.headX * 6;
  const shiftY = -p.eyeY * 5 - p.headY * 4;
  const eyeY = 44 + shiftY;
  const eyeHeight = (open: number) => (EYE_MIN + EYE_RANGE * open) * (1 - 0.5 * smile);
  return {
    body: { cx: 50 + p.bodyX * 4 + p.headX * 3, cy: 54 - p.headY * 3, rx: 30, ry: 30 * breathe },
    tiltDeg: p.headX * 6 + p.bodyX * 4,
    eyes: [
      { cx: 42 + shiftX, cy: eyeY, height: eyeHeight(p.eyeOpenL), smile },
      { cx: 58 + shiftX, cy: eyeY, height: eyeHeight(p.eyeOpenR), smile },
    ],
    mouth: {
      cx: 50 + shiftX * 0.7,
      cy: 62 + shiftY * 0.6,
      rx: 3 * MOUTH_WIDTH[p.mouthShape],
      ry: 0.6 + 5 * p.mouthOpen,
      visible: p.mouthOpen > 0.02,
    },
    blushOpacity: p.blush * 0.6,
  };
}

export function eyePath(eye: MascotEye): string {
  if (eye.smile > 0.5) {
    const w = 4;
    return `M ${eye.cx - w} ${eye.cy + 1.5} Q ${eye.cx} ${eye.cy - 3} ${eye.cx + w} ${eye.cy + 1.5}`;
  }
  const half = eye.height / 2;
  return `M ${eye.cx} ${eye.cy - half} L ${eye.cx} ${eye.cy + half}`;
}
