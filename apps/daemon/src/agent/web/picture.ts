import { raster } from "../../raster.ts";

export interface Picture {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

// A picture as the model sees it: at most `side` pixels a side, as JPEG, which keyd can size for
// the budget; transparency on white, the first frame of an animation, turned upright.
export async function toJpeg(image: Buffer, side: number): Promise<Picture> {
  const { data, info } = await (await raster(image, { limitInputPixels: 50_000_000 }))
    .rotate()
    .resize(side, side, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
