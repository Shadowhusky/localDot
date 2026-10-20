import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
for (const surface of ["activity", "chat"] as const) {
  test(`${surface} step images open in the existing viewer without covering desktop steps`, async ({
    page,
    ui,
  }) => {
    await ui.open("image-output");
    if (surface === "activity") {
      if (isPhone(page)) await page.getByRole("button", { name: "Activity", exact: true }).click();
      else await page.getByRole("radio", { name: "Activity", exact: true }).click();
    } else {
      await page.locator(".thread-work-steps > .ui-disclosure-trigger:visible").last().click();
    }
    const row = page
      .locator(surface === "chat" ? ".thread-work-list" : ".activity-rail")
      .getByTestId("tool-row")
      .filter({ hasText: "read flower-poster/assets/hero1.jpg" });
    await row.getByRole("button", { name: /read flower-poster/ }).click();
    const image = row.getByRole("img", { name: "~/flower-poster/assets/hero1.jpg" });
    await expect(image).toBeVisible();
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBe(640);
    if (!isPhone(page)) await image.hover();
    const button = row.getByRole("button", { name: "Preview image" });
    await expect(button).toHaveCSS("opacity", "1");
    const control = await button.boundingBox();
    const resource = await image.locator("..").boundingBox();
    expect(
      control &&
        resource &&
        control.x >= resource.x &&
        control.y >= resource.y &&
        control.x + control.width <= resource.x + resource.width &&
        control.y + control.height <= resource.y + resource.height,
    ).toBe(true);
    await button.click();
    // The same zoomable viewer used by Files; inspect the loaded image, not just its shell.
    const picture = page.locator(".file-viewer img");
    await expect(picture).toBeVisible();
    await expect
      .poll(() => picture.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBe(640);
    const sheet = page.locator(".file-viewer");
    if (!isPhone(page)) {
      const panel = await row
        .locator("xpath=ancestor::*[contains(@class,'rail-chat')]")
        .boundingBox();
      const box = await sheet.boundingBox();
      expect(box && panel && box.x + box.width <= panel.x).toBe(true);
      await expect(sheet).toHaveAttribute("aria-modal", "false");
    } else {
      await expect(sheet).toHaveAttribute("data-detent", "large");
      await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
    }
    await ui.settle();
    await expect(sheet).toHaveCSS("opacity", "1");
    await page.screenshot({ path: test.info().outputPath(`${surface}-preview.png`) });
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).not.toBeVisible();
    await expect(row).toBeVisible();
    await expect(button).toBeFocused();
  });
}

test("recorded output opens as selectable text beside the steps", async ({ page, ui }) => {
  await ui.open("image-output");
  if (isPhone(page)) await page.getByRole("button", { name: "Activity", exact: true }).click();
  else await page.getByRole("radio", { name: "Activity", exact: true }).click();
  const row = page
    .locator(".activity-rail")
    .getByTestId("tool-row")
    .filter({ hasText: "read flower-poster/assets/hero1.jpg" });
  await row.getByRole("button", { name: /read flower-poster/ }).click();
  const stream = row.locator('.terminal-stream[data-stream="stdout"]');
  if (!isPhone(page)) await stream.hover();
  await stream.getByRole("button", { name: "Preview output" }).click();
  const dialog = page.getByRole("dialog", { name: "Output", exact: true });
  await expect(dialog.getByRole("region", { name: "Step output preview" })).toContainText(
    "hero1.jpg · 80427 bytes",
  );
  await expect(dialog.getByRole("button", { name: "Copy output" })).toBeVisible();
  await dialog.getByRole("radio", { name: "Rendered", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Rendered Output" })).toContainText(
    "80427 bytes",
  );
  await dialog.getByRole("radio", { name: "Source", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Step output preview" })).toContainText(
    "80427 bytes",
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test("Activity screen steps open an uncropped, zoomable screenshot", async ({ page, ui }) => {
  await ui.open("image-output");
  if (isPhone(page)) await page.getByRole("button", { name: "Activity", exact: true }).click();
  else await page.getByRole("radio", { name: "Activity", exact: true }).click();
  const row = page
    .locator(".activity-rail")
    .getByTestId("step-row")
    .filter({ hasText: "Opening the monthly report" });
  await row.locator(".activity-row-head").click();
  const frame = row.locator(".activity-frame");
  await frame.scrollIntoViewIfNeeded();
  if (!isPhone(page)) await frame.hover();
  await frame.getByRole("button", { name: "Preview screenshot" }).click();
  const dialog = page.getByRole("dialog", { name: "Step screenshot", exact: true });
  const image = dialog.getByRole("img", { name: "Step screenshot" });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(dialog.getByRole("radio", { name: "Actual size" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(row).toBeVisible();
});

test("the Activity Steps panel opens previews to its left on a wide desktop", async ({
  page,
  ui,
}) => {
  test.skip(test.info().project.name !== "c14", "Wide desktop layout");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await ui.open("image-output");
  await page.getByRole("radio", { name: "Activity", exact: true }).click();
  const rail = page.locator(".activity-rail");
  await expect(rail).toBeVisible();
  const row = rail
    .getByTestId("tool-row")
    .filter({ hasText: "read flower-poster/assets/hero1.jpg" });
  await row.locator(".activity-row-head").click();
  const image = row.getByRole("img", { name: "~/flower-poster/assets/hero1.jpg" });
  await image.hover();
  await row.getByRole("button", { name: "Preview image" }).click();
  const preview = page.locator(".file-viewer");
  await expect(preview).toHaveCSS("opacity", "1");
  const panel = await rail.boundingBox();
  const box = await preview.boundingBox();
  expect(box && panel && box.x + box.width <= panel.x).toBe(true);
  await page.screenshot({ path: test.info().outputPath("separate-steps-preview.png") });
});

test("Markdown files switch between the rendered document and its source", async ({ page, ui }) => {
  await ui.open("image-output");
  await page.getByRole("button", { name: "Open summary.md", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "summary.md", exact: true });
  await expect(dialog.getByRole("heading", { name: "Monthly report (sample)" })).toBeVisible();
  await dialog.getByRole("radio", { name: "Source", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Source of summary.md" })).toContainText(
    "# Monthly report (sample)",
  );
  await page.screenshot({ path: test.info().outputPath("markdown-source.png") });
  await dialog.getByRole("radio", { name: "Rendered", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Monthly report (sample)" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("markdown-rendered.png") });
});
