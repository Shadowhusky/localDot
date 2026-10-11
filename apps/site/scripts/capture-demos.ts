import { demoScreen } from "./demo-screen.mjs";
import sharp from "../../web/node_modules/sharp/dist/index.mjs";
import { chromium, expect } from "../../web/node_modules/@playwright/test/index.mjs";
import { startUiFixture, TOKEN } from "../../web/e2e/fixtures/start-ui-fixture.ts";
import { skipSetup } from "../../web/e2e/skip-setup.ts";
import { showActivity, showChat } from "../../web/e2e/layout.ts";
import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const out = fileURLToPath(new URL("../public/demos/", import.meta.url));
const temp = fileURLToPath(new URL("../qa/capture/", import.meta.url));
await mkdir(temp, { recursive: true });
const mobile = process.argv.includes("--mobile");
const size = mobile ? { width: 390, height: 500 } : { width: 1440, height: 900 };
const browser = await chromium.launch();
try {
  for (const [name, activity] of mobile
    ? [
        ["work", ""],
        ["research", "research"],
        ["play", "long"],
      ]
    : [
        ["work", ""],
        ["research", "research"],
        ["play", "long"],
      ]) {
    const outputName = name + (mobile ? "-mobile" : "");
    const fixture = await startUiFixture(
      {
        ...(activity ? { QA_ACTIVITY: activity } : { QA_SCENARIO: "running" }),
        QA_NOW: "2026-10-08T09:00:00Z",
      },
      "site-sample",
    );
    const context = await browser.newContext({
      viewport: size,
      recordVideo: { dir: temp, size },
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
      colorScheme: "dark",
      locale: "en-GB",
    });
    try {
      const page = await context.newPage();
      if (name !== "work") {
        const frame = await sharp(Buffer.from(demoScreen(name)))
          .webp({ quality: 90 })
          .toBuffer();
        await page.route("**/owned-desktop.webp", (route) =>
          route.fulfill({ contentType: "image/webp", body: frame }),
        );
      }
      await skipSetup(page);
      await page.addInitScript("globalThis.__name = (fn) => fn;");
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      await expect(page.locator(".stage").first()).toBeVisible();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${temp}/${name}.png` });
      await showActivity(page);
      await page.waitForTimeout(2500);
      if (name === "research") {
        await page.getByRole("tab", { name: /Sources/ }).click();
        await page.waitForTimeout(4000);
        await page.getByRole("tab", { name: /Steps/ }).click();
        await page.waitForTimeout(2000);
      } else if (name === "play") {
        const row = page.locator(".activity-row[data-current] .activity-row-head");
        await row.click();
        await page.waitForTimeout(2500);
        await page
          .locator(mobile ? ".ui-sheet-body" : ".activity-scroll")
          .evaluate((el) => el.scrollTo({ top: 0, behavior: "smooth" }));
        await page.waitForTimeout(3000);
      }
      await showChat(page);
      await page.waitForTimeout(3000);
      const video = page.video();
      await context.close();
      const path = await video.path();
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-i",
          path,
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "slow",
          "-crf",
          "22",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          `${out}/${outputName}.mp4`,
        ],
        { stdio: "ignore" },
      );
      await sharp(`${temp}/${name}.png`)
        .webp({ quality: 88 })
        .toFile(`${out}/${outputName}-poster.webp`);
      console.log(name + " captured using only synthetic app fixtures");
    } finally {
      await context.close();
      await fixture.close();
    }
  }
} finally {
  await browser.close();
}
