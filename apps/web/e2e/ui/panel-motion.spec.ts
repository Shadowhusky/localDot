import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

test("Activity tabs and filters remain below the header while scrolling", async ({ page, ui }) => {
  const phone = (page.viewportSize()?.width ?? 0) < 700;
  if (!phone) await page.setViewportSize({ width: 2000, height: 650 });
  await ui.open("done");
  await ui.picture();
  if (phone) await page.getByRole("button", { name: "Activity", exact: true }).click();
  const rail = phone ? page.locator(".activity-sheet") : page.locator(".rail-activity");
  const controls = rail.locator(".activity-controls");
  await expect(controls).toBeVisible();
  const scroller = phone
    ? page.getByRole("dialog", { name: "Activity" }).locator(".ui-sheet-body")
    : rail.locator(".activity-scroll");
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await ui.settle();
  const bounds = await controls.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("Missing controls");
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  if (phone) {
    const header = await page
      .getByRole("dialog", { name: "Activity" })
      .locator(".ui-sheet-header")
      .boundingBox();
    if (!header) throw new Error("Missing header");
    expect(bounds.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  }
  // Both controls must remain hittable, not merely present behind the sheet header.
  await rail.getByRole("radio", { name: "Tools", exact: true }).click();
  await expect(rail.getByRole("radio", { name: "Tools", exact: true })).toBeChecked();
  await rail.getByRole("tab", { name: /^Files/ }).click();
  await expect(rail.getByRole("tab", { name: /^Files/ })).toHaveAttribute("aria-selected", "true");
});

test("work window animates without replacing its output", async ({ page, ui }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await ui.open("running");
  await ui.picture();
  const expand = page.getByRole("button", { name: "Expand command window" });
  if (await expand.isVisible()) await expand.click();
  const panel = page.locator(".work-overlay");
  await panel.evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished));
  });
  const output = await page.locator(".work-overlay-output").elementHandle();
  const start = await panel.evaluate((node) => node.getBoundingClientRect().height);
  await page.getByRole("button", { name: "Minimize command window" }).click();
  expect(await panel.evaluate((node) => getComputedStyle(node).transitionDuration)).not.toBe("0s");
  await expect
    .poll(() => panel.evaluate((node) => node.getBoundingClientRect().height))
    .toBeLessThan(start);
  expect(await output?.evaluate((node) => node.isConnected)).toBe(true);
  await expand.click();
  await expect(page.getByRole("region", { name: "Recent command output" })).toBeVisible();
  expect(
    await output?.evaluate((node) => node === document.querySelector(".work-overlay-output")),
  ).toBe(true);
});
