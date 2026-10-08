import { emptyModel } from "@localdot/stage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PixiPresenter } from "../stage/pixi-presenter.ts";
import { ReplayProbe } from "./probe.ts";

function fixture() {
  const closed: number[] = [];
  let serial = 0;
  const makeFrame = (): VideoFrame => {
    const id = ++serial;
    return {
      format: "I420",
      displayWidth: 32,
      displayHeight: 16,
      allocationSize: () => 16 * 40 + 8,
      async copyTo(target: Uint8Array) {
        for (let row = 0; row < 16; row++) {
          target.fill(25, 8 + row * 40, 8 + row * 40 + 16);
          target.fill(180, 8 + row * 40 + 16, 8 + row * 40 + 32);
        }
        return [{ offset: 8, stride: 40 }];
      },
      clone: makeFrame,
      close: () => {
        closed.push(id);
      },
    } as unknown as VideoFrame;
  };
  const extract = vi.fn(() => new Uint8ClampedArray([0, 0, 0, 255]));
  return {
    probe: new ReplayProbe(),
    closed,
    frame: makeFrame(),
    context: {
      presenter: { extract } as unknown as PixiPresenter,
      model: emptyModel(),
      view: { reducedMotion: true },
      camera: { scale: 1, tx: 0, ty: 0 },
      viewport: { w: 1, h: 1 },
      stats: { openFrames: 2, decodeQueue: 0, seeks: 1, decoded: 2 },
    },
    extract,
  };
}

describe("ReplayProbe", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("samples the presented video without overlays and releases its temporary frame", async () => {
    const setup = fixture();
    const drawImage = vi.fn();
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray([25, 30, 40, 255]) }));
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return { drawImage, getImageData };
        }
      },
    );
    await setup.probe.handle({ id: 1, op: "enable" }, setup.context);
    setup.probe.present(setup.frame, "video");
    expect(await setup.probe.handle({ id: 2, op: "thumb", w: 1, h: 1 }, setup.context)).toEqual([
      25, 30, 40, 255,
    ]);
    expect(drawImage).toHaveBeenCalledWith(
      expect.objectContaining({ displayWidth: 32 }),
      0,
      0,
      1,
      1,
    );
    expect(getImageData).toHaveBeenCalledWith(0, 0, 1, 1);
    expect(setup.extract).not.toHaveBeenCalled();
    expect(setup.closed).toEqual([3]);
    setup.probe.close();
    expect(setup.closed).toEqual([3, 2]);
  });

  it("rejects unbounded thumbnails and closes the temporary frame when drawing fails", async () => {
    const setup = fixture();
    await setup.probe.handle({ id: 1, op: "enable" }, setup.context);
    setup.probe.present(setup.frame, "video");
    await expect(
      setup.probe.handle({ id: 2, op: "thumb", w: 1025, h: 1 }, setup.context),
    ).rejects.toThrow("Invalid thumbnail");
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return {
            drawImage() {
              throw new Error("drawing failed");
            },
          };
        }
      },
    );
    await expect(
      setup.probe.handle({ id: 3, op: "thumb", w: 1, h: 1 }, setup.context),
    ).rejects.toThrow("drawing failed");
    expect(setup.closed).toEqual([3, 4]);
    setup.probe.close();
  });

  it("keeps no extra frame while disabled and uses the returned luma plane stride", async () => {
    const setup = fixture();
    setup.probe.present(setup.frame, "video");
    expect(await setup.probe.handle({ id: 1, op: "stats" }, setup.context)).toEqual({
      error: "Replay probe is disabled.",
    });
    expect(setup.closed).toEqual([]);
    await setup.probe.handle({ id: 2, op: "enable" }, setup.context);
    setup.probe.present(setup.frame, "video");
    expect(
      await setup.probe.handle({ id: 3, op: "mb-luma", widthMbs: 2, heightMbs: 1 }, setup.context),
    ).toEqual([25, 180]);
    setup.probe.present(null, "backdrop");
    expect(
      await setup.probe.handle({ id: 4, op: "mb-luma", widthMbs: 2, heightMbs: 1 }, setup.context),
    ).toBeNull();
    expect(await setup.probe.handle({ id: 5, op: "stats" }, setup.context)).toEqual({
      ...setup.context.stats,
      source: "backdrop",
    });
    setup.probe.close();
    expect(setup.closed).toEqual([3, 2]);
  });

  it("closes temporary frames on invalid grids and hashes overlays independently", async () => {
    const setup = fixture();
    await setup.probe.handle({ id: 1, op: "enable" }, setup.context);
    setup.probe.present(setup.frame, "video");
    await expect(
      setup.probe.handle({ id: 2, op: "mb-luma", widthMbs: 3, heightMbs: 1 }, setup.context),
    ).rejects.toThrow("Invalid macroblock grid");
    const first = await setup.probe.handle({ id: 3, op: "overlay-hash", tMs: 0 }, setup.context);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await setup.probe.handle({ id: 4, op: "overlay-hash", tMs: 0 }, setup.context)).toBe(
      first,
    );
    expect(setup.extract.mock.calls).toHaveLength(2);
    setup.probe.close();
    expect(setup.closed).toEqual([3, 2]);
  });
});
