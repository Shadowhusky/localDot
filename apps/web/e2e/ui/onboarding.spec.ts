import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { progressChannel } from "../../../cli/src/install/browser-progress.ts";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { expect, runAt, test } from "./harness.ts";

// Everything before the first task: the installer's page, signing in and first run.
runAt("c14", "w39");

const box = (page: Page, selector: string) => page.locator(selector).first().boundingBox();

test("first run", async ({ page, ui }) => {
  await ui.open("first-run");
  await expect(page.getByRole("heading", { name: "Your computer is off" })).toBeVisible();
  await ui.settle();
  await ui.still();
});

test("first run, model ready", async ({ page, ui }) => {
  await ui.open("model-ready");
  await expect(page.getByRole("heading", { name: "Your computer is off" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Finish setting up" })).toHaveCount(0);
  await ui.settle();
  await ui.still();
});

test("first run shows Turn on without scrolling and keeps the stage where the computer appears", async ({
  page,
  ui,
}) => {
  await ui.open("first-run");
  const turnOn = page.locator(".curtain").getByRole("button", { name: "Turn on" });
  await expect(turnOn).toBeVisible();
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const button = await turnOn.boundingBox();
  expect(button && button.y + button.height <= viewport.height).toBe(true);
  expect(await turnOn.evaluate((element) => element.closest(".ui-scroll-area"))).toBeNull();
  const scrollers = await page
    .locator(".curtain *")
    .evaluateAll(
      (all) =>
        all.filter((element) => /auto|scroll/.test(getComputedStyle(element).overflowY)).length,
    );
  expect(scrollers).toBe(0);
  const before = await box(page, ".stage");
  expect((before?.width ?? 0) / (before?.height ?? 1)).toBeCloseTo(1.6, 2);
  const setup = await box(page, ".curtain");
  // Over the stage on a wide screen; over the stage and the band under it on a phone.
  if (viewport.width >= 700) expect(setup).toEqual(before);
  else expect(setup).toEqual(await box(page, ".stage-frame"));
  await turnOn.click();
  await expect(turnOn).toHaveAttribute("aria-hidden", "true");
  expect(await box(page, ".stage")).toEqual(before);
});

test("sign-in, first visit", async ({ page, ui }) => {
  await ui.open("first-run", undefined, "");
  await expect(page.getByRole("heading", { name: "Open localDot from Terminal" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await ui.settle();
  await ui.still();
});

test("sign-in, checking", async ({ page, ui }) => {
  await page.route("**/api/whoami", () => {});
  await ui.open("first-run", undefined, `#token=${TOKEN}`);
  await expect(page.getByRole("status")).toHaveText("Signing you in…");
  await ui.settle();
  await ui.still();
});

test("sign-in, rejected", async ({ page, ui }) => {
  await ui.open("first-run", undefined, `#code=${"z".repeat(43)}`);
  await expect(page.getByRole("alert")).toHaveText(
    "That link has expired or was already used. Run this for a fresh one:",
  );
  await ui.settle();
  await ui.still();
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
    expect(f.problems).toEqual([]);
  } finally {
    await f.close();
  }
});

// The widest the fill is drawn, as a share of the bar, over the next two seconds of frames while
// the bar shows a share rather than its sweep.
function widestFill(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const bar = document.querySelector("#bar") as HTMLElement;
        const fill = document.querySelector("#fill") as HTMLElement;
        const end = performance.now() + 2000;
        let widest = 0;
        const frame = () => {
          if (!bar.hasAttribute("data-indeterminate"))
            widest = Math.max(
              widest,
              fill.getBoundingClientRect().width / bar.getBoundingClientRect().width,
            );
          if (performance.now() < end) requestAnimationFrame(frame);
          else resolve(widest);
        };
        requestAnimationFrame(frame);
      }),
  );
}

test.describe("installer bar in motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("goes from the sweep straight to its share", async ({ page }) => {
    const f = await installer(page);
    try {
      await expect(page.locator("#bar")).toHaveAttribute("data-indeterminate", "");
      const widest = widestFill(page);
      f.channel.report({ role: "desktop", phase: "ready" });
      f.channel.report({
        role: "gate",
        phase: "downloading",
        layer: "a",
        currentBytes: 48,
        totalBytes: 100,
      });
      expect(await widest).toBeLessThanOrEqual(0.375);
      await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "37");
      expect(f.problems).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test("stops from the sweep without filling the bar", async ({ page }) => {
    const f = await installer(page);
    try {
      await expect(page.locator("#bar")).toHaveAttribute("data-indeterminate", "");
      const widest = widestFill(page);
      f.channel.finish("failed");
      expect(await widest).toBeLessThanOrEqual(0.005);
      await expect(page.getByRole("heading", { name: "Setup stopped" })).toBeVisible();
      expect(f.problems).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
