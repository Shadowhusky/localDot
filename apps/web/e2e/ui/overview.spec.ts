import type { Locator, Page, Request } from "@playwright/test";
import { expect, isPhone, runAt, test } from "./harness.ts";

// The overview: every conversation's screen, dot, status and progress, from the rail, the palette
// and Chat's list, in both houses at desktop and phone sizes. The `overview` scenario has the
// sample task at work beside eight more: two that need the user, two more at work (one on screen),
// one waiting for the computer, one at rest and two that ended today.
runAt("c14", "c39", "w14", "w39");

const OVERVIEW_KEY = "localdot.overview.v1";

const overview = (page: Page) => page.getByRole("region", { name: "Overview" });
const tiles = (page: Page) => overview(page).locator(".overview-tile");
const names = (page: Page) =>
  tiles(page).evaluateAll((all) => all.map((tile) => tile.getAttribute("aria-label") ?? ""));

async function columns(page: Page): Promise<number> {
  const tops = await tiles(page).evaluateAll((all) =>
    all.map((tile) => Math.round(tile.getBoundingClientRect().top)),
  );
  return tops.filter((top) => top === tops[0]).length;
}

async function openFromRail(page: Page) {
  await page
    .getByRole("navigation", { name: "Conversations" })
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await expect(overview(page)).toBeVisible();
}

async function openFromPalette(page: Page) {
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search actions" });
  await palette.getByRole("combobox").fill("overview");
  await palette.getByText("Show the overview").click();
  await expect(overview(page)).toBeVisible();
}

const density = (page: Page, size: "S" | "M" | "L") =>
  overview(page).getByRole("radiogroup", { name: "Tile size" }).getByRole("radio", { name: size });
const filter = (page: Page, name: RegExp) =>
  overview(page).getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name });

