import { expect, runAt, test } from "./harness.ts";

runAt("c14", "w14");

test("panel sizes, visibility and Files survive reload and smaller screens", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 2000, height: 1000 });
  await ui.open("done");
  const activity = page.locator(".rail-activity");
  const chat = page.locator(".rail-chat");
  await expect(activity).toBeVisible();
  await activity.getByRole("tab", { name: /^Files/ }).click();
  const activityEdge = page.getByRole("separator", { name: "Activity width" });
  const chatEdge = page.getByRole("separator", { name: "Conversation width" });
  await activityEdge.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(activityEdge).toHaveAttribute("aria-valuenow", "384");
  await chatEdge.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(chatEdge).toHaveAttribute("aria-valuenow", "432");
  await activity.getByRole("button", { name: "Hide activity" }).click();
  await expect(activity).toBeHidden();
  await expect(chat.getByRole("radio", { name: "Activity", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Panels", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByRole("menuitem", { name: "Hide chat" }).click();
  await expect(chat).toBeHidden();
  await page.reload();
  await expect(activity).toBeHidden();
  await expect(chat).toBeHidden();
  await expect(page.getByRole("button", { name: "Panels", exact: true })).toBeVisible();
  expect(
    await page
      .locator(".app")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length),
  ).toBe(1);
  await ui.picture();
  await page.screenshot({ path: test.info().outputPath("panels-hidden.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(chat).toBeVisible();
  await page.setViewportSize({ width: 2000, height: 1000 });
  await expect(chat).toBeHidden();
  for (const name of ["Show activity", "Show chat"]) {
    await page.getByRole("button", { name: "Panels", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  await expect(activityEdge).toHaveAttribute("aria-valuenow", "384");
  await expect(chatEdge).toHaveAttribute("aria-valuenow", "432");
  await expect(activity.getByRole("tab", { name: /^Files/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.reload();
  await expect(activity.getByRole("tab", { name: /^Files/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(chatEdge).toHaveAttribute("aria-valuenow", "432");
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await ui.picture();
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("panels-restored.png") });
});

test("Activity can be closed and restored in the shared laptop panel", async ({ page, ui }) => {
  await ui.open("done");
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show activity" }).click();
  await page
    .locator(".rail-chat")
    .getByRole("tab", { name: /^Files/ })
    .click();
  await page.reload();
  await expect(page.locator(".rail-chat").getByRole("tab", { name: /^Files/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "Hide activity", exact: true }).click();
  await expect(page.getByRole("form", { name: "Message dot" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("form", { name: "Message dot" })).toBeVisible();
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
