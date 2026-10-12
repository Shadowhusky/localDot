import { expect, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`status changes animate once and retire the previous line (${reducedMotion})`, async ({
    page,
    ui,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await ui.open("running");
    const status = page.getByTestId("hud-status");
    await expect(status).toHaveText("Select the Net total cell");
    await expect(page.locator(".island-text-leaving")).toHaveCount(0);
    const original = await status.locator("span").elementHandle();
    await page.evaluate(() => {
      const root = document.querySelector(".island-label-text");
      if (!root) throw new Error("Missing status label");
      const animations: string[] = [];
      Object.assign(window, { statusAnimations: animations });
      root.addEventListener("animationstart", (event) =>
        animations.push((event as AnimationEvent).animationName),
      );
    });
    // A clock tick is not a text change.
    await page.waitForTimeout(1100);
    expect(await status.locator("span").evaluate((node, before) => node === before, original)).toBe(
      true,
    );
    expect(await page.evaluate(() => Reflect.get(window, "statusAnimations"))).toEqual([]);
    const stop = await page
      .locator(".island")
      .getByRole("button", { name: "Stop" })
      .elementHandle();
    await ui.step("ask");
    await expect(status).toHaveText("Needs your answer");
    await expect(page.locator(".island-text-leaving")).toHaveCount(0);
    const animations = await page.evaluate(
      () => Reflect.get(window, "statusAnimations") as string[],
    );
    expect(animations).toEqual(
      expect.arrayContaining(
        reducedMotion === "reduce"
          ? ["island-text-fade-in", "island-text-fade-out"]
          : ["island-text-in", "island-text-out"],
      ),
    );
    expect(
      await page
        .locator(".island")
        .getByRole("button", { name: "Stop" })
        .evaluate((node, before) => node === before, stop),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`hud-${reducedMotion}.png`) });
  });
}
