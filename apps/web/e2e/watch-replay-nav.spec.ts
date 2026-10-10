import { type Browser, expect, type Page, test, webkit } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";
import { reach } from "./reach.ts";

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

const modes = (page: Page) => page.getByRole("radiogroup", { name: "Mode" });
const library = (page: Page) => page.getByRole("main", { name: "Replay" });

// A recording from the library: chosen into the rail beside the list, then played.
async function pickTask(page: Page, title: string) {
  await library(page)
    .getByRole("button", { name: new RegExp(`^${title}`) })
    .click();
  await page
    .getByRole("complementary", { name: "Chosen recording" })
    .getByRole("button", { name: "Watch replay" })
    .click();
}

// The 44 px touch target may extend past the visible segment, so probe the hit area itself.
async function hitHeight(page: Page, name: string) {
  return modes(page)
    .getByRole("radio", { name, exact: true })
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

for (const engine of ["chrome", "webkit"] as const satisfies Engine[]) {
  // A phone has no top bar: Replay is in More, and the library leads back to Watch.
  test(`Watch and Replay stay reachable on a 390 px ${engine} phone`, async ({ browser }) => {
    const owned = engine === "webkit" ? await webkit.launch({ channel: undefined }) : null;
    const page = await phonePage(owned ?? browser, 390);
    try {
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      await expect(modes(page)).toHaveCount(0);
      await page.getByRole("button", { name: "More", exact: true }).tap();
      const replay = page.getByRole("menuitem", { name: "Replay", exact: true });
      await expect(replay).toBeEnabled();
      // Measured once the menu has grown to its size.
      await expect
        .poll(async () => (await replay.boundingBox())?.height ?? 0)
        .toBeGreaterThanOrEqual(44);
      await replay.tap();
      await expect(page).toHaveURL(/[?&]replay=library/);
      const watch = page
        .getByRole("navigation", { name: "Replay" })
        .getByRole("button", { name: "Watch" });
      await expect(watch).toBeVisible();
      expect(await watch.evaluate(reach)).toEqual({ width: 44, height: 44 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await watch.tap();
      await expect(page).not.toHaveURL(/[?&]replay=/);
      await expect(library(page)).toHaveCount(0);
    } finally {
      await page.context().close();
      await owned?.close();
    }
  });

  // Wider than a phone, a touch screen keeps the top bar's Watch and Replay.
  test(`Watch and Replay stay reachable on a 759 px ${engine} touch screen`, async ({
    browser,
  }) => {
    const owned = engine === "webkit" ? await webkit.launch({ channel: undefined }) : null;
    const page = await phonePage(owned ?? browser, 759);
    try {
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      const watch = modes(page).getByRole("radio", { name: "Watch", exact: true });
      const replay = modes(page).getByRole("radio", { name: "Replay", exact: true });
      await expect(watch).toBeVisible();
      await expect(replay).toBeEnabled();
      await expect(replay).toBeVisible();
      expect(await hitHeight(page, "Watch")).toBeGreaterThanOrEqual(44);
      expect(await hitHeight(page, "Replay")).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await replay.tap();
      await expect(page).toHaveURL(/[?&]replay=/);
      await expect(replay).toHaveAttribute("aria-checked", "true");
      await watch.tap();
      await expect(page).not.toHaveURL(/[?&]replay=/);
      await expect(watch).toHaveAttribute("aria-checked", "true");
    } finally {
      await page.context().close();
      await owned?.close();
    }
  });
}

test("browser Back from a recording goes up to the library, then to Watch", async ({ page }) => {
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  const watch = modes(page).getByRole("radio", { name: "Watch", exact: true });
  await expect(watch).toHaveAttribute("aria-checked", "true");
  await modes(page).getByRole("radio", { name: "Replay", exact: true }).click();
  await expect(page).toHaveURL(/[?&]replay=library/);
  const older = fixture.seeded[1] as string;
  await pickTask(page, "Earlier sample task 1");
  await expect(page).toHaveURL(new RegExp(`replay=${older}`));
  await page.goBack();
  await expect(page).toHaveURL(/[?&]replay=library/);
  await page.goBack();
  await expect(page).toHaveURL(`${fixture.origin}/`);
  await expect(watch).toHaveAttribute("aria-checked", "true");
  await expect(library(page)).toHaveCount(0);
  await page.goForward();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`replay=${older}`));
});

test("Replay hides the live task's Pause and Stop", async ({ page }) => {
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(pause).toBeVisible();
  await expect(stop).toBeVisible();
  await modes(page).getByRole("radio", { name: "Replay", exact: true }).click();
  await expect(library(page)).toBeVisible();
  await expect(pause).toHaveCount(0);
  await expect(stop).toHaveCount(0);
});

for (const engine of ["chrome", "webkit"] as const satisfies Engine[])
  test(`a ${engine} phone shows Pause and Stop without keyboard shortcuts`, async ({ browser }) => {
    const owned = engine === "webkit" ? await webkit.launch({ channel: undefined }) : null;
    const page = await phonePage(owned ?? browser, 390);
    try {
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      const island = page.locator(".island");
      await expect(island.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      await expect(island.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expect(page.getByText(/Ctrl|Cmd|⌘/)).toHaveCount(0);
    } finally {
      await page.context().close();
      await owned?.close();
    }
  });

test("a task gone quiet makes dot say so once you are back in Watch", async ({ page }) => {
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await modes(page).getByRole("radio", { name: "Replay", exact: true }).click();
  await expect(library(page)).toBeVisible();
  await page.request.post(`${fixture.origin}/__qa/heartbeat`);
  await modes(page).getByRole("radio", { name: "Watch", exact: true }).click();
  await expect(
    page.getByText("This is taking longer than usual. Stop me if it looks stuck."),
  ).toBeVisible();
});

// Runs last: it deletes a seeded recording the earlier tests open.
test("browser Back and Forward never reopen a deleted recording", async ({ page }) => {
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  const replay = modes(page).getByRole("radio", { name: "Replay", exact: true });
  await expect(replay).toBeEnabled();
  const older = fixture.seeded[1] as string;
  await replay.click();
  await pickTask(page, "Earlier sample task 1");
  await expect(page).toHaveURL(new RegExp(`replay=${older}`));
  await page.goBack();
  await expect(page).toHaveURL(/[?&]replay=library/);
  const row = library(page).getByRole("button", { name: /^Earlier sample task 1/ });
  await expect(row).toBeVisible();
  await library(page).getByRole("button", { name: "Delete Earlier sample task 1" }).click();
  await page
    .getByRole("alertdialog", { name: "Delete this recording?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  // Its entry shows the library instead.
  await page.goForward();
  await expect(page).toHaveURL(/[?&]replay=library/);
  expect(page.url()).not.toContain(older);
  await page.goBack();
  expect(page.url()).not.toContain(older);
});
