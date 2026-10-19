import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test("Activity shows persisted running and finished child agents with expandable linked results", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/agents`);
  const phone = (page.viewportSize()?.width ?? 0) < 700;
  if (phone) await page.getByRole("button", { name: "Activity", exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: /Agents/ }).click();
  const panel = page.getByRole("tabpanel", { name: /Agents/ });
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
  if (phone) await page.getByRole("button", { name: "Activity", exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: /Agents/ }).click();
  await expect(page.getByRole("tabpanel", { name: /Agents/ })).toContainText(
    "Research official sources",
  );
});
