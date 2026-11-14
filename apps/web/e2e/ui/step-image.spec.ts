import { PANEL_NAME } from "../../src/shell/panel-name.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "w39");
test("saved image reads display inside Steps after reopening the conversation", async ({
  page,
  ui,
}) => {
  await ui.open("image-output");
  for (const reopened of [false, true]) {
    if (reopened) {
      ui.leaving();
      await page.reload();
    }
    if (isPhone(page)) await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
    else await page.getByRole("radio", { name: PANEL_NAME, exact: true }).click();
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

// While a step's picture loads, its room says so in the middle, not in a corner.
test("a step's picture says it is loading in the middle of its room", async ({ page, ui }) => {
  await ui.open("image-output");
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/files/**", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  if (isPhone(page)) await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
  else await page.getByRole("radio", { name: PANEL_NAME, exact: true }).click();
  const row = page
    .getByTestId("tool-row")
    .filter({ hasText: "read flower-poster/assets/hero1.jpg" });
  await row.getByRole("button", { name: /read flower-poster/ }).click();
  const status = row.getByRole("status").filter({ hasText: "Loading image…" });
  await expect(status).toBeVisible();
  await ui.settle();
  const room = await row.locator(".step-output-image").boundingBox();
  const words = await status.boundingBox();
  release();
  if (!room || !words) throw new Error("Nothing to measure");
  expect(Math.abs(words.y + words.height / 2 - (room.y + room.height / 2))).toBeLessThan(4);
  expect(Math.abs(words.x + words.width / 2 - (room.x + room.width / 2))).toBeLessThan(4);
});
