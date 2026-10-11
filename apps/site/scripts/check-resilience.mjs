import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const url = process.env.SITE_URL ?? "http://127.0.0.1:8788/";
const browser = await chromium.launch({ channel: "chrome" });
const results = [];
try {
  for (const kind of ["main-thread-fallback", "no-webgl", "no-storage"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (kind === "main-thread-fallback") {
      await context.addInitScript(() => {
        Object.defineProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen", {
          value: undefined,
        });
      });
    }
    if (kind === "no-webgl") {
      await page.route("**/orb.worker-*.js", async (route) => {
        const response = await route.fetch();
        const patch = `const originalContext=OffscreenCanvas.prototype.getContext;
          OffscreenCanvas.prototype.getContext=function(type,...args){
            if(type.startsWith('webgl'))return null;
            return originalContext.call(this,type,...args);
          };\n`;
        await route.fulfill({ response, body: patch + (await response.text()) });
      });
    }
    if (kind === "no-storage") {
      await context.addInitScript(() => {
        Storage.prototype.getItem = () => {
          throw new DOMException("Storage disabled", "SecurityError");
        };
        Storage.prototype.setItem = () => {
          throw new DOMException("Storage disabled", "SecurityError");
        };
      });
    }
    await page.goto(url, { waitUntil: "networkidle" });
    if (kind === "no-webgl") {
      await expect(page.locator("#orb-mount")).toHaveAttribute("data-renderer", "poster");
      await expect(page.locator(".orb-poster")).toHaveCSS("opacity", "1");
      assert.equal(await page.locator("canvas").count(), 0);
    } else {
      await expect(page.locator("#orb-mount")).toHaveClass(/ready/, { timeout: 25000 });
      if (kind === "main-thread-fallback") {
        await expect(page.locator("#orb-mount")).toHaveAttribute("data-renderer", "main");
      }
    }
    await page.getByRole("button", { name: "Say hello to dot" }).click();
    await expect(page.getByRole("status")).toHaveText("Hello, you.");
    await page.getByRole("button", { name: "Pause motion", exact: true }).click();
    await expect(page.getByRole("button", { name: "Play motion", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "03 Close to home" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("cloud provider");
    assert.deepEqual(errors, []);
    await context.close();
    results.push(kind);
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await expect(page.locator("#orb-mount")).toHaveClass(/ready/, { timeout: 25000 });
  await page.evaluate(() => {
    window.auditNavigationToken = "original";
  });
  await page.goto(new URL("/missing-page", url).href, { waitUntil: "networkidle" });
  assert.equal(page.workers().length, 0, "Navigation must release the old renderer");
  await page.goBack({ waitUntil: "networkidle" });
  await expect(page.locator("#orb-mount")).toHaveClass(/ready/, { timeout: 25000 });
  await expect(page.getByRole("button", { name: "Say hello to dot" })).toBeVisible();
  assert.deepEqual(errors, []);
  results.push("back-navigation-recovery");
  await context.close();
} finally {
  await browser.close();
}
console.log(`Resilience passed: ${results.join(", ")}`);
