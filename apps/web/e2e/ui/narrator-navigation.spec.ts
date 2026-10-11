import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
for (const scenario of ["done", "running"] as const) {
  test(`${scenario} restores mascot narration when returning from Replay`, async ({ page, ui }) => {
    await ui.open(scenario);
    await ui.picture();
    await ui.settle();
    const line = page.locator(".narration-line");
    await expect(line).toBeVisible();
    const before = (await line.textContent()) ?? "";
    expect(before.trim()).not.toBe("");
    for (let i = 0; i < 2; i++) {
      if (isPhone(page)) {
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("menuitem", { name: "Replay", exact: true }).click();
      } else await page.getByRole("radio", { name: "Replay", exact: true }).click();
      await expect(page.locator(".app")).toHaveAttribute("data-replaying", "");
      if (isPhone(page))
        await page
          .getByRole("navigation")
          .getByRole("button", { name: "Watch", exact: true })
          .click();
      else await page.getByRole("radio", { name: "Watch", exact: true }).click();
      await expect(page.locator(".app")).not.toHaveAttribute("data-replaying");
      await expect(line).toHaveText(before, { timeout: 3000 });
      await expect(line).toHaveCSS("opacity", "1");
    }
    await page.screenshot({ path: test.info().outputPath(`${scenario}-restored.png`) });
  });
}
