import type { Locator } from "@playwright/test";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "w39");
test.use({ fixedClock: false });

async function trim(panel: Locator, from: string, to: string) {
  const end = panel.getByRole("textbox", { name: "End time" });
  await end.fill(to);
  await end.press("Enter");
  const start = panel.getByRole("textbox", { name: "Start time" });
  await start.fill(from);
  await start.press("Enter");
}

async function position(panel: Locator, ms: number) {
  await panel.getByRole("slider", { name: "Preview position" }).fill(String(ms));
}

async function pause(panel: Locator) {
  await panel.getByRole("button", { name: "Pause preview" }).click();
  await expect(panel.getByRole("button", { name: "Play preview" })).toBeVisible();
}

test("preview plays only the trim at export speed, seeks, pauses and replays", async ({
  page,
  ui,
}, info) => {
  await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=16000`);
  await page.getByRole("button", { name: "Export video" }).click();
  const panel = page.getByRole("dialog", { name: "Export video" });
  await trim(panel, "0:12", "0:16");
  await panel.getByRole("button", { name: "More options" }).click();
  await panel.getByRole("switch", { name: "Skip idle" }).click();
  await panel.getByRole("button", { name: "More options" }).click();
  await panel.getByRole("radiogroup", { name: "Speed" }).getByRole("radio", { name: "2×" }).click();
  await expect(panel.getByRole("timer", { name: "Preview time" })).toHaveText("0:00.0 / 0:02.0");
  await panel.getByRole("button", { name: "Play preview" }).click();
  const canvas = panel.locator(".export-preview-surface[data-visible] canvas");
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-session-ms")))
    .toBeGreaterThan(12000);
  await pause(panel);
  await position(panel, 1000);
  await expect(canvas).toHaveAttribute("data-session-ms", "14000");
  await expect(panel.getByRole("timer", { name: "Preview time" })).toHaveText("0:01.0 / 0:02.0");
  const frame = await canvas.getAttribute("data-frame");
  await page.waitForTimeout(200);
  expect(await canvas.getAttribute("data-frame")).toBe(frame);
  await info.attach("trimmed-preview", {
    body: await panel.screenshot({ path: info.outputPath("trimmed-preview.png") }),
    contentType: "image/png",
  });
  const controls = await panel.locator(".export-preview-controls").boundingBox();
  expect(controls).not.toBeNull();
  expect((controls?.x ?? 0) + (controls?.width ?? 0)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 0,
  );
  await panel.getByRole("button", { name: "Play preview" }).click();
  await expect(panel.getByRole("timer", { name: "Preview time" })).toHaveText("0:02.0 / 0:02.0");
  await expect(panel.getByRole("button", { name: "Play preview" })).toBeVisible();
  expect(Number(await canvas.getAttribute("data-session-ms"))).toBeLessThan(16000);
  await panel.getByRole("button", { name: "Play preview" }).click();
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-session-ms")))
    .toBeLessThan(14000);
  await pause(panel);
});

test("editing the trim or output options resets preview and closing releases it", async ({
  page,
  ui,
}) => {
  await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=16000`);
  await page.getByRole("button", { name: "Export video" }).click();
  const panel = page.getByRole("dialog", { name: "Export video" });
  await panel.getByRole("button", { name: "Play preview" }).click();
  await expect(panel.locator(".export-preview-surface[data-visible] canvas")).toBeVisible();
  await trim(panel, "0:16", "0:19");
  await expect(panel.locator(".export-preview-surface canvas")).toHaveCount(0);
  await expect(panel.getByRole("timer", { name: "Preview time" })).toHaveText("0:00.0 / 0:03.0");
  await panel.getByRole("switch", { name: "Show dot", exact: true }).click();
  await panel.getByRole("button", { name: "Play preview" }).click();
  await expect(panel.locator(".export-preview-surface[data-visible] canvas")).toBeVisible();
  await pause(panel);
  await panel.getByRole("button", { name: "More options" }).click();
  await panel.getByRole("switch", { name: "Skip idle" }).click();
  await expect(panel.locator(".export-preview-surface canvas")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Play preview" })).toBeVisible();
  await panel.getByRole("button", { name: "Play preview" }).click();
  await expect(panel.locator(".export-preview-surface[data-visible] canvas")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.locator(".export-preview-surface canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Export video" }).click();
  await panel.getByRole("button", { name: "Play preview" }).click();
  await expect(panel.locator(".export-preview-surface[data-visible] canvas")).toBeVisible();
  await pause(panel);
});
