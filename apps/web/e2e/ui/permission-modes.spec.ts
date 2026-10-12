import { composer, expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

test("each saved permission mode has its own icon in the composer and menu", async ({
  page,
  ui,
}) => {
  await ui.open("done");
  const field = await composer(page);
  const button = field.getByRole("button", { name: /^Permission mode:/ });
  const icons = new Set<string>();
  for (const name of ["Custom", "Auto", "Full access"]) {
    await button.click();
    const option = page.getByRole("menuitemradio", { name: new RegExp(`^${name} `) });
    const icon = await option.locator(".permission-menu-name svg").innerHTML();
    await option.click();
    await expect(button).toHaveAccessibleName(`Permission mode: ${name}`);
    await expect(button).not.toHaveAttribute("aria-disabled", "true");
    expect(await button.locator("svg").innerHTML()).toBe(icon);
    icons.add(icon);
  }
  expect(icons.size).toBe(3);
  await page.screenshot({ path: test.info().outputPath("permission-full.png") });
  await page.reload();
  await expect(
    (await composer(page)).getByRole("button", { name: "Permission mode: Full access" }),
  ).toBeVisible();
});
