import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
for (const width of [320, 390, 1440]) {
  test(`download review contains long names and actions at ${width}px`, async ({ page, ui }) => {
    await page.setViewportSize({ width, height: 740 });
    const name = `thema-app-${"6b676d0e6749460016d829707ed2038501796452".repeat(3)}.zip`;
    await page.route("**/api/cells/*/quarantine", async (route) => {
      const parentCellId = new URL(route.request().url()).pathname.split("/")[3];
      await route.fulfill({
        json: {
          items: [
            {
              version: 1,
              id: "01M4D263DDHCRM52FMG340DDF1",
              parentCellId,
              browserCellId: "01M4D263DDHCRM52FMG340DDF2",
              browserInstance: "b0b00198-54b2-46fa-8f78-1020e4880f24",
              sessionId: "01M4D263DDHCRM52FMG340DDF3",
              name,
              source: "codeload.github.com",
              bytes: 19800000,
              sha256: "a".repeat(64),
              kind: "archive",
              createdAt: 1,
              revision: 1,
              state: "held",
            },
          ],
        },
      });
    });
    await ui.open("ready");
    await page
      .getByRole(width < 700 ? "button" : "radio", { name: "Activity", exact: true })
      .click();
    await page.getByRole("tab", { name: /^Files/ }).click();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await ui.settle();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    // Content may scroll vertically, but the choices remain reachable and fully inside.
    const save = dialog.getByRole("button", { name: "Save to computer", exact: true });
    await save.scrollIntoViewIfNeeded();
    const action = await save.boundingBox();
    expect(action!.x).toBeGreaterThanOrEqual(box!.x);
    expect(action!.x + action!.width).toBeLessThanOrEqual(box!.x + box!.width);
    expect(action!.y + action!.height).toBeLessThanOrEqual(740);
    await page.screenshot({ path: test.info().outputPath("download-review.png") });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
}
