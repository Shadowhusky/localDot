import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");

test("a task paused at its plan's limit says when it continues by itself, and stops on request", async ({
  page,
  ui,
}, testInfo) => {
  const fixture = await ui.open("plan-limit");
  const rail = page.getByRole("complementary", { name: "Conversation" });
  const card = rail.getByRole("region", { name: /^Paused until \d/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText(
    "Your Claude plan is at its limit. dot continues by itself when it resets.",
  );
  await expect(card.getByRole("button", { name: "Continue now" })).toBeVisible();
  for (const look of ["daylight", "graphite"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, look);
    await page.waitForTimeout(600);
    await ui.settle();
    await card.screenshot({ path: testInfo.outputPath(`waiting-${look}.png`) });
  }
  await card.getByRole("button", { name: "Don't continue" }).click();
  const paused = rail.getByRole("region", { name: "Paused at your plan's limit" });
  await expect(paused).toContainText("Wait for it to reset");
  await expect(paused.getByRole("button", { name: "Don't continue" })).toHaveCount(0);
  await expect(paused.getByRole("button", { name: "Try again" })).toBeVisible();

  const checking = await page.request.post(`${fixture.origin}/__qa/stall/plan-limit-unknown`);
  expect(checking.ok()).toBe(true);
  await expect(paused).toContainText("didn't say when it resets");
});
