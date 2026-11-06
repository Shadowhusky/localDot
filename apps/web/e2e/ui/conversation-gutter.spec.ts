import type { Page } from "@playwright/test";
import { expect, FIXTURE_START, isPhone, runAt, test } from "./harness.ts";

runAt("c39", "w39", "c14");

const SINCE = new Date(new Date(FIXTURE_START).getTime() - 60_000).toISOString();
const TAGS: [RegExp, string][] = [
  [/^Rename the holiday/, "purple"],
  [/^Clean up my Downloads/, "blue"],
  [/^Draft a reply/, "orange"],
  [/^Find a plumber/, "red"],
  [/^Summarise the Q3/, "green"],
  [/^Compare flights/, "yellow"],
];

// The fixture's conversations with a colour tag on most, so the row of them overflows a phone, and
// two pinned.
async function filed(page: Page) {
  await page.route("**/api/conversations", async (route) => {
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    const { conversations, archivedCount } = await reply.json();
    await route.fulfill({
      json: {
        archivedCount,
        conversations: conversations.map((entry: { title: string | null }, at: number) => ({
          ...entry,
          ...(at < 2 ? { pinned: true } : {}),
          ...(at === 3
            ? { ended: null, live: { state: "working", onScreen: false, since: SINCE } }
            : {}),
          tag: TAGS.find(([name]) => name.test(entry.title ?? ""))?.[1],
        })),
      },
    });
  });
}

// Where each part's own edge is drawn, from the edges of the list's screen: a heading's by its words.
function edges(page: Page, root: string, parts: Record<string, string>) {
  return page.evaluate(
    ([rootSelector, wanted]) => {
      const base = document.querySelector(rootSelector as string)?.getBoundingClientRect();
      const out: Record<string, { left: number; right: number }> = {};
      for (const [name, selector] of Object.entries(wanted as Record<string, string>)) {
        const part = document.querySelector(selector);
        if (!part || !base) continue;
        const words = document.createRange();
        words.selectNodeContents(part);
        const box = (part.matches(".conversations-day") ? words : part).getBoundingClientRect();
        out[name] = { left: box.left - base.left, right: base.right - box.right };
      }
      return out;
    },
    [root, parts] as const,
  );
}

test.describe("Chat", () => {
  test.use({ viewStyle: "chat", phoneList: true });

  for (const [name, size] of [
    ["phone", { width: 390, height: 844 }],
    ["small phone", { width: 320, height: 568 }],
    ["tablet", { width: 768, height: 1024 }],
  ] as const) {
    test(`the list keeps one gutter on a ${name}`, async ({ page, ui }, info) => {
      await page.setViewportSize(size);
      await filed(page);
      await ui.open("conversations");
      const tags = page.locator(".phone-list-scroll > .conversations-tags");
      await expect(tags.locator(".conversations-tag").first()).toBeVisible();
      await expect(page.locator(".phone-rail-item").first()).toBeVisible();
      await ui.settle();
      await page.screenshot({ path: info.outputPath("list.png") });

      const at = await edges(page, ".phone-list-screen", {
        title: ".phone-large-title",
        search: ".phone-search",
        tag: ".conversations-tag",
        tags: ".phone-list-scroll > .conversations-tags",
        rail: ".phone-rail-name",
        ball: ".phone-row-avatar",
        when: ".phone-row-time",
      });
      const gutter = at.search?.left ?? 0;
      expect(gutter).toBeGreaterThan(0);
      expect(at.search?.right).toBeCloseTo(gutter, 0);
      for (const part of ["title", "tag", "rail", "ball"])
        expect(at[part]?.left, `${part}'s left edge`).toBeCloseTo(gutter, 0);
      expect(at.when?.right, "a row's right edge").toBeCloseTo(gutter, 0);

      // The tags scroll edge to edge, the first and the last coming to rest at the gutter.
      expect(at.tags?.left).toBe(0);
      expect(at.tags?.right).toBe(0);
      const ends = await tags.evaluate((row) => {
        row.scrollLeft = row.scrollWidth;
        const last = row.lastElementChild?.getBoundingClientRect();
        const box = row.getBoundingClientRect();
        return {
          overflows: row.scrollWidth > row.clientWidth,
          right: box.right - (last?.right ?? 0),
        };
      });
      if (ends.overflows) expect(ends.right, "the last tag's rest").toBeCloseTo(gutter, 0);

      await page.getByRole("textbox", { name: "Search conversations" }).fill("zzzzz");
      await expect(page.locator(".phone-list-body .ui-empty")).toBeVisible();
      const none = await edges(page, ".phone-list-screen", {
        art: ".phone-list-body .ui-empty-art",
      });
      expect(none.art?.left, "a search with no match").toBeCloseTo(gutter, 0);
    });
  }
});

test.describe("Studio", () => {
  test.use({ viewStyle: "studio" });

  test("the conversation sheet keeps one gutter", async ({ page, ui }, info) => {
    test.skip(!isPhone(page), "The phone's sheet");
    await filed(page);
    await ui.open("conversations");
    await page
      .getByRole("button", { name: /^Conversations/ })
      .first()
      .click();
    const sheet = ".conversations[data-layout='sheet']";
    const tags = page.locator(`${sheet} > .conversations-tags`);
    await expect(tags.locator(".conversations-tag").first()).toBeVisible();
    await expect(page.locator(`${sheet} .live-card`).first()).toBeVisible();
    await ui.settle();
    await page.screenshot({ path: info.outputPath("sheet.png") });
    const at = await edges(page, ".conversations-sheet", {
      search: ".conversations-search",
      tag: ".conversations-tag",
      tags: `${sheet} > .conversations-tags`,
      card: `${sheet} .live-card`,
      heading: `${sheet} .conversations-day`,
      ball: `${sheet} .conversations-row .conversation-avatar`,
    });
    const gutter = at.search?.left ?? 0;
    expect(gutter).toBeGreaterThan(0);
    for (const part of ["tag", "card", "heading"])
      expect(at[part]?.left, `${part}'s left edge`).toBeCloseTo(gutter, 0);
    // The ball is three quarters of its frame.
    expect((at.ball?.left ?? 0) + 4, "a row's ball").toBeCloseTo(gutter, 0);
    expect(at.tags?.left).toBe(0);
    expect(at.tags?.right).toBe(0);

    await page.getByRole("combobox", { name: "Search conversations" }).fill("zzzzz");
    await expect(page.locator(`${sheet} .ui-empty`)).toBeVisible();
    const none = await edges(page, ".conversations-sheet", { art: `${sheet} .ui-empty-art` });
    expect(none.art?.left, "a search with no match").toBeCloseTo(gutter, 0);
  });
});
