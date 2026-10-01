import { Physics } from "@esotericsoftware/spine-core";
import { type AvatarParams, NEUTRAL_PARAMS } from "@localdot/avatar";
import { buildSkeleton, toyRig } from "@localdot/rig-gen";
import { loadSkeleton } from "@localdot/rig-gen/testing";
import { describe, expect, it } from "vitest";
import { applyPose } from "./apply.ts";
import { mapParams } from "./pose.ts";
import { toyBinding } from "./toy.ts";
import { bindingProblems } from "./validate.ts";

const toy = () => loadSkeleton(buildSkeleton(toyRig()));
const apply = (skeleton: ReturnType<typeof toy>, overrides: Partial<AvatarParams>) => {
  applyPose(skeleton, mapParams({ ...NEUTRAL_PARAMS, ...overrides }, toyBinding));
  skeleton.updateWorldTransform(Physics.none);
};

describe("bindingProblems", () => {
  it("accepts the toy binding for the toy rig", () => {
    expect(bindingProblems(toyBinding, toy().data)).toEqual([]);
  });

  it("names every mismatch", () => {
    const binding = {
      ...toyBinding,
      headX: "tilt",
      mouth: "lips",
      eyes: { ...toyBinding.eyes, left: { ...toyBinding.eyes.left, iris: "nope" } },
    };
    const problems = bindingProblems(binding, toy().data).join("\n");
    expect(problems).toContain('slider "tilt" not found');
    expect(problems).toContain('slot "lips" not found');
    expect(problems).toContain('bone "nope" not found');
  });

  it("names a missing mouth shape", () => {
    const skeleton = toy();
    const rig = toyRig();
    const mouth = rig.parts.find((p) => p.name === "mouth");
    if (mouth?.variants) delete mouth.variants.O;
    expect(bindingProblems(toyBinding, loadSkeleton(buildSkeleton(rig)).data)).toContain(
      'slot "mouth" has no attachment "mouth-O"',
    );
    expect(bindingProblems(toyBinding, skeleton.data)).toEqual([]);
  });
});

describe("applyPose", () => {
  it("turns the head through the sliders", () => {
    const skeleton = toy();
    apply(skeleton, { headX: 1 });
    expect(skeleton.findBone("features")?.appliedPose.worldX).toBeCloseTo(14.4, 3);
  });

  it("offsets bones from their setup pose without accumulating", () => {
    const skeleton = toy();
    const setupX = skeleton.findBone("iris-l")?.data.setupPose.x ?? 0;
    apply(skeleton, { eyeX: 1 });
    apply(skeleton, { eyeX: 1 });
    expect(skeleton.findBone("iris-l")?.pose.x).toBeCloseTo(setupX + 6, 6);
    apply(skeleton, { eyeX: 0 });
    expect(skeleton.findBone("iris-l")?.pose.x).toBeCloseTo(setupX, 6);
  });

  it("switches eye and mouth attachments", () => {
    const skeleton = toy();
    apply(skeleton, { eyeOpenL: 0, mouthShape: "A", mouthOpen: 1 });
    expect(skeleton.findSlot("eye-white-l")?.pose.attachment).toBeNull();
    expect(skeleton.findSlot("eye-l-state")?.pose.attachment?.name).toBe("eye-l-state-closed");
    expect(skeleton.findSlot("mouth")?.pose.attachment?.name).toBe("mouth-A");
    apply(skeleton, { eyeOpenL: 1, mouthShape: "rest", mouthOpen: 0 });
    expect(skeleton.findSlot("eye-white-l")?.pose.attachment?.name).toBe("eye-white-l");
    expect(skeleton.findSlot("eye-l-state")?.pose.attachment).toBeNull();
  });

  it("sets the blush slot's alpha", () => {
    const skeleton = toy();
    apply(skeleton, { blush: 0.3 });
    expect(skeleton.findSlot("blush")?.pose.color.a).toBeCloseTo(0.3, 6);
  });

  it("survives every extreme pose", () => {
    const skeleton = toy();
    const shapes = ["A", "I", "U", "E", "O", "N", "rest"] as const;
    for (const x of [-1, 0, 1]) {
      for (const y of [-1, 0, 1]) {
        for (const open of [0, 0.5, 1]) {
          for (const shape of shapes) {
            apply(skeleton, {
              headX: x,
              headY: y,
              bodyX: x,
              eyeX: y,
              eyeY: x,
              eyeOpenL: open,
              eyeOpenR: 1 - open,
              brow: y,
              mouthShape: shape,
              mouthOpen: open,
              breath: open,
              blush: open,
              expressions: { smile: open, smug: 1 - open, annoyed: open, hmm: 1 },
            });
            for (const bone of skeleton.bones)
              expect(Number.isFinite(bone.appliedPose.worldX)).toBe(true);
          }
        }
      }
    }
  });
});
