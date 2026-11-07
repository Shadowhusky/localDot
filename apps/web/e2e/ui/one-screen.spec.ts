import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import sharp from "sharp";
import { browserWindow, MENU_BAR_PX } from "../../src/stage/composite.ts";
import { expect, isPhone, openComputerScreen, runAt, test } from "./harness.ts";

const OUT = process.env.QA_ONE_SCREEN_OUT;

type Pixel = [number, number, number];
interface Delivered {
  input: { kind: string; at?: { x: number; y: number }; text?: string; combo?: string[] };
  screen?: string;
}

test.use({ fixedClock: false });

const stageOf = (page: Page) => page.locator(".stage").first();
// The picture's own box in the stage: the desktop's 16:10, however the stage is shaped.
const screenOf = (page: Page) => stageOf(page).locator(".browser-chrome-screen");

async function pictureBox(page: Page) {
  const box = await screenOf(page).boundingBox();
  if (!box) throw new Error("The picture is missing");
  return box;
}

// A pixel of the stage's picture, by its share of the picture's box.
async function pixelAt(page: Page, x: number, y: number) {
  const shot = await page.screenshot({ animations: "disabled", clip: await pictureBox(page) });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const at = Math.floor(y * info.height) * info.width + Math.floor(x * info.width);
  return [...data.subarray(at * info.channels, at * info.channels + 3)] as Pixel;
}

const near = (pixel: Pixel, want: Pixel, by = 28) =>
  pixel.every((value, index) => Math.abs(value - (want[index] ?? 0)) <= by);
// The fixture's browser draws #dfe3e8 across its top; its desktop has a home screen with a #f3f4f8
// bar and a gradient under it. The window's title bar is the desktop's own windows' white.
const TOOLBAR: Pixel = [0xdf, 0xe3, 0xe8];
const PAGE: Pixel = [0xf4, 0xf5, 0xf7];
const BAR: Pixel = [0xf3, 0xf4, 0xf8];
const TITLE_BAR: Pixel = [0xff, 0xff, 0xff];
const WINDOW = browserWindow({ w: 2560, h: 1600 });
// The browser's own top row, in the stage's share, just under the window's title bar.
const TOOLBAR_Y = (WINDOW.y / 2 + 12) / 800;

const delivered = async (page: Page, origin: string) =>
  (await (await page.request.get(`${origin}/__qa/manual-inputs`)).json()) as Delivered[];

async function shoot(page: Page, name: string) {
  const scheme = await page.evaluate(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const file = `${test.info().project.name}-${scheme}-${name}.png`;
  await page.screenshot({ path: test.info().outputPath(file) });
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, file) });
}

// The browser's window, which the stage draws only while it is in front.
const windowOf = (page: Page) => stageOf(page).getByRole("group", { name: /window$/ });
const dockItem = (page: Page) => stageOf(page).locator(".browser-dock-item");
// Close enough that neither of the desktop's pictures, its window or its home, passes for it.
const onToolbar = (page: Page) => pixelAt(page, 0.12, TOOLBAR_Y).then((p) => near(p, TOOLBAR, 10));

async function inFront(page: Page, screen: "browser" | "desktop") {
  if (screen === "browser") await expect(windowOf(page)).toBeVisible();
  else await expect(windowOf(page)).toHaveCount(0);
  // A thumbnail in the thread's foot is too small to read a row of pixels from.
  if ((await pictureBox(page)).width < 200) return;
  await expect.poll(() => onToolbar(page)).toBe(screen === "browser");
}

// The dock item, as a finger or a pointer reaches it: with the window in front a pointer brings the
// dock up from the bottom edge first, as the desktop's own dock comes back.
async function useDock(page: Page) {
  const item = dockItem(page);
  if (isPhone(page)) {
    await item.tap();
    return;
  }
  if (!(await item.isVisible())) {
    const box = await pictureBox(page);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height - 1);
    await expect(item).toBeVisible();
  }
  await item.click();
}

runAt("c14", "c39", "w14", "w39");

