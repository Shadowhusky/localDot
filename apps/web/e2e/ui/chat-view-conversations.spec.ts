import type { Page } from "@playwright/test";
import { expect, FIXTURE_START, finger, type Harness, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test.use({ viewStyle: "chat", phoneList: true });

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

for (const appearance of ["graphite", "daylight"])
  test.describe(appearance, () => {
    test.beforeEach(({ page }) => {
      test.skip(!isPhone(page), "The phone's conversations");
    });

    test("the list is the home: whichever needs the user first, with what each is doing", async ({
      page,
      ui,
    }) => {
      await appearanceIs(page, appearance);
      await underWay(page);
      await ui.open("conversations");
      await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance);
      await expect(page.getByRole("heading", { name: "Conversations" })).toBeVisible();
      const rows = page.locator(".phone-row");
      await expect(rows.nth(0)).toHaveAccessibleName(/^Rename the holiday photos.*\. Needs you\./);
      await expect(rows.nth(1)).toHaveAccessibleName(/^Compare flights to Lisbon.*\. Working\./);
      await expect(rows.nth(1)).toContainText("Comparing the 9:40 and 11:15 fares");
      await expect(rows.nth(2)).toHaveAccessibleName(
        /^Summarise the Q3 board deck.*\. Waiting for the computer\./,
      );
      await expect(rows.nth(0).locator(".conversation-avatar-point")).toBeVisible();
      await expect(page.getByRole("group", { name: "Show only a colour tag" })).toContainText(
        "OrangeBluePurple",
      );
      // The needs-you row takes two lines, the others one.
      const heights = await rows.evaluateAll((all) =>
        all.slice(0, 2).map((row) => row.querySelector(".phone-row-line")?.clientHeight ?? 0),
      );
      expect(heights[0]).toBeGreaterThanOrEqual(heights[1] ?? 0);
      await shot(page, ui, `${appearance}-home`);

      const continued = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/conversation/continue",
      );
      await rows.nth(1).tap();
      expect((await continued).postDataJSON()).toHaveProperty("sessionId");
      await expect(page).toHaveURL(/#\/c\//);
      await expect(page.getByRole("button", { name: "Back to conversations" })).toBeVisible();
      await page.goBack();
      await expect(page.getByRole("heading", { name: "Conversations" })).toBeInViewport();
    });

    test("a row swipes to pin and archive, and a hold magnifies it with its menu", async ({
      page,
      ui,
    }) => {
      await appearanceIs(page, appearance);
      await underWay(page);
      await ui.open("conversations");
      await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
      const row = (title: RegExp) => page.locator(".phone-row-wrap").filter({ hasText: title });
      await expect(row(/Clean up my Downloads/)).toBeVisible();
      const hand = await finger(page);

      // A long swipe right pins it: it goes up into the rail.
      const pinned = page.waitForRequest((request) =>
        new URL(request.url()).pathname.endsWith("/pin"),
      );
      await hand.swipe(row(/Clean up my Downloads/), 0.8);
      expect((await pinned).postDataJSON()).toEqual({ pinned: true });
      await expect(
        page.getByRole("list", { name: "Pinned" }).getByRole("button", { name: /^Clean up my/ }),
      ).toBeVisible();

      // A short swipe left rests open on More and Archive.
      await hand.swipe(row(/Draft a reply to the landlord/), -0.35);
      const faces = row(/Draft a reply to the landlord/).locator(
        ".ui-swipe-faces[data-side='trailing']",
      );
      await expect(faces).toBeVisible();
      await expect(faces.locator(".ui-swipe-face")).toHaveText(["More", "Archive"]);
      await shot(page, ui, `${appearance}-swipe-open`);

      // Its Archive face slides the row away and files it.
      const archived = page.waitForRequest((request) =>
        new URL(request.url()).pathname.endsWith("/archive"),
      );
      await faces.getByText("Archive").tap();
      expect((await archived).postDataJSON()).toEqual({ archived: true });
      await expect(row(/Draft a reply to the landlord/)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Archived (1)" })).toBeVisible();

      // Held, a row grows into its preview, the list dims behind, and its menu opens under it.
      // Letting go over the menu chooses nothing.
      await hand.hold(row(/Sample . monthly report/).first());
      const card = page.locator(".peek-card");
      await expect(card).toBeVisible();
      const menu = page.getByRole("menu", { name: "Conversation actions" });
      await expect(menu.getByRole("menuitem", { name: "Open conversation" })).toBeVisible();
      const cardBox = await card.boundingBox();
      const menuBox = await menu.boundingBox();
      expect(menuBox?.y).toBeGreaterThan((cardBox?.y ?? 0) + (cardBox?.height ?? 0) - 1);
      await shot(page, ui, `${appearance}-peek`);
      await hand.lift();
      await page.waitForTimeout(400);
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(card).toHaveCount(0);
    });
  });

test("a swipe is never read as a hold, however slowly the finger starts", async ({ page, ui }) => {
  test.skip(!isPhone(page), "The phone's conversations");
  await underWay(page);
  await ui.open("conversations");
  const target = page.locator(".phone-row-wrap").filter({ hasText: /Clean up my Downloads/ });
  await expect(target).toBeVisible();
  const hand = await finger(page);
  await hand.swipe(target, -0.35);
  await page.waitForTimeout(600);
  await expect(page.locator(".peek-card")).toHaveCount(0);
  await expect(page.getByRole("menu", { name: "Conversation actions" })).toHaveCount(0);
});

test("every gesture has a button, and the motion follows the finger", async ({ page, ui }) => {
  test.skip(!isPhone(page), "The phone's conversations");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await underWay(page);
  await ui.open("conversations");
  const rows = page.locator(".phone-row-wrap");
  await expect(rows.first()).toBeVisible();
  // Each row has its own Actions button, the way to everything its gestures do.
  const actions = page.getByRole("button", { name: /^Actions for / });
  await expect(actions).toHaveCount(await rows.count());
  await actions.last().focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Conversation actions" });
  for (const name of ["Rename", "Pin to top", "Archive", "Delete conversation"])
    await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  await expect(menu.getByRole("group", { name: "Tag" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  // The swipe faces are for touch alone.
  for (const faces of await page.locator(".ui-swipe-faces").all())
    await expect(faces).toHaveAttribute("aria-hidden", "true");

  // Mid-swipe the row sits under the finger, and let go short of a side it springs home.
  const hand = await finger(page);
  const target = rows.filter({ hasText: /Clean up my Downloads/ });
  await hand.swipe(target, -0.12);
  const surface = target.locator(".ui-swipe-content");
  await expect
    .poll(() => surface.evaluate((element) => getComputedStyle(element).transform))
    .toBe("none");
});
