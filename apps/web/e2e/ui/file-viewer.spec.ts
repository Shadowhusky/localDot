import type { Locator, Page } from "@playwright/test";
import { PANEL_NAME } from "../../src/shell/panel-name.ts";
import { expect, type Harness, isPhone, runAt, test } from "./harness.ts";

// Files on dot's computer open in the one viewer: the files a message carried, from their chips,
// and the files a task changed, from Activity's Files and from a change's own preview. Each kind
// shows as itself; anything else says so and downloads.
runAt("c14", "c39", "w39");

interface Placed {
  uploads: string[];
  changed: string[];
}

// A finished turn first, so the follow-up that carries the files reads as a message.
async function place(page: Page, ui: Harness): Promise<Placed> {
  const fixture = await ui.open("running");
  const turn = await page.request.post(`${fixture.origin}/__qa/files?count=1`);
  expect(turn.ok(), await turn.text()).toBe(true);
  const put = await page.request.post(`${fixture.origin}/__qa/computer-files`);
  expect(put.ok(), await put.text()).toBe(true);
  return (await put.json()) as Placed;
}

// The page as it is, in both appearances.
async function shoot(page: Page, ui: Harness, name: string) {
  for (const appearance of ["graphite", "midnight"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath(`${name}-${appearance}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.appearance = "graphite";
  });
}

async function next(viewer: Locator) {
  await viewer.getByRole("button", { name: "Next file" }).click();
}

async function activityFiles(page: Page) {
  if (isPhone(page)) await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: PANEL_NAME, exact: true }).click();
  await page
    .getByRole("tablist", { name: PANEL_NAME })
    .getByRole("tab", { name: /^Files/ })
    .click();
}

test("a message's files open from their chips, each kind as itself", async ({ page, ui }) => {
  await place(page, ui);
  const chips = page.locator(".thread-bubble-files").last();
  const thumb = chips.locator(".file-chip-thumb");
  await expect
    .poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await chips.scrollIntoViewIfNeeded();
  await shoot(page, ui, "chat-chips");

  await chips.getByRole("button", { name: "Open photo.png" }).click();
  const viewer = page.locator(".file-viewer");
  const photo = viewer.getByRole("img", { name: "photo.png" });
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1600);
  await expect(viewer.getByText(/^PNG picture · /)).toBeVisible();
  await shoot(page, ui, "viewer-picture");

  await next(viewer);
  await expect(viewer.locator(".viewer-page-canvas canvas").first()).toBeVisible();
  await shoot(page, ui, "viewer-pdf");

  await next(viewer);
  const table = viewer.locator(".viewer-table-scroll table");
  await expect(table.locator("tbody tr")).toHaveCount(30);
  await expect(viewer.getByRole("radio", { name: "Table" })).toBeChecked();
  await shoot(page, ui, "viewer-table");
  await viewer.getByRole("radio", { name: "Source" }).click();
  await expect(viewer.getByRole("region", { name: "Contents of figures.csv" })).toBeVisible();

  await next(viewer);
  const code = viewer.getByRole("region", { name: "Contents of main.ts" });
  await expect(code.locator(".tok-k").first()).toBeVisible();
  await expect(viewer.getByRole("radio")).toHaveCount(0);
  await shoot(page, ui, "viewer-code");

  await next(viewer);
  await expect(viewer.locator(".ui-file-card")).toBeVisible();
  await expect(viewer.getByText("No preview for this kind of file")).toBeVisible();
  await shoot(page, ui, "viewer-binary");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    viewer.getByRole("button", { name: "Download" }).last().click(),
  ]);
  expect(download.suggestedFilename()).toBe("firmware.bin");

  await next(viewer);
  const audio = viewer.locator("audio");
  await expect(audio).toBeVisible();
  await expect
    .poll(() => audio.evaluate((media: HTMLAudioElement) => media.duration))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();
  await expect(chips.getByRole("button", { name: "Open photo.png" })).toBeVisible();
});

// A draft's files open before they are sent, from the copy on this device: a picture as itself, a
// text's words, and anything else saying it has no preview. Nothing there downloads.
test("a draft's files open from their chips before they are sent", async ({ page, ui }) => {
  await ui.open("running");
  const composer = page.locator(".composer");
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const files = [
    { name: "pixel.png", mimeType: "image/png", buffer: pixel },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("first line\nsecond line\n") },
    {
      name: "firmware.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0, 1, 2, 3]),
    },
  ];
  const chips = composer.getByRole("list", { name: "Attached files" });
  // The composer turns files away while it reconnects to the task it just opened; once it takes
  // them, they stay.
  await expect(async () => {
    if ((await chips.getByRole("listitem").count()) === 0)
      await composer.locator("input[type=file]").setInputFiles(files);
    await expect(chips.getByRole("listitem")).toHaveCount(3, { timeout: 2_000 });
  }).toPass();

  await chips.getByRole("button", { name: "Open pixel.png" }).click();
  const viewer = page.locator(".file-viewer");
  const pixelShown = viewer.getByRole("img", { name: "pixel.png" });
  await expect.poll(() => pixelShown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(viewer.getByRole("button", { name: "Download" })).toHaveCount(0);

  await next(viewer);
  await expect(viewer.getByText("second line")).toBeVisible();
  await next(viewer);
  await expect(viewer.getByText("No preview for this kind of file")).toBeVisible();
  await shoot(page, ui, "draft-binary");
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(chips.getByRole("listitem")).toHaveCount(3);
});

test("a changed file opens from Activity's Files, beside its changes", async ({ page, ui }) => {
  const placed = await place(page, ui);
  await activityFiles(page);
  const row = page
    .locator(".activity-rail")
    .getByTestId("change-row")
    .filter({ hasText: "server.ts" })
    .last();
  await row.locator(".activity-row-head").click();
  const server = placed.changed.find((path) => path.endsWith("server.ts")) ?? "";
  await expect(row.getByRole("button", { name: `Download ${server}` })).toBeVisible();
  await shoot(page, ui, "activity-changed");
  await row.getByRole("button", { name: `Open ${server}` }).click();

  const viewer = page.locator(".file-viewer");
  await expect(viewer.getByRole("region", { name: "Contents of server.ts" })).toBeVisible();
  await expect(viewer.getByRole("radio", { name: "Rendered" })).toHaveCount(0);
  await viewer.getByRole("radio", { name: "Changes" }).click();
  const changes = viewer.getByRole("region", { name: "Changes to server.ts" });
  await expect(changes.locator('[data-kind="add"]').first()).toBeVisible();
  await expect(changes.locator('[data-kind="remove"]').first()).toBeVisible();
  if (!isPhone(page)) {
    await viewer.getByRole("radio", { name: "Side by side" }).click();
    await expect(changes.locator('[data-layout="split"]').first()).toBeVisible();
  }
  await shoot(page, ui, "viewer-changes");

  // Markdown keeps its own view, rendered; code comes back on Changes, the view last chosen for it.
  await viewer.getByRole("button", { name: "Previous file" }).click();
  await expect(viewer.getByRole("radio", { name: "Rendered" })).toBeChecked();
  await expect(viewer.getByRole("radio")).toHaveCount(3);
  await expect(viewer.getByRole("region", { name: "Rendered report.md" })).toBeVisible();
  await shoot(page, ui, "viewer-markdown");
  await next(viewer);
  await expect(viewer.getByRole("radio", { name: "Changes" })).toBeChecked();
});

test("a change's own preview opens the file at its changes", async ({ page, ui }) => {
  await place(page, ui);
  if (isPhone(page)) await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: PANEL_NAME, exact: true }).click();
  const row = page
    .locator(".activity-rail")
    .getByTestId("tool-row")
    .filter({ hasText: /edit .*server\.ts/ })
    .last();
  await row.scrollIntoViewIfNeeded();
  await row.locator(".activity-row-head").click();
  const diff = row.locator(".diff-viewer");
  if (!isPhone(page)) await diff.hover();
  await diff.getByRole("button", { name: "Preview code changes" }).click();
  const viewer = page.locator(".file-viewer");
  await expect(viewer.getByRole("radio", { name: "Changes" })).toBeChecked();
  await expect(viewer.getByRole("radio")).toHaveCount(isPhone(page) ? 2 : 4);
  await expect(viewer.getByRole("region", { name: "Changes to server.ts" })).toBeVisible();
  await shoot(page, ui, "side-panel-changes");
  await viewer.getByRole("radio", { name: "File" }).click();
  await expect(viewer.getByRole("region", { name: "Contents of server.ts" })).toBeVisible();
});
