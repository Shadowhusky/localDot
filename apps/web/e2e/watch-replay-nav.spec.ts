import { type Browser, expect, type Page, test, webkit } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";

type Engine = "chrome" | "webkit";

async function phonePage(browser: Browser, width: number) {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  return context.newPage();
}

const modes = (page: Page) => page.getByRole("navigation", { name: "Mode" });

async function pickTask(page: Page, title: string) {
  await page.getByRole("button", { name: /^All tasks/ }).click();
  await page
    .getByRole("dialog", { name: "Tasks" })
    .getByRole("link", { name: new RegExp(`^${title}`) })
    .click();
}

// The 44 px touch target may extend past the visible segment, so probe the hit area itself.
async function hitHeight(page: Page, name: string) {
  return modes(page)
    .getByRole("button", { name, exact: true })
    .evaluate((button) => {
      const box = button.getBoundingClientRect();
      const x = box.left + box.width / 2;
      let top = box.top + box.height / 2;
      while (top > 0 && button.contains(document.elementFromPoint(x, top - 1))) top--;
      let bottom = box.top + box.height / 2;
      while (button.contains(document.elementFromPoint(x, bottom + 1))) bottom++;
      return bottom - top + 1;
    });
}

let fixture: UiFixture;
test.beforeAll(async () => {
  fixture = await startUiFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});
test.setTimeout(90_000);

for (const engine of ["chrome", "webkit"] as const satisfies Engine[])
  for (const width of [390, 759])
    test(`Watch and Replay stay reachable on a ${width} px ${engine} phone`, async ({
      browser,
    }) => {
      const owned = engine === "webkit" ? await webkit.launch({ channel: undefined }) : null;
      const page = await phonePage(owned ?? browser, width);
      try {
        await page.goto(`${fixture.origin}/#token=${TOKEN}`);
        const watch = modes(page).getByRole("button", { name: "Watch", exact: true });
        const replay = modes(page).getByRole("button", { name: "Replay", exact: true });
        await expect(watch).toBeVisible();
        await expect(replay).toBeEnabled();
        await expect(replay).toBeVisible();
        await expect(modes(page).getByText("Glance")).toHaveCount(0);
        expect(await hitHeight(page, "Watch")).toBeGreaterThanOrEqual(44);
        expect(await hitHeight(page, "Replay")).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await replay.tap();
        await expect(page).toHaveURL(/[?&]replay=/);
        await expect(replay).toHaveAttribute("aria-current", "page");
        await watch.tap();
        await expect(page).not.toHaveURL(/[?&]replay=/);
        await expect(watch).toHaveAttribute("aria-current", "page");
      } finally {
        await page.context().close();
        await owned?.close();
      }
    });

test("browser Back from Replay returns to Watch", async ({ page }) => {
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  const watch = modes(page).getByRole("button", { name: "Watch", exact: true });
  await expect(watch).toHaveAttribute("aria-current", "page");
  await modes(page).getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page).toHaveURL(/[?&]replay=/);
  const older = fixture.seeded[1] as string;
  await pickTask(page, "Earlier sample task 1");
  await expect(page).toHaveURL(new RegExp(`replay=${older}`));
  await page.goBack();
  await expect(page).toHaveURL(`${fixture.origin}/`);
  await expect(watch).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("main", { name: "Replay" })).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`replay=${older}`));
});

test("Replay hides the live task's Pause and Stop shortcut", async ({ page }) => {
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  const pause = page.getByRole("button", { name: "Pause after this step" });
  const hint = page.getByText("Stop: Ctrl/Cmd + Shift + .");
  await expect(pause).toBeVisible();
  await expect(hint).toBeVisible();
  await modes(page).getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByRole("main", { name: "Replay" })).toBeVisible();
  await expect(pause).toHaveCount(0);
  await expect(hint).toHaveCount(0);
});

for (const engine of ["chrome", "webkit"] as const satisfies Engine[])
  test(`a ${engine} phone shows Pause without the keyboard shortcut`, async ({ browser }) => {
    const owned = engine === "webkit" ? await webkit.launch({ channel: undefined }) : null;
    const page = await phonePage(owned ?? browser, 390);
    try {
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      await expect(page.getByRole("button", { name: "Pause after this step" })).toBeVisible();
      await expect(page.getByText("Stop: Ctrl/Cmd + Shift + .")).toBeHidden();
    } finally {
      await page.context().close();
      await owned?.close();
    }
  });

test("a task gone quiet makes dot say so once you are back in Watch", async ({ page }) => {
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await modes(page).getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByRole("main", { name: "Replay" })).toBeVisible();
  await page.request.post(`${fixture.origin}/__qa/heartbeat`);
  await modes(page).getByRole("button", { name: "Watch", exact: true }).click();
  await expect(
    page.getByText("This is taking longer than usual. Stop me if it looks stuck."),
  ).toBeVisible();
});

// Runs last: it deletes a seeded recording the earlier tests open.
test("browser Back never reopens a deleted recording", async ({ page }) => {
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  const watch = modes(page).getByRole("button", { name: "Watch", exact: true });
  const replay = modes(page).getByRole("button", { name: "Replay", exact: true });
  await expect(replay).toBeEnabled();
  const entries = await page.evaluate(() => history.length);
  const older = fixture.seeded[1] as string;
  await replay.click();
  await pickTask(page, "Earlier sample task 1");
  await expect(page).toHaveURL(new RegExp(`replay=${older}`));
  await watch.click();
  await expect(page).toHaveURL(`${fixture.origin}/`);
  await replay.click();
  await expect(page).toHaveURL(/[?&]replay=/);
  expect(await page.evaluate(() => history.length)).toBe(entries + 1);
  await page.getByRole("button", { name: /^All tasks/ }).click();
  const tasks = page.getByRole("dialog", { name: "Tasks" });
  await tasks.getByRole("button", { name: "More for Earlier sample task 1" }).click();
  await page.getByRole("menuitem", { name: /^Delete recording/ }).click();
  await page
    .getByRole("alertdialog", { name: "Delete this task's recording?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(tasks.getByRole("link", { name: /^Earlier sample task 1/ })).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(`${fixture.origin}/`);
  await expect(watch).toHaveAttribute("aria-current", "page");
  await page.goBack();
  expect(page.url()).not.toContain(older);
});
