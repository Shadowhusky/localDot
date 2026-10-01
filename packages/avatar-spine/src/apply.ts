import { type Skeleton, Slider } from "@esotericsoftware/spine-core";
import type { RigPose } from "./pose.ts";

// Offsets are applied to the setup pose every frame, so repeated frames never accumulate.
export function applyPose(skeleton: Skeleton, pose: RigPose): void {
  for (const [name, time] of Object.entries(pose.sliders)) {
    const slider = skeleton.findConstraint(name, Slider);
    if (slider) slider.pose.time = time;
  }
  for (const [name, offset] of Object.entries(pose.bones)) {
    const bone = skeleton.findBone(name);
    if (!bone) continue;
    const setup = bone.data.setupPose;
    bone.pose.x = setup.x + (offset.x ?? 0);
    bone.pose.y = setup.y + (offset.y ?? 0);
    bone.pose.rotation = setup.rotation + (offset.rotation ?? 0);
    bone.pose.scaleY = setup.scaleY * (offset.scaleY ?? 1);
  }
  for (const [slot, attachment] of Object.entries(pose.attachments))
    skeleton.setAttachment(slot, attachment);
  for (const [name, alpha] of Object.entries(pose.alpha)) {
    const slot = skeleton.findSlot(name);
    if (slot) slot.pose.color.a = alpha;
  }
}
