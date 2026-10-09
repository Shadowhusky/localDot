import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ExportProbeOptions, ExportProbeResult } from "../src/export/export-probe.ts";
import type { RunningDaemon } from "./daemon.ts";
import { type SeededHome, seedHome, startReplayDaemon } from "./seed.ts";

const MARKER = `p7-privacy-marker-${Date.now().toString(36)}`;
let directory: string;
let daemon: RunningDaemon | undefined;
let privacy: SeededHome;
let longSession: SeededHome;
let uiSession: SeededHome;

test.use({ launchOptions: { args: ["--js-flags=--expose-gc"] } });
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "localdot-export-"));
  privacy = seedHome({
    home: join(directory, "home"),
    minutes: 3,
    title: `Quarterly ${MARKER}`,
    marker: MARKER,
    takeover: "60000-90000",
  });
  uiSession = seedHome({ home: privacy.home, minutes: 1, title: "Research notes" });
  daemon = await startReplayDaemon(privacy.home);
  mkdirSync("e2e/out", { recursive: true });
});
test.afterAll(async () => {
  try {
    await daemon?.stop();
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

async function openForExport(page: Page, sessionId: string) {
  if (!daemon) throw new Error("The export fixture is unavailable.");
  await page.goto(
    `${daemon.origin}/?replay=${sessionId}&replayProbe=1&exportProbe=1#token=${daemon.token}`,
  );
  await page.waitForFunction(
    () => window.__localdot?.replay?.status() === "ready" && !!window.__localdot.exportProbe,
    undefined,
    { timeout: 120_000 },
  );
}
async function runExport(page: Page, options: ExportProbeOptions): Promise<ExportProbeResult> {
  return page.evaluate((options) => {
    const probe = window.__localdot?.exportProbe;
    if (!probe) throw new Error("The export probe is unavailable.");
    return probe.run(options);
  }, options);
}
async function fileScan(page: Page, needles: string[]) {
  return page.evaluate(async (needles) => {
    const directory = await navigator.storage.getDirectory();
    const file = await (await directory.getFileHandle("localdot-export-probe.mp4")).getFile();
    const text = new TextDecoder("latin1").decode(await file.arrayBuffer());
    return {
      size: file.size,
      found: needles.filter((needle) => text.includes(needle)),
      boxes: ["udta", "meta", "ilst", "©nam", "©too"].filter((box) => text.includes(box)),
    };
  }, needles);
}

test("export smoke produces a playable MP4", async ({ page }) => {
  await openForExport(page, privacy.seed.sessionId);
  const result = await runExport(page, {
    speed: 2,
    skipIdle: false,
    hashes: false,
    fromMs: 0,
    toMs: 2000,
  });
  expect(result.frames).toBe(30);
  expect((await fileScan(page, [])).size).toBe(result.bytes);
  const encoded = await page.evaluate(async () => {
    const directory = await navigator.storage.getDirectory();
    const file = await (await directory.getFileHandle("localdot-export-probe.mp4")).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
  });
  writeFileSync("e2e/out/export-smoke.mp4", Buffer.from(encoded, "base64"));
  const player = await page.context().newPage();
  const playback = await player.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const address = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    const video = document.createElement("video");
    video.muted = true;
    try {
      const loaded = new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("MP4 playback failed."));
      });
      video.src = address;
      await loaded;
      await video.play();
      await new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve()));
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(address);
    }
  }, encoded);
  await player.close();
  expect(playback).toMatchObject({ width: 1280, height: 800 });
  expect(playback.duration).toBeCloseTo(1, 1);
});

test("export popover floats, keeps its size, collapses to a ring and cancels without a partial video", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      showSaveFilePicker: async () =>
        (await navigator.storage.getDirectory()).getFileHandle("localdot-export-ui.mp4", {
          create: true,
        }),
    });
  });
  await openForExport(page, uiSession.seed.sessionId);
  await page.evaluate(() => window.__localdot?.replay?.seek(1000, "exact"));
  const before = await page.getByRole("main", { name: "Replay" }).boundingBox();
  const trigger = page.getByRole("button", { name: "Export video", exact: true });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Export video" });
  await expect(panel).toBeVisible();
  const save = panel.getByRole("button", { name: "Save…" });
  await expect(save).not.toHaveAttribute("aria-disabled", "true");
  await panel.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const after = await page.getByRole("main", { name: "Replay" }).boundingBox();
  expect(after?.y).toBe(before?.y);
  expect(after?.height).toBe(before?.height);
  const options = await panel.boundingBox();
  await page.screenshot({ path: "e2e/out/export-options.png" });
  await save.click();
  const progress = panel.getByRole("progressbar", { name: "Export progress" });
  await expect(progress).toHaveAttribute("aria-valuenow", /[1-9]/);
  expect(await panel.boundingBox()).toEqual(options);
  await page.screenshot({ path: "e2e/out/export-progress.png" });
  await panel.getByRole("button", { name: "Keep working" }).click();
  await expect(panel).toBeHidden();
  await expect(trigger).toHaveAttribute("data-ring", "");
  await trigger.click();
  await expect(progress).toBeVisible();
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel.getByText("Cancelled. Nothing was saved.", { exact: true })).toBeVisible();
  const partialSize = await page.evaluate(
    async () =>
      (
        await (
          await (await navigator.storage.getDirectory()).getFileHandle("localdot-export-ui.mp4")
        ).getFile()
      ).size,
  );
  expect(partialSize).toBe(0);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page.setViewportSize({ width: 375, height: 480 });
  await trigger.click();
  await expect(panel).toBeVisible();
  await panel.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  // The sheet runs on past the bottom edge by design, so it is its footer that has to fit.
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  const footer = await panel.locator(".ui-sheet-footer").boundingBox();
  expect(footer).not.toBeNull();
  expect((footer?.y ?? 0) + (footer?.height ?? 0)).toBeLessThanOrEqual(480);
  await page.screenshot({ path: "e2e/out/export-sheet-narrow.png" });
});

