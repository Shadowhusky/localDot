import { chromium, webkit } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const origin = process.env.SITE_URL || "http://127.0.0.1:4321";
const out = new URL("../qa/", import.meta.url);
await mkdir(out, { recursive: true });
const results = [];
const browser = await chromium.launch();
try {
  for (const [width, height] of [
    [1440, 900],
    [768, 1024],
    [390, 844],
    [320, 640],
    [844, 390],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page.locator("#loader").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("#demo-video").readyState >= 2);
    for (const [i, id] of ["watch", "hello", "possibilities", "yours", "get-dot"].entries()) {
      await page.locator(`.journey-footer a[href="#${id}"]`).click();
      await page.waitForTimeout(1000);
      const bounds = await page.evaluate((id) => {
        const panel = document.querySelector("#" + id + " .scene-panel");
        const controls = [...panel.querySelectorAll("button,a")].filter(
          (e) => e.getBoundingClientRect().width,
        );
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          controls: controls.map((e) => {
            const b = e.getBoundingClientRect();
            return {
              text: e.textContent?.trim(),
              left: b.left,
              top: b.top,
              right: b.right,
              bottom: b.bottom,
              width: b.width,
              height: b.height,
            };
          }),
        };
      }, id);
      assert.equal(bounds.overflow, false, `${width}/${id} horizontal overflow`);
      if (height > 510)
        for (const b of bounds.controls)
          assert.ok(
            b.left >= -1 && b.right <= width + 1 && b.top >= 0 && b.bottom <= height + 1,
            `${width}/${id} clipped control ${JSON.stringify(b)}`,
          );
      await page.screenshot({ path: new URL(`${width}-${id}.png`, out).pathname });
      if (id === "possibilities")
        results.push({
          width,
          height,
          scene: id,
          metrics: await page.evaluate(() => window.siteMetrics?.()),
        });
    }
    await page.locator('.journey-footer a[href="#hello"]').click();
    await page.waitForTimeout(900);
    await page.locator("#greet").click();
    assert.match(await page.locator("#greeting").innerText(), /Hello/);
    await page.locator('.journey-footer a[href="#watch"]').click();
    await page.waitForTimeout(900);
    for (const demo of ["research", "play", "work"]) {
      await page.locator(`[data-demo="${demo}"]`).click();
      await page.waitForFunction(() => document.querySelector("#demo-video").readyState >= 2);
      assert.ok((await page.locator("#demo-video").getAttribute("src")).includes(demo));
    }
    await page.locator("#play-toggle").click();
    await page.locator("#fullscreen").click();
    await page.keyboard.press("Escape");
    const metrics = await page.evaluate(() => window.siteMetrics?.());
    results.push({ width, height, errors, metrics });
    assert.deepEqual(errors, []);
    await page.close();
  }
  for (const mode of ["reduced", "webgl-failed", "no-js"]) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion: mode === "reduced" ? "reduce" : "no-preference",
      javaScriptEnabled: mode !== "no-js",
    });
    if (mode === "webgl-failed")
      await page.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return type.includes("webgl") ? null : get.call(this, type, ...args);
        };
      });
    await page.goto(origin + "/#hello");
    await page.waitForTimeout(500);
    assert.ok(await page.locator("#hello-title").isVisible());
    await page.screenshot({ path: new URL(`${mode}.png`, out).pathname });
    if (mode === "reduced") {
      assert.equal(await page.locator("#demo-video").evaluate((v) => v.paused), true);
      assert.equal(
        await page.locator("html").evaluate((e) => e.classList.contains("has-world")),
        false,
      );
    }
    results.push({ mode, passed: true });
    await page.close();
  }
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await page.goto(origin);
  await page.addScriptTag({
    path: new URL("../node_modules/axe-core/axe.min.js", import.meta.url).pathname,
  });
  const a11y = await page.evaluate(() =>
    axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } }),
  );
  results.push({
    a11y: a11y.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target),
    })),
  });
  await page.close();
} finally {
  await browser.close();
  await writeFile(new URL("checks.json", out), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
const safari = await webkit.launch();
try {
  const p = await safari.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await p.goto(origin);
  await p.locator("#loader").waitFor({ state: "hidden" });
  await p.locator('.journey-footer a[href="#hello"]').click();
  await p.waitForTimeout(1000);
  await p.screenshot({ path: new URL("webkit-mobile.png", out).pathname });
  await p.locator("#greet").click();
  assert.match(await p.locator("#greeting").innerText(), /Hello/);
  console.log("WebKit mobile greeting passed");
} finally {
  await safari.close();
}
