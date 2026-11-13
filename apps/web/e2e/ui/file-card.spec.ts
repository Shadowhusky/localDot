import type { Locator, Page } from "@playwright/test";
import { PANEL_NAME } from "../../src/shell/panel-name.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

// A file that can't be shown where it is shows its card: its name, kind and size, and what can be
// done with it. One the browser can play shows its player.
runAt("c14", "c39", "w14", "w39");

async function handed(page: Page, origin: string) {
  const reply = await page.request.post(`${origin}/__qa/previews`);
  expect(reply.ok(), await reply.text()).toBe(true);
  const card = page.getByRole("region", { name: "Task result" }).last();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /^Show \d+ more files$/ }).click();
  return card;
}

const shoot = async (page: Page, name: string) => {
  for (const appearance of ["daylight", "graphite"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    // Colours ease to the new appearance: the picture is of where they end.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((motion) => motion.effect?.getComputedTiming().endTime !== Infinity)
          .map((motion) => motion.finished.catch(() => null)),
      ),
    );
    await page.screenshot({ path: test.info().outputPath(`${name}-${appearance}.png`) });
  }
};

const open = async (row: Locator, name: string) => {
  await row.getByRole("button", { name: `Show ${name}` }).click();
  await expect(row.getByRole("button", { name: `Hide ${name}` })).toBeVisible();
};

test("a zip under its row shows its card and a download, with nothing to explain", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  const result = await handed(page, fixture.origin);
  const row = result.getByRole("listitem", { name: "archive.zip" });
  await open(row, "archive.zip");
  const card = row.locator(".ui-file-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".ui-file-meta")).toHaveText(/^ZIP file · /);
  await expect(card.locator(".ui-file-card-problem")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Open" })).toHaveCount(0);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    card.getByRole("button", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("archive.zip");
  await card.scrollIntoViewIfNeeded();
  await shoot(page, "zip");
});

test("a video under its row plays there, in the page", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  const result = await handed(page, fixture.origin);
  const row = result.getByRole("listitem", { name: "walkthrough.mp4" });
  await open(row, "walkthrough.mp4");
  const video = row.locator("video");
  await expect(video).toBeVisible();
  expect(await video.getAttribute("playsinline")).not.toBeNull();
  expect(await video.getAttribute("controls")).not.toBeNull();
  expect(await video.getAttribute("src")).toMatch(/^.*\/file-previews\/[^/]+\/walkthrough\.mp4/);
  await expect
    .poll(() => video.evaluate((media: HTMLVideoElement) => media.duration))
    .toBeCloseTo(4, 0);
  await expect(row.locator(".ui-file-card")).toHaveCount(0);
  await video.scrollIntoViewIfNeeded();
  await shoot(page, "video");

  // The address answers as a phone's player asks: a two-byte probe first, then ranges.
  const src = (await video.getAttribute("src")) ?? "";
  const probe = await page.request.get(src.split("#")[0] ?? "", {
    headers: { range: "bytes=0-1" },
  });
  expect(probe.status()).toBe(206);
  expect(probe.headers()["accept-ranges"]).toBe("bytes");
  expect(probe.headers()["content-type"]).toBe("video/mp4");
  expect(probe.headers()["content-length"]).toBe("2");
  expect(probe.headers()["content-range"]).toMatch(/^bytes 0-1\/\d+$/);
});

