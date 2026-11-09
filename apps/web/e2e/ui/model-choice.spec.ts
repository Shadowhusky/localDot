import type { Page } from "@playwright/test";
import { PANEL_NAME } from "../../src/shell/panel-name.ts";
import { openSettings } from "../settings-ui.ts";
import { expect, type Harness, isPhone, openComposer, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

// The page as it stands in each of the app's looks, for looking at.
async function shots(page: Page, ui: Harness, name: string) {
  for (const appearance of ["daylight", "graphite"]) {
    await page.evaluate((shown) => {
      document.documentElement.dataset.appearance = shown;
    }, appearance);
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath(`${name}-${appearance}.png`) });
  }
}

test("a model chosen in a task stays with that task, and goes with its next message", async ({
  page,
  ui,
}) => {
  const { origin } = await ui.open("running");
  const card = await openComposer(page);
  const chip = card.getByRole("button", { name: /^Model/ });
  await expect(chip).toContainText("Sonnet");
  await chip.click();
  const panel = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(panel).toContainText("Applies from your next message");
  await panel.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "GPT-6 Luna", exact: true }).click();
  await shots(page, ui, "model-menu");
  await panel.getByRole("button", { name: "Apply" }).click();
  await expect(chip).toContainText("GPT-6 Luna");

  // Settings holds the default: it hasn't moved.
  const saved = await page.evaluate(
    async ({ origin, token }) =>
      (
        await fetch(`${origin}/api/agent/settings`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json(),
    { origin, token: "a".repeat(43) },
  );
  expect(saved.main.model).toBe("claude-sonnet-5-5");

  ui.leaving();
  await page.reload();
  const again = await openComposer(page);
  await expect(again.getByRole("button", { name: /^Model/ })).toContainText("GPT-6 Luna");

  await again.getByRole("textbox").first().fill("Now fix the import");
  await expect(again.getByText("Runs on GPT-6 Luna after this task")).toBeVisible();
  await shots(page, ui, "runs-after");
  await again.getByRole("button", { name: "Send after this task" }).click();
  await expect(
    page
      .getByRole("article", { name: "You", exact: true })
      .filter({ hasText: "Now fix the import" })
      .getByText("After this task"),
  ).toBeVisible();
  await expect
    .poll(
      async () => (await (await page.request.get(`${origin}/__qa/last-turn-model`)).json()).model,
    )
    .toBe("gpt-6-luna");
});

test("steps name their model where it changes, in chat and in the activity panel", async ({
  page,
  ui,
}) => {
  const { origin } = await ui.open("running");
  await page.request.post(`${origin}/__qa/model-change`);
  const run = page.locator(".thread-work-steps > .ui-disclosure-trigger:visible").last();
  await expect(run).toBeVisible();
  const list = page.locator(".thread-work-list");
  if (!(await list.isVisible())) await run.click();
  await expect(list.locator(".work-model-change")).toHaveCount(1);
  await expect(list.locator(".work-model-change")).toHaveText("GPT-6 Luna");
  await shots(page, ui, "chat-model-change");
  if (isPhone(page)) await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: PANEL_NAME, exact: true }).click();
  const rail = page.locator(".activity-rail:visible");
  await expect(rail.locator(".work-model-change")).toHaveText(["Claude Sonnet 5.5", "GPT-6 Luna"]);
  await rail.locator(".work-model-change").last().scrollIntoViewIfNeeded();
  await shots(page, ui, "activity-model-change");
});

test("Settings keeps several models on one key, each on or off, any of them the default", async ({
  page,
  ui,
}) => {
  const { origin } = await ui.open("ready");
  await page.request.post(`${origin}/__qa/own-endpoint`);
  const sheet0 = await openSettings(page, undefined, "Models");
  const section = sheet0.getByRole("region", { name: "Your models" });
  await expect(section).toContainText("Default");
  await section.scrollIntoViewIfNeeded();
  await shots(page, ui, "settings-models");

  await section.getByRole("button", { name: "Add models" }).click();
  const sheet = page.getByRole("dialog", { name: "Add models" });
  await expect(sheet).toBeVisible();
  // From searches every provider; a phone's list is a sheet a finger taps.
  const from = sheet.getByRole("combobox", { name: "From", exact: true });
  const option = page.getByRole("option", { name: /relay\.example/ });
  if (isPhone(page)) {
    await from.tap();
    await option.tap();
  } else {
    await from.click();
    await option.click();
  }
  // The endpoint's own list, and a model it doesn't list, added by hand.
  await sheet.getByText("gpt-6.1-terra", { exact: true }).click();
  await sheet.getByLabel("Add by ID").fill("gpt-6-luna-new");
  await sheet.getByLabel("Input price").fill("1");
  await sheet.getByLabel("Output price").fill("2");
  await shots(page, ui, "settings-add-models");
  await sheet.getByRole("button", { name: "Add 2 models", exact: true }).click();
  await expect(sheet).toBeHidden();
  const row = section.locator(".settings-model-row", { hasText: "gpt-6-luna-new" });
  await expect(row).toBeVisible();
  await row.getByText("gpt-6-luna-new", { exact: true }).first().click();
  await expect(row.getByRole("switch")).not.toBeChecked();
  await row.getByRole("button", { name: /^More for/ }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);
});
