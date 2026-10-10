import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDotEvent, ulid } from "@localdot/protocol";
import { frameOfLuma } from "@localdot/stage/testing";
import { expect, type Page, test } from "@playwright/test";
import { type SeedResult, seedSession } from "../../daemon/src/recorder/testing/seed-session.ts";
import type { RunningDaemon } from "./daemon.ts";
import { startReplayDaemon } from "./seed.ts";
import { skipSetup } from "./skip-setup.ts";

let directory: string, home: string, desktop: SeedResult, browser: SeedResult;
let daemon: RunningDaemon | undefined;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "localdot-two-screen-replay-"));
  home = join(directory, "home");
  const common = { home, minutes: 0.2, stepsPerMinute: 30, takeover: { fromMs: 4000, toMs: 5000 } };
  desktop = await seedSession({ ...common, title: "Desktop and browser recording" });
  browser = await seedSession({
    ...common,
    title: "Browser track fixture",
    synth: { widthMbs: 24, heightMbs: 16, keyEvery: 16 },
  });
  cpSync(
    join(home, "sessions", browser.sessionId, "recording"),
    join(home, "sessions", desktop.sessionId, "recording-browser"),
    { recursive: true },
  );
  const path = join(home, "sessions", desktop.sessionId, "events.jsonl");
  const events = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => LocalDotEvent.parse(JSON.parse(line)))
    .filter((event) => event.type !== "observe" || event.t < 2000000 || event.t >= 8000000);
  for (const [screen, t, revision, geometry] of [
    ["browser", 2000000, 1, { w: 384, h: 256, scale: 1 }],
    ["desktop", 8000000, 2, { w: 2560, h: 1600, scale: 2 }],
  ] as const)
    events.push(
      LocalDotEvent.parse({
        v: 1,
        id: ulid(),
        seq: 0,
        t,
        agent: "main",
        type: "screen.switch",
        data: { screen, revision, geometry, cellId: ulid(), by: "agent" },
      }),
    );
  events.sort((a, b) => a.t - b.t);
  writeFileSync(
    path,
    `${events.map((event, seq) => JSON.stringify({ ...event, seq })).join("\n")}\n`,
  );
  daemon = await startReplayDaemon(home);
  mkdirSync("e2e/out", { recursive: true });
});
test.afterAll(async () => {
  try {
    await daemon?.stop();
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

async function open(page: Page) {
  if (!daemon) throw new Error("Replay fixture is unavailable.");
  await page.goto(
    `${daemon.origin}/?replay=${desktop.sessionId}&replayProbe=1&exportProbe=1#token=${daemon.token}`,
  );
  await page.waitForFunction(() => window.__localdot?.replay?.status() === "ready");
}
async function seek(page: Page, time: number) {
  await page.evaluate(async (time) => {
    const hook = window.__localdot?.replay;
    if (!hook) throw new Error("Replay hook is missing.");
    await hook.probe({ op: "enable" });
    await hook.seek(time, "exact");
  }, time);
}

// The real daemon starts with no model; what is under first-run setup is what these check.
test.beforeEach(({ page }) => skipSetup(page));
test("switches actual decoded recordings at the same time and retains private gaps", async ({
  page,
}) => {
  await open(page);
  await seek(page, 2500);
  const actualIndex = async (seed: SeedResult) => {
    const luma = (await page.evaluate(async (synth) => {
      const hook = window.__localdot?.replay;
      if (!hook) throw new Error("Replay hook is missing.");
      return hook.probe({ op: "mb-luma", widthMbs: synth.widthMbs, heightMbs: synth.heightMbs });
    }, seed.synth)) as number[];
    return frameOfLuma(seed.synth, luma);
  };
  expect(await actualIndex(desktop)).toBe(
    desktop.frames.findLast((frame) => frame.tMicros <= 2500000)?.index,
  );
  await page.getByRole("radio", { name: "Browser", exact: true }).click();
  await page.waitForFunction(() => window.__localdot?.replay?.status() === "ready");
  await expect(page.getByRole("slider", { name: "Replay timeline" })).toHaveAttribute(
    "aria-valuenow",
    "2500",
  );
  await seek(page, 2500);
  expect(await actualIndex(browser)).toBe(
    browser.frames.findLast((frame) => frame.tMicros <= 2500000)?.index,
  );
  await page.screenshot({ path: "e2e/out/two-screen-browser.png" });
  await seek(page, 4500);
  await expect(page.getByText("Nothing was recorded while you were in control.")).toBeVisible();
  await page.getByRole("radio", { name: "Desktop", exact: true }).click();
  await page.waitForFunction(() => window.__localdot?.replay?.status() === "ready");
  await expect(page.getByRole("slider", { name: "Replay timeline" })).toHaveAttribute(
    "aria-valuenow",
    "4500",
  );
  await seek(page, 7000);
  expect(await actualIndex(desktop)).toBe(
    desktop.frames.findLast((frame) => frame.tMicros <= 7000000)?.index,
  );
});

test("exports the chosen browser track as decodable MP4 and omits its private interval", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("radio", { name: "Browser", exact: true }).click();
  await page.waitForFunction(() => window.__localdot?.replay?.status() === "ready");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/recording/video.mp4")) requests.push(request.url());
  });
  const result = await page.evaluate(async () => {
    const probe = window.__localdot?.exportProbe;
    if (!probe) throw new Error("Export probe is missing.");
    const exported = await probe.run({
      fromMs: 3000,
      toMs: 6000,
      skipIdle: false,
      captions: false,
      size: { w: 1280, h: 800 },
    });
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle("localdot-export-probe.mp4")).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      ...exported,
      encoded: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")),
      privateSources: probe.sourcesBetween(4000, 5000),
      size: file.size,
    };
  });
  // Saved files play outside the app. Its production CSP deliberately forbids blob media.
  const player = await page.context().newPage();
  const playback = await player.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const video = document.createElement("video");
    video.muted = true;
    const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    try {
      const loaded = new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("Export is not playable."));
      });
      video.src = url;
      await loaded;
      await video.play();
      await new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve()));
      return {
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      };
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
  }, result.encoded);
  await player.close();
  expect(playback.width).toBe(1280);
  expect(playback.height).toBe(800);
  expect(playback.duration).toBeCloseTo(3, 1);
  expect(result.size).toBe(result.bytes);
  expect(result.privateSources.length).toBeGreaterThan(0);
  expect(new Set(result.privateSources)).toEqual(new Set(["hold"]));
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((url) => new URL(url).searchParams.get("screen") === "browser")).toBe(true);
});

test("offers no screen switch when the browser track is missing, and keeps the desktop", async ({
  page,
}) => {
  rmSync(join(home, "sessions", desktop.sessionId, "recording-browser"), { recursive: true });
  await open(page);
  await seek(page, 3000);
  await expect(page.getByRole("radiogroup", { name: "Recording screen" })).toHaveCount(0);
  expect(await page.evaluate(() => window.__localdot?.replay?.status())).toBe("ready");
});
