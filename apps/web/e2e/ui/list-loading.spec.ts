import { fileURLToPath } from "node:url";
import { hostExport } from "../../src/testing/host-export.ts";
import { openSettings } from "../settings-ui.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "w39");

test("conversation loading keeps its space; a long list only mounts nearby rows", async ({
  page,
  ui,
}) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/conversations", async (route) => {
    const original = await route.fetch();
    const { conversations } = await original.json();
    await waiting;
    await route.fulfill({
      json: {
        conversations: Array.from({ length: 50 }, (_, i) => ({
          ...conversations[0],
          sessionId: `01M4ECBR5X0R92SYA389${String(i).padStart(6, "0")}`,
          sessions: [`01M4ECBR5X0R92SYA389${String(i).padStart(6, "0")}`],
          title: `Conversation ${i}`,
        })),
      },
    });
  });
  await ui.open("conversations");
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Conversations", exact: true }).click();
  } else await page.getByRole("button", { name: "Conversations", exact: true }).click();
  const loading = page.getByText("Loading your conversations", { exact: true });
  await expect(loading).toBeVisible();
  const body = page.locator(".conversations-body");
  const before = await body.boundingBox();
  await expect(page.getByRole("button", { name: "See all in Replay" })).toBeHidden();
  release();
  await expect(page.getByRole("grid", { name: "Recent conversations" })).toBeVisible();
  await expect(page.getByRole("row").first()).toBeVisible();
  await expect.poll(() => page.getByRole("row").count()).toBeLessThan(40);
  const after = await body.boundingBox();
  expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThan(2);
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole("button", { name: /^Stopped Conversation 49/ })).toBeVisible();
  await expect.poll(() => page.getByRole("row").count()).toBeLessThan(40);
});

test("recording rows are virtualized and exported videos open a preview", async ({ page, ui }) => {
  await page.route("**/api/session-index*", async (route) => {
    const response = await route.fetch();
    const { sessions } = await response.json();
    await route.fulfill({
      json: {
        sessions: Array.from({ length: 1000 }, (_, i) => ({
          ...sessions[0],
          id: `01M4ECBR5X0R92SYA389${String(i).padStart(6, "0")}`,
          title: `Recording ${i}`,
          coverFrameId: null,
        })),
        next: null,
      },
    });
  });
  await page.routeWebSocket("**/api/exports/stream", () => {});
  await page.route("**/api/exports", (route) =>
    route.fulfill({
      json: {
        host: { state: "ready", maxPixels: { mp4: 2000000, webm: 2000000 } },
        exports: [hostExport({ phase: "done", name: "demo.mp4", bytes: 1000 })],
      },
    }),
  );
  await page.route("**/api/exports/*/link", (route) =>
    route.fulfill({ json: { href: `/export-files/${"a".repeat(43)}` } }),
  );
  let mediaRequests = 0;
  await page.route("**/export-files/**", (route) => {
    mediaRequests += 1;
    return mediaRequests === 1
      ? route.fulfill({ status: 404 })
      : route.fulfill({
          status: 200,
          contentType: "video/mp4",
          path: fileURLToPath(new URL("../fixtures/ui-assets/clip.mp4", import.meta.url)),
        });
  });
  await ui.open("done", () => "/?replay=library");
  await expect(page.getByRole("button", { name: "demo.mp4", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "demo.mp4", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "demo.mp4" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download video", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "The video couldn’t load",
  );
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  const video = page.getByRole("dialog").locator("video");
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState))
    .toBeGreaterThan(0);
  await video.evaluate((element) => (element as HTMLVideoElement).play());
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "demo.mp4" })).toBeHidden();
  const list = page.locator(".replay-window");
  await expect(list.locator(".replay-task").first()).toBeVisible();
  await expect.poll(() => list.locator(".replay-task").count()).toBeLessThan(40);
  await page.locator(".replay-library-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole("button", { name: "Recording 999", exact: true })).toBeVisible();
  await expect.poll(() => list.locator(".replay-task").count()).toBeLessThan(40);
  const last = page.getByRole("button", { name: "Recording 999", exact: true });
  await last.focus();
  await last.press("Home");
  await expect(page.getByRole("button", { name: "Recording 0", exact: true })).toBeFocused();
});

test("computer updates are easy to find with room around their controls", async ({
  page,
  ui,
  request,
}) => {
  const fixture = await ui.open("ready");
  await request.post(`${fixture.origin}/__qa/update`);
  const sheet = await openSettings(page, undefined, "Your computer");
  const heading = sheet.getByRole("heading", { name: "Computer updates" });
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeVisible();
  await expect(sheet.getByText("Update localDot manually")).toBeVisible();
  const group = heading.locator("../..").locator(".ui-group");
  const button = group.getByRole("button", { name: "Update", exact: true });
  await expect(button).toBeVisible();
  const bounds = await group.boundingBox();
  const action = await button.boundingBox();
  expect(
    (bounds?.y ?? 0) + (bounds?.height ?? 0) - (action?.y ?? 0) - (action?.height ?? 0),
  ).toBeGreaterThanOrEqual(10);
  const rowLeft = await group
    .locator(".ui-group-row")
    .evaluate(
      (element) =>
        element.getBoundingClientRect().left + parseFloat(getComputedStyle(element).paddingLeft),
    );
  expect(Math.abs(rowLeft - ((await heading.boundingBox())?.x ?? 0))).toBeLessThan(2);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("computer-settings.png") });
});

test("settings sections keep their content within the panel", async ({ page, ui }) => {
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Models");
  for (const title of [
    "Models",
    "Autonomy",
    "Appearance",
    "Notifications",
    "Accounts",
    "Connectors",
    "Your computer",
  ]) {
    if (isPhone(page)) {
      if (title !== "Models") {
        await sheet.getByRole("button", { name: "Settings", exact: true }).click();
        await sheet.getByRole("button", { name: new RegExp(`^${title}`) }).click();
      }
    } else {
      await sheet
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: title, exact: true })
        .click();
    }
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
          .map((animation) => animation.finished.catch(() => null)),
      ),
    );
    const overflow = await sheet.evaluate((element) =>
      [...element.querySelectorAll<HTMLElement>(".ui-sheet-page:not([inert]) .settings-section")]
        .filter((section) => section.getBoundingClientRect().height > 0)
        .map((section) => ({
          id: section.id,
          overflow: section.scrollWidth - section.clientWidth,
          children: [...section.querySelectorAll<HTMLElement>("*")]
            .filter(
              (node) =>
                node.getBoundingClientRect().right > section.getBoundingClientRect().right + 2,
            )
            .slice(0, 8)
            .map((node) => node.className),
        })),
    );
    // Button touch targets extend 6px; their text and visible controls must remain inside.
    expect(overflow.filter((value) => value.children.length > 0)).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath(`settings-${title.toLowerCase().replaceAll(" ", "-")}.png`),
    });
  }
});
