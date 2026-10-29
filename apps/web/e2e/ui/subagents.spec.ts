import type { Locator, Page } from "@playwright/test";
import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

// While the user holds the computer, a phone's toolbar has its controls in Activity's place, and
// More has Activity instead.
async function agentsTab(page: Page, holding = false) {
  if (!isPhone(page))
    await page.locator(".rail-chat").getByRole("radio", { name: "Activity", exact: true }).click();
  else if (!holding) await page.getByRole("button", { name: "Activity", exact: true }).click();
  else {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Activity", exact: true }).click();
  }
  await page.getByRole("tab", { name: /Agents/ }).click();
  return page.getByRole("tabpanel", { name: /Agents/ });
}

const row = (panel: Locator, label: string) => panel.locator(".subagent-row", { hasText: label });

// WebKit reports a request that a reload cuts off as a page error, so the page settles first.
async function reload(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.reload();
}

test("Activity shows persisted running and finished child agents with expandable linked results", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/agents`);
  const panel = await agentsTab(page);
  await expect(panel).toContainText("Research official sources");
  await expect(panel).toContainText("Running");
  await expect(panel).toContainText("Review implementation");
  await expect(panel).toContainText("Finished");
  await panel.getByRole("button", { name: "Result" }).click();
  await expect(panel.getByRole("link", { name: "https://example.test/reference" })).toHaveAttribute(
    "href",
    "https://example.test/reference",
  );
  await page.screenshot({ path: test.info().outputPath("agents.png") });
  await reload(page);
  await expect(await agentsTab(page)).toContainText("Research official sources");
});

test("an agent dot wakes again keeps one row, led by its new run, its earlier result inside", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/agents`);
  await page.request.post(`${fixture.origin}/__qa/agents/again`);
  const panel = await agentsTab(page);
  const review = row(panel, "Review implementation");
  await expect(review).toHaveCount(1);
  await expect(panel.locator(".subagent-row").first()).toContainText("Review implementation");
  await expect(review.locator(".subagent-heading")).toContainText("Running");
  await review.getByRole("button", { name: /^Earlier runs/ }).click();
  const earlier = review.locator(".subagent-runs");
  await expect(earlier).toContainText("Finished");
  await expect(earlier.getByRole("link", { name: "https://example.test/reference" })).toBeVisible();
  await page.request.post(`${fixture.origin}/__qa/agents/again?done=1`);
  await expect(review.locator(".subagent-heading")).toContainText("Finished");
  await review.getByRole("button", { name: "Result", exact: true }).click();
  await expect(review).toContainText("the monthly totals now match");
  await expect(earlier).toContainText("Verified against");
  await page.screenshot({ path: test.info().outputPath("agents-earlier.png") });
});

test("an agent a usage limit stopped says why, then reads Resumed with that run kept", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/agents`);
  await page.request.post(`${fixture.origin}/__qa/agents/limit`);
  const panel = await agentsTab(page);
  const research = row(panel, "Research official sources");
  await expect(research.locator(".subagent-heading")).toContainText("Interrupted");
  await expect(research.locator(".subagent-reason")).toHaveText("Usage limit reached");
  await page.screenshot({ path: test.info().outputPath("agents-limit.png") });
  await page.request.post(`${fixture.origin}/__qa/agents/resume`);
  await expect(research.locator(".subagent-heading")).toContainText("Resumed");
  await expect(research.locator(".subagent-reason")).toHaveCount(0);
  await research.getByRole("button", { name: /^Earlier runs/ }).click();
  await expect(research.locator(".subagent-runs")).toContainText(
    "Interrupted · Usage limit reached",
  );
  const { scrollWidth, clientWidth } = await panel.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  await page.screenshot({ path: test.info().outputPath("agents-resumed.png") });
  await reload(page);
  await expect(
    row(await agentsTab(page), "Research official sources").locator(".subagent-heading"),
  ).toContainText("Resumed");
});

test("a child agent cut off when the user takes the computer reads Interrupted, never Running", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/agents`);
  let panel = await agentsTab(page);
  await expect(row(panel, "Research official sources")).toContainText("Running");
  // A phone's Activity sheet covers the island, so it is closed to reach Take control.
  if (isPhone(page))
    await page
      .getByRole("dialog", { name: "Activity" })
      .getByRole("button", { name: "Done" })
      .click();
  await page.locator(".island").getByRole("button", { name: "Take control" }).click();
  await expect(page.getByTestId("hud-status")).toHaveText("You're in control");
  if (isPhone(page)) panel = await agentsTab(page, true);
  await expect(row(panel, "Research official sources")).toContainText("Interrupted");
  await expect(row(panel, "Research official sources")).toContainText("You took the computer");
  await expect(row(panel, "Review implementation")).toContainText("Finished");
  await expect(panel).not.toContainText("Running");
  await page.screenshot({ path: test.info().outputPath("agents-interrupted.png") });
  await reload(page);
  await expect(page.getByTestId("hud-status")).toHaveText("You're in control");
  await expect(row(await agentsTab(page, true), "Research official sources")).toContainText(
    "Interrupted",
  );
});
