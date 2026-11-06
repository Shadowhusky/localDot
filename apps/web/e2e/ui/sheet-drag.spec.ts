import type { Locator, Page } from "@playwright/test";
import { PANEL_NAME } from "../../src/shell/panel-name.ts";
import { expect, type Harness, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test.use({
  reducedMotion: "no-preference",
  video: { mode: "on", size: { width: 390, height: 844 } },
});

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("Missing geometry");
  return found;
}

async function settled(locator: Locator) {
  await locator.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => null)),
    ),
  );
}

// A press at (x, y) that moves and lifts: a finger in Chromium, the mouse in WebKit, whose touch
// emulation sends no moves. Moves are a frame apart unless flung; a still lift carries no speed.
async function grab(page: Page, touch: boolean, x: number, y: number) {
  const cdp = touch ? await page.context().newCDPSession(page) : null;
  if (cdp)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  else {
    await page.mouse.move(x, y);
    await page.mouse.down();
  }
  let at = y;
  return {
    async move(to: number, { steps = 10, fling = false } = {}) {
      const from = at;
      for (let step = 1; step <= steps; step++) {
        const now = from + ((to - from) * step) / steps;
        if (cdp)
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: now }],
          });
        else await page.mouse.move(x, now);
        if (!fling) await page.waitForTimeout(16);
      }
      at = to;
    },
    async lift({ still = true } = {}) {
      if (still) await page.waitForTimeout(120);
      if (cdp) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();
      } else await page.mouse.up();
    },
  };
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test("the Activity sheet rises when its header is dragged off-centre", async ({
  page,
  ui,
  browserName,
}) => {
  await ui.open("done");
  await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: PANEL_NAME });
  await expect(sheet).toHaveAttribute("data-detent", "medium");
  await settled(sheet);
  await shot(page, "activity-medium");
  // Beside the title, well clear of Done.
  const header = await box(sheet.locator(".ui-sheet-header"));
  const press = await grab(page, browserName === "chromium", header.x + 28, header.y + 30);
  await press.move(header.y - 150);
  await shot(page, "activity-header-drag");
  await press.lift();
  await expect(sheet).toHaveAttribute("data-detent", "large");
  await settled(sheet);
  await shot(page, "activity-large");
  // Done in the header stays a button.
  await sheet
    .locator(".ui-sheet-header")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(sheet).toBeHidden();
});

// How far the sheet and the steps have moved, frame by frame, for what a gesture leaves behind.
async function watch(sheet: Locator, pane: Locator) {
  const sheetTop = () => sheet.evaluate((node) => node.getBoundingClientRect().top);
  const scrolled = () => pane.evaluate((node) => node.scrollTop);
  return { sheetTop, scrolled };
}

