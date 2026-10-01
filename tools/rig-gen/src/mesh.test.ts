import { describe, expect, it } from "vitest";
import { gridMesh } from "./mesh.ts";

describe("gridMesh", () => {
  it("puts the hull ring first, then the interior", () => {
    const mesh = gridMesh(4, 5);
    expect(mesh.cells).toHaveLength(30);
    expect(mesh.hull).toBe(18);
    expect(mesh.cells.slice(0, 2)).toEqual([
      [0, 0],
      [1, 0],
    ]);
    const interior = mesh.cells.slice(mesh.hull);
    expect(interior.every(([i, j]) => i > 0 && i < 4 && j > 0 && j < 5)).toBe(true);
  });

  it("covers every cell with two triangles and normalised uvs", () => {
    const mesh = gridMesh(4, 5);
    expect(mesh.triangles).toHaveLength(4 * 5 * 6);
    expect(Math.max(...mesh.triangles)).toBe(29);
    expect(mesh.uvs).toHaveLength(60);
    expect(mesh.uvs.every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it("handles a single cell", () => {
    const mesh = gridMesh(1, 1);
    expect(mesh.hull).toBe(4);
    expect(mesh.triangles).toHaveLength(6);
  });
});
