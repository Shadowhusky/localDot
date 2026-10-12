import { expect, runAt, test } from "./harness.ts";

runAt("c14", "w14");

test("Activity stays in the conversation panel across desktop sizes and reloads", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 2000, height: 1000 });
  await ui.open("done");
  const chat = page.locator(".rail-chat");
  await expect(page.locator(".rail-activity")).toHaveCount(0);
  await chat.getByRole("radio", { name: "Activity", exact: true }).click();
  await chat.getByRole("tab", { name: /^Files/ }).click();
  await page.reload();
  await expect(chat.getByRole("tab", { name: /^Files/ })).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(chat.getByRole("tab", { name: /^Files/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /activity/i })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Hide chat" }).click();
  await expect(chat).toBeHidden();
  await page.reload();
  await expect(chat).toBeHidden();
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show chat" }).click();
  await expect(chat.getByRole("radio", { name: "Activity", exact: true })).toBeVisible();
  await ui.picture();
  await page.screenshot({ path: test.info().outputPath("shared-activity.png") });
});

test("a tablet keeps the restore control available when its lower panel is hidden", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await ui.open("done");
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByRole("menuitem", { name: "Hide chat" }).click();
  await expect(page.locator(".rail-chat")).toBeHidden();
  await page.reload();
  await expect(page.locator(".rail-chat")).toBeHidden();
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show chat" }).click();
  await expect(page.getByRole("form", { name: "Message dot" })).toBeVisible();
});
