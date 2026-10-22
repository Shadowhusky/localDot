import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type AppUpdateStatus,
  DEFAULT_APP_UPDATES,
} from "../../../../packages/protocol/src/app-update.ts";
import { closeSettings, openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

// The notes the next release ships, and a skipped version's to show folding.
const NOTES = [
  {
    version: "0.1.0-rc.32",
    markdown: readFileSync(
      fileURLToPath(new URL("../../../../docs/releases/0.1.0-rc.32.md", import.meta.url)),
      "utf8",
    ).trim(),
  },
  {
    version: "0.1.0-rc.31",
    markdown: "## Fixes\n\n- Setup finds Docker Desktop's sign-in helpers.",
  },
];

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
    progress: null,
    notes: [],
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

test("an update shows its progress and notes, says what failed, restarts and then says it updated", async ({
  page,
  ui,
}) => {
  const state: AppUpdateStatus = {
    supported: true,
    installOnLaunchSupported: false,
    currentVersion: "0.1.0-rc.30",
    phase: "downloading",
    preferences: { ...DEFAULT_APP_UPDATES },
    checkedAt: Date.parse("2026-10-08T09:00:00Z"),
    availableVersion: "0.1.0-rc.32",
    dismissedVersion: "0.1.0-rc.32",
    error: null,
    progress: { step: "images", value: 0.55, detail: "Preparing the computer · 1.4 of 3.1 GB" },
    notes: NOTES,
  };
  let down = false;
  await page.route("**/api/app-update**", async (route) => {
    // A stopped daemon refuses the request; WebKit reports an aborted one as a page error.
    if (down) return route.fulfill({ status: 502, body: "" });
    if (new URL(route.request().url()).pathname.endsWith("install")) {
      state.phase = "installing";
      state.progress = { step: "install", value: null, detail: "Installing localDot 0.1.0-rc.32" };
    }
    await route.fulfill({ json: state });
  });
  const shot = async (name: string) => {
    await ui.settle();
    await page.screenshot({
      path: test.info().outputPath(`updater-${name}-${test.info().project.name}.png`),
    });
  };
  const refresh = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Your computer");
  const detail = sheet.getByText("Preparing the computer · 1.4 of 3.1 GB", { exact: true });
  await detail.scrollIntoViewIfNeeded();
  await expect(sheet.getByRole("progressbar", { name: "Update progress" })).toHaveAttribute(
    "aria-valuenow",
    "0.55",
  );
  await shot("downloading");

  state.phase = "ready";
  state.progress = { step: "install", value: 0.95, detail: "Ready to install" };
  await refresh();
  await expect(sheet.getByText("Ready to install", { exact: true })).toBeVisible();
  const notes = sheet.getByRole("region", { name: "What's new in 0.1.0-rc.32" });
  await expect(
    notes.getByText(
      "Updates show a progress bar and what's new, and installing one only restarts localDot.",
    ),
  ).toBeVisible();
  const older = notes.getByRole("button", { name: "What's new in 0.1.0-rc.31" });
  await expect(older).toHaveAttribute("aria-expanded", "false");
  await notes.scrollIntoViewIfNeeded();
  await shot("ready-notes");
  await older.click();
  await expect(notes.getByText("Setup finds Docker Desktop's sign-in helpers.")).toBeVisible();

  state.phase = "idle";
  state.error = "localDot 0.1.0-rc.32 couldn't be downloaded, so nothing has changed.";
  state.progress = { step: "images", value: 0.3, detail: null };
  await refresh();
  const steps = sheet.getByRole("list", { name: "Update steps" });
  await expect(steps.getByRole("listitem")).toHaveText([
    "Download",
    "Check the download",
    "Prepare the computer",
    "Install",
    "Restart",
  ]);
  await expect(steps.locator('li[data-state="failed"]')).toHaveText("Prepare the computer");
  await steps.scrollIntoViewIfNeeded();
  await shot("failure");

  state.phase = "ready";
  state.error = null;
  state.progress = { step: "install", value: 0.95, detail: "Ready to install" };
  await refresh();
  await sheet.getByRole("button", { name: "Install update", exact: true }).click();
  await page.getByRole("button", { name: "Shut down and update", exact: true }).click();
  await expect(sheet.getByText("Restarting localDot…", { exact: true })).toBeVisible();
  down = true;
  await refresh();
  await expect(sheet.getByText("Starting localDot 0.1.0-rc.32", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Update status is unavailable. Try again.")).toHaveCount(0);
  await sheet
    .getByRole("status")
    .filter({ hasText: "Restarting localDot…" })
    .scrollIntoViewIfNeeded();
  await shot("restarting");

  Object.assign(state, {
    currentVersion: "0.1.0-rc.32",
    phase: "idle",
    availableVersion: null,
    progress: null,
    notes: NOTES.slice(0, 1),
  });
  down = false;
  // The page's own poll finds the new version and reloads; a second request still in flight
  // would be cut off by the reload, which WebKit reports as a page error.
  await page.waitForEvent("load");
  const toast = page
    .getByRole("region", { name: /notifications/i })
    .getByText("Updated to 0.1.0-rc.32");
  await expect(toast).toBeVisible();
  await page.getByRole("button", { name: "What's new", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "What's new in 0.1.0-rc.32" })
      .getByText(
        "Updates show a progress bar and what's new, and installing one only restarts localDot.",
      ),
  ).toBeVisible();
});
