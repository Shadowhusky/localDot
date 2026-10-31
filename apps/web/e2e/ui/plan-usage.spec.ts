import { composer, expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

const STATES = ["normal", "near", "limit", "stale", "reset", "unknown"] as const;

test("the model menu shows each plan's limits, near, reached, stale, reset and unknown", async ({
  page,
  ui,
}, testInfo) => {
  const fixture = await ui.open("plan-usage");
  const chip = (await composer(page)).getByRole("button", { name: /^Model:/ });
  const panel = page.getByRole("dialog", { name: "Model and thinking" });
  const claude = panel.getByRole("region", { name: /^Claude plan/ });
  const chatgpt = panel.getByRole("region", { name: /^ChatGPT plan/ });
  for (const appearance of ["graphite", "midnight"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    for (const state of STATES) {
      const set = await page.request.post(`${fixture.origin}/__qa/plan-usage/${state}`);
      expect(set.ok()).toBe(true);
      await chip.click();
      await expect(panel).toBeVisible();
      // The ChatGPT plan is signed in too, but the chosen model spends only the Claude plan.
      await expect(chatgpt).toHaveCount(0);
      if (state === "unknown")
        await expect(claude).toContainText("Usage appears after the first reply.");
      else await expect(claude.getByRole("heading")).toHaveText("Claude plan · Max");
      const session = claude.getByRole("meter", { name: "5-hour limit" });
      const week = claude.getByRole("meter", { name: "Weekly limit" });
      switch (state) {
        case "normal":
          await expect(session).toHaveAttribute("aria-valuetext", "42% used");
          await expect(week).toHaveAttribute("aria-valuetext", "18% used");
          await expect(claude).toContainText(/Resets in 2 h 1\d min/);
          await expect(claude).toContainText(/Resets in 3 days 3 h/);
          await expect(chip).toHaveAccessibleName("Model: Claude Sonnet");
          break;
        case "near":
          await expect(session).toHaveAttribute("aria-valuetext", "93% used, almost at limit");
          await expect(chip).toHaveAccessibleName(
            "Model: Claude Sonnet, Claude plan almost at limit",
          );
          break;
        case "limit":
          await expect(claude).toContainText(/Limit reached · resets in 1 h 3\d min/);
          await expect(chip).toHaveAccessibleName(
            "Model: Claude Sonnet, Claude plan limit reached",
          );
          break;
        case "stale":
          await expect(claude).toContainText("As of 3 h ago");
          await expect(session).toHaveAttribute("aria-valuetext", "58% used");
          break;
        case "reset":
          await expect(session).toHaveAttribute("aria-valuetext", "Reset");
          await expect(claude).toContainText("New usage not known yet.");
          await expect(chip).toHaveAccessibleName("Model: Claude Sonnet");
          break;
      }
      await ui.settle();
      await page.screenshot({
        path: testInfo.outputPath(`${state}-${appearance}.png`),
        animations: "disabled",
      });
      if (state === "near" || state === "limit")
        await chip.screenshot({ path: testInfo.outputPath(`chip-${state}-${appearance}.png`) });
      // A tooltip shown over the panel takes the first Escape.
      await expect(async () => {
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden({ timeout: 1_000 });
      }).toPass();
    }
  }
});