async function openWorkspace(page: Page, ui: Harness, steps = 40) {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/steps?n=${steps}`);
  await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: PANEL_NAME });
  await expect(sheet).toHaveAttribute("data-detent", "medium");
  await settled(sheet);
  const pane = sheet.locator('[role="tabpanel"]:not([aria-hidden]) .activity-scroll');
  return { sheet, pane, ...(await watch(sheet, pane)) };
}

test("at partial height a swipe on the content scrolls it, and never moves the sheet", async ({
  page,
  ui,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Playwright's WebKit sends no touch moves");
  const { sheet, pane, sheetTop, scrolled } = await openWorkspace(page, ui);
  await pane.evaluate((node) => {
    node.scrollTop = 400;
  });
  const rest = await sheetTop();
  const list = await box(pane);
  // Up: the steps go on, the sheet stays.
  let press = await grab(page, true, list.x + 60, list.y + 140);
  await press.move(list.y + 20);
  expect(await sheetTop()).toBe(rest);
  await press.lift();
  await expect.poll(scrolled).toBeGreaterThan(450);
  await expect(sheet).toHaveAttribute("data-detent", "medium");
  // Down, with steps above: they come back, the sheet stays.
  const before = await scrolled();
  press = await grab(page, true, list.x + 60, list.y + 20);
  await press.move(list.y + 140);
  expect(await sheetTop()).toBe(rest);
  await press.lift();
  await expect.poll(scrolled).toBeLessThan(before);
  await expect(sheet).toHaveAttribute("data-detent", "medium");
  expect(await sheetTop()).toBe(rest);
});

test("a pull past the top of the content takes the sheet down, in one gesture", async ({
  page,
  ui,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Playwright's WebKit sends no touch moves");
  const { sheet, pane, sheetTop, scrolled } = await openWorkspace(page, ui);
  await pane.evaluate((node) => {
    node.scrollTop = 60;
  });
  const rest = await sheetTop();
  const list = await box(pane);
  const press = await grab(page, true, list.x + 60, list.y + 20);
  await press.move(list.y + 50, { steps: 6 });
  expect(await sheetTop(), "the steps still have room").toBe(rest);
  await press.move(list.y + 220, { steps: 24 });
  await shot(page, "pull-past-top");
  await expect.poll(scrolled).toBe(0);
  await expect.poll(sheetTop).toBeGreaterThan(rest + 60);
  // Back up, it goes home again and no further.
  await press.move(list.y - 40, { steps: 24 });
  await expect.poll(sheetTop).toBe(rest);
  await press.move(list.y + 200, { steps: 24 });
  await expect.poll(sheetTop).toBeGreaterThan(rest + 60);
  await press.lift();
  await expect(sheet).toHaveAttribute("data-detent", "medium");
  await expect.poll(sheetTop).toBe(rest);
  // The steps are free to scroll again.
  expect(await pane.evaluate((node) => getComputedStyle(node).overflowY)).toBe("auto");
});

test("pulled from the content's top at full height, the sheet comes down and goes no higher", async ({
  page,
  ui,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Playwright's WebKit sends no touch moves");
  const { sheet, pane, sheetTop } = await openWorkspace(page, ui);
  const header = await box(sheet.locator(".ui-sheet-header"));
  let press = await grab(page, true, header.x + 28, header.y + 30);
  await press.move(header.y - 150);
  await press.lift();
  await expect(sheet).toHaveAttribute("data-detent", "large");
  await settled(sheet);
  await pane.evaluate((node) => {
    node.scrollTop = 0;
  });
  const top = await sheetTop();
  const list = await box(pane);
  press = await grab(page, true, list.x + 60, list.y + 40);
  await press.move(list.y + 190);
  expect(await sheetTop()).toBeGreaterThan(top + 100);
  await press.move(list.y - 60);
  expect(await sheetTop()).toBe(top);
  await press.move(list.y + 190);
  await press.lift();
  await expect(sheet).toHaveAttribute("data-detent", "medium");
  await expect(sheet).toBeVisible();
});

test("at partial height the content reaches its end above the screen's edge", async ({
  page,
  ui,
}) => {
  const { sheet, pane } = await openWorkspace(page, ui);
  await pane.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const screen = page.viewportSize()?.height ?? 0;
  const end = await pane.evaluate((node) => node.getBoundingClientRect().bottom);
  expect(end).toBeLessThanOrEqual(screen);
  // Each page of it, not only the first.
  for (const name of [/^Files/, /^Agents/, /^Previews/]) {
    await sheet.getByRole("tab", { name }).click();
    await settled(sheet);
    const shown = sheet.locator('[role="tabpanel"]:not([aria-hidden])').first();
    expect((await box(shown)).y + (await box(shown)).height).toBeLessThanOrEqual(screen);
  }
  // Raised, it has the room back.
  const header = await box(sheet.locator(".ui-sheet-header"));
  const press = await grab(page, test.info().project.name === "c39", header.x + 28, header.y + 30);
  await press.move(header.y - 150);
  await press.lift();
  await expect(sheet).toHaveAttribute("data-detent", "large");
  await settled(sheet);
  const raised = sheet.locator('[role="tabpanel"]:not([aria-hidden])').first();
  const area = await box(raised);
  expect(area.y + area.height).toBeLessThanOrEqual(screen);
  expect(area.y + area.height).toBeGreaterThan(screen - 80);
});

test("raising a sheet by its header lets the content take the room as it rises, with nothing left under it", async ({
  page,
  ui,
  browserName,
}) => {
  const { sheet, pane } = await openWorkspace(page, ui);
  const header = await box(sheet.locator(".ui-sheet-header"));
  const screen = page.viewportSize()?.height ?? 0;
  const press = await grab(page, browserName === "chromium", header.x + 28, header.y + 30);
  await press.move(header.y - 90);
  const area = await box(pane);
  // Dragged part of the way, the content still ends at the edge of the screen, not above it.
  expect(area.y + area.height).toBeGreaterThan(screen - 120);
  await press.lift();
  await expect(sheet).toBeVisible();
});

test("content with nothing to scroll may still move the sheet", async ({
  page,
  ui,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Playwright's WebKit sends no touch moves");
  const { sheet } = await openWorkspace(page, ui, 0);
  await sheet.getByRole("tab", { name: /^Previews/ }).click();
  await settled(sheet);
  const shown = sheet.locator('[role="tabpanel"]:not([aria-hidden])').first();
  const area = await box(shown);
  const press = await grab(page, true, area.x + 60, area.y + 120);
  await press.move(area.y - 120);
  await press.lift();
  await expect(sheet).toHaveAttribute("data-detent", "large");
});

test("a question rises by the line under its grabber, and a flick down settles it collapsed", async ({
  page,
  ui,
  browserName,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/ask?fields=servicekey`);
  const sheet = page.locator(".decision-sheet");
  await expect(sheet).toBeVisible();
  await settled(sheet);
  await shot(page, "question-collapsed");
  const touch = browserName === "chromium";
  // Off-centre on the line under the grabber, not the grabber itself.
  let head = await box(sheet.locator(".decision-sheet-head"));
  let press = await grab(page, touch, head.x + 24, head.y + head.height / 2);
  await press.move(80);
  await press.lift();
  await expect(sheet).toHaveAttribute("data-expanded", "");
  await settled(sheet);
  await shot(page, "question-expanded");
  // A question cannot be swiped away: a firm flick lands at the nearest height, collapsed.
  head = await box(sheet.locator(".decision-sheet-head"));
  press = await grab(page, touch, head.x + 24, head.y + head.height / 2);
  await press.move(head.y + 300, { steps: 4, fling: true });
  await press.lift({ still: false });
  await expect(sheet).not.toHaveAttribute("data-expanded");
  await settled(sheet);
  await expect(sheet).toBeVisible();
  await shot(page, "question-flicked");
});