for (const colorScheme of ["light", "dark"] as const)
  test.describe(colorScheme, () => {
    test.use({ colorScheme });

    test("the web browser opens as a window on the desktop's screen", async ({ page, ui }) => {
      const phone = test.info().project.name.endsWith("39");
      if (colorScheme === "light")
        await page.addInitScript(() => localStorage.setItem("localdot.appearance.v1", "daylight"));
      const fixture = await ui.open("running");
      await page.request.post(`${fixture.origin}/__qa/desktop/home`);
      await ui.picture();
      const onBar = () =>
        pixelAt(page, 0.15, (0.5 * MENU_BAR_PX) / 800).then((p) => near(p, BAR, phone ? 60 : 28));
      await expect.poll(onBar).toBe(true);
      await shoot(page, "desktop");
      await page.request.post(`${fixture.origin}/__qa/screen?to=browser`);
      // The bar stays the desktop's, the window's title bar is under it, and the browser's own top
      // row starts right under that.
      await expect.poll(() => onToolbar(page)).toBe(true);
      await expect.poll(onBar).toBe(true);
      await expect
        .poll(() =>
          pixelAt(page, 0.25, (MENU_BAR_PX + 14) / 800).then((p) =>
            near(p, TITLE_BAR, phone ? 40 : 8),
          ),
        )
        .toBe(true);
      await expect(windowOf(page)).toHaveAccessibleName("Chromium window");
      // A phone's frame tints the picture's edge in the dark.
      if (!phone)
        await expect.poll(() => pixelAt(page, 0.5, 0.97).then((p) => near(p, PAGE, 6))).toBe(true);
      // In the margin beside the window, the desktop's own picture still shows.
      const margin = await pixelAt(page, 0.5 * (WINDOW.x / 2560), 0.5);
      expect(near(margin, PAGE, 6)).toBe(false);
      await shoot(page, "browser");
    });
  });

for (const view of ["studio", "chat"] as const)
  test.describe(`${view} view`, () => {
    test.use({ viewStyle: view });

    test("the window follows dot onto the web browser and back, with no press", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("running");
      if (view === "chat" && isPhone(page)) await openComputerScreen(page);
      await ui.picture();
      await inFront(page, "desktop");
      await page.request.post(`${fixture.origin}/__qa/screen?to=browser`);
      await inFront(page, "browser");
      await expect(dockItem(page)).toHaveAttribute("data-dot", "");
      await shoot(page, `${view}-dot-in-browser`);
      await page.request.post(`${fixture.origin}/__qa/screen`);
      await inFront(page, "desktop");
      await expect(dockItem(page)).not.toHaveAttribute("data-dot");
      await page.request.post(`${fixture.origin}/__qa/screen?to=browser`);
      await inFront(page, "browser");
      // Nobody pressed anything: the stage moved by itself.
      expect(await delivered(page, fixture.origin)).toEqual([]);
    });
  });

test("the window stays in front once dot's task in it ends", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await ui.picture();
  await page.request.post(`${fixture.origin}/__qa/screen?to=browser`);
  await inFront(page, "browser");
  // dot rests in it: the task waits, done, with the web browser still its screen.
  await page.request.post(`${fixture.origin}/__qa/finish?done=1`);
  await expect(page.getByText("Report ready").first()).toBeVisible();
  await inFront(page, "browser");
  // The task ends on a window of the browser that has since gone: the stage keeps the browser
  // that runs now.
  await page.request.post(`${fixture.origin}/__qa/screen?retired=browser`);
  await expect(dockItem(page)).not.toHaveAttribute("data-dot");
  await page.waitForTimeout(500);
  await inFront(page, "browser");
  await expect(
    page.getByRole("region", { name: "Notifications" }).getByRole("listitem"),
  ).toHaveCount(0);
});

