import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0);
  return Buffer.concat([head, data, crc]);
}

// 8-bit RGB with the Sub filter on every row: screenshots are mostly runs of one colour.
export function encodePng(rgb: Buffer, width: number, height: number): Buffer {
  const row = width * 3;
  if (rgb.length !== row * height) throw new RangeError("png: pixel count does not match the size");
  const rows = Buffer.allocUnsafe((row + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * row;
    const dst = y * (row + 1);
    rows[dst] = 1;
    for (let i = 0; i < row; i++)
      rows[dst + 1 + i] =
        ((rgb[src + i] as number) - (i < 3 ? 0 : (rgb[src + i - 3] as number))) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 3 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
