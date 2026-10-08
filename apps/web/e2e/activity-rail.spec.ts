import { type BrowserContextOptions, expect, type Page, test } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";
import { ENGINES } from "./ui-fixture.ts";

// The Activity rail against the fixture daemon's long hand-drawing task: one scroller, the live
// step in view, older runs folded, rows that unfold in place, and new steps that never move what
// the reader is looking at.
test.describe.configure({ timeout: 120_000 });

const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
};
const MATRIX = [
  ["chrome", "desktop", DESKTOP],
  ["webkit", "desktop", DESKTOP],
  ["chrome", "phone", PHONE],
  ["webkit", "phone", PHONE],
] as const;

let fixture: UiFixture | undefined;
test.afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function open(engine: keyof typeof ENGINES, options: BrowserContextOptions) {
  fixture = await startUiFixture({ QA_ACTIVITY: "long" });
  const browser = await ENGINES[engine]();
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  if ((options.viewport?.width ?? 0) < 1180)
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
  const rail = page.getByRole("complementary", { name: "Plan and steps" });
  await expect(rail.locator("[data-current]")).toHaveCount(1);
  return { browser, page, rail };
}

const qa = (path: string) => fetch(`${fixture?.origin}/__qa/${path}`, { method: "POST" });

function scrollers(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".pane-activity *")]
      .filter((element) => {
        const { overflowY } = getComputedStyle(element);
        return /auto|scroll/.test(overflowY) && element.scrollHeight > element.clientHeight + 1;
      })
      .map((element) => element.className),
  );
}

function inView(page: Page, selector: string) {
  return page.evaluate((query) => {
    const row = document.querySelector(query)?.getBoundingClientRect();
    const pane = document.querySelector(".activity-scroll")?.getBoundingClientRect();
    return !!row && !!pane && row.top >= pane.top - 1 && row.bottom <= pane.bottom + 1;
  }, selector);
}

