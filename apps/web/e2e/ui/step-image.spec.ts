import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "w39");
test("saved image reads display inside Steps after reopening the conversation", async ({
  page,
  ui,
}) => {
  await ui.open("image-output");
  for (const reopened of [false, true]) {
    if (reopened) await page.reload();
    if (isPhone(page)) await page.getByRole("button", { name: "Activity", exact: true }).click();
    else await page.getByRole("radio", { name: "Activity", exact: true }).click();
    const row = page
      .getByTestId("tool-row")
      .filter({ hasText: "read flower-poster/assets/hero1.jpg" });
    await row.getByRole("button", { name: /read flower-poster/ }).click();
    const image = row.getByRole("img", { name: "~/flower-poster/assets/hero1.jpg" });
    await expect(image).toBeVisible();
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBe(640);
    expect(
      await image.evaluate((node) => node.getBoundingClientRect().right <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`step-image-${reopened ? "history" : "first"}.png`),
    });
  }
});
