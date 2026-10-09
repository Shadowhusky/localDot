import { expect, keepBaselinesAt, test } from "./harness.ts";

// Today's main screens, as pixels. A task that changes one of them updates its baseline on purpose
// (--update-snapshots) and reviews the new image.
keepBaselinesAt("c14", "w39");

test("watch, running", async ({ page, ui }) => {
  await ui.open("running");
  await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
  await ui.picture();
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("watch-running.png");
});

test("watch, approval", async ({ page, ui }) => {
  await ui.open("running");
  await ui.picture();
  await ui.step("approval");
  await expect(page.getByRole("dialog", { name: /^Send the monthly report/ })).toBeVisible();
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("watch-approval.png");
});

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

test("replay", async ({ page, ui }) => {
  await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=20000`);
  await expect(page.getByRole("status", { name: "Replay time" })).toHaveText("0:20 / 3:00");
  await ui.picture(page.locator(".replay-stage"));
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("replay.png");
});
