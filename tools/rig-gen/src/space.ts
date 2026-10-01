import type { CanvasPoint, RigDescription } from "./types.ts";

export interface WorldPoint {
  x: number;
  y: number;
}

// Canvas is y-down from the top-left; Spine is y-up from `root`.
export function toWorld(p: CanvasPoint, root: CanvasPoint): WorldPoint {
  return { x: p.x - root.x, y: root.y - p.y };
}

export function boneWorlds(desc: RigDescription): Map<string, WorldPoint> {
  const worlds = new Map<string, WorldPoint>([["root", { x: 0, y: 0 }]]);
  for (const bone of desc.bones) worlds.set(bone.name, toWorld(bone.at, desc.root));
  return worlds;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round4 = (n: number) => Math.round(n * 10000) / 10000;
