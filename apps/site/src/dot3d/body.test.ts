import { Texture } from "three";
import { describe, expect, it } from "vitest";
import { bodyMaterial, setShades } from "./body.ts";

describe("setShades", () => {
  it("marks the shades of what sits on the face and the head, which turn with them", () => {
    const { uniforms } = bodyMaterial();
    const mustache = new Texture();
    const headphones = new Texture();
    const scarf = new Texture();
    setShades(uniforms, [headphones, mustache, scarf], ["head", "face", "body"]);
    expect(uniforms.uShade0.value).toBe(headphones);
    expect(uniforms.uShade1.value).toBe(mustache);
    expect(uniforms.uShade2.value).toBe(scarf);
    expect(uniforms.uShadeOnFace.value.toArray()).toEqual([0, 1, 0, 0]);
    expect(uniforms.uShadeOnHead.value.toArray()).toEqual([1, 0, 0, 0]);
  });
});
