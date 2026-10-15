import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { NotRaster } from "../../raster.ts";
import { toJpeg } from "./picture.ts";

const canvas = () =>
  sharp({ create: { width: 900, height: 600, channels: 4, background: "#c22" } });

describe("pictures from the web", () => {
  it("makes a small JPEG of a PNG, JPEG, GIF or WebP", async () => {
    for (const bytes of [
      await canvas().png().toBuffer(),
      await canvas().jpeg().toBuffer(),
      await canvas().gif().toBuffer(),
      await canvas().webp().toBuffer(),
    ]) {
      const picture = await toJpeg(bytes, 512);
      expect([picture.width, picture.height]).toEqual([512, 341]);
      expect((await sharp(picture.data).metadata()).format).toBe("jpeg");
    }
  });

  it("refuses SVG, TIFF and HEIF served as image/* without decoding them", async () => {
    for (const bytes of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>'),
      await canvas().tiff().toBuffer(),
      await canvas().avif().toBuffer(),
      await canvas().heif({ compression: "av1" }).toBuffer(),
    ])
      await expect(toJpeg(bytes, 512)).rejects.toBeInstanceOf(NotRaster);
  });
});
