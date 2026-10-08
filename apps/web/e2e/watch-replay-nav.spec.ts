import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test, webkit } from "@playwright/test";

const TOKEN = "a".repeat(43);
const WEB = fileURLToPath(new URL("..", import.meta.url));

interface Fixture {
  origin: string;
  seeded: string[];
  close(): Promise<void>;
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (!address || typeof address === "string") throw new Error("No free port");
  return address.port;
}

async function startFixture(): Promise<Fixture> {
  const port = process.env.QA_PORT ? Number(process.env.QA_PORT) : await freePort();
  const home = mkdtempSync(join(tmpdir(), "localdot-nav-"));
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "e2e/fixtures/ui-server.ts"],
    { cwd: WEB, env: { ...process.env, QA_PORT: String(port), QA_HOME: home } },
  );
  const ready = await new Promise<{ origin: string; seeded: string[] }>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n").find((entry) => entry.includes('"ready":true'));
      if (line) resolve(JSON.parse(line));
    });
    child.once("exit", (code) => reject(new Error(`Fixture exited with ${code}`)));
  });
  return {
    ...ready,
    async close() {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

type Engine = "chrome" | "webkit";

async function phonePage(browser: Browser, width: number) {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  return context.newPage();
}

const modes = (page: Page) => page.getByRole("navigation", { name: "Mode" });

// The 44 px touch target may extend past the visible segment, so probe the hit area itself.
async function hitHeight(page: Page, name: string) {
  return modes(page)
    .getByRole("button", { name, exact: true })
    .evaluate((button) => {
      const box = button.getBoundingClientRect();
      const x = box.left + box.width / 2;
      let top = box.top + box.height / 2;
      while (top > 0 && button.contains(document.elementFromPoint(x, top - 1))) top--;
      let bottom = box.top + box.height / 2;
      while (button.contains(document.elementFromPoint(x, bottom + 1))) bottom++;
      return bottom - top + 1;
    });
}

let fixture: Fixture;
test.beforeAll(async () => {
  fixture = await startFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});
test.setTimeout(90_000);

for (const engine of ["chrome", "webkit"] as const satisfies Engine[])
  for (const width of [390, 759])
    test(`Watch and Replay stay reachable on a ${width} px ${engine} phone`, async ({
      browser,
    }) => {
      const owned = engine === "webkit" ? await webkit.launch({ channel: undefined }) : null;
      const page = await phonePage(owned ?? browser, width);
      try {
        await page.goto(`${fixture.origin}/#token=${TOKEN}`);
        const watch = modes(page).getByRole("button", { name: "Watch", exact: true });
        const replay = modes(page).getByRole("button", { name: "Replay", exact: true });
        await expect(watch).toBeVisible();
        await expect(replay).toBeEnabled();
        await expect(replay).toBeVisible();
        await expect(modes(page).getByText("Glance")).toHaveCount(0);
        expect(await hitHeight(page, "Watch")).toBeGreaterThanOrEqual(44);
        expect(await hitHeight(page, "Replay")).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await replay.tap();
        await expect(page).toHaveURL(/[?&]replay=/);
        await expect(replay).toHaveAttribute("aria-current", "page");
        await watch.tap();
        await expect(page).not.toHaveURL(/[?&]replay=/);
        await expect(watch).toHaveAttribute("aria-current", "page");
      } finally {
        await page.context().close();
        await owned?.close();
      }
    });
