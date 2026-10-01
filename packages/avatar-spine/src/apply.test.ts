import { Physics } from "@esotericsoftware/spine-core";
import { type AvatarParams, NEUTRAL_PARAMS } from "@localdot/avatar";
import { buildSkeleton, toyRig } from "@localdot/rig-gen";
import { loadSkeleton } from "@localdot/rig-gen/testing";
import { describe, expect, it } from "vitest";
import { applyPose } from "./apply.ts";
import type { SpineRigBinding } from "./binding.ts";
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

  const problemsOf = (binding: unknown) => bindingProblems(binding as SpineRigBinding, toy().data);

  it("names a missing or non-finite range", () => {
    const ranges: Partial<SpineRigBinding["ranges"]> = { ...toyBinding.ranges };
    delete ranges.breath;
    expect(problemsOf({ ...toyBinding, ranges })).toEqual([
      "ranges.breath must be a finite number",
    ]);
    expect(problemsOf({ ...toyBinding, ranges: { ...toyBinding.ranges, bodyDeg: "3" } })).toEqual([
      "ranges.bodyDeg must be a finite number",
    ]);
  });

  it("names missing and wrong-typed fields instead of throwing", () => {
    const { eyes, arms } = toyBinding;
    expect(problemsOf({ ...toyBinding, eyes: { right: eyes.right } })).toEqual([
      "eyes.left must be an object",
    ]);
    const right = { ...eyes.right, open: "eye-white-r" };
    expect(problemsOf({ ...toyBinding, eyes: { ...eyes, right } })).toEqual([
      "eyes.right.open must be an array",
    ]);
    expect(problemsOf({ ...toyBinding, headX: "" })).toEqual(["headX must be a non-empty string"]);
    expect(problemsOf({ ...toyBinding, brows: { left: "brow-l" } })).toEqual([
      "brows.right must be a non-empty string",
    ]);
    expect(problemsOf({ ...toyBinding, arms: { ...arms, hide: [null] } })).toEqual([
      "arms.hide[0] must be a non-empty string",
    ]);
  });

  it("names the fields an empty or non-object binding lacks", () => {
    expect(problemsOf(null)).toEqual(["the binding must be an object"]);
    expect(problemsOf([])).toEqual(["the binding must be an object"]);
    expect(problemsOf({})).toEqual([
      "headX must be a non-empty string",
      "headY must be a non-empty string",
      "body must be a non-empty string",
      "eyes must be an object",
      "brows must be an object",
      "mouth must be a non-empty string",
      "ranges must be an object",
    ]);
  });

  it("treats a null blush or arms as absent", () => {
    expect(problemsOf({ ...toyBinding, blush: null, arms: null })).toEqual([]);
  });

  it("never throws, whatever JSON stands in for a field", () => {
    const { eyes, brows, arms, ranges } = toyBinding;
    for (const junk of [null, 0, "", "x", true, [], {}, [null], [""]]) {
      for (const binding of [
        junk,
        { ...toyBinding, headX: junk },
        { ...toyBinding, eyes: junk },
        { ...toyBinding, eyes: { ...eyes, left: junk } },
        { ...toyBinding, eyes: { ...eyes, left: { ...eyes.left, iris: junk } } },
        { ...toyBinding, eyes: { ...eyes, left: { ...eyes.left, open: junk } } },
        { ...toyBinding, eyes: { ...eyes, right: { ...eyes.right, state: junk } } },
        { ...toyBinding, brows: junk },
        { ...toyBinding, brows: { ...brows, right: junk } },
        { ...toyBinding, mouth: junk },
        { ...toyBinding, blush: junk },
        { ...toyBinding, arms: junk },
        { ...toyBinding, arms: { ...arms, slot: junk } },
        { ...toyBinding, arms: { ...arms, hide: junk } },
        { ...toyBinding, ranges: junk },
        { ...toyBinding, ranges: { ...ranges, irisY: junk } },
      ]) {
        expect(() => problemsOf(binding)).not.toThrow();
      }
    }
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
