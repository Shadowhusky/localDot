import { openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test("app links show local and Tailscale access without enabling the relay", async ({
  page,
  ui,
}) => {
  if (test.info().project.name !== "c14") await page.setViewportSize({ width: 320, height: 640 });
  let issued = 0;
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/access-links", (route) =>
    route.fulfill({
      json: {
        links: [
          {
            origin: "http://localhost:4750",
            label: "This computer",
            description: "Works only on the computer running localDot.",
          },
          {
            origin: "https://richards-mac-studio.tail849a6b.ts.net:4750",
            label: "Tailscale",
            description: "Connect your other device to the same Tailscale network.",
          },
        ],
      },
    }),
  );
  await page.route("**/api/install-code", async (route) => {
    issued++;
    await response;
    return route.fulfill({
      json: { code: "a".repeat(43), expiresAt: Date.parse("2026-10-08T09:01:02Z") },
    });
  });
  await ui.open("ready");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    });
    Object.defineProperty(window, "ClipboardItem", { configurable: true, value: undefined });
  });
  const sheet = await openSettings(page, undefined, "Your computer");
  const copy = sheet.getByRole("button", { name: "Copy tailscale link" });
  await copy.scrollIntoViewIfNeeded();
  await expect(copy).toBeVisible();
  expect(issued).toBe(0);
  await ui.settle();
  const geometry = () =>
    sheet.evaluate((root) => {
      const selectors = [".ui-sheet-header", ".settings-remote-action", ".settings-section"];
      return selectors.flatMap((selector) =>
        [...root.querySelectorAll(selector)].map((node) => {
          const box = node.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height].map((n) => Math.round(n));
        }),
      );
    });
  const before = await geometry();
  await copy.click();
  await expect(copy).toHaveAttribute("aria-busy", "true");
  expect(await geometry()).toEqual(before);
  release();
  await expect.poll(() => issued).toBe(1);
  await expect(
    sheet.getByRole("status").filter({ hasText: /Link copied|Copying was blocked/ }),
  ).toBeVisible();
  expect(await geometry()).toEqual(before);
  await expect(sheet.getByRole("button", { name: "Copy tailscale link" })).toBeVisible({
    timeout: 6000,
  });
  expect(await geometry()).toEqual(before);
  const overflow = await sheet
    .locator("button:visible, input:visible, .settings-remote-hint")
    .evaluateAll(
      (nodes) =>
        nodes.filter((node) => {
          const box = node.getBoundingClientRect();
          return box.left < 0 || box.right > innerWidth + 1;
        }).length,
    );
  expect(overflow).toBe(0);
  await page.screenshot({ path: test.info().outputPath("app-links.png") });
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });
  await copy.click();
  const fallback = page.getByRole("dialog", { name: "Copy sign-in link", exact: true });
  await expect(fallback.getByRole("textbox", { name: "App sign-in link" })).toBeVisible();
  await page.waitForTimeout(450);
  await page.screenshot({ path: test.info().outputPath("copy-fallback.png") });
  await fallback.getByRole("button", { name: "Close", exact: true }).click();
  await expect(fallback).toBeHidden();
  expect(await geometry()).toEqual(before);
});
