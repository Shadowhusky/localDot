import { choose, closeSettings, openSettings, roleCard } from "../settings-ui.ts";
import { composer, expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

test("each speed a model offers comes with its price, and the model button marks it", async ({
  page,
  ui,
}, testInfo) => {
  await ui.open("ready");
  const trigger = (await composer(page)).getByRole("button", { name: /^Model:/ });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Model and thinking" });
  await choose(page, panel.getByRole("combobox", { name: "Model", exact: true }), "GPT-6 Luna", {
    tap: isPhone(page),
  });
  const speed = panel.getByRole("combobox", { name: "Speed", exact: true });
  await expect(speed).toHaveText("Standard");
  await (isPhone(page) ? speed.tap() : speed.click());
  const list = page.getByRole("listbox", { name: "Speed", exact: true });
  await expect(list.getByRole("option")).toHaveText(["Standard", /^Fast\s*2× the price$/]);
  await ui.settle();
  await page.screenshot({ path: testInfo.outputPath("speed-options.png"), animations: "disabled" });
  const fast = list.getByRole("option", { name: /^Fast/ });
  await (isPhone(page) ? fast.tap() : fast.click());
  await panel.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(trigger).toHaveAttribute("aria-label", /^Model: GPT-6 Luna(, [^,]+)?, Fast$/);
  await expect(trigger.locator(".ui-speed-mark")).toHaveAttribute("data-speed", "fast");
  await expect(trigger.locator(".ui-speed-mark")).toBeVisible();
  await ui.settle();
  await page.screenshot({ path: testInfo.outputPath("speed-chip.png"), animations: "disabled" });
});

test("a fast model on the main model's provider starts from its key and a cheaper model", async ({
  page,
  ui,
}, testInfo) => {
  await ui.open("ready");
  await ui.picture();
  const tap = isPhone(page);
  const sheet = await openSettings(page, undefined, "Models");
  const main = roleCard(sheet, "main");
  await choose(page, main.getByRole("combobox", { name: "Provider", exact: true }), "OpenAI", {
    tap,
  });
  await choose(page, main.getByRole("combobox", { name: "Model", exact: true }), "GPT-6.1 Sol", {
    tap,
  });
  await choose(page, main.getByRole("combobox", { name: "Key", exact: true }), "openai-fast", {
    tap,
  });
  // The model saves itself first, so choosing its speed is a change of its options alone.
  const saved = sheet.getByRole("status").filter({ hasText: "Changes save automatically." });
  await expect(saved).toBeVisible();
  const speed = main.getByRole("combobox", { name: "Speed", exact: true });
  await (tap ? speed.tap() : speed.click());
  await expect(
    page.getByRole("listbox", { name: "Speed", exact: true }).getByRole("option"),
  ).toHaveText(["Standard", /^Fast\s*2× the price$/, /^Ultrafast\s*6× the price$/]);
  await page.keyboard.press("Escape");
  await choose(page, speed, "Ultrafast", { tap });
  await expect(speed).toHaveText("Ultrafast");
  await expect(saved).toBeVisible();

  const fast = roleCard(sheet, "fast");
  const on = fast.getByRole("switch", { name: "Fast model" });
  await on.click();
  await expect(on).not.toBeChecked();
  await on.click();
  await choose(page, fast.getByRole("combobox", { name: "Provider", exact: true }), "OpenAI", {
    tap,
  });
  await expect(fast.getByRole("combobox", { name: "Key", exact: true })).toHaveText("openai-fast");
  await expect(fast.getByRole("combobox", { name: "Model", exact: true })).toHaveText("GPT-6 Luna");
  await expect(
    fast.getByText("Summarizes long tasks and answers purpose checks", { exact: true }),
  ).toBeVisible();
  await fast.scrollIntoViewIfNeeded();
  await ui.settle();
  await page.screenshot({
    path: testInfo.outputPath("fast-same-provider.png"),
    animations: "disabled",
  });

  // Each edit saved itself, Speed included, so Settings closes with nothing to discard.
  await closeSettings(page);
  const trigger = (await composer(page)).getByRole("button", { name: /^Model:/ });
  await expect(trigger).toHaveAttribute("aria-label", /^Model: GPT-6\.1 Sol, Ultrafast$/);
  await expect(trigger.locator(".ui-speed-mark")).toHaveAttribute("data-speed", "ultrafast");
  await expect(trigger.locator(".ui-speed-mark svg")).toHaveCount(2);
});
