import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { FrameStore } from "../gateway/frames.ts";

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Real pixels for a zoom: the screen's own device-resolution capture of the frame, while the
// screen still holds it.
export interface FrameDetail {
  zoom(
    sessionId: string,
    frameId: string,
    region: Region,
    signal?: AbortSignal,
  ): Promise<Buffer | undefined>;
}

const fit = (image: Buffer) =>
  sharp(image, { limitInputPixels: 2560 * 1600 }).resize(1280, 800, { fit: "inside" });

// Screenshots go to the model as PNG (P4a-R27: keyd sizes PNG and JPEG for the budget), from the
// WebP observe frames the gateway stores. A zoom crops a region of a frame (model pixels) and
// scales it to fit 1280×800, so small text becomes legible: from the screen's device-resolution
// capture when it still has that frame, else by enlarging the stored 1280×800 frame.
export class FramePng {
  constructor(
    private readonly frames: Pick<FrameStore, "path">,
    private readonly detail?: FrameDetail,
  ) {}

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
      const box = { x: left, y: top, w: width, h: height };
      const device = await this.detail
        ?.zoom(sessionId, frameId, box, signal)
        .catch(() => undefined);
      signal?.throwIfAborted();
      if (device) {
        const result = await fit(device).png({ compressionLevel: 6 }).toBuffer();
        signal?.throwIfAborted();
        return result;
      }
      const cropped = await image.extract({ left, top, width, height }).png().toBuffer();
      signal?.throwIfAborted();
      image = fit(cropped);
    }
    signal?.throwIfAborted();
    const result = await image.png({ compressionLevel: 6 }).toBuffer();
    signal?.throwIfAborted();
    return result;
  }
}
