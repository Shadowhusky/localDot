import { demoScreen } from "./demo-screen.mjs";
import sharp from "../../web/node_modules/sharp/dist/index.mjs";
import { chromium, expect } from "../../web/node_modules/@playwright/test/index.mjs";
import { startUiFixture, TOKEN } from "../../web/e2e/fixtures/start-ui-fixture.ts";
import { skipSetup } from "../../web/e2e/skip-setup.ts";
import { showActivity, showChat } from "../../web/e2e/layout.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const out = fileURLToPath(new URL("../public/demos/", import.meta.url));
const temp = fileURLToPath(new URL("../qa/capture/", import.meta.url));
await mkdir(temp, { recursive: true });
const mobile = process.argv.includes("--mobile");
const size = mobile ? { width: 390, height: 500 } : { width: 1440, height: 900 };
const browser = await chromium.launch();
try {
  for (const [name, activity] of [
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
      const recordingStarted = Date.now();
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
      await page.addInitScript(() => {
        globalThis.__name = (fn) => fn;
        // A real persisted app preference: keep idle commands out of these screen demos.
        localStorage.setItem(
          "localdot.work-overlay.v1",
          JSON.stringify({ x: 0.02, y: 0.9, minimized: true, hidden: true }),
        );
      });
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      await expect(page.locator(".stage").first()).toBeVisible();
      const stream = page.frameLocator("iframe.desktop-frame").locator("#videoStream");
      await expect
        .poll(() => stream.evaluate((v: HTMLVideoElement) => v.readyState))
        .toBeGreaterThanOrEqual(2);
      // Validate the pixels produced by the stream, not merely its container's size.
      const streamProof = await stream.evaluate((v: HTMLVideoElement) => {
        const c = document.createElement("canvas");
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(v, 0, 0);
        return {
          width: c.width,
          height: c.height,
          corners: [
            [0.02, 0.02],
            [0.98, 0.02],
            [0.02, 0.98],
            [0.98, 0.98],
          ].map(([x, y]) => [
            ...ctx.getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data,
          ]),
        };
      });
      expect(streamProof.width).toBe(2560);
      expect(streamProof.height).toBe(1600);
      for (const pixel of streamProof.corners)
        expect(Math.max(...pixel.slice(0, 3))).toBeGreaterThan(5);
      await expect(page.getByRole("region", { name: "Background work" })).toBeHidden();
      await page.waitForTimeout(600);
      await page.mouse.move(size.width - 4, size.height - 4);
      const trimStart = (Date.now() - recordingStarted) / 1000;
      await page.screenshot({ path: `${temp}/${outputName}.png` });
      await writeFile(`${temp}/${outputName}-framing.json`, JSON.stringify(streamProof, null, 2));
      await page.waitForTimeout(3000);
      await showActivity(page);
      await page.waitForTimeout(2200);
      if (name === "research") {
        await page.getByRole("tab", { name: /Sources/ }).click();
        await page.waitForTimeout(4000);
        await page.getByRole("tab", { name: /Steps/ }).click();
        await page.waitForTimeout(2000);
      }
      await showChat(page);
      await page.waitForTimeout(3000);
      const trimDuration = (Date.now() - recordingStarted) / 1000 - trimStart;
      const video = page.video();
      await context.close();
      const path = await video.path();
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-i",
          path,
          "-ss",
          String(trimStart),
          "-t",
          String(trimDuration),
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
      await sharp(`${temp}/${outputName}.png`)
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
