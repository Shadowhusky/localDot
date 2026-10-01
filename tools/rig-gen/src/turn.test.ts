import { type MeshAttachment, Physics, Slider } from "@esotericsoftware/spine-core";
import { describe, expect, it } from "vitest";
import { buildSkeleton } from "./build.ts";
import { loadSkeleton } from "./testing.ts";
import { toyRig } from "./toy.ts";
import { HEAD_X, HEAD_Y } from "./types.ts";

const turned = (x: number, y: number) => {
  const skeleton = loadSkeleton(buildSkeleton(toyRig()));
  (skeleton.findConstraint(HEAD_X, Slider) as Slider).pose.time = 0.5 + x / 2;
  (skeleton.findConstraint(HEAD_Y, Slider) as Slider).pose.time = 0.5 + y / 2;
  skeleton.updateWorldTransform(Physics.none);
  return skeleton;
};
const worldX = (s: ReturnType<typeof turned>, bone: string) =>
  s.findBone(bone)?.appliedPose.worldX ?? Number.NaN;
const worldY = (s: ReturnType<typeof turned>, bone: string) =>
  s.findBone(bone)?.appliedPose.worldY ?? Number.NaN;
// Spine leaves `deform` empty while nothing deforms a mesh; the mesh then shows its setup vertices.
const faceVertices = (s: ReturnType<typeof turned>) => {
  const pose = s.findSlot("face")?.appliedPose;
  const mesh = pose?.attachment as MeshAttachment;
  return Array.from(pose?.deform.length ? pose.deform : mesh.vertices);
};

describe("head turn", () => {
  it("leaves the neutral pose untouched", () => {
    const s = turned(0, 0);
    const json = buildSkeleton(toyRig());
    const still = loadSkeleton({
      ...json,
      constraints: json.constraints.filter((c) => c.type !== "slider"),
    });
    for (const bone of still.bones) {
      expect(worldX(s, bone.data.name)).toBe(bone.appliedPose.worldX);
      expect(worldY(s, bone.data.name)).toBe(bone.appliedPose.worldY);
    }
    expect(faceVertices(s)).toEqual(faceVertices(still));
    expect(worldY(s, "features")).toBeCloseTo(250, 6);
  });

  it("shifts each depth bone by headTurn × depth", () => {
    const s = turned(1, 0);
    expect(worldX(s, "features")).toBeCloseTo(14.4, 3);
    expect(worldX(s, "head-front")).toBeCloseTo(21.6, 3);
    expect(worldX(s, "head-back")).toBeCloseTo(-9.6, 3);
    expect(worldX(turned(-1, 0), "features")).toBeCloseTo(-14.4, 3);
  });

  it("combines both sliders additively", () => {
    const s = turned(1, 1);
    expect(worldX(s, "features")).toBeCloseTo(14.4, 3);
    expect(worldY(s, "features")).toBeCloseTo(259.6, 3);
  });

  it("bulges the middle of the face and keeps its rim", () => {
    const s = turned(1, 0);
    const slot = s.findSlot("face");
    const mesh = slot?.appliedPose.attachment as MeshAttachment;
    const deform = slot?.appliedPose.deform ?? [];
    // Vertex order: 20 hull vertices, then interior (1,1)…(4,4); (2,2) is interior index 5.
    const middle = 20 + 5;
    expect((deform[middle * 2] as number) - (mesh.vertices[middle * 2] as number)).toBeCloseTo(
      10.85,
      1,
    );
    expect((deform[0] as number) - (mesh.vertices[0] as number)).toBeCloseTo(0, 1);
  });

  it("adds one physics constraint per spec", () => {
    const json = buildSkeleton(toyRig());
    expect(json.constraints).toContainEqual(
      expect.objectContaining({ name: "hair-tip-physics", type: "physics", bone: "hair-tip" }),
    );
  });

  it("stays finite and bounded over a long run with physics", () => {
    const skeleton = loadSkeleton(buildSkeleton(toyRig()));
    const x = skeleton.findConstraint(HEAD_X, Slider) as Slider;
    const y = skeleton.findConstraint(HEAD_Y, Slider) as Slider;
    const setupRotation =
      skeleton.findBone("hair-tip")?.appliedPose.getWorldRotationX() ?? Number.NaN;
    for (let frame = 0; frame < 600; frame++) {
      const t = frame / 60;
      x.pose.time = 0.5 + 0.5 * Math.sin(t * 2.1);
      y.pose.time = 0.5 + 0.5 * Math.sin(t * 1.3);
      skeleton.x = Math.sin(t * 3) * 40;
      skeleton.update(1 / 60);
      skeleton.updateWorldTransform(Physics.update);
      const tip = skeleton.findBone("hair-tip")?.appliedPose;
      expect(Number.isFinite(tip?.worldX)).toBe(true);
      expect(Math.abs(worldX(skeleton, "features") - skeleton.x)).toBeLessThan(15);
      expect(Math.abs((tip?.getWorldRotationX() ?? Number.NaN) - setupRotation)).toBeLessThan(1);
      // The tip sits straight above head-front, so without physics their world x would match.
      expect(Math.abs(worldX(skeleton, "hair-tip") - worldX(skeleton, "head-front"))).toBeLessThan(
        20,
      );
    }
    const deform = skeleton.findSlot("face")?.appliedPose.deform ?? [];
    // The face mesh spans about ±210 px around the head bone; accumulation would run far past this.
    expect(Math.max(...Array.from(deform, Math.abs))).toBeLessThan(300);
  });
});
