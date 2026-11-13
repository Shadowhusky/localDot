import { expect, runAt, test } from "./harness.ts";

// The marks that turn while dot works turn for hours. One the compositor can't run alone (an arc
// turning inside its SVG) has the whole page laid out for every frame of them, which a phone pays
// for in heat.
runAt("c39");
test.use({ fixedClock: false, viewStyle: "chat" });

test("a task at work with nothing new to show lays the page out for few of its frames", async ({
  page,
  ui,
}) => {
  await ui.open("running");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await ui.settle();
  await expect(page.locator(".ui-session-glyph[data-status='working']").first()).toBeAttached();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const read = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return {
      layouts: metrics.find((metric) => metric.name === "LayoutCount")?.value ?? 0,
      frames: await page.evaluate(
        () => (window as unknown as { seen: { frames: number } }).seen.frames,
      ),
    };
  };
  await page.evaluate(() => {
    const seen = { frames: 0 };
    Object.defineProperty(window, "seen", { value: seen });
    const tick = () => {
      seen.frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.waitForTimeout(1000);
  const before = await read();
  await page.waitForTimeout(3000);
  const after = await read();
  const frames = after.frames - before.frames;
  expect(frames).toBeGreaterThan(30);
  expect((after.layouts - before.layouts) / frames).toBeLessThan(0.5);
});
