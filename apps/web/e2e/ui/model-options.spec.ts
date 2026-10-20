import { composer, expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

test("model thinking can be changed, saved and reset inside the composer", async ({
  page,
  ui,
}, testInfo) => {
  await ui.open("ready");
  const card = await composer(page);
  const trigger = card.getByRole("button", { name: /^Model:/ });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(panel).toBeVisible();
  await panel.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "GPT-6 Luna", exact: true }).click();
  const speed = panel.getByRole("combobox", { name: "Speed", exact: true });
  await speed.click();
  await page.getByRole("option", { name: "Fast · higher cost", exact: true }).click();
  const manage = panel.getByRole("button", { name: /Manage models/ });
  const bounds = await manage.boundingBox(),
    panelBounds = await panel.boundingBox();
  expect(
    bounds &&
      panelBounds &&
      bounds.x >= panelBounds.x &&
      bounds.x + bounds.width <= panelBounds.x + panelBounds.width,
  ).toBe(true);
  const detail = panel.getByRole("slider", { name: "Answer detail" });
  await detail.focus();
  await detail.press("End");
  await expect(detail).toHaveAttribute("aria-valuetext", "Detailed");
  const slider = panel.getByRole("slider", { name: "Reasoning effort" });
  await slider.focus();
  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", "Maximum");
  await ui.settle();
  await page.screenshot({ path: testInfo.outputPath("model-options.png"), animations: "disabled" });
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(trigger).toContainText("Maximum");
  await page.reload();
  const again = (await composer(page)).getByRole("button", { name: /^Model:/ });
  await expect(again).toContainText("Maximum");
  await again.click();
  await expect(speed).toContainText("Fast");
  await expect(detail).toHaveAttribute("aria-valuetext", "Detailed");
  await expect(slider).toHaveAttribute("aria-valuetext", "Maximum");
  await panel.getByRole("button", { name: "Reset to provider defaults" }).click();
  await expect(detail).toHaveAttribute("aria-valuetext", "Provider default");
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(again).not.toContainText("Maximum");
  // Editing and cancelling must not mutate saved settings or the message draft.
  const box = (await composer(page)).getByRole("textbox");
  await box.fill("Keep this draft");
  await again.click();
  await slider.focus();
  await slider.press("End");
  await slider.press("Escape");
  await expect(again).toBeFocused();
  await expect(box).toHaveValue("Keep this draft");
  await expect(again).not.toContainText("Maximum");
});