test("a video the browser can't play shows its card, and one that can't load says so", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  // The player gets bytes it can't read, while the address still answers.
  await page.route("**/file-previews/**/walkthrough.mp4*", (route) =>
    route.request().method() === "HEAD"
      ? route.fulfill({ status: 200 })
      : route.fulfill({ status: 200, contentType: "video/mp4", body: "not a video" }),
  );
  const result = await handed(page, fixture.origin);
  const row = result.getByRole("listitem", { name: "walkthrough.mp4" });
  await open(row, "walkthrough.mp4");
  const card = row.locator(".ui-file-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".ui-file-meta")).toHaveText(/^MP4 video · /);
  await expect(card.locator(".ui-file-card-problem")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Open" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Download" })).toBeVisible();

  await page.unroute("**/file-previews/**/walkthrough.mp4*");
  await page.route("**/file-previews/**/voice-note.wav*", (route) =>
    route.fulfill({ status: 404 }),
  );
  const sound = result.getByRole("listitem", { name: "voice-note.wav" });
  await open(sound, "voice-note.wav");
  await expect(sound.getByText("Couldn't load this file.")).toBeVisible();
  await expect(sound.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.unroute("**/file-previews/**/voice-note.wav*");
  await sound.getByRole("button", { name: "Try again" }).click();
  await expect(sound.locator("audio")).toBeVisible();
});

test("the viewer shows a zip's card, and a video's player", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  const result = await handed(page, fixture.origin);
  const more = (name: string) =>
    result
      .getByRole("listitem", { name })
      .getByRole("button", { name: `More for ${name}`, exact: true });
  await more("archive.zip").click();
  await page.getByRole("menuitem", { name: "Open", exact: true }).click();
  const viewer = page.locator(".file-viewer");
  const card = viewer.locator(".ui-file-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".ui-file-meta")).toHaveText(/^ZIP file · /);
  await expect(card.getByRole("button", { name: "Download" })).toBeVisible();
  await expect(viewer.getByText(/isn't text/)).toHaveCount(0);
  await shoot(page, "viewer-zip");
  await viewer.getByRole("button", { name: "Previous file" }).click();
  const video = viewer.locator("video, audio").first();
  await expect(video).toBeVisible();
  await shoot(page, "viewer-media");
});

test("a file that failed says so, with room for all it can do on a phone", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await page.route("**/file-previews/**/walkthrough.mp4*", (route) =>
    route.fulfill({ status: 404 }),
  );
  const result = await handed(page, fixture.origin);
  const row = result.getByRole("listitem", { name: "walkthrough.mp4" });
  await open(row, "walkthrough.mp4");
  const card = row.locator(".ui-file-card");
  await expect(card.getByText("Couldn't load this file.")).toBeVisible();
  const again = card.getByRole("button", { name: "Try again" });
  await expect(again).toBeVisible();
  const report = await card.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return {
      name: (node.querySelector(".ui-file-name") as HTMLElement).getBoundingClientRect().width,
      outside: [...node.querySelectorAll("button")].filter((button) => {
        const place = button.getBoundingClientRect();
        return place.left < box.left || place.right > box.right || place.bottom > box.bottom;
      }).length,
    };
  });
  expect(report.outside).toBe(0);
  expect(report.name).toBeGreaterThan(100);
  await card.scrollIntoViewIfNeeded();
  await shoot(page, "failed");
});

// The Workspace's list of files has the room for Open beside each one, as the chat's has; the name
// keeps enough to read.
test("each file the Workspace lists has its Open, and room for its name", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await handed(page, fixture.origin);
  if (isPhone(page)) await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: PANEL_NAME, exact: true }).click();
  await page.getByRole("tab", { name: /^Files/ }).click();
  const list = page.getByRole("list", { name: "Handed over" });
  const row = list.getByRole("listitem", { name: "walkthrough.mp4" });
  const openButton = row.getByRole("button", { name: /^Open/ });
  await expect(openButton).toBeVisible();
  const report = await row.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return {
      name: (node.querySelector(".ui-file-name") as HTMLElement).getBoundingClientRect().width,
      outside: [...node.querySelectorAll("button")].filter((button) => {
        const place = button.getBoundingClientRect();
        return place.width > 0 && (place.left < box.left - 0.5 || place.right > box.right + 0.5);
      }).length,
    };
  });
  expect(report.outside).toBe(0);
  expect(report.name).toBeGreaterThan(90);
  await shoot(page, "workspace-files");
  await openButton.click();
  await expect(page.locator(".file-viewer video, .file-viewer audio").first()).toBeVisible();
});
