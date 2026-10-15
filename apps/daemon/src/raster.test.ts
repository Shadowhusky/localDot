import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotRaster, raster, rasterMetadata } from "./raster.ts";

const canvas = () => sharp({ create: { width: 12, height: 8, channels: 3, background: "#36f" } });
const pictures = {
  png: await canvas().png().toBuffer(),
  jpeg: await canvas().jpeg().toBuffer(),
  gif: await canvas().gif().toBuffer(),
  webp: await canvas().webp().toBuffer(),
};
// Each of these but HEIC, BMP and PDF is a picture this libvips would otherwise decode.
const others = {
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"/>'),
  tiff: await canvas().tiff().toBuffer(),
  avif: await canvas().avif().toBuffer(),
  heif: await canvas().heif({ compression: "av1" }).toBuffer(),
  heic: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]),
  bmp: Buffer.concat([Buffer.from("BM"), Buffer.alloc(56)]),
  pdf: Buffer.from("%PDF-1.7\n"),
};
const prototype = sharp.prototype as { metadata(): unknown; toBuffer(): unknown };
afterEach(() => vi.restoreAllMocks());

describe("raster", () => {
  it.each(Object.entries(pictures))("decodes a %s", async (format, bytes) => {
    expect((await rasterMetadata(bytes)).format).toBe(format);
    const { info } = await (await raster(bytes)).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([12, 8]);
  });

  it.each(Object.entries(others))("refuses %s before libvips reads any of it", async (_, bytes) => {
    const header = vi.spyOn(prototype, "metadata");
    const decode = vi.spyOn(prototype, "toBuffer");
    await expect(raster(bytes)).rejects.toBeInstanceOf(NotRaster);
    await expect(rasterMetadata(bytes)).rejects.toBeInstanceOf(NotRaster);
    expect(header).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it("refuses a picture's signature in front of something else", async () => {
    await expect(
      raster(Buffer.concat([pictures.png.subarray(0, 8), others.svg])),
    ).rejects.toThrow();
    await expect(
      raster(Buffer.concat([pictures.gif.subarray(0, 6), others.tiff])),
    ).rejects.toThrow();
  });

  it("keeps the caller's pixel limit", async () => {
    await expect(raster(pictures.png, { limitInputPixels: 50 })).rejects.toThrow(/pixel limit/);
  });
});
