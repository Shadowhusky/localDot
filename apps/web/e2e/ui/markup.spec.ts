import type { Locator, Page } from "@playwright/test";
import { expect, finger, openFile, runAt, test } from "./harness.ts";

runAt("c14", "w14", "c39");

// A line across part of the drawing, by finger on a touch screen and by mouse elsewhere.
async function stroke(page: Page, canvas: Locator, from: [number, number], to: [number, number]) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The drawing is not on screen");
  const [x0, y0] = [box.x + box.width * from[0], box.y + box.height * from[1]];
  const [x1, y1] = [box.x + box.width * to[0], box.y + box.height * to[1]];
  if (test.info().project.name === "c39") {
    await (await finger(page)).drag(x0, y0, x1, y1);
    return;
  }
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let step = 1; step <= 8; step++)
    await page.mouse.move(x0 + ((x1 - x0) * step) / 8, y0 + ((y1 - y0) * step) / 8);
  await page.mouse.up();
}

// How much of the drawing is drawn on, out of every pixel's alpha.
const inked = (canvas: Locator) =>
  canvas.evaluate((node: HTMLCanvasElement) => {
    const data = node.getContext("2d")?.getImageData(0, 0, node.width, node.height).data ?? [];
    let drawn = 0;
    for (let at = 3; at < data.length; at += 4) if ((data[at] ?? 0) > 0) drawn += 1;
    return drawn;
  });

test("marks up a picture and attaches the marked copy to the message", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/previews`);
  const card = page.getByRole("region", { name: "Task result" }).last();
  await openFile(page, "chart.png", card);
  const sheet = page.getByRole("dialog", { name: "chart.png" });
  await expect(sheet.locator(".viewer-canvas")).toHaveAttribute("data-ready", "true");
  await sheet.getByRole("button", { name: "Mark up", exact: true }).click();

  const canvas = sheet.locator(".markup-canvas");
  const add = sheet.getByRole("button", { name: "Add to message", exact: true });
  await expect(sheet.locator(".markup-picture")).toHaveAttribute("data-ready", "");
  await expect(add).toHaveAttribute("aria-disabled", "true");
  await expect(sheet.getByRole("button", { name: "Pen", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await stroke(page, canvas, [0.2, 0.3], [0.7, 0.4]);
  await expect.poll(() => inked(canvas)).toBeGreaterThan(0);
  const pen = await inked(canvas);
  await sheet.getByRole("button", { name: "Box", exact: true }).click();
  await sheet.getByRole("button", { name: "Blue", exact: true }).click();
  await stroke(page, canvas, [0.3, 0.55], [0.8, 0.85]);
  await expect.poll(() => inked(canvas)).toBeGreaterThan(pen);
  // Undo takes the box away and Redo brings it back.
  await sheet.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => inked(canvas)).toBe(pen);
  await sheet.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(() => inked(canvas)).toBeGreaterThan(pen);

  // The message box turns files away while it reconnects to the task it just opened, and says so.
  const chips = page.locator(".composer").getByRole("list", { name: "Attached files" });
  await expect(async () => {
    if (await add.isVisible()) await add.click();
    await expect(chips.getByRole("listitem")).toHaveCount(1, { timeout: 2_000 });
  }).toPass();
  await expect(sheet).toBeHidden();
  await expect(chips).toContainText("chart marked up.png");
});

test("puts the marks away without touching the picture or the message", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.request.post(`${fixture.origin}/__qa/previews`);
  await openFile(page, "chart.png", page.getByRole("region", { name: "Task result" }).last());
  const sheet = page.getByRole("dialog", { name: "chart.png" });
  await sheet.getByRole("button", { name: "Mark up", exact: true }).click();
  await expect(sheet.locator(".markup-picture")).toHaveAttribute("data-ready", "");
  await stroke(page, sheet.locator(".markup-canvas"), [0.2, 0.2], [0.6, 0.6]);
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet.locator(".viewer-canvas")).toHaveAttribute("data-ready", "true");
  await expect(sheet.getByRole("button", { name: "Mark up", exact: true })).toBeVisible();
  await expect(page.locator(".composer").getByRole("list", { name: "Attached files" })).toHaveCount(
    0,
  );
});
