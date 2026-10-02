import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { microsToMs } from "@localdot/protocol";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import type { OracleDump, TickCapture } from "../src/stage/oracle.ts";
import {
  arrowRect,
  awayFromRectEdge,
  countColour,
  crosshairMask,
  firstChange,
  locateTemplate,
  outsideRect,
  type Rgba,
  ringBandMask,
} from "../src/stage/oracle-check.ts";
import { type CellRef, createReadyCell, removeCell } from "./cells.ts";
import { type RunningDaemon, startDaemon } from "./daemon.ts";
import { frameBytes, runPuppet, waitForSessionEnd } from "./puppet.ts";

const DOCKER = process.env.LOCALDOT_DOCKER_TESTS === "1";
const SCRIPT = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../daemon/puppet/oracle.json", import.meta.url)), "utf8"),
);
const XENON: [number, number, number] = [0x3f, 0xb5, 0xde];
let daemon: RunningDaemon;
let cell: CellRef;

test.skip(!DOCKER, "needs LOCALDOT_DOCKER_TESTS=1, the images and Docker Desktop");
test.beforeAll(async () => {
  daemon = await startDaemon();
  cell = await createReadyCell(daemon, 2);
});
test.afterAll(async () => {
  if (cell) await removeCell(daemon, cell.id);
  await daemon?.stop();
});

const decode = async (png: string): Promise<Rgba> => {
  const { data, info } = await sharp(Buffer.from(png, "base64"))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    w: info.width,
    h: info.height,
  };
};

