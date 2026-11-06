import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { VIEW_STYLE_KEY, type ViewStyle } from "../../src/shell/view-style.ts";
import {
  assertFreshBuild,
  startUiFixture,
  TOKEN,
  type UiFixture,
} from "../fixtures/start-ui-fixture.ts";
import { skipSetup } from "../skip-setup.ts";

// Capture the actual app with synthetic data; never attach to a user's running daemon.
// From apps/web: node --import tsx e2e/ui/readme-capture.ts
// The README's screenshots, then the website's pictures of the app: several tasks at once in Studio,
// and Chat's list on a phone. The website's Studio shows a frame of its Kyoto demo, so those need that
// demo's video in apps/site/public (apps/site/README.md, Demos).
assertFreshBuild("app");
const out = fileURLToPath(new URL("../../../../docs/readme/", import.meta.url));
await mkdir(out, { recursive: true });
const site = fileURLToPath(new URL("../../../site/public/screens/", import.meta.url));
const kyoto = fileURLToPath(
  new URL("../../../site/public/demos/kyoto/theatre.mp4", import.meta.url),
);
const fixture = await startUiFixture({
  QA_SCENARIO: "running",
  QA_NOW: "2026-10-08T09:00:00Z",
  QA_ACTIVITY: "readme",
  QA_PAST: "1",
});
const browser = await chromium.launch();
const look = {
  reducedMotion: "reduce",
  locale: "en-GB",
  timezoneId: "UTC",
  colorScheme: "dark",
} as const;
const open = async (
  page: Page,
  view: ViewStyle,
  address = "",
  from: UiFixture = fixture,
  now = "2026-10-08T09:01:00Z",
) => {
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  await skipSetup(page);
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [VIEW_STYLE_KEY, view],
  );
  await page.clock.setFixedTime(new Date(now));
  await page.goto(`${from.origin}/#token=${TOKEN}`);
  if (address) {
    await page.waitForFunction(() => !window.location.hash.includes("token="));
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, address);
  }
};
// Studio with the live task's screen up and every dot dressed.
const studioReady = async (page: Page) => {
  const form = page.getByRole("form", { name: "Message dot" });
  await expect(form.getByRole("button", { name: "Stop task", exact: true })).toBeVisible();
  await expect(page.locator(".stage").first()).toBeVisible();
  // The live task's controls show once its screen is connected; the connecting card is busy enough
  // to pass the picture check below.
  await expect(page.getByRole("button", { name: "Take control" })).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(
      async () => {
        const { channels } = await sharp(await page.locator(".stage").first().screenshot()).stats();
        return Math.max(...channels.map((channel) => channel.stdev));
      },
      { timeout: 15000 },
    )
    .toBeGreaterThan(20);
  // The rail's dots come in their own time, and a dot's plates show together.
  await expect(page.locator(".sessions-item")).not.toHaveCount(0);
  await expect(page.locator(".dot-avatar[data-loading], .dot[data-skin='loading']")).toHaveCount(0);
  await page.waitForTimeout(300);
};
try {
  const page = await browser.newPage({
    ...look,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await open(page, "studio");
  const form = page.getByRole("form", { name: "Message dot" });
  await studioReady(page);
  await page.screenshot({ path: `${out}/studio.png` });
  const phone = await browser.newPage({
    ...look,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await open(phone, "chat", "#/c/current");
  await expect(phone.locator(".phone-stack")).toHaveAttribute("data-level", "1");
  await expect(phone.getByRole("button", { name: "Open the computer" })).toBeVisible();
  await expect(phone.locator(".dot-avatar[data-loading], .dot[data-skin='loading']")).toHaveCount(
    0,
  );
  await phone.waitForTimeout(1500);
  await phone.screenshot({ path: `${out}/chat.png` });
  await phone.close();
  await form.getByRole("textbox").first().focus();
  await form.getByRole("button", { name: /^Permission mode:/ }).click();
  await expect(page.getByRole("menuitemradio", { name: /^Full access/ })).toBeVisible();
  await page.waitForTimeout(200);
  const rail = page.locator(".rail-chat");
  const bounds = await rail.boundingBox();
  if (!bounds) throw new Error("Conversation panel is not visible");
  await page.screenshot({
    path: `${out}/permissions.png`,
    clip: { ...bounds, y: bounds.y + bounds.height - 400, height: 400 },
  });
  await page.keyboard.press("Escape");
  await form
    .getByRole("textbox", { name: "Message" })
    .fill("When you're finished, add a chart of the monthly totals.");
  await form.getByRole("button", { name: "Message options" }).click();
  await page.getByRole("menuitem", { name: "Send after this task" }).click();
  const queued = page
    .getByRole("article", { name: "You", exact: true })
    .filter({ hasText: "When you're finished" });
  await expect(queued.getByRole("button", { name: "Steer now" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${out}/queue.png`,
    clip: { ...bounds, y: bounds.y + bounds.height - 510, height: 510 },
  });
  await page.close();
} catch (error) {
  await browser.close();
  throw error;
} finally {
  await fixture.close();
}
if (!existsSync(kyoto)) {
  await browser.close();
  throw new Error(`The website's pictures need ${kyoto}: build the site's demos first.`);
}

// The website's: dot plans Kyoto in its browser window, a frame of the demo, while three more tasks
// work in theirs. Each is kept at twice the size the website lays it out, which is as sharp as a phone
// or a desktop shows it.
const scratch = mkdtempSync(join(tmpdir(), "localdot-site-capture-"));
const frame = join(scratch, "kyoto.png");
const cut = spawnSync("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-ss",
  "14",
  "-i",
  kyoto,
  "-frames:v",
  "1",
  frame,
]);
if (cut.status !== 0) throw new Error(`ffmpeg could not take the Kyoto frame: ${cut.stderr}`);
const picture = join(scratch, "kyoto.webp");
await sharp(frame).webp({ quality: 92 }).toFile(picture);
await mkdir(site, { recursive: true });
const several = await startUiFixture({
  QA_SCENARIO: "running",
  QA_NOW: "2026-10-15T03:10:00Z",
  QA_ACTIVITY: "several",
  QA_PICTURE: picture,
});
const SITE_NOW = "2026-10-15T03:11:00Z";
const keep = (shot: Buffer, file: string, width: number) =>
  sharp(shot).resize({ width }).webp({ quality: 80 }).toFile(join(site, file));
try {
  for (const [file, width, height, kept] of [
    ["several.webp", 1440, 900, 1920],
    ["several-tall.webp", 820, 1180, 960],
  ] as const) {
    const page = await browser.newPage({
      ...look,
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    await open(page, "studio", "", several, SITE_NOW);
    await studioReady(page);
    await expect(page.locator(".sessions-item")).toHaveCount(8);
    await keep(await page.screenshot(), file, kept);
    await page.close();
  }
  // The site's phone is 390 by 800.
  const phone = await browser.newPage({
    ...look,
    viewport: { width: 390, height: 800 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await open(phone, "chat", "", several, SITE_NOW);
  await expect(phone.locator(".phone-stack")).toHaveAttribute("data-level", "0");
  await expect(phone.getByText("Clean up my Downloads folder")).toBeVisible();
  await expect(phone.locator(".dot-avatar[data-loading], .dot[data-skin='loading']")).toHaveCount(
    0,
  );
  await phone.waitForTimeout(1500);
  await keep(await phone.screenshot(), "chat-list.webp", 780);
} finally {
  await browser.close();
  await several.close();
  rmSync(scratch, { recursive: true, force: true });
}
