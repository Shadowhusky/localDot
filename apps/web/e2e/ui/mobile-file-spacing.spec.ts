import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");

test("file actions clear dividers and Activity remains comfortable on narrow phones", async ({
  page,
  ui,
}) => {
  await ui.open("done");
  await ui.picture();
  await ui.settle();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 740 });
    const file = page.locator(".deliverable").first();
    await file.scrollIntoViewIfNeeded();
    const action = file.getByRole("button", { name: /^Open / }).first();
    await expect(action).toBeVisible();
    const clearance = await action.evaluate((button) => {
      const parent = button.closest(".ui-file-row");
      if (!parent) throw new Error("Missing file row");
      const row = parent.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return { top: box.top - row.top, bottom: row.bottom - box.bottom, height: box.height };
    });
    expect(clearance.top).toBeGreaterThanOrEqual(8);
    expect(clearance.bottom).toBeGreaterThanOrEqual(8);
    expect(clearance.height).toBeLessThanOrEqual(32);
    await page.screenshot({ path: test.info().outputPath(`files-${width}.png`) });
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    const filter = page.getByRole("radiogroup", { name: "Activity filter" });
    await expect(filter).toBeVisible();
    for (const radio of await filter.getByRole("radio").all()) {
      const box = await radio.boundingBox();
      if (!box) throw new Error("Missing filter bounds");
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(70);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await page.getByRole("dialog", { name: "Activity" }).evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath(`activity-${width}.png`) });
    await page
      .getByRole("dialog", { name: "Activity" })
      .getByRole("button", { name: "Done", exact: true })
      .click();
  }
});

test("portrait full screen keeps short narration close to the picture", async ({ page, ui }) => {
  await page.setViewportSize({ width: 390, height: 680 });
  await ui.open("done");
  await ui.picture();
  await ui.settle();
  await page.locator(".stage-expand").getByRole("button", { name: "Full screen" }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-focus", "");
  await ui.settle();
  const mascot = await page.locator(".narrator-dock").boundingBox();
  const narration = await page.locator(".narration").boundingBox();
  if (!mascot || !narration) throw new Error("Missing narrator bounds");
  expect(mascot.y).toBeGreaterThanOrEqual(16);
  expect(narration.y).toBeGreaterThanOrEqual(mascot.y + mascot.height);
  await expect(page.locator(".focus-hint")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("portrait-done.png") });
});
