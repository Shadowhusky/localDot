import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { msToMicros, type Rect, ulid } from "@localdot/protocol";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../cells/types.ts";
import { DesktopdRegistry } from "../desktopd/registry.ts";
import { FakeDesktopd } from "../desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "./frames.ts";
import { animationKeepsTarget, frameLuma, lumaRegionChanged, regionChanged } from "./freshness.ts";
import { ActionGateway, type GuiAction } from "./gateway.ts";
import { DEFAULT_ONSET_TABLE } from "./onset-table.ts";
import { keepPolicy } from "./ring-onset.ts";

const point = { x: 640, y: 400 };
const base = () => Buffer.alloc(1280 * 800, 100);
function paint(image: Buffer, box: Rect, value = 200): Buffer {
  const next = Buffer.from(image);
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++) next[y * 1280 + x] = value;
  return next;
}
const spinner = { x: 602, y: 362, w: 16, h: 16 };
const png = (pixels: Buffer) =>
  sharp(pixels, { raw: { width: 1280, height: 800, channels: 1 } })
    .png()
    .toBuffer();

describe("freshness pixels", () => {
  it("compares the target neighborhood and ignores a distant change", async () => {
    const a = await png(base());
    expect((await regionChanged(a, await png(paint(base(), spinner)), point)).changed).toBe(true);
    expect(
      (await regionChanged(a, await png(paint(base(), { x: 0, y: 0, w: 40, h: 40 })), point))
        .changed,
    ).toBe(false);
    expect((await regionChanged(a, a, { x: 0, y: 0 })).fraction).toBe(0);
  });
  it("uses strict 24-luma and 2-percent thresholds", () => {
    const two = paint(base(), { x: 635, y: 395, w: 2, h: 1 });
    expect(lumaRegionChanged(base(), two, point, { radius: 5 })).toEqual({
      changed: false,
      fraction: 0.02,
    });
    const three = paint(two, { x: 637, y: 395, w: 1, h: 1 });
    expect(lumaRegionChanged(base(), three, point, { radius: 5 }).changed).toBe(true);
    expect(lumaRegionChanged(base(), paint(base(), spinner, 124), point).changed).toBe(false);
    expect(lumaRegionChanged(base(), paint(base(), spinner, 125), point).changed).toBe(true);
  });
  it("permits only a small peripheral animation", () => {
    expect(animationKeepsTarget(base(), paint(base(), spinner), base(), point)).toBe(true);
    expect(
      animationKeepsTarget(base(), paint(base(), spinner), paint(base(), spinner), point),
    ).toBe(false);
    expect(
      animationKeepsTarget(base(), paint(base(), { x: 592, y: 352, w: 96, h: 22 }), base(), point),
    ).toBe(false);
  });
  it("never masks the center, static overlay, or complete target label", () => {
    const center = paint(base(), { x: 630, y: 390, w: 20, h: 20 });
    expect(animationKeepsTarget(base(), center, base(), point)).toBe(false);
    const overlay = paint(base(), { x: 620, y: 380, w: 40, h: 40 });
    expect(animationKeepsTarget(base(), overlay, overlay, point)).toBe(false);
    const target = { x: 635, y: 370, w: 45, h: 20 };
    const label = paint(paint(base(), spinner), { x: 650, y: 375, w: 20, h: 2 });
    expect(animationKeepsTarget(base(), label, base(), point, target)).toBe(false);
  });
  it("subtracts exact dynamic pixels rather than their bounding rectangle", () => {
    let first = paint(base(), { x: 598, y: 358, w: 5, h: 5 });
    first = paint(first, { x: 620, y: 380, w: 5, h: 5 });
    first = paint(first, { x: 605, y: 360, w: 13, h: 16 });
    const second = paint(base(), { x: 605, y: 360, w: 13, h: 16 });
    expect(animationKeepsTarget(base(), first, second, point)).toBe(false);
  });
  it("removes alpha, clips edge targets, and rejects invalid dimensions or options", async () => {
    const rgba = await sharp({
      create: {
        width: 1280,
        height: 800,
        channels: 4,
        background: { r: 100, g: 100, b: 100, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    expect((await frameLuma(rgba)).length).toBe(1280 * 800);
    expect(
      animationKeepsTarget(
        base(),
        base(),
        base(),
        { x: 0, y: 0 },
        { x: -10, y: -10, w: 30, h: 30 },
      ),
    ).toBe(true);
    expect(() => lumaRegionChanged(base(), base(), point, { radius: -1 })).toThrow(RangeError);
    expect(() => lumaRegionChanged(base(), base(), point, { threshold: NaN })).toThrow(RangeError);
    expect(() => lumaRegionChanged(base(), base(), point, { fraction: 2 })).toThrow(RangeError);
    expect(() => animationKeepsTarget(base(), base(), Buffer.alloc(1), point)).toThrow(RangeError);
  });
});

async function setup(scale: 1 | 2 = 1) {
  const home = mkdtempSync(join(tmpdir(), "localdot-freshness-"));
  let now = 10_000_000;
  const clock = { nowMicros: () => now };
  const log = new EventLog(home, clock);
  const cells = new FakeOrchestrator();
  const fake = new FakeDesktopd();
  const registry = new DesktopdRegistry(cells, clock, fake.fetchImpl);
  const cellId = ulid();
  cells.emit({
    id: cellId,
    state: "ready",
    scale,
    createdAt: new Date().toISOString(),
    stream: { ...NO_STREAM, connection: "none", viewers: 0 },
  });
  cells.endpointsById.set(cellId, {
    desktopd: { baseUrl: "http://127.0.0.1:1", token: fake.token },
    stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" },
  });
  const abort = new AbortController();
  const sleeps: number[] = [];
  let onSleep: (ms: number) => void = () => {};
  const gateway = new ActionGateway({
    eventLog: log,
    cells,
    registry,
    onset: DEFAULT_ONSET_TABLE,
    ringOnset: keepPolicy(DEFAULT_ONSET_TABLE),
    frames: new FrameStore(home),
    now: clock.nowMicros,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      sleeps.push(ms);
      now += msToMicros(ms);
      onSleep(ms);
      await new Promise((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
    },
  });
  const sessionId = log.createSession("freshness");
  const ctx = { source: "manual" as const, sessionId, cellId, signal: abort.signal };
  const setFrames = (...images: (Buffer | Error)[]) => {
    let index = 0;
    fake.script.observe = () => {
      const image = images[Math.min(index++, images.length - 1)];
      if (!image || image instanceof Error) throw image ?? new Error("missing fixture frame");
      return {
        frameId: ulid(),
        width: 1280,
        height: 800,
        image: image.toString("base64"),
        pointer: { x: 640 * scale, y: 400 * scale },
        windows: [],
      };
    };
  };
  setFrames(await png(base()));
  const basis = await gateway.observe(ctx);
  const clicks = () => fake.calls.filter((call) => call.path === "/input");
  // The gateway listens to the cells only while it holds an input for the stream.
  const idle = cells.listeners.size;
  const holding = () => vi.waitFor(() => expect(cells.listeners.size).toBe(idle + 1));
  return {
    holding,
    fake,
    log,
    cells,
    gateway,
    ctx,
    basis,
    abort,
    sleeps,
    setFrames,
    clicks,
    setOnSleep: (f: (ms: number) => void) => {
      onSleep = f;
    },
  };
}

describe("gateway freshness", () => {
  for (const scale of [1, 2] as const) {
    it(`allows a peripheral spinner after a second frame and 100 ms at ${scale}x`, async () => {
      const s = await setup(scale);
      s.fake.script.hitTest = () => ({
        target: {
          point: { x: 640 * scale, y: 400 * scale },
          bbox: { x: 628 * scale, y: 388 * scale, w: 24 * scale, h: 24 * scale },
          name: "Go",
          role: "button",
          source: "ax",
        },
        window: 42,
        ms: 1,
      });
      s.setFrames(await png(paint(base(), spinner)), await png(base()));
      s.setOnSleep((ms) => {
        if (ms === 100) expect(s.clicks()).toHaveLength(0);
      });
      const out = await s.gateway.run(s.ctx, { verb: "click", point, basedOn: s.basis.frameId });
      expect(out.ok).toBe(true);
      expect(s.sleeps).toContain(100);
      expect(s.clicks()).toHaveLength(1);
      expect(s.fake.calls.filter((c) => c.path === "/observe")).toHaveLength(4);
    });
    it(`protects all target bounds in model pixels at ${scale}x`, async () => {
      const s = await setup(scale);
      s.fake.script.hitTest = () => ({
        target: {
          point: { x: 640 * scale, y: 400 * scale },
          bbox: { x: 600 * scale, y: 360 * scale, w: 60 * scale, h: 60 * scale },
          source: "ax",
          role: "button",
          name: "wide target",
        },
        window: 42,
        ms: 1,
      });
      s.setFrames(await png(paint(base(), spinner)), await png(base()));
      const out = await s.gateway.run(s.ctx, {
        verb: "scroll",
        point,
        dx: 0,
        dy: 1,
        basedOn: s.basis.frameId,
      });
      expect(out.cancelled).toBe("stale");
      expect(s.clicks()).toHaveLength(0);
    });
  }
  it("returns the newer frame without input for a static overlay", async () => {
    const s = await setup();
    s.setFrames(await png(paint(base(), { x: 620, y: 380, w: 40, h: 40 })));
    const out = await s.gateway.run(s.ctx, { verb: "click", point, basedOn: s.basis.frameId });
    expect(out).toMatchObject({ ok: false, cancelled: "stale" });
    expect(out.frameId).toBeDefined();
    expect(out.frameId).not.toBe(s.basis.frameId);
    expect(s.clicks()).toHaveLength(0);
    expect(s.log.read(s.ctx.sessionId).at(-1)).toMatchObject({
      type: "action.cancel",
      data: { reason: "stale" },
    });
  });
  it("cancels if the accessibility identity changes during animation", async () => {
    const s = await setup();
    let hits = 0;
    s.fake.script.hitTest = () => ({
      target: { point, name: ++hits === 1 ? "Go" : "Delete", role: "button", source: "ax" },
      window: 42,
      ms: 1,
    });
    s.setFrames(await png(paint(base(), spinner)), await png(base()));
    expect(
      (await s.gateway.run(s.ctx, { verb: "click", point, basedOn: s.basis.frameId })).cancelled,
    ).toBe("stale");
    expect(s.clicks()).toHaveLength(0);
  });
  it("refuses the animation exception when the second observation fails", async () => {
    const s = await setup();
    s.setFrames(await png(paint(base(), spinner)), new Error("fixture missing second frame"));
    const out = await s.gateway.run(s.ctx, { verb: "click", point, basedOn: s.basis.frameId });
    expect(out.cancelled).toBe("stale");
    expect(out.frameId).toBeDefined();
    expect(s.clicks()).toHaveLength(0);
  });
  it("does not observe or dispatch again after Stop during the animation delay", async () => {
    const s = await setup();
    s.setFrames(await png(paint(base(), spinner)), await png(base()));
    s.setOnSleep((ms) => {
      if (ms === 100) s.abort.abort();
    });
    expect(
      (await s.gateway.run(s.ctx, { verb: "click", point, basedOn: s.basis.frameId })).cancelled,
    ).toBe("user");
    expect(s.clicks()).toHaveLength(0);
    expect(s.fake.calls.filter((c) => c.path === "/observe")).toHaveLength(2);
  });
  it("allows an unchanged neighborhood without the animation delay", async () => {
    const s = await setup();
    expect(
      (await s.gateway.run(s.ctx, { verb: "click", point, basedOn: s.basis.frameId })).ok,
    ).toBe(true);
    expect(s.sleeps).not.toContain(100);
    expect(s.clicks()).toHaveLength(1);
  });
  it("cancels a drag whose start changed since the model's screenshot, before any press", async () => {
    const s = await setup();
    s.setFrames(await png(paint(base(), { x: 620, y: 380, w: 40, h: 40 })));
    const out = await s.gateway.run(s.ctx, {
      verb: "drag",
      path: [point, { x: 100, y: 100 }],
      basedOn: s.basis.frameId,
    });
    expect(out).toMatchObject({ ok: false, cancelled: "stale" });
    expect(s.clicks()).toHaveLength(0);
  });
  it("lets an agent's drag start beside a spinner once its element read stays the same", async () => {
    const s = await setup();
    s.fake.script.hitTest = (p) => ({
      target: { point: p, name: "Canvas", role: "drawing area", source: "ax" },
      window: 42,
      ms: 1,
    });
    s.setFrames(await png(paint(base(), spinner)), await png(base()));
    const out = await s.gateway.run(
      {
        ...s.ctx,
        source: "agent",
        authorizeAgent: async () => ({ consume: () => true }),
        beforeEffect: () => true,
      },
      { verb: "drag", path: [point, { x: 100, y: 100 }], basedOn: s.basis.frameId },
    );
    expect(out.ok).toBe(true);
    expect(s.clicks()).toHaveLength(1);
  });
  it("checks a button press against the screenshot unless this agent's move on that screenshot just put the cursor there", async () => {
    const s = await setup();
    s.setFrames(await png(paint(base(), { x: 620, y: 380, w: 40, h: 40 })));
    const basedOn = s.basis.frameId;
    const press = () => s.gateway.run(s.ctx, { verb: "down", basedOn });
    const stale = { ok: false, cancelled: "stale" };
    expect(await s.gateway.run(s.ctx, { verb: "down", point, basedOn })).toMatchObject(stale);
    // A move on no screenshot, on a later one, or another agent's move leaves the press checked.
    await s.gateway.run(s.ctx, { verb: "move", point });
    expect(await press()).toMatchObject(stale);
    const later = await s.gateway.observe(s.ctx);
    await s.gateway.run(s.ctx, { verb: "move", point, basedOn: later.frameId });
    expect(await press()).toMatchObject(stale);
    await s.gateway.run({ ...s.ctx, agent: "helper" }, { verb: "move", point, basedOn });
    expect(await press()).toMatchObject(stale);
    // So does anything else that acted after the move.
    await s.gateway.run(s.ctx, { verb: "move", point, basedOn });
    await s.gateway.run(s.ctx, { verb: "scroll", point, dx: 0, dy: 1 });
    expect(await press()).toMatchObject(stale);
    await s.gateway.run(s.ctx, { verb: "move", point, basedOn });
    expect((await press()).ok).toBe(true);
    expect(s.clicks().map((c) => (c.body as { input: { kind: string } }).input.kind)).toEqual([
      "move",
      "move",
      "move",
      "move",
      "scroll",
      "move",
      "down",
    ]);
  });
  it("checks a press after any other action since the move, at a point of its own, or once the pointer moved away", async () => {
    const s = await setup();
    const overlay = { x: 620, y: 380, w: 40, h: 40 };
    s.setFrames(await png(paint(base(), overlay)));
    const basedOn = s.basis.frameId;
    const stale = { ok: false, cancelled: "stale" };
    const actions: GuiAction[] = [
      { verb: "key", combo: ["Return"] },
      { verb: "type", text: "a" },
      { verb: "wait", ms: 10 },
    ];
    for (const between of actions) {
      await s.gateway.run(s.ctx, { verb: "move", point, basedOn });
      await s.gateway.run(s.ctx, between);
      expect(await s.gateway.run(s.ctx, { verb: "down", basedOn })).toMatchObject(stale);
    }
    // The desktop reports the pointer where the move left it, yet a press at a point of its own
    // is checked there.
    const covered = await png(paint(base(), overlay));
    s.fake.script.observe = () => ({
      frameId: ulid(),
      width: 1280,
      height: 800,
      image: covered.toString("base64"),
      pointer: { ...s.fake.pointer },
      windows: [],
    });
    await s.gateway.run(s.ctx, { verb: "move", point: { x: 100, y: 100 }, basedOn });
    expect(s.gateway.cursorOf(s.ctx.cellId)).toEqual({ x: 100, y: 100 });
    expect(await s.gateway.run(s.ctx, { verb: "down", point, basedOn })).toMatchObject(stale);
    const away = { x: 300, y: 300 };
    const moved = await png(paint(paint(base(), overlay), { x: 280, y: 280, w: 40, h: 40 }));
    s.fake.script.observe = () => ({
      frameId: ulid(),
      width: 1280,
      height: 800,
      image: moved.toString("base64"),
      pointer: away,
      windows: [],
    });
    await s.gateway.run(s.ctx, { verb: "move", point, basedOn });
    expect(s.gateway.cursorOf(s.ctx.cellId)).toEqual(away);
    expect(await s.gateway.run(s.ctx, { verb: "down", basedOn })).toMatchObject(stale);
    expect(
      s.clicks().filter((c) => (c.body as { input: { kind: string } }).input.kind === "down"),
    ).toEqual([]);
  });
  it("checks a press after the move's owner handed the screen over, or once a held button was let go", async () => {
    const s = await setup();
    s.setFrames(await png(paint(base(), { x: 620, y: 380, w: 40, h: 40 })));
    const basedOn = s.basis.frameId;
    const stale = { ok: false, cancelled: "stale" };
    let release: (() => Promise<void>) | undefined;
    const ctx = {
      ...s.ctx,
      holdInput: (r: () => Promise<void>) => {
        release = r;
        return () => {};
      },
    };
    await s.gateway.run(ctx, { verb: "move", point, basedOn });
    await release?.();
    expect(await s.gateway.run(ctx, { verb: "down", basedOn })).toMatchObject(stale);
    // A held button let go of with Escape (its time ran out, or the task stopped).
    await s.gateway.run(ctx, { verb: "down", point: { x: 100, y: 100 } });
    await s.gateway.run(ctx, { verb: "move", point, basedOn });
    await s.gateway.releaseHeld(ctx.cellId);
    expect(await s.gateway.run(ctx, { verb: "down", basedOn })).toMatchObject(stale);
  });
  it("checks a drag's start against the screenshot, not the canvas it is about to change", async () => {
    const s = await setup();
    s.setFrames(await png(paint(base(), { x: 80, y: 80, w: 40, h: 40 })));
    const out = await s.gateway.run(s.ctx, {
      verb: "drag",
      path: [point, { x: 100, y: 100 }],
      basedOn: s.basis.frameId,
    });
    expect(out.ok).toBe(true);
    expect(s.clicks()).toHaveLength(1);
  });
  it("preserves optional unknown-basis behavior and avoids checks without a basis", async () => {
    const s = await setup();
    for (const basedOn of [undefined, ulid()])
      expect((await s.gateway.run(s.ctx, { verb: "click", point, basedOn })).ok).toBe(true);
    expect(s.fake.calls.filter((c) => c.path === "/observe")).toHaveLength(3);
  });
});

describe("freshness after a renewed stream hold", () => {
  for (const branch of ["unchanged", "animation"] as const) {
    it(`holds during ${branch} comparison and rejects an overlay appearing before recovery`, async () => {
      const s = await setup();
      const clear = await png(base());
      const spinning = await png(paint(base(), spinner));
      const overlay = await png(paint(base(), { x: 620, y: 380, w: 40, h: 40 }));
      let observations = 0;
      let recovered = false;
      s.fake.script.observe = () => {
        observations++;
        if (observations === (branch === "unchanged" ? 1 : 2))
          s.cells.updateStream(s.ctx.cellId, { viewers: 1, connection: "stalled" });
        const image = recovered
          ? overlay
          : branch === "animation" && observations === 1
            ? spinning
            : clear;
        return {
          frameId: ulid(),
          width: 1280,
          height: 800,
          image: image.toString("base64"),
          pointer: point,
          windows: [],
        };
      };
      const running = s.gateway.run(s.ctx, { verb: "click", point, basedOn: s.basis.frameId });
      try {
        await s.holding();
        expect(s.cells.get(s.ctx.cellId)?.stream.connection).toBe("stalled");
        expect(s.clicks()).toHaveLength(0);
        recovered = true;
        s.cells.updateStream(s.ctx.cellId, { viewers: 1, connection: "live" });
        expect((await running).cancelled).toBe("stale");
        expect(s.clicks()).toHaveLength(0);
      } finally {
        s.abort.abort();
        await running;
      }
    });
  }
  it("stops without a later observation or input during the renewed hold", async () => {
    const s = await setup();
    const image = await png(base());
    let observations = 0;
    s.fake.script.observe = () => {
      observations++;
      s.cells.updateStream(s.ctx.cellId, { viewers: 1, connection: "stalled" });
      return {
        frameId: ulid(),
        width: 1280,
        height: 800,
        image: image.toString("base64"),
        pointer: point,
        windows: [],
      };
    };
    const running = s.gateway.run(s.ctx, { verb: "click", point, basedOn: s.basis.frameId });
    try {
      await s.holding();
      expect(s.clicks()).toHaveLength(0);
      s.abort.abort();
      expect((await running).cancelled).toBe("user");
      expect(observations).toBe(1);
      s.cells.updateStream(s.ctx.cellId, { viewers: 1, connection: "live" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(s.clicks()).toHaveLength(0);
    } finally {
      s.abort.abort();
      await running;
    }
  });
  it("rechecks after recovery then dispatches a still unchanged target once", async () => {
    const s = await setup();
    const image = await png(base());
    let observations = 0;
    s.fake.script.observe = () => {
      if (++observations === 1)
        s.cells.updateStream(s.ctx.cellId, { viewers: 1, connection: "stalled" });
      return {
        frameId: ulid(),
        width: 1280,
        height: 800,
        image: image.toString("base64"),
        pointer: point,
        windows: [],
      };
    };
    const running = s.gateway.run(s.ctx, { verb: "click", point, basedOn: s.basis.frameId });
    try {
      await s.holding();
      expect(s.clicks()).toHaveLength(0);
      s.cells.updateStream(s.ctx.cellId, { viewers: 1, connection: "live" });
      expect((await running).ok).toBe(true);
      expect(s.clicks()).toHaveLength(1);
      expect(observations).toBe(3);
    } finally {
      s.abort.abort();
      await running;
    }
  });
});
