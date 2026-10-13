import type { Page } from "@playwright/test";
import type { UiScenarioName } from "../fixtures/ui-scenarios.ts";
import { choose, closeSettings, openSettings, roleCard } from "../settings-ui.ts";
import { expect, type Harness, isPhone, runAt, test } from "./harness.ts";

// The Settings inspector over the page at 1440, and a sheet of sections on a phone.
runAt("c14", "w39");

// Opens Settings at its models, once the saved settings are in.
async function settings(page: Page, ui: Harness, scenario: UiScenarioName = "ready") {
  await ui.open(scenario);
  await ui.picture();
  const sheet = await openSettings(page, undefined, "Models");
  await expect(
    roleCard(sheet, "main").getByRole("combobox", { name: "Model", exact: true }),
  ).toBeVisible();
  return sheet;
}

test("settings, model chooser open", async ({ page, ui }) => {
  const sheet = await settings(page, ui);
  const model = roleCard(sheet, "main").getByRole("combobox", { name: "Model", exact: true });
  await model.click();
  await expect(page.getByRole("listbox", { name: "Model" })).toBeVisible();
});

test("settings, a change saves itself", async ({ page, ui }) => {
  let sheet = await settings(page, ui);
  if (isPhone(page)) {
    await sheet.getByRole("button", { name: "Settings", exact: true }).click();
    await sheet.getByRole("button", { name: /^Autonomy/ }).click();
  }
  const choice = () =>
    sheet.getByRole("radiogroup", { name: "Start from" }).getByRole("radio", { name: /^Careful/ });
  await choice().click();
  await expect(choice()).toBeChecked();
  // Closing waits for the change on its way; opening again shows it saved.
  await closeSettings(page);
  sheet = await openSettings(page, undefined, "Autonomy");
  await expect(choice()).toBeChecked();
});

test("settings, ChatGPT plan", async ({ page, ui }) => {
  const sheet = await settings(page, ui, "chatgpt-plan");
  await expect(sheet.getByText("Signed in as preview@example.test")).toBeVisible();
});

test("visiting an unconfigured provider and returning closes without saving or discarding", async ({
  page,
  ui,
}) => {
  const sheet = await settings(page, ui);
  const main = roleCard(sheet, "main");
  const provider = main.getByRole("combobox", { name: "Provider", exact: true });
  const original = await provider.innerText();
  const model = main.getByRole("combobox", { name: "Model", exact: true });
  const originalModel = await model.innerText();
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/agent/settings")
      writes.push(request.postData() ?? "");
  });
  await choose(page, provider, "DeepSeek", { tap: isPhone(page) });
  await expect(provider).toContainText("DeepSeek");
  await choose(page, provider, original, { tap: isPhone(page) });
  await expect(model).toHaveText(originalModel);
  await closeSettings(page);
  expect(writes).toEqual([]);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
