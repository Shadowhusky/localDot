import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameOfLuma } from "@localdot/stage/testing";
import { expect, type Page, test } from "@playwright/test";
import type { ReplayDebugHook } from "../src/stage/debug-hooks.ts";
import type { RunningDaemon } from "./daemon.ts";
import { type SeededHome, seedHome, startReplayDaemon } from "./seed.ts";

type Hook = ReplayDebugHook;
let daemon: RunningDaemon | undefined;
let directory: string | undefined;
let shortSession: SeededHome;
let longSession: SeededHome;

test.use({ launchOptions: { args: ["--js-flags=--expose-gc"] } });
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "localdot-replay-pins-"));
  shortSession = seedHome({ home: join(directory, "home"), minutes: 2 });
  longSession = seedHome({ home: shortSession.home, minutes: 120, title: "Two hours" });
  daemon = await startReplayDaemon(shortSession.home);
});
test.afterAll(async () => {
  try {
    await daemon?.stop();
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

async function openReplay(page: Page, sessionId: string): Promise<void> {
  if (!daemon) throw new Error("Replay fixture is not running.");
  await page.goto(`${daemon.origin}/?replay=${sessionId}&replayProbe=1#token=${daemon.token}`);
  await page.waitForFunction(() => window.__localdot?.replay?.status() === "ready", undefined, {
    timeout: 60_000,
  });
  await page.evaluate(() => window.__localdot?.replay?.probe({ op: "enable" }));
}
const seek = (page: Page, tMs: number, mode: "exact" | "preview" = "exact") =>
  page.evaluate(
    ({ tMs, mode }) => {
      const hook = window.__localdot?.replay;
      if (!hook) throw new Error("Replay hook is missing.");
      return hook.seek(tMs, mode);
    },
    {
      tMs,
      mode,
    },
  );
const probe = (page: Page, command: Parameters<Hook["probe"]>[0]) =>
  page.evaluate((command) => {
    const hook = window.__localdot?.replay;
    if (!hook) throw new Error("Replay hook is missing.");
    return hook.probe(command);
  }, command);

test("shows the frame on screen at any scrubbed time (Review Focus 1)", async ({ page }) => {
  await openReplay(page, shortSession.seed.sessionId);
  const { frames, synth } = shortSession.seed;
  const stride = Math.max(1, Math.floor(frames.length / 60));
  for (let index = 1; index < frames.length; index += stride) {
    const current = frames[index];
    const previous = frames[index - 1];
    if (!current || !previous) throw new Error("Missing seeded frame.");
    for (const tMs of [
      current.tMicros / 1000,
      (current.tMicros + 1) / 1000,
      (previous.tMicros + current.tMicros) / 2000,
      (current.tMicros - 1) / 1000,
    ]) {
      await seek(page, tMs);
      const luma = (await probe(page, {
        op: "mb-luma",
        widthMbs: synth.widthMbs,
        heightMbs: synth.heightMbs,
      })) as number[];
      const expected = frames.filter((frame) => frame.tMicros <= tMs * 1000).at(-1);
      expect(expected).toBeDefined();
      expect(frameOfLuma(synth, luma), `t = ${tMs} ms`).toBe(expected?.index);
    }
  }
});

test("draws identical overlays in separate loads (Review Focus 5)", async ({ page }) => {
  const times = shortSession.seed.steps
    .slice(0, 12)
    .flatMap((step) => [
      step.startMs + 130,
      step.dispatchMs - 40,
      step.dispatchMs + 23,
      step.dispatchMs + 150,
      step.endMs + 600,
    ]);
  const hashes = async () => {
    await openReplay(page, shortSession.seed.sessionId);
    const values: string[] = [];
    for (const tMs of times) {
      await seek(page, tMs);
      values.push((await probe(page, { op: "overlay-hash", tMs })) as string);
    }
    return values;
  };
  const first = await hashes();
  await page.goto("about:blank");
  expect(await hashes()).toEqual(first);
  expect(new Set(first).size).toBeGreaterThan(times.length / 2);
});

test("scrubs a two-hour session in bounded memory (Review Focus 4, the browser)", async ({
  page,
}) => {
  await openReplay(page, longSession.seed.sessionId);
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const mainHeap = async () => {
    await session.send("HeapProfiler.collectGarbage");
    const { metrics } = await session.send("Performance.getMetrics");
    const heap = metrics.find((metric) => metric.name === "JSHeapUsedSize");
    if (!heap) throw new Error("Chrome did not report heap usage.");
    return heap.value;
  };
  const workerHeap = async () => {
    const workers = page.workers().filter((worker) => worker.url().includes("render-worker"));
    expect(workers.length).toBeGreaterThan(0);
    const heaps = await Promise.all(
      workers.map((worker) =>
        worker.evaluate(() => {
          (globalThis as { gc?: () => void }).gc?.();
          return (
            (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? null
          );
        }),
      ),
    );
    return heaps.every((heap): heap is number => heap !== null)
      ? heaps.reduce((total, heap) => total + heap, 0)
      : null;
  };
  const stats = async () =>
    (await probe(page, { op: "stats" })) as { openFrames: number; decodeQueue: number };
  const baseMain = await mainHeap();
  const baseWorker = await workerHeap();
  const end = longSession.seed.steps.at(-1)?.endMs ?? 7_200_000;
  let randomSeed = 5;
  const latencies: number[] = [];
  for (let index = 0; index < 300; index++) {
    randomSeed = (randomSeed * 48_271) % 2_147_483_647;
    const started = Date.now();
    await seek(page, (randomSeed / 2_147_483_647) * end);
    latencies.push(Date.now() - started);
    if (index % 25 === 0) {
      const current = await stats();
      expect(current.openFrames).toBeLessThanOrEqual(3);
      expect(current.decodeQueue).toBeLessThanOrEqual(4);
    }
  }
  await page.evaluate(async (end) => {
    const hook = window.__localdot?.replay;
    if (!hook) throw new Error("Replay hook is missing.");
    const pending: Promise<void>[] = [];
    for (let index = 0; index < 100; index++)
      pending.push(hook.seek((index / 100) * end, "preview"));
    await Promise.all(pending);
  }, end);
  expect((await stats()).openFrames).toBeLessThanOrEqual(3);
  await page.evaluate(() => {
    const hook = window.__localdot?.replay;
    if (!hook) throw new Error("Replay hook is missing.");
    hook.transport({ playing: true, speed: 8, skipIdle: true });
  });
  for (let seconds = 0; seconds < 20; seconds++) {
    await page.waitForTimeout(1000);
    expect((await stats()).openFrames).toBeLessThanOrEqual(3);
  }
  latencies.sort((left, right) => left - right);
  expect(latencies[Math.floor(latencies.length * 0.95)]).toBeLessThan(1000);
  expect((await mainHeap()) - baseMain).toBeLessThan(32 * 1024 * 1024);
  const afterWorker = await workerHeap();
  if (baseWorker !== null && afterWorker !== null)
    expect(afterWorker - baseWorker).toBeLessThan(96 * 1024 * 1024);
  else
    test.info().annotations.push({
      type: "unverified",
      description: "This Chrome build does not expose worker heap measurements.",
    });
});
