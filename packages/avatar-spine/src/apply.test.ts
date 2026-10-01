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

  it("accepts a head roll binding and names a missing head bone or roll range", () => {
    const rolling = {
      ...toyBinding,
      head: "head",
      ranges: { ...toyBinding.ranges, headRollDeg: 3 },
    };
    expect(problemsOf(rolling)).toEqual([]);
    expect(problemsOf({ ...rolling, head: "skull" })).toEqual(['bone "skull" not found']);
    expect(problemsOf({ ...rolling, ranges: toyBinding.ranges })).toEqual([
      "ranges.headRollDeg must be a finite number",
    ]);
    expect(problemsOf({ ...rolling, head: "" })).toEqual(["head must be a non-empty string"]);
    expect(problemsOf({ ...toyBinding, head: null })).toEqual([]);
  });

  it("names a wind range that is not a finite number", () => {
    const windy = (hairWind: unknown) => ({
      ...toyBinding,
      ranges: { ...toyBinding.ranges, hairWind },
    });
    expect(problemsOf(windy(2))).toEqual([]);
    expect(problemsOf(windy("2"))).toEqual(["ranges.hairWind must be a finite number"]);
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
        { ...toyBinding, head: junk },
        { ...toyBinding, head: "head", ranges: { ...ranges, headRollDeg: junk } },
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

  it("rolls the head about its own pivot", () => {
    const rolling = {
      ...toyBinding,
      head: "head",
      ranges: { ...toyBinding.ranges, headRollDeg: 10 },
    };
    const pose = (headRoll: number) => {
      const skeleton = toy();
      applyPose(skeleton, mapParams({ ...NEUTRAL_PARAMS, headRoll }, rolling));
      skeleton.updateWorldTransform(Physics.none);
      const at = (name: string) => skeleton.findBone(name)?.appliedPose;
      return { head: at("head"), iris: at("iris-l") };
    };
    const level = pose(0);
    const rolled = pose(1);
    expect(rolled.head?.worldX).toBeCloseTo(level.head?.worldX ?? Number.NaN, 6);
    expect(rolled.head?.worldY).toBeCloseTo(level.head?.worldY ?? Number.NaN, 6);
    // The iris sits 40 left of and 110 above the pivot: a 10° roll toward the right carries it
    // 40·(1 − cos 10°) + 110·sin 10° ≈ 19.71 to the right.
    expect((rolled.iris?.worldX ?? 0) - (level.iris?.worldX ?? 0)).toBeCloseTo(19.71, 2);
  });

  it("sets the wind on every physics constraint", () => {
    const skeleton = toy();
    const windy = { ...toyBinding, ranges: { ...toyBinding.ranges, hairWind: 3 } };
    applyPose(skeleton, mapParams({ ...NEUTRAL_PARAMS, wind: 0.5 }, windy));
    expect(skeleton.physics.length).toBeGreaterThan(0);
    for (const constraint of skeleton.physics) expect(constraint.pose.wind).toBe(1.5);
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
