import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

// T02 gates for the Tailwind + Base UI stack: the kit spike gallery, served by the daemon's own
// static route so it runs under the production CSP, in Chrome and WebKit. Nothing here takes a
// screenshot: Playwright's WebKit screenshots inject a <style> the CSP reports.
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
  scratch = mkdtempSync(join(tmpdir(), "localdot-kit-spike-"));
  const gallery = join(scratch, "gallery");
  await build({
    configFile: join(WEB, "vite.spike.config.ts"),
    logLevel: "warn",
    build: { outDir: gallery, emptyOutDir: true, sourcemap: false },
  });
  const app = new Hono();
  serveUi(app, gallery);
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
  query = "",
): Promise<{ context: BrowserContext; page: Page; seen: () => Promise<Seen> }> {
  const context = await browser.newContext(options);
  await context.addInitScript(() => {
    const seen = { violations: [] as string[], styles: 0 };
    (window as unknown as { kitSpike: typeof seen }).kitSpike = seen;
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
  await page.goto(`${origin}/${query}`);
  await expect(page.getByRole("heading", { name: "Kit spike" })).toBeVisible();
  const seen = async () => {
    expect(errors).toEqual([]);
    return page.evaluate(() => (window as unknown as { kitSpike: Seen }).kitSpike);
  };
  return { context, page, seen };
}

function listbox(page: Page): Locator {
  return page.getByRole("listbox");
}

async function exerciseEveryOverlay(page: Page, phone: boolean) {
  const press = (locator: Locator) => (phone ? locator.tap() : locator.click());
  const dismiss = async (popup: Locator) => {
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
  };

  await press(page.getByRole("combobox", { name: "Playback speed" }));
  await expect(listbox(page)).toBeVisible();
  await dismiss(listbox(page));

  const model = page.getByRole("combobox", { name: "Model" });
  await press(model);
  await expect(listbox(page)).toBeVisible();
  await model.fill("son");
  await expect(listbox(page).getByRole("option")).toHaveText(["sonnet-5-5", "sonnet-5"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(model).toHaveValue("sonnet-5-5");

  await press(page.getByRole("button", { name: "Details" }));
  await dismiss(page.getByRole("dialog", { name: "Recorded on this Mac" }));

  await press(page.getByRole("button", { name: "More" }));
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await dismiss(page.getByRole("menu"));

  if (!phone) {
    await page.getByRole("button", { name: "Copy link" }).hover();
    await expect(page.getByText("Copies a link to this replay")).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page.getByText("Copies a link to this replay")).toBeHidden();
  }

  await press(page.getByRole("button", { name: "Delete recording" }));
  const confirm = page.getByRole("dialog", { name: "Delete this recording?" });
  await press(confirm.getByRole("button", { name: "Delete" }));
  await expect(confirm).toBeHidden();
  await expect(page.getByText("Recording deleted")).toBeVisible();

  await press(page.getByRole("button", { name: "Open settings" }));
  const sheet = page.getByRole("dialog", { name: "Settings" });
  await press(sheet.getByRole("combobox", { name: "When to ask" }));
  await dismiss(listbox(page));
  await dismiss(sheet);

  await press(page.getByRole("button", { name: "Open playback options" }));
  await dismiss(page.getByRole("dialog", { name: "Playback" }));

  await press(page.getByRole("button", { name: "Save settings" }));
  await expect(page.getByText("Settings saved")).toBeVisible();
}

// Where the page is, judged by an element's place on screen: Base UI may lock either the root or
// the body, and the inset-scrollbar lock scrolls the body instead of the window. (A role query would
// wait forever here: an open modal hides the page from the accessibility tree.)
function headingTop(page: Page): Promise<number> {
  return page.locator("h1").evaluate((h) => h.getBoundingClientRect().top);
}

// Everything inside a layer's blocks, braces matched; empty when the layer is only declared.
function layerRules(css: string, name: string): string {
  const head = `@layer ${name}{`;
  let rules = "";
  for (let start = css.indexOf(head); start >= 0; start = css.indexOf(head, start + 1)) {
    let depth = 0;
    let at = start + head.length - 1;
    do {
      if (css[at] === "{") depth++;
      else if (css[at] === "}") depth--;
      at++;
    } while (depth > 0 && at < css.length);
    if (depth > 0) throw new Error(`unclosed @layer ${name}`);
    rules += css.slice(start + head.length, at - 1);
  }
  return rules;
}

function classNames(css: string): Set<string> {
  return new Set(
    [...css.matchAll(/\.(-?[A-Za-z_](?:\\.|[\w-])*)/g)].map((match) => match[1] as string),
  );
}

test("the production build orders the layers with the legacy styles in components", async () => {
  const out = join(scratch, "dist");
  await build({
    root: WEB,
    configFile: join(WEB, "vite.config.ts"),
    logLevel: "warn",
    build: { outDir: out, emptyOutDir: true, sourcemap: false },
  });
  const assets = join(out, "assets");
  const sheets = readdirSync(assets).filter((name) => name.endsWith(".css"));
  expect(sheets).toHaveLength(1);
  const css = readFileSync(join(assets, sheets[0] as string), "utf8");
  const order = [...css.matchAll(/@layer ([a-z, ]+?) ?[;{]/g)].flatMap((match) =>
    (match[1] as string).split(/, ?/),
  );
  expect([...new Set(order)].filter((name) => name !== "properties")).toEqual([
    "theme",
    "base",
    "components",
    "utilities",
  ]);
  expect(layerRules(css, "components")).toContain(".app{");
  expect(css).not.toContain("--rails-collapse");
  const legacy = classNames(layerRules(css, "components"));
  expect([...classNames(layerRules(css, "utilities"))].filter((name) => legacy.has(name))).toEqual(
    [],
  );
  for (const name of readdirSync(assets)) {
    const text = readFileSync(join(assets, name), "latin1");
    expect(text, name).not.toContain("Kit spike");
    expect(text, name).not.toContain("base-ui-disable-scrollbar");
  }
});

for (const [engine, launch] of Object.entries(ENGINES))
  test.describe(engine, () => {
    let browser: Browser;
    test.beforeAll(async () => {
      browser = await launch();
    });
    test.afterAll(async () => {
      await browser?.close();
    });

    test("every overlay opens and closes under the production CSP", async () => {
      for (const [options, phone] of [
        [DESKTOP, false],
        [PHONE, true],
      ] as const) {
        const { context, page, seen } = await open(browser, options);
        await exerciseEveryOverlay(page, phone);
        expect(await seen()).toEqual({ violations: [], styles: 0 });
        await context.close();
      }
    });

    test("the check would catch Base UI's own style element", async () => {
      const { context, page, seen } = await open(browser, DESKTOP, "?inline-styles");
      await page.getByRole("combobox", { name: "Playback speed" }).click();
      await expect(listbox(page)).toBeVisible();
      await expect.poll(async () => (await seen()).violations.length).toBeGreaterThan(0);
      expect((await seen()).styles).toBeGreaterThan(0);
      await context.close();
    });

    test("a dialog locks the page scroll through inline styles only", async () => {
      const { context, page, seen } = await open(browser, DESKTOP);
      await page.mouse.move(720, 450);
      await page.mouse.wheel(0, 400);
      await expect.poll(() => headingTop(page)).toBeLessThan(-300);
      const before = await headingTop(page);
      await page.getByRole("button", { name: "Delete recording" }).click();
      const dialog = page.getByRole("dialog", { name: "Delete this recording?" });
      await expect(dialog).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() =>
            [document.documentElement, document.body].some((element) =>
              /hidden|clip/.test(getComputedStyle(element).overflowY),
            ),
          ),
        )
        .toBe(true);
      await page.mouse.move(100, 450);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(300);
      expect(await headingTop(page)).toBe(before);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect.poll(() => headingTop(page)).toBe(before);
      await page.mouse.wheel(0, 300);
      await expect.poll(() => headingTop(page)).toBeLessThan(before);
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("dialog, sheet and bottom sheet trap focus and return it to the trigger", async () => {
      const { context, page, seen } = await open(browser, DESKTOP);
      await page.locator("main").evaluate((main) => {
        (window as unknown as { escaped: number }).escaped = 0;
        main.addEventListener("focusin", () => {
          (window as unknown as { escaped: number }).escaped++;
        });
      });
      const escaped = () => page.evaluate(() => (window as unknown as { escaped: number }).escaped);
      for (const [trigger, name] of [
        ["Delete recording", "Delete this recording?"],
        ["Open settings", "Settings"],
        ["Open playback options", "Playback"],
      ]) {
        const button = page.getByRole("button", { name: trigger });
        await button.focus();
        const before = await escaped();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name });
        await expect(dialog).toBeVisible();
        // Wrapping passes through Base UI's focus guards, beside the popup, for a moment.
        const inside = () => dialog.evaluate((d) => d.contains(document.activeElement));
        await expect.poll(inside).toBe(true);
        for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
          await page.keyboard.press(key);
          await expect.poll(inside, `${name} after ${key}`).toBe(true);
        }
        expect(await escaped(), `${name} let focus reach the page`).toBe(before);
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(button).toBeFocused();
      }
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("at 390 with touch, a tapped option commits without reaching what lies under the list", async () => {
      const { context, page, seen } = await open(browser, PHONE);
      const trigger = page.getByRole("combobox", { name: "Playback speed" });
      const under = page.getByRole("button", { name: /^Under the list/ });
      await trigger.tap();
      await expect(listbox(page)).toBeVisible();
      const target = await under.boundingBox();
      if (!target) throw new Error("no button under the list");
      let covering: Locator | undefined;
      for (const option of await listbox(page).getByRole("option").all()) {
        const box = await option.boundingBox();
        const middle = target.y + target.height / 2;
        if (
          box &&
          box.y < middle &&
          box.y + box.height > middle &&
          (await option.textContent()) !== "1×"
        )
          covering = option;
      }
      if (!covering) throw new Error("no option covers the button under the list");
      const label = (await covering.textContent()) ?? "";
      await covering.tap();
      await expect(listbox(page)).toBeHidden();
      await expect(trigger).toHaveText(label);
      await page.waitForTimeout(500);
      await expect(under).toHaveText("Under the list · pressed 0");
      await under.tap();
      await expect(under).toHaveText("Under the list · pressed 1");
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });

    test("at 390 with touch, Escape and taps outside the list close only the list in a sheet", async () => {
      const { context, page, seen } = await open(browser, PHONE);
      await page.getByRole("button", { name: "Open settings" }).tap();
      const sheet = page.getByRole("dialog", { name: "Settings" });
      const note = sheet.getByRole("textbox", { name: "Task note" });
      await note.fill("Check the totals");
      const ask = sheet.getByRole("combobox", { name: "When to ask" });
      const stillOpen = async () => {
        await expect(listbox(page)).toBeHidden();
        await expect(sheet).toBeVisible();
        await expect(note).toHaveValue("Check the totals");
        await expect(ask).toHaveText("Ask before risky actions");
      };

      await ask.tap();
      await expect(listbox(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await stillOpen();

      await ask.tap();
      await expect(listbox(page)).toBeVisible();
      await sheet.getByText("Choices here apply to the next task.").tap();
      await stillOpen();

      await ask.tap();
      await expect(listbox(page)).toBeVisible();
      await page.touchscreen.tap(3, 600);
      await stillOpen();

      // The same tap with no list open does reach the dim area and closes the sheet.
      await page.touchscreen.tap(3, 600);
      await expect(sheet).toBeHidden();
      expect(await seen()).toEqual({ violations: [], styles: 0 });
      await context.close();
    });
  });
