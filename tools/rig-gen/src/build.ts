import { gridMesh } from "./mesh.ts";
import { boneWorlds, round2, round4, toWorld, type WorldPoint } from "./space.ts";
import { type Box, type PartSpec, type RigDescription, SPINE_VERSION } from "./types.ts";
import { validateRig } from "./validate.ts";

type Json = Record<string, unknown>;

export interface SpineSkeletonJson {
  skeleton: { spine: string; x: number; y: number; width: number; height: number; images: string };
  bones: { name: string; parent?: string; x?: number; y?: number }[];
  slots: { name: string; bone: string; attachment?: string }[];
  constraints: Json[];
  skins: { name: string; attachments: Record<string, Record<string, Json>> }[];
  animations: Record<string, Json>;
}

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export function tipWeight(v: number, from: number): number {
  if (v <= from) return 0;
  const t = Math.min(1, (v - from) / (1 - from));
  return t * t * (3 - 2 * t);
}

export function buildSkeleton(desc: RigDescription): SpineSkeletonJson {
  validateRig(desc);
  const worlds = boneWorlds(desc);
  const worldOf = (bone: string) => worlds.get(bone) as WorldPoint;
  const relative = (p: WorldPoint, bone: string) => ({
    x: round2(p.x - worldOf(bone).x),
    y: round2(p.y - worldOf(bone).y),
  });
  const boneIndex = new Map(["root", ...desc.bones.map((b) => b.name)].map((name, i) => [name, i]));

  const region = (image: string, bbox: Box, bone: string): Json => ({
    path: image,
    ...relative(toWorld(center(bbox), desc.root), bone),
    width: bbox.w,
    height: bbox.h,
  });

  const mesh = (part: PartSpec): Json => {
    const spec = part.mesh as NonNullable<PartSpec["mesh"]>;
    const grid = gridMesh(spec.cols, spec.rows);
    const vertices: number[] = [];
    for (const [i, j] of grid.cells) {
      const u = i / spec.cols;
      const v = j / spec.rows;
      const world = toWorld(
        { x: part.bbox.x + u * part.bbox.w, y: part.bbox.y + v * part.bbox.h },
        desc.root,
      );
      const bind = (bone: string) => {
        const at = relative(world, bone);
        return [at.x, at.y];
      };
      if (!part.tip) {
        vertices.push(...bind(part.bone));
        continue;
      }
      const tip = part.tip.bone;
      const t = round4(tipWeight(v, part.tip.from));
      const own = boneIndex.get(part.bone) as number;
      const tipIndex = boneIndex.get(tip) as number;
      if (t <= 0) vertices.push(1, own, ...bind(part.bone), 1);
      else if (t >= 1) vertices.push(1, tipIndex, ...bind(tip), 1);
      else vertices.push(2, own, ...bind(part.bone), round4(1 - t), tipIndex, ...bind(tip), t);
    }
    return {
      type: "mesh",
      path: part.image,
      uvs: grid.uvs.map(round4),
      triangles: grid.triangles,
      vertices,
      hull: grid.hull,
      width: part.bbox.w,
      height: part.bbox.h,
    };
  };

  const attachments: Record<string, Record<string, Json>> = {};
  for (const part of desc.parts) {
    const entries: Record<string, Json> = {
      [part.name]: part.mesh ? mesh(part) : region(part.image, part.bbox, part.bone),
    };
    for (const [key, variant] of Object.entries(part.variants ?? {})) {
      entries[`${part.name}-${key}`] = region(variant.image, variant.bbox, part.bone);
    }
    attachments[part.name] = entries;
  }

  return {
    skeleton: {
      spine: SPINE_VERSION,
      x: round2(-desc.root.x),
      y: round2(desc.root.y - desc.canvas.h),
      width: desc.canvas.w,
      height: desc.canvas.h,
      images: desc.images,
    },
    bones: [
      { name: "root" },
      ...desc.bones.map((b) => {
        const parent = b.parent ?? "root";
        return { name: b.name, parent, ...relative(worldOf(b.name), parent) };
      }),
    ],
    slots: desc.parts.map((p) =>
      p.hidden
        ? { name: p.name, bone: p.bone }
        : { name: p.name, bone: p.bone, attachment: p.name },
    ),
    constraints: [],
    skins: [{ name: "default", attachments }],
    animations: {},
  };
}
