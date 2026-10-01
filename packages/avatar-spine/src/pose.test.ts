import { type AvatarParams, NEUTRAL_PARAMS } from "@localdot/avatar";
import { toyRig } from "@localdot/rig-gen";
import { describe, expect, it } from "vitest";
import { mapParams } from "./pose.ts";
import { toyBinding } from "./toy.ts";

const frame = (overrides: Partial<AvatarParams>): AvatarParams => ({
  ...NEUTRAL_PARAMS,
  ...overrides,
});
const map = (overrides: Partial<AvatarParams>) => mapParams(frame(overrides), toyBinding);

describe("mapParams", () => {
  it("maps head turns to slider times", () => {
    expect(map({ headX: 1 }).sliders["head-x"]).toBe(1);
    expect(map({ headX: -1 }).sliders["head-x"]).toBe(0);
    expect(map({}).sliders["head-x"]).toBe(0.5);
    expect(map({ headY: 0.5 }).sliders["head-y"]).toBe(0.75);
  });

  it("leans and breathes with the body bone", () => {
    const body = map({ bodyX: 1, breath: 1 }).bones.body;
    expect(body?.rotation).toBe(-3);
    expect(body?.scaleY).toBeCloseTo(1.012, 9);
  });

  it("rolls a head bone the binding names, and leaves the head alone otherwise", () => {
    const rolling = {
      ...toyBinding,
      head: "head",
      ranges: { ...toyBinding.ranges, headRollDeg: 3 },
    };
    expect(mapParams(frame({ headRoll: 1 }), rolling).bones.head).toEqual({ rotation: -3 });
    expect(mapParams(frame({ headRoll: -0.5 }), rolling).bones.head).toEqual({ rotation: 1.5 });
    expect(map({ headRoll: 1 }).bones.head).toBeUndefined();
  });

  it("blows on the hair physics within the binding's wind range, and not at all without one", () => {
    const windy = { ...toyBinding, ranges: { ...toyBinding.ranges, hairWind: 2 } };
    expect(mapParams(frame({ wind: -0.5 }), windy).wind).toBe(-1);
    expect(map({ wind: 1 }).wind).toBeUndefined();
  });

  it("moves irises and brows within their ranges", () => {
    const pose = map({ eyeX: 1, eyeY: -1, brow: 1 });
    expect(pose.bones["iris-l"]).toEqual({ x: 6, y: -4 });
    expect(pose.bones["brow-r"]).toEqual({ y: 6 });
  });

  it("shows open eyes above two thirds and composites below", () => {
    const open = map({ eyeOpenL: 1 }).attachments;
    expect(open["eye-white-l"]).toBe("eye-white-l");
    expect(open["iris-l"]).toBe("iris-l");
    expect(open["eye-l-state"]).toBeNull();
    const half = map({ eyeOpenL: 0.5 }).attachments;
    expect(half["iris-l"]).toBeNull();
    expect(half["eye-l-state"]).toBe("eye-l-state-half");
    expect(map({ eyeOpenL: 0.1 }).attachments["eye-l-state"]).toBe("eye-l-state-closed");
  });

  it("smiles with closed eyes, half-lids when smug, and winks one eye", () => {
    expect(map({ expressions: { smile: 1 } }).attachments["eye-r-state"]).toBe("eye-r-state-smile");
    expect(map({ expressions: { smug: 1 } }).attachments["eye-l-state"]).toBe("eye-l-state-half");
    const wink = map({ eyeOpenR: 0 }).attachments;
    expect(wink["eye-r-state"]).toBe("eye-r-state-closed");
    expect(wink["eye-l-state"]).toBeNull();
  });

  it("picks the mouth shape while speaking, else a resting expression", () => {
    expect(map({ mouthShape: "A", mouthOpen: 0.8 }).attachments.mouth).toBe("mouth-A");
    expect(map({ mouthShape: "O", mouthOpen: 0.01 }).attachments.mouth).toBe("mouth");
    expect(map({ expressions: { smile: 1 } }).attachments.mouth).toBe("mouth-smile");
    expect(map({ expressions: { hmm: 1 } }).attachments.mouth).toBe("mouth-N");
    expect(map({}).attachments.mouth).toBe("mouth");
  });

  it("fades the blush and crosses the arms when annoyed", () => {
    expect(map({ blush: 0.4 }).alpha.blush).toBe(0.4);
    const annoyed = map({ expressions: { annoyed: 1 } }).attachments;
    expect(annoyed.torso).toBe("torso-crossed");
    expect(annoyed.tie).toBeNull();
    const calm = map({}).attachments;
    expect(calm.torso).toBe("torso");
    expect(calm.tie).toBe("tie");
  });

  it("only ever names attachments the rig defines and never produces NaN", () => {
    const rig = toyRig();
    const names = new Set(
      rig.parts.flatMap((p) => [
        p.name,
        ...Object.keys(p.variants ?? {}).map((k) => `${p.name}-${k}`),
      ]),
    );
    const shapes = ["A", "I", "U", "E", "O", "N", "rest"] as const;
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 500; i++) {
      const pose = map({
        headX: rnd() * 2 - 1,
        headY: rnd() * 2 - 1,
        bodyX: rnd() * 2 - 1,
        eyeOpenL: rnd(),
        eyeOpenR: rnd(),
        eyeX: rnd() * 2 - 1,
        eyeY: rnd() * 2 - 1,
        brow: rnd() * 2 - 1,
        mouthShape: shapes[Math.floor(rnd() * shapes.length)] as (typeof shapes)[number],
        mouthOpen: rnd(),
        breath: rnd(),
        blush: rnd(),
        expressions: { smile: rnd(), smug: rnd(), annoyed: rnd(), hmm: rnd() },
      });
      for (const name of Object.values(pose.attachments))
        if (name !== null) expect(names.has(name)).toBe(true);
      for (const offset of Object.values(pose.bones))
        for (const v of Object.values(offset)) expect(Number.isFinite(v)).toBe(true);
      for (const v of Object.values(pose.sliders)) expect(v >= 0 && v <= 1).toBe(true);
    }
  });
});
