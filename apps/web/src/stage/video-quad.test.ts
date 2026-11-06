import { expect, it, vi } from "vitest";

vi.mock("pixi.js", () => ({ Mesh: class {}, MeshGeometry: class {}, Shader: {}, Texture: {} }));
const { quadMesh } = await import("./video-quad.ts");

const triangles = (mesh: ReturnType<typeof quadMesh>) => mesh.indices.length / 3;
// Covered area, from the positions each two triangles of a rectangle share.
function area(mesh: ReturnType<typeof quadMesh>) {
  let sum = 0;
  for (let at = 0; at < mesh.positions.length; at += 8) {
    const w = (mesh.positions[at + 2] ?? 0) - (mesh.positions[at] ?? 0);
    const h = (mesh.positions[at + 5] ?? 0) - (mesh.positions[at + 1] ?? 0);
    sum += w * h;
  }
  return sum;
}

it("draws the whole picture as two triangles", () => {
  const mesh = quadMesh(2560, 1600, null);
  expect([...mesh.positions]).toEqual([0, 0, 2560, 0, 2560, 1600, 0, 1600]);
  expect([...mesh.uvs]).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
  expect(triangles(mesh)).toBe(2);
});

it("leaves out a hole, keeping each corner's texel", () => {
  const hole = { x: 38.4, y: 48, w: 2483.2, h: 1552 };
  const mesh = quadMesh(2560, 1600, hole);
  expect(triangles(mesh)).toBe(6);
  expect(area(mesh)).toBeCloseTo(2560 * 1600 - hole.w * hole.h, 0);
  // The right-hand strip's far corner reads the picture's corner.
  expect(mesh.uvs[20]).toBeCloseTo(1);
  expect(mesh.uvs[21]).toBeCloseTo(1);
  expect(mesh.uvs[16]).toBeCloseTo((38.4 + 2483.2) / 2560);
});
