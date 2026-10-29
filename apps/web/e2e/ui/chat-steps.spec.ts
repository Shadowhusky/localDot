import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

// A step chosen in the chat unfolds where it is, with what Activity shows for it; the chat stays.
test("a chat step unfolds its details in place, by pointer and keyboard", async ({ page, ui }) => {
  await ui.open("image-output");
  await page.locator(".thread-work-steps > .ui-disclosure-trigger:visible").last().click();
  const list = page.locator(".thread-work-list");
  const row = list.getByTestId("step-row").filter({ hasText: "Opening the monthly report" });
  const head = row.getByRole("button", { name: /Opening the monthly report/ });
  await head.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  const frame = row.locator(".activity-frame");
  await expect(frame).toBeVisible();
  await expect(frame.locator("img")).toBeVisible();
  await expect(row.getByRole("list", { name: "Keys used" })).toBeAttached();
  if (isPhone(page)) await expect(page.getByRole("dialog", { name: "Activity" })).toHaveCount(0);
  else {
    await expect(page.getByRole("radio", { name: "Chat", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByRole("tablist", { name: "Activity" })).toBeHidden();
  }
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("chat-step-open.png") });

  // Another step takes its place; Escape folds it and gives focus back to its head.
  const tool = list.getByTestId("tool-row").filter({ hasText: "Validate report schema" });
  const toolHead = tool.getByRole("button", { name: /Validate report schema/ });
  await toolHead.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await toolHead.focus();
  await page.keyboard.press("Enter");
  await expect(toolHead).toHaveAttribute("aria-expanded", "true");
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(tool.getByLabel("Standard error text")).toContainText("schema.json");
  await page.keyboard.press("Escape");
  await expect(toolHead).toHaveAttribute("aria-expanded", "false");
  await expect(toolHead).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toolHead).toHaveAttribute("aria-expanded", "true");
});
