import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, type Harness, keepBaselinesAt, test } from "./harness.ts";

// Export from Replay: the popover's choices, a video being made, a saved file and a browser that
// cannot make video. Chrome saves through its save picker (lent here, so nothing reaches the disk);
// WebKit has none and saves through a download.
keepBaselinesAt("c14", "w39");

// Holds the export worker at 12 of 40 frames, or with `done` writes 2.4 MB and finishes, so the
// pictures do not depend on how fast a machine encodes.
function holdExports(page: Page, finish: boolean) {
  return page.addInitScript((finish) => {
    const Real = window.Worker;
    // Called with new, a function that returns an object gives that object.
    function Held(url: string | URL, options?: WorkerOptions) {
      if (!String(url).includes("mp4-worker")) return new Real(url, options);
      const fake = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        onerror: null,
        onmessageerror: null,
        terminate() {},
        postMessage(message: { type: string }) {
          const send = (data: unknown) => setTimeout(() => fake.onmessage?.({ data }));
          if (message.type === "start") {
            send({ type: "progress", done: 12, total: 40, openFrames: 1, encodeQueue: 1 });
            if (finish)
              send({ type: "chunk", chunk: 0, position: 0, data: new ArrayBuffer(2_400_000) });
          } else if (message.type === "ack") {
            send({ type: "progress", done: 40, total: 40, openFrames: 1, encodeQueue: 1 });
            send({ type: "done", frames: 40, bytes: 2_400_000, hashes: null });
          } else if (message.type === "cancel") send({ type: "cancelled" });
        },
      };
      return fake;
    }
    window.Worker = Held as unknown as typeof Worker;
    if ("showSaveFilePicker" in window)
      Object.assign(window, {
        showSaveFilePicker: async ({ suggestedName }: { suggestedName: string }) => ({
          name: suggestedName,
          createWritable: async () => ({
            write: async () => {},
            close: async () => {},
            abort: async () => {},
          }),
        }),
      });
  }, finish);
}

async function openExport(page: Page, ui: Harness) {
  await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=16000`);
  await expect(page.getByRole("status", { name: "Replay time" })).toHaveText("0:16 / 3:00");
  await ui.picture(page.locator(".replay-stage"));
  await page.getByRole("button", { name: "Export MP4" }).click();
  const panel = page.getByRole("dialog", { name: "Export MP4" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Save/ })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  return panel;
}

async function still(ui: Harness) {
  await ui.settle();
  await ui.still();
}

const save = (panel: Locator) => panel.getByRole("button", { name: /^Save/ }).click();

test("export, options", async ({ page, ui }) => {
  const panel = await openExport(page, ui);
  await expect(panel.getByRole("radio", { name: "Whole" })).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByRole("radio", { name: "Selection" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await still(ui);
  await expect(page).toHaveScreenshot("export-options.png");
});

test("export, progress", async ({ page, ui }) => {
  await holdExports(page, false);
  const panel = await openExport(page, ui);
  const options = await panel.boundingBox();
  await save(panel);
  await expect(panel.getByText("30% · working out the time left")).toBeVisible();
  expect(await panel.boundingBox()).toEqual(options);
  await still(ui);
  await expect(page).toHaveScreenshot("export-progress.png");
});

test("export, saved", async ({ page, ui }) => {
  await holdExports(page, true);
  const panel = await openExport(page, ui);
  await save(panel);
  const ready = panel.getByRole("button", { name: "Save video" });
  const saved = panel.getByText("Video saved", { exact: true });
  await expect(ready.or(saved)).toBeVisible();
  if (await ready.isVisible()) {
    const [download] = await Promise.all([page.waitForEvent("download"), ready.click()]);
    expect(download.suggestedFilename()).toBe("localdot-2026-10-08-0901.mp4");
  }
  await expect(saved).toBeVisible();
  await expect(panel.getByText("2.3 MB · 1:38", { exact: true })).toBeVisible();
  await still(ui);
  await expect(page).toHaveScreenshot("export-saved.png");
});

test("export, unsupported", async ({ page, ui }) => {
  await page.addInitScript(() => Object.assign(window, { VideoEncoder: undefined }));
  await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=16000`);
  await ui.picture(page.locator(".replay-stage"));
  const trigger = page.getByRole("button", { name: "Export MP4" });
  const reason = "Export needs Chrome, Edge or Safari 17 or later";
  await expect(trigger).toHaveAttribute("aria-disabled", "true");
  await expect(trigger).toHaveAccessibleDescription(reason);
  await trigger.click({ force: true });
  await expect(page.locator(".ui-tooltip")).toContainText(reason);
  await expect(page.getByRole("dialog", { name: "Export MP4" })).toHaveCount(0);
  await still(ui);
  await expect(page).toHaveScreenshot("export-unsupported.png");
});

test.describe("in WebKit", () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== "webkit", "Safari's path: no save picker");
  });

  test("Export saves through a download, or says why it cannot", async ({ page, ui }) => {
    await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=16000`);
    await ui.picture(page.locator(".replay-stage"));
    const trigger = page.getByRole("button", { name: "Export MP4" });
    if ((await trigger.getAttribute("aria-disabled")) === "true") {
      await expect(trigger).toHaveAccessibleDescription(/\S/);
      return;
    }
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "Export MP4" });
    await panel.getByRole("radio", { name: "This step" }).click();
    await panel.getByRole("radio", { name: "8×" }).click();
    await panel.getByRole("radio", { name: "720p" }).click();
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    const ready = panel.getByRole("button", { name: "Save video" });
    await expect(ready).toBeVisible({ timeout: 60_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), ready.click()]);
    expect(download.suggestedFilename()).toMatch(/^localdot-.+\.mp4$/);
    const head = readFileSync(await download.path());
    expect(head.length).toBeGreaterThan(1000);
    expect(head.subarray(4, 8).toString("latin1")).toBe("ftyp");
    await expect(panel.getByText("Video saved", { exact: true })).toBeVisible();
  });
});
