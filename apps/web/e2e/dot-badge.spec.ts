import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// The real daemon app over a fake computer (fixtures/ui-server.ts) serving the built UI with its
// production CSP, so the badge's plates, styles and SVG run under the policy users get.
const TOKEN = "a".repeat(43);
let fixture: ChildProcess;
let origin: string;
let home: string;

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function qa(path: string): Promise<void> {
  const res = await fetch(`${origin}/__qa/${path}`, { method: "POST" });
  expect(res.ok).toBe(true);
}

async function openTheatre(page: Page) {
  const violations: string[] = [];
  const errors: string[] = [];
  const plates: string[] = [];
  await page.exposeFunction("reportViolation", (v: string) => violations.push(v));
  await page.addInitScript((token) => {
    localStorage.setItem("localdot.token", token);
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { reportViolation(v: string): void }).reportViolation(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  }, TOKEN);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    const name = new URL(r.url()).pathname.split("/").pop() ?? "";
    if (name.endsWith(".webp")) plates.push(name);
  });
  await page.goto(`${origin}/`);
  return { violations, errors, plates };
}

test.setTimeout(60_000);

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "localdot-dot-badge-"));
  fixture = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./fixtures/ui-server.ts", import.meta.url))],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, QA_PORT: String(await freePort()), QA_HOME: join(home, "home") },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  for await (const line of createInterface({ input: fixture.stdout as NodeJS.ReadableStream })) {
    if (!line.startsWith("{")) continue;
    const ready = JSON.parse(line) as { ready?: boolean; origin?: string };
    if (ready.ready && ready.origin) {
      origin = ready.origin;
      break;
    }
  }
  if (!origin) throw new Error("the fixture daemon never became ready");
  fixture.stdout?.resume();
});

test.afterAll(async () => {
  if (fixture.exitCode === null) {
    fixture.kill("SIGTERM");
    await once(fixture, "exit");
  }
  rmSync(home, { recursive: true, force: true });
});

test("the HUD shows dot's live badge, loading the xenon and dim plates only when they show", async ({
  page,
}) => {
  await qa("cell/paused");
  const { violations, errors, plates } = await openTheatre(page);
  const badge = page.locator(".hud .mascot > .dot");
  await expect(badge).toHaveAttribute("data-lod", "badge");
  await expect(badge).toHaveAttribute("data-skin", "plate");
  expect(await badge.boundingBox()).toMatchObject({ width: 24, height: 24 });
  expect(await page.locator(".hud .mascot").boundingBox()).toMatchObject({ width: 18, height: 18 });
  await expect(page.locator(".brand .mascot > svg.dot-glyph")).toBeVisible();
  expect(plates.filter((p) => p.startsWith("body-"))).toEqual([
    expect.stringMatching(/^body-neutral-48-/),
  ]);

  // Back from pause, dot has control again: the xenon plate crossfades in.
  await qa("cell/live");
  await expect(page.locator(".app")).toHaveClass(/\bcontrol\b/);
  await expect.poll(() => plates.some((p) => p.startsWith("body-xenon-48-"))).toBe(true);
  await expect
    .poll(() =>
      page.locator(".hud .dot-plate-xenon").evaluate((img) => getComputedStyle(img).opacity),
    )
    .toBe("1");
  expect(plates.some((p) => p.startsWith("body-dim-"))).toBe(false);
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("the badge falls back to the SVG body when a plate cannot load", async ({ page }) => {
  await page.route("**/assets/body-*.webp", (route) => route.abort());
  const { violations, errors } = await openTheatre(page);
  const badge = page.locator(".hud .mascot > .dot");
  await expect(badge).toHaveAttribute("data-skin", "svg");
  await expect(badge.locator(".dot-flat")).toBeVisible();
  await expect(badge.locator(".dot-plate-neutral")).toBeHidden();
  await expect(badge.locator(".dot-eye")).toHaveCount(2);
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});
