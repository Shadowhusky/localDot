import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { type KitGallery, serveKitGallery } from "./kit-gallery.ts";
import { ENGINES } from "./ui-fixture.ts";

// T08's overlays in the kit gallery under the production CSP, in Chrome and WebKit, at 1440 and at
// 390 with touch. No screenshots: WebKit's inject a <style> the CSP reports.
const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};
const SAVED = "Saved: Research assistant · Anthropic";

interface Seen {
  violations: string[];
  styles: number;
}

let gallery: KitGallery;

test.use({ actionTimeout: 10_000, navigationTimeout: 10_000 });
test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  gallery = await serveKitGallery("localdot-kit-overlays");
});

test.afterAll(async () => {
  await gallery?.stop();
});

async function open(
  browser: Browser,
  device: keyof typeof DEVICES,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
): Promise<{ context: BrowserContext; page: Page; seen: () => Promise<Seen> }> {
  const context = await browser.newContext({ ...DEVICES[device], reducedMotion });
  await context.addInitScript(() => {
    const seen = { violations: [] as string[], styles: 0 };
    (window as unknown as { kitOverlays: typeof seen }).kitOverlays = seen;
    document.addEventListener("securitypolicyviolation", (event) =>
      seen.violations.push(`${event.violatedDirective} ${event.blockedURI} ${event.sample}`),
    );
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) if (node.nodeName === "STYLE") seen.styles++;
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${gallery.origin}/?page=overlays`);
  await expect(page.getByRole("heading", { name: "Overlays" })).toBeVisible();
  const seen = async () => {
    expect(errors).toEqual([]);
    return page.evaluate(() => (window as unknown as { kitOverlays: Seen }).kitOverlays);
  };
  return { context, page, seen };
}

function sheetOf(page: Page): Locator {
  return page.getByRole("dialog", { name: "Models and settings" });
}

function promptOf(page: Page): Locator {
  return page.locator(".ui-sheet-prompt[data-shown]");
}

// Every transition on the element and inside it has finished.
async function settled(locator: Locator) {
  await locator.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
}

async function top(locator: Locator): Promise<number> {
  return (await box(locator)).y;
}

// A quick downward throw from a point on the sheet's header, a frame apart per move.
async function fling(page: Page, x: number, y: number, distance: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 15);
  for (let step = 1; step <= 4; step++) {
    await page.waitForTimeout(8);
    await page.mouse.move(x, y + 15 + (distance * step) / 4);
  }
  await page.mouse.up();
}

// A point on the dim area beside the side panel, or above the bottom sheet.
function scrimPoint(device: keyof typeof DEVICES): { x: number; y: number } {
  return device === "phone" ? { x: 195, y: 16 } : { x: 120, y: 450 };
}

for (const [engine, launch] of Object.entries(ENGINES))
  for (const device of Object.keys(DEVICES) as (keyof typeof DEVICES)[])
    test.describe(`${engine} ${device}`, () => {
      const touch = device === "phone";
      let browser: Browser;
      test.beforeAll(async () => {
        browser = await launch();
      });
      test.afterAll(async () => {
        await browser?.close();
      });

      const press = (locator: Locator) => (touch ? locator.tap() : locator.click());

      async function openSheet(page: Page, label = "Open settings"): Promise<Locator> {
        await press(page.getByRole("button", { name: label }));
        const sheet = sheetOf(page);
        await expect(sheet).toBeVisible();
        await settled(sheet);
        return sheet;
      }

      test("Escape in a picker or a menu inside a sheet closes only that", async () => {
        const { context, page, seen } = await open(browser, device);
        const sheet = await openSheet(page);
        const provider = sheet.getByLabel("Provider");
        await provider.selectOption("OpenAI");
        await provider.focus();
        await page.keyboard.press("Escape");
        await expect(sheet).toBeVisible();
        await expect(promptOf(page)).toHaveCount(0);
        await expect(provider).toHaveValue("OpenAI");

        const actions = sheet.getByRole("button", { name: "Model actions" });
        await press(actions);
        const menu = page.getByRole("menu", { name: "Model actions" });
        await expect(menu).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
        await expect(sheet).toBeVisible();
        await expect(promptOf(page)).toHaveCount(0);
        await expect(actions).toBeFocused();

        // The change is still unsaved, so Escape from the sheet itself asks first.
        await page.keyboard.press("Escape");
        await expect(promptOf(page)).toBeVisible();
        await expect(provider).toHaveValue("OpenAI");
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("a sheet with unsaved changes asks before it goes, however it is dismissed", async () => {
        const { context, page, seen } = await open(browser, device);
        const sheet = await openSheet(page);
        const name = sheet.getByLabel("Name");
        await name.fill("Research assistant, faster");
        const keep = sheet.getByRole("button", { name: "Keep editing" });

        await page.keyboard.press("Escape");
        await expect(promptOf(page)).toBeVisible();
        await expect(keep).toBeFocused();
        await press(keep);
        await expect(promptOf(page)).toHaveCount(0);

        await press(sheet.getByRole("button", { name: "Close settings" }));
        await expect(promptOf(page)).toBeVisible();
        await press(keep);

        const { x, y } = scrimPoint(device);
        if (touch) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        await expect(promptOf(page)).toBeVisible();
        await expect(sheet).toBeVisible();
        await expect(name).toHaveValue("Research assistant, faster");

        await press(sheet.getByRole("button", { name: "Discard" }));
        await expect(sheet).toHaveCount(0);
        await expect(page.getByTestId("saved-auto-modal")).toHaveText(SAVED);
        await openSheet(page);
        await expect(sheetOf(page).getByLabel("Name")).toHaveValue("Research assistant");
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("a nested page slides in with a Back, and Back returns to the row and the scroll it left", async () => {
        const { context, page, seen } = await open(browser, device);
        const sheet = await openSheet(page);
        const body = page.locator(".ui-sheet-page:not([inert]) > .ui-sheet-body");
        await body.evaluate((element) => element.scrollTo(0, 60));
        const row = sheet.getByRole("button", { name: /^Keys/ });
        // From the keyboard on a desktop, so the row has focus as it opens the page.
        if (touch) await row.tap();
        else {
          await row.focus();
          await page.keyboard.press("Enter");
        }
        const keys = page.getByRole("dialog", { name: "Keys" });
        await expect(keys).toBeVisible();
        const back = keys.getByRole("button", { name: "Settings", exact: true });
        await expect(back).toBeVisible();
        if (!touch) await expect(back).toBeFocused();
        await expect(keys.getByText("Added 2 Oct")).toBeVisible();
        await settled(keys);
        // The page it came from waits underneath, out of sight and out of reach.
        await expect(page.locator(".ui-sheet-page:not([inert])")).toHaveCount(1);
        await expect(page.locator(".ui-sheet-page[data-held]")).toHaveCount(1);
        await expect(page.locator(".ui-sheet-page[data-held]")).toHaveCSS("opacity", "0");

        if (touch) await back.tap();
        else await page.keyboard.press("Enter");
        await expect(sheetOf(page)).toBeVisible();
        await settled(sheetOf(page));
        await expect(page.locator(".ui-sheet-page")).toHaveCount(1);
        expect(await body.evaluate((element) => element.scrollTop)).toBe(60);
        if (!touch) await expect(row).toBeFocused();

        // Escape from a nested page still dismisses the whole sheet.
        await press(row);
        await expect(keys).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("the dim area closes the sheet only for a press that starts and ends on it", async () => {
        const { context, page, seen } = await open(browser, device);
        const sheet = await openSheet(page);
        const row = await box(sheet.getByText("Browser"));
        const { x, y } = scrimPoint(device);
        await page.mouse.move(row.x + 4, row.y + row.height / 2);
        await page.mouse.down();
        await page.mouse.move(x, y, { steps: 4 });
        await page.mouse.up();
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(row.x + 4, row.y + row.height / 2, { steps: 4 });
        await page.mouse.up();
        await page.waitForTimeout(400);
        await expect(sheet).toBeVisible();

        if (touch) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        await expect(sheet).toHaveCount(0);
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("a menu item commits on a tap or click, and nothing under the menu is pressed", async () => {
        const { context, page, seen } = await open(browser, device);
        const trigger = page.getByRole("button", { name: "Recording actions" });
        const under = page.getByRole("button", { name: /^Pressed/ });
        await trigger.scrollIntoViewIfNeeded();
        await press(trigger);
        const menu = page.getByRole("menu", { name: "Recording actions" });
        await settled(menu);
        // Shortcuts show only where there is a keyboard to press them.
        if (touch) await expect(menu.locator(".ui-menu-kbd").first()).toBeHidden();
        else await expect(menu.locator(".ui-menu-kbd").first()).toBeVisible();
        const beneath = await box(under);
        const point = { x: beneath.x + 12, y: beneath.y + beneath.height / 2 };
        // The menu is drawn over the counter, so a press that went through would count.
        const chosen = await page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.closest<HTMLElement>("[role=menuitem]")?.dataset.label,
          point,
        );
        expect(chosen).toBeTruthy();
        if (touch) await page.touchscreen.tap(point.x, point.y);
        else await page.mouse.click(point.x, point.y);
        await expect(page.getByText(`Last choice: ${chosen}`)).toBeVisible();
        await expect(menu).toHaveCount(0);
        await page.waitForTimeout(400);
        await expect(under).toHaveText("Pressed 0 times");

        // A press on the trigger while its menu is open only closes it.
        await press(trigger);
        await expect(menu).toBeVisible();
        await settled(menu);
        const at = await box(trigger);
        if (touch) await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
        else await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
        await expect(menu).toHaveCount(0);
        await page.waitForTimeout(400);
        await expect(menu).toHaveCount(0);
        await expect(under).toHaveText("Pressed 0 times");
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("a bottom sheet follows the finger from where it was grabbed, then springs back or goes", async () => {
        const { context, page, seen } = await open(browser, device);
        const label = touch ? "Open settings" : "Open as a bottom sheet";
        let sheet = await openSheet(page, label);
        const rest = await top(sheet);
        const title = await box(sheet.getByRole("heading", { name: "Models and settings" }));
        const x = title.x + 40;
        const y = title.y + title.height / 2;

        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + 15);
        await page.mouse.move(x, y + 115, { steps: 5 });
        await expect
          .poll(async () => Math.abs((await top(sheet)) - (rest + 115)))
          .toBeLessThanOrEqual(1);
        await page.waitForTimeout(200);
        await page.mouse.up();
        await expect.poll(async () => Math.abs((await top(sheet)) - rest)).toBeLessThanOrEqual(1);
        await expect(sheet).toBeVisible();

        // Pulled up, it stretches a little and never so far that its bottom edge shows.
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y - 215, { steps: 6 });
        await expect.poll(async () => rest - (await top(sheet))).toBeGreaterThan(20);
        expect(rest - (await top(sheet))).toBeLessThan(48);
        await page.mouse.up();
        await expect.poll(async () => Math.abs((await top(sheet)) - rest)).toBeLessThanOrEqual(1);

        // With an unsaved change, a fling springs back and asks instead.
        await sheet.getByLabel("Name").fill("Research assistant, faster");
        await fling(page, x, y, 200);
        await expect(promptOf(page)).toBeVisible();
        await expect.poll(async () => Math.abs((await top(sheet)) - rest)).toBeLessThanOrEqual(1);
        await press(sheet.getByRole("button", { name: "Discard" }));
        await expect(sheet).toHaveCount(0);

        sheet = await openSheet(page, label);
        await fling(page, x, y, 200);
        await expect(sheet).toHaveCount(0);
        await expect(page.getByText(SAVED).first()).toBeVisible();
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      if (engine === "chrome" && touch)
        test("a finger drags the bottom sheet by its header, and by its content from the top", async () => {
          const { context, page, seen } = await open(browser, device);
          const sheet = await openSheet(page);
          const rest = await top(sheet);
          const cdp = await context.newCDPSession(page);
          const touchAt = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
            cdp.send("Input.dispatchTouchEvent", {
              type,
              touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
            });
          const title = await box(sheet.getByRole("heading", { name: "Models and settings" }));
          const x = title.x + 40;
          const y = title.y + title.height / 2;
          await touchAt("touchStart", x, y);
          await touchAt("touchMove", x, y + 15);
          for (const step of [40, 70, 115]) await touchAt("touchMove", x, y + step);
          await expect
            .poll(async () => Math.abs((await top(sheet)) - (rest + 115)))
            .toBeLessThanOrEqual(1);
          await page.waitForTimeout(200);
          await touchAt("touchEnd", x, y + 115);
          await expect.poll(async () => Math.abs((await top(sheet)) - rest)).toBeLessThanOrEqual(1);

          const row = await box(sheet.getByText("Files"));
          const ry = row.y + row.height / 2;
          await touchAt("touchStart", row.x + 4, ry);
          await touchAt("touchMove", row.x + 4, ry + 15);
          for (const step of [50, 90]) await touchAt("touchMove", row.x + 4, ry + step);
          await expect
            .poll(async () => Math.abs((await top(sheet)) - (rest + 90)))
            .toBeLessThanOrEqual(1);
          await page.waitForTimeout(200);
          await touchAt("touchEnd", row.x + 4, ry + 90);
          await expect.poll(async () => Math.abs((await top(sheet)) - rest)).toBeLessThanOrEqual(1);
          await expect(sheet).toBeVisible();
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        });

      if (!touch)
        test("focus stays inside a modal sheet and comes back to what opened it", async () => {
          const { context, page, seen } = await open(browser, device);
          const opener = page.getByRole("button", { name: "Open settings" });
          await opener.focus();
          await page.keyboard.press("Enter");
          const sheet = sheetOf(page);
          await expect(sheet.getByLabel("Name")).toBeFocused();
          // WebKit, like Safari, tabs only to fields unless Option is held.
          const tab = engine === "webkit" ? "Alt+Tab" : "Tab";
          for (let step = 0; step < 8; step++) {
            await page.keyboard.press(tab);
            expect(
              await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))),
            ).toBe(true);
          }
          await page.keyboard.press(`Shift+${tab}`);
          expect(
            await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))),
          ).toBe(true);
          // Escape from a focused native select belongs to it, so leave from a field.
          await sheet.getByLabel("Name").focus();
          await page.keyboard.press("Escape");
          await expect(sheet).toHaveCount(0);
          await expect(opener).toBeFocused();

          const trigger = page.getByRole("button", { name: "Recording actions" });
          await trigger.focus();
          await page.keyboard.press("Enter");
          const menu = page.getByRole("menu", { name: "Recording actions" });
          await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeFocused();
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("Enter");
          await expect(page.getByText("Last choice: Duplicate")).toBeVisible();
          await expect(trigger).toBeFocused();
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        });

      test("a modal sheet holds the page still without a style element", async () => {
        const { context, page, seen } = await open(browser, device);
        await page.evaluate(() => window.scrollTo(0, 120));
        const before = await page.evaluate(() => window.scrollY);
        await openSheet(page);
        expect(
          await page.evaluate(() => [
            document.documentElement.dataset.scrollLocked,
            getComputedStyle(document.documentElement).overflow,
          ]),
        ).toEqual(["", "hidden"]);
        // Mobile WebKit takes no wheel input.
        if (!(engine === "webkit" && touch)) {
          const { x, y } = scrimPoint(device);
          await page.mouse.move(x, y);
          await page.mouse.wheel(0, 400);
          await page.waitForTimeout(200);
        }
        expect(await page.evaluate(() => window.scrollY)).toBe(before);
        await page.keyboard.press("Escape");
        await expect(sheetOf(page)).toHaveCount(0);
        expect(
          await page.evaluate(() => document.documentElement.dataset.scrollLocked ?? null),
        ).toBeNull();
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("under reduced motion the overlays only fade", async () => {
        const moving = (page: Page) =>
          page.evaluate(() =>
            [...document.querySelectorAll(".ui-layer *")].flatMap((element) =>
              element
                .getAnimations()
                .map((animation) => (animation as CSSTransition).transitionProperty),
            ),
          );
        for (const motion of ["no-preference", "reduce"] as const) {
          const { context, page, seen } = await open(browser, device, motion);
          await press(page.getByRole("button", { name: "Open settings" }));
          const properties = await moving(page);
          const travels = properties.some((name) => name === "translate" || name === "scale");
          expect(travels).toBe(motion === "no-preference");
          await settled(sheetOf(page));
          await press(page.getByRole("button", { name: "Close settings" }));
          expect((await moving(page)).some((name) => name === "translate")).toBe(
            motion === "no-preference",
          );
          await expect(sheetOf(page)).toHaveCount(0);
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        }
      });
    });
