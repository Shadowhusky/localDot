import { openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test("app links show local and Tailscale access without enabling the relay", async ({
  page,
  ui,
}) => {
  if (test.info().project.name !== "c14") await page.setViewportSize({ width: 320, height: 640 });
  let issued = 0;
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
  await page.route("**/api/install-code", (route) => {
    issued++;
    return route.fulfill({
      json: { code: "a".repeat(43), expiresAt: Date.parse("2026-10-08T09:02:00Z") },
    });
  });
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Your computer");
  const copy = sheet.getByRole("button", { name: "Copy tailscale link" });
  await copy.scrollIntoViewIfNeeded();
  await expect(copy).toBeVisible();
  expect(issued).toBe(0);
  await copy.click();
  await expect.poll(() => issued).toBe(1);
  await expect(
    sheet.getByRole("status").filter({ hasText: /Link copied|Copying was blocked/ }),
  ).toBeVisible();
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
});
