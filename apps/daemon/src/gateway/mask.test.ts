import sharp from "sharp";
import { expect, it } from "vitest";
import { maskFrame } from "./mask.ts";

it("covers screen-pixel parts of a model frame at the screen's scale, losslessly", async () => {
  const frame = await sharp({
    create: { width: 1280, height: 800, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .webp({ lossless: true })
    .toBuffer();
  expect(await maskFrame(frame, [], 2)).toBe(frame);
  const masked = await maskFrame(frame, [{ x: 200, y: 100, w: 400, h: 200 }], 2);
  const pixels = await sharp(masked).removeAlpha().raw().toBuffer();
  const at = (x: number, y: number) => pixels[(y * 1280 + x) * 3] as number;
  expect(at(100, 50)).toBe(0x5b);
  expect(at(299, 149)).toBe(0x5b);
  expect(at(99, 50)).toBe(255);
  expect(at(300, 150)).toBe(255);
});
