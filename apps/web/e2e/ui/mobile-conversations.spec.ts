import type { Locator, Page } from "@playwright/test";
import { expect, FIXTURE_START, type Harness, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

const FARES = "Comparing the 9:40 and 11:15 fares";
// Two minutes before the page's clock, which stands at a minute past the fixture's start.
const SINCE = new Date(new Date(FIXTURE_START).getTime() - 60_000).toISOString();

// The fixture's conversations with four under way, as the daemon's list carries them, and colour
// tags on two of the rest; whatever the daemon then files (a pin, an archive) shows in the next read.
async function underWay(page: Page) {
  await page.route("**/api/conversations", async (route) => {
    // The list is read again every few seconds, so a read can outlast the fixture.
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    const { conversations, archivedCount } = await reply.json();
    const live: [RegExp, object][] = [
      [/^Compare flights/, { state: "working", onScreen: true, activity: FARES }],
      [/^Rename the holiday/, { state: "needs-you", onScreen: false }],
      [/^Summarise the Q3/, { state: "waiting-for-computer", onScreen: false }],
      [/^Find a plumber/, { state: "paused", onScreen: false }],
    ];
    const tags: [RegExp, string][] = [
      [/^Rename the holiday/, "purple"],
      [/^Clean up my Downloads/, "blue"],
      [/^Draft a reply/, "orange"],
    ];
    await route.fulfill({
      json: {
        archivedCount,
        conversations: conversations.map(
          (entry: { sessionId: string; title: string | null; tag?: string }) => {
            const title = entry.title ?? "";
            const state = live.find(([name]) => name.test(title))?.[1];
            const tag = tags.find(([name]) => name.test(title))?.[1];
            return {
              ...entry,
              ...(tag && !entry.tag ? { tag } : {}),
              ...(state ? { ended: null, live: { ...state, since: SINCE } } : {}),
            };
          },
        ),
      },
    });
  });
}

const appearanceIs = (page: Page, appearance: string) =>
  page.addInitScript((value) => localStorage.setItem("localdot.appearance.v1", value), appearance);

async function shot(page: Page, ui: Harness, name: string) {
  await ui.settle();
  await ui.still();
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

// A finger on the page. Chromium is touched for real, through the DevTools protocol, so the browser
// decides on scrolling and sends its own clicks. Playwright's WebKit sends no touch moves, so there
// the finger is the pointer events a touch makes, dispatched where it is.
async function finger(page: Page) {
  const real = test.info().project.name.startsWith("c");
  const cdp = real ? await page.context().newCDPSession(page) : null;
  let at = { x: 0, y: 0 };
  const send = async (type: "down" | "move" | "up", x: number, y: number) => {
    at = { x, y };
    if (cdp) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: type === "down" ? "touchStart" : type === "move" ? "touchMove" : "touchEnd",
        touchPoints: type === "up" ? [] : [{ x, y }],
      });
      return;
    }
    await page.evaluate(
      ([kind, x, y]) => {
        const held = window as { fingerOn?: Element | null };
        if (kind === "down") held.fingerOn = document.elementFromPoint(x, y);
        held.fingerOn?.dispatchEvent(
          new PointerEvent(`pointer${kind}`, {
            pointerId: 9,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
        if (kind === "up") held.fingerOn = null;
      },
      [type, x, y] as const,
    );
  };
  return {
    // Across a row by `share` of its width, leftward when negative, stopping before it lifts.
    async swipe(target: Locator, share: number) {
      const box = await target.boundingBox();
      if (!box) throw new Error("Nothing to swipe");
      const y = box.y + box.height / 2;
      const from = share < 0 ? box.x + box.width - 40 : box.x + 40;
      const to = from + share * box.width;
      await send("down", from, y);
      for (let step = 1; step <= 14; step++) {
        await send("move", from + ((to - from) * step) / 14, y);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(120);
      await send("up", to, y);
    },
    async hold(target: Locator) {
      const box = await target.boundingBox();
      if (!box) throw new Error("Nothing to hold");
      await send("down", box.x + box.width / 3, box.y + box.height / 2);
      await page.waitForTimeout(650);
    },
    lift: () => send("up", at.x, at.y),
  };
}

async function openSheet(page: Page) {
  await page.getByRole("button", { name: "Conversations", exact: true }).tap();
  const sheet = page.getByRole("dialog", { name: "Conversations" });
  await expect(sheet.getByRole("region", { name: /^Under way/ })).toBeVisible();
  return sheet;
}

for (const appearance of ["graphite", "daylight"])
  test.describe(appearance, () => {
    test.beforeEach(({ page }) => {
      test.skip(!isPhone(page), "The phone's conversations");
    });

    test("the conversations under way ring the bubble and open as cards a tap away", async ({
      page,
      ui,
    }) => {
      await appearanceIs(page, appearance);
      await underWay(page);
      await ui.open("conversations");
      await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance);
      const bubble = page.getByRole("button", { name: "Conversations", exact: true });
      await expect(bubble).toHaveAccessibleDescription("4 others under way, 1 needs you");
      await expect(page.locator(".conversations-ring circle")).toHaveCount(4);
      await shot(page, ui, `${appearance}-home`);

      const sheet = await openSheet(page);
      // It rests at its medium height, so the cards and the first rows are in a thumb's reach.
      await expect(sheet).toHaveAttribute("data-detent", "medium");
      const deck = sheet.getByRole("region", { name: /^Under way/ });
      const cards = deck.getByRole("button", { name: /, 2 min$/ });
      await expect(cards).toHaveCount(4);
      expect(await cards.evaluateAll((all) => all.map((card) => card.ariaLabel))).toEqual([
        expect.stringMatching(/^Rename the holiday photos .*, purple tag, needs you, 2 min$/),
        expect.stringMatching(/^Compare flights to Lisbon .*, working, on screen, 2 min$/),
        expect.stringMatching(/^Summarise the Q3 board deck.*, waiting for the computer, 2 min$/),
        expect.stringMatching(/^Find a plumber .*, paused, 2 min$/),
      ]);
      await expect(cards.nth(1)).toContainText("Comparing the 9:40 and 11:15 fares");
      const viewport = page.viewportSize()?.height ?? 844;
      expect((await deck.boundingBox())?.y).toBeGreaterThan(viewport * 0.4);
      // Those under way are cards only; the rows below are the rest, by day.
      await expect(sheet.getByRole("row")).toHaveCount(3);
      await expect(sheet.getByRole("group", { name: "Show only a colour tag" })).toContainText(
        "OrangeBluePurple",
      );
      await shot(page, ui, `${appearance}-sheet`);

      // The deck scrolls sideways a card at a time.
      const strip = deck.getByRole("list");
      await strip.evaluate((list) => list.scrollTo({ left: list.scrollWidth }));
      await expect.poll(() => strip.evaluate((list) => list.scrollLeft)).toBeGreaterThan(0);

      const continued = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/conversation/continue",
      );
      await deck.getByRole("button", { name: /^Compare flights to Lisbon/ }).tap();
      expect((await continued).postDataJSON()).toHaveProperty("sessionId");
      await expect(sheet).toBeHidden();
    });

    test("a row swipes to pin and archive, and a hold magnifies it with its menu", async ({
      page,
      ui,
    }) => {
      await appearanceIs(page, appearance);
      await underWay(page);
      await ui.open("conversations");
      const sheet = await openSheet(page);
      const row = (title: RegExp) => sheet.getByRole("row").filter({ hasText: title });
      const hand = await finger(page);

      // A long swipe right pins it: the row glides up among those pinned.
      const pinned = page.waitForRequest((request) =>
        new URL(request.url()).pathname.endsWith("/pin"),
      );
      await hand.swipe(row(/Clean up my Downloads/), 0.8);
      expect((await pinned).postDataJSON()).toEqual({ pinned: true });
      await expect(sheet.locator(".conversations-list .conversations-day").first()).toHaveText(
        "Pinned",
      );
      await expect(sheet.getByRole("row").nth(0)).toContainText("Clean up my Downloads");

      // A short swipe left rests open on More and Archive.
      await hand.swipe(row(/Clean up my Downloads/), -0.35);
      const faces = row(/Clean up my Downloads/).locator(".ui-swipe-faces[data-side='trailing']");
      await expect(faces).toBeVisible();
      await expect(faces.locator(".ui-swipe-face")).toHaveText(["More", "Archive"]);
      await shot(page, ui, `${appearance}-swipe-open`);

      // Its Archive face slides the row away and files it.
      const archived = page.waitForRequest((request) =>
        new URL(request.url()).pathname.endsWith("/archive"),
      );
      await faces.getByText("Archive").tap();
      expect((await archived).postDataJSON()).toEqual({ archived: true });
      await expect(row(/Clean up my Downloads/)).toHaveCount(0);
      await expect(sheet.getByRole("button", { name: "Archived (1)" })).toBeVisible();

      // Held, a row grows into its preview, the list dims behind, and its menu opens under it.
      // Letting go over the menu chooses nothing.
      await hand.hold(row(/Draft a reply to the landlord/));
      const card = page.locator(".peek-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText("Draft a reply to the landlord");
      await expect(card).toContainText(/1 tasks?|\d+ tasks/);
      const menu = page.getByRole("menu", { name: "Conversation actions" });
      await expect(menu.getByRole("menuitem", { name: "Open conversation" })).toBeVisible();
      const cardBox = await card.boundingBox();
      const menuBox = await menu.boundingBox();
      expect(menuBox?.y).toBeGreaterThan((cardBox?.y ?? 0) + (cardBox?.height ?? 0) - 1);
      await shot(page, ui, `${appearance}-peek`);
      await hand.lift();
      await page.waitForTimeout(400);
      await expect(menu).toBeVisible();
      await expect(page.getByRole("dialog", { name: /Delete/ })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(card).toHaveCount(0);

      // A colour tag filters the list, and again shows all.
      const orange = sheet.getByRole("button", { name: "Orange" });
      await orange.tap();
      await expect(orange).toHaveAttribute("aria-pressed", "true");
      await expect(sheet.getByRole("row")).toHaveCount(1);
      await expect(sheet.getByRole("region", { name: /^Under way/ })).toHaveCount(0);
      await shot(page, ui, `${appearance}-tagged`);
      await orange.tap();
      await expect(sheet.getByRole("row")).toHaveCount(2);
    });
  });

test("every gesture has a button, and the motion follows the finger", async ({ page, ui }) => {
  test.skip(!isPhone(page), "The phone's conversations");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await underWay(page);
  await ui.open("conversations");
  const sheet = await openSheet(page);
  // Each card and row has its own Actions button, the way to everything its gestures do.
  const actions = sheet.getByRole("button", { name: /^Actions for / });
  await expect(actions).toHaveCount(4 + 3);
  await actions.nth(5).tap();
  const menu = page.getByRole("menu", { name: "Conversation actions" });
  for (const name of ["Rename", "Pin to top", "Archive", "Delete conversation"])
    await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  await expect(menu.getByRole("group", { name: "Tag" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  // The swipe faces are for touch alone.
  for (const faces of await sheet.locator(".ui-swipe-faces").all())
    await expect(faces).toHaveAttribute("aria-hidden", "true");

  // Mid-swipe the row sits under the finger, and let go short of a side it springs home.
  const hand = await finger(page);
  const target = sheet.getByRole("row").filter({ hasText: /Clean up my Downloads/ });
  await hand.swipe(target, -0.12);
  const surface = target.locator(".ui-swipe-content");
  await expect
    .poll(() => surface.evaluate((element) => getComputedStyle(element).transform))
    .toBe("none");
});

test("the desktop rail keeps its marks, rows and menu", async ({ page, ui }) => {
  test.skip(isPhone(page), "The rail is beside the stage on wider screens");
  await page.addInitScript(() =>
    localStorage.setItem("localdot.panels.v1", JSON.stringify({ sessions: true })),
  );
  await underWay(page);
  await ui.open("conversations");
  const rail = page.getByRole("navigation", { name: "Conversations" });
  await expect(rail.getByRole("button", { name: /^Clean up my Downloads/ })).toBeVisible();
  await expect(rail.getByText("Comparing the 9:40 and 11:15 fares")).toBeVisible();
  // None of the phone's parts reach it.
  for (const part of [".live-deck", ".ui-swipe", ".conversations-tags", ".conversations-ring"])
    await expect(page.locator(part)).toHaveCount(0);
  const rows = await rail.locator(".sessions-row").evaluateAll((all) =>
    all.slice(1).map((row) => {
      const glyph = row.querySelector(".ui-session-glyph")?.getBoundingClientRect();
      return { height: Math.round(row.getBoundingClientRect().height), glyph: glyph?.width };
    }),
  );
  for (const each of rows) expect(each.glyph).toBe(16);
  expect(rows.filter((each) => each.height === 36).length).toBeGreaterThan(3);
  await shot(page, ui, "rail-expanded");

  // A right click opens the plain menu, with no preview.
  await rail.getByRole("button", { name: /^Clean up my Downloads/ }).click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Conversation actions" })).toBeVisible();
  await expect(page.locator(".peek-card")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The chat's conversations popover keeps its list: those under way grouped as Active.
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  const list = page.getByRole("grid", { name: "Recent conversations" });
  await expect(list.locator(".conversations-day").first()).toHaveText("Active");
  await expect(list.locator(".conversations-row")).toHaveCount(7);
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(page.locator(".app")).toHaveAttribute("data-sessions", "collapsed");
  await shot(page, ui, "rail-collapsed");
});
