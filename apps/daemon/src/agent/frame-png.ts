import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { FrameStore } from "../gateway/frames.ts";

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Screenshots go to the model as PNG (P4a-R27: keyd sizes PNG and JPEG for the budget), from the
// WebP observe frames the gateway stores. A zoom crops a region of a frame (model pixels) and
// scales it up to fit 1280×800, so small text becomes legible.
export class FramePng {
  constructor(private readonly frames: Pick<FrameStore, "path">) {}

  async png(
    sessionId: string,
    frameId: string,
    region?: Region,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    signal?.throwIfAborted();
    const file = this.frames.path(sessionId, frameId);
    if (!file) throw new Error(`no frame ${frameId}`);
    let image = sharp(readFileSync(file)).resize(1280, 800, { fit: "fill" });
    if (region) {
      const left = Math.max(0, Math.min(1272, Math.round(region.x)));
      const top = Math.max(0, Math.min(792, Math.round(region.y)));
      const width = Math.max(8, Math.min(1280 - left, Math.round(region.w)));
      const height = Math.max(8, Math.min(800 - top, Math.round(region.h)));
      const cropped = await image.extract({ left, top, width, height }).png().toBuffer();
      signal?.throwIfAborted();
      image = sharp(cropped).resize(1280, 800, { fit: "inside" });
    }
    signal?.throwIfAborted();
    const result = await image.png({ compressionLevel: 6 }).toBuffer();
    signal?.throwIfAborted();
    return result;
  }
}
