import { type Box, INHERIT_MODES, type RigDescription } from "./types.ts";

export class RigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid rig description:\n- ${problems.join("\n- ")}`);
    this.name = "RigError";
    this.problems = problems;
  }
}

const finite = (...values: number[]) => values.every((v) => Number.isFinite(v));
const validBox = (b: Box | undefined) => !!b && finite(b.x, b.y, b.w, b.h) && b.w > 0 && b.h > 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isPoint = (p: unknown) => isObject(p) && finite(p.x as number, p.y as number);

function listProblems(label: string, list: unknown): string[] {
  if (!Array.isArray(list)) return [`${label} must be an array`];
  const problems: string[] = [];
  for (const [i, entry] of list.entries()) {
    if (!isObject(entry)) problems.push(`${label}[${i}] must be an object`);
  }
  return problems;
}

function structureProblems(desc: unknown): string[] {
  if (!isObject(desc)) return ["the rig description must be an object"];
  const problems = [
    ...listProblems("bones", desc.bones),
    ...listProblems("parts", desc.parts),
    ...listProblems("physics", desc.physics ?? []),
  ];
  if (!isObject(desc.canvas)) problems.push("canvas must be an object");
  if (!isPoint(desc.root)) problems.push("root must be a finite point");
  if (!isPoint(desc.headTurn)) problems.push("headTurn must be a finite point");
  for (const part of Array.isArray(desc.parts) ? desc.parts : []) {
    if (!isObject(part)) continue;
    for (const [key, variant] of Object.entries(part.variants ?? {})) {
      if (!isObject(variant)) problems.push(`variant "${part.name}-${key}" must be an object`);
    }
  }
  return problems;
}

export function rigProblems(input: unknown): string[] {
  const structure = structureProblems(input);
  if (structure.length > 0) return structure;
  const desc = input as RigDescription;
  const problems: string[] = [];
  if (!desc.name) problems.push("name is empty");
  if (!(finite(desc.canvas.w, desc.canvas.h) && desc.canvas.w > 0 && desc.canvas.h > 0)) {
    problems.push("canvas must have a positive width and height");
  }
  const bones = new Set(["root"]);
  for (const bone of desc.bones) {
    if (bones.has(bone.name))
      problems.push(`bone "${bone.name}" is defined twice (or reuses "root")`);
    const parent = bone.parent ?? "root";
    if (!bones.has(parent)) {
      problems.push(`bone "${bone.name}" has parent "${parent}", which is not defined before it`);
    }
    if (!isPoint(bone.at)) problems.push(`bone "${bone.name}" has a non-finite position`);
    if (bone.depth !== undefined && !finite(bone.depth))
      problems.push(`bone "${bone.name}" has a non-finite depth`);
    if (bone.inherit !== undefined && !INHERIT_MODES.includes(bone.inherit))
      problems.push(`bone "${bone.name}" has an unknown inherit mode "${bone.inherit}"`);
    bones.add(bone.name);
  }
  const names = new Set<string>();
  for (const part of desc.parts) {
    const own = [part.name, ...Object.keys(part.variants ?? {}).map((k) => `${part.name}-${k}`)];
    for (const name of own) {
      if (names.has(name)) problems.push(`attachment name "${name}" is used twice`);
      names.add(name);
    }
    if (!bones.has(part.bone))
      problems.push(`part "${part.name}" hangs on unknown bone "${part.bone}"`);
    if (!validBox(part.bbox)) problems.push(`part "${part.name}" has an empty or non-finite bbox`);
    if (part.mesh) {
      const { cols, rows, bulge } = part.mesh;
      if (!(Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && rows >= 1)) {
        problems.push(`part "${part.name}" mesh needs whole-number cols and rows of at least 1`);
      }
      if (bulge !== undefined && !finite(bulge))
        problems.push(`part "${part.name}" has a non-finite bulge`);
    }
    if (part.tip) {
      if (!part.mesh) problems.push(`part "${part.name}" has a tip but no mesh`);
      if (part.mesh?.bulge) problems.push(`part "${part.name}" cannot have both a tip and a bulge`);
      if (!bones.has(part.tip.bone))
        problems.push(`part "${part.name}" tip uses unknown bone "${part.tip.bone}"`);
      if (!(part.tip.from >= 0 && part.tip.from < 1))
        problems.push(`part "${part.name}" tip.from must be in [0, 1)`);
    }
    for (const [key, variant] of Object.entries(part.variants ?? {})) {
      if (!key) problems.push(`part "${part.name}" has a variant with an empty name`);
      if (!validBox(variant.bbox))
        problems.push(`variant "${part.name}-${key}" has an empty or non-finite bbox`);
    }
  }
  const physics = new Set<string>();
  for (const p of desc.physics ?? []) {
    if (!bones.has(p.bone)) problems.push(`physics on unknown bone "${p.bone}"`);
    if (physics.has(p.bone)) problems.push(`bone "${p.bone}" has physics twice`);
    if ((p.rotate ?? 0) !== 0) {
      problems.push(`physics on "${p.bone}" cannot rotate: rig-gen bones have no length; use x`);
    }
    physics.add(p.bone);
  }
  return problems;
}

export function validateRig(desc: unknown): void {
  const problems = rigProblems(desc);
  if (problems.length > 0) throw new RigError(problems);
}
