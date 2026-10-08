import { expect, test } from "@playwright/test";
import { setupServer } from "./fixtures/setup-server.ts";

test("installer progress hands off once to first-run setup and settings", async ({
  page,
}, info) => {
  const f = await setupServer();
  const errors: string[] = [],
    external: string[] = [],
    violations: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("recordSetupCsp", (directive: string) => violations.push(directive));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void (window as unknown as { recordSetupCsp(value: string): Promise<void> }).recordSetupCsp(
        event.violatedDirective,
      );
    });
  });
  await page.route("**/*", (route) => {
    const origin = new URL(route.request().url()).origin;
    if (origin === f.origin || origin === f.progressOrigin) return route.continue();
    external.push(origin);
    return route.abort();
  });
  try {
    await page.goto(f.url);
    await expect(page.getByRole("heading", { name: "Preparing localDot" })).toBeVisible();
    await expect(page).toHaveURL(`${f.progressOrigin}/`);
    f.channel.report({ role: "desktop", phase: "downloading", currentBytes: 50, totalBytes: 100 });
    await expect(page.locator("#detail")).toHaveText("Downloading Desktop… 50% of this layer");
    await page.screenshot({ path: info.outputPath("install-progress.png") });
    f.channel.starting();
    await expect(page.getByRole("heading", { name: "Starting localDot" })).toBeVisible();
    const link = f.issue();
    f.channel.finish("ready", link);
    await expect(page.getByRole("heading", { name: "Set up localDot" })).toBeVisible();
    await expect(page).toHaveURL(`${f.origin}/`);
    const setupBounds = await page.locator(".welcome-setup").boundingBox();
    expect(setupBounds?.height).toBeGreaterThan((page.viewportSize()?.height ?? 0) * 0.65);
    await page.screenshot({ path: info.outputPath("first-run-setup.png") });
    expect(f.requests.filter((r) => r.path === "/auth/exchange-code")).toHaveLength(1);
    expect(f.requests.filter((r) => r.method !== "GET").map((r) => r.path)).toEqual([
      "/auth/exchange-code",
    ]);
    expect(f.requests.every((r) => r.referrer === null)).toBe(true);
    await page.getByRole("radio", { name: "Midnight" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "midnight");
    await page.getByRole("button", { name: "Review autonomy" }).click();
    const settings = page.getByRole("dialog", { name: "Models and settings" });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("combobox", { name: "Read information" })).toBeFocused();
    await settings.getByRole("button", { name: "Close settings" }).click();
    await expect(page.getByRole("button", { name: "Review autonomy" })).toBeFocused();
    const start = page.locator(".welcome-setup").getByRole("button", { name: "Turn on" });
    await start.scrollIntoViewIfNeeded();
    await expect(start).toBeEnabled();
    const bounds = await start.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.y).toBeGreaterThanOrEqual(0);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(
      page.viewportSize()?.height ?? 0,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath("first-run-footer.png") });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Set up localDot" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "midnight");
    expect(f.requests.filter((r) => r.path === "/auth/exchange-code")).toHaveLength(1);
    const replay = await page.request.post(`${f.origin}/auth/exchange-code`, {
      headers: { origin: f.origin },
      data: { code: new URL(link).hash.slice(6) },
    });
    expect(replay.status()).toBe(401);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    expect(violations).toEqual([]);
  } finally {
    await page.close();
    await f.close();
  }
});

for (const phase of ["failed", "cancelled"] as const) {
  test(`installer ${phase} stays on its terminal guidance`, async ({ page }) => {
    const f = await setupServer();
    try {
      await page.goto(f.url);
      f.channel.finish(phase);
      await expect(
        page.getByRole("heading", {
          name: phase === "failed" ? "Setup needs attention" : "Setup interrupted",
        }),
      ).toBeVisible();
      await expect(page).toHaveURL(`${f.progressOrigin}/`);
      expect(f.requests).toEqual([]);
    } finally {
      await page.close();
      await f.close();
    }
  });
}

test("a progress page without its capability cannot read status or open the workspace", async ({
  page,
}) => {
  const f = await setupServer();
  try {
    f.channel.finish("ready", f.issue());
    await page.goto(f.progressOrigin);
    await expect(page.getByRole("heading", { name: "Return to your terminal" })).toBeVisible();
    expect((await page.request.get(`${f.progressOrigin}/status`)).status()).toBe(404);
    expect(f.requests).toEqual([]);
  } finally {
    await page.close();
    await f.close();
  }
});
