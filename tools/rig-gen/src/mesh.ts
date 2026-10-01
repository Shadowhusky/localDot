export interface GridMesh {
  cells: [number, number][];
  uvs: number[];
  triangles: number[];
  hull: number;
}

// Spine expects the hull (outline) vertices first, in order around the edge.
export function gridMesh(cols: number, rows: number): GridMesh {
  const ring: [number, number][] = [];
  for (let i = 0; i <= cols; i++) ring.push([i, 0]);
  for (let j = 1; j <= rows; j++) ring.push([cols, j]);
  for (let i = cols - 1; i >= 0; i--) ring.push([i, rows]);
  for (let j = rows - 1; j > 0; j--) ring.push([0, j]);
  const interior: [number, number][] = [];
  for (let j = 1; j < rows; j++) for (let i = 1; i < cols; i++) interior.push([i, j]);
  const cells = [...ring, ...interior];
  const index = new Map(cells.map(([i, j], k) => [`${i},${j}`, k]));
  const at = (i: number, j: number) => index.get(`${i},${j}`) as number;
  const triangles: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i, j + 1);
      const d = at(i + 1, j + 1);
      triangles.push(a, c, b, b, c, d);
    }
  }
  return {
    cells,
    uvs: cells.flatMap(([i, j]) => [i / cols, j / rows]),
    triangles,
    hull: ring.length,
  };
}
