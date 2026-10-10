import {
  type AppUpdateStatus,
  DEFAULT_APP_UPDATES,
} from "../../../../packages/protocol/src/app-update.ts";
import { closeSettings, openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "w39");

test("a postponed app update stays in Settings with aligned mobile controls", async ({
  page,
  ui,
}) => {
  const state: AppUpdateStatus = {
    supported: true,
    installOnLaunchSupported: true,
    currentVersion: "1.0.0",
    phase: "ready",
    preferences: { ...DEFAULT_APP_UPDATES },
    checkedAt: Date.parse("2026-10-08T09:00:00Z"),
    availableVersion: "1.1.0",
    dismissedVersion: "1.1.0",
    error: null,
  };
  let installs = 0;
  await page.route("**/api/app-update**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("preferences")) state.preferences = route.request().postDataJSON();
    if (path.endsWith("install")) {
      expect(route.request().postDataJSON()).toEqual({ confirmShutdown: true });
      installs++;
    }
    await route.fulfill({ json: state });
  });
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Your computer");
  const title = sheet.getByText("localDot 1.1.0 is ready", { exact: true });
  await title.scrollIntoViewIfNeeded();
  await expect(title).toBeVisible();
  await expect(sheet.getByText("Installed version 1.0.0")).toBeVisible();
  await sheet.getByRole("button", { name: "Install update", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Shut down and update?", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Later", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Later", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(installs).toBe(0);
  await expect(title).toBeVisible();
  const preference = sheet.getByRole("switch", { name: "Install at next launch", exact: true });
  await preference.scrollIntoViewIfNeeded();
  await ui.settle();
  const before = await sheet.locator("#settings-computer").boundingBox();
  await preference.click();
  await expect(
    sheet.getByRole("switch", { name: "Install at next launch", exact: true }),
  ).not.toBeChecked();
  expect(await sheet.locator("#settings-computer").boundingBox()).toEqual(before);
  await closeSettings(page);
  await page.reload();
  const reopened = await openSettings(page, undefined, "Your computer");
  await reopened.getByText("localDot 1.1.0 is ready").scrollIntoViewIfNeeded();
  await expect(
    reopened.getByRole("switch", { name: "Install at next launch", exact: true }),
  ).not.toBeChecked();
  await ui.settle();
  await page.waitForTimeout(450);
  await page.screenshot({ path: test.info().outputPath("software-update.png") });
  const overflow = await reopened.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>(".ui-group-row")]
      .filter((row) => row.offsetWidth > 0)
      .some((row) => row.scrollWidth > row.clientWidth + 1),
  );
  expect(overflow).toBe(false);
  await reopened.getByRole("button", { name: "Install update", exact: true }).click();
  await dialog.getByRole("button", { name: "Shut down and update", exact: true }).click();
  await expect.poll(() => installs).toBe(1);
});
