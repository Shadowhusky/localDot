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

// Presses a page control from a script, so the pointer stays where the test left it.
function pressFromScript(page: Page, name: string) {
  return page.evaluate((label) => {
    const control = [...document.querySelectorAll<HTMLElement>("button")].find(
      (button) => button.textContent?.trim() === label || button.ariaLabel === label,
    );
    if (!control) throw new Error(`no ${label}`);
    control.click();
  }, name);
}

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

      if (!touch)
        test("the stack follows its anchor when the anchor moves without changing size", async () => {
          const { context, page, seen } = await open(browser, device);
          await page.locator(".feedback-stage").scrollIntoViewIfNeeded();
          await press(page.getByRole("button", { name: "Show a failure" }));
          await settled(page.getByRole("region", { name: "Notifications" }));
          const hud = page.getByRole("toolbar", { name: "Task controls" });
          // Moved by a transform: no resize and no layout for an observer to see.
          await hud.evaluate((element) => element.style.setProperty("translate", "-120px 40px"));
          const centre = (rect: { x: number; width: number }) => rect.x + rect.width / 2;
          await expect
            .poll(async () => {
              const [anchor, front] = await Promise.all([box(hud), box(toastsOf(page).first())]);
              return Math.max(
                Math.abs(centre(front) - centre(anchor)),
                Math.abs(front.y - (anchor.y + anchor.height + 8)),
              );
            })
            .toBeLessThanOrEqual(1);
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

      if (touch)
        test("the opened stack stays over the page's controls and takes every press inside it", async () => {
          const { context, page, seen } = await open(browser, device);
          await page
            .locator(".feedback-stage")
            .evaluate((element) => element.scrollIntoView({ block: "start" }));
          await press(page.getByRole("button", { name: "Show three" }));
          const region = page.getByRole("region", { name: "Notifications" });
          await settled(region);
          await toastsOf(page).first().locator(".ui-toast-text").tap();
          await expect(region).toHaveAttribute("data-expanded", "");
          await settled(region);
          const points = await page.evaluate(() => {
            const controls = [...document.querySelectorAll(".feedback-controls button")].map(
              (control) => control.getBoundingClientRect(),
            );
            return [...document.querySelectorAll(".ui-toast:not([data-leaving])")].flatMap(
              (toast) => {
                const rect = toast.getBoundingClientRect();
                // In from each edge, clear of the rounded corners, and through the middle.
                return [24, rect.width / 2, rect.width - 24].flatMap((dx) =>
                  [6, rect.height / 2, rect.height - 6].map((dy) => {
                    const x = rect.x + dx;
                    const y = rect.y + dy;
                    const over = controls.some(
                      (c) => x >= c.left && x <= c.right && y >= c.top && y <= c.bottom,
                    );
                    const mine = document.elementFromPoint(x, y)?.closest(".ui-toast") === toast;
                    return { x, y, over, mine };
                  }),
                );
              },
            );
          });
          // The opened stack does hang over the buttons under the stage.
          const overControls = points.filter((point) => point.over);
          expect(overControls.length).toBeGreaterThan(0);
          expect(points.filter((point) => !point.mine)).toEqual([]);
          await page.evaluate(() => {
            const counts = window as unknown as { pagePresses: number };
            counts.pagePresses = 0;
            document.querySelector(".feedback-controls")?.addEventListener("click", () => {
              counts.pagePresses++;
            });
          });
          const [inside] = overControls;
          if (inside) await page.touchscreen.tap(inside.x, inside.y);
          await page.waitForTimeout(300);
          expect(
            await page.evaluate(() => (window as unknown as { pagePresses: number }).pagePresses),
          ).toBe(0);
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        });

      if (!touch)
        test("a toast shown again while it is swiped away comes back whole and can be swiped again", async () => {
          const { context, page, seen } = await open(browser, device);
          await page.locator(".feedback-stage").scrollIntoViewIfNeeded();
          await press(page.getByRole("button", { name: "Show a failure" }));
          const region = page.getByRole("region", { name: "Notifications" });
          await settled(region);
          const swipe = async () => {
            const start = await box(toastsOf(page).first().locator(".ui-toast-text"));
            const x = start.x + 20;
            const y = start.y + start.height / 2;
            await page.mouse.move(x, y);
            await page.mouse.down();
            for (const step of [15, 60, 120, 180, 240]) await page.mouse.move(x + step, y);
            await page.mouse.up();
          };
          await swipe();
          // The HUD's Stop shows the same failure again while the first is still flying off.
          await pressFromScript(page, "Stop");
          const toast = page.locator(".ui-toast");
          await expect(toast).toHaveCount(1);
          await expect(toast).not.toHaveAttribute("data-leaving");
          await expect(toast).not.toHaveAttribute("inert");
          await page.waitForTimeout(400);
          await settled(region);
          expect(
            await toast.evaluate((element) => [
              element.style.transform,
              getComputedStyle(element).opacity,
            ]),
          ).toEqual(["", "1"]);
          await swipe();
          await expect(page.locator(".ui-toast")).toHaveCount(0);
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        });

      if (!touch)
        test("a toast that comes while the pointer rests on the stack waits, so nothing moves under it", async () => {
          const { context, page, seen } = await open(browser, device);
          await page.locator(".feedback-stage").scrollIntoViewIfNeeded();
          await press(page.getByRole("button", { name: "Show a failure" }));
          await press(page.getByRole("button", { name: "Show one with Undo" }));
          const region = page.getByRole("region", { name: "Notifications" });
          await settled(region);
          await toastsOf(page).first().locator(".ui-toast-text").hover();
          await expect(region).toHaveAttribute("data-expanded", "");
          await settled(region);
          const check = page.getByRole("button", { name: "Check again" });
          const before = await box(check);
          const x = before.x + before.width / 2;
          const y = before.y + before.height / 2;
          await page.mouse.move(x, y);
          await pressFromScript(page, "Show a result");
          await page.waitForTimeout(100);
          await settled(region);
          expect(await box(check)).toEqual(before);
          expect(
            await page.evaluate(
              ({ px, py }) => document.elementFromPoint(px, py)?.closest("button")?.textContent,
              { px: x, py: y },
            ),
          ).toBe("Check again");
          await expect(toastsOf(page)).toHaveCount(2);
          // Let go, and it takes the front.
          await page.mouse.move(8, 8);
          await expect(toastsOf(page)).toHaveCount(3);
          await expect(toastsOf(page).first()).toContainText("Saved to Downloads");
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        });

      if (!touch)
        test("words coming out from behind start to show at once", async () => {
          const { context, page, seen } = await open(browser, device);
          await page.locator(".feedback-stage").scrollIntoViewIfNeeded();
          const region = page.getByRole("region", { name: "Notifications" });
          // How opaque the words of the toast now second are, frame by frame, from the given event
          // on the stack.
          const sample = (type: "pointerover" | "click") =>
            page.evaluate(
              (name) =>
                new Promise<{ t: number; opacity: number }[]>((resolve) => {
                  const behind = document.querySelectorAll(".ui-toast:not([data-leaving])")[1];
                  const words = behind?.querySelector(".ui-toast-body");
                  const list = document.querySelector(".ui-toast-list");
                  if (!words || !list) throw new Error("no toast behind");
                  const listener = () => {
                    const start = performance.now();
                    const frames: { t: number; opacity: number }[] = [];
                    const step = (now: number) => {
                      frames.push({
                        t: now - start,
                        opacity: Number(getComputedStyle(words).opacity),
                      });
                      if (now - start < 200) requestAnimationFrame(step);
                      else resolve(frames);
                    };
                    requestAnimationFrame(step);
                  };
                  list.addEventListener(name, listener, { once: true, capture: true });
                }),
              type,
            );
          const shownBy = (frames: { t: number; opacity: number }[], ms: number) =>
            frames.find((frame) => frame.t >= ms)?.opacity ?? 0;

          // Laid out: the card behind parts from the front one with its words on it.
          await press(page.getByRole("button", { name: "Show a result" }));
          await press(page.getByRole("button", { name: "Show one with Undo" }));
          await settled(region);
          const parting = sample("pointerover");
          await toastsOf(page).first().locator(".ui-toast-text").hover();
          expect(shownBy(await parting, 70)).toBeGreaterThanOrEqual(0.5);
          await page.mouse.move(8, 8);
          await expect(region).not.toHaveAttribute("data-expanded");
          await settled(region);

          // Handed over: the front one goes, and the next one's words come up as it takes its place.
          const forward = sample("click");
          await page.evaluate(() =>
            document
              .querySelector<HTMLElement>(".ui-toast:not([data-leaving]) [aria-label='Dismiss']")
              ?.click(),
          );
          // Chrome starts a transition a frame or two late, so this is read from where it starts.
          const frames = await forward;
          const start = frames.findIndex((frame) => frame.opacity > 0);
          expect(start).toBeGreaterThanOrEqual(0);
          expect(frames[start + 2]?.opacity).toBeGreaterThanOrEqual(0.6);
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        });

      if (!touch)
        test("a toast springing home is caught where it is and follows on from there", async () => {
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
          await page.mouse.move(x + 100, y);
          await page.waitForTimeout(150);
          await page.mouse.up();
          await page.waitForTimeout(40);
          expect((await shift(toast)).x).toBeGreaterThan(5);
          await page.mouse.down();
          const held = (await shift(toast)).x;
          await page.waitForTimeout(150);
          expect(Math.abs((await shift(toast)).x - held)).toBeLessThanOrEqual(1);
          await page.mouse.move(x + 120, y);
          expect(Math.abs((await shift(toast)).x - (held + 20))).toBeLessThanOrEqual(1);
          await page.mouse.up();
          await expect.poll(async () => Math.abs((await shift(toast)).x)).toBeLessThan(0.5);
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        });

      if (engine === "chrome" && touch)
        test("a toast that comes while a finger is on the front one waits until the press is done", async () => {
          const { context, page, seen } = await open(browser, device);
          await page.locator(".feedback-stage").scrollIntoViewIfNeeded();
          await press(page.getByRole("button", { name: "Show one with Undo" }));
          await settled(page.getByRole("region", { name: "Notifications" }));
          const undo = page.getByRole("button", { name: "Undo", exact: true });
          const before = await box(undo);
          const cdp = await context.newCDPSession(page);
          const x = before.x + before.width / 2;
          const y = before.y + before.height / 2;
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x, y, id: 1 }],
          });
          await pressFromScript(page, "Show a result");
          await page.waitForTimeout(400);
          expect(await box(undo)).toEqual(before);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await expect(page.getByTestId("undone")).toHaveText("Undo pressed 1 time");
          await expect(toastsOf(page).first()).toContainText("Saved to Downloads");
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

      test("a reload keeps the rows on screen, and shows bones only if it lasts", async () => {
        const { context, page, seen } = await open(browser, device);
        const panel = page.getByRole("figure").filter({ hasText: "Loaded" });
        await panel.scrollIntoViewIfNeeded();
        // The first row's name, sampled every frame for 700 ms from the press on Reload.
        const sampling = panel.evaluate(
          (figure) =>
            new Promise<{ t: number; content: number; bones: number }[]>((resolve) => {
              const name = figure.querySelectorAll(".ui-skeleton")[1];
              const reload = [...figure.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "Reload",
              );
              const seenAt = (element: Element | null | undefined) => {
                if (!element) return 0;
                const style = getComputedStyle(element);
                return style.visibility === "visible" ? Number(style.opacity) : 0;
              };
              reload?.addEventListener(
                "click",
                () => {
                  const start = performance.now();
                  const frames: { t: number; content: number; bones: number }[] = [];
                  const step = (now: number) => {
                    frames.push({
                      t: now - start,
                      content: seenAt(name?.querySelector(".ui-skeleton-content")),
                      bones: seenAt(name?.querySelector(".ui-skeleton-bones")),
                    });
                    if (now - start < 700) requestAnimationFrame(step);
                    else resolve(frames);
                  };
                  requestAnimationFrame(step);
                },
                { once: true },
              );
            }),
        );
        await press(panel.getByRole("button", { name: "Reload" }));
        const frames = await sampling;
        expect(frames.filter((frame) => Math.max(frame.content, frame.bones) < 0.45)).toEqual([]);
        const early = frames.filter((frame) => frame.t < 150);
        expect(early.length).toBeGreaterThan(2);
        expect(early.every((frame) => frame.content === 1 && frame.bones === 0)).toBe(true);
        const late = frames.filter((frame) => frame.t > 450);
        expect(late.length).toBeGreaterThan(2);
        expect(late.every((frame) => frame.bones === 1 && frame.content === 0)).toBe(true);
        await expect(panel.locator(".ui-skeleton-bones")).toHaveCount(0, { timeout: 5000 });
        await expect(panel.getByText("monthly-report.ods")).toBeVisible();
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      if (touch)
        test("a toast's close button takes its whole 44 px reach on touch", async () => {
          const { context, page, seen } = await open(browser, device);
          await page.locator(".feedback-stage").scrollIntoViewIfNeeded();
          // No action beside it, whose face would rightly take a press on its own side.
          await press(page.getByRole("button", { name: "Show a result" }));
          await settled(page.getByRole("region", { name: "Notifications" }));
          const close = toastsOf(page).first().getByRole("button", { name: "Dismiss" });
          const face = await box(close);
          const x = face.x + face.width / 2;
          const y = face.y + face.height / 2;
          const misses = await page.evaluate(
            ({ cx, cy }) =>
              [
                [-21, 0],
                [21, 0],
                [0, -21],
                [0, 21],
              ].filter(
                ([dx = 0, dy = 0]) =>
                  document.elementFromPoint(cx + dx, cy + dy)?.closest("button")?.ariaLabel !==
                  "Dismiss",
              ),
            { cx: x, cy: y },
          );
          expect(misses).toEqual([]);
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        });

      if (!touch)
        test("a banner's close button lines up with the buttons beside it", async () => {
          const { context, page, seen } = await open(browser, device);
          await page.getByTestId("below-banner").scrollIntoViewIfNeeded();
          await press(page.getByRole("button", { name: "Show a message" }));
          const banner = page.locator(".feedback-flow .ui-banner");
          await settled(page.locator(".feedback-flow > .ui-banner-reveal"));
          const middle = (rect: { y: number; height: number }) => rect.y + rect.height / 2;
          const [close, retry] = await Promise.all([
            box(banner.getByRole("button", { name: "Dismiss" })),
            box(banner.getByRole("button", { name: "Try again" })),
          ]);
          expect(Math.abs(middle(close) - middle(retry))).toBeLessThanOrEqual(1);
          expect(await seen()).toEqual({ violations: [], styles: 0 });
          await context.close();
        });

      test("under reduced motion work of unknown length stands still, and its ring has no track", async () => {
        const { context, page, seen } = await open(browser, device, "reduce");
        const unknown = page.locator(".ui-progress[data-indeterminate]");
        await unknown.first().scrollIntoViewIfNeeded();
        expect(
          await unknown.evaluateAll((elements) =>
            elements.flatMap((element) =>
              element.getAnimations({ subtree: true }).map((animation) => animation.id || "a"),
            ),
          ),
        ).toEqual([]);
        const tracks = await page
          .locator(".ui-progress[data-variant='ring'] .ui-progress-track")
          .evaluateAll((elements) =>
            elements.map((element) => [
              element.closest("[data-indeterminate]") !== null,
              getComputedStyle(element).opacity,
            ]),
          );
        expect(tracks).toContainEqual([true, "0"]);
        expect(tracks.filter(([unknownLength]) => unknownLength)).toEqual([[true, "0"]]);
        expect(tracks).toContainEqual([false, "0.25"]);
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      test("a meter short of room puts its amount under its name rather than cutting the name", async () => {
        const { context, page, seen } = await open(browser, device);
        const meter = page.locator(".ui-meter[data-near]").first();
        await meter.scrollIntoViewIfNeeded();
        await meter.evaluate((element) => element.style.setProperty("width", "240px"));
        const [label, value] = await Promise.all(
          [".ui-meter-label", ".ui-meter-value"].map((selector) =>
            meter.locator(selector).evaluate((element) => {
              const { x, y, width } = element.getBoundingClientRect();
              return { x, y, width, cut: element.scrollWidth > element.clientWidth };
            }),
          ),
        );
        expect(label?.cut).toBe(false);
        expect(value?.y).toBeGreaterThan(label?.y ?? 0);
        const track = await box(meter.getByRole("meter"));
        expect((value?.x ?? 0) + (value?.width ?? 0)).toBeLessThanOrEqual(
          track.x + track.width + 0.5,
        );
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      });

      if (engine === "chrome" && !touch)
        test("in light forced colours a meter near its limit still shows its fill", async () => {
          const { context, page, seen } = await open(browser, device);
          await page.emulateMedia({ forcedColors: "active", colorScheme: "light" });
          const near = page.locator(".ui-meter[data-near] .ui-meter-fill").first();
          await near.scrollIntoViewIfNeeded();
          await settled(page.locator(".feedback-meters"));
          const fill = (locator: Locator) =>
            locator.evaluate((element) => getComputedStyle(element).backgroundColor);
          const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
          expect(await fill(near)).not.toBe(ground);
          expect(await fill(near)).toBe(
            await fill(page.locator(".ui-meter:not([data-near]) .ui-meter-fill").first()),
          );
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
