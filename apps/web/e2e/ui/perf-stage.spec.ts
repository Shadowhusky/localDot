import type { Page, Worker } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";
import { between, installProbes, mark, record, streamDesktop } from "./perf.ts";

// What the live stage costs, fed a synthetic stream decoded as Selkies' is (see streamDesktop):
// at a fixed 60 or 30 fps with no task, then at the frame rate the viewer asks for under a running
// task, with the island's glass and without it. QA_PERF_OUT=<file> appends each run as a JSON line.
runAt("c14", "c39");
test.use({
  fixedClock: false,
  // Motion as most people see it: the harness reduces it.
  reducedMotion: "no-preference",
  deviceScaleFactor: 2,
  launchOptions: async ({ browserName }, use) =>
    use(browserName === "chromium" ? { args: ["--enable-gpu"] } : {}),
});

const WINDOW_MS = 20_000;

interface StageCounts {
  ticks: number;
  looks: number;
  renders: number;
  uploads: number;
}

// Counts the render worker's display-frame callbacks, its looks at the scene (each keys it with
// JSON.stringify and a replacer), its draws to the canvas (each clears the canvas's own framebuffer
// once) and its frame uploads. The worker looks its globals up on each call, so wrapping them now
// counts.
async function countStage(worker: Worker): Promise<() => Promise<StageCounts>> {
  await worker.evaluate(() => {
    const scope = self as unknown as {
      __stage?: StageCounts;
      requestAnimationFrame(callback: (t: number) => void): number;
    };
    const counts = { ticks: 0, looks: 0, renders: 0, uploads: 0 };
    scope.__stage = counts;
    const stringify = JSON.stringify;
    JSON.stringify = ((value: unknown, replacer?: unknown, space?: string | number) => {
      if (typeof replacer === "function") counts.looks++;
      return stringify(value, replacer as never, space);
    }) as typeof JSON.stringify;
    const raf = scope.requestAnimationFrame.bind(scope);
    scope.requestAnimationFrame = (callback) =>
      raf((t) => {
        counts.ticks++;
        callback(t);
      });
    const gl = WebGL2RenderingContext.prototype;
    const clear = gl.clear;
    gl.clear = function (this: WebGL2RenderingContext, mask: number) {
      if (this.getParameter(this.FRAMEBUFFER_BINDING) === null) counts.renders++;
      return clear.call(this, mask);
    };
    for (const name of ["texImage2D", "texSubImage2D"] as const) {
      const upload = gl[name] as (...args: unknown[]) => void;
      (gl as unknown as Record<string, unknown>)[name] = function (
        this: WebGL2RenderingContext,
        ...args: unknown[]
      ) {
        const source = args.at(-1);
        if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) counts.uploads++;
        return upload.apply(this, args);
      };
    }
  });
  return () =>
    worker.evaluate(() => ({ ...(self as unknown as { __stage: StageCounts }).__stage }));
}

async function renderWorker(page: Page): Promise<Worker> {
  await expect.poll(() => page.workers().some((w) => w.url().includes("render-worker"))).toBe(true);
  const worker = page.workers().find((w) => w.url().includes("render-worker"));
  if (!worker) throw new Error("No render worker");
  return worker;
}

