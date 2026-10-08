import { expect, keepBaselinesAt, test } from "./harness.ts";

// T08's overlays open over the kit's gallery page: an inspector sheet on a desktop and a bottom
// sheet on a phone, and the destructive dialog beside (or, on a phone, over) what asked for it.
keepBaselinesAt("c14", "w39");

test("overlays, sheet", async ({ page, ui }) => {
  await ui.gallery("overlays");
  await page.getByRole("button", { name: "Open settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Models and settings" });
  await expect(sheet).toBeVisible();
  await page.clock.runFor(1000);
  const side = await sheet.getAttribute("data-side");
  expect(side).toBe((page.viewportSize()?.width ?? 0) < 760 ? "bottom" : "inspector");
  await expect(page).toHaveScreenshot(`ui-sheet-${side}.png`);
});

test("overlays, destructive dialog", async ({ page, ui }) => {
  await ui.gallery("overlays");
  const trigger = page.getByRole("button", { name: "Delete recording" });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const dialog = page.getByRole("alertdialog", { name: "Delete this recording?" });
  await expect(dialog).toBeVisible();
  await page.clock.runFor(1000);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(page).toHaveScreenshot("ui-dialog-destructive.png");
});
