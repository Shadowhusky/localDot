import type { Page } from "@playwright/test";
import sharp from "sharp";
import { browserWindow } from "../../src/stage/composite.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

// A conversation with a web browser of its own: the stage shows that browser, as the same window on
// dot's desktop with the same dock item, minimise light and Alt/Option-Tab, and asks the daemon for
// that browser's stream by name.
runAt("c14", "c39", "w14", "w39");
test.use({ fixedClock: false });

type Pixel = [number, number, number];
const stageOf = (page: Page) => page.locator(".stage").first();
const screenOf = (page: Page) => stageOf(page).locator(".browser-chrome-screen");
const windowOf = (page: Page) => stageOf(page).getByRole("group", { name: /window$/ });
const dockItem = (page: Page) => stageOf(page).locator(".browser-dock-item");
const WINDOW = browserWindow({ w: 2560, h: 1600 });
const TOOLBAR_Y = (WINDOW.y / 2 + 12) / 800;
// The fixture's main browser has a grey toolbar; the conversation's own, a green one.
const MAIN: Pixel = [0xdf, 0xe3, 0xe8];
const OWN: Pixel = [0xcf, 0xe8, 0xd6];

async function toolbar(page: Page): Promise<Pixel> {
  const box = await screenOf(page).boundingBox();
  if (!box) throw new Error("The picture is missing");
  const shot = await page.screenshot({ animations: "disabled", clip: box });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const at = Math.floor(TOOLBAR_Y * info.height) * info.width + Math.floor(0.12 * info.width);
  return [...data.subarray(at * info.channels, at * info.channels + 3)] as Pixel;
}
const near = (pixel: Pixel, want: Pixel, by = 10) =>
  pixel.every((value, index) => Math.abs(value - (want[index] ?? 0)) <= by);
const shows = (page: Page, want: Pixel) =>
  expect.poll(async () => near(await toolbar(page), want), { timeout: 15_000 }).toBe(true);

async function useDock(page: Page) {
  const item = dockItem(page);
  if (!(await stageOf(page).locator(".browser-dock[data-shown]").count())) {
    if (isPhone(page)) await stageOf(page).locator(".browser-dock-edge").tap();
    else {
      const box = await screenOf(page).boundingBox();
      if (!box) throw new Error("The picture is missing");
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height - 1);
    }
  }
  if (isPhone(page)) await item.tap();
  else await item.click();
}

function tickets(page: Page) {
  const asked: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/browser-stream-ticket")) asked.push(url);
  });
  return asked;
}

test("a conversation's own web browser is the window on its desktop", async ({ page, ui }) => {
  const asked = tickets(page);
  const fixture = await ui.open("running");
  await ui.picture();
  const state = await (await page.request.get(`${fixture.origin}/__qa/state`)).json();
  const sessionId = state.sessionId as string;

  // dot in the computer's main browser.
  await page.request.post(`${fixture.origin}/__qa/screen?to=browser`);
  await expect(windowOf(page)).toBeVisible();
  await shows(page, MAIN);
  const main = asked.at(-1)?.searchParams.get("browser");
  expect(main).toBeTruthy();

  // dot moves to its conversation's own browser: the same window shows it, under the same name.
  await page.request.post(`${fixture.origin}/__qa/screen?to=browser&own=1`);
  await shows(page, OWN);
  await expect(windowOf(page)).toHaveAccessibleName("Chromium window");
  await expect(dockItem(page)).toHaveAttribute("data-dot", "");
  const own = asked.at(-1);
  expect(own?.searchParams.get("browser")).not.toBe(main);
  expect(own?.searchParams.get("task")).toBe(sessionId);
  await page.screenshot({ path: test.info().outputPath("own-browser.png") });

  // Its minimise light and its dock item, as before.
  const minimise = windowOf(page).getByRole("button", { name: "Minimise the web browser" });
  if (isPhone(page)) await minimise.tap();
  else await minimise.click();
  await expect(windowOf(page)).toHaveCount(0);
  await useDock(page);
  await expect(windowOf(page)).toBeVisible();
  await shows(page, OWN);
  // Back on the desktop, the user asking for the web browser gets this conversation's, not the
  // computer's main one.
  await page.request.post(`${fixture.origin}/__qa/screen`);
  await expect(windowOf(page)).toHaveCount(0);
  await useDock(page);
  await expect(windowOf(page)).toBeVisible();
  await shows(page, OWN);
  expect(
    asked.some(
      (url) => url.searchParams.get("task") === sessionId && !url.searchParams.get("browser"),
    ),
  ).toBe(true);
});

test("the user holding a conversation's own browser types into it, and Alt+Tab still switches", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await ui.picture();
  // dot is on the desktop, and its conversation has a web browser of its own.
  await page.request.post(`${fixture.origin}/__qa/browser/start?own=1`);
  await page.request.post(`${fixture.origin}/__qa/takeover`);
  await expect(page.getByRole("button", { name: "Hand back" })).toBeEnabled();
  await expect(page.locator(".manual-surface")).toHaveAttribute("data-live", "");
  await useDock(page);
  await expect(windowOf(page)).toBeVisible();
  await shows(page, OWN);
  const box = await screenOf(page).boundingBox();
  if (!box) throw new Error("The picture is missing");
  const scale = box.width / 2560;
  const x = box.x + (WINDOW.x + 1000 * WINDOW.scale) * scale;
  const y = box.y + (WINDOW.y + 800 * WINDOW.scale) * scale;
  if (isPhone(page)) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
  await expect
    .poll(async () => {
      const inputs = (await (
        await page.request.get(`${fixture.origin}/__qa/manual-inputs`)
      ).json()) as { screen?: string }[];
      return inputs.some((input) => input.screen === "browser");
    })
    .toBe(true);
  if (isPhone(page)) return;
  const keyboard = page.getByLabel("Type on the computer");
  await keyboard.focus();
  await page.keyboard.press("Alt+Tab");
  await expect(windowOf(page)).toHaveCount(0);
  await page.keyboard.press("Alt+Tab");
  await expect(windowOf(page)).toBeVisible();
  await shows(page, OWN);
});
