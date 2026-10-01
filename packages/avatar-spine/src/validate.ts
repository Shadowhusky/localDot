import { type SkeletonData, SliderData } from "@esotericsoftware/spine-core";
import type { SpineRigBinding } from "./binding.ts";
import { EYE_COMPOSITES, MOUTH_VARIANTS } from "./pose.ts";

const SIDES = ["left", "right"] as const;
const RANGES = ["irisX", "irisY", "brow", "bodyDeg", "breath"] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Bindings are pack JSON with no schema, and spine-core's lookups throw on a missing or empty name.
function structureProblems(b: unknown): string[] {
  if (!isObject(b)) return ["the binding must be an object"];
  const problems: string[] = [];
  const name = (path: string, value: unknown) => {
    if (typeof value !== "string" || value === "")
      problems.push(`${path} must be a non-empty string`);
  };
  const names = (path: string, value: unknown) => {
    if (!Array.isArray(value)) problems.push(`${path} must be an array`);
    else for (const [i, item] of value.entries()) name(`${path}[${i}]`, item);
  };
  const object = (path: string, value: unknown) => {
    if (isObject(value)) return value;
    problems.push(`${path} must be an object`);
    return undefined;
  };
  name("headX", b.headX);
  name("headY", b.headY);
  if (b.head != null) name("head", b.head);
  name("body", b.body);
  const eyes = object("eyes", b.eyes);
  for (const side of SIDES) {
    const eye = eyes && object(`eyes.${side}`, eyes[side]);
    if (!eye) continue;
    name(`eyes.${side}.iris`, eye.iris);
    names(`eyes.${side}.open`, eye.open);
    name(`eyes.${side}.state`, eye.state);
  }
  const brows = object("brows", b.brows);
  for (const side of SIDES) if (brows) name(`brows.${side}`, brows[side]);
  name("mouth", b.mouth);
  if (b.blush != null) name("blush", b.blush);
  const arms = b.arms == null ? undefined : object("arms", b.arms);
  if (arms) {
    name("arms.slot", arms.slot);
    name("arms.variant", arms.variant);
    names("arms.hide", arms.hide);
  }
  object("ranges", b.ranges);
  return problems;
}

export function bindingProblems(b: SpineRigBinding, data: SkeletonData): string[] {
  const structure = structureProblems(b);
  if (structure.length > 0) return structure;
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
  if (b.head) {
    bone(b.head);
    if (!Number.isFinite(b.ranges.headRollDeg))
      problems.push("ranges.headRollDeg must be a finite number");
  }
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
  for (const key of RANGES) {
    if (!Number.isFinite(b.ranges[key])) problems.push(`ranges.${key} must be a finite number`);
  }
  if (b.ranges.hairWind !== undefined && !Number.isFinite(b.ranges.hairWind))
    problems.push("ranges.hairWind must be a finite number");
  return problems;
}