for (const appearance of ["graphite", "daylight"] as const)
  test.describe(appearance, () => {
    test.use({ colorScheme: appearance === "daylight" ? "light" : "dark" });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        (choice) => localStorage.setItem("localdot.appearance.v1", choice),
        appearance,
      );
    });

    test.describe("Studio", () => {
      test("shows every conversation, needs you first, and opens one with Back to return", async ({
        page,
        ui,
      }) => {
        await ui.open("overview");
        if (isPhone(page)) {
          await page.getByRole("button", { name: "More", exact: true }).first().click();
          await page.getByRole("menuitem", { name: "Overview", exact: true }).click();
          await expect(overview(page)).toBeVisible();
        } else {
          await openFromRail(page);
          await expect(
            page
              .getByRole("navigation", { name: "Conversations" })
              .getByRole("button", { name: "Overview", exact: true }),
          ).toHaveAttribute("aria-current", "page");
          await expect(page.locator(".stage-col")).toBeHidden();
        }
        await expect(tiles(page)).toHaveCount(9);
        await expect
          .poll(() => names(page))
          .toEqual([
            expect.stringMatching(/^Find a plumber near me with good reviews, needs you, /),
            expect.stringMatching(/^Reply to the boiler engineer, needs you, /),
            expect.stringMatching(/^Sample · monthly report, working, /),
            expect.stringMatching(/^Plan three autumn days in Kyoto, working, on screen, /),
            expect.stringMatching(/^Breakout, starring dot, working, /),
            expect.stringMatching(/^A poster for Blue Hour, waiting for the computer, /),
            expect.stringMatching(/^Where my money went, idle, /),
            expect.stringMatching(/^Clean up my Downloads folder, failed, /),
            expect.stringMatching(/^Standing desks under £400, done, /),
          ]);
        // Each tile shows its screen, its plan or steps, and what it needs.
        const kyoto = tiles(page).nth(3);
        await kyoto.scrollIntoViewIfNeeded();
        await expect(kyoto.locator(".overview-picture-image")).toBeVisible();
        await expect(kyoto).toContainText("1 of 4 · Check hours and entry fees");
        await expect(kyoto).toContainText("On screen");
        await tiles(page).first().scrollIntoViewIfNeeded();
        await expect(tiles(page).first()).toContainText("Weekday mornings or Saturday?");
        await expect(tiles(page).nth(1)).toContainText("Send the reply to Tom Hartley");
        await ui.settle();
        await ui.still();
        await page.screenshot({ path: test.info().outputPath(`studio-${appearance}.png`) });

        await tiles(page).nth(4).click();
        await expect(overview(page)).toBeHidden();
        if (!isPhone(page))
          await expect(
            page
              .getByRole("navigation", { name: "Conversations" })
              .getByRole("button", { name: /^Breakout, starring dot/ }),
          ).toHaveAttribute("aria-current", "true");
        await page.goBack();
        await expect(overview(page)).toBeVisible();
        await expect(tiles(page)).toHaveCount(9);
      });

      test("its rail button and the rail's conversations both lead back out of it", async ({
        page,
        ui,
      }) => {
        test.skip(isPhone(page), "A phone's overview has its own Back");
        await ui.open("overview");
        const rail = page.getByRole("navigation", { name: "Conversations" });
        const shown = rail.getByRole("button", { name: /^Sample · monthly report/ });
        await expect(shown).toHaveAttribute("aria-current", "true");
        await openFromRail(page);
        // Pressed again, Overview goes back to the conversation that was on show.
        await rail.getByRole("button", { name: "Overview", exact: true }).click();
        await expect(overview(page)).toBeHidden();
        await expect(page.locator(".stage-col")).toBeVisible();
        await expect(shown).toHaveAttribute("aria-current", "true");
        // A conversation in the rail opens itself, and Back comes back to the overview.
        await openFromRail(page);
        await rail.getByRole("button", { name: /^Breakout, starring dot/ }).click();
        await expect(overview(page)).toBeHidden();
        await expect(rail.getByRole("button", { name: /^Breakout, starring dot/ })).toHaveAttribute(
          "aria-current",
          "true",
        );
        await page.goBack();
        await expect(overview(page)).toBeVisible();
      });

      test("the palette opens it, and it reflows to the window at each size", async ({
        page,
        ui,
      }) => {
        test.skip(isPhone(page), "A phone's palette is in More; its sizes are in Chat's test");
        await ui.open("overview");
        await openFromPalette(page);
        await expect(density(page, "M")).toHaveAttribute("aria-checked", "true");
        const medium = await columns(page);
        await density(page, "S").click();
        await expect.poll(() => columns(page)).toBeGreaterThan(medium);
        await density(page, "L").click();
        await expect.poll(() => columns(page)).toBeLessThan(medium);
        const large = await columns(page);
        await page.setViewportSize({ width: 1100, height: 900 });
        await expect.poll(() => columns(page)).toBeLessThanOrEqual(large);
        await page.setViewportSize({ width: 2200, height: 900 });
        await expect.poll(() => columns(page)).toBeGreaterThan(large);
        // The size is kept for this browser.
        await page.reload();
        await expect(overview(page)).toBeVisible();
        await expect(density(page, "L")).toHaveAttribute("aria-checked", "true");
        expect(
          JSON.parse(
            (await page.evaluate((key) => localStorage.getItem(key), OVERVIEW_KEY)) ?? "{}",
          ),
        ).toMatchObject({ density: "l" });
      });

      test("filters to those at work or needing you", async ({ page, ui }) => {
        test.skip(isPhone(page), "Chat's test covers a phone");
        await ui.open("overview");
        await openFromRail(page);
        await expect(filter(page, /^All/)).toHaveAccessibleName(/All.*9/);
        await filter(page, /^Needs you/).click();
        await expect(tiles(page)).toHaveCount(2);
        await filter(page, /^Working/).click();
        await expect
          .poll(() => names(page))
          .toEqual([
            expect.stringMatching(/^Sample · monthly report, working/),
            expect.stringMatching(/^Plan three autumn days in Kyoto, working/),
            expect.stringMatching(/^Breakout, starring dot, working/),
            expect.stringMatching(/^A poster for Blue Hour, waiting for the computer/),
          ]);
        await filter(page, /^All/).click();
        await expect(tiles(page)).toHaveCount(9);
      });

      test("the arrows move between tiles and Return opens one", async ({ page, ui }) => {
        test.skip(isPhone(page), "Chat's test covers a phone");
        await ui.open("overview");
        await openFromRail(page);
        await density(page, "M").click();
        const across = await columns(page);
        await tiles(page).first().focus();
        await page.keyboard.press("ArrowRight");
        await expect(tiles(page).nth(1)).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(tiles(page).nth(1 + across)).toBeFocused();
        await page.keyboard.press("ArrowLeft");
        await expect(tiles(page).nth(across)).toBeFocused();
        await page.keyboard.press("End");
        await expect(tiles(page).last()).toBeFocused();
        await page.keyboard.press("Home");
        await expect(tiles(page).first()).toBeFocused();
        // One tab stop for the grid: Tab leaves it.
        await expect(tiles(page).nth(1)).toHaveAttribute("tabindex", "-1");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        await expect(overview(page)).toBeHidden();
        await expect(
          page
            .getByRole("navigation", { name: "Conversations" })
            .getByRole("button", { name: /^Reply to the boiler engineer/ }),
        ).toHaveAttribute("aria-current", "true");
      });
    });

    test.describe("Chat", () => {
      test.use({ viewStyle: "chat", phoneList: true });

      test("opens from the list, reads as a list or two columns, and Back returns", async ({
        page,
        ui,
      }) => {
        await ui.open("overview");
        await page.getByRole("button", { name: "Overview", exact: true }).click();
        await expect(overview(page)).toBeVisible();
        await expect(overview(page).getByRole("heading", { name: "Overview" })).toBeVisible();
        await expect(tiles(page)).toHaveCount(9);
        await expect(tiles(page).first()).toHaveAccessibleName(/needs you/);
        if (isPhone(page)) {
          await density(page, "M").click();
          await expect.poll(() => columns(page)).toBe(1);
          await density(page, "S").click();
          await expect.poll(() => columns(page)).toBe(2);
          await density(page, "M").click();
        }
        await ui.settle();
        await ui.still();
        await page.screenshot({ path: test.info().outputPath(`chat-${appearance}.png`) });

        await tiles(page).nth(2).click();
        await expect(overview(page)).toBeHidden();
        await expect(page).toHaveURL(/#\/c\/[0-9A-Z]{26}$/);
        await page.goBack();
        await expect(overview(page)).toBeVisible();
        await overview(page).getByRole("button", { name: "Conversations", exact: true }).click();
        await expect(overview(page)).toBeHidden();
        await expect(page.locator(".phone-row").first()).toBeVisible();
      });
    });
  });

