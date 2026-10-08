import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ObserveResult,
  Rect,
  SettleRequest,
  SettleResult,
  WindowInfo,
} from "@localdot/protocol";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EvalCell,
  evalCellOptions,
  removeEvalContainers,
  startEvalCell,
} from "../agent/evals/cell.ts";
import { FramePng } from "../agent/frame-png.ts";
import { DesktopdClient } from "../desktopd/client.ts";
import { FrameStore } from "../gateway/frames.ts";
import { DOCKER_TESTS } from "./testing/docker-cli.ts";

// A fresh 2× desktop with the cell's own label and name prefix (LOCALDOT_EVAL_* as in the desktop
// eval), never one of the live computer's localdot-* containers.
const options = DOCKER_TESTS ? evalCellOptions() : undefined;
let cell: EvalCell;
let desktop: DesktopdClient;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
};
const titled = (o: ObserveResult, title: RegExp): WindowInfo | undefined =>
  o.windows.find((w) => title.test(w.title));

async function rgb(o: ObserveResult): Promise<Buffer> {
  return sharp(Buffer.from(o.image, "base64")).removeAlpha().raw().toBuffer();
}

// Mean absolute difference of two 1280×800 RGB frames inside a model-pixel rect.
function difference(a: Buffer, b: Buffer, r: Rect): number {
  let sum = 0;
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++)
      for (let c = 0; c < 3; c++, n++) {
        const i = (y * 1280 + x) * 3 + c;
        sum += Math.abs((a[i] as number) - (b[i] as number));
      }
  return sum / n;
}

// The top-left of the first 12×12 all-black block inside a model-pixel rect.
function blackBlock(frame: Buffer, r: Rect): { x: number; y: number } | undefined {
  const dark = (x: number, y: number) => {
    const i = (y * 1280 + x) * 3;
    return (frame[i] as number) + (frame[i + 1] as number) + (frame[i + 2] as number) < 30;
  };
  for (let y = r.y; y < r.y + r.h - 12; y++)
    for (let x = r.x; x < r.x + r.w - 12; x++) {
      let all = true;
      for (let dy = 0; dy < 12 && all; dy += 3)
        for (let dx = 0; dx < 12 && all; dx += 3) all = dark(x + dx, y + dy);
      if (all) return { x, y };
    }
  return undefined;
}

const toModel = (r: Rect): Rect => ({
  x: Math.round(r.x / 2),
  y: Math.round(r.y / 2),
  w: Math.round(r.w / 2),
  h: Math.round(r.h / 2),
});

async function waitFor<T>(
  what: string,
  find: () => Promise<T | undefined>,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = await find().catch(() => undefined);
    if (found !== undefined) return found;
    await sleep(500);
  }
  throw new Error(`${what} did not appear`);
}

async function press(combo: string[], window?: number) {
  return desktop.input({
    input: { kind: "key", combo },
    injector: "xtest",
    holdMs: 0,
    ...(window ? { window } : {}),
  });
}

async function click(model: { x: number; y: number }, window?: number) {
  return desktop.input({
    input: { kind: "click", button: "left", count: 1, at: { x: model.x * 2, y: model.y * 2 } },
    injector: "xtest",
    holdMs: 0,
    ...(window ? { window } : {}),
  });
}

async function timedSettle(req: Partial<SettleRequest>) {
  const t0 = performance.now();
  const result = await desktop.settle(req);
  return { result, ms: performance.now() - t0 };
}

// Mean squared luminance step between neighbours. A blurred edge spreads the same contrast over
// more pixels, so its squared steps sum to less: higher means sharper strokes.
async function sharpness(png: Buffer, width: number, height: number): Promise<number> {
  const grey = await sharp(png).resize(width, height, { fit: "fill" }).greyscale().raw().toBuffer();
  let sum = 0;
  for (let y = 0; y < height - 1; y++)
    for (let x = 0; x < width - 1; x++) {
      const i = y * width + x;
      sum +=
        ((grey[i] as number) - (grey[i + 1] as number)) ** 2 +
        ((grey[i] as number) - (grey[i + width] as number)) ** 2;
    }
  return sum / ((width - 1) * (height - 1));
}

