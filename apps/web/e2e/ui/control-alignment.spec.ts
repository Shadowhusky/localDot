import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

for (const scenario of ["ready", "done", "paused"] as const) {
  test(`${scenario} centers the status within its segment and aligns toolbar icons`, async ({
    page,
    ui,
  }) => {
    await ui.open(scenario);
    await ui.settle();
    const label = page.locator(".island-label-text");
    await expect(label).toBeVisible();
    const offset = await label.evaluate((element) => {
      const text = element.getBoundingClientRect();
      const parent = element.closest(".island-row");
      const separator = parent?.querySelector(".island-divider");
      if (!parent || !separator) throw new Error("Missing status segment");
      const row = parent.getBoundingClientRect();
      const divider = separator.getBoundingClientRect();
      return Math.abs(text.x + text.width / 2 - (row.x + divider.x) / 2);
    });
    expect(offset).toBeLessThanOrEqual(1);
    const errors = await page.locator(".ui-icon-button:visible").evaluateAll((buttons) =>
      buttons.flatMap((button) => {
        const icon = button.querySelector(".ui-icon");
        if (!icon) return [];
        const a = button.getBoundingClientRect(),
          b = icon.getBoundingClientRect();
        const dx = Math.abs(a.x + a.width / 2 - b.x - b.width / 2);
        const dy = Math.abs(a.y + a.height / 2 - b.y - b.height / 2);
        return dx > 1 || dy > 1 ? [{ label: button.getAttribute("aria-label"), dx, dy }] : [];
      }),
    );
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`${scenario}-alignment.png`) });
    if (scenario !== "paused" && test.info().project.name.endsWith("39")) {
      await page.locator(".stage-expand").getByRole("button", { name: "Full screen" }).click();
      await expect(page.locator(".app")).toHaveAttribute("data-focus", "");
      await ui.settle();
      const fullOffset = await label.evaluate((element) => {
        const text = element.getBoundingClientRect();
        const parent = element.closest(".island-row");
        if (!parent) throw new Error("Missing status row");
        const row = parent.getBoundingClientRect();
        return Math.abs(text.x + text.width / 2 - row.x - row.width / 2);
      });
      expect(fullOffset).toBeLessThanOrEqual(1);
      await page.screenshot({ path: test.info().outputPath(`${scenario}-fullscreen.png`) });
    }
  });
}
