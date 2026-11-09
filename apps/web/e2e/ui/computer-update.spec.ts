import type { Page } from "@playwright/test";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { closeSettings, openSettings } from "../settings-ui.ts";
import { auditContrast, wearAppearance } from "./contrast.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

const steps = async (page: Page, origin: string, query: Record<string, string>) => {
  const answer = await page.request.post(
    `${origin}/__qa/update/step?${new URLSearchParams(query)}`,
  );
  expect(answer.ok(), await answer.text()).toBe(true);
};
const offer = async (page: Page, origin: string, query = "hold=1") => {
  const answer = await page.request.post(`${origin}/__qa/update?${query}`);
  expect(answer.ok(), await answer.text()).toBe(true);
};
const openUpdates = async (page: Page) => {
  const sheet = await openSettings(page, undefined, "Your computer");
  const heading = sheet.getByRole("heading", { name: "Computer updates" });
  await heading.scrollIntoViewIfNeeded();
  return { sheet, heading };
};
const notices = (page: Page) => page.getByRole("region", { name: /notifications/i });
const pressUpdate = async (page: Page) => {
  const { sheet } = await openUpdates(page);
  await sheet.getByRole("button", { name: "Update", exact: true }).click();
  return sheet;
};
const stepNow = (page: Page) => page.locator('[aria-label="Update steps"] li[aria-current="step"]');

for (const { name, choice } of [
  { name: "light", choice: "daylight" },
  { name: "dark", choice: "midnight" },
])
  test.describe(name, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((appearance) => {
        localStorage.setItem("localdot.appearance.v1", appearance);
      }, choice);
    });
    const shot = async (page: Page, ui: { settle(): Promise<void> }, stage: string) => {
      await ui.settle();
      await page.screenshot({
        path: test.info().outputPath(`computer-${stage}-${name}-${test.info().project.name}.png`),
      });
    };

    test("shows every stage from the press to the computer back, with files kept", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("ready");
      await offer(page, fixture.origin);
      const sheet = await pressUpdate(page);

      // At once, before the daemon has said anything.
      await expect(sheet.getByText("Updating…", { exact: true })).toBeVisible();
      await expect(stepNow(page)).toHaveText("Get the new version");

      await steps(page, fixture.origin, {
        stage: "download",
        share: "0.45",
        detail: "Downloading · 45% · 1.4 of 3.1 GB",
      });
      await expect(
        sheet.getByText("Step 1 of 6 · Downloading · 45% · 1.4 of 3.1 GB"),
      ).toBeVisible();
      await expect(notices(page).getByText(/Downloading · 45%/)).toBeVisible();
      await expect(sheet.getByRole("progressbar", { name: "Update progress" })).toHaveAttribute(
        "aria-valuenow",
        "0.075",
      );
      await shot(page, ui, "download");

      await steps(page, fixture.origin, { stage: "stop" });
      await expect(stepNow(page)).toHaveText("Stop your computer");
      await shot(page, ui, "stop");

      await steps(page, fixture.origin, {
        stage: "keep",
        share: "0.3",
        detail: "Comparing it with the new version",
      });
      await expect(
        sheet.getByText("Step 3 of 6 · Comparing it with the new version"),
      ).toBeVisible();
      await expect(stepNow(page)).toHaveText("Keep your apps and files");
      await shot(page, ui, "keep");

      await steps(page, fixture.origin, { stage: "replace" });
      await expect(stepNow(page)).toHaveText("Install the new version");
      await shot(page, ui, "replace");

      await steps(page, fixture.origin, { stage: "start" });
      await expect(stepNow(page)).toHaveText("Start your computer");
      await shot(page, ui, "start");

      await closeSettings(page);
      if (!isPhone(page)) {
        const curtain = page.getByRole("region", { name: "Updating your computer" });
        await expect(curtain.locator(".curtain-sub")).toContainText("Step 5 of 6");
        await expect(curtain.locator(".curtain-sub")).toContainText("Your files and sign-ins stay");
        await shot(page, ui, "curtain");
      }

      await steps(page, fixture.origin, { stage: "reconnect" });
      await expect(notices(page).getByText(/Step 6 of 6/)).toBeVisible();
      await shot(page, ui, "reconnect");

      await steps(page, fixture.origin, {});
      await expect(notices(page).getByText("Your computer is updated")).toBeVisible();
      await expect(
        notices(page).getByText("Your files and sign-ins are all still there."),
      ).toBeVisible();
      await shot(page, ui, "done");
    });

    test("a failed update says what happened, that the files are kept, and retries", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("ready");
      await offer(page, fixture.origin);
      const sheet = await pressUpdate(page);
      await steps(page, fixture.origin, {
        fail: "keep",
        message:
          "Your computer couldn't be updated. It's back as it was, and your files are kept. Docker has run out of disk space. Free some up and try again.",
      });
      await expect(notices(page).getByText("Your computer wasn't updated")).toBeVisible();
      await expect(notices(page).getByRole("button", { name: "Retry" })).toBeVisible();
      const row = sheet.locator(".ui-group-row").filter({ hasText: "wasn't updated" });
      await expect(row.getByText(/Docker has run out of disk space/)).toBeVisible();
      await expect(
        row.getByRole("list", { name: "Update steps" }).locator('li[data-state="failed"]'),
      ).toHaveText("Keep your apps and files");
      await shot(page, ui, "failed");
      await row.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(sheet.getByText("Updating…", { exact: true })).toBeVisible();
    });

    test("a computer the failure left off says so, and that it starts by itself", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("ready");
      await steps(page, fixture.origin, {
        fail: "keep",
        state: "stopped",
        message:
          "Your computer couldn't be updated. Your files are kept. It starts again by itself as soon as Docker answers.",
      });
      if (!isPhone(page)) {
        const curtain = page.getByRole("region", { name: "Your computer wasn't updated" });
        await expect(curtain.locator(".curtain-sub")).toContainText("as soon as Docker answers");
        await expect(curtain.getByRole("button", { name: "Turn on" })).toBeVisible();
      }
      await expect(notices(page).getByText("Your computer wasn't updated")).toBeVisible();
      await shot(page, ui, "failed-off");
    });

    test("a slow step says it is slow, then says it is too slow, without pretending", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("ready");
      await offer(page, fixture.origin);
      const sheet = await pressUpdate(page);
      await steps(page, fixture.origin, {
        stage: "keep",
        detail: "Saving what's on your computer",
        elapsed: String(4 * 60_000),
      });
      await expect(sheet.getByText(/taking longer than usual/)).toBeVisible();
      await shot(page, ui, "slow");
      await steps(page, fixture.origin, {
        stage: "replace",
        elapsed: String(31 * 60_000),
      });
      await expect(sheet.getByText(/much longer than it should/)).toBeVisible();
      await shot(page, ui, "too-slow");
    });

    test("a working task holds the update back and says why", async ({ page, ui }) => {
      const fixture = await ui.open("ready");
      await offer(page, fixture.origin, "refuse=Wait for dot to finish, or stop the task first.");
      await pressUpdate(page);
      await expect(
        notices(page).getByText("Wait for dot to finish, or stop the task first."),
      ).toBeVisible();
      await shot(page, ui, "task-working");
    });
  });

