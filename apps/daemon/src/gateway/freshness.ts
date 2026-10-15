import type { Point, Rect } from "@localdot/protocol";
import { raster } from "../raster.ts";

const WIDTH = 1280;
const HEIGHT = 800;
const THRESHOLD = 24;
const FRACTION = 0.02;

export interface FreshnessOptions {
  radius?: number;
  threshold?: number;
  fraction?: number;
}

export async function frameLuma(image: Buffer): Promise<Buffer> {
  const decoded = await (await raster(image, { limitInputPixels: WIDTH * HEIGHT * 4 }))
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer();
  if (decoded.length !== WIDTH * HEIGHT) throw new Error("invalid freshness frame");
  return decoded;
}

function boxAt(point: Point, radius: number): Rect {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new RangeError("freshness point must be finite");
  return {
    x: Math.max(0, Math.min(WIDTH - 2 * radius, Math.round(point.x) - radius)),
    y: Math.max(0, Math.min(HEIGHT - 2 * radius, Math.round(point.y) - radius)),
    w: 2 * radius,
    h: 2 * radius,
  };
}

function clippedBox(box: Rect): Rect {
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0)
    throw new RangeError("invalid freshness target bounds");
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const right = Math.min(WIDTH, Math.ceil(box.x + box.w));
  const bottom = Math.min(HEIGHT, Math.ceil(box.y + box.h));
  if (right <= x || bottom <= y) throw new RangeError("freshness target outside frame");
  return { x, y, w: right - x, h: bottom - y };
}

function eachPixel(box: Rect, visit: (i: number) => void): void {
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++) visit(y * WIDTH + x);
}

function changedFraction(a: Buffer, b: Buffer, box: Rect, threshold: number): number {
  let changed = 0;
  eachPixel(box, (i) => {
    if (Math.abs((a[i] as number) - (b[i] as number)) > threshold) changed++;
  });
  return changed / (box.w * box.h);
}

export function lumaRegionChanged(
  before: Buffer,
  after: Buffer,
  point: Point,
  opts: FreshnessOptions = {},
): { changed: boolean; fraction: number } {
  if (before.length !== WIDTH * HEIGHT || after.length !== WIDTH * HEIGHT)
    throw new RangeError("invalid freshness luma size");
  const radius = opts.radius ?? 48;
  const threshold = opts.threshold ?? THRESHOLD;
  const limit = opts.fraction ?? FRACTION;
  if (!Number.isSafeInteger(radius) || radius < 1 || radius > HEIGHT / 2)
    throw new RangeError("invalid freshness radius");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255)
    throw new RangeError("invalid freshness threshold");
  if (!Number.isFinite(limit) || limit < 0 || limit > 1)
    throw new RangeError("invalid freshness fraction");
  const fraction = changedFraction(before, after, boxAt(point, radius), threshold);
  return { changed: fraction > limit, fraction };
}

export async function regionChanged(
  before: Buffer,
  after: Buffer,
  point: Point,
  opts: FreshnessOptions = {},
): Promise<{ changed: boolean; fraction: number }> {
  const [a, b] = await Promise.all([frameLuma(before), frameLuma(after)]);
  return lumaRegionChanged(a, b, point, opts);
}

// Only a small peripheral animation may be excluded. The center and complete resolved target
// must agree pairwise; no moving pixel in either protected region is masked out.
export function animationKeepsTarget(
  basis: Buffer,
  first: Buffer,
  second: Buffer,
  point: Point,
  target?: Rect,
): boolean {
  if ([basis, first, second].some((frame) => frame.length !== WIDTH * HEIGHT))
    throw new RangeError("invalid freshness luma size");
  const protectedRegions = [boxAt(point, 12), ...(target ? [clippedBox(target)] : [])];
  for (const box of protectedRegions) {
    if (
      changedFraction(basis, first, box, THRESHOLD) > FRACTION ||
      changedFraction(basis, second, box, THRESHOLD) > FRACTION ||
      changedFraction(first, second, box, THRESHOLD) > FRACTION
    )
      return false;
  }
  const outer = boxAt(point, 48);
  let staticFirst = 0;
  let staticSecond = 0;
  let union = 0;
  eachPixel(outer, (i) => {
    const a = Math.abs((basis[i] as number) - (first[i] as number)) > THRESHOLD;
    const b = Math.abs((basis[i] as number) - (second[i] as number)) > THRESHOLD;
    const dynamic = Math.abs((first[i] as number) - (second[i] as number)) > THRESHOLD;
    if (a && !dynamic) staticFirst++;
    if (b && !dynamic) staticSecond++;
    if (a || b || dynamic) union++;
  });
  const area = outer.w * outer.h;
  return staticFirst / area <= FRACTION && staticSecond / area <= FRACTION && union / area <= 0.2;
}
