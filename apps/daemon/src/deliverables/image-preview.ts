import { PREVIEW_LIMITS } from "@localdot/protocol";
import sharp from "sharp";

// The only formats libvips may decode here, on the Mac. SVG, PDF, TIFF, HEIF/AVIF and anything
// else it can sniff are refused, so their loaders never see agent bytes.
const RASTER = new Set(["png", "jpeg", "gif", "webp"]);
export class PreviewRefused extends Error {
  constructor(readonly reason: "attachment" | "too_large") {
    super(reason);
  }
}

// PNG, JPEG, GIF and WebP signatures only, checked before libvips sees the bytes, so an SVG, PDF,
// TIFF or HEIF renamed to .png never reaches another loader.
export function rasterMagic(b: Buffer): boolean {
  const ascii = (at: number, text: string) =>
    b.subarray(at, at + text.length).toString("latin1") === text;
  return (
    (b[0] === 0x89 && ascii(1, "PNG")) ||
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
    ascii(0, "GIF8") ||
    (ascii(0, "RIFF") && ascii(8, "WEBP"))
  );
}

// Re-encodes untrusted image bytes as a metadata-free PNG of at most 1024 px a side and 2 MiB.
export async function previewPng(input: Buffer): Promise<Buffer> {
  const options = {
    limitInputPixels: PREVIEW_LIMITS.imageInputPixels,
    failOn: "error",
    sequentialRead: true,
    animated: false,
  } as const;
  if (!rasterMagic(input)) throw new PreviewRefused("attachment");
  // The header alone says the format and size; nothing is decoded until both are acceptable.
  const meta = await sharp(input).metadata();
  if (!meta.format || !RASTER.has(meta.format)) throw new PreviewRefused("attachment");
  if ((meta.width ?? 0) * (meta.height ?? 0) > PREVIEW_LIMITS.imageInputPixels)
    throw new PreviewRefused("too_large");
  // A noisy picture can exceed the byte cap at 1024 px; 640 px RGBA cannot (640² × 4 < 2 MiB).
  for (const side of [PREVIEW_LIMITS.imagePx, 640]) {
    const png = await sharp(input, options)
      .rotate()
      .resize(side, side, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    if (png.byteLength <= PREVIEW_LIMITS.pngBytes) return png;
  }
  throw new PreviewRefused("too_large");
}
