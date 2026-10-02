export interface Rgba {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

export interface LumaFrame {
  t: number;
  presented: number;
  actionId: string;
  luma: Uint8Array;
}

// Sum of absolute colour differences over the template's opaque pixels (alpha ≥ 128) at every
// offset where the template fits; the best mean difference wins when it is under the limit.
export function locateTemplate(
  crop: Rgba,
  template: Rgba,
  tipInTemplate: { x: number; y: number },
  maxMeanDiff = 40,
): { tip: { x: number; y: number }; score: number } | null {
  const opaque: [number, number][] = [];
  for (let y = 0; y < template.h; y++)
    for (let x = 0; x < template.w; x++)
      if ((template.data[(y * template.w + x) * 4 + 3] ?? 0) >= 128) opaque.push([x, y]);
  if (opaque.length === 0) return null;
  let best: { x: number; y: number; score: number } | null = null;
  for (let oy = 0; oy + template.h <= crop.h; oy++) {
    for (let ox = 0; ox + template.w <= crop.w; ox++) {
      let sum = 0;
      for (const [tx, ty] of opaque) {
        const ti = (ty * template.w + tx) * 4;
        const ci = ((oy + ty) * crop.w + ox + tx) * 4;
        const alphaMiss = (crop.data[ci + 3] ?? 0) < 128 ? 255 : 0;
        sum +=
          alphaMiss +
          Math.abs((template.data[ti] ?? 0) - (crop.data[ci] ?? 0)) +
          Math.abs((template.data[ti + 1] ?? 0) - (crop.data[ci + 1] ?? 0)) +
          Math.abs((template.data[ti + 2] ?? 0) - (crop.data[ci + 2] ?? 0));
      }
      const score = sum / (opaque.length * 3);
      if (!best || score < best.score) best = { x: ox, y: oy, score };
    }
  }
  if (!best || best.score > maxMeanDiff) return null;
  return { tip: { x: best.x + tipInTemplate.x, y: best.y + tipInTemplate.y }, score: best.score };
}

export function countColour(
  crop: Rgba,
  rgb: [number, number, number],
  tol: number,
  mask?: (x: number, y: number) => boolean,
): number {
  let n = 0;
  for (let y = 0; y < crop.h; y++) {
    for (let x = 0; x < crop.w; x++) {
      if (mask && !mask(x, y)) continue;
      const i = (y * crop.w + x) * 4;
      if ((crop.data[i + 3] ?? 0) < 128) continue;
      if (
        Math.abs((crop.data[i] ?? 0) - rgb[0]) <= tol &&
        Math.abs((crop.data[i + 1] ?? 0) - rgb[1]) <= tol &&
        Math.abs((crop.data[i + 2] ?? 0) - rgb[2]) <= tol
      )
        n += 1;
    }
  }
  return n;
}

export function ringBandMask(
  cx: number,
  cy: number,
  rMin: number,
  rMax: number,
): (x: number, y: number) => boolean {
  return (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    return r >= rMin && r <= rMax;
  };
}

// True for points farther than `pad` from every edge of `rect`, inside or outside it: the target
// box's stroke and halo run along those edges and must not count as ring pixels.
export function awayFromRectEdge(
  rect: { x: number; y: number; w: number; h: number },
  pad: number,
): (x: number, y: number) => boolean {
  return (x, y) => {
    const inside = x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
    if (inside)
      return Math.min(x - rect.x, rect.x + rect.w - x, y - rect.y, rect.y + rect.h - y) > pad;
    const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.w));
    const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.h));
    return Math.hypot(dx, dy) > pad;
  };
}

// True outside `rect` grown by `pad` on every side.
export function outsideRect(
  rect: { x: number; y: number; w: number; h: number },
  pad: number,
): (x: number, y: number) => boolean {
  return (x, y) =>
    x < rect.x - pad || x > rect.x + rect.w + pad || y < rect.y - pad || y > rect.y + rect.h + pad;
}

// The arrow's footprint around its tip at `dpr`: x −2…20, y −2…25 CSS px (geometry.ts, the 12°
// tilt, the rim and the halo), grown by 2 px for the xenon stroke. Its own accent stroke must
// never count as ring pixels.
export function arrowRect(
  tip: { x: number; y: number },
  dpr: number,
): { x: number; y: number; w: number; h: number } {
  return { x: tip.x - 2 * dpr - 2, y: tip.y - 2 * dpr - 2, w: 22 * dpr + 4, h: 27 * dpr + 4 };
}

// The coordinates-only marker (18 px ring with 1.5 px stroke, four arms from 14 to 24 px) in
// crop pixels at `dpr`; true where its pixels can lie.
export function crosshairMask(
  cx: number,
  cy: number,
  dpr: number,
): (x: number, y: number) => boolean {
  return (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    if (r >= 16.5 * dpr && r <= 19.5 * dpr) return true;
    const onArm =
      (Math.abs(x - cx) <= 1.5 * dpr || Math.abs(y - cy) <= 1.5 * dpr) &&
      r >= 13 * dpr &&
      r <= 25 * dpr;
    return onArm || r <= 3 * dpr;
  };
}

// The first frame whose luma differs from the mean of the first `baselineCount` frames by more
// than `threshold` on average: the frame that shows the control's change.
export function firstChange(
  frames: LumaFrame[],
  baselineCount: number,
  threshold = 8,
): LumaFrame | undefined {
  const base = frames.slice(0, baselineCount);
  if (base.length === 0 || frames.length <= baselineCount) return undefined;
  const n = base[0]?.luma.length ?? 0;
  const mean = new Float32Array(n);
  for (const f of base)
    for (let i = 0; i < n; i++) mean[i] = (mean[i] ?? 0) + (f.luma[i] ?? 0) / base.length;
  for (const f of frames.slice(baselineCount)) {
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs((f.luma[i] ?? 0) - (mean[i] ?? 0));
    if (diff / n > threshold) return f;
  }
  return undefined;
}
