// A uniform value in [0, 1) from two integers, so per-cycle variation needs no stored draws.
export function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

// A lognormal draw (Box–Muller) from two uniform draws of next().
export function lognormal(next: () => number, median: number, sigma: number): number {
  const u1 = Math.max(1e-9, next());
  const u2 = next();
  return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
}