describe.skipIf(!DOCKER_TESTS)("desktopd observe and settle on a real 2× desktop", () => {
  beforeAll(async () => {
    if (!options) return;
    cell = await startEvalCell("observe", options);
    desktop = new DesktopdClient({ baseUrl: cell.baseUrl, token: cell.token });
  });
  afterAll(() => {
    if (options && cell) removeEvalContainers(options, cell.name);
  });

  it("observes in 250 ms at the median and 500 ms at p95, and never fails while GIMP starts", async () => {
    const starting: number[] = [];
    const failures: string[] = [];
    const made = cell.exec([
      "sh",
      "-c",
      "mkdir -p /config/eval && convert -size 640x400 xc:white -strip /config/eval/canvas.png",
    ]);
    expect(made.status, made.err).toBe(0);
    await desktop.launch({ app: "gimp", args: ["/config/eval/canvas.png"] });
    let seen: number | undefined;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && (seen === undefined || Date.now() - seen < 3000)) {
      const t0 = performance.now();
      try {
        const o = await desktop.observe();
        starting.push(performance.now() - t0);
        if (seen === undefined && titled(o, /GNU Image Manipulation Program|GIMP$/))
          seen = Date.now();
      } catch (error) {
        failures.push(String(error));
      }
    }
    expect(seen, "GIMP's window").toBeDefined();
    const open: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      await desktop.observe();
      open.push(performance.now() - t0);
    }
    console.log(
      `observe while GIMP starts: n=${starting.length} p50=${percentile(starting, 0.5).toFixed(0)} p95=${percentile(starting, 0.95).toFixed(0)} max=${Math.max(...starting).toFixed(0)} ms; with GIMP open: p50=${percentile(open, 0.5).toFixed(0)} p95=${percentile(open, 0.95).toFixed(0)} ms`,
    );
    expect(failures).toEqual([]);
    expect(starting.length).toBeGreaterThan(10);
    expect(percentile(open, 0.5)).toBeLessThanOrEqual(250);
    expect(percentile(open, 0.95)).toBeLessThanOrEqual(500);
  });

  it("returns a frame that already shows the colour dialog after a click on GIMP's foreground swatch", async () => {
    const welcome = await waitFor(
      "the welcome dialog",
      async () => titled(await desktop.observe(), /^Welcome to GIMP/),
      60_000,
    );
    await press(["Escape"], welcome.id);
    const before = await waitFor(
      "GIMP without its welcome dialog",
      async () => {
        const o = await desktop.observe();
        return titled(o, /^Welcome to GIMP/) ? undefined : o;
      },
      30_000,
    );
    const main = titled(before, /GNU Image Manipulation Program|GIMP$/);
    if (!main) throw new Error("no GIMP window");
    const frame = await rgb(before);
    const box = toModel(main.rect);
    const swatch = blackBlock(frame, { x: box.x, y: box.y + 150, w: 190, h: 200 });
    if (!swatch) throw new Error("no foreground swatch");
    await sleep(1000);
    await click({ x: swatch.x + 6, y: swatch.y + 6 }, main.id);
    const { result, ms } = await timedSettle({
      verb: "click",
      quietMs: 250,
      firstMs: 800,
      timeoutMs: 3000,
    });
    const after = await desktop.observe();
    const dialog = titled(after, /^Change Foreground Colou?r$/);
    console.log(`swatch click settled in ${ms.toFixed(0)} ms: ${JSON.stringify(result)}`);
    expect(dialog, "the colour dialog in the settled frame's window list").toBeDefined();
    if (!dialog) return;
    await sleep(2000);
    const later = await rgb(await desktop.observe());
    const area = toModel(dialog.rect);
    // The dialog was fully drawn in the settled frame: it matches the frame two seconds on,
    // and it is not what was there before the click.
    expect(difference(await rgb(after), later, area)).toBeLessThan(2);
    expect(difference(frame, later, area)).toBeGreaterThan(10);
    await press(["Escape"], dialog.id);
  });

  it("settles a key press in GIMP within 500 ms while the selection's marching ants run", async () => {
    const main = titled(await desktop.observe(), /GIMP$/);
    if (!main) throw new Error("no GIMP window");
    await press(["ctrl", "a"], main.id);
    await desktop.settle({ verb: "key" });
    const runs: { ms: number; result: SettleResult }[] = [];
    for (let i = 0; i < 3; i++) {
      await sleep(1500 + i * 70);
      await press(["shift"], main.id);
      runs.push(await timedSettle({ verb: "key", quietMs: 250, firstMs: 400, timeoutMs: 3000 }));
    }
    console.log(`key settles over marching ants: ${JSON.stringify(runs)}`);
    // Shift sometimes shows a hint in GIMP's status bar; the ants alone never hold settle open.
    for (const { ms, result } of runs) {
      expect(result.quiet).toBe(true);
      expect(ms).toBeLessThanOrEqual(500);
    }
    expect(runs.some(({ result }) => result.noVisibleChange)).toBe(true);
    await press(["shift", "ctrl", "a"], main.id);
  });

  it("settles a key press beside a blinking caret within 500 ms", async () => {
    cell.exec(["xfconf-query", "-c", "xsettings", "-p", "/Net/CursorBlink", "-s", "true"]);
    await desktop.launch({ app: "mousepad", args: [] });
    const editor = await waitFor(
      "Mousepad",
      async () => titled(await desktop.observe(), /Mousepad$/),
      60_000,
    );
    const inside = {
      x: Math.round(editor.rect.x / 2) + 200,
      y: Math.round(editor.rect.y / 2) + 150,
    };
    const times: number[] = [];
    const results: SettleResult[] = [];
    for (let i = 0; i < 6; i++) {
      // A click restarts GTK's blinking, which otherwise stops after ten idle seconds; the
      // press then lands at a different phase of the blink each time.
      await click(inside, editor.id);
      await desktop.settle({ verb: "click" });
      await sleep(1700 + i * 130);
      await press(["shift"], editor.id);
      const { result, ms } = await timedSettle({
        verb: "key",
        quietMs: 250,
        firstMs: 400,
        timeoutMs: 3000,
      });
      times.push(ms);
      results.push(result);
    }
    await press(["a"], editor.id);
    const typed = await timedSettle({ verb: "key", quietMs: 250, firstMs: 400, timeoutMs: 3000 });
    times.push(typed.ms);
    console.log(
      `key settles beside a blinking caret: ${times.map((t) => t.toFixed(0)).join(", ")} ms; ${JSON.stringify(results)}`,
    );
    expect(typed.result.noVisibleChange).toBe(false);
    expect(Math.max(...times)).toBeLessThanOrEqual(500);
  });

  it("zooms 10 pt text from the device-resolution frame, sharper than enlarging the model frame", async () => {
    const editor = titled(await desktop.observe(), /Mousepad$/);
    if (!editor) throw new Error("no Mousepad");
    await desktop.type(
      {
        text: "The quick brown fox jumps over the lazy dog 0123456789 #A9743E",
        masked: false,
        pace: { firstMs: 0, firstCount: 60, restMs: 0 },
        injector: "xtest",
        window: editor.id,
      },
      () => {},
    );
    await desktop.settle({ verb: "type", firstMs: 400 });
    const o = await desktop.observe();
    const home = mkdtempSync(join(tmpdir(), "localdot-zoom-"));
    const frames = new FrameStore(home);
    const sessionId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0S";
    frames.save(sessionId, o.frameId, Buffer.from(o.image, "base64"));
    const line = toModel(editor.rect);
    const region = { x: line.x, y: line.y + 28, w: 320, h: 32 };
    const real = await new FramePng(frames, {
      zoom: (_s, frameId, r) => desktop.zoom({ frameId, region: r }),
    }).png(sessionId, o.frameId, region);
    const enlarged = await new FramePng(frames).png(sessionId, o.frameId, region);
    writeFileSync(join(home, "zoom-device.png"), real);
    writeFileSync(join(home, "zoom-enlarged.png"), enlarged);
    const [device, upscaled] = await Promise.all([
      sharpness(real, 1280, 128),
      sharpness(enlarged, 1280, 128),
    ]);
    console.log(
      `zoom sharpness: device ${device.toFixed(0)}, enlarged ${upscaled.toFixed(0)} (${home})`,
    );
    expect(device).toBeGreaterThan(upscaled * 1.5);
    const meta = await sharp(real).metadata();
    expect([meta.width, meta.height]).toEqual([1280, 128]);
  });
});