test("pixel oracle: cursor hotspot, ring order, typing pace, clean observations, determinism", async ({
  page,
}, info) => {
  await page.goto(`${daemon.origin}/?oracle=1#token=${daemon.token}`);
  await expect(page.getByTestId("hud-status")).toHaveText("Live", { timeout: 120_000 });
  await page.waitForFunction(
    () => Number(document.querySelector("canvas.stage-canvas")?.getAttribute("data-frames")) > 0,
    null,
    { timeout: 60_000 },
  );
  await page.evaluate(() =>
    (
      window as unknown as { __localdot: { oracle: { enable(z: number[]): Promise<unknown> } } }
    ).__localdot.oracle.enable([1, 2]),
  );
  const template = (await page.evaluate(() =>
    (
      window as unknown as { __localdot: { oracle: { template(): Promise<unknown> } } }
    ).__localdot.oracle.template(),
  )) as { png: string; w: number; h: number; tip: { x: number; y: number } };
  const templateRgba = await decode(template.png);

  const sessionId = await runPuppet(daemon, cell.id, SCRIPT);
  const events = await waitForSessionEnd(daemon, sessionId);
  expect(events.at(-1)?.data.reason).toBe("done");
  const dump = (await page.evaluate(() =>
    (
      window as unknown as { __localdot: { oracle: { dump(): Promise<unknown> } } }
    ).__localdot.oracle.dump(),
  )) as OracleDump;
  expect(dump.errors, `failed luma crops: ${dump.errors.join("; ")}`).toEqual([]);
  expect(dump.ticks.length).toBeGreaterThan(50);

  const intents = events.filter((e) => e.type === "action.intent");
  const dispatches = events.filter((e) => e.type === "action.dispatch");
  const byStep = (type: string, step: string | undefined) =>
    events.find((e) => e.type === type && e.step === step);
  const report: string[] = [];

  for (const d of dispatches) {
    const input = d.data.input as { kind: string; at?: { x: number; y: number }; button?: string };
    const intent = byStep("action.intent", d.step);
    if (!intent) continue;
    const pressT = microsToMs(Number(d.data.pressT));
    // A key has no point, so it opens no capture window: checks 1–4 need one.
    if (input.kind === "key") continue;
    const ticks = dump.ticks.filter((t) => t.actionId === intent.id);
    expect(ticks.length, `captures for ${intent.data.label}`).toBeGreaterThan(5);

    if (input.kind === "click" && input.at) {
      // 1. The drawn cursor hotspot within 2 px of where the scene puts it, at zoom 1 and zoom 2,
      // on the latest capture whose arrow is unsquashed (press 0) and opaque (alpha 1): during the
      // travel, the dwell or the hold after the release. The template is the unsquashed arrow, so
      // the squash ticks (pressT − 80 ms … pressT + 150 ms) and an Instant fade-in never qualify.
      for (const zoom of [1, 2]) {
        const sharpTick = ticks
          .filter(
            (t) =>
              t.zoom === zoom &&
              t.cursorShot &&
              t.cursorShot.press === 0 &&
              t.cursorShot.alpha === 1,
          )
          .sort((a, b) => b.t - a.t)[0];
        expect(
          sharpTick,
          `an unsquashed cursor capture at zoom ${zoom} for ${intent.data.label}`,
        ).toBeDefined();
        const shot = (sharpTick as TickCapture).cursorShot as NonNullable<
          TickCapture["cursorShot"]
        >;
        const hit = locateTemplate(await decode(shot.png), templateRgba, template.tip);
        expect(hit, `cursor sprite found at zoom ${zoom} for ${intent.data.label}`).not.toBeNull();
        const dx = (hit?.tip.x ?? 0) - shot.tip.x;
        const dy = (hit?.tip.y ?? 0) - shot.tip.y;
        report.push(
          `${intent.data.label} zoom ${zoom}: hotspot off by (${dx.toFixed(1)}, ${dy.toFixed(1)}) px at t=${(sharpTick as TickCapture).t.toFixed(1)}`,
        );
        expect(
          Math.hypot(dx, dy),
          `hotspot within 2 px at zoom ${zoom} for ${intent.data.label}`,
        ).toBeLessThanOrEqual(2);
      }
      // The scene itself puts the cursor on the dispatch point at the press (Task 13 proves the
      // model; this proves the captured one): the latest capture in the dwell, from the planned
      // arrival (the intent's PointerPlan, session ms like the ticks) to pressT. Earlier ticks
      // are still travelling, up to OVERSHOOT_CAP_PX off; a Fast click's 45 ms dwell may hold no
      // capture, which is reported rather than failed.
      const plan = intent.data.pointer as { startsAt: number; durationMs: number };
      const arrival = plan.startsAt + plan.durationMs;
      const atPress = ticks
        .filter((t) => t.zoom === 1 && t.t >= arrival && t.t < pressT && t.cursorInCrop)
        .sort((a, b) => b.t - a.t)[0];
      if (!atPress) {
        report.push(
          `${intent.data.label}: no capture between the arrival (${arrival.toFixed(1)} ms) and the press (${pressT.toFixed(1)} ms); cursor-at-press check skipped`,
        );
      } else {
        const c = atPress.cursorInCrop as { x: number; y: number };
        expect(
          Math.hypot(c.x - atPress.expected.x, c.y - atPress.expected.y),
          `scene cursor on the dispatch point at the press (${intent.data.label})`,
        ).toBeLessThanOrEqual(0.5);
      }
      // 2. No click ring before the raw press: no ring in the scene and no accent pixels in the ring
      // band, 11…21 CSS px from the point (a ring 0–90 ms old spans 13–20 px, stroke 2 px). Excluded:
      // the arrow's own footprint (its xenon stroke sits on the point during the dwell and the
      // squash), the target box's stroke and halo (within 8 CSS px of the bbox edges), and the
      // coordinates-only crosshair (its 18 px ring, arms and dot). Captures are premultiplied
      // RGBA, so only solid xenon counts; ≤ 4 pixels allows anti-aliasing at the exclusions' rims.
      const target = byStep("action.target", d.step)?.data.target as
        | { bbox?: { x: number; y: number; w: number; h: number } }
        | undefined;
      for (const t of ticks.filter((t) => t.zoom === 1 && t.t < pressT)) {
        expect(
          t.rings,
          `scene has no ring before the press (${intent.data.label}, t=${t.t.toFixed(1)})`,
        ).toBe(0);
        const crop = await decode(t.png);
        const band = ringBandMask(t.expected.x, t.expected.y, 11 * dump.dpr, 21 * dump.dpr);
        const parts: ((x: number, y: number) => boolean)[] = [band];
        if (t.cursorInCrop) parts.push(outsideRect(arrowRect(t.cursorInCrop, dump.dpr), 0));
        if (target?.bbox) {
          const b = target.bbox;
          const box = {
            x: t.expected.x + (b.x - input.at.x) * t.scale,
            y: t.expected.y + (b.y - input.at.y) * t.scale,
            w: b.w * t.scale,
            h: b.h * t.scale,
          };
          parts.push(awayFromRectEdge(box, 8 * dump.dpr));
        } else {
          const cross = crosshairMask(t.expected.x, t.expected.y, dump.dpr);
          parts.push((x, y) => !cross(x, y));
        }
        const mask = (x: number, y: number) => parts.every((p) => p(x, y));
        expect(
          countColour(crop, XENON, 40, mask),
          `no ring pixels before the press (${intent.data.label}, t=${t.t.toFixed(1)})`,
        ).toBeLessThanOrEqual(4);
      }
      // 3. Press-acting control (every flash-page click, all five labelled "Click the page …"):
      // the ring starts at most one frame before the frame that shows the change. A still screen
      // sends no frames (A30), so every window's luma series starts with a baseline crop of the
      // newest frame, taken before the press: for Watch and Fast when the window opens, at
      // arrival − 100 ms; for Instant when the intent reaches the worker, about 60 ms before the
      // press is due. The oracle keeps that frame only while it is on (P3-C12): it is on before
      // the puppet starts, and the script's first step (the flash page's launch) repaints the
      // screen before any window opens, so `baseline` is at least 1 for every click.
      const frames = dump.frames
        .filter((f) => f.actionId === intent.id)
        .map((f) => ({ ...f, luma: new Uint8Array(Buffer.from(f.luma, "base64")) }))
        .sort((a, b) => a.presented - b.presented);
      const baseline = frames.filter((f) => f.t < pressT).length;
      expect(baseline, `baseline frames before the press for ${intent.data.label}`).toBeGreaterThan(
        0,
      );
      if ((intent.data.label as string).startsWith("Click the page")) {
        const change = firstChange(frames, baseline);
        const ringTick = ticks
          .filter((t) => t.zoom === 1 && t.rings > 0)
          .sort((a, b) => a.t - b.t)[0];
        expect(change, `the flash page changed after ${intent.data.label}`).toBeDefined();
        expect(ringTick, `a ring was drawn for ${intent.data.label}`).toBeDefined();
        report.push(
          `${intent.data.label}: change at frame ${change?.presented}, ring first drawn over frame ${ringTick?.presented}`,
        );
        expect(
          (ringTick?.presented ?? 0) >= (change?.presented ?? 0) - 1,
          `ring not more than one frame before the change (${intent.data.label})`,
        ).toBe(true);
      }
    }
    if (input.kind === "type") {
      // 4. The typing display never shows more characters than were typed.
      for (const t of ticks)
        expect(t.typingShown, `typing shown ≤ typed at t=${t.t.toFixed(1)}`).toBeLessThanOrEqual(
          t.typingCount,
        );
      expect(
        ticks.some((t) => t.typingShown > 0),
        "the pill showed something",
      ).toBe(true);
    }
  }

  // 5. Model screenshots contain no overlay pixels. The desktop's own blue icons leave a few
  // xenon-like pixels in a lossy WebP, so each observe is held to the session's first, taken
  // before any action, when nothing could be drawn: at most 24 more, under a third of the xenon in
  // the smallest overlay (a 1280×800 ring is about 70 pixels).
  const observes = events.filter((e) => e.type === "observe");
  expect(observes.length).toBeGreaterThan(5);
  const xenonIn = async (frameId: string): Promise<number> => {
    const { data, info } = await sharp(await frameBytes(daemon, sessionId, frameId))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(1280);
    return countColour(
      {
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
        w: info.width,
        h: info.height,
      },
      XENON,
      6,
    );
  };
  const firstCount = await xenonIn(String(observes[0]?.data.frameId));
  for (const o of observes.slice(1)) {
    const n = await xenonIn(String(o.data.frameId));
    report.push(
      `observe ${String(o.data.frameId)}: ${n} xenon-like pixels (first observe: ${firstCount})`,
    );
    expect(
      n,
      `xenon pixels in observe ${String(o.data.frameId)} against the first observe's ${firstCount}`,
    ).toBeLessThanOrEqual(firstCount + 24);
  }

  // 6. Rendering the same log twice yields identical frames.
  for (const d of dispatches.slice(0, 3)) {
    const t = microsToMs(Number(d.data.ringAt)) + 100;
    const twice = (await page.evaluate(
      (tMs) =>
        (
          window as unknown as {
            __localdot: { oracle: { renderTwice(t: number): Promise<unknown> } };
          }
        ).__localdot.oracle.renderTwice(tMs),
      t,
    )) as { identical: boolean; bytes: number };
    expect(twice.identical, `identical overlay frames at t=${t}`).toBe(true);
    expect(twice.bytes).toBeGreaterThan(0);
  }

  expect(intents.length).toBeGreaterThanOrEqual(10);
  await info.attach("oracle-report", { body: report.join("\n"), contentType: "text/plain" });
  await page.screenshot({ path: `e2e/out/oracle-${info.project.name}.png` });
});
