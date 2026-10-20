import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { DESKTOP, openKitPage, PHONE, startKitGallery } from "./kit-gallery.ts";
import { ENGINES } from "./ui-fixture.ts";

// The T06 atoms in the kit gallery, under the production CSP, in Chrome and WebKit.
const SQUEEZED = "0.97";
const REASON = "Choose a main provider and model";

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
  options: typeof DESKTOP | typeof PHONE,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
) {
  return openKitPage(browser, `${gallery.origin}/`, "Actions and atoms", options, reducedMotion);
}

function style(locator: Locator, property: "transform" | "opacity"): Promise<string> {
  return locator.evaluate((element, name) => getComputedStyle(element)[name], property);
}

// A control draws its fill, and squeezes, on its face: the ::before above every neighbour's reach.
function face(
  locator: Locator,
  property: "scale" | "backgroundColor" | "backgroundImage",
): Promise<string> {
  return locator.evaluate((element, name) => getComputedStyle(element, "::before")[name], property);
}

async function middle(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not on screen");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// The tooltip on screen: aria-hidden, since the trigger's name or description already carries it.
function tooltip(page: Page): Locator {
  return page.locator(".ui-tooltip:not([data-closing])");
}

// Every pixel along each control's middle row and column must hit-test to that control: no
// neighbour's reach may cover its face. Still specimens are inert, so they are left out.
function facesMissed(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const controls = ".ui-button, .ui-icon-button";
    const name = (element: Element | null | undefined) =>
      element ? (element.getAttribute("aria-label") ?? element.textContent) : "nothing";
    const misses: string[] = [];
    for (const control of document.querySelectorAll(controls)) {
      if (control.closest("[inert]")) continue;
      control.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const box = control.getBoundingClientRect();
      const points = [
        ...Array.from({ length: Math.floor(box.width) }, (_, i) => [
          box.left + 0.5 + i,
          box.top + box.height / 2,
        ]),
        ...Array.from({ length: Math.floor(box.height) }, (_, i) => [
          box.left + box.width / 2,
          box.top + 0.5 + i,
        ]),
      ];
      for (const [x = 0, y = 0] of points) {
        const hit = document.elementFromPoint(x, y)?.closest(controls);
        if (hit === control) continue;
        misses.push(
          `${name(control)} at ${Math.floor(x - box.left)},${Math.floor(y - box.top)} hits ${name(hit)}`,
        );
        break;
      }
    }
    return misses;
  });
}

// Records the name of every control in the close-together pairs that receives a click.
async function recordClicks(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const clicks: string[] = [];
    (window as unknown as { kitClicks: string[] }).kitClicks = clicks;
    for (const control of document.querySelectorAll(".atoms-pair :is(.ui-button, .ui-icon-button)"))
      control.addEventListener("click", () =>
        clicks.push(control.getAttribute("aria-label") ?? control.textContent ?? ""),
      );
  });
  return () => page.evaluate(() => (window as unknown as { kitClicks: string[] }).kitClicks);
}

