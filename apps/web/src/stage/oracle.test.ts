import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { describe, expect, it, vi } from "vitest";
import { OracleCapture } from "./oracle.ts";
import type { PixiPresenter } from "./pixi-presenter.ts";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
let seq = 0;
const ev = (
  type: string,
  tMs: number,
  data: Record<string, unknown>,
  step?: string,
): LocalDotEvent =>
  ({
    v: 1,
    id: ID,
    seq: seq++,
    t: msToMicros(tMs),
    agent: "main",
    ...(step ? { step } : {}),
    type,
    data,
  }) as LocalDotEvent;

// A click whose cursor arrives at 1120 + 400 = 1520 ms, so its capture window opens at 1420 ms.
const clickModel = () =>
  foldEvents(emptyModel(), [
    ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux" }),
    ev(
      "action.intent",
      1000,
      {
        verb: "click",
        label: "Click the page (centre)",
        point: { x: 300, y: 400 },
        risk: "none",
        pointer: {
          from: { x: 100, y: 100 },
          to: { x: 300, y: 400 },
          startsAt: 1120,
          durationMs: 400,
          seed: 1,
          curve: "minjerk-bow-v1",
        },
      },
      "s1",
    ),
  ]);

// A VideoFrame stand-in with a flat luma plane; it records every clone it hands out and every rect
// read from it or its clones.
function fakeFrame(luma: number) {
  const clones: VideoFrame[] = [];
  const rects: { x: number; y: number; width: number; height: number }[] = [];
  const make = (): VideoFrame =>
    ({
      allocationSize: (opts: { rect: { width: number; height: number } }) =>
        opts.rect.width * opts.rect.height,
      copyTo: async (
        buf: Uint8Array,
        opts: { rect: { x: number; y: number; width: number; height: number } },
      ) => {
        rects.push(opts.rect);
        buf.fill(luma);
        return [{ offset: 0, stride: opts.rect.width }];
      },
      clone: () => {
        const c = make();
        clones.push(c);
        return c;
      },
      close: vi.fn(),
    }) as unknown as VideoFrame;
  return { frame: make(), clones, rects };
}

// With this clock sessionMsAt (Task 6) maps viewer wall ms w to session ms w − 1_000_000.
const clock = { offsetMicros: 0, originMicros: 1_000_000_000 };
const wall = (sessionMs: number) => 1_000_000 + sessionMs;
const screen = { w: 2560, h: 1600 };
const cam = { scale: 0.5, tx: 0, ty: 0 };
const viewport = { w: 1280, h: 800 };
const noPresenter = {} as PixiPresenter;
const settle = () => new Promise((r) => setTimeout(r, 0));
const bytes = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

