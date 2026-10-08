import { emptyModel } from "@localdot/stage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PixiPresenter } from "../stage/pixi-presenter.ts";
import { ReplayProbe } from "./probe.ts";

function setup() {
  const closed: number[] = [];
  let id = 0;
  const frame = (): VideoFrame => {
    const current = ++id;
    return { clone: frame, close: () => closed.push(current) } as unknown as VideoFrame;
  };
  const probe = new ReplayProbe();
  const source = frame();
  return {
    probe,
    source,
    closed,
    context: {
      presenter: {} as PixiPresenter,
      model: emptyModel(),
      view: { reducedMotion: true },
      camera: { scale: 1, tx: 0, ty: 0 },
      viewport: { w: 1, h: 1 },
      stats: { openFrames: 0, decodeQueue: 0, seeks: 0, decoded: 0 },
    },
  };
}
const canvas = vi.fn();
const draw = vi.fn();
const pixels = vi.fn(() => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(w: number, h: number) {
        canvas(w, h);
      }
      getContext() {
        return { drawImage: draw, getImageData: pixels };
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("independent thumbnail ownership and bounds", () => {
  it("refuses disabled probes and returns null for nonvideo holds without touching canvas or frames", async () => {
    const s = setup();
    s.probe.present(s.source, "video");
    expect(await s.probe.handle({ id: 1, op: "thumb", w: 1, h: 1 }, s.context)).toEqual({
      error: "Replay probe is disabled.",
    });
    expect(canvas).not.toHaveBeenCalled();
    expect(s.closed).toEqual([]);
    await s.probe.handle({ id: 2, op: "enable" }, s.context);
    s.probe.present(s.source, "video");
    s.probe.present(null, "none");
    expect(await s.probe.handle({ id: 3, op: "thumb", w: 1, h: 1 }, s.context)).toBeNull();
    s.probe.present(s.source, "backdrop");
    expect(await s.probe.handle({ id: 4, op: "thumb", w: 1, h: 1 }, s.context)).toBeNull();
    expect(canvas).not.toHaveBeenCalled();
    expect(s.closed).toEqual([2]);
    s.probe.close();
    expect(s.closed).toEqual([2]);
  });
  it.each([
    [0, 1],
    [1, 0],
    [-1, 1],
    [1, -1],
    [0.5, 1],
    [1, 0.5],
    [Number.NaN, 1],
    [1, Infinity],
    [1025, 1],
    [1, 1025],
  ])("rejects dimensions %s × %s and closes only the temporary clone", async (w, h) => {
    const s = setup();
    await s.probe.handle({ id: 1, op: "enable" }, s.context);
    s.probe.present(s.source, "video");
    await expect(s.probe.handle({ id: 2, op: "thumb", w, h }, s.context)).rejects.toThrow(
      RangeError,
    );
    expect(canvas).not.toHaveBeenCalled();
    expect(s.closed).toEqual([3]);
    s.probe.close();
    expect(s.closed).toEqual([3, 2]);
  });
  it("accepts the declared upper bound and retains the displayed owner for a second sample", async () => {
    const s = setup();
    await s.probe.handle({ id: 1, op: "enable" }, s.context);
    s.probe.present(s.source, "video");
    expect(await s.probe.handle({ id: 2, op: "thumb", w: 1024, h: 1024 }, s.context)).toEqual([
      10, 20, 30, 255,
    ]);
    expect(canvas).toHaveBeenCalledWith(1024, 1024);
    expect(pixels).toHaveBeenCalledWith(0, 0, 1024, 1024);
    expect(await s.probe.handle({ id: 3, op: "thumb", w: 1, h: 1 }, s.context)).toEqual([
      10, 20, 30, 255,
    ]);
    expect(s.closed).toEqual([3, 4]);
    s.probe.close();
    s.probe.close();
    expect(s.closed).toEqual([3, 4, 2]);
  });
  it.each(["missing-context", "pixel-read"])(
    "cleans up %s failure without retiring the stored frame",
    async (failure) => {
      vi.stubGlobal(
        "OffscreenCanvas",
        class {
          getContext() {
            return failure === "missing-context"
              ? null
              : {
                  drawImage: draw,
                  getImageData() {
                    throw new Error("read unavailable");
                  },
                };
          }
        },
      );
      const s = setup();
      await s.probe.handle({ id: 1, op: "enable" }, s.context);
      s.probe.present(s.source, "video");
      await expect(s.probe.handle({ id: 2, op: "thumb", w: 1, h: 1 }, s.context)).rejects.toThrow();
      expect(s.closed).toEqual([3]);
      s.probe.close();
      expect(s.closed).toEqual([3, 2]);
    },
  );
});
