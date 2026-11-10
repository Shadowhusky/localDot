import { describe, expect, it, vi } from "vitest";
import { raster } from "../../raster.ts";
import { type FreshLookDeps, freshDesktopLook } from "./screen.ts";

const WHITE = { r: 255, g: 255, b: 255 };
const COVER = [0x5b, 0x5e, 0x66];

async function screenImage() {
  const sharp = (await import("sharp")).default;
  const png = await sharp({
    create: { width: 1280, height: 800, channels: 3, background: WHITE },
  })
    .webp({ lossless: true })
    .toBuffer();
  return png.toString("base64");
}
const windowAt = (id: number, x: number) => ({
  id,
  pid: 1,
  cls: "c",
  title: "t",
  rect: { x, y: 0, w: 100, h: 100 },
  frame: { x, y: 0, w: 100, h: 100 },
  active: false,
  overrideRedirect: false,
  transientFor: null,
});
async function deps(more: Partial<FreshLookDeps> = {}) {
  const image = await screenImage();
  const observe = vi.fn(async () => ({
    frameId: "f",
    width: 1280,
    height: 800,
    image,
    pointer: { x: 0, y: 0 },
    windows: [windowAt(1, 0), windowAt(2, 200), windowAt(3, 400)],
  }));
  const value: FreshLookDeps = {
    sessionId: "s",
    cellId: "c",
    onDesktop: () => true,
    acting: () => false,
    device: () => ({ client: { observe } as never }),
    // 1 is the task's own, 2 another task's, 3 too new to tell.
    owners: () => ({
      foreign: (_task: string, id: number | null | undefined) => id === 2,
      known: (id: number) => id !== 3,
    }),
    scale: () => 1,
    ...more,
  };
  return { value, observe };
}
async function pixel(png: Buffer, x: number, y: number) {
  const { data, info } = await (await raster(png)).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at], data[at + 1], data[at + 2]];
}
const signal = new AbortController().signal;

describe("a new look at the screen", () => {
  it("covers other tasks' windows and windows too new to tell, as dot's observations do", async () => {
    const { value } = await deps();
    const png = await freshDesktopLook(value, 60_000, signal);
    expect(png).toBeDefined();
    expect(await pixel(png as Buffer, 50, 50)).toEqual([255, 255, 255]);
    expect(await pixel(png as Buffer, 250, 50)).toEqual(COVER);
    expect(await pixel(png as Buffer, 450, 50)).toEqual(COVER);
  });

  it.each([
    ["the task isn't on the desktop, or the user has the computer", { onDesktop: () => false }],
    ["someone is acting on the computer", { acting: () => true }],
    ["the computer can't be reached", { device: () => undefined }],
  ])("isn't taken when %s", async (_why, more) => {
    const { value, observe } = await deps(more);
    await expect(freshDesktopLook(value, 60_000, signal)).resolves.toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
  });

  it("isn't taken when dot's own last look is fresh", async () => {
    const { value, observe } = await deps();
    await expect(freshDesktopLook(value, 3_000, signal)).resolves.toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
  });

  it("is taken when dot hasn't looked at all", async () => {
    const { value, observe } = await deps();
    await expect(freshDesktopLook(value, undefined, signal)).resolves.toBeDefined();
    expect(observe).toHaveBeenCalledOnce();
  });
});
