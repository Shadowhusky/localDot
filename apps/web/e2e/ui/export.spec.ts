import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, type Harness, runAt, test } from "./harness.ts";

// Export from Replay: the sheet's choices, a video being made, a saved file and a browser that
// cannot make video. Chrome saves through its save picker (lent here, so nothing reaches the disk);
// WebKit has none and saves through a download.
runAt("c14", "w14", "w39");

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

// Replay plays on a stage of its own; Watch's stays mounted under it.
const replayStage = (page: Page) => page.getByRole("main", { name: "Replay" }).locator(".stage");

async function openExport(page: Page, ui: Harness) {
  await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=16000`);
  await expect(page.getByRole("status", { name: "Replay time" })).toHaveText("0:16");
  await expect(page.locator(".replay-length")).toHaveText("3:00");
  await ui.picture(replayStage(page));
  await page.getByRole("button", { name: "Export video" }).click();
  const panel = page.getByRole("dialog", { name: "Export video" });
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
});

test("export, progress", async ({ page, ui }) => {
  await holdExports(page, false);
  const panel = await openExport(page, ui);
  const options = await panel.boundingBox();
  await save(panel);
  await expect(panel.getByText("30% · working out the time left")).toBeVisible();
  expect(await panel.boundingBox()).toEqual(options);
  await still(ui);
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
    await expect(panel.getByText("Downloaded", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Save again" })).toBeVisible();
  } else await expect(saved).toBeVisible();
  await expect(panel.getByText(/^2\.3 MB · 1:38 video · made in \d+:\d\d$/)).toBeVisible();
  await still(ui);
});

test("export, unsupported", async ({ page, ui }) => {
  await page.addInitScript(() => Object.assign(window, { VideoEncoder: undefined }));
  await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=16000`);
  await ui.picture(replayStage(page));
  const trigger = page.getByRole("button", { name: "Export video" });
  const reason = "Export needs Chrome, Edge or Safari 17 or later";
  await expect(trigger).toHaveAttribute("aria-disabled", "true");
  await expect(trigger).toHaveAccessibleDescription(reason);
  await trigger.click({ force: true });
  await expect(page.locator(".ui-tooltip")).toContainText(reason);
  await expect(page.getByRole("dialog", { name: "Export video" })).toHaveCount(0);
  await still(ui);
});

test.describe("in WebKit", () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== "webkit", "Safari's path: no save picker");
  });

  test("Export saves through a download, or says why it cannot", async ({ page, ui }) => {
    await ui.open("done", (fixture) => `/?replay=${fixture.seeded[0]}&t=16000`);
    await ui.picture(replayStage(page));
    const trigger = page.getByRole("button", { name: "Export video" });
    if ((await trigger.getAttribute("aria-disabled")) === "true") {
      await expect(trigger).toHaveAccessibleDescription(/\S/);
      return;
    }
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "Export video" });
    await panel.getByRole("radio", { name: "This step" }).click();
    await panel
      .getByRole("radiogroup", { name: "Preset" })
      .getByRole("radio", { name: "Fast" })
      .click();
    await panel
      .getByRole("radiogroup", { name: "Speed" })
      .getByRole("radio", { name: "3×" })
      .click();
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    const ready = panel.getByRole("button", { name: "Save video" });
    await expect(ready).toBeVisible({ timeout: 60_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), ready.click()]);
    expect(download.suggestedFilename()).toMatch(/^localdot-.+\.mp4$/);
    const head = readFileSync(await download.path());
    expect(head.length).toBeGreaterThan(1000);
    expect(head.subarray(4, 8).toString("latin1")).toBe("ftyp");
    await expect(panel.getByText("Downloaded", { exact: true })).toBeVisible();
    const [again] = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("button", { name: "Save again" }).click(),
    ]);
    expect(again.suggestedFilename()).toBe(download.suggestedFilename());
  });
});
