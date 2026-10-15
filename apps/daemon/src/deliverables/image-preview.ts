import { PREVIEW_LIMITS } from "@localdot/protocol";
import { NotRaster, raster, rasterMetadata } from "../raster.ts";

export { rasterType } from "../raster.ts";

export class PreviewRefused extends Error {
  constructor(readonly reason: "attachment" | "too_large") {
    super(reason);
  }
}

// Re-encodes untrusted image bytes as a metadata-free PNG of at most 1024 px a side and 2 MiB.
export async function previewPng(input: Buffer): Promise<Buffer> {
  const options = {
    limitInputPixels: PREVIEW_LIMITS.imageInputPixels,
    sequentialRead: true,
    animated: false,
  } as const;
  // The header alone says the format and size; nothing is decoded until both are acceptable.
  const meta = await rasterMetadata(input).catch((error: unknown) => {
    throw error instanceof NotRaster ? new PreviewRefused("attachment") : error;
  });
  if ((meta.width ?? 0) * (meta.height ?? 0) > PREVIEW_LIMITS.imageInputPixels)
    throw new PreviewRefused("too_large");
  // A noisy picture can exceed the byte cap at 1024 px; 640 px RGBA cannot (640² × 4 < 2 MiB).
  for (const side of [PREVIEW_LIMITS.imagePx, 640]) {
    const png = await (await raster(input, options))
      .rotate()
      .resize(side, side, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    if (png.byteLength <= PREVIEW_LIMITS.pngBytes) return png;
  }
  throw new PreviewRefused("too_large");
}
