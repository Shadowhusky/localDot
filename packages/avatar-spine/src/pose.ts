import type { AvatarParams } from "@localdot/avatar";
import type { SpineRigBinding } from "./binding.ts";

export interface BoneOffset {
  x?: number;
  y?: number;
  rotation?: number;
  scaleY?: number;
}

export interface RigPose {
  sliders: Record<string, number>;
  bones: Record<string, BoneOffset>;
  attachments: Record<string, string | null>;
  alpha: Record<string, number>;
  wind?: number;
}

export type EyeState = "open" | "half" | "closed" | "smile";

export const EYE_COMPOSITES = ["half", "closed", "smile"] as const;
export const MOUTH_VARIANTS = ["A", "I", "U", "E", "O", "N", "smile"] as const;
const EXPRESSION_ON = 0.5;
const EYE_HALF_AT = 0.66;
const EYE_CLOSED_AT = 0.25;
const MOUTH_OPEN_AT = 0.05;

const on = (e: Record<string, number>, name: string) => (e[name] ?? 0) > EXPRESSION_ON;

export function eyeState(openness: number, expressions: Record<string, number>): EyeState {
  if (on(expressions, "smile")) return "smile";
  if (openness <= EYE_CLOSED_AT) return "closed";
  if (openness <= EYE_HALF_AT || on(expressions, "smug")) return "half";
  return "open";
}

export function mouthAttachment(slot: string, p: AvatarParams): string {
  if (p.mouthShape !== "rest" && p.mouthOpen >= MOUTH_OPEN_AT) return `${slot}-${p.mouthShape}`;
  if (on(p.expressions, "smile") || on(p.expressions, "smug")) return `${slot}-smile`;
  if (on(p.expressions, "hmm")) return `${slot}-N`;
  return slot;
}

export function mapParams(p: AvatarParams, b: SpineRigBinding): RigPose {
  const pose: RigPose = { sliders: {}, bones: {}, attachments: {}, alpha: {} };
  pose.sliders[b.headX] = 0.5 + p.headX / 2;
  pose.sliders[b.headY] = 0.5 + p.headY / 2;
  // Spine rotates counter-clockwise, so leaning to the viewer's right is negative.
  pose.bones[b.body] = {
    rotation: -p.bodyX * b.ranges.bodyDeg,
    scaleY: 1 + p.breath * b.ranges.breath,
  };
  if (b.head) pose.bones[b.head] = { rotation: -(p.headRoll ?? 0) * (b.ranges.headRollDeg ?? 0) };
  if (b.ranges.hairWind !== undefined) pose.wind = (p.wind ?? 0) * b.ranges.hairWind;
  const eyes = [
    [b.eyes.left, p.eyeOpenL],
    [b.eyes.right, p.eyeOpenR],
  ] as const;
  for (const [eye, openness] of eyes) {
    pose.bones[eye.iris] = { x: p.eyeX * b.ranges.irisX, y: p.eyeY * b.ranges.irisY };
    const state = eyeState(openness, p.expressions);
    for (const slot of eye.open) pose.attachments[slot] = state === "open" ? slot : null;
    pose.attachments[eye.state] = state === "open" ? null : `${eye.state}-${state}`;
  }
  pose.bones[b.brows.left] = { y: p.brow * b.ranges.brow };
  pose.bones[b.brows.right] = { y: p.brow * b.ranges.brow };
  pose.attachments[b.mouth] = mouthAttachment(b.mouth, p);
  if (b.blush) pose.alpha[b.blush] = p.blush;
  if (b.arms) {
    const crossed = on(p.expressions, "annoyed");
    pose.attachments[b.arms.slot] = crossed ? `${b.arms.slot}-${b.arms.variant}` : b.arms.slot;
    for (const slot of b.arms.hide) pose.attachments[slot] = crossed ? null : slot;
  }
  return pose;
}
