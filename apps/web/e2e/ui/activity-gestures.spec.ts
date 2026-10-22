import type { Locator } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");
async function bounds(node: Locator) {
  const box = await node.boundingBox();
  if (!box) throw new Error("Missing visible geometry");
  return box;
}

test("a mouse on Activity content never drags the sheet; its handle dismisses it", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 390, height: 680 });
  await ui.open("done");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  const pane = sheet.locator('[role="tabpanel"]:not([aria-hidden]) .activity-scroll');
  await pane.evaluate((node) => {
    node.scrollTop = 0;
  });
  await ui.settle();
  const top = (await bounds(sheet)).y;
  const box = await bounds(pane);
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(140, box.height - 12), {
    steps: 12,
  });
  await expect.poll(async () => Math.abs((await bounds(sheet)).y - top)).toBeLessThan(1);
  await page.mouse.up();
  await pane.evaluate((node) => {
    node.scrollTop = 80;
  });
  await expect.poll(() => pane.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(sheet).toBeVisible();
  const handle = sheet.locator(".ui-sheet-handle");
  const grip = await bounds(handle);
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 350, { steps: 12 });
  await page.mouse.up();
  await expect(sheet).toBeHidden();
});

test("Activity pages follow horizontal scroll and keep each tab's vertical position", async ({
  page,
  ui,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await ui.open("done");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  const pager = sheet.locator(".ui-swipe-panels");
  const steps = sheet.locator('[role="tabpanel"]').first().locator(".activity-scroll");
  await ui.settle();
  await steps.dispatchEvent("touchstart");
  await steps.evaluate((node) => {
    node.scrollTop = 60;
  });
  const position = await steps.evaluate((node) => node.scrollTop);
  await pager.evaluate((node) => node.scrollTo({ left: node.clientWidth, behavior: "smooth" }));
  await expect(sheet.getByRole("tab", { name: /^Files/ })).toHaveAttribute("aria-selected", "true");
  await sheet.getByRole("tab", { name: /^Steps/ }).click();
  await expect.poll(() => pager.evaluate((node) => node.scrollLeft)).toBeLessThan(1);
  await expect.poll(() => steps.evaluate((node) => node.scrollTop)).toBe(position);
  await expect(sheet).toBeVisible();
});

test("the plan stays visible below tabs while steps scroll", async ({ page, ui }) => {
  await ui.open("done");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  const plan = sheet.locator(".activity-plan");
  await expect(plan).toBeVisible();
  const before = await bounds(plan);
  const pane = sheet.locator('[role="tabpanel"]:not([aria-hidden]) .activity-scroll');
  await pane.evaluate((n) => {
    n.scrollTop = n.scrollHeight;
  });
  await ui.settle();
  expect(Math.abs((await bounds(plan)).y - before.y)).toBeLessThan(1);
  expect((await bounds(pane)).y).toBeGreaterThanOrEqual(before.y + before.height - 1);
});

test("a finger swipe switches Activity tabs without moving the sheet", async ({
  page,
  ui,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "CDP touch injection needs Chromium");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await ui.open("done");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  await ui.settle();
  const pane = sheet.locator('[role="tabpanel"]').first().locator(".activity-scroll");
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => null)),
    ),
  );
  const box = await bounds(pane),
    before = await bounds(sheet);
  const cdp = await page.context().newCDPSession(page);
  const y = box.y + Math.min(90, box.height / 2),
    x = box.x + box.width - 35;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 12; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x - ((box.width - 70) * step) / 12, y }],
    });
    await page.waitForTimeout(16);
  }
  // Selection changes while the finger is still down, not after the snap finishes.
  await expect(sheet.getByRole("tab", { name: /^Files/ })).toHaveAttribute("aria-selected", "true");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect(Math.abs((await bounds(sheet)).y - before.y)).toBeLessThan(1);
  await cdp.detach();
});

test("opening the pinned plan preserves the steps viewport and scroll position", async ({
  page,
  ui,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await ui.open("done");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  await expect(sheet).toBeVisible();
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => null)),
    ),
  );
  const pane = sheet.locator('[role="tabpanel"]:not([aria-hidden]) .activity-scroll');
  await pane.dispatchEvent("touchstart");
  await pane.evaluate((n) => {
    n.scrollTop = 60;
  });
  const before = await pane.evaluate((n) => ({
    y: n.getBoundingClientRect().y,
    height: n.clientHeight,
    scroll: n.scrollTop,
  }));
  const toggle = sheet.locator(".activity-plan .ui-disclosure-trigger");
  for (const expanded of [true, false]) {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
    const samples = await pane.evaluate(async (n) => {
      const frames = [];
      for (let i = 0; i < 35; i++) {
        await new Promise(requestAnimationFrame);
        frames.push({
          y: n.getBoundingClientRect().y,
          height: n.clientHeight,
          scroll: n.scrollTop,
        });
      }
      return frames;
    });
    for (const sample of samples) expect(sample).toEqual(before);
  }
});

test("the filter travels with Steps and selection updates at the halfway threshold", async ({
  page,
  ui,
}) => {
  await ui.open("done");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  const pager = sheet.locator(".ui-swipe-panels");
  const filter = sheet.locator(".activity-filter");
  await expect(filter).toBeVisible();
  const initial = await bounds(filter);
  await pager.dispatchEvent("touchstart");
  await pager.evaluate((n) => {
    n.style.scrollSnapType = "none";
    n.scrollLeft = n.clientWidth * 0.4;
  });
  await expect(sheet.getByRole("tab", { name: /^Steps/ })).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await bounds(filter)).x).toBeLessThan(initial.x - 100);
  await pager.evaluate((n) => {
    n.scrollLeft = n.clientWidth * 0.6;
  });
  await expect(sheet.getByRole("tab", { name: /^Files/ })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => pager.evaluate((n) => n.scrollLeft / n.clientWidth)).toBeCloseTo(0.6, 1);
  await pager.evaluate((n) => {
    n.scrollLeft = n.clientWidth * 0.4;
  });
  await expect(sheet.getByRole("tab", { name: /^Steps/ })).toHaveAttribute("aria-selected", "true");
});
