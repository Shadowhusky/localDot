import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import {
  type AppUpdateStatus,
  DEFAULT_APP_UPDATES,
} from "../../../../packages/protocol/src/app-update.ts";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { closeSettings, openSettings } from "../settings-ui.ts";
import { auditContrast, wearAppearance } from "./contrast.ts";
import { expect, FIXTURE_START, runAt, test } from "./harness.ts";

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
    updating: false,
    unsupported: null,
  };
  let installs = 0;
  await page.route("**/api/app-update**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("preferences")) state.preferences = route.request().postDataJSON();
    if (path.endsWith("/update")) {
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
  await sheet.getByRole("button", { name: "Update now", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Update localDot now?", exact: true });
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
  await reopened.getByRole("button", { name: "Update now", exact: true }).click();
  await dialog.getByRole("button", { name: "Update now", exact: true }).click();
  await expect.poll(() => installs).toBe(1);
});

const OLD = "0.1.0-rc.30";
const NEW = "0.1.0-rc.32";
const updateState = (more: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
  supported: true,
  installOnLaunchSupported: false,
  currentVersion: OLD,
  phase: "ready",
  preferences: { ...DEFAULT_APP_UPDATES },
  checkedAt: Date.parse("2026-10-08T09:00:00Z"),
  availableVersion: NEW,
  dismissedVersion: NEW,
  error: null,
  progress: { step: "install", value: 0.95, detail: "Ready to install" },
  notes: NOTES,
  updating: false,
  unsupported: null,
  ...more,
});

// A daemon that answers from `state`, or stands for a stopped one when `down`.
async function fakeDaemon(page: Page, state: AppUpdateStatus) {
  const daemon = {
    state,
    down: false,
    updates: 0,
    refusal: null as string | null,
    serve: async (viewer: Page) => {
      await viewer.route("**/api/app-update**", async (route) => {
        // A stopped daemon refuses the request; WebKit reports an aborted one as a page error.
        if (daemon.down) return route.fulfill({ status: 502, body: "" });
        if (new URL(route.request().url()).pathname.endsWith("/update")) {
          daemon.updates++;
          if (daemon.refusal) return route.fulfill({ status: 409, body: daemon.refusal });
          Object.assign(daemon.state, {
            phase: "checking",
            updating: true,
            progress: null,
            error: null,
          });
          return route.fulfill({ status: 202, json: { accepted: true } });
        }
        await route.fulfill({ json: daemon.state });
      });
    },
  };
  await daemon.serve(page);
  return daemon;
}
const nudge = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
const stepNow = (where: Locator) => where.locator('li[aria-current="step"]');
const openUpdates = async (page: Page) => {
  const sheet = await openSettings(page, undefined, "Your computer");
  await sheet.getByText("localDot updates").scrollIntoViewIfNeeded();
  return sheet;
};

// Light and dark, in Studio on a wide screen and on the phone. The shots are for looking at.
for (const { name, choice } of [
  { name: "light", choice: "daylight" },
  { name: "dark", choice: "midnight" },
])
  test.describe(name, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((appearance) => {
        localStorage.setItem("localdot.appearance.v1", appearance);
        if (!sessionStorage.getItem("seen")) {
          sessionStorage.setItem("seen", "1");
          localStorage.setItem("localdot.app-version", "0.1.0-rc.30");
        }
      }, choice);
    });
    const shot = async (page: Page, ui: { settle(): Promise<void> }, stage: string) => {
      await ui.settle();
      await page.screenshot({
        path: test.info().outputPath(`update-${stage}-${name}-${test.info().project.name}.png`),
      });
    };

    test("shows each stage at once, through the restart, to the new version", async ({
      page,
      ui,
    }) => {
      const daemon = await fakeDaemon(page, updateState());
      await ui.open("ready");
      const sheet = await openUpdates(page);
      await sheet.getByRole("button", { name: "Update now", exact: true }).click();
      await page
        .getByRole("alertdialog", { name: "Update localDot now?", exact: true })
        .getByRole("button", { name: "Update now", exact: true })
        .click();

      await expect(sheet.getByText("Checking for updates…", { exact: true })).toBeVisible();
      await expect(stepNow(sheet)).toHaveText("Check for updates");
      await shot(page, ui, "checking");

      Object.assign(daemon.state, {
        phase: "downloading",
        progress: { step: "download", value: 0.03, detail: "Downloading · 42% · 8 of 19 MB" },
      });
      await nudge(page);
      await expect(
        sheet.getByText("Downloading · 42% · 8 of 19 MB", { exact: true }),
      ).toBeVisible();
      await expect(stepNow(sheet)).toHaveText("Download");
      await expect(sheet.getByRole("progressbar", { name: "Update progress" })).toHaveAttribute(
        "aria-valuenow",
        "0.03",
      );
      await shot(page, ui, "downloading");

      Object.assign(daemon.state, {
        progress: { step: "verify", value: 0.1, detail: "Checking the download" },
      });
      await nudge(page);
      await expect(stepNow(sheet)).toHaveText("Verify the download");
      await shot(page, ui, "verifying");

      Object.assign(daemon.state, {
        progress: {
          step: "images",
          value: 0.55,
          detail: "Preparing the computer · 50% · 1.4 of 3.1 GB",
        },
      });
      await nudge(page);
      await expect(stepNow(sheet)).toHaveText("Prepare the computer");
      await shot(page, ui, "preparing");

      Object.assign(daemon.state, {
        phase: "installing",
        progress: { step: "install", value: 0.96, detail: "Checking the download once more" },
      });
      await nudge(page);
      const overlay = page.getByRole("alertdialog", { name: `Updating localDot to ${NEW}` });
      await expect(overlay.getByText("Checking the download once more")).toBeVisible();
      await expect(stepNow(overlay)).toHaveText("Install");
      await shot(page, ui, "installing");

      Object.assign(daemon.state, {
        progress: { step: "restart", value: 0.97, detail: "Restarting localDot" },
      });
      await nudge(page);
      await expect(stepNow(overlay)).toHaveText("Restart");
      await shot(page, ui, "restarting");

      daemon.down = true;
      await nudge(page);
      await expect(overlay.getByText(`Starting localDot ${NEW}`)).toBeVisible();
      await expect(page.getByText("isn't answering")).toHaveCount(0);
      await shot(page, ui, "restarting-down");

      Object.assign(daemon.state, {
        currentVersion: NEW,
        availableVersion: null,
        progress: { step: "restart", value: 0.99, detail: `Checking localDot ${NEW}` },
      });
      daemon.down = false;
      await nudge(page);
      await expect(stepNow(overlay)).toHaveText("Reconnect");
      await shot(page, ui, "reconnecting");

      Object.assign(daemon.state, {
        phase: "idle",
        updating: false,
        progress: null,
        notes: NOTES.slice(0, 1),
      });
      // The page's own poll finds the new version and reloads; a second request still in flight
      // would be cut off by the reload, which WebKit reports as a page error.
      await page.waitForEvent("load");
      await expect(
        page.getByRole("region", { name: /notifications/i }).getByText(`Updated to ${NEW}`),
      ).toBeVisible();
      await shot(page, ui, "updated");
      expect(daemon.updates).toBe(1);
    });

    test("a failed install says what happened and retries on one press", async ({ page, ui }) => {
      const daemon = await fakeDaemon(
        page,
        updateState({
          error: `localDot ${NEW} couldn't be installed, so nothing has changed. Docker isn't running. Start it and try again.`,
          progress: { step: "install", value: null, detail: null },
        }),
      );
      await ui.open("ready");
      const sheet = await openUpdates(page);
      await expect(sheet.getByText("The update didn't finish", { exact: true })).toBeVisible();
      await expect(sheet.getByText(/Docker isn't running/)).toBeVisible();
      const steps = sheet.getByRole("list", { name: "Update steps" });
      await expect(steps.locator('li[data-state="failed"]')).toHaveText("Install");
      await steps.scrollIntoViewIfNeeded();
      await shot(page, ui, "failed");
      await sheet
        .locator(".ui-group-row")
        .filter({ hasText: "The update didn't finish" })
        .getByRole("button", { name: "Retry", exact: true })
        .click();
      await expect(sheet.getByText("Checking for updates…", { exact: true })).toBeVisible();
      expect(daemon.updates).toBe(1);
    });

    test("a rollback says the previous version came back, and never claims the update", async ({
      page,
      ui,
    }) => {
      const daemon = await fakeDaemon(
        page,
        updateState({
          phase: "installing",
          updating: true,
          progress: { step: "restart", value: 0.97, detail: "Restarting localDot" },
        }),
      );
      await ui.open("ready");
      const overlay = page.getByRole("alertdialog", { name: `Updating localDot to ${NEW}` });
      await expect(overlay).toBeVisible();
      daemon.down = true;
      await nudge(page);
      await expect(overlay.getByText(`Starting localDot ${NEW}`)).toBeVisible();
      Object.assign(daemon.state, {
        phase: "ready",
        updating: false,
        error: `localDot ${NEW} started but failed its checks, so your previous version was restored.`,
        progress: { step: "restart", value: null, detail: null },
      });
      daemon.down = false;
      await nudge(page);
      await expect(overlay).toBeHidden();
      const notices = page.getByRole("region", { name: /notifications/i });
      await expect(notices.getByText(/your previous version was restored/)).toBeVisible();
      await expect(notices.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(notices.getByText(/Updated to/)).toHaveCount(0);
      await shot(page, ui, "rolled-back");
    });

    test("a restart that never returns says so, and recovers when it does", async ({
      page,
      ui,
    }) => {
      const daemon = await fakeDaemon(
        page,
        updateState({
          phase: "installing",
          updating: true,
          progress: { step: "restart", value: 0.97, detail: "Restarting localDot" },
        }),
      );
      await ui.open("ready");
      const overlay = page.getByRole("alertdialog", { name: `Updating localDot to ${NEW}` });
      await expect(overlay).toBeVisible();
      daemon.down = true;
      await nudge(page);
      await expect(overlay.getByText(`Starting localDot ${NEW}`)).toBeVisible();
      const later = (minutes: number) =>
        new Date(Date.parse(FIXTURE_START) + 60_000 + minutes * 60_000);
      await page.clock.setFixedTime(later(2));
      await nudge(page);
      await expect(overlay.getByText(/taking longer than usual/)).toBeVisible();
      await shot(page, ui, "restart-slow");
      await page.clock.setFixedTime(later(6));
      await nudge(page);
      await expect(overlay.getByText(/run localdot up/)).toBeVisible();
      await shot(page, ui, "restart-lost");
      Object.assign(daemon.state, {
        phase: "ready",
        updating: false,
        error: "localDot rc didn't start.",
        progress: { step: "restart", value: null, detail: null },
      });
      daemon.down = false;
      await nudge(page);
      await expect(overlay).toBeHidden();
    });

    test("a working task holds the update back in plain words", async ({ page, ui }) => {
      const daemon = await fakeDaemon(page, updateState());
      daemon.refusal = "Finish or stop the task before updating localDot.";
      await ui.open("ready");
      const sheet = await openUpdates(page);
      await sheet.getByRole("button", { name: "Update now", exact: true }).click();
      await page
        .getByRole("alertdialog", { name: "Update localDot now?", exact: true })
        .getByRole("button", { name: "Update now", exact: true })
        .click();
      await expect(sheet.getByText(daemon.refusal, { exact: true })).toBeVisible();
      await expect(sheet.getByRole("list", { name: "Update steps" })).toHaveCount(0);
      await shot(page, ui, "task-working");
    });
  });

test("what an update says stays readable in every appearance", async ({ page, ui }) => {
  const daemon = await fakeDaemon(
    page,
    updateState({
      phase: "downloading",
      updating: true,
      progress: { step: "download", value: 0.03, detail: "Downloading · 42% · 8 of 19 MB" },
    }),
  );
  await ui.open("ready");
  const sheet = await openUpdates(page);
  const read = async (state: string) => {
    await ui.settle();
    for (const [turn, appearance] of (["daylight", "graphite", "midnight"] as const).entries()) {
      await wearAppearance(page, appearance);
      const { failures } = await auditContrast(page, { stillSince: turn > 0 });
      expect
        .soft(
          failures.map(
            (each) =>
              `${state} ${appearance} ${each.ratio}:1 < ${each.needs} ${each.kind} "${each.what}"`,
          ),
        )
        .toEqual([]);
    }
  };
  await expect(sheet.getByText(/Downloading · 42%/)).toBeVisible();
  await read("downloading");
  Object.assign(daemon.state, {
    phase: "ready",
    updating: false,
    error: `localDot ${NEW} couldn't be installed, so nothing has changed. Docker isn't running. Start it and try again.`,
    progress: { step: "install", value: null, detail: null },
  });
  await nudge(page);
  await expect(sheet.getByRole("list", { name: "Update steps" })).toBeVisible();
  await read("failed");
  Object.assign(daemon.state, {
    phase: "installing",
    updating: true,
    error: null,
    progress: { step: "restart", value: 0.97, detail: "Restarting localDot" },
  });
  await nudge(page);
  await expect(
    page.getByRole("alertdialog", { name: `Updating localDot to ${NEW}` }),
  ).toBeVisible();
  await read("restarting");
});

test("a copy running from source says so, with nothing to press that could fail", async ({
  page,
  ui,
}) => {
  await fakeDaemon(
    page,
    updateState({
      supported: false,
      unsupported: "source-checkout",
      currentVersion: "Development",
      phase: "idle",
      availableVersion: null,
      dismissedVersion: null,
      progress: null,
      notes: [],
    }),
  );
  await ui.open("ready");
  const sheet = await openUpdates(page);
  await expect(sheet.getByText("This copy runs from source", { exact: true })).toBeVisible();
  await expect(sheet.getByText(/pull, rebuild, then restart localDot/)).toBeVisible();
  await expect(
    sheet
      .locator(".ui-group-row")
      .filter({ hasText: "This copy runs from source" })
      .getByRole("button"),
  ).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("update-source-checkout.png") });
});

