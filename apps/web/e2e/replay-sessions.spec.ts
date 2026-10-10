import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { ENGINES, startUiFixture, TOKEN, type UiFixture } from "./ui-fixture.ts";

// Replay's task library, task switching, the way back to Watch, the picture and its cards, and the
// export trigger at desktop, tablet and phone widths, against the fixture daemon serving the built UI.
type Size = { viewport: { width: number; height: number }; isMobile?: boolean; hasTouch?: boolean };
const WIDE: Size = { viewport: { width: 1728, height: 1000 } };
const DESKTOP: Size = { viewport: { width: 1440, height: 900 } };
const TABLET: Size = { viewport: { width: 1024, height: 768 } };
const PHONE: Size = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const EXPORT_REASON = "Export needs Chrome, Edge or Safari 17 or later";
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
// The time played and the whole length, either side of the scrubber.
async function expectTime(page: Page, played: string | RegExp, length: string) {
  await expect(replayTime(page)).toHaveText(played);
  await expect(page.locator(".replay-length")).toHaveText(length);
}
const replayHeading = (page: Page, name: string) =>
  page.getByRole("main", { name: "Replay" }).getByRole("heading", { name });
const replayStage = (page: Page) => page.getByRole("main", { name: "Replay" }).locator(".stage");
const query = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);
const isPhone = (size: Size) => size.viewport.width < 700;

// The recordings: the player's rail beside the stage, or the library one screen back on a phone.
async function tasks(page: Page, size: Size, press: (target: Locator) => Promise<void>) {
  if (isPhone(size)) {
    await press(page.getByRole("navigation").getByRole("button", { name: "Replay" }));
    return page.getByRole("main", { name: "Replay" });
  }
  const rail = page.getByRole("complementary", { name: "Recording" });
  await press(rail.getByRole("radio", { name: "Recordings", exact: true }));
  return rail;
}

// How tall a control's reach is where it shows: a kit control may reach past what it draws.
const reach = (control: Locator) =>
  control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    let top = box.top + box.height / 2;
    while (top > 0 && element.contains(document.elementFromPoint(x, top - 1))) top--;
    let bottom = box.top + box.height / 2;
    while (element.contains(document.elementFromPoint(x, bottom + 1))) bottom++;
    return bottom - top + 1;
  });

const transportControls = (page: Page) =>
  page
    .getByRole("group", { name: "Playback controls" })
    .locator("button, [role=combobox], [role=switch], .ui-badge, output");

// The bar, the picture and the transport stay inside the width, with no two controls on top of each
// other, once a task with no video shows its chip.
async function fitsTheWidth(page: Page, size: Size) {
  await expect(
    page.getByRole("group", { name: "Playback controls" }).getByText("No video"),
  ).toBeVisible({
    timeout: 5000,
  });
  const width = size.viewport.width;
  // The way back to Watch: the top bar's Watch, or a phone's Replay, which leads there. A phone's
  // transport keeps play, the scrubber and Export.
  const back = isPhone(size)
    ? page.getByRole("navigation").getByRole("button", { name: "Replay" })
    : page.getByRole("radiogroup", { name: "Mode" }).getByRole("radio", { name: "Watch" });
  for (const control of [
    back,
    page.getByRole("button", { name: "Play replay" }),
    ...(isPhone(size) ? [] : [page.getByRole("combobox", { name: "Playback speed" })]),
    page.getByRole("button", { name: "Export video" }),
  ]) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    if (size.hasTouch) expect(await reach(control)).toBeGreaterThanOrEqual(44);
  }
  const overlaps = await transportControls(page).evaluateAll((controls) => {
    const boxes = controls
      .filter((control) => !controls.some((other) => other !== control && other.contains(control)))
      .map((control) => ({
        name: control.getAttribute("aria-label") ?? control.textContent?.trim(),
        box: control.getBoundingClientRect(),
      }))
      .filter(({ box }) => box.width > 0);
    return boxes.flatMap(({ name, box }, at) =>
      boxes
        .slice(at + 1)
        .filter(
          (other) =>
            box.left < other.box.right - 0.5 &&
            other.box.left < box.right - 0.5 &&
            box.top < other.box.bottom - 0.5 &&
            other.box.top < box.bottom - 0.5,
        )
        .map((other) => `${name} covers ${other.name}`),
    );
  });
  expect(overlaps).toEqual([]);
  const outside = await page.evaluate(() => {
    const main = document.querySelector(".replay-main") as HTMLElement;
    const room = main.getBoundingClientRect();
    // The light the stage spills on the floor is drawn past it on purpose.
    const spill = [...main.querySelectorAll("*")].filter((element) => {
      if (element.closest("[aria-hidden='true']")) return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.right > room.right + 0.5 || box.bottom > room.bottom + 0.5);
    });
    return [document.documentElement.scrollWidth - innerWidth, spill.length];
  });
  expect(outside).toEqual([0, 0]);
}

