import { expect, keepBaselinesAt, test } from "./harness.ts";

// Today's main screens, as pixels. A task that changes one of them updates its baseline on purpose
// (--update-snapshots) and reviews the new image.
keepBaselinesAt("c14", "w39");

test("watch, done", async ({ page, ui }) => {
  await ui.open("done");
  await expect(page.getByTestId("hud-status")).toHaveText("Done");
  await ui.picture();
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("watch-done.png");
});

test("settings", async ({ page, ui }) => {
  await ui.open("ready");
  await ui.picture();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("settings.png");
});

test("keys", async ({ page, ui }) => {
  await ui.open("ready");
  await ui.picture();
  await page.getByTestId("keys-button").click();
  await expect(page.getByRole("dialog", { name: "Keys" }).getByText("openai-fast")).toBeVisible();
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("keys.png");
});
