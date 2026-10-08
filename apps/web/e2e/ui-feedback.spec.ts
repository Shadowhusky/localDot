import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { DESKTOP, openKitPage, PHONE, startKitGallery } from "./kit-gallery.ts";
import { ENGINES } from "./ui-fixture.ts";

// T09's feedback in the kit gallery under the production CSP, in Chrome and WebKit, at 1440 and at
// 390 with touch.
const DEVICES = { desktop: DESKTOP, phone: PHONE };

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
  device: keyof typeof DEVICES,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
) {
  return openKitPage(
    browser,
    `${gallery.origin}/?page=feedback`,
    "Feedback",
    DEVICES[device],
    reducedMotion,
  );
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
}

// Every transition and animation that ends, on the element and inside it, has finished.
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

const toastsOf = (page: Page) => page.locator(".ui-toast:not([data-leaving])");

// Where the toast's content sits now, transforms included.
async function shift(locator: Locator): Promise<{ x: number; y: number }> {
  return locator.evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42 };
  });
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

      test("toasts hang 8 px under the HUD, centred on it, and move nothing on the page", async () => {
        const { context, page, seen } = await open(browser, device);
        const stage = page.locator(".feedback-stage");
        await stage.scrollIntoViewIfNeeded();
        const hud = page.getByRole("toolbar", { name: "Task controls" });
        const others = [
          stage,
          page.getByRole("button", { name: "Show three" }),
          page.getByTestId("undone"),
          page.getByRole("heading", { name: "Banners" }),
        ];
        const before = await Promise.all(others.map(box));
        await press(page.getByRole("button", { name: "Show three" }));
        await expect(toastsOf(page)).toHaveCount(3);
        const region = page.getByRole("region", { name: "Notifications" });
        await settled(region);
        expect(await Promise.all(others.map(box))).toEqual(before);

        const anchor = await box(hud);
        const front = await box(toastsOf(page).first());
        expect(Math.abs(front.y - (anchor.y + anchor.height + 8))).toBeLessThanOrEqual(1);
        const centre = (rect: { x: number; width: number }) => rect.x + rect.width / 2;
        expect(Math.abs(centre(front) - centre(anchor))).toBeLessThanOrEqual(1);
        // The two behind peek out below the front one, narrower each step back.
        const [, second, third] = await Promise.all(
          [0, 1, 2].map((index) => box(toastsOf(page).nth(index))),
        );
        expect(second?.width).toBeLessThan(front.width);
        expect(third?.width).toBeLessThan(second?.width ?? 0);
        expect((second?.y ?? 0) + (second?.height ?? 0)).toBeGreaterThan(front.y + front.height);
        await expect(toastsOf(page).nth(1)).toHaveAttribute("inert", "");
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("the stack opens out into a column and closes again", async () => {
        const { context, page, seen } = await open(browser, device);
        await page.locator(".feedback-stage").scrollIntoViewIfNeeded();
        await press(page.getByRole("button", { name: "Show three" }));
        const region = page.getByRole("region", { name: "Notifications" });
        await settled(region);
        const front = toastsOf(page).first();
        if (touch) await front.locator(".ui-toast-text").tap();
        else await front.locator(".ui-toast-text").hover();
        await expect(region).toHaveAttribute("data-expanded", "");
        await settled(region);
        const rows = await Promise.all([0, 1, 2].map((index) => box(toastsOf(page).nth(index))));
        for (let index = 1; index < rows.length; index++) {
          const above = rows[index - 1];
          const row = rows[index];
          expect(
            Math.abs((row?.y ?? 0) - ((above?.y ?? 0) + (above?.height ?? 0) + 8)),
          ).toBeLessThanOrEqual(1);
          expect(row?.width).toBeCloseTo(above?.width ?? 0, 0);
        }
        await expect(toastsOf(page).nth(2)).not.toHaveAttribute("inert");
        if (touch) await page.touchscreen.tap(8, 8);
        else await page.mouse.move(8, 8);
        await expect(region).not.toHaveAttribute("data-expanded");
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("a toast follows a sideways drag 1:1, springs back from a short one and leaves on a long one", async () => {
        const { context, page, seen } = await open(browser, device);
        await page.locator(".feedback-stage").scrollIntoViewIfNeeded();
        await press(page.getByRole("button", { name: "Show a failure" }));
        const toast = toastsOf(page).first();
        await settled(page.getByRole("region", { name: "Notifications" }));
        const start = await box(toast.locator(".ui-toast-text"));
        const x = start.x + 20;
        const y = start.y + start.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 15, y);
        await page.mouse.move(x + 60, y);
        expect(Math.abs((await shift(toast)).x - 60)).toBeLessThanOrEqual(1);
        await page.waitForTimeout(150);
        await page.mouse.up();
        await expect.poll(async () => Math.abs((await shift(toast)).x)).toBeLessThan(0.5);
        await expect(toast).toBeVisible();

        await page.mouse.move(x, y);
        await page.mouse.down();
        for (const step of [15, 60, 120, 180, 240]) await page.mouse.move(x + step, y);
        await page.waitForTimeout(150);
        await page.mouse.up();
        await expect(page.locator(".ui-toast")).toHaveCount(0);
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      if (engine === "chrome" && touch)
        test("a quick flick up by touch sends the toast back into the HUD", async () => {
          const { context, page, seen } = await open(browser, device);
          await page.locator(".feedback-stage").scrollIntoViewIfNeeded();
          await press(page.getByRole("button", { name: "Show a failure" }));
          const toast = toastsOf(page).first();
          await settled(page.getByRole("region", { name: "Notifications" }));
          const cdp = await context.newCDPSession(page);
          const touchAt = (type: "touchStart" | "touchMove" | "touchEnd", px: number, py: number) =>
            cdp.send("Input.dispatchTouchEvent", {
              type,
              touchPoints: type === "touchEnd" ? [] : [{ x: px, y: py, id: 1 }],
            });
          const text = await box(toast.locator(".ui-toast-text"));
          const x = text.x + 20;
          const y = text.y + text.height / 2;
          await touchAt("touchStart", x, y);
          for (const step of [12, 20, 30]) await touchAt("touchMove", x, y - step);
          await expect
            .poll(async () => Math.abs((await shift(toast)).y + 30))
            .toBeLessThanOrEqual(1);
          // Then a quick flick on from there: let go mid-move, short of half its height.
          expect(38).toBeLessThan((await box(toast)).height / 2);
          for (const step of [34, 38]) await touchAt("touchMove", x, y - step);
          await touchAt("touchEnd", x, y - 38);
          await expect(page.locator(".ui-toast")).toHaveCount(0);
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        });

      test("a banner opens and closes as the same element, sliding what follows without a jump", async () => {
        const { context, page, seen } = await open(browser, device);
        const below = page.getByTestId("below-banner");
        await below.scrollIntoViewIfNeeded();
        const reveal = page.locator(".feedback-flow > .ui-banner-reveal");
        await reveal.evaluate((element) => {
          (element as HTMLElement & { marked?: boolean }).marked = true;
        });
        const rest = (await box(below)).y;
        // Where the line below sits in each of the next 40 frames, read in the page.
        const sampling = below.evaluate(
          (element) =>
            new Promise<number[]>((resolve) => {
              const path: number[] = [];
              const step = () => {
                path.push(element.getBoundingClientRect().y);
                if (path.length < 40) requestAnimationFrame(step);
                else resolve(path);
              };
              requestAnimationFrame(step);
            }),
        );
        await press(page.getByRole("button", { name: "Show a message" }));
        const path = await sampling;
        await settled(reveal);
        const opened = (await box(below)).y;
        const card = await box(reveal.locator(".ui-banner"));
        expect(Math.abs(opened - rest - card.height - 12)).toBeLessThanOrEqual(1);
        // It slides down through several frames and never jumps half the way, or back.
        const steps = path.slice(1).map((y, index) => y - (path[index] ?? y));
        expect(steps.filter((step) => step > 0.5).length).toBeGreaterThanOrEqual(4);
        expect(Math.max(...steps)).toBeLessThan((opened - rest) / 2);
        expect(steps.every((step) => step >= -0.5)).toBe(true);
        await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

        await press(page.getByRole("button", { name: "Hide the message" }));
        await settled(reveal);
        expect(Math.abs((await box(below)).y - rest)).toBeLessThanOrEqual(0.5);
        expect(
          await reveal.evaluate(
            (element) => (element as HTMLElement & { marked?: boolean }).marked,
          ),
        ).toBe(true);
        await expect(page.getByRole("button", { name: "Try again" })).toBeHidden();
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("skeleton rows keep their boxes while loading and when the content arrives", async () => {
        const { context, page, seen } = await open(browser, device);
        const panel = page.getByRole("figure").filter({ hasText: "Loaded" });
        await panel.scrollIntoViewIfNeeded();
        const rows = panel.getByRole("listitem");
        const boxes = () =>
          rows.evaluateAll((items) =>
            items.map((item) => {
              const { x, y, width, height } = item.getBoundingClientRect();
              return { x, y, width, height };
            }),
          );
        const loaded = await boxes();
        await press(panel.getByRole("button", { name: "Reload" }));
        await expect(panel.locator(".ui-skeleton-bone").first()).toBeVisible();
        expect(await boxes()).toEqual(loaded);
        await expect(panel.locator(".ui-skeleton-bones")).toHaveCount(0, { timeout: 5000 });
        await expect(panel.getByText("monthly-report.ods")).toBeVisible();
        expect(await boxes()).toEqual(loaded);
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("a download ring fills, then closes with a check", async () => {
        const { context, page, seen } = await open(browser, device);
        const live = page.locator(".feedback-download");
        await live.scrollIntoViewIfNeeded();
        const ring = live.locator(".ui-progress[data-variant='ring']");
        await expect(ring).toHaveAttribute("aria-valuenow", "0");
        await press(live.getByRole("button", { name: "Download" }));
        await expect
          .poll(async () => Number(await ring.getAttribute("aria-valuenow")))
          .toBeGreaterThan(0.2);
        await expect(ring).toHaveAttribute("data-complete", "", { timeout: 5000 });
        await expect(ring.locator(".ui-progress-check")).toHaveCount(1);
        await expect(live.getByRole("button", { name: "Download" })).not.toHaveAttribute(
          "aria-busy",
        );
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("under reduced motion a toast and a banner only fade", async () => {
        const moving = (page: Page, selector: string) =>
          page
            .locator(selector)
            .evaluateAll((elements) =>
              elements.flatMap((element) =>
                element
                  .getAnimations()
                  .map((animation) => (animation as CSSTransition).transitionProperty),
              ),
            );
        for (const motion of ["no-preference", "reduce"] as const) {
          const { context, page, seen } = await open(browser, device, motion);
          await page.locator(".feedback-stage").scrollIntoViewIfNeeded();
          await press(page.getByRole("button", { name: "Show three" }));
          const toasts = await moving(page, ".ui-toast");
          const travels = toasts.some((name) => name === "translate" || name === "scale");
          expect(travels, motion).toBe(motion === "no-preference");
          expect(toasts).toContain("opacity");

          await page.getByTestId("below-banner").scrollIntoViewIfNeeded();
          await press(page.getByRole("button", { name: "Show a message" }));
          const banner = await moving(page, ".feedback-flow > .ui-banner-reveal");
          expect(banner.includes("grid-template-rows"), motion).toBe(motion === "no-preference");
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        }
      });
    });
