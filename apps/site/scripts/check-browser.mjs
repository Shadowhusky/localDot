import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect, firefox, webkit } from "@playwright/test";
import axe from "axe-core";

const url = process.env.SITE_URL ?? "http://127.0.0.1:8788/";
const destination = new URL(url);
const requested = (process.env.SITE_BROWSERS ?? "chromium,firefox,webkit").split(",");
const engines = { chromium, firefox, webkit };
const reports = [];
await mkdir(new URL("../qa/", import.meta.url), { recursive: true });

async function noOverflow(page, name) {
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert.ok(dimensions.content <= dimensions.viewport, `${name}: ${JSON.stringify(dimensions)}`);
  const clipped = await page
    .locator(
      "h1, h2, h3, .hero-description, .principle p, .feature-description p, .development-bottom p",
    )
    .evaluateAll((elements) =>
      elements
        .filter(
          (element) =>
            element.getClientRects().length && element.scrollWidth > element.clientWidth + 1,
        )
        .map((element) => element.textContent.trim()),
    );
  assert.deepEqual(clipped, [], `${name}: readable text must not be clipped`);
}

for (const name of requested) {
  const browser = await engines[name].launch(name === "chromium" ? { channel: "chrome" } : {});
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const errors = [];
    const failed = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400) failed.push(response.url());
    });
    const response = await page.goto(url, { waitUntil: "networkidle" });
    assert.equal(response.status(), 200);
    await expect(page.locator("#orb-mount")).toHaveClass(/ready/, { timeout: 25000 });
    assert.equal(await page.locator("#orb-mount").getAttribute("data-renderer"), "worker");
    const worker = page.workers()[0];
    const frameTiming = await worker.evaluate(async () => {
      const original = self.requestAnimationFrame;
      self.auditFrames = 0;
      const times = [];
      self.requestAnimationFrame = (callback) =>
        original((time) => {
          self.auditFrames++;
          times.push(time);
          callback(time);
        });
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const gaps = times
        .slice(1)
        .map((time, index) => time - times[index])
        .sort((a, b) => a - b);
      return {
        frames: times.length,
        medianMs: gaps[Math.floor(gaps.length / 2)],
        p95Ms: gaps[Math.floor(gaps.length * 0.95)],
      };
    });
    assert.ok(frameTiming.frames > 20, `${name}: animation must advance`);
    assert.ok(
      frameTiming.p95Ms < 50,
      `${name}: excessive dropped frames ${JSON.stringify(frameTiming)}`,
    );

    await page.getByRole("button", { name: "Pause motion", exact: true }).click();
    await page.waitForTimeout(120);
    const pausedAt = await worker.evaluate(() => self.auditFrames);
    await page.waitForTimeout(250);
    assert.equal(
      await worker.evaluate(() => self.auditFrames),
      pausedAt,
      `${name}: paused renderer must sleep`,
    );

    for (const [width, height] of [
      [320, 780],
      [390, 844],
      [768, 1024],
      [1440, 1000],
      [1920, 1080],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => scrollTo(0, 0));
      await noOverflow(page, `${name} ${width}px`);
      if (width === 390 || width === 1440) {
        // Let the compositor present the resized viewport before capturing its layers.
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await page.screenshot({
          path: fileURLToPath(new URL(`../qa/${name}-${width}.png`, import.meta.url)),
        });
      }
    }
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
      await noOverflow(page, `${name} ${width}px / 200% text`);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "";
      });
    }

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("tab", { name: "02 Every move, in view" }).click();
    await expect(page.locator("#app-preview")).toHaveAttribute("data-view", "visible");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#app-preview")).toHaveAttribute("data-view", "local");
    await expect(page.getByRole("tabpanel")).toContainText("cloud provider");
    assert.equal(
      await page
        .locator(".demo-pointer")
        .evaluate((element) => getComputedStyle(element).transitionDuration),
      "0s",
    );
    await page.keyboard.press("Home");
    await expect(page.locator("#tab-space")).toBeFocused();
    assert.equal(
      await page.locator("html").evaluate((element) => getComputedStyle(element).scrollBehavior),
      "auto",
      `${name}: keyboard links must not animate scrolling`,
    );
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tabpanel")).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#tab-space").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#tab-visible")).toBeFocused();
    await expect(page.getByRole("tablist")).toHaveAttribute("aria-orientation", "vertical");
    await page.keyboard.press("End");
    await expect(page.locator("#tab-local")).toBeFocused();

    await page.getByRole("button", { name: "Say hello to dot" }).click();
    await expect(page.getByRole("status")).toHaveText("Hello, you.");
    await page.getByRole("button", { name: "Play motion", exact: true }).click();
    await expect.poll(() => worker.evaluate(() => self.auditFrames)).toBeGreaterThan(pausedAt);
    await page.locator("#development").scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const offscreenAt = await worker.evaluate(() => self.auditFrames);
    await page.waitForTimeout(250);
    assert.equal(
      await worker.evaluate(() => self.auditFrames),
      offscreenAt,
      `${name}: offscreen renderer must sleep`,
    );
    await page.locator("footer .brand").click();
    await expect(page).toHaveURL(/#top$/);
    await expect.poll(() => worker.evaluate(() => self.auditFrames)).toBeGreaterThan(offscreenAt);

    await page.getByRole("button", { name: "Pause motion", exact: true }).click();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Play motion", exact: true })).toBeVisible();
    assert.equal(page.workers().length, 0, `${name}: saved pause should not start a renderer`);
    await page.evaluate(axe.source);
    const accessibility = await page.evaluate(async () =>
      axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
        },
      }),
    );
    assert.deepEqual(
      accessibility.violations.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => node.target),
      })),
      [],
    );

    await expect(page).toHaveTitle("localDot — A local AI assistant with its own computer");
    assert.equal(await page.locator("h1").count(), 1);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://localdot.dev/",
    );
    const schema = JSON.parse(
      await page.locator('script[type="application/ld+json"]').textContent(),
    );
    assert.equal(schema["@type"], "WebSite");
    assert.equal(schema.url, "https://localdot.dev/");
    assert.equal(schema.name, "localDot");
    const robots = await page.request.get(new URL("/robots.txt", destination).href);
    assert.match(await robots.text(), /Sitemap: https:\/\/localdot.dev\/sitemap.xml/);
    const sitemap = await page.request.get(new URL("/sitemap.xml", destination).href);
    assert.match(await sitemap.text(), /<loc>https:\/\/localdot.dev\/<\/loc>/);
    const missing = await page.request.get(new URL("/missing-page", destination).href);
    assert.equal(missing.status(), 404);
    assert.match(await missing.text(), /name="robots" content="noindex"/);
    assert.match(response.headers()["content-security-policy"], /script-src 'self' 'sha256-/);
    assert.equal(response.headers()["x-content-type-options"], "nosniff");
    assert.deepEqual(errors, []);
    assert.deepEqual(failed, []);

    const reduced = await browser.newContext({
      reducedMotion: "reduce",
      viewport: { width: 390, height: 844 },
    });
    const reducedPage = await reduced.newPage();
    await reducedPage.goto(url, { waitUntil: "networkidle" });
    assert.equal(reducedPage.workers().length, 0);
    assert.equal(await reducedPage.locator("canvas").count(), 0);
    await expect(
      reducedPage.getByRole("button", { name: "Play motion", exact: true }),
    ).toBeVisible();
    const loaded = await reducedPage.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => entry.name),
    );
    assert.ok(!loaded.some((resource) => /orb\.worker|orb-scene/.test(resource)));
    await reducedPage.emulateMedia({ reducedMotion: "no-preference" });
    await expect(reducedPage.locator("#orb-mount")).toHaveClass(/ready/, { timeout: 25000 });
    await reduced.close();

    const staticContext = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    const staticPage = await staticContext.newPage();
    await staticPage.goto(url, { waitUntil: "networkidle" });
    await expect(staticPage.locator("h1")).toBeVisible();
    await expect(staticPage.locator(".orb-poster")).toBeVisible();
    await expect(staticPage.locator("#motion-toggle")).toBeHidden();
    assert.ok(
      await staticPage.locator("#motion-toggle").evaluate((element) => element.offsetWidth > 0),
      `${name}: reserve the motion control's space before JavaScript enables it`,
    );
    await expect(staticPage.locator("#greet-dot")).toBeHidden();
    await noOverflow(staticPage, `${name} no JavaScript`);
    await staticContext.close();
    await context.close();
    reports.push({
      browser: name,
      version: browser.version(),
      frameTiming,
      viewportWidths: [320, 390, 768, 1440, 1920],
      textZoom: "200%",
      axeViolations: 0,
      motion: "pause, resume, offscreen suspension, saved preference, system preference",
      keyboard: "horizontal and vertical tabs, panel focus",
      SEO: "metadata, structured data, canonical, robots, sitemap, 404",
      errors,
      failed,
    });
    console.log(`${name}: passed`);
  } finally {
    await browser.close();
  }
}
await writeFile(
  new URL("../qa/quality-report.json", import.meta.url),
  JSON.stringify({ url, testedAt: new Date().toISOString(), reports }, null, 2),
);
console.log(JSON.stringify(reports, null, 2));
