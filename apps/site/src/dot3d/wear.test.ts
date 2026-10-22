import { Group, Texture } from "three";
import { describe, expect, it, vi } from "vitest";

vi.mock("./wardrobe.ts", () => ({
  ON_FACE: new Set(["round-glasses", "sunglasses", "mustache"]),
  ON_HEAD: new Set(["cap", "beret", "mortarboard", "headphones", "bow"]),
  wearable: () => Promise.resolve(new Group()),
  wearableShadow: () => Promise.resolve(new Texture()),
  loadedWearable: (name: string) => Object.assign(new Group(), { name }),
  loadedShadow: () => new Texture(),
}));

const { Dot3D } = await import("./dot3d.ts");

describe("Dot3D.wear", () => {
  it("puts on what is already loaded at once, so the next frame shows it", () => {
    const dot = new Dot3D();
    dot.wear(["beret", "round-glasses", "scarf"]);
    expect(dot.headwear.getObjectByName("beret")).toBeTruthy();
    expect(dot.face.getObjectByName("round-glasses")).toBeTruthy();
    expect(dot.head.children.some((item) => item.name === "scarf")).toBe(true);
    dot.wear([]);
    expect(dot.head.getObjectByName("beret")).toBeUndefined();
  });
});
