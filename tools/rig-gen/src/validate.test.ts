import { describe, expect, it } from "vitest";
import { toyRig } from "./toy.ts";
import type { RigDescription } from "./types.ts";
import { RigError, rigProblems, validateRig } from "./validate.ts";

const broken = (): RigDescription => {
  const rig = toyRig();
  rig.bones.push({ name: "orphan", parent: "nope", at: { x: 0, y: 0 } });
  (rig.parts[0] as RigDescription["parts"][number]).bone = "missing";
  rig.parts.push({ ...(rig.parts[1] as RigDescription["parts"][number]) });
  const hair = rig.parts.find((p) => p.name === "front-hair");
  if (hair?.mesh) hair.mesh.bulge = 0.3;
  rig.physics = [{ bone: "ghost" }];
  return rig;
};

describe("rigProblems", () => {
  it("accepts the toy rig", () => {
    expect(rigProblems(toyRig())).toEqual([]);
  });

  it("names every problem", () => {
    const problems = rigProblems(broken()).join("\n");
    expect(problems).toContain('bone "orphan" has parent "nope"');
    expect(problems).toContain('hangs on unknown bone "missing"');
    expect(problems).toContain("is used twice");
    expect(problems).toContain('part "front-hair" cannot have both a tip and a bulge');
    expect(problems).toContain('physics on unknown bone "ghost"');
  });

  it("names a bone whose inherit mode Spine does not have", () => {
    const rig = toyRig();
    rig.bones.push({
      name: "spin",
      parent: "head",
      at: { x: 0, y: 0 },
      inherit: "noRotation" as RigDescription["bones"][number]["inherit"],
    });
    expect(rigProblems(rig)).toEqual(['bone "spin" has an unknown inherit mode "noRotation"']);
    rig.bones.pop();
    rig.bones.push({
      name: "level",
      parent: "head",
      at: { x: 0, y: 0 },
      inherit: "onlyTranslation",
    });
    expect(rigProblems(rig)).toEqual([]);
  });

  it("reports missing structure without crashing", () => {
    const problems = rigProblems({});
    expect(problems).toContain("bones must be an array");
    expect(problems).toContain("parts must be an array");
  });

  it("reports physics that is not an array, treating null as no physics", () => {
    expect(rigProblems({ ...toyRig(), physics: {} })).toEqual(["physics must be an array"]);
    expect(rigProblems({ ...toyRig(), physics: null })).toEqual([]);
  });

  it("reports null entries and variant values instead of throwing", () => {
    const rig = toyRig();
    const parts = rig.parts.map((p) =>
      p.name === "mouth" ? { ...p, variants: { ...p.variants, A: null } } : p,
    );
    expect(rigProblems({ ...rig, bones: [null] })).toEqual(["bones[0] must be an object"]);
    expect(rigProblems({ ...rig, parts: [null, ...rig.parts] })).toEqual([
      "parts[0] must be an object",
    ]);
    expect(rigProblems({ ...rig, physics: [null] })).toEqual(["physics[0] must be an object"]);
    expect(rigProblems({ ...rig, parts })).toEqual(['variant "mouth-A" must be an object']);
  });

  it("rejects rotation physics, since rig-gen bones have no length", () => {
    const withPhysics = (spec: object) =>
      rigProblems({ ...toyRig(), physics: [{ bone: "hair-tip", ...spec }] });
    expect(withPhysics({ rotate: 1 })).toEqual([
      'physics on "hair-tip" cannot rotate: rig-gen bones have no length; use x',
    ]);
    expect(withPhysics({ rotate: 0, x: 1 })).toEqual([]);
    expect(withPhysics({ rotate: null })).toEqual([]);
  });

  it("rejects empty boxes and bad tips", () => {
    const rig = toyRig();
    const face = rig.parts.find((p) => p.name === "face");
    if (face) face.bbox = { x: 0, y: 0, w: 0, h: 10 };
    const hair = rig.parts.find((p) => p.name === "front-hair");
    if (hair?.tip) hair.tip.from = 1;
    const problems = rigProblems(rig).join("\n");
    expect(problems).toContain('part "face" has an empty or non-finite bbox');
    expect(problems).toContain('part "front-hair" tip.from must be in [0, 1)');
  });
});

describe("validateRig", () => {
  it("throws one RigError listing every problem", () => {
    expect(() => validateRig(broken())).toThrow(RigError);
    expect(() => validateRig(broken())).toThrow(/unknown bone "missing"/);
  });

  it("throws a RigError, not a TypeError, for malformed input", () => {
    expect(() => validateRig({ ...toyRig(), physics: {} })).toThrow(RigError);
  });
});