for (const [label, engine, size] of [
  ["chrome at 1728", "chrome", WIDE],
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

    test("another task in the library opens at its start", async () => {
      const { context, page, press } = await open(browser, size, `/?replay=${organize}`);
      await expectTime(page, "0:00", "3:00");
      const slider = page.getByRole("slider", { name: "Replay timeline" });
      const track = await slider.boundingBox();
      if (!track) throw new Error("timeline missing");
      await press(slider, { position: { x: track.width * 0.9, y: track.height / 2 } });
      await expectTime(page, /^2:\d\d$/, "3:00");
      await expect.poll(() => Number(query(page, "t"))).toBeGreaterThan(100_000);

      const stage = await replayStage(page).boundingBox();
      const list = await tasks(page, size, press);
      const row = list.getByRole("button", { name: /^Earlier sample task 1/ });
      await expect(row).toBeInViewport({ ratio: 1 });
      expect(await reach(row)).toBeGreaterThanOrEqual(44);
      const misses: string[] = [];
      page.on("response", (response) => {
        if (response.status() === 404 && /\/(thumbs|frames)\//.test(response.url()))
          misses.push(new URL(response.url()).pathname);
      });
      await press(row);
      await expect(replayHeading(page, "Earlier sample task 1")).toBeAttached();
      expect(query(page, "replay")).toBe(earlier);
      await expectTime(page, "0:00", "1:00");
      await expect.poll(() => query(page, "t")).toBe("0");
      await page.waitForTimeout(500);
      expect(misses).toEqual([]);
      expect(await replayStage(page).boundingBox()).toEqual(stage);
      await context.close();
    });

    test("the bar, the picture and the transport fit the width without a scroll", async () => {
      const { context, page, press } = await open(browser, size, `/?replay=${fixture.sessionId}`);
      await fitsTheWidth(page, size);
      const screen = page.locator(".replay");
      expect(await screen.locator("select, input[type=radio], input[type=file]").count()).toBe(0);
      if (size.hasTouch) {
        const list = await tasks(page, size, press);
        const row = list.getByRole("button", { name: /^Earlier sample task 1/ });
        await expect(row).toBeVisible();
        expect(await reach(row)).toBeGreaterThanOrEqual(44);
      }
      await context.close();
    });

    test("the picture keeps 16:10 and nothing covers its top edge", async () => {
      const { context, page } = await open(browser, size, `/?replay=${organize}&t=20000`);
      await expectTime(page, "0:20", "3:00");
      await expect(page.locator(".replay-opening")).toBeHidden();
      const stage = await replayStage(page).boundingBox();
      if (!stage) throw new Error("stage missing");
      expect(Math.abs(stage.width / stage.height - 1.6)).toBeLessThan(0.01);
      const covered = await page.evaluate(({ x, y, width }) => {
        const found: string[] = [];
        for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          const hit = document.elementFromPoint(x + width * fraction, y + 12);
          // The island hangs on the stage's top edge by design (design-v2 §10.15).
          if (hit && !hit.matches("canvas, iframe, .stage") && !hit.closest(".island-anchor"))
            found.push(hit.className);
        }
        return found;
      }, stage);
      expect(covered).toEqual([]);
      await context.close();
    });

    test("a task with no video says so on solid ground, then as a chip", async () => {
      const { context, page } = await open(browser, size, `/?replay=${fixture.sessionId}`);
      const card = page.locator(".replay-gap-card");
      await expect(card.getByText("No video for this task", { exact: true })).toBeVisible();
      const look = await card.evaluate((element) => {
        const alpha = (colour: string) =>
          colour.startsWith("rgba") ? Number(colour.split(",").at(-1)?.replace(")", "")) : 1;
        const box = element.getBoundingClientRect();
        const stage = (element.closest(".stage") as HTMLElement).getBoundingClientRect();
        const title = element.querySelector(".replay-gap-title") as HTMLElement;
        return {
          background: alpha(getComputedStyle(element).backgroundColor),
          lower: box.top > stage.top + stage.height / 2,
          inside: box.left >= stage.left && box.right <= stage.right && box.bottom <= stage.bottom,
          title: getComputedStyle(title).color,
        };
      });
      expect(look.background).toBeGreaterThanOrEqual(0.9);
      expect(look).toMatchObject({ lower: true, inside: true, title: "rgb(238, 239, 241)" });
      const boxes = () =>
        transportControls(page).evaluateAll((controls) =>
          controls
            .filter((control) => !control.matches(".ui-badge"))
            .map((control) => control.getBoundingClientRect().toJSON()),
        );
      const before = await boxes();
      const controls = page.getByRole("group", { name: "Playback controls" });
      await expect(controls.getByText("No video", { exact: true })).toBeVisible({ timeout: 5000 });
      await expect(card).toBeHidden();
      expect(await boxes()).toEqual(before);
      await context.close();
    });

    test("Export opens its choices above the transport, with or without a save picker", async () => {
      const { context, page, press } = await open(browser, size, `/?replay=${earlier}`);
      const trigger = page.getByRole("button", { name: "Export video" });
      await expectTime(page, "0:00", "1:00");
      await expect(trigger).not.toHaveAttribute("aria-disabled", "true");
      const stage = await replayStage(page).boundingBox();
      await press(trigger);
      const panel = page.getByRole("dialog", { name: "Export video" });
      await expect(panel).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      // Only the kit's own controls: its choice cards hold their radios inside.
      await expect(
        panel.locator("select, input[type=radio]:not(.ui-choice-input), input[type=file]"),
      ).toHaveCount(0);
      await expect(panel.getByRole("button", { name: /^Save/ })).toBeVisible();
      // Measured where it comes to rest, not on its way in.
      await panel.evaluate((element) =>
        Promise.all(
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map((animation) => animation.finished.catch(() => null)),
        ),
      );
      const box = await panel.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.viewport.width);
      expect(await replayStage(page).boundingBox()).toEqual(stage);
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(trigger).toBeFocused();
      await context.close();
    });

    test("Export says why when this browser cannot make video", async () => {
      const context = await browser.newContext({ ...size, deviceScaleFactor: 2 });
      await context.addInitScript(() => {
        Object.assign(window, { VideoEncoder: undefined });
      });
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/?replay=${earlier}#token=${TOKEN}`);
      const trigger = page.getByRole("button", { name: "Export video" });
      await expectTime(page, "0:00", "1:00");
      await expect(trigger).toHaveAttribute("aria-disabled", "true");
      await expect(trigger).toHaveAccessibleDescription(EXPORT_REASON);
      await (size.hasTouch ? trigger.tap({ force: true }) : trigger.click({ force: true }));
      await expect(page.locator(".ui-tooltip")).toContainText(EXPORT_REASON);
      await expect(page.getByRole("dialog", { name: "Export video" })).toHaveCount(0);
      await context.close();
    });
  });

