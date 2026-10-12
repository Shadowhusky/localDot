import { composer, expect, runAt, test } from "./harness.ts";

runAt("c14", "w39");

test("an arriving approval keeps the message focus and caret", async ({ page, ui }) => {
  await ui.open("running");
  const box = (await composer(page)).getByRole("textbox", { name: "Message" });
  await box.fill("Keep typing this draft");
  await box.press("ArrowLeft");
  const selection = await box.evaluate((el: HTMLTextAreaElement) => [
    el.selectionStart,
    el.selectionEnd,
  ]);
  await ui.step("approval");
  await expect(page.getByRole("dialog", { name: "Send this email?" })).toBeVisible();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("Keep typing this draft");
  expect(
    await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual(selection);
});

test("typing continues through incoming messages and conversation resizing", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  const box = (await composer(page)).getByRole("textbox", { name: "Message" });
  await box.fill("My draft");
  const response = await page.request.post(
    `${fixture.origin}/__qa/say?n=8&text=Background%20update`,
  );
  expect(response.ok()).toBe(true);
  await expect(
    page
      .getByRole("region", { name: "Conversation history" })
      .getByText("Background update (8)", { exact: true }),
  ).toBeAttached();
  await expect(box).toBeFocused();
  const size = page.viewportSize();
  if (!size) throw new Error("Missing viewport");
  await page.setViewportSize({ ...size, height: 550 });
  await ui.settle();
  await expect(box).toBeFocused();
  // Keyboard input, not fill(), proves typing works without clicking the field again.
  await page.keyboard.type(" continues");
  await expect(box).toHaveValue("My draft continues");
  await page.setViewportSize(size);
  await ui.settle();
  await expect(box).toBeFocused();
});
