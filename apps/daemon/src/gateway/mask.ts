import type { Rect } from "@localdot/protocol";
import { raster } from "../raster.ts";

// What covers another task's window in a frame: a flat grey, which nothing on a desktop shows.
const COVER = { r: 0x5b, g: 0x5e, b: 0x66 };

// A 1280×800 observe frame with these screen-pixel parts covered, still lossless WebP.
export async function maskFrame(
  image: Buffer,
  hidden: readonly Rect[],
  scale: number,
): Promise<Buffer> {
  const boxes = hidden.flatMap((r) => {
    const x = Math.max(0, Math.floor(r.x / scale));
    const y = Math.max(0, Math.floor(r.y / scale));
    const w = Math.min(1280, Math.ceil((r.x + r.w) / scale)) - x;
    const h = Math.min(800, Math.ceil((r.y + r.h) / scale)) - y;
    return w > 0 && h > 0 ? [{ x, y, w, h }] : [];
  });
  if (!boxes.length) return image;
  return (await raster(image))
    .composite(
      boxes.map((b) => ({
        input: { create: { width: b.w, height: b.h, channels: 3 as const, background: COVER } },
        left: b.x,
        top: b.y,
      })),
    )
    .webp({ lossless: true })
    .toBuffer();
}

// The same frame at the screen's device resolution, for people only: the screen-pixel parts
// covered as in the model's frame, then lossy, which keeps it near the model's size on disk.
export async function maskFullFrame(image: Buffer, hidden: readonly Rect[]): Promise<Buffer> {
  const picture = await raster(image);
  const { width = 0, height = 0 } = await picture.metadata();
  const boxes = hidden.flatMap((r) => {
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const w = Math.min(width, Math.ceil(r.x + r.w)) - x;
    const h = Math.min(height, Math.ceil(r.y + r.h)) - y;
    return w > 0 && h > 0 ? [{ x, y, w, h }] : [];
  });
  return picture
    .composite(
      boxes.map((b) => ({
        input: { create: { width: b.w, height: b.h, channels: 3 as const, background: COVER } },
        left: b.x,
        top: b.y,
      })),
    )
    .webp({ quality: 85, smartSubsample: true })
    .toBuffer();
}
