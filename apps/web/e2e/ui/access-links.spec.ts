import type { AccessLinksStatus, TailscaleAccess } from "@localdot/protocol";
import { openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

const ORIGIN = "https://richards-mac-studio.tail849a6b.ts.net:4750";
const PAGE = "https://login.tailscale.com/f/serve?node=n1";
const STATES: Record<string, TailscaleAccess> = {
  stopped: {
    state: "not-running",
    message: "Tailscale is installed but not running. Open the Tailscale app, then check again.",
  },
  off: {
    state: "ready-to-enable",
    origin: ORIGIN,
    message: "Turn on to open localDot from your devices signed in to Tailscale.",
  },
  approval: {
    state: "needs-approval",
    origin: ORIGIN,
    approvalUrl: PAGE,
    message: "Allow HTTPS for this computer in Tailscale. localDot turns on as soon as you do.",
  },
  on: {
    state: "served",
    origin: ORIGIN,
    message: "Copy a link and open it on any device signed in to your Tailscale network.",
  },
};

runAt("c14", "c39", "w39");
test("app links always show Tailscale's state and take it from stopped to on, one step at a time", async ({
  page,
  ui,
}) => {
  if (test.info().project.name !== "c14") await page.setViewportSize({ width: 320, height: 640 });
  let tailscale = STATES.stopped as TailscaleAccess;
  let enabled = 0;
  const answer = (): AccessLinksStatus => ({
    links: [{ origin: "http://localhost:4750", label: "This computer" }],
    tailscale,
  });
  await page.route("**/api/access-links**", (route) => route.fulfill({ json: answer() }));
  await page.route("**/api/access-links/tailscale", (route) => {
    enabled++;
    tailscale = STATES.approval as TailscaleAccess;
    return route.fulfill({ json: answer() });
  });
  await page.route("**/api/install-code", (route) =>
    route.fulfill({
      json: { code: "a".repeat(43), expiresAt: Date.parse("2026-10-08T09:01:02Z") },
    }),
  );
  await ui.open("ready");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    });
    Object.defineProperty(window, "ClipboardItem", { configurable: true, value: undefined });
    window.open = (url) => {
      document.documentElement.dataset.opened = String(url);
      return null;
    };
  });
  const sheet = await openSettings(page, undefined, "Your computer");
  const row = sheet.locator(".ui-group-row").filter({ hasText: /^Tailscale/ });
  await row.scrollIntoViewIfNeeded();
  await expect(row).toContainText("Not running");
  await expect(sheet.getByText(STATES.stopped?.message ?? "")).toBeVisible();
  await expect(sheet.getByText(/LAN sharing|Local network/)).toHaveCount(0);

  tailscale = STATES.off as TailscaleAccess;
  await row.getByRole("button", { name: "Check again" }).click();
  await expect(row).toContainText("Off");
  await row.getByRole("button", { name: "Turn on" }).click();
  await expect(row).toContainText("Waiting for you to allow HTTPS");
  expect(enabled).toBe(1);
  await row.getByRole("button", { name: "Allow HTTPS" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-opened", PAGE);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("tailscale-approval.png") });

  tailscale = STATES.on as TailscaleAccess;
  const copy = row.getByRole("button", { name: "Copy Tailscale link" });
  await expect(copy).toBeVisible({ timeout: 6000 });
  await expect(row).toContainText("richards-mac-studio.tail849a6b.ts.net:4750");
  await copy.click();
  await expect(row.getByRole("button", { name: "Tailscale link copied" })).toBeVisible();
  await expect(sheet.getByRole("status").filter({ hasText: /Link copied/ })).toBeVisible();
  const overflow = await sheet
    .locator("button:visible, input:visible, .ui-group-row-detail")
    .evaluateAll(
      (nodes) =>
        nodes.filter((node) => {
          const box = node.getBoundingClientRect();
          return box.left < 0 || box.right > innerWidth + 1;
        }).length,
    );
  expect(overflow).toBe(0);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("tailscale-on.png") });
});
