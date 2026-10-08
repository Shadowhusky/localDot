import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { DESKTOP, openKitPage, PHONE, startKitGallery } from "./kit-gallery.ts";
import { ENGINES } from "./ui-fixture.ts";

// A touch tablet with room for a popover beside the trigger.
const TABLET = { ...PHONE, viewport: { width: 820, height: 1180 } };

// The T07 fields and pickers in the kit gallery, under the production CSP, in Chrome and WebKit,
// on a desktop and on a touch phone.
let gallery: Awaited<ReturnType<typeof startKitGallery>>;

test.use({ actionTimeout: 10_000, navigationTimeout: 10_000 });
test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  gallery = await startKitGallery();
});

test.afterAll(async () => {
  await gallery?.stop();
});

function open(
  browser: Browser,
  options: typeof DESKTOP | typeof PHONE | typeof TABLET,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
) {
  return openKitPage(
    browser,
    `${gallery.origin}/?page=fields`,
    "Fields and choices",
    options,
    reducedMotion,
  );
}

function picker(page: Page, name: string): Locator {
  return page.getByRole("combobox", { name, exact: true });
}

// Counts the clicks that reach anything but the open list: a choice must never click through.
async function countStrayClicks(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const strays = { count: 0 };
    (window as unknown as { kitStrays: typeof strays }).kitStrays = strays;
    document.addEventListener(
      "click",
      (event) => {
        if (!(event.target as Element).closest(".ui-picker, .ui-picker-scrim")) strays.count++;
      },
      true,
    );
  });
  return () =>
    page.evaluate(() => (window as unknown as { kitStrays: { count: number } }).kitStrays.count);
}

// Waits for every transition on the page to finish, such as a sheet rising.
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
}

async function press(locator: Locator, phone: boolean) {
  if (phone) await locator.tap();
  else await locator.click();
}

// Drives a finger through Chrome's DevTools protocol, a move every `gap` ms, so the sheet sees a real
// touch with real timing. Without `lift`, the finger stays down until the returned function lifts it.
async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  dy: number,
  { steps, gap, lift = true }: { steps: number; gap: number; lift?: boolean },
) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", y: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: from.x, y }],
    });
  await touch("touchStart", from.y);
  for (let step = 1; step <= steps; step++) {
    await page.waitForTimeout(gap);
    await touch("touchMove", from.y + (dy * step) / steps);
  }
  if (lift) await touch("touchEnd", from.y + dy);
  return () => touch("touchEnd", from.y + dy);
}

// The top of every field after the one named, so a test can see whether anything below it moved.
function fieldsBelow(page: Page, label: string) {
  return page.evaluate((name) => {
    const fields = [...document.querySelectorAll(".ui-field")];
    const at = fields.findIndex((field) => field.querySelector("label")?.textContent === name);
    return fields.slice(at + 1).map((field) => Math.round(field.getBoundingClientRect().y));
  }, label);
}