test("exports carry no identifying data and never leave the page (Review Focus 6)", async ({
  page,
}) => {
  await openForExport(page, privacy.seed.sessionId);
  if (!daemon) throw new Error("Missing daemon.");
  const origin = daemon.origin;
  const sent: string[] = [];
  page.on("request", (request) => {
    if (
      !["GET", "HEAD"].includes(request.method()) ||
      request.postData() !== null ||
      new URL(request.url()).origin !== origin ||
      /export/i.test(request.url())
    )
      sent.push(`${request.method()} ${request.url()}`);
  });
  page.on("websocket", (socket) => socket.on("framesent", () => sent.push(`ws ${socket.url()}`)));
  const result = await runExport(page, { speed: 2, skipIdle: true, hashes: false });
  expect(result.frames).toBeGreaterThan(0);
  expect(sent).toEqual([]);
  const scan = await fileScan(page, [
    MARKER,
    privacy.seed.sessionId,
    privacy.home,
    daemon.token,
    "Quarterly",
    "events.jsonl",
  ]);
  expect(scan.size).toBe(result.bytes);
  expect(scan.found).toEqual([]);
  expect(scan.boxes).toEqual([]);
  const inside = await page.evaluate(() =>
    window.__localdot?.exportProbe?.sourcesBetween(60_000, 90_000),
  );
  expect(inside?.length).toBeGreaterThan(0);
  expect(inside?.every((source) => source !== "video" && source !== "backdrop")).toBe(true);
});

test("exports render identical frames in two exports (Review Focus 5)", async ({ page }) => {
  const range = {
    fromMs: privacy.seed.steps[1]?.startMs ?? 0,
    toMs: privacy.seed.steps[6]?.endMs ?? 30_000,
  };
  const options = { ...range, speed: 1 as const, skipIdle: false, hashes: true };
  await openForExport(page, privacy.seed.sessionId);
  const first = await runExport(page, options);
  await page.goto("about:blank");
  await openForExport(page, privacy.seed.sessionId);
  const second = await runExport(page, options);
  expect(first.hashes?.length).toBe(first.frames);
  expect(new Set(first.hashes).size).toBeGreaterThan(first.frames / 4);
  expect(second.hashes).toEqual(first.hashes);
});

test("exports a 2-hour session in bounded memory (Review Focus 4, export)", async ({ page }) => {
  test.setTimeout(20 * 60_000);
  await daemon?.stop();
  longSession = seedHome({ home: join(directory, "long-home"), minutes: 120 });
  daemon = await startReplayDaemon(longSession.home);
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const mainHeap = async () => {
    await session.send("HeapProfiler.collectGarbage");
    const { metrics } = await session.send("Performance.getMetrics");
    const heap = metrics.find((metric) => metric.name === "JSHeapUsedSize");
    if (!heap) throw new Error("Chrome did not report heap usage.");
    return heap.value;
  };
  await openForExport(page, longSession.seed.sessionId);
  const base = await mainHeap();
  const started = Date.now();
  const result = await runExport(page, { speed: 8, skipIdle: true, hashes: false });
  const seconds = (Date.now() - started) / 1000;
  expect(result.peakOpenFrames).toBeLessThanOrEqual(3);
  expect(result.peakEncodeQueue).toBeLessThanOrEqual(4);
  const heapGrowth = (await mainHeap()) - base;
  expect(heapGrowth).toBeLessThan(48 * 1024 * 1024);
  const scan = await fileScan(page, []);
  expect(scan.size).toBe(result.bytes);
  const measure = {
    frames: result.frames,
    seconds,
    fps: result.frames / seconds,
    megabytes: result.bytes / 1e6,
    heapGrowth,
    peakOpenFrames: result.peakOpenFrames,
    peakEncodeQueue: result.peakEncodeQueue,
  };
  writeFileSync("e2e/out/export-measure.json", `${JSON.stringify(measure, null, 2)}\n`);
  test.info().annotations.push({ type: "measure", description: JSON.stringify(measure) });
});
