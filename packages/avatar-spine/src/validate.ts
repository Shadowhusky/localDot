import { type SkeletonData, SliderData } from "@esotericsoftware/spine-core";
import type { SpineRigBinding } from "./binding.ts";
import { EYE_COMPOSITES, MOUTH_VARIANTS } from "./pose.ts";

export function bindingProblems(b: SpineRigBinding, data: SkeletonData): string[] {
  const problems: string[] = [];
  const slider = (name: string) => {
    if (!data.findConstraint(name, SliderData)) problems.push(`slider "${name}" not found`);
  };
  const bone = (name: string) => {
    if (!data.findBone(name)) problems.push(`bone "${name}" not found`);
  };
  const attachment = (slotName: string, placeholder: string) => {
    const slot = data.findSlot(slotName);
    if (!slot) {
      problems.push(`slot "${slotName}" not found`);
      return;
    }
    if (!data.defaultSkin?.getAttachment(slot.index, placeholder)) {
      problems.push(`slot "${slotName}" has no attachment "${placeholder}"`);
    }
  };
  slider(b.headX);
  slider(b.headY);
  bone(b.body);
  bone(b.brows.left);
  bone(b.brows.right);
  for (const eye of [b.eyes.left, b.eyes.right]) {
    bone(eye.iris);
    for (const slot of eye.open) attachment(slot, slot);
    for (const state of EYE_COMPOSITES) attachment(eye.state, `${eye.state}-${state}`);
  }
  if (data.findSlot(b.mouth)) {
    attachment(b.mouth, b.mouth);
    for (const shape of MOUTH_VARIANTS) attachment(b.mouth, `${b.mouth}-${shape}`);
  } else {
    problems.push(`slot "${b.mouth}" not found`);
  }
  if (b.blush) attachment(b.blush, b.blush);
  if (b.arms) {
    attachment(b.arms.slot, b.arms.slot);
    attachment(b.arms.slot, `${b.arms.slot}-${b.arms.variant}`);
    for (const slot of b.arms.hide) attachment(slot, slot);
  }
  if (!Object.values(b.ranges).every((v) => Number.isFinite(v)))
    problems.push("ranges must be finite numbers");
  return problems;
}
