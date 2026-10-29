import { SessionIndexPage } from "@localdot/protocol";
import type { Page } from "@playwright/test";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

// Replay's library with four months of recordings, long titles and a long localDot name: nothing
// overlaps or wraps at any width, with the chat panel shown or hidden, and space is freed only
// after a confirmation that says what goes.
runAt("c14", "c12", "c39", "w14", "w39");

const DAY = 86_400_000;
// Where the fixture's wall clock starts: the library seeds its ages from here.
const FIXTURE_START = Date.parse("2026-10-08T09:00:00.000Z");

async function library(page: Page, origin: string) {
  const listed = await page.request.get(`${origin}/api/session-index?limit=100`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return SessionIndexPage.parse(await listed.json()).sessions;
}

async function layout(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    const lines = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((element) => element.offsetParent !== null)
        .map((element) => {
          const height = element.getBoundingClientRect().height;
          const line = Number.parseFloat(getComputedStyle(element).lineHeight);
          return Math.round(height / line);
        });
    const brand = box(".bar-brand");
    const modes = box(".bar-modes");
    return {
      overlap: !!brand && !!modes && brand.right > modes.left,
      library: box(".replay-library")?.width ?? 0,
      rail: box(".replay-rail")?.width ?? 0,
      head: box(".replay-library-head")?.height ?? 0,
      bar: box(".replay-library-bar")?.height ?? 0,
      titles: Math.max(...lines(".ui-list-row-title")),
      metas: Math.max(...lines(".ui-list-row-meta")),
      totals: Math.max(...lines(".replay-library-total")),
      scrolls: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

for (const chat of [true, false])
  test(`the library keeps every line whole with the chat ${chat ? "shown" : "hidden"}`, async ({
    page,
    ui,
  }) => {
    await page.addInitScript((shown) => {
      localStorage.setItem(
        "localdot.panels.v1",
        JSON.stringify({ chat: shown, activity: true, view: "chat" }),
      );
    }, chat);
    await ui.open("library", () => "/?replay=library");
    await expect(page.getByRole("button", { name: /^Compare the home insurance/ })).toBeVisible();
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath("library.png") });
    const shape = await layout(page);
    expect(shape.overlap).toBe(false);
    expect(shape.scrolls).toBe(false);
    expect(shape.head).toBeLessThanOrEqual(52);
    expect(shape.bar).toBeLessThanOrEqual(isPhone(page) ? 48 : 40);
    expect([shape.titles, shape.metas, shape.totals]).toEqual([1, 1, 1]);
    const width = page.viewportSize()?.width ?? 0;
    if (width >= 1100) {
      expect(shape.rail).toBe(368);
      expect(shape.library).toBeGreaterThan(width / 2);
    }
    if (!isPhone(page))
      await expect(page.locator(".bar-brand-name")).toHaveAttribute(
        "title",
        "Studio workstation upstairs",
      );
  });

test("deletes the picked recordings once confirmed", async ({ page, ui }) => {
  const { origin } = await ui.open("library", () => "/?replay=library");
  const before = await library(page, origin);
  const tidy = before.find((card) => card.title === "Tidy the Downloads folder");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const first = page.getByRole("button", { name: "Tidy the Downloads folder" }).first();
  const last = page.getByRole("button", { name: /^Research standing desks/ }).first();
  await first.click();
  await last.click({ modifiers: ["Shift"] });
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(last).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Delete…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete 2 recordings?" });
  await expect(confirm).toContainText("messages and saved files are removed from this Mac");
  await expect(confirm).toContainText("Frees");
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("confirm.png") });
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.locator(".replay-library-bar")).toContainText("Deleted 2 recordings · freed");
  const after = await library(page, origin);
  expect(before.length - after.length).toBe(2);
  expect(after.map((card) => card.id)).not.toContain(tidy?.id);
  expect(after.some((card) => card.verdict === "live")).toBe(true);
});

test("Free up space deletes what it counted, and never a running task", async ({ page, ui }) => {
  const { origin } = await ui.open("library", () => "/?replay=library");
  await page.getByRole("button", { name: "Free up space" }).click();
  const choice = page.getByRole("menuitem", { name: /^Older than 30 days/ });
  const old = (await library(page, origin)).filter(
    (card) => FIXTURE_START - Date.parse(card.startedAt) > 30 * DAY,
  );
  await expect(choice).toContainText(`${old.length} recordings`);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("free-up-space.png") });
  await choice.click();
  const confirm = page.getByRole("alertdialog", {
    name: `Delete ${old.length} recordings older than 30 days?`,
  });
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirm).toBeHidden();
  const after = await library(page, origin);
  expect(after.filter((card) => old.some((gone) => gone.id === card.id))).toEqual([]);
  expect(after.some((card) => card.verdict === "live")).toBe(true);
  await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible();
});
