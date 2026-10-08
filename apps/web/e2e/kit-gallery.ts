import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import { build } from "vite";
import { serveUi } from "../../daemon/src/static-ui.ts";

// The kit gallery, built and served by the daemon's own static route, so its pages run under the
// production CSP. Screenshots stay out of these specs: WebKit's inject a <style> the CSP reports.
const require = createRequire(new URL("../../daemon/package.json", import.meta.url));
const { Hono } = require("hono") as { Hono: new () => Parameters<typeof serveUi>[0] };
const { getRequestListener } = require("@hono/node-server") as {
  getRequestListener(
    fetch: (request: Request) => Response | Promise<Response>,
  ): Parameters<typeof createServer>[0];
};
const WEB = fileURLToPath(new URL("..", import.meta.url));

export const DESKTOP = { viewport: { width: 1440, height: 900 } };
export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

export interface Seen {
  violations: string[];
  styles: number;
}

export async function startKitGallery(): Promise<{ origin: string; stop(): Promise<void> }> {
  const scratch = mkdtempSync(join(tmpdir(), "localdot-kit-gallery-"));
  await build({
    configFile: join(WEB, "vite.kit-gallery.config.ts"),
    logLevel: "warn",
    build: { outDir: scratch, emptyOutDir: true, sourcemap: false },
  });
  const app = new Hono();
  serveUi(app, scratch);
  const server = createServer(getRequestListener((request) => app.fetch(request)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

// Opens a gallery page and watches it for CSP violations and inserted <style> elements.
export async function openKitPage(
  browser: Browser,
  url: string,
  heading: string,
  options: typeof DESKTOP | typeof PHONE,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
): Promise<{ context: BrowserContext; page: Page; seen: () => Promise<Seen> }> {
  const context = await browser.newContext({ ...options, reducedMotion });
  await context.addInitScript(() => {
    const seen = { violations: [] as string[], styles: 0 };
    (window as unknown as { kitSeen: typeof seen }).kitSeen = seen;
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
  await page.goto(url);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  const seen = async () => {
    expect(errors).toEqual([]);
    return page.evaluate(() => (window as unknown as { kitSeen: Seen }).kitSeen);
  };
  return { context, page, seen };
}
