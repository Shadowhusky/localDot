import { expect, runAt, test } from "./harness.ts";

runAt("c14", "w39");
test("a fresh sign-in code reaches the daemon behind a cookie-protected relay", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("ready", undefined, "");
  let exchanges = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/auth/exchange-code") exchanges++;
  });
  await page.goto(`${fixture.origin}/__qa/relay-sign-in`);
  await expect(page.locator(".composer")).toBeVisible();
  expect(exchanges).toBe(1);
  expect(new URL(page.url()).hash).toBe("");
  await page.reload();
  await expect(page.locator(".composer")).toBeVisible();
  expect(exchanges).toBe(1);
});
