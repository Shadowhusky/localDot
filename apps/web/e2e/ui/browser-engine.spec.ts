import { openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

const SETUP = "localdot.onboarding.v1";

for (const scheme of ["graphite", "daylight"] as const)
  test.describe(`${scheme} mode`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((choice) => {
        localStorage.setItem("localdot.appearance.v1", choice);
      }, scheme);
    });

    test("setup offers Chrome, naming Google's terms, and needs an accept", async ({
      page,
      ui,
    }, info) => {
      await page.addInitScript(
        ([key]) => localStorage.setItem(key as string, JSON.stringify({ step: "browser" })),
        [SETUP],
      );
      await ui.open("first-run");
      await expect(
        page.getByRole("heading", { name: "Which web browser should dot use?" }),
      ).toBeVisible();
      await expect(page.getByRole("radio", { name: /Google Chrome/u })).toBeChecked();
      await expect(page.getByRole("link", { name: "Google's Terms of Service" })).toHaveAttribute(
        "href",
        "https://policies.google.com/terms",
      );
      await expect(page.getByRole("link", { name: "Chrome's Additional Terms" })).toBeVisible();
      await ui.settle();
      await page.screenshot({ path: info.outputPath(`setup-${scheme}.png`) });
      await page.getByRole("radio", { name: /Chromium/u }).click();
      await expect(page.getByRole("link", { name: "Google's Terms of Service" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
      await page.getByRole("radio", { name: /Google Chrome/u }).click();
      await page.getByRole("button", { name: "Accept and continue" }).click();
      await page.getByRole("button", { name: "Skip for now" }).click();
      await expect(page.getByRole("heading", { name: "You're all set." })).toBeVisible();
      await expect(page.getByText("Google Chrome", { exact: true })).toBeVisible();
    });

    test("Settings asks before Chrome, then gives the way back", async ({ page, ui }, info) => {
      await ui.open("ready");
      const sheet = await openSettings(page, undefined, "Accounts");
      await expect(sheet.getByText("Chromium 154", { exact: true })).toBeVisible();
      await sheet.getByRole("button", { name: "Use Google Chrome…" }).click();
      const dialog = page.getByRole("alertdialog", { name: "Use Google Chrome?" });
      await expect(dialog.getByRole("link", { name: "Google's Terms of Service" })).toBeVisible();
      await ui.settle();
      await page.screenshot({ path: info.outputPath(`settings-ask-${scheme}.png`) });
      await dialog.getByRole("button", { name: "Accept and install" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(sheet.getByText("Google Chrome 157", { exact: true })).toBeVisible();
      await expect(sheet.getByText(/before Chrome opened them/u)).toBeVisible();
      await ui.settle();
      await page.screenshot({ path: info.outputPath(`settings-chrome-${scheme}.png`) });
      await sheet.getByRole("button", { name: "Go back to Chromium…" }).click();
      const back = page.getByRole("alertdialog", { name: "Go back to Chromium?" });
      await expect(back.getByText(/since then is lost/u)).toBeVisible();
      await back.getByRole("button", { name: "Go back", exact: true }).click();
      await expect(sheet.getByText("Chromium 154", { exact: true })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Go back to Chromium…" })).toHaveCount(0);
    });
  });
