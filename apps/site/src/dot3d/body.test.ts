import { Texture } from "three";
import { describe, expect, it } from "vitest";
import { bodyMaterial, setShades } from "./body.ts";

describe("setShades", () => {
  it("marks the shades of what sits on the face, which turn with it", () => {
    const { uniforms } = bodyMaterial();
    const mustache = new Texture();
    const headphones = new Texture();
    setShades(uniforms, [headphones, mustache], [false, true]);
    expect(uniforms.uShade0.value).toBe(headphones);
    expect(uniforms.uShade1.value).toBe(mustache);
    expect(uniforms.uShadeOnFace.value.toArray()).toEqual([0, 1, 0, 0]);
  });
});
