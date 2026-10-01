import {
  AtlasAttachmentLoader,
  Physics,
  Skeleton,
  SkeletonJson,
  TextureAtlas,
} from "@esotericsoftware/spine-core";
import type { SpineSkeletonJson } from "./build.ts";

// An atlas with one region per image and no textures: enough to read and pose a skeleton in Node.
export function atlasFor(json: SpineSkeletonJson): string {
  const sizes = new Map<string, [number, number]>();
  for (const slot of Object.values(json.skins[0]?.attachments ?? {})) {
    for (const a of Object.values(slot)) {
      sizes.set(String(a.path), [
        Math.max(1, Math.round(Number(a.width))),
        Math.max(1, Math.round(Number(a.height))),
      ]);
    }
  }
  const lines = ["rig.png", "size:4096,4096", "filter:Linear,Linear"];
  for (const [path, [w, h]] of sizes) lines.push(path, `bounds:0,0,${w},${h}`);
  return lines.join("\n");
}

export function loadSkeleton(json: SpineSkeletonJson): Skeleton {
  const reader = new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlasFor(json))));
  const skeleton = new Skeleton(reader.readSkeletonData(structuredClone(json)));
  skeleton.setupPose();
  skeleton.updateWorldTransform(Physics.none);
  return skeleton;
}