test("every device follows: a second page shows the update someone else started", async ({
  page,
  ui,
}) => {
  const daemon = await fakeDaemon(page, updateState());
  const fixture = await ui.open("ready");
  const other = await page.context().newPage();
  await daemon.serve(other);
  await other.goto(`${fixture.origin}/#token=${TOKEN}`);
  const sheet = await openUpdates(page);
  await sheet.getByRole("button", { name: "Update now", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Update localDot now?", exact: true })
    .getByRole("button", { name: "Update now", exact: true })
    .click();
  await expect(sheet.getByText("Checking for updates…", { exact: true })).toBeVisible();
  Object.assign(daemon.state, {
    phase: "downloading",
    progress: { step: "download", value: 0.03, detail: "Downloading · 42% · 8 of 19 MB" },
  });
  await nudge(other);
  const notices = other.getByRole("region", { name: /notifications/i });
  await expect(notices.getByText(/Downloading · 42%/)).toBeVisible();
  await expect(notices.getByRole("button", { name: "Details" })).toBeVisible();
  await other.screenshot({ path: test.info().outputPath("update-second-device-download.png") });
  Object.assign(daemon.state, {
    phase: "installing",
    progress: { step: "install", value: 0.96, detail: "Checking the download once more" },
  });
  await nudge(other);
  await expect(
    other.getByRole("alertdialog", { name: `Updating localDot to ${NEW}` }),
  ).toBeVisible();
  await other.close();
});

test.describe("with its service worker", () => {
  test.use({ serviceWorkers: "allow" });
  test("a reload during the restart finds a page that waits, then comes back by itself", async ({
    page,
    ui,
    browserName,
  }) => {
    test.skip(browserName === "webkit", "Playwright's WebKit can't go offline under a worker");
    await fakeDaemon(
      page,
      updateState({
        phase: "installing",
        updating: true,
        progress: { step: "restart", value: 0.97, detail: "Restarting localDot" },
      }),
    );
    await ui.open("ready");
    await expect(
      page.getByRole("alertdialog", { name: `Updating localDot to ${NEW}` }),
    ).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.context().setOffline(true);
    ui.leaving();
    await page.reload();
    await expect(page.getByRole("heading", { name: `Updating localDot to ${NEW}` })).toBeVisible();
    await expect(page.getByText("This page reconnects by itself.")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("update-reload-while-down.png") });
    const back = page.waitForEvent("load", { timeout: 20_000 });
    await page.context().setOffline(false);
    await back;
    await expect(
      page
        .getByRole("button", { name: "Settings", exact: true })
        .or(page.getByRole("button", { name: "More", exact: true }))
        .or(page.getByRole("button", { name: /this computer and app settings$/ }))
        .first(),
    ).toBeVisible();
  });
});
