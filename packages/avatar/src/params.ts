export type MouthShape = "A" | "I" | "U" | "E" | "O" | "N" | "rest";

export interface AvatarParams {
  headX: number;
  headY: number;
  // Positive tips the top of the head toward the viewer's right.
  headRoll?: number;
  bodyX: number;
  eyeOpenL: number;
  eyeOpenR: number;
  eyeX: number;
  eyeY: number;
  brow: number;
  mouthShape: MouthShape;
  mouthOpen: number;
  breath: number;
  blush: number;
  // A breeze on the hair physics; positive blows toward the viewer's right.
  wind?: number;
  expressions: Record<string, number>;
}

export const NEUTRAL_PARAMS: AvatarParams = {
  headX: 0,
  headY: 0,
  headRoll: 0,
  bodyX: 0,
  eyeOpenL: 1,
  eyeOpenR: 1,
  eyeX: 0,
  eyeY: 0,
  brow: 0,
  mouthShape: "rest",
  mouthOpen: 0,
  breath: 0,
  blush: 0,
  wind: 0,
  expressions: {},
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
// `|| 0` folds −0 into 0, so a channel at rest reads as a plain zero.
const signedUnit = (value: number, fallback: number) =>
  clamp(finiteOr(value, fallback), -1, 1) || 0;
const unit = (value: number, fallback: number) => clamp(finiteOr(value, fallback), 0, 1);

export function sanitizeParams(p: AvatarParams): AvatarParams {
  const n = NEUTRAL_PARAMS;
  const expressions: Record<string, number> = {};
  for (const [name, weight] of Object.entries(p.expressions)) {
    const w = unit(weight, 0);
    if (w > 0) expressions[name] = w;
  }
  return {
    headX: signedUnit(p.headX, n.headX),
    headY: signedUnit(p.headY, n.headY),
    headRoll: signedUnit(p.headRoll ?? 0, 0),
    bodyX: signedUnit(p.bodyX, n.bodyX),
    eyeOpenL: unit(p.eyeOpenL, n.eyeOpenL),
    eyeOpenR: unit(p.eyeOpenR, n.eyeOpenR),
    eyeX: signedUnit(p.eyeX, n.eyeX),
    eyeY: signedUnit(p.eyeY, n.eyeY),
    brow: signedUnit(p.brow, n.brow),
    mouthShape: p.mouthShape,
    mouthOpen: unit(p.mouthOpen, 0),
    breath: unit(p.breath, 0),
    blush: unit(p.blush, 0),
    wind: signedUnit(p.wind ?? 0, 0),
    expressions,
  };
}
