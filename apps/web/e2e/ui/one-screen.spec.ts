import { mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { browserWindow, MENU_BAR_PX } from "../../src/stage/composite.ts";
import { expect, runAt, test } from "./harness.ts";

const OUT = process.env.QA_ONE_SCREEN_OUT;

type Pixel = [number, number, number];
interface Delivered {
  input: { kind: string; at?: { x: number; y: number }; text?: string };
  screen?: string;
}

test.use({ fixedClock: false });

const stageOf = (page: import("@playwright/test").Page) => page.locator(".stage").first();

// A pixel of the stage's picture, by its share of the stage's box.
async function pixelAt(page: import("@playwright/test").Page, x: number, y: number) {
  const shot = await stageOf(page).screenshot({ animations: "disabled" });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  const at = Math.floor(y * info.height) * info.width + Math.floor(x * info.width);
  return [...data.subarray(at * info.channels, at * info.channels + 3)] as Pixel;
}

const near = (pixel: Pixel, want: Pixel, by = 28) =>
  pixel.every((value, index) => Math.abs(value - (want[index] ?? 0)) <= by);
// The fixture's browser draws #dfe3e8 across its top; its desktop has a home screen with a #f3f4f8
// bar and a gradient under it.
const TOOLBAR: Pixel = [0xdf, 0xe3, 0xe8];
const PAGE: Pixel = [0xf4, 0xf5, 0xf7];
const BAR: Pixel = [0xf3, 0xf4, 0xf8];
const WINDOW = browserWindow({ w: 2560, h: 1600 });

const delivered = async (page: import("@playwright/test").Page, origin: string) =>
  (await (await page.request.get(`${origin}/__qa/manual-inputs`)).json()) as Delivered[];

async function shoot(page: import("@playwright/test").Page, name: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  const project = test.info().project.name;
  const scheme = await page.evaluate(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  await page.screenshot({ path: join(OUT, `${project}-${scheme}-${name}.png`) });
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
      // The bar stays the desktop's, and the browser's own top row starts right under it.
      await expect
        .poll(() => pixelAt(page, 0.12, (MENU_BAR_PX + 12) / 800).then((p) => near(p, TOOLBAR)))
        .toBe(true);
      await expect.poll(onBar).toBe(true);
      expect(near(await pixelAt(page, 0.5, 0.97), PAGE)).toBe(true);
      // In the margin beside the window, the desktop's own picture still shows.
      const margin = await pixelAt(page, 0.5 * (WINDOW.x / 2 / 2560), 0.5);
      expect(near(margin, PAGE, 6)).toBe(false);
      await shoot(page, "browser");
    });
  });

// The web browser's entry on the desktop's menu bar.
const entryOf = (page: import("@playwright/test").Page) =>
  page.locator(".stage .desktop-bar").getByRole("button");
const onToolbar = (page: import("@playwright/test").Page) =>
  pixelAt(page, 0.12, (MENU_BAR_PX + 12) / 800).then((p) => near(p, TOOLBAR));

test("dot's move takes the window along, and its entry on the menu bar minimises and shows it", async ({
  page,
  ui,
}) => {
  const fixture = await ui.open("running");
  await ui.picture();
  const entry = entryOf(page);
  await expect(entry).toHaveAccessibleName("Show the web browser");
  await page.request.post(`${fixture.origin}/__qa/screen?to=browser`);
  await expect(entry).toHaveAccessibleName("Minimise the web browser");
  await expect.poll(() => onToolbar(page)).toBe(true);
  await entry.click();
  await expect(entry).toHaveAccessibleName("Show the web browser, where dot is working");
  await expect.poll(() => onToolbar(page)).toBe(false);
  await entry.click();
  await expect(entry).toHaveAccessibleName("Minimise the web browser");
  await expect.poll(() => onToolbar(page)).toBe(true);
  await page.request.post(`${fixture.origin}/__qa/screen?to=desktop`);
  await expect(entry).toHaveAccessibleName("Show the web browser");
  // One desktop: nothing switches between a desktop and a web browser.
  await expect(page.getByRole("button", { name: /^(desktop|web browser)$|forward/i })).toHaveCount(
    0,
  );
});

