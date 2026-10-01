import type { MeshAttachment, Slot } from "@esotericsoftware/spine-core";
import { describe, expect, it } from "vitest";
import { buildSkeleton, tipWeight } from "./build.ts";
import { boneWorlds, toWorld } from "./space.ts";
import { loadSkeleton } from "./testing.ts";
import { toyRig } from "./toy.ts";

const json = buildSkeleton(toyRig());
const attachments = (json.skins[0] as (typeof json.skins)[number]).attachments;

describe("buildSkeleton", () => {
  it("places bones relative to their parents in Spine's y-up space", () => {
    expect(json.bones[0]).toEqual({ name: "root" });
    expect(json.bones.find((b) => b.name === "body")).toEqual({
      name: "body",
      parent: "root",
      x: 0,
      y: 80,
    });
    expect(json.bones.find((b) => b.name === "head")).toEqual({
      name: "head",
      parent: "body",
      x: 0,
      y: 170,
    });
    expect(json.bones.find((b) => b.name === "iris-l")).toEqual({
      name: "iris-l",
      parent: "features",
      x: -40,
      y: 110,
    });
  });

  it("keeps parts in draw order and leaves hidden slots empty", () => {
    expect(json.slots.map((s) => s.name)).toEqual(toyRig().parts.map((p) => p.name));
    expect(json.slots.find((s) => s.name === "face")?.attachment).toBe("face");
    expect(json.slots.find((s) => s.name === "eye-l-state")?.attachment).toBeUndefined();
  });

  it("centres region attachments on their box, relative to the slot's bone", () => {
    expect(attachments.torso?.torso).toEqual({
      path: "torso",
      x: 0,
      y: 20,
      width: 240,
      height: 200,
    });
    expect(attachments.torso?.["torso-crossed"]).toMatchObject({
      path: "torso-crossed",
      x: 0,
      y: 20,
    });
  });

  it("names variants after their part", () => {
    expect(Object.keys(attachments.mouth ?? {})).toEqual([
      "mouth",
      "mouth-A",
      "mouth-I",
      "mouth-U",
      "mouth-E",
      "mouth-O",
      "mouth-N",
      "mouth-smile",
    ]);
  });

  it("binds weighted vertices so the setup pose matches the art", () => {
    const rig = toyRig();
    const hair = rig.parts.find((p) => p.name === "front-hair");
    const mesh = attachments["front-hair"]?.["front-hair"] as { vertices: number[]; uvs: number[] };
    const worlds = boneWorlds(rig);
    const names = ["root", ...rig.bones.map((b) => b.name)];
    let cursor = 0;
    let twoBone = 0;
    for (let k = 0; k < mesh.uvs.length / 2; k++) {
      const count = mesh.vertices[cursor++] as number;
      let x = 0;
      let y = 0;
      let weights = 0;
      for (let e = 0; e < count; e++) {
        const bone = worlds.get(names[mesh.vertices[cursor] as number] as string) as {
          x: number;
          y: number;
        };
        const [bx, by, w] = mesh.vertices.slice(cursor + 1, cursor + 4) as [number, number, number];
        x += w * (bone.x + bx);
        y += w * (bone.y + by);
        weights += w;
        cursor += 4;
      }
      if (count === 2) twoBone++;
      const u = mesh.uvs[k * 2] as number;
      const v = mesh.uvs[k * 2 + 1] as number;
      const box = hair?.bbox as { x: number; y: number; w: number; h: number };
      const expected = toWorld({ x: box.x + u * box.w, y: box.y + v * box.h }, rig.root);
      expect(weights).toBeCloseTo(1, 3);
      expect(x).toBeCloseTo(expected.x, 1);
      expect(y).toBeCloseTo(expected.y, 1);
    }
    expect(twoBone).toBeGreaterThan(0);
  });

  it("weights rows smoothly below the tip start", () => {
    expect(tipWeight(0.2, 0.4)).toBe(0);
    expect(tipWeight(1, 0.4)).toBe(1);
    expect(tipWeight(0.7, 0.4)).toBeCloseTo(0.5, 6);
  });

  it("loads in the Spine runtime with every attachment", () => {
    const skeleton = loadSkeleton(json);
    const skin = skeleton.data.defaultSkin;
    expect(skin).not.toBeNull();
    for (const [slotName, entries] of Object.entries(attachments)) {
      const slot = skeleton.data.findSlot(slotName);
      expect(slot).not.toBeNull();
      for (const placeholder of Object.keys(entries)) {
        expect(skin?.getAttachment(slot?.index ?? -1, placeholder)?.name).toBe(placeholder);
      }
    }
    const face = skeleton.findSlot("face");
    const mesh = face?.pose.attachment as MeshAttachment;
    const world = new Float32Array(mesh.worldVerticesLength);
    mesh.computeWorldVertices(skeleton, face as Slot, 0, mesh.worldVerticesLength, world, 0, 2);
    const rig = toyRig();
    const topLeft = toWorld({ x: 110, y: 140 }, rig.root);
    expect(world[0]).toBeCloseTo(topLeft.x, 1);
    expect(world[1]).toBeCloseTo(topLeft.y, 1);
  });
});