test("a question keeps a drag through Safari's toolbars resizing the viewport", async ({
  page,
  ui,
  browserName,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/ask?fields=servicekey`);
  const sheet = page.locator(".decision-sheet");
  await expect(sheet).toBeVisible();
  await settled(sheet);
  const head = await box(sheet.locator(".decision-sheet-head"));
  const start = (await box(sheet)).y;
  const press = await grab(page, browserName === "chromium", head.x + 24, head.y + 10);
  await press.move(head.y + 10 - 100);
  // The toolbars collapsing take 60 px from the visual viewport: no keyboard.
  await page.evaluate(() => {
    const view = window.visualViewport;
    if (!view) throw new Error("Missing viewport");
    Object.defineProperty(view, "height", { configurable: true, value: innerHeight - 60 });
    view.dispatchEvent(new Event("resize"));
  });
  await press.move(head.y + 10 - 200);
  await expect.poll(async () => Math.abs((await box(sheet)).y - (start - 200))).toBeLessThan(3);
  await expect(sheet).not.toHaveAttribute("data-keyboard");
  await press.lift();
  await expect(sheet).toHaveAttribute("data-expanded", "");
});

test("a finger raises a collapsed question by content with nothing to scroll", async ({
  page,
  ui,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Playwright's WebKit sends no touch moves");
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/ask?fields=pin`);
  const sheet = page.locator(".decision-sheet");
  await expect(sheet).toBeVisible();
  await settled(sheet);
  const content = sheet.locator(".decision-sheet-content");
  expect(await content.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(false);
  const area = await box(content);
  const press = await grab(page, true, area.x + area.width - 60, area.y + 60);
  await press.move(area.y + 60 - 220);
  await press.lift();
  await expect(sheet).toHaveAttribute("data-expanded", "");
  expect(await content.evaluate((node) => node.scrollTop)).toBe(0);
});

test.describe("every sheet on a phone", () => {
  test.use({ viewStyle: "chat", phoneList: true });

  const fromPill = (name: string) => async (page: Page) => {
    await page.getByRole("button", { name: /this computer and app settings$/ }).click();
    await page.getByRole("menuitem", { name }).click();
  };
  const fromConversation = (open: (page: Page) => Promise<void>) => async (page: Page) => {
    await page.locator(".phone-row").first().click();
    await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "1");
    await page.waitForTimeout(600);
    await open(page);
  };
  const SHEETS: [string, (page: Page) => Promise<void>][] = [
    ["Settings", fromPill("Settings")],
    ["Keys", fromPill("Keys")],
    ["Routines", fromPill("Routines")],
    [
      "Details",
      fromConversation((page) =>
        page.getByRole("button", { name: /Conversation details$/ }).click(),
      ),
    ],
  ];

  const modelMenu = fromConversation(async (page) => {
    await page.getByRole("button", { name: "More", exact: true }).first().click();
    await page.getByRole("menuitem", { name: /^Model:/ }).click();
  });
  SHEETS.push([
    "Models",
    async (page) => {
      await modelMenu(page);
      await page.getByRole("button", { name: /^Manage models/ }).click();
    },
  ]);

  test("the list of models scrolls under the finger, and its sheet stays", async ({
    page,
    ui,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "Playwright's WebKit sends no touch moves");
    await page.setViewportSize({ width: 390, height: 560 });
    await ui.open("running");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    await modelMenu(page);
    await page.getByRole("combobox", { name: "Model", exact: true }).click();
    const list = page.locator(".ui-picker-sheet").last();
    await expect(list).toBeVisible();
    await settled(list);
    await shot(page, "models-list");
    const top = await list.evaluate((node) => node.getBoundingClientRect().top);
    const area = await box(list.getByRole("listbox"));
    const press = await grab(page, true, area.x + 40, area.y + area.height - 20);
    await press.move(area.y + 20);
    expect(await list.evaluate((node) => node.getBoundingClientRect().top)).toBe(top);
    await press.lift();
  });

  for (const [name, open] of SHEETS)
    test(`${name}: a swipe scrolls what can scroll, and the end of it can be reached`, async ({
      page,
      ui,
      browserName,
    }) => {
      test.skip(browserName !== "chromium", "Playwright's WebKit sends no touch moves");
      await page.setViewportSize({ width: 390, height: 560 });
      await ui.open("running");
      await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
      await open(page);
      const sheet = page.locator('.ui-sheet[data-side="bottom"]').last();
      await expect(sheet).toBeVisible();
      await settled(sheet);
      await shot(page, `${name}-rest`);
      const sheetTop = () => sheet.evaluate((node) => node.getBoundingClientRect().top);
      const rest = await sheetTop();
      const body = sheet.locator(".ui-sheet-page:not([data-held]) .ui-sheet-body").first();
      const area = await box(body);
      const scrolls = await body.evaluate((node) => node.scrollHeight > node.clientHeight + 1);
      const screen = page.viewportSize()?.height ?? 0;
      if (scrolls) {
        const press = await grab(page, true, area.x + 8, area.y + area.height - 12);
        await press.move(area.y + 12);
        expect(await sheetTop(), "a swipe up leaves the sheet where it is").toBe(rest);
        await press.lift();
        await expect
          .poll(() => body.evaluate((node) => node.scrollTop), "a swipe up scrolls")
          .toBeGreaterThan(0);
        await body.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        const end = await body.evaluate((node) => {
          const last = node.lastElementChild?.getBoundingClientRect();
          return last?.bottom ?? 0;
        });
        expect(end, "its end is on the screen").toBeLessThanOrEqual(screen);
        await shot(page, `${name}-end`);
        await body.evaluate((node) => {
          node.scrollTop = 0;
        });
      }
      const press = await grab(page, true, area.x + 8, area.y + 12);
      await press.move(area.y + 92);
      expect(await sheetTop(), "a pull at the top takes the sheet").toBeGreaterThan(rest + 40);
      await press.move(area.y + 12);
      await press.lift();
      await expect.poll(sheetTop).toBe(rest);
    });
});
