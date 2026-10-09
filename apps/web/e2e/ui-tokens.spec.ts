import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { build } from "vite";
import { serveUi } from "../../daemon/src/static-ui.ts";
import { readTokens } from "../src/testing/tokens.ts";
import { ENGINES } from "./ui-fixture.ts";

// The token layer as the browsers resolve it from the production build: every colour role in each
// appearance and contrast preference, the legacy names on top of them, the base layer's focus ring
// and the reduced-motion durations. Cascade layers decide which declaration wins, so only a real
// build in a real engine shows a later layer overriding a token.
const require = createRequire(new URL("../../daemon/package.json", import.meta.url));
const { Hono } = require("hono") as { Hono: new () => Parameters<typeof serveUi>[0] };
const { getRequestListener } = require("@hono/node-server") as {
  getRequestListener(
    fetch: (request: Request) => Response | Promise<Response>,
  ): Parameters<typeof createServer>[0];
};
const WEB = fileURLToPath(new URL("..", import.meta.url));
const tokensCss = readFileSync(join(WEB, "src/ui/tokens.css"), "utf8");

type Rgba = [number, number, number, number];

let scratch: string;
let server: Server;
let origin: string;

test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  scratch = mkdtempSync(join(tmpdir(), "localdot-ui-tokens-"));
  const dist = join(scratch, "dist");
  await build({
    root: WEB,
    configFile: join(WEB, "vite.config.ts"),
    logLevel: "warn",
    build: { outDir: dist, emptyOutDir: true, sourcemap: false },
  });
  const app = new Hono();
  serveUi(app, dist);
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

function rgba(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16);
    return [n >> 16, (n >> 8) & 255, n & 255, 1];
  }
  const fn = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value);
  if (!fn) throw new Error(`not a colour: ${value}`);
  return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])];
}

// What the page computes for a property set to the given value on a fresh element.
function computed(page: Page, property: string, value: string): Promise<string> {
  return page.evaluate(
    ([property, value]) => {
      const probe = document.createElement("div");
      probe.style.setProperty(property, value);
      document.body.append(probe);
      const out = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return out;
    },
    [property, value] as const,
  );
}

async function expectColour(page: Page, token: string, expected: string) {
  const [r, g, b, a] = rgba(await computed(page, "color", `var(${token})`));
  const [er, eg, eb, ea] = rgba(expected);
  expect([r, g, b], token).toEqual([er, eg, eb]);
  expect(Math.abs(a - ea), `${token} alpha`).toBeLessThan(0.01);
}

async function open(browser: Browser, appearance: "graphite" | "midnight", contrast = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.emulateMedia({ contrast: contrast ? "more" : "no-preference" });
  await page.goto(`${origin}/`);
  await expect(page.getByRole("heading", { name: "Open localDot from Terminal" })).toBeVisible();
  await page.evaluate((value) => {
    document.documentElement.dataset.appearance = value;
  }, appearance);
  return { context, page };
}

for (const [engine, launch] of Object.entries(ENGINES)) {
  test.describe(engine, () => {
    let browser: Browser;
    test.beforeAll(async () => {
      browser = await launch();
    });
    test.afterAll(async () => {
      await browser?.close();
    });

    for (const appearance of ["graphite", "midnight"] as const) {
      for (const contrast of [false, true]) {
        const label = `${appearance}${contrast ? ", more contrast" : ""}`;

        test(`renders every colour token as declared (${label})`, async () => {
          const { context, page } = await open(browser, appearance, contrast);
          const tokens = readTokens([tokensCss], {
            appearance,
            media: contrast ? ["prefers-contrast: more"] : [],
          });
          const colours = [...tokens].filter(([name]) => name.startsWith("--color-"));
          expect(colours.length).toBeGreaterThan(20);
          for (const [name, value] of colours) await expectColour(page, name, value);
          await context.close();
        });

        test(`puts the legacy names on the roles (${label})`, async () => {
          const { context, page } = await open(browser, appearance, contrast);
          for (const [legacy, role] of [
            ["--color-surface", "--color-raised"],
            ["--color-surface-2", "--color-raised-2"],
            ["--color-line", contrast ? "--color-field-line" : "--color-overlay"],
            ["--color-text", "--color-fg-1"],
            ["--color-text-2", "--color-fg-2"],
            ["--color-text-3", "--color-fg-3"],
          ]) {
            expect(await computed(page, "color", `var(${legacy})`), legacy).toBe(
              await computed(page, "color", `var(${role})`),
            );
          }
          const body = await page.evaluate(() => {
            const style = getComputedStyle(document.body);
            return { background: style.backgroundColor, family: style.fontFamily };
          });
          expect(body.background).toBe(await computed(page, "color", "var(--color-void)"));
          expect(body.family).toMatch(/^system-ui, -apple-system/);
          await context.close();
        });

        test(`rings keyboard focus in fg-1 (${label})`, async () => {
          const { context, page } = await open(browser, appearance, contrast);
          // A text field: WebKit on macOS leaves buttons out of the Tab order.
          await page.evaluate(() => {
            const field = document.createElement("input");
            field.setAttribute("aria-label", "Probe");
            document.body.append(field);
          });
          await page.keyboard.press("Tab");
          const ring = await page.evaluate(() => {
            const style = getComputedStyle(document.activeElement as Element);
            return {
              color: style.outlineColor,
              width: style.outlineWidth,
              offset: style.outlineOffset,
            };
          });
          expect(ring.color).toBe(await computed(page, "color", "var(--color-fg-1)"));
          expect(ring.width).toBe(contrast ? "3px" : "2px");
          expect(ring.offset).toBe("2px");
          await context.close();
        });
      }
    }

    test("shortens every transition under reduced motion", async () => {
      const { context, page } = await open(browser, "graphite");
      const durations = [
        "press",
        "hover",
        "fade",
        "exit",
        "sheet-exit",
        "snappy",
        "default",
        "gentle",
      ];
      const read = () =>
        Promise.all(
          durations.map((name) => computed(page, "transition-duration", `var(--dur-${name})`)),
        );
      expect(await read()).toEqual([
        "0.08s",
        "0.12s",
        "0.15s",
        "0.18s",
        "0.28s",
        "0.34s",
        "0.47s",
        "0.67s",
      ]);
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await read()).toEqual([
        "0.12s",
        "0.12s",
        "0.15s",
        "0.15s",
        "0.15s",
        "0.15s",
        "0.15s",
        "0.15s",
      ]);
      await context.close();
    });
  });
}