for (const [engine, size, options] of MATRIX) {
  test(`a long task opens on its live step, in one scroller, with older runs folded (${engine} ${size})`, async () => {
    const { browser, page, rail } = await open(engine, options);
    await expect.poll(() => inView(page, ".activity-row[data-current]")).toBe(true);
    await expect(rail.locator("[data-current]")).toContainText("Fill the tail with brown");
    expect(await scrollers(page)).toEqual(["ui-scroll-area activity-scroll"]);
    await expect(rail.getByRole("button", { name: /^Open the paint app/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(rail.getByRole("button", { name: /^Colour the dog in/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // The plan header stays in view, as a strip of the plan's progress once the list scrolls away.
    await expect(rail.locator(".plan-head")).toHaveAttribute("data-stuck");
    expect(
      await rail
        .locator(".plan-progress > span")
        .evaluateAll((parts) => parts.map((part) => part.getAttribute("data-state"))),
    ).toEqual(["done", "done", "done", "doing", "todo", "skipped"]);
    // Every model call uses a key; those fold into their step. Only the blocked use is a row.
    await rail.getByRole("button", { name: /^Sketch the dog's outline/ }).click();
    await expect(rail.getByTestId("key-use")).toHaveCount(1);
    await expect(rail.getByTestId("key-use")).toContainText("Blocked stock-images key");
    // No text in the rail reaches past its edges, whatever the scrollbar takes.
    expect(
      await rail.evaluate((element) => {
        const { left, right } = element.getBoundingClientRect();
        const scroller = element.querySelector(".activity-scroll") as HTMLElement;
        const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
        const outside: string[] = [];
        const range = document.createRange();
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          range.selectNodeContents(node);
          const box = range.getBoundingClientRect();
          if (box.width && (box.left < left - 0.5 || box.right > right + 0.5))
            outside.push(node.textContent);
        }
        return outside;
      }),
    ).toEqual([]);
    if (size === "phone")
      for (const target of await rail
        .locator(".activity-row-head, .ui-disclosure-trigger, .ui-segment")
        .all()) {
        const box = await target.boundingBox();
        if (box) expect(box.height).toBeGreaterThanOrEqual(43.5);
      }
    expect(await scrollers(page)).toEqual(["ui-scroll-area activity-scroll"]);
    await browser.close();
  });
}

for (const engine of ["chrome", "webkit"] as const) {
  test(`new steps never move the row being read, and Jump to latest follows again (${engine})`, async () => {
    const { browser, page, rail } = await open(engine, DESKTOP);
    const scroller = page.locator(".activity-scroll");
    const jump = rail.getByRole("button", { name: "Jump to latest" });
    await expect(jump).not.toHaveAttribute("data-shown");
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2 - element.clientHeight / 2;
    });
    const reading = rail.getByRole("button", { name: /Check the canvas size/ });
    await reading.scrollIntoViewIfNeeded();
    await scroller.evaluate((element) => element.scrollBy(0, -40));
    await expect(jump).toHaveAttribute("data-shown");
    const before = await reading.boundingBox();
    await qa("steps?n=3");
    await expect(rail.locator("[data-current]")).toContainText("Fill area 3 with brown");
    await page.waitForTimeout(400);
    expect((await reading.boundingBox())?.y).toBeCloseTo(before?.y ?? Number.NaN, 0);
    await jump.click();
    await expect(jump).not.toHaveAttribute("data-shown");
    await expect.poll(() => inView(page, ".activity-row[data-current]")).toBe(true);
    await qa("steps?n=2");
    await expect(rail.locator("[data-current]")).toContainText("Fill area 5 with brown");
    await expect.poll(() => inView(page, ".activity-row[data-current]")).toBe(true);
    await browser.close();
  });

  test(`a step unfolds in place, Escape folds it, and usage opens over the rail (${engine})`, async () => {
    const { browser, page, rail } = await open(engine, DESKTOP);
    const row = rail.getByRole("button", { name: /Export a preview/ });
    await row.scrollIntoViewIfNeeded();
    const top = (await row.boundingBox())?.y;
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(rail.getByRole("region", { name: "Standard error text" })).toHaveText(
      "convert: no images defined `preview.png'\n",
    );
    expect((await row.boundingBox())?.y).toBeCloseTo(top ?? Number.NaN, 0);
    await page.keyboard.press("Escape");
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(row).toBeFocused();
    expect(await scrollers(page)).toEqual(["ui-scroll-area activity-scroll"]);

    const scroller = await page.locator(".activity-scroll").boundingBox();
    const usage = rail.getByRole("button", { name: /^Usage:/ });
    await usage.click();
    const details = page.getByRole("dialog", { name: "Usage" });
    await expect(details).toContainText("186,420 in · 9,210 out");
    expect(await page.locator(".activity-scroll").boundingBox()).toEqual(scroller);
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(usage).toBeFocused();
    await browser.close();
  });
}

for (const engine of ["chrome", "webkit"] as const) {
  test(`a question arriving above the row being read never moves it (${engine})`, async () => {
    const { browser, page, rail } = await open(engine, DESKTOP);
    const scroller = page.locator(".activity-scroll");
    const reading = rail.getByRole("button", { name: /Check the canvas size/ });
    await reading.scrollIntoViewIfNeeded();
    await scroller.evaluate((element) => element.scrollBy(0, -40));
    await expect(rail.getByRole("button", { name: "Jump to latest" })).toHaveAttribute(
      "data-shown",
    );
    const before = await reading.boundingBox();
    await qa("ask");
    await expect(
      page.getByRole("article", { name: "Question", includeHidden: true }),
    ).toBeAttached();
    await page.waitForTimeout(400);
    expect((await reading.boundingBox())?.y).toBeCloseTo(before?.y ?? Number.NaN, 0);
    await browser.close();
  });
}

test("a blocked key use stays under the plan item it happened in when only tools show (chrome)", async () => {
  const { browser, page, rail } = await open("chrome", DESKTOP);
  await rail.getByRole("radio", { name: "Tools" }).click();
  const name = /^Sketch the dog's outline/;
  await rail.getByRole("button", { name }).click();
  await expect(rail.getByTestId("key-use")).toContainText("Blocked stock-images key");
  await expect(
    rail.locator(".activity-group", { has: page.getByRole("button", { name }) }),
  ).toContainText("Blocked stock-images key");
  await expect(rail.getByRole("button", { name: /^Open the paint app/ })).toHaveText(
    "Open the paint app 1 step · 0:02",
  );
  await browser.close();
});

for (const [engine, size, options] of [
  ["chrome", "desktop", DESKTOP],
  ["webkit", "phone", PHONE],
] as const)
  test(`held downloads before a task scroll in the rail's one scroller (${engine} ${size})`, async () => {
    fixture = await startUiFixture({ QA_SESSION: "0" });
    const browser = await ENGINES[engine]();
    const page = await (await browser.newContext(options)).newPage();
    await page.route("**/api/cells/*/quarantine", (route) => {
      const parentCellId = new URL(route.request().url()).pathname.split("/")[3];
      return route.fulfill({
        json: {
          items: Array.from({ length: 10 }, (_, n) => ({
            version: 1,
            id: `01M4DQ00000000000000000${String(n).padStart(3, "0")}`,
            parentCellId,
            browserCellId: "01M4DB0000000000000000000B",
            browserInstance: "3f1d8a52-5a3b-4f8e-9c0e-1d2b3c4d5e6f",
            sessionId: "01M4DS000000000000000000SS",
            name: `reference-${n + 1}.png`,
            source: "images.example.test",
            bytes: 204_800 * (n + 1),
            sha256: "a".repeat(61) + String(n).padStart(3, "0"),
            kind: "document",
            createdAt: Date.now(),
            revision: 1,
            state: "held",
          })),
        },
      });
    });
    await page.goto(`${fixture.origin}/#token=${TOKEN}`);
    if (size === "phone") await page.getByRole("tab", { name: "Activity", exact: true }).click();
    const rail = page.getByRole("complementary", { name: "Plan and steps" });
    await expect(rail.getByTestId("download-row")).toHaveCount(10);
    await expect(rail.getByText("Plan and steps appear here once dot starts.")).toBeVisible();
    expect(await scrollers(page)).toEqual(["ui-scroll-area activity-scroll"]);
    expect(await page.locator(".activity-scroll").evaluate((element) => element.scrollTop)).toBe(0);
    const refresh = rail.getByRole("button", { name: "Refresh downloads" });
    await refresh.scrollIntoViewIfNeeded();
    await expect.poll(() => inView(page, ".download-actions")).toBe(true);
    await expect
      .poll(() => inView(page, ".download-row:nth-last-child(1 of .download-row)"))
      .toBe(true);
    await refresh.click();
    await browser.close();
  });

test("steps arriving while the reader follows shift nothing in the rail (chrome)", async () => {
  const { browser, page } = await open("chrome", DESKTOP);
  await page.evaluate(() => {
    const shifts: number[] = [];
    (window as unknown as { railShifts: number[] }).railShifts = shifts;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        sources: { node?: Node }[];
      })[])
        if (entry.sources.some((source) => source.node?.parentElement?.closest(".pane-activity")))
          shifts.push(entry.value);
    }).observe({ type: "layout-shift" });
  });
  for (let n = 0; n < 4; n++) {
    await qa("steps?n=1");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400);
  const shifts = await page.evaluate(
    () => (window as unknown as { railShifts: number[] }).railShifts,
  );
  expect(shifts.reduce((sum, value) => sum + value, 0)).toBeLessThan(0.001);
  await browser.close();
});

test("a replay's steps are plain rows, not boxed buttons (chrome)", async () => {
  fixture = await startUiFixture({ QA_ACTIVITY: "long" });
  const browser = await ENGINES.chrome();
  const page = await (await browser.newContext(DESKTOP)).newPage();
  await page.goto(`${fixture.origin}/?replay=${fixture.seeded[0]}#token=${TOKEN}`);
  const head = page.locator(".replay-house .activity-row-head").first();
  await expect(head).toBeVisible();
  expect(
    await head.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.borderTopWidth, style.backgroundColor];
    }),
  ).toEqual(["0px", "rgba(0, 0, 0, 0)"]);
  await browser.close();
});
