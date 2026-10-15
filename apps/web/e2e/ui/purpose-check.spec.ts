import { openSettings } from "../settings-ui.ts";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test("Purpose Check exposes configuration, bypass and a real-test result without overflow", async ({
  page,
  ui,
}, testInfo) => {
  const at = "2026-10-08T09:00:00.000Z";
  let tested = false;
  await page.route("**/api/keys", async (route) => {
    const reply = await route.fetch();
    const body = await reply.json();
    body.keys.push({
      id: "jev",
      kind: "http",
      hosts: ["api.typesafe.ai"],
      header: "Authorization",
      format: "bearer",
      createdAt: at,
      updatedAt: at,
    });
    await route.fulfill({ json: body });
  });
  await page.route("**/api/agent/settings", async (route) => {
    const reply = await route.fetch();
    const body = await reply.json();
    await route.fulfill({ json: { ...body, permissionMode: "full" } });
  });
  await page.route("**/api/agent/purpose-check**", async (route) => {
    if (route.request().method() === "POST") tested = true;
    await route.fulfill({
      json: {
        mode: "bypassed",
        keyId: "jev",
        host: "api.typesafe.ai",
        model: "jev-latest",
        calls: tested ? 1 : 0,
        succeeded: tested ? 1 : 0,
        failed: 0,
        ...(tested
          ? { last: { at, kind: "test", ok: true, latencyMs: 259, model: "jev-1.13.0" } }
          : {}),
      },
    });
  });
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Autonomy");
  const switcher = sheet.getByRole("switch", { name: "Purpose check", exact: true });
  await switcher.scrollIntoViewIfNeeded();
  await expect(sheet.getByText(/Bypassed in Full access/)).toBeVisible();
  expect(tested).toBe(false);
  const button = sheet.getByRole("button", { name: "Test Jev", exact: true });
  await button.click();
  await expect(sheet.getByText(/Test succeeded/)).toBeVisible();
  await expect(sheet.getByText(/1 attempted · 1 succeeded/)).toBeVisible();
  const group = sheet
    .locator(".ui-group")
    .filter({ has: page.getByRole("switch", { name: "Purpose check", exact: true }) });
  const box = await group.boundingBox();
  const send = await button.boundingBox();
  if (!box || !send) throw new Error("Purpose controls have no layout");
  expect(send.x).toBeGreaterThanOrEqual(box.x);
  expect(send.x + send.width).toBeLessThanOrEqual(box.x + box.width + 1);
  expect(await group.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("purpose-check.png") });
});