test("a page reloaded mid-update, and a second device, show the same stage", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("ready");
  await offer(page, fixture.origin);
  await pressUpdate(page);
  await steps(page, fixture.origin, { stage: "keep", detail: "Saving what's on your computer" });
  const other = await page.context().newPage();
  await other.goto(`${fixture.origin}/#token=${TOKEN}`);
  await expect(
    other
      .getByRole("region", { name: /notifications/i })
      .getByText(/Step 3 of 6 · Saving what's on your computer/),
  ).toBeVisible();
  await other.screenshot({ path: test.info().outputPath("computer-second-device.png") });
  await other.close();
  ui.leaving();
  await page.reload();
  await expect(
    notices(page).getByText(/Step 3 of 6 · Saving what's on your computer/),
  ).toBeVisible();
  const sheet = (await openUpdates(page)).sheet;
  await expect(sheet.getByText("Updating…", { exact: true })).toBeVisible();
  await expect(stepNow(page)).toHaveText("Keep your apps and files");
  // It fails while a page that wasn't the one pressing it is watching: it is told all the same.
  await steps(page, fixture.origin, {
    fail: "keep",
    message: "Your computer couldn't be updated. It's back as it was, and your files are kept.",
    at: "2000",
  });
  await expect(notices(page).getByText("Your computer wasn't updated")).toBeVisible();
});

test("what a computer update says stays readable in every appearance", async ({ page, ui }) => {
  const fixture = await ui.open("ready");
  await offer(page, fixture.origin);
  const sheet = await pressUpdate(page);
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
  await steps(page, fixture.origin, { stage: "keep", detail: "Saving what's on your computer" });
  await expect(stepNow(page)).toHaveText("Keep your apps and files");
  await read("keep");
  await steps(page, fixture.origin, {
    fail: "keep",
    message: "Your computer couldn't be updated. It's back as it was, and your files are kept.",
  });
  await expect(sheet.getByText("Your computer wasn't updated", { exact: true })).toBeVisible();
  await read("failed");
});
