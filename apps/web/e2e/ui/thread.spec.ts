import type { Page } from "@playwright/test";
import { expect, keepBaselinesAt, test } from "./harness.ts";

// The conversation thread in each of its states, as pixels of the conversation column.
keepBaselinesAt("c14", "w39");

async function conversation(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 1180)
    await page.getByRole("tab", { name: /^Conversation/ }).click();
  return page.getByRole("complementary", { name: "Conversation" });
}

test("thread, running", async ({ page, ui }) => {
  await ui.open("running");
  const rail = await conversation(page);
  await expect(rail.locator(".thread-live .thread-work")).toContainText(
    "Select the Net total cell",
  );
  await ui.settle();
  await ui.still();
  await expect(rail).toHaveScreenshot("thread-running.png");
});

test("thread, done with files", async ({ page, ui }) => {
  await ui.open("done");
  const rail = await conversation(page);
  await expect(rail.getByRole("region", { name: "Task result" })).toContainText("totals.csv");
  await ui.settle();
  await ui.still();
  await expect(rail).toHaveScreenshot("thread-done-files.png");
});

test("thread, question", async ({ page, ui }) => {
  await ui.open("ask");
  const rail = await conversation(page);
  await expect(rail.getByRole("form", { name: "Answer dot" })).toBeVisible();
  await ui.settle();
  await ui.still();
  await expect(rail).toHaveScreenshot("thread-question.png");
});

test("thread, recovery", async ({ page, ui }) => {
  await ui.open("budget");
  const rail = await conversation(page);
  const recovery = rail.getByRole("region", { name: "Task recovery" });
  await expect(recovery.getByRole("button", { name: "Raise to $7 and continue" })).toBeVisible();
  await ui.settle();
  await ui.still();
  await expect(rail).toHaveScreenshot("thread-recovery.png");
});
