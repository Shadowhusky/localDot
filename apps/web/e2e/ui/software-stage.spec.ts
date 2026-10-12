import { expect, runAt, test } from "./harness.ts";

runAt("c14");
test.use({
  fixedClock: false,
  launchOptions: { args: ["--disable-webgl", "--disable-gpu"] },
});

test("software rendering paints video and retains the picture through resize", async ({
  page,
  ui,
}) => {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("stage worker:"))
      failures.push(message.text());
  });
  await ui.open("ready");
  // These flags exercise Pixi's real Canvas2D fallback, inside the real rendering worker.
  expect(
    await page.evaluate(() => document.createElement("canvas").getContext("webgl2")),
  ).toBeNull();
  const canvas = page.locator("canvas.stage-canvas");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-frames")))
    .toBeGreaterThan(5);
  await ui.picture();
  const before = Number(await canvas.getAttribute("data-frames"));
  await page.setViewportSize({ width: 1100, height: 760 });
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-frames")))
    .toBeGreaterThan(before + 5);
  await ui.picture();
  expect(failures).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("software-video.png") });
});