function controlAt(page: Page, x: number, y: number): Promise<string | null | undefined> {
  return page.evaluate(
    ([x = 0, y = 0]) => {
      const control = document.elementFromPoint(x, y)?.closest(".ui-button, .ui-icon-button");
      return control?.getAttribute("aria-label") ?? control?.textContent;
    },
    [x, y],
  );
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

    test("a press shows on pointer-down, before the release", async () => {
      const { context, page, seen } = await open(browser, DESKTOP);
      const button = page.getByRole("button", { name: "Press me" });
      const rest = await face(button, "backgroundColor");
      const { x, y } = await middle(button);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await expect.poll(() => face(button, "scale")).toBe(SQUEEZED);
      expect(await face(button, "backgroundColor")).not.toBe(rest);
      expect(await style(button, "transform")).toBe("none");
      await expect(page.getByText("Pressed 0 times")).toBeVisible();
      await page.mouse.up();
      await expect.poll(() => face(button, "scale")).toBe("none");
      await expect(page.getByText("Pressed 1 time", { exact: true })).toBeVisible();

      // The wide one is porcelain: its face darkens to the pressed porcelain.
      const wide = page.getByRole("button", { name: /^Turn on your computer/ });
      const wideRest = await face(wide, "backgroundImage");
      const at = await middle(wide);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await expect.poll(() => face(wide, "backgroundImage")).not.toBe(wideRest);
      await page.waitForTimeout(250);
      expect(await face(wide, "scale")).toBe("none");
      await page.mouse.up();
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("under reduced motion a press darkens without the squeeze", async () => {
      const { context, page, seen } = await open(browser, DESKTOP, "reduce");
      const button = page.getByRole("button", { name: "Press me" });
      const rest = await face(button, "backgroundColor");
      const { x, y } = await middle(button);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await expect.poll(() => face(button, "backgroundColor")).not.toBe(rest);
      await page.waitForTimeout(250);
      expect(await face(button, "scale")).toBe("none");
      expect(await style(button, "transform")).toBe("none");
      // The legacy rule that fades a pressed button would make it a stacking context.
      expect(await style(button, "opacity")).toBe("1");
      await page.mouse.up();
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("an unavailable control keeps focus and gives its reason", async () => {
      const { context, page, seen } = await open(browser, DESKTOP);
      const save = page.getByRole("button", { name: "Save settings" });
      await save.scrollIntoViewIfNeeded();
      await page.getByRole("button", { name: "Press me" }).focus();
      // WebKit, like Safari, tabs only to fields unless Option is held.
      const tab = engine === "webkit" ? "Alt+Tab" : "Tab";
      await page.keyboard.press(tab);
      await page.keyboard.press(tab);
      await expect(save).toBeFocused();
      await expect(save).toHaveAttribute("aria-disabled", "true");
      expect(await save.evaluate((button) => (button as HTMLButtonElement).disabled)).toBe(false);
      await expect(save).toHaveAccessibleDescription(REASON);
      await expect(tooltip(page)).toHaveText(REASON);
      for (const key of ["Enter", " "]) await page.keyboard.press(key);
      await expect(save).toBeFocused();
      await expect(page.getByText("Pressed 0 times")).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(tooltip(page)).toHaveCount(0);
      await page.mouse.move(0, 0);
      await save.click({ force: true });
      await expect(tooltip(page)).toHaveText(REASON);
      await expect(page.getByText("Pressed 0 times")).toBeVisible();
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("a tooltip waits half a second, then follows the pointer along a row at once", async () => {
      const { context, page, seen } = await open(browser, DESKTOP);
      const bar = page.getByRole("toolbar", { name: "Task controls" });
      const stop = bar.getByRole("button", { name: "Stop", exact: true });
      await stop.scrollIntoViewIfNeeded();
      await stop.hover();
      await page.waitForTimeout(250);
      await expect(tooltip(page)).toHaveCount(0);
      await expect(tooltip(page)).toContainText("Stop");
      await bar.getByRole("button", { name: "Pause after this step" }).hover();
      await expect(tooltip(page)).toHaveText("Pause after this step", { timeout: 150 });
      await page.keyboard.press("Escape");
      await expect(tooltip(page)).toHaveCount(0);
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("with touch, every control gives a finger at least 44 px", async () => {
      const { context, page, seen } = await open(browser, PHONE);
      const short = await page.evaluate(() => {
        const misses: string[] = [];
        for (const control of document.querySelectorAll<HTMLElement>(
          ".ui-button:not([data-pressed]), .ui-icon-button:not([data-pressed])",
        )) {
          const box = control.getBoundingClientRect();
          const after = getComputedStyle(control, "::after");
          const inset = (side: "top" | "right" | "bottom" | "left") =>
            Number.parseFloat(after[side]);
          // The ::after sits in the padding box, inside the 1 px border.
          const width = Math.max(box.width, box.width - 2 - inset("left") - inset("right"));
          const height = Math.max(box.height, box.height - 2 - inset("top") - inset("bottom"));
          if (Math.min(width, height) < 44)
            misses.push(
              `${control.getAttribute("aria-label") ?? control.textContent} ${width}x${height}`,
            );
        }
        return misses;
      });
      expect(short).toEqual([]);

      const copy = page.getByRole("button", { name: "Copy, 24 px" });
      await copy.scrollIntoViewIfNeeded();
      await copy.evaluate((button) => {
        button.addEventListener("click", () => {
          button.dataset.tapped = "yes";
        });
      });
      const { x, y } = await middle(copy);
      await page.touchscreen.tap(x - 20, y + 20);
      await expect(copy).toHaveAttribute("data-tapped", "yes");
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("a tap on an unavailable control shows its reason", async () => {
      const { context, page, seen } = await open(browser, PHONE);
      const save = page.getByRole("button", { name: "Save settings" });
      await save.scrollIntoViewIfNeeded();
      await save.tap({ force: true });
      await expect(tooltip(page)).toHaveText(REASON);
      await expect(page.getByText("Pressed 0 times")).toBeVisible();
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("shortcut keys show with a pointer that hovers and hide on a touch screen", async () => {
      for (const [options, visible] of [
        [DESKTOP, true],
        [PHONE, false],
      ] as const) {
        const { context, page, seen } = await open(browser, options);
        const keys = page.getByRole("region", { name: "Keys" }).locator("kbd");
        await expect(keys).toHaveCount(5);
        for (const key of await keys.all()) {
          if (visible) await expect(key).toBeVisible();
          else await expect(key).toBeHidden();
        }
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      }
    });

    test("a neighbour's reach never covers a control's face", async () => {
      for (const options of [DESKTOP, PHONE]) {
        const { context, page, seen } = await open(browser, options);
        expect(await facesMissed(page)).toEqual([]);
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      }
    });

    test("a press just inside a control's edge lands on it, held or repeated", async () => {
      for (const [options, motion] of [
        [DESKTOP, "no-preference"],
        [DESKTOP, "reduce"],
        [PHONE, "no-preference"],
      ] as const) {
        const { context, page, seen } = await open(browser, options, motion);
        const clicks = await recordClicks(page);
        const expected: string[] = [];
        for (const [group, first, second] of [
          ["24 px, 4 px apart", "Pause after this step", "Stop"],
          ["28 px, 4 px apart", "Pause after this step", "Stop"],
          ["Buttons, 4 px apart", "Back", "Next"],
        ] as const) {
          const pair = page.getByRole("toolbar", { name: group });
          await pair.scrollIntoViewIfNeeded();
          const left = await pair.getByRole("button", { name: first }).boundingBox();
          const right = await pair.getByRole("button", { name: second }).boundingBox();
          if (!left || !right) throw new Error(`${group} not on screen`);
          const y = left.y + left.height / 2;
          for (const [x, name] of [
            [left.x + left.width - 1, first],
            [right.x + 1, second],
          ] as const) {
            if (options === PHONE) {
              await page.touchscreen.tap(x, y);
              await page.touchscreen.tap(x, y);
            } else {
              await page.mouse.move(x, y);
              await page.mouse.down();
              expect(await controlAt(page, x, y)).toBe(name);
              await page.mouse.up();
              // Again at once, while the press eases back.
              await page.mouse.click(x, y);
            }
            expected.push(name, name);
            await expect.poll(clicks).toEqual(expected);
          }
        }
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      }
    });

    test("an older screen's button rules do not restyle a kit control", async () => {
      const { context, page, seen } = await open(browser, DESKTOP);
      const button = page.getByRole("button", { name: "Press me" });
      const look = () =>
        button.evaluate((element) => {
          const own = getComputedStyle(element);
          const face = getComputedStyle(element, "::before");
          return [
            own.height,
            own.paddingLeft,
            own.borderRadius,
            own.backgroundColor,
            own.transform,
            own.opacity,
            face.backgroundColor,
          ];
        });
      const before = await look();
      await page.evaluate(() => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(
          "@layer components { .atoms-row button { height: 60px; padding: 0 40px; border-radius: 0; background: rgb(200, 0, 0); transform: rotate(4deg); opacity: 0.5; } }",
        );
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      });
      expect(await look()).toEqual(before);
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("a tooltip stays open while another part of the page scrolls", async () => {
      const { context, page, seen } = await open(browser, DESKTOP);
      await page.evaluate(() => {
        const rail = document.createElement("div");
        rail.dataset.testid = "rail";
        Object.assign(rail.style, {
          position: "fixed",
          top: "0",
          right: "0",
          width: "120px",
          height: "120px",
          overflow: "auto",
        });
        const lines = document.createElement("div");
        lines.style.height = "1200px";
        rail.append(lines);
        document.body.append(rail);
      });
      const stop = page
        .getByRole("toolbar", { name: "Task controls" })
        .getByRole("button", { name: "Stop", exact: true });
      await stop.scrollIntoViewIfNeeded();
      await stop.hover();
      await expect(tooltip(page)).toContainText("Stop");
      await page.getByTestId("rail").evaluate((rail) => {
        rail.scrollTop = 400;
      });
      await page.waitForTimeout(200);
      await expect(tooltip(page)).toContainText("Stop");
      await page.mouse.wheel(0, 120);
      await expect(tooltip(page)).toHaveCount(0);
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("a tooltip stays centred on its trigger when the label changes", async () => {
      const { context, page, seen } = await open(browser, DESKTOP);
      const bar = page.getByRole("toolbar", { name: "Task controls" });
      const pause = bar.getByRole("button", { name: "Pause after this step" });
      await pause.scrollIntoViewIfNeeded();
      await pause.focus();
      await expect(tooltip(page)).toHaveText("Pause after this step");
      await page.keyboard.press("Enter");
      await expect(bar.getByRole("button", { name: "Continue" })).toBeFocused();
      await expect(tooltip(page)).toHaveText("Continue");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const tip = document.querySelector(".ui-tooltip:not([data-closing])");
            const trigger = document.activeElement;
            if (!tip || !trigger) return Number.POSITIVE_INFINITY;
            const a = tip.getBoundingClientRect();
            const b = trigger.getBoundingClientRect();
            return Math.abs(a.left + a.width / 2 - (b.left + b.width / 2));
          }),
        )
        .toBeLessThanOrEqual(1);
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });
  });
