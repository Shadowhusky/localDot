import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { progressChannel } from "../../../cli/src/install/browser-progress.ts";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { expect, keepBaselinesAt, test } from "./harness.ts";

// Everything before the first task: the installer's page, signing in and first run.
keepBaselinesAt("c14", "w39");

const box = (page: Page, selector: string) => page.locator(selector).first().boundingBox();

test("first run", async ({ page, ui }) => {
  await ui.open("first-run");
  await expect(page.getByRole("heading", { name: "Set up localDot" })).toBeVisible();
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("first-run.png");
});

test("first run, model ready", async ({ page, ui }) => {
  await ui.open("model-ready");
  await expect(page.getByText("Anthropic · claude-sonnet-5-5", { exact: true })).toBeVisible();
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("first-run-model-ready.png");
});

test("first run shows Turn on without scrolling and keeps the stage where the computer appears", async ({
  page,
  ui,
}) => {
  await ui.open("first-run");
  const turnOn = page.locator(".welcome-setup").getByRole("button", { name: "Turn on" });
  await expect(turnOn).toBeVisible();
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const button = await turnOn.boundingBox();
  expect(button && button.y + button.height <= viewport.height).toBe(true);
  expect(await turnOn.evaluate((element) => element.closest(".ui-scroll-area"))).toBeNull();
  const scrollers = await page
    .locator(".welcome-setup *")
    .evaluateAll(
      (all) =>
        all.filter((element) => /auto|scroll/.test(getComputedStyle(element).overflowY)).length,
    );
  expect(scrollers).toBe(1);
  if (viewport.width < 760) return;
  const before = await box(page, ".stage");
  expect(await box(page, ".welcome-setup")).toEqual(before);
  expect((before?.width ?? 0) / (before?.height ?? 1)).toBeCloseTo(1.6, 2);
  await turnOn.click();
  await expect(page.locator(".welcome-setup")).toHaveCount(0);
  expect(await box(page, ".stage")).toEqual(before);
});

test("sign-in, first visit", async ({ page, ui }) => {
  await ui.open("first-run", undefined, "");
  await expect(page.getByRole("heading", { name: "Open localDot from Terminal" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("signin-first.png");
});

test("sign-in, checking", async ({ page, ui }) => {
  await page.route("**/api/whoami", () => {});
  await ui.open("first-run", undefined, `#token=${TOKEN}`);
  await expect(page.getByRole("status")).toHaveText("Signing you in…");
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("signin-checking.png");
});

test("sign-in, rejected", async ({ page, ui }) => {
  await ui.open("first-run", undefined, `#code=${"z".repeat(43)}`);
  await expect(page.getByRole("alert")).toHaveText(
    "That link has expired or was already used. Run this for a fresh one:",
  );
  await ui.settle();
  await ui.still();
  await expect(page).toHaveScreenshot("signin-rejected.png");
});

// The CLI serves this page before the app exists, from its own server and under its own policy.
async function installer(page: Page) {
  const capability = "p".repeat(43);
  const channel = progressChannel(capability, 4750);
  let origin = "";
  const server = createServer((request, response) => channel.handle(origin, request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.exposeFunction("recordInstallerCsp", (text: string) => problems.push(text));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      // WebKit reports the stylesheet Playwright adds to take a screenshot, with no source file.
      if (event.violatedDirective === "style-src-elem" && !event.sourceFile) return;
      void (
        window as unknown as { recordInstallerCsp(text: string): Promise<void> }
      ).recordInstallerCsp(`${event.violatedDirective} ${event.sourceFile}`);
    });
  });
  await page.goto(`${origin}/#progress=${capability}`);
  return {
    channel,
    problems,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("installer progress", async ({ page }) => {
  const f = await installer(page);
  try {
    f.channel.report({ role: "desktop", phase: "ready" });
    f.channel.report({
      role: "gate",
      phase: "downloading",
      layer: "a",
      currentBytes: 48,
      totalBytes: 100,
    });
    await expect(page.locator("#images-value")).toHaveText("37%");
    await expect(page.locator("#detail")).toHaveText("Downloading the network gate image…");
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "37");
    await expect(page).toHaveScreenshot("installer-progress.png");
    expect(f.problems).toEqual([]);
  } finally {
    await f.close();
  }
});

test("installer failed", async ({ page }) => {
  const f = await installer(page);
  try {
    f.channel.starting();
    await expect(page.getByRole("heading", { name: "Starting localDot" })).toBeVisible();
    f.channel.finish("failed");
    await expect(page.getByRole("heading", { name: "Setup stopped" })).toBeVisible();
    await expect(page.locator("#resume")).toBeVisible();
    await expect(page).toHaveScreenshot("installer-failed.png");
    expect(f.problems).toEqual([]);
  } finally {
    await f.close();
  }
});
