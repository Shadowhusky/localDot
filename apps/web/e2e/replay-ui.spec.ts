import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import sharp from "sharp";
import type { RunningDaemon } from "./daemon.ts";
import { type SeededHome, seedHome, startReplayDaemon } from "./seed.ts";
import { skipSetup } from "./skip-setup.ts";

let daemon: RunningDaemon | undefined;
let directory: string | undefined;
let seeded: SeededHome;

test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "localdot-replay-ui-"));
  seeded = seedHome({
    home: join(directory, "home"),
    minutes: 10,
    stepsPerMinute: 6,
    title: "Organize a workspace",
    takeover: "30000-40000",
  });
  daemon = await startReplayDaemon(seeded.home);
  mkdirSync("e2e/out", { recursive: true });
});
test.afterAll(async () => {
  try {
    await daemon?.stop();
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

async function openReplay(page: Page): Promise<void> {
  if (!daemon) throw new Error("Replay fixture is not running.");
  await page.goto(
    `${daemon.origin}/?replay=${seeded.seed.sessionId}&replayProbe=1#token=${daemon.token}`,
  );
  await page.waitForFunction(() => window.__localdot?.replay?.status() === "ready", undefined, {
    timeout: 60_000,
  });
  await expect(page.getByRole("slider", { name: "Replay timeline" })).toHaveAttribute(
    "aria-valuemax",
    "600000",
  );
  await page.evaluate(() => window.__localdot?.replay?.probe({ op: "enable" }));
}
async function seek(page: Page, time: number): Promise<void> {
  await page.evaluate((time) => {
    const hook = window.__localdot?.replay;
    if (!hook) throw new Error("Replay hook is missing.");
    return hook.seek(time, "exact");
  }, time);
}
async function bounds(locator: Locator) {
  const rectangle = await locator.boundingBox();
  if (!rectangle) throw new Error("Replay control has no bounds.");
  return rectangle;
}
async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `e2e/out/replay-${name}.png` });
}
async function largestDifference(one: Buffer, other: Buffer): Promise<number> {
  const [a, b] = await Promise.all([one, other].map((png) => sharp(png).raw().toBuffer()));
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let largest = 0;
  for (let at = 0; at < a.length; at++)
    largest = Math.max(largest, Math.abs((a[at] ?? 0) - (b[at] ?? 0)));
  return largest;
}
const position = async (page: Page) =>
  Number(await page.getByRole("slider", { name: "Replay timeline" }).getAttribute("aria-valuenow"));

// The real daemon starts with no model; what is under first-run setup is what these check.
test.beforeEach(({ page }) => skipSetup(page));
test("plays, scrubs and steps through a seeded session", async ({ page }) => {
  await openReplay(page);
  await page.getByRole("combobox", { name: "Playback speed" }).click();
  await page.getByRole("option", { name: "4×" }).click();
  await page.getByRole("button", { name: "Play replay" }).click();
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Pause replay" }).click();
  expect(await position(page)).toBeGreaterThanOrEqual(8000);
  await seek(page, 10_100);
  // The island names the step on show.
  await expect(page.locator(".replay-main .island-label-text")).toContainText("Typing a sample");
  const track = await bounds(page.getByRole("slider", { name: "Replay timeline" }));
  const before = await position(page);
  await page.mouse.move(track.x + track.width * 0.7, track.y + track.height / 2);
  await page.mouse.down();
  await expect.poll(() => position(page)).toBeGreaterThan(before + 100_000);
  await page.mouse.move(track.x + track.width * 0.3, track.y + track.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const playhead = await bounds(page.locator(".replay-playhead"));
      return Math.abs(playhead.x + playhead.width / 2 - (track.x + track.width * 0.3));
    })
    .toBeLessThanOrEqual(1);
  const released = await position(page);
  const nextSteps = seeded.seed.steps.filter((step) => step.startMs > released + 0.5);
  const target = nextSteps[1];
  if (!target) throw new Error("Fixture has no second next chapter.");
  await page
    .getByRole("slider", { name: "Replay timeline" })
    .evaluate((element) => (element as HTMLElement).blur());
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => position(page)).toBe(target.startMs);
  await page.mouse.move(8, 8);
  await screenshot(page, "theatre");
});

test("skips idle by default and says so", async ({ page }) => {
  await openReplay(page);
  const skip = page.getByRole("button", { name: "Skip idle" });
  await expect(skip).toHaveAttribute("aria-pressed", "true");
  await seek(page, 4000);
  await expect(page.locator(".replay-speed-label")).toHaveText("Idle skipped");
  const track = page.getByRole("slider", { name: "Replay timeline" });
  const compressed = Number(await track.getAttribute("data-duration-ms"));
  await skip.click();
  await expect(skip).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(async () => Number(await track.getAttribute("data-duration-ms")))
    .toBeGreaterThan(compressed);
  await expect(track).toHaveAttribute("data-duration-ms", "600000");
  await screenshot(page, "idle");
});

test("shows a takeover gap card and the backdrop over it", async ({ page }) => {
  await openReplay(page);
  await seek(page, 29_000);
  const stage = await bounds(page.locator(".replay-main .stage canvas"));
  const clip = {
    x: stage.x + stage.width * 0.15,
    y: stage.y + stage.height * 0.25,
    width: 64,
    height: 64,
  };
  const before = await page.screenshot({ clip });
  const statistics = await sharp(before).stats();
  expect(statistics.channels.slice(0, 3).every((channel) => channel.mean > 30)).toBe(true);
  await seek(page, 35000);
  await expect(page.getByText("You had control here", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing was recorded while you were in control.")).toBeVisible();
  // The last picture stays behind the card: the same pixels, give or take a rounding step.
  expect(await largestDifference(await page.screenshot({ clip }), before)).toBeLessThanOrEqual(2);
  await screenshot(page, "takeover");
});

test("compares before and after", async ({ page }) => {
  await openReplay(page);
  await seek(page, 17_600);
  await page.keyboard.press("b");
  await expect(page.getByRole("region", { name: "Before and after comparison" })).toBeVisible();
  for (const description of ["Screen before this step", "Screen after this step"])
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: description })
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(1280);
  const divider = page.getByRole("slider", { name: "Comparison divider" });
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  const area = await bounds(divider);
  await page.mouse.move(area.x + area.width * 0.2, area.y + area.height / 2);
  await page.mouse.down();
  await expect(divider).toHaveAttribute("aria-valuenow", "20");
  await page.mouse.move(area.x + area.width * 0.8, area.y + area.height / 2, { steps: 10 });
  await expect(divider).toHaveAttribute("aria-valuenow", "80");
  await page.mouse.up();
  await screenshot(page, "compare");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Before and after comparison" })).toHaveCount(0);
  await expect(page.getByRole("main", { name: "Replay" })).toBeVisible();
});

test("reduced motion: the playhead jumps and the compare wipe does not animate", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openReplay(page);
  await seek(page, 17_600);
  await page.keyboard.press("b");
  const divider = page.getByRole("slider", { name: "Comparison divider" });
  await divider.focus();
  await page.keyboard.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", "100");
  for (const selector of [
    ".replay-playhead",
    ".replay-compare-divider",
    ".replay-compare-before",
  ]) {
    expect(
      await page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          transition: style.transitionDuration,
          animation: style.animationName,
          active: element.getAnimations().length,
        };
      }),
    ).toEqual({ transition: "0s", animation: "none", active: 0 });
  }
  await screenshot(page, "reduced-motion");
});
