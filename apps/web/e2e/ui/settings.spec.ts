import type { Page } from "@playwright/test";
import type { UiScenarioName } from "../fixtures/ui-scenarios.ts";
import { roleCard, settingsSheet } from "../settings-ui.ts";
import { expect, type Harness, keepBaselinesAt, test } from "./harness.ts";

// The Settings inspector beside the page at 1440, and as a sheet over it on a phone.
keepBaselinesAt("c14", "w39");

async function settings(page: Page, ui: Harness, scenario: UiScenarioName = "ready") {
  await ui.open(scenario);
  await ui.picture();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const sheet = settingsSheet(page);
  await expect(sheet.getByText("All changes saved", { exact: true })).toBeVisible();
  return sheet;
}

async function shoot(page: Page, ui: Harness, name: string) {
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot(name);
}

test("settings, model chooser open", async ({ page, ui }) => {
  const sheet = await settings(page, ui);
  const model = roleCard(sheet, "main").getByRole("combobox", { name: "Model", exact: true });
  await model.click();
  await expect(page.getByRole("listbox", { name: "Model" })).toBeVisible();
  await shoot(page, ui, "settings-model-chooser.png");
});

test("settings, autonomy", async ({ page, ui }) => {
  const sheet = await settings(page, ui);
  await sheet.locator("#settings-autonomy").evaluate((section) => section.scrollIntoView());
  await shoot(page, ui, "settings-autonomy.png");
});

test("settings, unsaved changes", async ({ page, ui }) => {
  const sheet = await settings(page, ui);
  await sheet
    .getByRole("radiogroup", { name: "Send as you" })
    .getByRole("radio", { name: "Just do it" })
    .click();
  await expect(sheet.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await shoot(page, ui, "settings-dirty-footer.png");
});

test("settings, ChatGPT plan", async ({ page, ui }) => {
  const sheet = await settings(page, ui, "chatgpt-plan");
  await expect(sheet.getByText("Signed in as preview@example.test")).toBeVisible();
  await shoot(page, ui, "settings-chatgpt.png");
});