// An iPad held upright: the transport is too narrow for one row, so how it plays takes a second.
for (const engine of ["chrome", "webkit"] as const)
  for (const width of [768, 820])
    test(`the transport fits a ${engine} tablet held upright at ${width}`, async () => {
      const browser = await ENGINES[engine]();
      const size: Size = { viewport: { width, height: 1024 }, hasTouch: true };
      const { page } = await open(browser, size, `/?replay=${fixture.sessionId}`);
      await fitsTheWidth(page, size);
      await browser.close();
    });

test("a deep link opens Replay at its time", async () => {
  const browser = await ENGINES.chrome();
  const { page } = await open(browser, TABLET, `/?replay=${organize}&t=60000`);
  await expectTime(page, "1:00", "3:00");
  expect(query(page, "t")).toBe("60000");
  await browser.close();
});

test("the top bar names the recording, not the task running live", async () => {
  const browser = await ENGINES.chrome();
  const { page } = await open(browser, DESKTOP, `/?replay=${earlier}`);
  const bar = page.locator("header.bar");
  await expect(bar.getByText("Earlier sample task 1", { exact: true })).toBeVisible();
  await expect(bar.locator(".title-note")).not.toBeEmpty();
  await expect(bar.getByText("Sample · monthly report")).toHaveCount(0);
  await browser.close();
});

// A finished recording leads back to Watch: the top bar's Watch, or on a phone back through the
// library. The task running live offers to be watched live instead.
for (const width of [390, 759, 760])
  test(`a finished task leads back to Watch at ${width}`, async () => {
    const browser = await ENGINES.chrome();
    const size = width === 390 ? PHONE : { viewport: { width, height: 900 } };
    const { page, press } = await open(browser, size, `/?replay=${earlier}`);
    await expect(replayHeading(page, "Earlier sample task 1")).toBeAttached();
    await expect(page.getByRole("button", { name: "Watch it live" })).toHaveCount(0);
    if (isPhone(size)) {
      const up = page.getByRole("navigation").getByRole("button", { name: "Replay" });
      await expect(up).toBeInViewport({ ratio: 1 });
      await press(up);
      await press(page.getByRole("navigation").getByRole("button", { name: "Watch" }));
    } else {
      const watch = page.getByRole("radiogroup", { name: "Mode" }).getByRole("radio", {
        name: "Watch",
      });
      await expect(watch).toBeInViewport({ ratio: 1 });
      await press(watch);
    }
    await expect(page.getByRole("main", { name: "Replay" })).toHaveCount(0);
    expect(query(page, "replay")).toBeNull();

    await page.goto(`${fixture.origin}/?replay=${fixture.sessionId}#token=${TOKEN}`);
    await expect(page.getByRole("button", { name: "Watch it live" })).toBeVisible();
    await browser.close();
  });
