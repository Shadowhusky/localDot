import { expect, openComputerScreen, runAt, test } from "./harness.ts";

runAt("c39", "w39");
test.use({ viewStyle: "chat" });

// An iPhone's home indicator is about 5 pt tall, 8 pt above the screen's edge. The composer may sit
// inside the safe area around it, so long as nothing to tap reaches it.
const HOME_INDICATOR_TOP = 13;

const LONG_LINE =
  "Still checking textures and which rig nodes Godot relies on before writing the new build script for the pistol";

test("going to the computer and back pauses, stops, takes and reconnects nothing", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await ui.picture();
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
    for (let repeat = 0; repeat < 2; repeat++) {
      await openComputerScreen(page);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      // Sideways the picture takes the height, and the steer box waits for the phone to turn back.
      if (viewport.width < viewport.height)
        await expect(page.getByPlaceholder("Steer dot")).toBeVisible();
      await ui.settle();
      await page.screenshot({
        path: test.info().outputPath(`computer-${viewport.width}-${repeat}.png`),
      });
      await page.getByRole("button", { name: "Back to the conversation" }).tap();
      await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "1");
    }
    // The same client all along, while the phone is held the same way.
    if (viewport.width < viewport.height) {
      expect(await stream?.evaluate((element) => element.isConnected)).toBe(true);
      expect(effects, "nothing to reconnect").toEqual([]);
    }
  }
  await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
  // Turning the phone can leave the thumbnail out of sight for a moment, and a viewer may ask for a
  // new client after that; nothing happens to the computer.
  expect(
    effects.filter((path) => !path.endsWith("/stream-ticket")),
    "the computer must not be paused, stopped or taken",
  ).toEqual([]);
});

test("held sideways, the picture takes the height with its controls in reach", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await ui.picture();
  await openComputerScreen(page);
  await page.setViewportSize({ width: 844, height: 390 });
  const box = page.locator(".phone-picture .stage-box");
  await expect.poll(async () => (await box.boundingBox())?.height).toBeGreaterThan(330);
  const picture = await box.boundingBox();
  const stop = await page.getByRole("button", { name: "Stop", exact: true }).boundingBox();
  expect((picture?.x ?? 0) + (picture?.width ?? 0)).toBeLessThanOrEqual(stop?.x ?? 0);
  await page.screenshot({ path: test.info().outputPath("sideways.png") });
});

test("a long line of dot's stays in two lines beside it, at the thread's foot", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/say?text=${encodeURIComponent(LONG_LINE)}`);
  const line = page.locator(".dot-strip .narration-line:not([data-leaving])");
  await expect(line).toContainText("Still checking");
  const box = await line.boundingBox();
  const lineHeight = await line.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).lineHeight),
  );
  expect(box?.height).toBeLessThanOrEqual(lineHeight * 2 + 1);
  await page.screenshot({ path: test.info().outputPath("long-line.png") });
});

test("a tap on dot opens its menu, which changes it, its look, or hides it", async ({
  page,
  ui,
}) => {
  await ui.open("done");
  const dot = page.getByRole("button", { name: "Your dot" });
  await dot.tap();
  await page.getByRole("menuitem", { name: "Change look" }).tap();
  await expect(page.getByRole("dialog", { name: "Change look" })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).last().tap();
  await dot.tap();
  await page.getByRole("menuitem", { name: "Change dot" }).tap();
  await expect(page.getByRole("dialog", { name: "Your dot" })).toBeVisible();
});

test("the stack keeps clear of an iPhone's safe areas", async ({ page, ui, browserName }) => {
  test.skip(browserName !== "chromium", "Safe areas are emulated through Chromium's DevTools");
  await ui.open("running");
  await ui.picture();
  const cdp = await page.context().newCDPSession(page);
  // The status bar and home indicator upright, the notch sideways; an iPhone SE's status bar over
  // the app added to its Home Screen.
  for (const [size, insets] of [
    [
      { width: 320, height: 568 },
      { top: 20, right: 0, bottom: 0, left: 0 },
    ],
    [
      { width: 390, height: 844 },
      { top: 47, right: 0, bottom: 34, left: 0 },
    ],
    [
      { width: 430, height: 932 },
      { top: 59, right: 0, bottom: 34, left: 0 },
    ],
  ] as const) {
    await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets } as never);
    await page.setViewportSize(size);
    // Until the app has taken this size, the last one's layout says nothing about it.
    await expect
      .poll(() => page.locator(".app").evaluate((app) => app.clientHeight))
      .toBe(size.height);
    const lowest = size.height - (insets.bottom ? HOME_INDICATOR_TOP : 0);
    for (const control of [".composer-card", ".composer-send", ".phone-plus"])
      await expect
        .poll(
          async () => {
            const box = await page.locator(control).boundingBox();
            return box ? box.y + box.height : Number.POSITIVE_INFINITY;
          },
          { message: `${control} over the home indicator` },
        )
        .toBeLessThanOrEqual(lowest);
    const back = await page.getByRole("button", { name: "Back to conversations" }).boundingBox();
    expect(back?.y, "Back under the status bar").toBeGreaterThanOrEqual(insets.top);
    await page.screenshot({
      path: test.info().outputPath(`safe-${size.width}x${size.height}.png`),
    });
  }
});
