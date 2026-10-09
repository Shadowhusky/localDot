import type { Page } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

// The conversation thread in each of its states.
runAt("c14", "w39");

async function conversation(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 1100) {
    // The phone opens on the computer until the task has loaded, so the tab is chosen once it has.
    const tab = page.getByRole("tab", { name: /^Conversation/ });
    await expect(async () => {
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1000 });
    }).toPass();
    await expect(page.locator(".thread-row").first()).toBeVisible();
  }
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
});

test("thread, done with files", async ({ page, ui }) => {
  await ui.open("done");
  const rail = await conversation(page);
  await expect(rail.getByRole("region", { name: "Task result" })).toContainText("totals.csv");
  await ui.settle();
  await ui.still();
});

test("thread, question", async ({ page, ui }) => {
  await ui.open("ask");
  const rail = await conversation(page);
  await expect(rail.getByRole("form", { name: "Answer dot" })).toBeVisible();
  await ui.settle();
  await ui.still();
});

test("thread, recovery", async ({ page, ui }) => {
  await ui.open("budget");
  const rail = await conversation(page);
  const recovery = rail.getByRole("region", { name: "Task recovery" });
  await expect(recovery.getByRole("button", { name: "Raise to $7 and continue" })).toBeVisible();
  await ui.settle();
  await ui.still();
});
