import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { ENGINES, startUiFixture, TOKEN, type UiFixture } from "./ui-fixture.ts";

// Replay's session list, session switching, the way back to Watch and the export trigger at
// tablet and phone widths, against the fixture daemon serving the built UI.
type Size = { viewport: { width: number; height: number }; isMobile?: boolean; hasTouch?: boolean };
const DESKTOP: Size = { viewport: { width: 1440, height: 900 } };
const TABLET: Size = { viewport: { width: 1024, height: 768 } };
const PHONE: Size = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const EXPORT_REASON = "Export needs Chrome or Edge for now";
let fixture: UiFixture, organize: string, earlier: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fixture = await startUiFixture("localdot-replay-sessions");
  [organize, earlier] = fixture.seeded as [string, string];
});

test.afterAll(async () => {
  await fixture?.stop();
});

async function open(browser: Browser, size: Size, path: string) {
  const context = await browser.newContext({ ...size, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${fixture.origin}${path}#token=${TOKEN}`);
  const press = (
    target: Locator,
    options?: { force?: boolean; timeout?: number; position?: { x: number; y: number } },
  ) => (size.hasTouch ? target.tap(options) : target.click(options));
  return { context, page, press };
}

const replayTime = (page: Page) => page.getByRole("status", { name: "Replay time" });
const replayHeading = (page: Page, name: string) =>
  page.getByRole("main", { name: "Session replay" }).getByRole("heading", { name });
const sessionCard = (page: Page, title: string) =>
  page
    .getByRole("complementary", { name: "Recorded sessions" })
    .getByRole("button", { name: new RegExp(`^${title}`) });
const query = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

for (const [label, engine, size] of [
  ["chrome at 1440", "chrome", DESKTOP],
  ["chrome at 1024", "chrome", TABLET],
  ["chrome at 390 with touch", "chrome", PHONE],
  ["webkit at 390 with touch", "webkit", PHONE],
] as const)
  test.describe(label, () => {
    let browser: Browser;
    test.beforeAll(async () => {
      browser = await ENGINES[engine]();
    });
    test.afterAll(async () => {
      await browser?.close();
    });

    test("the second session card opens that session at its start", async () => {
      const { context, page, press } = await open(browser, size, `/?replay=${organize}`);
      await expect(replayTime(page)).toHaveText("0:00 / 3:00");
      const slider = page.getByRole("slider", { name: "Replay timeline" });
      await slider.scrollIntoViewIfNeeded();
      const track = await slider.boundingBox();
      if (!track) throw new Error("timeline missing");
      await press(slider, { position: { x: track.width * 0.9, y: track.height / 2 } });
      await expect(replayTime(page)).toHaveText(/^2:\d\d \/ 3:00$/);
      await expect.poll(() => Number(query(page, "t"))).toBeGreaterThan(100_000);

      const card = sessionCard(page, "Earlier sample task 1");
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeInViewport({ ratio: 1 });
      expect((await card.boundingBox())?.width).toBeGreaterThanOrEqual(150);
      const misses: string[] = [];
      page.on("response", (response) => {
        if (response.status() === 404 && /\/(thumbs|frames)\//.test(response.url()))
          misses.push(new URL(response.url()).pathname);
      });
      await press(card, { timeout: 5000 });
      await expect(replayHeading(page, "Earlier sample task 1")).toBeVisible();
      expect(query(page, "replay")).toBe(earlier);
      await expect(replayTime(page)).toHaveText("0:00 / 1:00");
      await expect.poll(() => query(page, "t")).toBe("0");
      await page.waitForTimeout(500);
      expect(misses).toEqual([]);
      await context.close();
    });

    test("the heading and its controls fit the width", async () => {
      const { context, page } = await open(browser, size, `/?replay=${earlier}`);
      await expect(replayHeading(page, "Earlier sample task 1")).toBeVisible();
      const width = size.viewport.width;
      for (const name of ["Desktop", "Browser", "Back to Watch"]) {
        const control = page.getByRole("button", { name, exact: true });
        await expect(control).toBeVisible();
        const box = await control.boundingBox();
        expect(box?.x, name).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0), name).toBeLessThanOrEqual(width);
        if (size.hasTouch) expect(box?.height, name).toBeGreaterThanOrEqual(44);
      }
      const overflow = await page.evaluate(() => {
        const main = document.querySelector(".replay-main") as HTMLElement;
        return [
          document.documentElement.scrollWidth - innerWidth,
          main.scrollWidth - main.clientWidth,
        ];
      });
      expect(overflow).toEqual([0, 0]);
      if (size.hasTouch) {
        const remove = page.getByRole("button", { name: "Delete Earlier sample task 1" });
        await expect(remove).toBeVisible();
        expect((await remove.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }
      await context.close();
    });

    test("Export says when this browser cannot save it", async () => {
      const { context, page, press } = await open(browser, size, `/?replay=${earlier}`);
      const trigger = page.getByRole("button", { name: "Export MP4" });
      await trigger.scrollIntoViewIfNeeded();
      if (engine === "webkit") {
        await expect(trigger).toHaveAttribute("aria-disabled", "true");
        await expect(trigger).toHaveAccessibleDescription(EXPORT_REASON);
        await expect(page.getByText(EXPORT_REASON)).toBeVisible();
        await press(trigger, { force: true });
        await page.waitForTimeout(300);
        await expect(page.getByRole("dialog", { name: "Export MP4" })).toHaveCount(0);
      } else {
        await expect(trigger).not.toHaveAttribute("aria-disabled", "true");
        await expect(page.getByText(EXPORT_REASON)).toHaveCount(0);
        await press(trigger);
        await expect(page.getByRole("dialog", { name: "Export MP4" })).toBeVisible();
      }
      await context.close();
    });
  });

test("a deep link opens Replay at its time", async () => {
  const browser = await ENGINES.chrome();
  const { page } = await open(browser, TABLET, `/?replay=${organize}&t=60000`);
  await expect(replayTime(page)).toHaveText("1:00 / 3:00");
  expect(query(page, "t")).toBe("60000");
  await browser.close();
});

for (const width of [390, 759, 760])
  test(`a finished session leads back to Watch at ${width}`, async () => {
    const browser = await ENGINES.chrome();
    const size = width === 390 ? PHONE : { viewport: { width, height: 900 } };
    const { page, press } = await open(browser, size, `/?replay=${earlier}`);
    await expect(replayHeading(page, "Earlier sample task 1")).toBeVisible();
    await expect(page.getByRole("button", { name: "Jump to live" })).toHaveCount(0);
    const back = page.getByRole("button", { name: "Back to Watch" });
    await expect(back).toBeEnabled();
    await expect(back).toBeInViewport({ ratio: 1 });
    await press(back);
    await expect(page.getByRole("main", { name: "Session replay" })).toHaveCount(0);
    expect(query(page, "replay")).toBeNull();

    await page.goto(`${fixture.origin}/?replay=${fixture.sessionId}#token=${TOKEN}`);
    await expect(page.getByRole("button", { name: "Jump to live" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to Watch" })).toHaveCount(0);
    await browser.close();
  });
