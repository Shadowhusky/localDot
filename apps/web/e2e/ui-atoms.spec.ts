import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { build } from "vite";
import { serveUi } from "../../daemon/src/static-ui.ts";
import { ENGINES } from "./ui-fixture.ts";

// The T06 atoms in the kit gallery, served by the daemon's own static route so they run under the
// production CSP, in Chrome and WebKit. No screenshots: WebKit's inject a <style> the CSP reports.
const require = createRequire(new URL("../../daemon/package.json", import.meta.url));
const { Hono } = require("hono") as { Hono: new () => Parameters<typeof serveUi>[0] };
const { getRequestListener } = require("@hono/node-server") as {
  getRequestListener(
    fetch: (request: Request) => Response | Promise<Response>,
  ): Parameters<typeof createServer>[0];
};
const WEB = fileURLToPath(new URL("..", import.meta.url));
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const SQUEEZED = "matrix(0.97, 0, 0, 0.97, 0, 0)";
const REASON = "Choose a main provider and model";

interface Seen {
  violations: string[];
  styles: number;
}

let scratch: string;
let server: Server;
let origin: string;

test.use({ actionTimeout: 10_000, navigationTimeout: 10_000 });
test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  scratch = mkdtempSync(join(tmpdir(), "localdot-kit-atoms-"));
  await build({
    configFile: join(WEB, "vite.gallery.config.ts"),
    logLevel: "warn",
    build: { outDir: scratch, emptyOutDir: true, sourcemap: false },
  });
  const app = new Hono();
  serveUi(app, scratch);
  server = createServer(getRequestListener((request) => app.fetch(request)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
});

async function open(
  browser: Browser,
  options: typeof DESKTOP | typeof PHONE,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
): Promise<{ context: BrowserContext; page: Page; seen: () => Promise<Seen> }> {
  const context = await browser.newContext({ ...options, reducedMotion });
  await context.addInitScript(() => {
    const seen = { violations: [] as string[], styles: 0 };
    (window as unknown as { kitAtoms: typeof seen }).kitAtoms = seen;
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
  await page.goto(`${origin}/`);
  await expect(page.getByRole("heading", { name: "Actions and atoms" })).toBeVisible();
  const seen = async () => {
    expect(errors).toEqual([]);
    return page.evaluate(() => (window as unknown as { kitAtoms: Seen }).kitAtoms);
  };
  return { context, page, seen };
}

function style(locator: Locator, property: "transform" | "backgroundColor"): Promise<string> {
  return locator.evaluate((element, name) => getComputedStyle(element)[name], property);
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
      const rest = await style(button, "backgroundColor");
      const { x, y } = await middle(button);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await expect.poll(() => style(button, "transform")).toBe(SQUEEZED);
      expect(await style(button, "backgroundColor")).not.toBe(rest);
      await expect(page.getByText("Pressed 0 times")).toBeVisible();
      await page.mouse.up();
      await expect.poll(() => style(button, "transform")).toBe("none");
      await expect(page.getByText("Pressed 1 time", { exact: true })).toBeVisible();

      const wide = page.getByRole("button", { name: /^Turn on your computer/ });
      const wideRest = await style(wide, "backgroundColor");
      const at = await middle(wide);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await expect.poll(() => style(wide, "backgroundColor")).not.toBe(wideRest);
      await page.waitForTimeout(250);
      expect(await style(wide, "transform")).toBe("none");
      await page.mouse.up();
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("under reduced motion a press darkens without the squeeze", async () => {
      const { context, page, seen } = await open(browser, DESKTOP, "reduce");
      const button = page.getByRole("button", { name: "Press me" });
      const rest = await style(button, "backgroundColor");
      const { x, y } = await middle(button);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await expect.poll(() => style(button, "backgroundColor")).not.toBe(rest);
      await page.waitForTimeout(250);
      expect(await style(button, "transform")).toBe("none");
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
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      await stop.scrollIntoViewIfNeeded();
      await stop.hover();
      await page.waitForTimeout(250);
      await expect(tooltip(page)).toHaveCount(0);
      await expect(tooltip(page)).toContainText("Stop");
      await page.getByRole("button", { name: "Pause after this step" }).hover();
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
  });