// What the page asks the daemon for while the overview shows: only tiles in view are asked about
// and have pictures loaded, nothing is asked once the page is hidden, and the computer's stream
// is asked for nothing at all.
test.describe("costs", () => {
  test("asks only about the tiles in view, and nothing for a hidden page or the stream", async ({
    page,
    ui,
  }) => {
    test.skip(isPhone(page), "Measured at desktop size");
    await page.setViewportSize({ width: 1440, height: 560 });
    await page.addInitScript(
      (key) => localStorage.setItem(key, JSON.stringify({ density: "l", filter: "all" })),
      OVERVIEW_KEY,
    );
    await ui.open("overview");
    await ui.picture();
    const asked: Request[] = [];
    page.on("request", (request) => asked.push(request));
    await openFromRail(page);
    await expect(tiles(page)).toHaveCount(9);
    await expect(tiles(page).first().locator(".overview-picture-image")).toBeVisible();
    await page.waitForTimeout(2_500);

    const inView = await visibleIds(page);
    const hidden = (await allIds(page)).filter((id) => !inView.includes(id));
    expect(hidden.length).toBeGreaterThan(0);
    const reads = asked.filter((request) => request.url().includes("/api/overview?"));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      const ids = new URL(read.url()).searchParams.get("ids")?.split(",") ?? [];
      for (const id of hidden) expect(ids).not.toContain(id);
    }
    const pictures = asked.filter((request) =>
      /\/api\/sessions\/[0-9A-Z]{26}\/(thumbs|frames)\//.test(request.url()),
    );
    for (const picture of pictures)
      expect(hidden).not.toContain(new URL(picture.url()).pathname.split("/")[3]);
    expect(
      asked
        .map((request) => request.url())
        .filter((url) => /stream-ticket|\/(desktop|browser)\/[A-Za-z0-9_-]{22}\//.test(url)),
    ).toEqual([]);

    // A hidden page asks nothing more.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(500);
    const before = asked.length;
    await page.waitForTimeout(2_500);
    expect(
      asked.slice(before).filter((request) => request.url().includes("/api/overview?")),
    ).toEqual([]);

    // Scrolled to, the rest are asked about.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tiles(page).last().scrollIntoViewIfNeeded();
    const last = (await allIds(page)).at(-1) ?? "";
    await expect
      .poll(() =>
        asked.some(
          (request) => request.url().includes("/api/overview?") && request.url().includes(last),
        ),
      )
      .toBe(true);
  });
});

async function allIds(page: Page): Promise<string[]> {
  return overview(page)
    .locator(".overview-cell")
    .evaluateAll((cells) => cells.map((cell) => (cell as HTMLElement).dataset.flip ?? ""));
}

// The tiles within the scroller's view or the room it reads ahead.
async function visibleIds(page: Page): Promise<string[]> {
  const scroller: Locator = overview(page).locator(".overview-scroll");
  return scroller.evaluate((element) => {
    const view = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>(".overview-cell")]
      .filter((cell) => {
        const box = cell.getBoundingClientRect();
        return box.bottom > view.top - 240 && box.top < view.bottom + 240;
      })
      .map((cell) => cell.dataset.flip ?? "");
  });
}
