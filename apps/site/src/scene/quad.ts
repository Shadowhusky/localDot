export type Point2 = readonly [number, number];
// A CSS matrix3d's sixteen values, column by column.
export type Matrix3d = readonly number[];

// The projective map taking the unit square's corners (0,0) (1,0) (1,1) (0,1) to the quad's, as
// [a b c; d e f; g h 1] (Heckbert's square-to-quad).
function squareToQuad(q: readonly Point2[]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q as [Point2, Point2, Point2, Point2];
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0];
  }
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

// The matrix3d that lays an element of w × h (transform-origin 0 0) onto the quad, corners in
// order: top left, top right, bottom right, bottom left.
export function quadMatrix(w: number, h: number, quad: readonly Point2[]): Matrix3d {
  const [a, b, c, d, e, f, g, hh] = squareToQuad(quad) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  // Element pixels to the unit square first.
  const A = a / w;
  const B = b / h;
  const D = d / w;
  const E = e / h;
  const G = g / w;
  const Hh = hh / h;
  return [A, D, 0, G, B, E, 0, Hh, 0, 0, 1, 0, c, f, 0, 1];
}

export function applyMatrix3d(m: Matrix3d, x: number, y: number): [number, number] {
  const X = (m[0] as number) * x + (m[4] as number) * y + (m[12] as number);
  const Y = (m[1] as number) * x + (m[5] as number) * y + (m[13] as number);
  const W = (m[3] as number) * x + (m[7] as number) * y + (m[15] as number);
  return [X / W, Y / W];
}

// Under half a pixel from its own box, an element keeps no transform at all: a 3D transform would
// put its text through the compositor and soften it.
const AT_REST_PX = 0.5;

export function quadCss(w: number, h: number, quad: readonly Point2[]): string {
  const own: Point2[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const resting = quad.every(
    ([x, y], i) =>
      Math.abs(x - (own[i]?.[0] ?? 0)) < AT_REST_PX &&
      Math.abs(y - (own[i]?.[1] ?? 0)) < AT_REST_PX,
  );
  if (resting) return "none";
  return `matrix3d(${quadMatrix(w, h, quad)
    .map((v) => (Math.abs(v) < 1e-12 ? "0" : v.toPrecision(10)))
    .join(",")})`;
}