for (const [engine, launch] of Object.entries(ENGINES))
  test.describe(engine, () => {
    let browser: Browser;
    test.beforeAll(async () => {
      browser = await launch();
    });
    test.afterAll(async () => {
      await browser?.close();
    });

    test("Escape closes only the list, and the panel around it keeps its choice", async () => {
      for (const options of [DESKTOP, PHONE]) {
        const phone = options === PHONE;
        const { context, page, seen } = await open(browser, options);
        const panel = page.getByRole("region", { name: "Settings panel" });
        const select = picker(page, "Autonomy in the panel");
        await select.scrollIntoViewIfNeeded();
        await press(select, phone);
        await press(page.getByRole("option", { name: "Watch only" }), phone);
        await expect(select).toHaveText("Watch only");
        await press(select, phone);
        await expect(page.getByRole("listbox")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(select).toHaveAttribute("aria-expanded", "false");
        await expect(panel.getByTestId("panel-state")).toHaveText("Panel open · closed 0 times");
        await expect(select).toHaveText("Watch only");
        await expect(select).toBeFocused();
        // With the list closed, the panel's own Escape works again.
        await page.keyboard.press("Escape");
        await expect(panel.getByTestId("panel-state")).toHaveText("Panel closed · closed 1 time");
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      }
    });

    test("a tap on a row chooses it and nothing under the list sees the tap", async () => {
      for (const options of [DESKTOP, PHONE]) {
        const phone = options === PHONE;
        const { context, page, seen } = await open(browser, options);
        const strays = await countStrayClicks(page);
        const autonomy = picker(page, "Autonomy");
        await autonomy.scrollIntoViewIfNeeded();
        await press(autonomy, phone);
        const list = page.getByRole("listbox", { name: "Autonomy" });
        await expect(list).toBeVisible();
        if (phone) {
          // On a phone the list rises as a sheet from the bottom edge.
          await expect(page.getByRole("dialog", { name: "Autonomy" })).toBeVisible();
          await expect
            .poll(async () => {
              const sheet = await page.locator(".ui-sheet").boundingBox();
              return sheet && Math.round(sheet.y + sheet.height);
            })
            .toBe(844);
        }
        const before = await strays();
        await press(list.getByRole("option", { name: "Ask before each step" }), phone);
        await expect(autonomy).toHaveText("Ask before each step");
        await page.waitForTimeout(600);
        expect(await strays()).toBe(before);
        await expect(page.locator(".ui-picker")).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Taps that reached the page: 0" }),
        ).toBeVisible();
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      }
    });

    test("a press outside an open list closes only the list, and its click reaches nothing", async () => {
      for (const options of [DESKTOP, TABLET]) {
        const touch = options === TABLET;
        const { context, page, seen } = await open(browser, options);
        const autonomy = picker(page, "Autonomy");
        const taps = page.locator(".fields-under");
        await autonomy.scrollIntoViewIfNeeded();
        await press(autonomy, touch);
        await expect(page.getByRole("listbox", { name: "Autonomy" })).toBeVisible();
        await settled(page);
        await press(taps, touch);
        await expect(page.locator(".ui-picker")).toHaveCount(0);
        await expect(autonomy).toHaveAttribute("aria-expanded", "false");
        await expect(autonomy).toHaveText("Ask before risky steps");
        await expect(taps).toHaveText("Taps that reached the page: 0");
        // With the list gone, the next press is the page's.
        await press(taps, touch);
        await expect(taps).toHaveText("Taps that reached the page: 1");
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      }
    });

    test("a click on a panel's backdrop with a list open closes only the list", async () => {
      for (const options of [DESKTOP, TABLET, PHONE]) {
        const touch = options !== DESKTOP;
        const { context, page, seen } = await open(browser, options);
        const state = page.getByTestId("panel-state");
        const backdrop = page.getByTestId("panel-backdrop");
        const select = picker(page, "Autonomy in the panel");
        await backdrop.scrollIntoViewIfNeeded();
        await press(select, touch);
        await press(page.getByRole("option", { name: "Watch only" }), touch);
        await expect(page.locator(".ui-picker")).toHaveCount(0);
        await press(select, touch);
        await expect(page.getByRole("listbox")).toBeVisible();
        await settled(page);
        // A corner of the dimmed backdrop, clear of the panel and of a popover under its trigger. A
        // phone's sheet lays its own scrim over the page, so there the press lands on the dim area
        // above the sheet.
        const box = await backdrop.boundingBox();
        const sheetTop = await page.evaluate(
          () => document.querySelector(".ui-sheet")?.getBoundingClientRect().top ?? Infinity,
        );
        if (!box) throw new Error("no backdrop");
        const corner = { x: box.x + 12, y: box.y + 12 };
        const outside = { x: corner.x, y: Math.min(corner.y, sheetTop - 24) };
        if (touch) await page.touchscreen.tap(outside.x, outside.y);
        else await page.mouse.click(outside.x, outside.y);
        await expect(page.locator(".ui-picker")).toHaveCount(0);
        await expect(state).toHaveText("Panel open · closed 0 times");
        await expect(select).toHaveText("Watch only");
        // With no list open, a click on the backdrop closes the panel.
        if (touch) await page.touchscreen.tap(corner.x, corner.y);
        else await page.mouse.click(corner.x, corner.y);
        await expect(state).toHaveText("Panel closed · closed 1 time");
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      }
    });

    test("an error under a field without a description moves nothing below it", async () => {
      for (const options of [DESKTOP, PHONE]) {
        const { context, page, seen } = await open(browser, options);
        const name = page.getByRole("textbox", { name: "Key name" });
        await name.scrollIntoViewIfNeeded();
        const before = await fieldsBelow(page, "Key name");
        expect(before.length).toBeGreaterThan(0);
        await name.fill("");
        await expect(name).toHaveAccessibleDescription("Give the key a name");
        expect(await fieldsBelow(page, "Key name")).toEqual(before);
        await name.fill("Home");
        await expect(name).not.toHaveAttribute("aria-invalid");
        expect(await fieldsBelow(page, "Key name")).toEqual(before);
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      }
    });

    test("an unavailable row stays open to read and cannot be chosen", async () => {
      const { context, page, seen } = await open(browser, PHONE);
      const autonomy = picker(page, "Autonomy");
      await autonomy.scrollIntoViewIfNeeded();
      await autonomy.tap();
      const never = page.getByRole("option", { name: /Never ask/ });
      await expect(never).toContainText("Needs a task budget first");
      await settled(page);
      // Force: Playwright will not tap a row marked unavailable, and a finger can.
      await never.tap({ force: true });
      await page.waitForTimeout(400);
      await expect(page.getByRole("listbox", { name: "Autonomy" })).toBeVisible();
      await expect(autonomy).toHaveText("Ask before risky steps");
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("typing in the combobox filters the list and Enter takes the first match", async () => {
      for (const options of [DESKTOP, PHONE]) {
        const phone = options === PHONE;
        const { context, page, seen } = await open(browser, options);
        const model = picker(page, "Main model");
        await model.scrollIntoViewIfNeeded();
        await press(model, phone);
        const search = page.getByRole("combobox", { name: "Search: Main model" });
        if (phone) await search.tap();
        else await expect(search).toBeFocused();
        await search.fill("son");
        const rows = page.getByRole("listbox", { name: "Main model" }).getByRole("option");
        await expect(rows).toHaveText([
          "Claude Sonnet 4.5",
          "Claude Sonnet 4",
          "Use “son”Use as a custom model ID",
        ]);
        await search.fill("sonnet 4");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await expect(model).toHaveText("Claude Sonnet 4");
        await expect(model).toHaveAttribute("aria-expanded", "false");
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      }
    });

    test("the search field never moves while the list filters under it", async () => {
      for (const options of [DESKTOP, PHONE]) {
        const phone = options === PHONE;
        const { context, page, seen } = await open(browser, options);
        const provider = picker(page, "Main provider");
        await provider.scrollIntoViewIfNeeded();
        await press(provider, phone);
        const search = page.getByRole("combobox", { name: "Search: Main provider" });
        await expect(search).toBeVisible();
        await page.waitForTimeout(500);
        const at = await search.boundingBox();
        await search.fill("o");
        await search.fill("oll");
        await search.fill("nothing like this");
        await expect(page.getByText("No matches")).toBeVisible();
        expect(await search.boundingBox()).toEqual(at);
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      }
    });

    test("a phone's sheet follows a drag on its head and closes when flung down", async () => {
      const { context, page, seen } = await open(browser, PHONE);
      const autonomy = picker(page, "Autonomy");
      await autonomy.scrollIntoViewIfNeeded();
      await autonomy.tap();
      const sheet = page.locator(".ui-sheet");
      await expect(sheet).toBeVisible();
      await page.waitForTimeout(500);
      const rest = await sheet.boundingBox();
      const head = await page.locator(".ui-sheet-head").boundingBox();
      if (!rest || !head) throw new Error("no sheet");
      const x = head.x + head.width / 2;
      const y = head.y + head.height / 2;
      // A short drag moves it 1:1 and springs back.
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 40, { steps: 8 });
      expect(Math.round(((await sheet.boundingBox())?.y ?? 0) - rest.y)).toBe(40);
      await page.waitForTimeout(150);
      await page.mouse.up();
      await expect.poll(async () => (await sheet.boundingBox())?.y).toBe(rest.y);
      await expect(page.getByRole("listbox", { name: "Autonomy" })).toBeVisible();
      // A long drag past a third of its height closes it, with the choice unchanged.
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + rest.height * 0.6, { steps: 6 });
      await page.mouse.up();
      await expect(page.locator(".ui-picker")).toHaveCount(0);
      await expect(autonomy).toHaveText("Ask before risky steps");
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("a finger drags the sheet 1:1, and a short flick or a slow drag past a third closes it", async () => {
      test.skip(engine !== "chrome", "touch is driven through Chrome's DevTools protocol");
      const { context, page, seen } = await open(browser, PHONE);
      const autonomy = picker(page, "Autonomy");
      await autonomy.scrollIntoViewIfNeeded();
      await autonomy.tap();
      const sheet = page.locator(".ui-sheet");
      await settled(page);
      const rest = await sheet.boundingBox();
      const head = await page.locator(".ui-sheet-head").boundingBox();
      if (!rest || !head) throw new Error("no sheet");
      const grab = { x: head.x + head.width / 2, y: head.y + head.height / 2 };
      // It follows the finger exactly, and a finger that stopped lets it spring back.
      const lift = await touchDrag(page, grab, 48, { steps: 6, gap: 16, lift: false });
      await expect
        .poll(async () => Math.round(((await sheet.boundingBox())?.y ?? 0) - rest.y))
        .toBe(48);
      await page.waitForTimeout(150);
      await lift();
      await expect.poll(async () => (await sheet.boundingBox())?.y).toBe(rest.y);
      // A flick well short of a third of its height closes it by where it would come to rest.
      expect(60).toBeLessThan(rest.height * 0.3);
      await touchDrag(page, grab, 60, { steps: 3, gap: 8 });
      await expect(page.locator(".ui-picker")).toHaveCount(0);
      await expect(autonomy).toHaveText("Ask before risky steps");
      // A slow drag past a third closes it too, and its exit never outlasts the sheet.
      await autonomy.tap();
      await settled(page);
      await touchDrag(page, grab, rest.height * 0.5, { steps: 12, gap: 30 });
      const exit = await sheet.evaluate((element) =>
        Number.parseFloat(/translate (\d+)ms/.exec(element.style.transition)?.[1] ?? "NaN"),
      );
      expect(exit).toBeLessThanOrEqual(280);
      await expect(page.locator(".ui-picker")).toHaveCount(0);
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("a finger scrolls a long list in the sheet without choosing the row it lands on", async () => {
      test.skip(engine !== "chrome", "touch is driven through Chrome's DevTools protocol");
      const short = { ...PHONE, viewport: { width: 390, height: 520 } };
      const { context, page, seen } = await open(browser, short);
      const model = picker(page, "Main model");
      await model.scrollIntoViewIfNeeded();
      await model.tap();
      await settled(page);
      const list = page.getByRole("listbox", { name: "Main model" });
      expect(
        await list.evaluate((element) => element.scrollHeight - element.clientHeight),
      ).toBeGreaterThan(150);
      const box = await list.boundingBox();
      if (!box) throw new Error("no list");
      const pageAt = await page.evaluate(() => window.scrollY);
      await touchDrag(page, { x: box.x + box.width / 2, y: box.y + box.height - 40 }, -150, {
        steps: 10,
        gap: 16,
      });
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
      await page.waitForTimeout(400);
      await expect(list).toBeVisible();
      await expect(model).toHaveText("Claude Sonnet 4.5");
      // The page under the sheet stays where it was.
      expect(await page.evaluate(() => window.scrollY)).toBe(pageAt);
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("under reduced motion the sheet fades in where it rests instead of rising", async () => {
      const { context, page, seen } = await open(browser, PHONE, "reduce");
      const autonomy = picker(page, "Autonomy");
      await autonomy.scrollIntoViewIfNeeded();
      await autonomy.tap();
      const sheet = page.locator(".ui-sheet");
      await expect(sheet).toBeVisible();
      const opening = await sheet.evaluate((element) =>
        element.getAnimations().map((animation) => (animation as CSSTransition).transitionProperty),
      );
      expect(opening).not.toContain("translate");
      expect(await sheet.evaluate((element) => getComputedStyle(element).translate)).toBe("none");
      await page.keyboard.press("Escape");
      await expect(page.locator(".ui-picker")).toHaveCount(0);
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("the text area grows a line at a time to eight, and what is above it stays put", async () => {
      const { context, page, seen } = await open(browser, DESKTOP);
      const area = page.getByRole("textbox", { name: "Message" });
      const marker = page.getByTestId("above-message");
      // With room below it, so the page never scrolls to follow the caret.
      await marker.evaluate((element) => element.scrollIntoView({ block: "start" }));
      const above = await marker.boundingBox();
      const top = (await area.boundingBox())?.y;
      const heights: number[] = [];
      await area.click();
      for (let line = 1; line <= 10; line++) {
        if (line > 1) await page.keyboard.press("Enter");
        await page.keyboard.type(`line ${line}`);
        heights.push(Math.round((await area.boundingBox())?.height ?? 0));
        expect(await marker.boundingBox()).toEqual(above);
        expect((await area.boundingBox())?.y).toBe(top);
      }
      const steps = heights.slice(1, 8).map((height, at) => height - (heights[at] as number));
      expect(new Set(steps).size).toBe(1);
      expect(steps[0]).toBeGreaterThan(0);
      expect(heights.slice(7)).toEqual([heights[7], heights[7], heights[7]]);
      expect(await area.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true,
      );
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("an interrupted segmented thumb sets off from where it is, never jumping", async () => {
      const { context, page, seen } = await open(browser, DESKTOP);
      const speed = page.getByRole("radiogroup", { name: "Replay speed" });
      await speed.scrollIntoViewIfNeeded();
      const recording = page.evaluate(
        () =>
          new Promise<number[]>((resolve) => {
            const thumb = document.querySelector(".ui-segmented-thumb") as HTMLElement;
            const xs: number[] = [];
            const start = performance.now();
            const tick = () => {
              xs.push(thumb.getBoundingClientRect().x);
              if (performance.now() - start < 900) requestAnimationFrame(tick);
              else resolve(xs);
            };
            requestAnimationFrame(tick);
          }),
      );
      await speed.getByRole("radio", { name: "2×" }).click();
      await page.waitForTimeout(80);
      await speed.getByRole("radio", { name: "4×" }).click();
      const xs = await recording;
      const width = (await speed.getByRole("radio", { name: "1×" }).boundingBox())?.width ?? 0;
      const steps = xs.slice(1).map((x, at) => x - (xs[at] as number));
      // Only ever forward, and no frame covers more than half a segment.
      expect(Math.min(...steps)).toBeGreaterThanOrEqual(-0.5);
      expect(Math.max(...steps)).toBeLessThan(width / 2);
      expect((xs.at(-1) ?? 0) - (xs[0] ?? 0)).toBeGreaterThan(width * 1.9);
      await expect(speed.getByRole("radio", { name: "4×" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("with touch, every field, choice and segment gives a finger 44 px", async () => {
      const { context, page, seen } = await open(browser, PHONE);
      const short = await page.evaluate(() => {
        const misses: string[] = [];
        const targets =
          ".ui-text-field, .ui-text-area, .ui-select-trigger, .ui-choice, .ui-radio-card, .ui-segment";
        for (const target of document.querySelectorAll<HTMLElement>(targets)) {
          const box = target.getBoundingClientRect();
          if (box.height < 44)
            misses.push(`${target.className} ${target.textContent?.slice(0, 20)} ${box.height}`);
        }
        return misses;
      });
      expect(short).toEqual([]);
      const font = await page
        .getByRole("textbox", { name: "Task name" })
        .evaluate((input) => Number.parseFloat(getComputedStyle(input).fontSize));
      expect(font).toBeGreaterThanOrEqual(16);
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("a switch takes a tap anywhere on its row, and an unavailable one says why", async () => {
      const { context, page, seen } = await open(browser, PHONE);
      const notify = page.getByRole("switch", { name: "Notify me when a task needs me" });
      await notify.scrollIntoViewIfNeeded();
      await page.getByText("Notify me when a task needs me").tap();
      await expect(notify).toBeChecked();
      const login = page.getByRole("switch", { name: "Start at login" });
      // The row's text is the press target; force, since Playwright counts it as unavailable.
      await page.getByText("Start at login").tap({ force: true });
      await expect(login).not.toBeChecked();
      await expect(login).toHaveAccessibleDescription("Install localDot to start it at login");
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });
  });
