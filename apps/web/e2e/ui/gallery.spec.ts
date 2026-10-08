import { expect, keepBaselinesAt, test } from "./harness.ts";

// Gallery pages render components from fixture props on a paused clock, so even the live dot
// lands on the same frame every run.
keepBaselinesAt("c14", "w39");

test("gallery, dot", async ({ page, ui }) => {
  await ui.gallery("dot");
  await expect(page.locator('.dot[data-skin="loading"]')).toHaveCount(0);
  await page.clock.runFor(1500);
  await expect(page).toHaveScreenshot("gallery-dot.png", { fullPage: true });
});

test("gallery, stage", async ({ page, ui }) => {
  await ui.gallery("stage");
  await expect(page.locator('canvas[data-still="drawn"]')).toHaveCount(3);
  await page.clock.runFor(500);
  await expect(page).toHaveScreenshot("gallery-stage.png", { fullPage: true });
});
