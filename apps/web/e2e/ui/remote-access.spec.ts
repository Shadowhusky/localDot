import { pairPage } from "../../../remote/src/pair-page.ts";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test("remote access requires opt-in and keeps its privacy and pairing controls inside the sheet", async ({
  page,
  ui,
  browserName,
  context,
}) => {
  if (test.info().project.name !== "c14") await page.setViewportSize({ width: 320, height: 568 });
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-write", "clipboard-read"]);
  let enabled = false,
    mutations = 0;
  const link = `https://${"a".repeat(32)}--dot.example.com/_remote/pair#remote=${"b".repeat(64)}&code=${"c".repeat(32)}`;
  await page.route("**/api/remote-access**", async (route) => {
    if (route.request().method() === "PUT") {
      enabled = route.request().postDataJSON().enabled;
      mutations++;
    }
    const isLink = new URL(route.request().url()).pathname.endsWith("/link");
    await route.fulfill({
      json: isLink
        ? { url: link, expiresAt: Date.parse("2026-10-08T09:02:00Z") }
        : {
            supported: true,
            enabled,
            state: enabled ? "online" : "off",
            url: enabled ? "https://device--dot.example.com" : null,
            detail: "",
          },
    });
  });
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Your computer");
  const toggle = sheet.getByRole("switch", { name: "Allow remote access" });
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).not.toBeChecked();
  await expect(sheet.getByText(/which can process your traffic/)).toBeVisible();
  expect(mutations).toBe(0);
  await toggle.click();
  const create = sheet.getByRole("button", { name: "Copy sign-in link" });
  await create.scrollIntoViewIfNeeded();
  await ui.settle();
  const layout = () =>
    sheet.locator(".settings-remote-action").evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height].map(Math.round);
      }),
    );
  const beforeCopy = await layout();
  await create.click();
  const field = sheet.getByRole("textbox", { name: "Remote sign-in link" });
  await expect(sheet.getByRole("button", { name: "Link copied" })).toBeVisible();
  await expect(field).toHaveCount(0);
  expect(await layout()).toEqual(beforeCopy);
  await sheet.getByRole("heading", { name: "Remote access", exact: true }).scrollIntoViewIfNeeded();
  await ui.settle();
  const clipped = await sheet.locator("button:visible, input:visible").evaluateAll((controls) =>
    controls.flatMap((control) => {
      const box = control.getBoundingClientRect();
      return box.left < -1 || box.right > innerWidth + 1
        ? [control.getAttribute("aria-label") ?? control.textContent]
        : [];
    }),
  );
  expect(clipped).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("remote-access.png") });
  await sheet.getByRole("button", { name: "Privacy details" }).click();
  await expect(sheet.getByText(/not end-to-end encrypted against the relay/)).toBeVisible();
  await toggle.click();
  await expect(field).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  expect(mutations).toBe(2);
});

test("pairing removes secrets from the URL and reaches the existing app sign-in flow", async ({
  page,
  ui,
}) => {
  const key = "a".repeat(64),
    code = "b".repeat(43);
  let unlocks = 0,
    exchanges = 0;
  await page.route("**/_remote/pair", async (route) => {
    const response = pairPage();
    await route.fulfill({
      status: 200,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  await page.route("**/_remote/unlock", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ key });
    expect(new URL(route.request().url()).search).toBe("");
    unlocks++;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/auth/exchange-code", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ code });
    exchanges++;
    await route.fulfill({ json: { token: TOKEN } });
  });
  await ui.open("ready", () => "/_remote/pair", `#remote=${key}&code=${code}`);
  await expect.poll(() => exchanges).toBe(1);
  await expect(page.locator(".app")).toBeVisible();
  expect(unlocks).toBe(1);
  expect(new URL(page.url()).hash).toBe("");
  expect(new URL(page.url()).search).toBe("");
});
