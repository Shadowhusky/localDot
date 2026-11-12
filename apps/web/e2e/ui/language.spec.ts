import type { Locator, Page } from "@playwright/test";
import { openSettings, settingsSheet } from "../settings-ui.ts";
import { expect, type Harness, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14");

async function shot(page: Page, ui: Harness, name: string) {
  await ui.settle();
  await ui.still();
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

// Settings' way in, read in Chinese: the gear, More on Studio's phone, or the computer pill over
// Chat's list.
async function openSettingsInChinese(page: Page): Promise<Locator> {
  const gear = page.getByRole("button", { name: "设置", exact: true });
  const more = page.getByRole("button", { name: "更多", exact: true });
  const back = page.getByRole("button", { name: "返回对话列表" });
  const pill = page.getByRole("button", { name: /这台电脑和 App 设置$/ });
  await expect(gear.or(more).or(pill).first()).toBeVisible();
  const sheet = settingsSheet(page);
  if (await gear.isVisible()) {
    await gear.click();
    await sheet.getByRole("button", { name: "外观", exact: true }).click();
    return sheet;
  }
  if (await back.isVisible()) await back.click();
  await ((await pill.isVisible()) ? pill : more).click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  await sheet.getByRole("button", { name: /^外观/ }).click();
  return sheet;
}

async function choose(page: Page, sheet: Locator, field: string, option: string) {
  const chooser = sheet.getByRole("combobox", { name: field, exact: true });
  await chooser.scrollIntoViewIfNeeded();
  await chooser.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("chosen in Settings, the app speaks Simplified Chinese, and English again", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await choose(page, await openSettings(page, undefined, "Appearance"), "Language", "简体中文");
  // The page reloads in the language chosen, every word of it, those fixed as modules load too.
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await shot(page, ui, "zh-running");
  const sheet = await openSettingsInChinese(page);
  await expect(sheet.getByRole("combobox", { name: "语言", exact: true })).toBeVisible();
  await shot(page, ui, "zh-settings");
  await choose(page, sheet, "语言", "English");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page
      .getByRole("button", { name: "Settings", exact: true })
      .or(page.getByRole("button", { name: "More", exact: true }))
      .or(page.getByRole("button", { name: /this computer and app settings$/ }))
      .first(),
  ).toBeVisible();
});

test.describe("on a device set to Chinese", () => {
  test.use({ locale: "zh-CN" });
  test("the app is in Chinese without choosing", async ({ page, ui }) => {
    await ui.open("running");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await shot(page, ui, "zh-device");
  });
});
