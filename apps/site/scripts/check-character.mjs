import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";

const url = process.env.SITE_URL ?? "http://127.0.0.1:8788/";
const browser = await chromium.launch({ channel: "chrome" });
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await expect(page.locator("#orb-mount")).toHaveClass(/ready/, { timeout: 30000 });
  await page.getByRole("button", { name: "Pause motion", exact: true }).click();
  // Wait for the worker to stop and the compositor to present its final frame.
  await page.waitForTimeout(150);
  const mount = page.locator("#orb-mount");
  // The canvas overlaps the controls; exclude their hover/focus paint from the image check.
  const snapshot = async () =>
    digest(
      await mount.screenshot({
        style:
          ".scene-controls,.orb-touch,.scene-caption,.greeting-note,.drag-hint{visibility:hidden!important}",
      }),
    );
  const closed = await snapshot();
  await page.getByRole("button", { name: "Look inside", exact: true }).click();
  await expect(page.locator("#open-dot")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(snapshot).not.toBe(closed);
  await page.getByRole("button", { name: "Close dot", exact: true }).click();
  await expect.poll(snapshot).toBe(closed);
  await page.getByRole("button", { name: "Turn dot right" }).click();
  await expect.poll(snapshot).not.toBe(closed);
  await page.getByRole("button", { name: "Turn dot left" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(snapshot).toBe(closed);
  const bounds = await mount.boundingBox();
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 220, center.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(snapshot).not.toBe(closed);
  await expect(mount).not.toHaveClass(/dragging/);
  assert.deepEqual(errors, []);
  await context.close();

  const reduced = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 390, height: 844 },
  });
  const still = await reduced.newPage();
  await still.goto(url, { waitUntil: "networkidle" });
  assert.equal(still.workers().length, 0);
  await expect(still.getByRole("button", { name: "Turn dot left" })).toBeDisabled();
  await still.getByRole("button", { name: "Look inside", exact: true }).click();
  await expect(still.locator(".orb-poster")).toHaveAttribute("src", "/dot-open.webp");
  await expect
    .poll(() => still.locator(".orb-poster").evaluate((el) => el.complete && el.naturalWidth > 0))
    .toBe(true);
  assert.equal(still.workers().length, 0, "Opening the still view must respect reduced motion");
  await reduced.close();

  const touch = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await touch.newPage();
  await mobile.goto(url, { waitUntil: "networkidle" });
  await expect(mobile.locator("#orb-mount")).toHaveClass(/ready/, { timeout: 30000 });
  await mobile.getByRole("button", { name: "Pause motion", exact: true }).tap();
  await mobile.evaluate(() => scrollTo(0, 0));
  const before = digest(await mobile.locator("#orb-mount").screenshot());
  const cdp = await touch.newCDPSession(mobile);
  async function gesture(start, end) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: start.x + ((end.x - start.x) * i) / 8, y: start.y + ((end.y - start.y) * i) / 8 },
        ],
      });
      await mobile.waitForTimeout(20);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  await gesture({ x: 110, y: 280 }, { x: 290, y: 280 });
  await expect
    .poll(async () => digest(await mobile.locator("#orb-mount").screenshot()))
    .not.toBe(before);
  assert.equal(await mobile.evaluate(() => scrollY), 0, "Horizontal turning should not scroll");
  await gesture({ x: 195, y: 360 }, { x: 195, y: 130 });
  await expect.poll(() => mobile.evaluate(() => scrollY)).toBeGreaterThan(20);
  await expect(mobile.locator("#orb-mount")).not.toHaveClass(/dragging/);
  await touch.close();
  console.log(
    "Character passed: rendered open/close, button and keyboard rotation, mouse drag, static open view, touch drag, vertical page scrolling.",
  );
} finally {
  await browser.close();
}
