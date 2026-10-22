import type { Locator, Page } from "@playwright/test";
import { TOKEN } from "../fixtures/start-ui-fixture.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

async function agentsTab(page: Page) {
  if (isPhone(page)) await page.getByRole("button", { name: "Activity", exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: /Agents/ }).click();
  return page.getByRole("tabpanel", { name: /Agents/ });
}

const row = (panel: Locator, label: string) => panel.locator(".subagent-row", { hasText: label });

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
  await page.reload();
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

test("a child agent cut off when the user takes the computer reads Interrupted, never Running", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/agents`);
  const panel = await agentsTab(page);
  await expect(row(panel, "Research official sources")).toContainText("Running");
  // A phone's Agents sheet covers the island, so there the request its Take control sends is made
  // directly.
  if (isPhone(page)) {
    const took = await page.request.post(
      `${fixture.origin}/api/agent/sessions/${fixture.sessionId}/takeover`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(took.status(), await took.text()).toBe(202);
  } else await page.locator(".island").getByRole("button", { name: "Take control" }).click();
  await expect(page.getByTestId("hud-status")).toHaveText("You're in control");
  await expect(row(panel, "Research official sources")).toContainText("Interrupted");
  await expect(row(panel, "Review implementation")).toContainText("Finished");
  await expect(panel).not.toContainText("Running");
  await page.screenshot({ path: test.info().outputPath("agents-interrupted.png") });
  // While the user holds the computer, a phone's clicks and taps never land (at 4c0960a9 too).
  if (isPhone(page)) return;
  await page.reload();
  await expect(row(await agentsTab(page), "Research official sources")).toContainText(
    "Interrupted",
  );
});
