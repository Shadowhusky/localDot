import { expect, runAt, test } from "./harness.ts";

runAt("c39", "w39");

for (const fallback of [false, true]) {
  test(`watching a running task can enter and leave full screen${fallback ? " without the browser API" : ""}`, async ({
    page,
    ui,
  }) => {
    if (fallback)
      await page.addInitScript(() => {
        Object.defineProperty(Element.prototype, "requestFullscreen", {
          configurable: true,
          value: undefined,
        });
      });
    await ui.open("running");
    await ui.picture();
    const app = page.locator(".app");
    await expect(app).not.toHaveAttribute("data-entering");
    await ui.settle();
    const expand = page.locator(".stage-expand").getByRole("button", { name: "Full screen" });
    const leave = page.getByRole("button", { name: "Exit full screen" });
    const stream = await page.locator("iframe.desktop-frame").elementHandle();
    expect(stream).not.toBeNull();
    const effects: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/"))
        effects.push(new URL(request.url()).pathname);
    });

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      // Landscape enters focus automatically. Leaving must not prevent a later explicit tap.
      if (viewport.width > viewport.height) {
        await expect(app).toHaveAttribute("data-focus", "");
        await leave.tap();
      }
      for (let repeat = 0; repeat < 2; repeat++) {
        await expect(app).not.toHaveAttribute("data-focus");
        await expect(page.locator(".stage-expand")).toHaveCSS("opacity", "1");
        const target = await expand.boundingBox();
        expect(target?.width).toBeGreaterThanOrEqual(44);
        expect(target?.height).toBeGreaterThanOrEqual(44);
        if (repeat === 0)
          await page.screenshot({ path: test.info().outputPath(`watch-${viewport.width}.png`) });
        await expand.tap();
        await expect(app).toHaveAttribute("data-focus", "");
        await expect(leave).toBeVisible();
        await expect(page.getByRole("form", { name: "Message dot" })).toBeHidden();
        await expect(
          page.locator(".focus-controls").getByRole("button", { name: "Stop", exact: true }),
        ).toBeEnabled();
        await ui.settle();
        await page.screenshot({
          path: test.info().outputPath(`full-${viewport.width}-${repeat}.png`),
        });
        await leave.tap();
        await expect(page.getByRole("form", { name: "Message dot" })).toBeVisible();
      }
    }
    expect(await stream?.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
    expect(
      effects,
      "fullscreen must not pause, stop, take control, or reconnect the computer",
    ).toEqual([]);
  });
}