describe("OracleCapture", () => {
  it("gives a window opened on a still screen one baseline crop from the newest frame", async () => {
    const oracle = new OracleCapture();
    oracle.clock = clock;
    const model = clickModel();
    // The oracle is on before the screen's last frame arrives (900 ms); then the screen stays still.
    await oracle.handle({ id: 1, op: "enable", zooms: [1] }, noPresenter, model, {
      reducedMotion: false,
    });
    const still = fakeFrame(10);
    oracle.onFrame(still.frame, wall(900), 7);
    oracle.onTick(noPresenter, model, 1400, null, cam, viewport, screen);
    oracle.onTick(noPresenter, model, 1450, null, cam, viewport, screen);
    oracle.onTick(noPresenter, model, 1500, null, cam, viewport, screen);
    await settle();
    expect(oracle.frames).toHaveLength(1);
    expect(oracle.frames[0]).toMatchObject({ t: 900, presented: 7, actionId: ID });
    expect(bytes(oracle.frames[0]?.luma ?? "")).toEqual(new Uint8Array(64 * 64).fill(10));
    expect(still.rects).toEqual([{ x: 268, y: 368, width: 64, height: 64 }]);
    // The press changes the page: the new frame joins the window once, after its baseline.
    const lit = fakeFrame(200);
    oracle.onFrame(lit.frame, wall(1700), 8);
    oracle.onTick(noPresenter, model, 1716, null, cam, viewport, screen);
    await settle();
    expect(oracle.frames.map((f) => [f.t, f.presented])).toEqual([
      [900, 7],
      [1700, 8],
    ]);
    // The kept clone of the still frame and the clone its crop read are both closed.
    expect(still.clones).toHaveLength(2);
    for (const c of still.clones) expect(c.close).toHaveBeenCalledTimes(1);
  });

  it("keeps one clone of the newest frame while on, closing the one it replaces and on dispose", async () => {
    const oracle = new OracleCapture();
    await oracle.handle({ id: 1, op: "enable", zooms: [1] }, noPresenter, emptyModel(), {
      reducedMotion: false,
    });
    const a = fakeFrame(10);
    const b = fakeFrame(20);
    oracle.onFrame(a.frame, wall(100), 1);
    oracle.onFrame(b.frame, wall(116), 2);
    expect(a.clones).toHaveLength(1);
    expect(a.clones[0]?.close).toHaveBeenCalledTimes(1);
    expect(b.clones).toHaveLength(1);
    expect(b.clones[0]?.close).not.toHaveBeenCalled();
    oracle.dispose();
    expect(b.clones[0]?.close).toHaveBeenCalledTimes(1);
    // The presenter owns the frames themselves, and with no window open nothing is cropped.
    expect(a.frame.close).not.toHaveBeenCalled();
    expect(b.frame.close).not.toHaveBeenCalled();
    expect(oracle.frames).toEqual([]);
  });

  it("keeps no clone while the oracle is off", async () => {
    const oracle = new OracleCapture();
    oracle.clock = clock;
    const model = clickModel();
    // Production: frames flow with the oracle off, then the screen stays still.
    const early = fakeFrame(10);
    const still = fakeFrame(10);
    oracle.onFrame(early.frame, wall(884), 6);
    oracle.onFrame(still.frame, wall(900), 7);
    expect(early.clones).toEqual([]);
    expect(still.clones).toEqual([]);
    // Switched on mid-stream on that still screen: the window opens with no baseline.
    await oracle.handle({ id: 1, op: "enable", zooms: [1] }, noPresenter, model, {
      reducedMotion: false,
    });
    oracle.onTick(noPresenter, model, 1450, null, cam, viewport, screen);
    oracle.onTick(noPresenter, model, 1500, null, cam, viewport, screen);
    await settle();
    expect(oracle.frames).toEqual([]);
    expect(still.rects).toEqual([]);
    // The next frame is kept and is the open window's first crop, taken once.
    const lit = fakeFrame(200);
    oracle.onFrame(lit.frame, wall(1700), 8);
    oracle.onTick(noPresenter, model, 1716, null, cam, viewport, screen);
    await settle();
    expect(oracle.frames.map((f) => [f.t, f.presented])).toEqual([[1700, 8]]);
    expect(lit.rects).toEqual([{ x: 268, y: 368, width: 64, height: 64 }]);
    // Its kept clone stays open until dispose; the clone its crop read is closed.
    expect(lit.clones).toHaveLength(2);
    expect(lit.clones[0]?.close).not.toHaveBeenCalled();
    expect(lit.clones[1]?.close).toHaveBeenCalledTimes(1);
    oracle.dispose();
    expect(lit.clones[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("takes a window's baseline when its intent arrives, before any tick", async () => {
    const oracle = new OracleCapture();
    oracle.clock = clock;
    const model = clickModel();
    await oracle.handle({ id: 1, op: "enable", zooms: [1] }, noPresenter, model, {
      reducedMotion: false,
    });
    const still = fakeFrame(10);
    oracle.onFrame(still.frame, wall(900), 7);
    // The intent is folded at 1450 ms, inside its window (1420…3020 ms), and no tick follows.
    oracle.onModel(model, 1450, screen);
    await settle();
    expect(oracle.frames).toHaveLength(1);
    expect(oracle.frames[0]).toMatchObject({ t: 900, presented: 7, actionId: ID });
    expect(still.rects).toEqual([{ x: 268, y: 368, width: 64, height: 64 }]);
    // The kept clone stays open until dispose; the clone the crop read is closed.
    expect(still.clones).toHaveLength(2);
    expect(still.clones[0]?.close).not.toHaveBeenCalled();
    expect(still.clones[1]?.close).toHaveBeenCalledTimes(1);
    oracle.dispose();
    expect(still.clones[0]?.close).toHaveBeenCalledTimes(1);
  });
});
