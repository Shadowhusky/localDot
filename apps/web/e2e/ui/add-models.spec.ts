import type { Locator, Page } from "@playwright/test";
import { openSettings } from "../settings-ui.ts";
import { expect, finger, type Harness, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

// The page as it stands in light and dark, for looking at.
async function shots(page: Page, ui: Harness, name: string) {
  for (const appearance of ["daylight", "graphite"]) {
    await page.evaluate((shown) => {
      document.documentElement.dataset.appearance = shown;
    }, appearance);
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath(`${name}-${appearance}.png`) });
  }
}

async function addModels(page: Page): Promise<Locator> {
  const settings = await openSettings(page, undefined, "Models");
  const section = settings.getByRole("region", { name: "Your models" });
  await section.getByRole("button", { name: "Add models" }).click();
  const sheet = page.getByRole("dialog", { name: "Add models" });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function chooseFrom(page: Page, sheet: Locator, name: string | RegExp) {
  await sheet.getByRole("combobox", { name: "From" }).click();
  await page.getByRole("option", { name }).click();
}

// Whether all of `row` shows inside what scrolls it.
async function shownIn(row: Locator, scroller: Locator) {
  const [r, s] = await Promise.all([row.boundingBox(), scroller.boundingBox()]);
  return !!r && !!s && r.y >= s.y - 1 && r.y + r.height <= s.y + s.height + 1;
}

// Wheels on a desktop; on Chromium's phone a finger drags the list up, as a thumb does. Playwright's
// phone WebKit has neither a wheel nor touch moves, so there the keyboard reaches the row instead.
async function scrollTo(page: Page, row: Locator, scroller: Locator) {
  const project = test.info().project.name;
  if (project === "w39") {
    await row.getByRole("checkbox").focus();
    return;
  }
  const box = await scroller.boundingBox();
  if (!box) throw new Error("Nothing scrolls");
  const x = box.x + box.width / 2;
  const touch = project === "c39" ? await finger(page) : null;
  if (!touch) await page.mouse.move(x, box.y + box.height / 2);
  for (let turn = 0; turn < 30 && !(await shownIn(row, scroller)); turn++) {
    if (touch) await touch.drag(x, box.y + box.height * 0.8, x, box.y + box.height * 0.3);
    else await page.mouse.wheel(0, 300);
    await page.waitForTimeout(60);
  }
}

test("a long list of models flows in the sheet, which scrolls to its last model", async ({
  page,
  ui,
}) => {
  const { origin } = await ui.open("ready");
  await page.request.post(`${origin}/__qa/own-endpoint?models=40`);
  const sheet = await addModels(page);
  await chooseFrom(page, sheet, /relay\.example/);
  const list = sheet.getByRole("group", { name: "Models", exact: true });
  await expect(list.getByRole("checkbox")).toHaveCount(40);
  const body = sheet.locator(".ui-sheet-body");
  await shots(page, ui, "long-list-top");

  // One scroller: the list has nothing hidden of its own, and runs on past the bottom of the sheet
  // rather than stopping short over an empty half.
  expect(await list.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(
    1,
  );
  const [listBox, bodyBox] = await Promise.all([list.boundingBox(), body.boundingBox()]);
  expect((listBox?.y ?? 0) + (listBox?.height ?? 0)).toBeGreaterThan(
    (bodyBox?.y ?? 0) + (bodyBox?.height ?? 0),
  );

  const last = list.locator("label", { hasText: "relay-model-40" });
  await scrollTo(page, last, body);
  expect(await shownIn(last, body), "the last model scrolled into view").toBe(true);
  // Search stays in reach at the top of what scrolls.
  const search = sheet.getByRole("textbox", { name: "Search", exact: true });
  expect(await shownIn(search, body), "Search stays at the top").toBe(true);
  await shots(page, ui, "long-list-end");
  await last.click();
  await expect(last.getByRole("checkbox")).toBeChecked();
});
