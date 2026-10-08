import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { FrameStore } from "../gateway/frames.ts";
import { type FrameDetail, FramePng, type Region } from "./frame-png.ts";

const solid = (width: number, height: number, r: number, g: number, b: number) =>
  sharp({ create: { width, height, channels: 3, background: { r, g, b } } });

async function stored() {
  const frames = new FrameStore(mkdtempSync(join(tmpdir(), "local dot's frames-")));
  const sessionId = ulid();
  const frameId = ulid();
  frames.save(
    sessionId,
    frameId,
    await solid(1280, 800, 255, 0, 0).webp({ lossless: true }).toBuffer(),
  );
  return { frames, sessionId, frameId };
}

async function look(png: Buffer) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    centre: [
      ...data.subarray(((info.height >> 1) * info.width + (info.width >> 1)) * 3).subarray(0, 3),
    ],
  };
}

describe("FramePng zoom", () => {
  it("reads a zoom from the screen's device-resolution pixels when it still has the frame", async () => {
    const { frames, sessionId, frameId } = await stored();
    const asked: [string, string, Region][] = [];
    const detail: FrameDetail = {
      zoom: async (s, f, region) => {
        asked.push([s, f, region]);
        return solid(region.w * 2, region.h * 2, 0, 0, 255)
          .png()
          .toBuffer();
      },
    };
    const out = await look(
      await new FramePng(frames, detail).png(sessionId, frameId, {
        x: 1275.6,
        y: 10,
        w: 90,
        h: 40,
      }),
    );
    expect(asked).toEqual([[sessionId, frameId, { x: 1272, y: 10, w: 8, h: 40 }]]);
    expect(out).toEqual({ width: 160, height: 800, centre: [0, 0, 255] });
  });

  it("enlarges the stored frame when the screen no longer has it or cannot answer", async () => {
    const { frames, sessionId, frameId } = await stored();
    for (const detail of [
      { zoom: async () => undefined },
      {
        zoom: async () => {
          throw new Error("desktopd 503");
        },
      },
      undefined,
    ]) {
      const out = await look(
        await new FramePng(frames, detail).png(sessionId, frameId, { x: 0, y: 0, w: 640, h: 400 }),
      );
      expect(out).toEqual({ width: 1280, height: 800, centre: [255, 0, 0] });
    }
  });

  it("never asks the screen for a whole frame, a missing frame or after a Stop", async () => {
    const { frames, sessionId, frameId } = await stored();
    let asked = 0;
    const png = new FramePng(frames, {
      zoom: async () => {
        asked++;
        return undefined;
      },
    });
    expect((await look(await png.png(sessionId, frameId))).width).toBe(1280);
    await expect(png.png(sessionId, ulid(), { x: 0, y: 0, w: 8, h: 8 })).rejects.toThrow(
      /no frame/,
    );
    const stop = new AbortController();
    stop.abort();
    await expect(
      png.png(sessionId, frameId, { x: 0, y: 0, w: 8, h: 8 }, stop.signal),
    ).rejects.toThrow();
    expect(asked).toBe(0);
  });
});
