import { expect, runAt, test } from "./harness.ts";

runAt("c14", "w14");
test("fullscreen manual controls and settings stay below the computer picture", async ({
  page,
  ui,
}) => {
  await ui.open("ready");
  await ui.picture();
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page
    .locator(".control-strip")
    .getByRole("button", { name: "Full screen", exact: true })
    .click();
  await expect(page.locator(".app")).toHaveAttribute("data-full", "");
  await ui.settle();
  const picture = await page.locator(".watch .stage-box").boundingBox();
  const toolbar = await page.locator(".fullscreen-stream-controls").boundingBox();
  const manual = await page.locator(".control-strip").boundingBox();
  expect(picture).not.toBeNull();
  expect(toolbar).not.toBeNull();
  expect(manual).not.toBeNull();
  if (!picture || !toolbar || !manual) throw new Error("Missing screen controls");
  expect(toolbar.y).toBeGreaterThanOrEqual(picture.y + picture.height + 8);
  expect(manual.y).toBeGreaterThanOrEqual(toolbar.y);
  expect(manual.y + manual.height).toBeLessThanOrEqual(toolbar.y + toolbar.height + 1);
  expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
  await page.screenshot({ path: test.info().outputPath("fullscreen-toolbar.png") });
});
