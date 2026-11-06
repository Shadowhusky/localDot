import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { VIEW_STYLE_KEY, type ViewStyle } from "../../src/shell/view-style.ts";
import { assertFreshBuild, startUiFixture, TOKEN } from "../fixtures/start-ui-fixture.ts";
import { skipSetup } from "../skip-setup.ts";

// Capture the actual app with synthetic data; never attach to a user's running daemon.
// From apps/web: node --import tsx e2e/ui/readme-capture.ts
assertFreshBuild("app");
const out = fileURLToPath(new URL("../../../../docs/readme/", import.meta.url));
await mkdir(out, { recursive: true });
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
const open = async (page: Page, view: ViewStyle, address = "") => {
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  await skipSetup(page);
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [VIEW_STYLE_KEY, view],
  );
  await page.clock.setFixedTime(new Date("2026-10-08T09:01:00Z"));
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  if (address) {
    await page.waitForFunction(() => !window.location.hash.includes("token="));
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, address);
  }
};
try {
  const page = await browser.newPage({
    ...look,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await open(page, "studio");
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
} finally {
  await browser.close();
  await fixture.close();
}
