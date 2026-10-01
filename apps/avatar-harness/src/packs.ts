import type { Presence } from "@localdot/avatar";
import type { Frame, SpineRendererOptions, SpineRigBinding } from "@localdot/avatar-spine";

export interface PackMeta {
  root: { x: number; y: number };
  frames: Record<Presence, Frame>;
}

// Vite serves files outside the app root at /@fs/<absolute path> in dev.
const fsUrl = (dir: string, file: string) => `/@fs${encodeURI(`${dir}/${file}`)}`;

export async function loadPack(
  name: "toy" | "dev",
  manualClock = false,
): Promise<SpineRendererOptions> {
  const dir = name === "dev" ? __DEV_PACK__ : __TOY_PACK__;
  if (!dir) throw new Error("set LOCALDOT_AVATAR_PACK to the pack folder to use pack=dev");
  const [binding, meta] = await Promise.all([
    fetch(fsUrl(dir, "binding.json")).then((r) => r.json() as Promise<SpineRigBinding>),
    fetch(fsUrl(dir, "pack.json")).then((r) => r.json() as Promise<PackMeta>),
  ]);
  return {
    skeletonUrl: fsUrl(dir, "rig.skel"),
    atlasUrl: fsUrl(dir, "rig.atlas"),
    binding,
    root: meta.root,
    frames: meta.frames,
    manualClock,
  };
}
