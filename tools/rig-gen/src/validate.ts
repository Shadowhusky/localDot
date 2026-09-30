import type { Box, RigDescription } from "./types.ts";

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
const isPoint = (p: unknown) =>
  typeof p === "object" && p !== null && finite((p as Box).x, (p as Box).y);

function structureProblems(desc: RigDescription): string[] {
  const problems: string[] = [];
  if (typeof desc !== "object" || desc === null) return ["the rig description must be an object"];
  if (!Array.isArray(desc.bones)) problems.push("bones must be an array");
  if (!Array.isArray(desc.parts)) problems.push("parts must be an array");
  if (typeof desc.canvas !== "object" || desc.canvas === null)
    problems.push("canvas must be an object");
  if (!isPoint(desc.root)) problems.push("root must be a finite point");
  if (!isPoint(desc.headTurn)) problems.push("headTurn must be a finite point");
  return problems;
}

export function rigProblems(desc: RigDescription): string[] {
  const structure = structureProblems(desc);
  if (structure.length > 0) return structure;
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
    physics.add(p.bone);
  }
  return problems;
}

export function validateRig(desc: RigDescription): void {
  const problems = rigProblems(desc);
  if (problems.length > 0) throw new RigError(problems);
}
