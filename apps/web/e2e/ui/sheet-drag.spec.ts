import type { Locator, Page } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

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
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
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

test("a finger raises the Activity sheet by its content, and lowers it once the steps are at their top", async ({
  page,
  ui,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Playwright's WebKit sends no touch moves");
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/steps?n=40`);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  await expect(sheet).toHaveAttribute("data-detent", "medium");
  await settled(sheet);
  const pane = sheet.locator('[role="tabpanel"]:not([aria-hidden]) .activity-scroll');
  const scrolled = () => pane.evaluate((node) => node.scrollTop);
  await expect.poll(scrolled).toBeGreaterThan(0);
  // Below its top height, a finger moving up takes the sheet up, not the steps.
  let list = await box(pane);
  let press = await grab(page, true, list.x + list.width - 48, list.y + 140);
  await press.move(list.y - 60);
  await shot(page, "activity-content-raise");
  await press.lift();
  await expect(sheet).toHaveAttribute("data-detent", "large");
  await settled(sheet);
  // At its top height, a finger moving down scrolls the steps back first...
  list = await box(pane);
  const before = await scrolled();
  press = await grab(page, true, list.x + 60, list.y + 80);
  await press.move(list.y + 280, { steps: 8 });
  await press.lift();
  await expect.poll(scrolled).toBeLessThan(before);
  await expect(sheet).toHaveAttribute("data-detent", "large");
  // ...and once they are at their top, it lowers the sheet.
  await pane.evaluate((node) => {
    node.scrollTop = 0;
  });
  press = await grab(page, true, list.x + 60, list.y + 40);
  await press.move(list.y + 190);
  await shot(page, "activity-content-lower");
  await press.lift();
  await expect(sheet).toHaveAttribute("data-detent", "medium");
  await expect(sheet).toBeVisible();
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

test("a finger raises a collapsed question by its content", async ({ page, ui, browserName }) => {
  test.skip(browserName !== "chromium", "Playwright's WebKit sends no touch moves");
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/ask?fields=servicekey`);
  const sheet = page.locator(".decision-sheet");
  await expect(sheet).toBeVisible();
  await settled(sheet);
  const content = sheet.locator(".decision-sheet-content");
  const area = await box(content);
  const press = await grab(page, true, area.x + area.width - 60, area.y + 60);
  await press.move(area.y + 60 - 220);
  await press.lift();
  await expect(sheet).toHaveAttribute("data-expanded", "");
  expect(await content.evaluate((node) => node.scrollTop)).toBe(0);
});
