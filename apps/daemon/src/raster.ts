import sharp, { type Metadata, type Sharp, type SharpOptions } from "sharp";

export type RasterFormat = "png" | "jpeg" | "gif" | "webp";

export class NotRaster extends Error {
  constructor() {
    super("not a PNG, JPEG, GIF or WebP picture");
  }
}

// PNG, JPEG, GIF and WebP signatures only, checked before libvips sees the bytes, so an SVG, PDF,
// TIFF or HEIF renamed to .png never reaches another loader.
export function rasterType(b: Buffer): RasterFormat | undefined {
  const ascii = (at: number, text: string) =>
    b.subarray(at, at + text.length).toString("latin1") === text;
  if (b[0] === 0x89 && ascii(1, "PNG")) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (ascii(0, "GIF8")) return "gif";
  return ascii(0, "RIFF") && ascii(8, "WEBP") ? "webp" : undefined;
}

// Picture bytes from the web, from dot's computer or from dot itself reach libvips only as PNG,
// JPEG, GIF or WebP: the signature first, then the format libvips reads from the header, so its
// SVG, PDF, TIFF, HEIF/AVIF and other loaders never run on them.
export async function rasterMetadata(input: Buffer, options: SharpOptions = {}): Promise<Metadata> {
  const format = rasterType(input);
  if (!format) throw new NotRaster();
  const metadata = await sharp(input, { ...options, failOn: "error" }).metadata();
  if (metadata.format !== format) throw new NotRaster();
  return metadata;
}

export async function raster(input: Buffer, options: SharpOptions = {}): Promise<Sharp> {
  await rasterMetadata(input, options);
  return sharp(input, { ...options, failOn: "error" });
}
