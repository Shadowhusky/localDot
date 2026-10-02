import { describe, expect, it } from "vitest";
import { meanLuma } from "./probe.ts";

// A VideoFrame stand-in: I444 with a Y plane whose stride is wider than the rect.
function fakeFrame(width: number, height: number, fill: (x: number, y: number) => number) {
  const stride = width + 16;
  const plane = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) plane[y * stride + x] = fill(x, y);
  return {
    format: "I444",
    codedWidth: width,
    codedHeight: height,
    allocationSize: (opts: { rect: { x: number; y: number; width: number; height: number } }) =>
      opts.rect.width * opts.rect.height * 3,
    copyTo: async (
      buf: Uint8Array,
      opts: { rect: { x: number; y: number; width: number; height: number } },
    ) => {
      const r = opts.rect;
      for (let y = 0; y < r.height; y++)
        for (let x = 0; x < r.width; x++)
          buf[y * r.width + x] = plane[(r.y + y) * stride + r.x + x] as number;
      return [{ offset: 0, stride: r.width }];
    },
  } as unknown as VideoFrame;
}

describe("meanLuma", () => {
  it("averages the luma plane over the rect", async () => {
    const frame = fakeFrame(64, 64, (x) => (x < 32 ? 0 : 200));
    expect(await meanLuma(frame, { x: 0, y: 0, width: 32, height: 32 })).toBe(0);
    expect(await meanLuma(frame, { x: 32, y: 0, width: 32, height: 32 })).toBe(200);
    expect(await meanLuma(frame, { x: 16, y: 0, width: 32, height: 32 })).toBe(100);
  });
});
