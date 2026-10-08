import { expect, keepBaselinesAt, test } from "./harness.ts";

// T09's feedback over the kit's gallery page: three toasts stacked under the HUD and laid out in a
// column, and the page's banners, progress, meters, skeletons and empty states at rest.
keepBaselinesAt("c14", "w39");

test("feedback, toast stack", async ({ page, ui }) => {
  await ui.gallery("feedback");
  await expect(page.locator('canvas[data-still="drawn"]')).toHaveCount(1);
  const stage = page.locator(".feedback-stage");
  await stage.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Show three" }).click();
  await expect(page.locator(".ui-toast")).toHaveCount(3);
  await page.clock.runFor(500);
  // The stage and the room under it, which a laid-out stack can hang into.
  const area = await stage.boundingBox();
  if (!area) throw new Error("no stage");
  const clip = { ...area, height: area.height + 120 };
  await expect(page).toHaveScreenshot("ui-toast.png", { clip });

  // Focus in the stack lays it out, as hovering does.
  await page.getByRole("button", { name: "Dismiss" }).first().focus();
  await expect(page.getByRole("region", { name: "Notifications" })).toHaveAttribute(
    "data-expanded",
    "",
  );
  await page.clock.runFor(500);
  await expect(page).toHaveScreenshot("ui-toast-expanded.png", { clip });
});

test("feedback, at rest", async ({ page, ui }) => {
  await ui.gallery("feedback");
  await expect(page.locator('canvas[data-still="drawn"]')).toHaveCount(1);
  await page.clock.runFor(500);
  await expect(page).toHaveScreenshot("ui-feedback.png", { fullPage: true });
});