test("the user's input reaches the screen under their pointer", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  await ui.picture();
  await page.request.post(`${fixture.origin}/__qa/browser/start`);
  await page.request.post(`${fixture.origin}/__qa/takeover`);
  await expect(page.getByRole("button", { name: "Hand back" })).toBeEnabled();
  const surface = page.locator(".manual-surface");
  await expect(surface).toHaveAttribute("data-live", "");
  const entry = entryOf(page);
  await entry.click();
  await expect(entry).toHaveAccessibleName("Minimise the web browser");
  await expect(page.locator('iframe.desktop-frame[src*="/browser/"]')).toHaveCount(1);
  await expect(surface).toHaveAttribute("data-live", "");
  await expect(page.getByLabel("Type on the computer")).toHaveAttribute(
    "aria-description",
    "Keys go to the web browser's window.",
  );
  const box = await surface.boundingBox();
  if (!box) throw new Error("The computer view is missing");
  const scale = box.width / 2560;
  // A press on the page lands on the browser's own pixels.
  const onPage = {
    x: box.x + (WINDOW.x + 1000 * WINDOW.scale) * scale,
    y: box.y + (WINDOW.y + 800 * WINDOW.scale) * scale,
  };
  await page.mouse.click(onPage.x, onPage.y);
  await expect
    .poll(async () => (await delivered(page, fixture.origin)).at(-1))
    .toMatchObject({ screen: "browser" });
  const onBrowser = (await delivered(page, fixture.origin)).filter(
    ({ screen }) => screen === "browser",
  );
  const press = onBrowser.find(({ input }) => input.kind === "down" || input.kind === "click");
  expect(Math.abs((press?.input.at?.x ?? 0) - 1000)).toBeLessThanOrEqual(4);
  expect(Math.abs((press?.input.at?.y ?? 0) - 800)).toBeLessThanOrEqual(4);
  await page.keyboard.type("hi");
  await expect
    .poll(async () =>
      (await delivered(page, fixture.origin))
        .map(({ input, screen }) => (screen === "browser" ? (input.text ?? "") : ""))
        .join(""),
    )
    .toBe("hi");
  if (!test.info().project.name.endsWith("39")) {
    await page.mouse.move(onPage.x, onPage.y);
    await page.mouse.wheel(0, 240);
    await expect
      .poll(async () => (await delivered(page, fixture.origin)).at(-1))
      .toMatchObject({ input: { kind: "scroll" }, screen: "browser" });
  }
  await shoot(page, "control");
  // A press in the margin beside the window is on the desktop behind it: the desktop gets none of
  // it, and comes forward where the margin is wide enough to aim at.
  const count = async () => (await delivered(page, fixture.origin)).length;
  const before = await count();
  await page.mouse.click(box.x + (WINDOW.x / 2) * scale, box.y + box.height / 2);
  await page.waitForTimeout(200);
  expect(await count()).toBe(before);
  if (box.width < 700) {
    await expect(entry).toHaveAccessibleName("Minimise the web browser");
    return;
  }
  await expect(entry).toHaveAccessibleName("Show the web browser");
  await entry.click();
  await expect(entry).toHaveAccessibleName("Minimise the web browser");
  await expect(surface).toHaveAttribute("data-live", "");
  // The bar above it is the desktop's, where a pointer can aim at it, and the press brings it forward.
  await page.mouse.click(box.x + box.width * 0.15, box.y + MENU_BAR_PX * scale);
  await expect(entry).toHaveAccessibleName("Show the web browser");
  await expect(surface).toHaveAttribute("data-live", "");
  await page.mouse.click(onPage.x, onPage.y);
  await page.keyboard.type("x");
  await expect
    .poll(async () => (await delivered(page, fixture.origin)).at(-1))
    .toMatchObject({ input: { kind: "text", text: "x" } });
  expect((await delivered(page, fixture.origin)).at(-1)?.screen).not.toBe("browser");
});
