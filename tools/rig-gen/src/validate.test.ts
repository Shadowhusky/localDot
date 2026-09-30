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

  it("reports missing structure without crashing", () => {
    const problems = rigProblems({} as RigDescription);
    expect(problems).toContain("bones must be an array");
    expect(problems).toContain("parts must be an array");
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
});