test("its dock item minimises the window and shows it again", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await ui.picture();
  const item = dockItem(page);
  await expect(item).toHaveAccessibleName("Show the web browser");
  await page.request.post(`${fixture.origin}/__qa/screen?to=browser`);
  await inFront(page, "browser");
  await useDock(page);
  await inFront(page, "desktop");
  await expect(item).toHaveAccessibleName("Show the web browser, where dot is working");
  await useDock(page);
  await inFront(page, "browser");
  // Its title bar's minimise light does the same.
  const minimise = windowOf(page).getByRole("button", { name: "Minimise the web browser" });
  if (isPhone(page)) await minimise.tap();
  else await minimise.click();
  await inFront(page, "desktop");
  await page.request.post(`${fixture.origin}/__qa/screen`);
  await expect(item).toHaveAccessibleName("Show the web browser");
  // One desktop: nothing switches between a desktop and a web browser, and no button says so.
  await expect(page.getByRole("button", { name: /^(desktop|web browser)$|forward/i })).toHaveCount(
    0,
  );
  await expect(stageOf(page).getByText("Web browser", { exact: true })).toHaveCount(0);
});

// A point on the browser's page, in its own pixels, where the stage shows it now.
async function onPage(page: Page, x = 1000, y = 800) {
  const box = await pictureBox(page);
  const scale = box.width / 2560;
  return {
    x: box.x + (WINDOW.x + x * WINDOW.scale) * scale,
    y: box.y + (WINDOW.y + y * WINDOW.scale) * scale,
  };
}

async function holdTheComputer(page: Page, origin: string) {
  await page.request.post(`${origin}/__qa/browser/start`);
  await page.request.post(`${origin}/__qa/takeover`);
  await expect(page.getByRole("button", { name: "Hand back" })).toBeEnabled();
  const surface = page.locator(".manual-surface");
  await expect(surface).toHaveAttribute("data-live", "");
  return surface;
}