for (const { fps, task, glass, full } of [
  { fps: 60, task: false, glass: true, full: false },
  { fps: 30, task: false, glass: true, full: false },
  { fps: 0, task: true, glass: true, full: false },
  { fps: 0, task: true, glass: false, full: false },
  { fps: 0, task: true, glass: true, full: true },
  { fps: 0, task: true, glass: false, full: true },
]) {
  const rate = fps ? `${fps} fps` : "the frame rate it asks for";
  const name = `${task ? "a running task" : "the computer"} at ${rate}${full ? ", full screen" : ""}${glass ? "" : ", solid island"}`;
  test(`stage cost: ${name}`, async ({ page, ui }) => {
    test.setTimeout(150_000);
    const phone = test.info().project.name === "c39";
    test.skip(
      phone && (fps === 60 || !glass || full),
      "A phone asks for 30 fps; its island is solid",
    );
    await installProbes(page);
    await streamDesktop(page, fps ? { fps, follow: false } : {});
    const fixture = await ui.open(task ? "running" : "ready");
    await ui.picture();
    const stage = await countStage(await renderWorker(page));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    if (!glass) {
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const { styleSheetId } = await cdp.send("CSS.createStyleSheet", {
        frameId: frameTree.frame.id,
      });
      await cdp.send("CSS.setStyleSheetText", {
        styleSheetId,
        text: ".island-plate, .island-note { backdrop-filter: none !important; }",
      });
    }
    if (task) {
      const run = await page.request.post(`${fixture.origin}/__qa/live-run?ms=60000`);
      expect(run.ok()).toBe(true);
    }
    const canvas = page.locator("canvas.stage-canvas");
    if (full) {
      const enter = page.locator(".stage-expand").getByRole("button", { name: "Full screen" });
      await enter.focus();
      await enter.press("Enter");
      await expect
        .poll(() => canvas.evaluate((node) => node.getBoundingClientRect().width))
        .toBeGreaterThan(1100);
    }
    await page.waitForTimeout(3_000);
    const geometry = await canvas.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return {
        css: `${Math.round(box.width)}x${Math.round(box.height)}`,
        share: Math.round(((box.width * box.height) / (innerWidth * innerHeight)) * 100) / 100,
      };
    });
    const from = { page: await mark(page, cdp), stage: await stage() };
    await page.waitForTimeout(WINDOW_MS);
    const to = { page: await mark(page, cdp), stage: await stage() };
    await cdp.detach();
    const seconds = (to.page.at - from.page.at) / 1000;
    const rate = (key: keyof StageCounts) =>
      Math.round(((to.stage[key] - from.stage[key]) / seconds) * 10) / 10;
    const cost = between(from.page, to.page);
    const result = {
      spec: "stage",
      project: test.info().project.name,
      name,
      geometry,
      presentedFps: Number(await canvas.getAttribute("data-fps")),
      ticksPerS: rate("ticks"),
      looksPerS: rate("looks"),
      rendersPerS: rate("renders"),
      uploadsPerS: rate("uploads"),
      rendererCpuPct: cost.rendererCpuPct,
      gpuCpuPct: cost.gpuCpuPct,
      mainCpuPct: cost.mainCpuPct,
      mainTaskMsPerS: cost.mainTaskMsPerS,
      commitsPerS: cost.commitsPerS,
      rafFps: cost.rafFps,
    };
    console.log(JSON.stringify(result));
    test.info().annotations.push({ type: "stage", description: JSON.stringify(result) });
    record(result);
    expect(result.uploadsPerS).toBeGreaterThan(5);
    expect(result.rendersPerS).toBeGreaterThan(0);
    // Budgets, generous over what the app does now; QA_UI_DIR measures another build against them.
    if (process.env.QA_UI_DIR) return;
    expect(result.looksPerS, "the stage looks at most at 60 Hz").toBeLessThanOrEqual(66);
    expect(result.rendersPerS, "and draws at most at 60 Hz").toBeLessThanOrEqual(66);
    if (!fps && geometry.share < 0.6)
      expect(result.uploadsPerS, "a small stage takes 30 fps").toBeLessThanOrEqual(36);
  });
}

test("stage cost: a minimised phone screen", async ({ page, ui }) => {
  test.setTimeout(150_000);
  test.skip(test.info().project.name !== "c39", "The phone's screen folds away");
  await installProbes(page);
  await streamDesktop(page);
  const fixture = await ui.open("running");
  await ui.picture();
  const stage = await countStage(await renderWorker(page));
  const run = await page.request.post(`${fixture.origin}/__qa/live-run?ms=90000`);
  expect(run.ok()).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Minimize screen", exact: true }).click();
  await expect(page.locator(".stage-col")).toHaveCSS("max-height", "0px");
  await page.waitForTimeout(3_000);
  const from = { page: await mark(page, cdp), stage: await stage() };
  await page.waitForTimeout(WINDOW_MS / 2);
  const to = { page: await mark(page, cdp), stage: await stage() };
  const seconds = (to.page.at - from.page.at) / 1000;
  const rate = (key: keyof StageCounts) =>
    Math.round(((to.stage[key] - from.stage[key]) / seconds) * 10) / 10;
  const cost = between(from.page, to.page);
  const result = {
    spec: "stage",
    project: test.info().project.name,
    name: "a running task, its phone screen minimised",
    looksPerS: rate("looks"),
    rendersPerS: rate("renders"),
    uploadsPerS: rate("uploads"),
    rendererCpuPct: cost.rendererCpuPct,
    gpuCpuPct: cost.gpuCpuPct,
    mainCpuPct: cost.mainCpuPct,
    commitsPerS: cost.commitsPerS,
  };
  console.log(JSON.stringify(result));
  test.info().annotations.push({ type: "stage", description: JSON.stringify(result) });
  record(result);
  await page.getByRole("button", { name: "Show screen", exact: true }).click();
  const shown = await stage();
  await expect.poll(async () => (await stage()).uploads - shown.uploads).toBeGreaterThan(10);
  await cdp.detach();
  if (process.env.QA_UI_DIR) return;
  expect(result.uploadsPerS, "a folded screen takes no frames").toBeLessThan(1);
  expect(result.looksPerS, "and draws nothing").toBeLessThan(1);
});
