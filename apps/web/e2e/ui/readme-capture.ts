import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import sharp from "sharp";
import { assertFreshBuild, startUiFixture, TOKEN } from "../fixtures/start-ui-fixture.ts";
import { skipSetup } from "../skip-setup.ts";

// Capture the actual app with synthetic data; never attach to a user's running daemon.
// From apps/web: node --import tsx e2e/ui/readme-capture.ts
assertFreshBuild("app");
const out = fileURLToPath(new URL("../../../../docs/readme/", import.meta.url));
await mkdir(out, { recursive: true });
const fixture = await startUiFixture({ QA_SCENARIO: "running", QA_NOW: "2026-10-08T09:00:00Z" });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    locale: "en-GB",
    timezoneId: "UTC",
    colorScheme: "dark",
  });
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  await skipSetup(page);
  await page.clock.setFixedTime(new Date("2026-10-08T09:01:00Z"));
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  const form = page.getByRole("form", { name: "Message dot" });
  await expect(form.getByRole("button", { name: "Stop task", exact: true })).toBeVisible();
  await expect(page.locator(".stage").first()).toBeVisible();
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
  await page.screenshot({ path: `${out}/watch.png` });
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
  await form.getByRole("button", { name: "Queue message" }).click();
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