async function pressAt(page: Page, x: number, y: number) {
  if (isPhone(page)) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

test("while the user holds the computer, the dock, a press beside the window and Alt+Tab switch both ways", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await ui.picture();
  const surface = await holdTheComputer(page, fixture.origin);
  const keyboard = page.getByLabel("Type on the computer");
  // The dock brings the window forward, and the first crossing says what stays apart.
  await useDock(page);
  await inFront(page, "browser");
  await expect(page.getByText(/copied text and drags don't cross/)).toBeVisible();
  await expect(surface).toHaveAttribute("data-live", "");
  await expect(keyboard).toHaveAttribute(
    "aria-description",
    /^Keys go to the web browser's window\. (Alt\+Tab|Option-Tab) brings the desktop forward\.$/,
  );
  await shoot(page, "control-browser");
  // And sends it back.
  await useDock(page);
  await inFront(page, "desktop");
  await expect(keyboard).toHaveAttribute("aria-description", /^Keys go to the desktop\./);
  await useDock(page);
  await inFront(page, "browser");
  await expect(surface).toHaveAttribute("data-live", "");
  // A press beside the window brings the desktop forward, and the desktop gets none of it.
  const before = (await delivered(page, fixture.origin)).length;
  const box = await pictureBox(page);
  await pressAt(page, box.x + (WINDOW.x / 2) * (box.width / 2560), box.y + box.height / 2);
  await inFront(page, "desktop");
  expect((await delivered(page, fixture.origin)).length).toBe(before);
  await useDock(page);
  await inFront(page, "browser");
  await expect(surface).toHaveAttribute("data-live", "");
  // Alt+Tab switches each way, keeping the keys, and reaches neither screen.
  const point = await onPage(page);
  await pressAt(page, point.x, point.y);
  if (isPhone(page)) await page.getByRole("button", { name: "Keyboard" }).tap();
  await expect(keyboard).toBeFocused();
  const sent = (await delivered(page, fixture.origin)).length;
  await page.keyboard.press("Alt+Tab");
  await inFront(page, "desktop");
  await page.keyboard.press("Alt+Tab");
  await inFront(page, "browser");
  await page.waitForTimeout(200);
  expect(
    (await delivered(page, fixture.origin)).slice(sent).filter(({ input }) => input.kind === "key"),
  ).toEqual([]);
  // Handing back follows dot, which is on the desktop.
  await page.getByRole("button", { name: "Hand back" }).click();
  await inFront(page, "desktop");
});

test("the user's input reaches the screen under their pointer", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await ui.picture();
  const surface = await holdTheComputer(page, fixture.origin);
  await useDock(page);
  await inFront(page, "browser");
  await expect(page.locator('iframe.desktop-frame[src*="/browser/"]')).toHaveCount(1);
  await expect(surface).toHaveAttribute("data-live", "");
  // A press on the page lands on the browser's own pixels.
  const point = await onPage(page);
  await page.mouse.click(point.x, point.y);
  await expect
    .poll(async () => (await delivered(page, fixture.origin)).at(-1))
    .toMatchObject({ screen: "browser" });
  const onBrowser = (await delivered(page, fixture.origin)).filter(
    ({ screen }) => screen === "browser",
  );
  const press = onBrowser.find(({ input }) => input.kind === "down" || input.kind === "click");
  // Within a CSS pixel, which on a phone is about seven of the browser's.
  const within = isPhone(page) ? 8 : 4;
  expect(Math.abs((press?.input.at?.x ?? 0) - 1000)).toBeLessThanOrEqual(within);
  expect(Math.abs((press?.input.at?.y ?? 0) - 800)).toBeLessThanOrEqual(within);
  await page.keyboard.type("hi");
  await expect
    .poll(async () =>
      (await delivered(page, fixture.origin))
        .map(({ input, screen }) => (screen === "browser" ? (input.text ?? "") : ""))
        .join(""),
    )
    .toBe("hi");
  if (!isPhone(page)) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 240);
    await expect
      .poll(async () => (await delivered(page, fixture.origin)).at(-1))
      .toMatchObject({ input: { kind: "scroll" }, screen: "browser" });
  }
  // A press on the title bar reaches neither screen.
  const count = async () => (await delivered(page, fixture.origin)).length;
  const before = await count();
  const bar = await windowOf(page).boundingBox();
  if (!bar) throw new Error("The title bar is missing");
  await page.mouse.click(bar.x + bar.width * 0.7, bar.y + bar.height / 2);
  await page.waitForTimeout(200);
  expect(await count()).toBe(before);
  await inFront(page, "browser");
  if (isPhone(page)) return;
  // The bar above it is the desktop's, where a pointer can aim at it, and the press brings it forward.
  const box = await pictureBox(page);
  await page.mouse.click(box.x + box.width * 0.15, box.y + (MENU_BAR_PX * box.width) / 2560);
  await inFront(page, "desktop");
  await expect(surface).toHaveAttribute("data-live", "");
  await page.mouse.click(point.x, point.y);
  await page.keyboard.type("x");
  await expect
    .poll(async () => (await delivered(page, fixture.origin)).at(-1))
    .toMatchObject({ input: { kind: "text", text: "x" } });
  expect((await delivered(page, fixture.origin)).at(-1)?.screen).not.toBe("browser");
});

// The look at a size a shot can be read at, for the record.
test("shows the window and its dock item in the desktop's own look", async ({ page, ui }) => {
  test.skip(isPhone(page), "the wide stage shows the detail");
  const fixture = await ui.open("running");
  await ui.picture();
  await page.request.post(`${fixture.origin}/__qa/screen?to=browser`);
  await inFront(page, "browser");
  await crop(page, windowOf(page), "title-bar");
  const box = await pictureBox(page);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height - 1);
  await expect(dockItem(page)).toBeVisible();
  await page.waitForTimeout(300);
  await crop(page, stageOf(page).locator(".browser-dock"), "dock-over-window");
  await page.request.post(`${fixture.origin}/__qa/screen`);
  await inFront(page, "desktop");
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.waitForTimeout(300);
  await crop(page, stageOf(page).locator(".browser-dock"), "dock-on-desktop");
});

async function crop(page: Page, target: Locator, name: string) {
  const box = await target.boundingBox();
  if (!box) throw new Error(`${name} is missing`);
  const pad = 24;
  await page.screenshot({
    path: test.info().outputPath(`${test.info().project.name}-${name}.png`),
    clip: {
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + 2 * pad,
      height: box.height + 2 * pad,
    },
  });
}
