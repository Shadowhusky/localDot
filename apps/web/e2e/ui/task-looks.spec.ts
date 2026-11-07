import type { Locator, Page } from "@playwright/test";
import { openSettings } from "../settings-ui.ts";
import { keyboardFocus } from "./focus-ring.ts";
import { expect, FIXTURE_START, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");

const PANELS = "localdot.panels.v1";
const SINCE = new Date(new Date(FIXTURE_START).getTime() - 60_000).toISOString();
const TITLES = [
  "Compare flights to Lisbon",
  "Fix the login page",
  "Quarterly numbers",
  "Cut the launch video",
  "Poster for the fair",
  "Why the build fails",
  "Book the dentist",
];
const PERSONAS = [undefined, "coder", "finance", "video", "design", "research", undefined];
const LIVE = [
  { state: "working", onScreen: true, activity: "Comparing the 9:40 and 11:15 fares" },
  { state: "needs-you", onScreen: false },
];

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// Ids made one after another, as a day's tasks are, so they share their first letters.
const taskId = (n: number) =>
  `01M6K1VH23${[...Array(16).keys()].map((at) => ULID_CHARS[((n * (at + 7) * 2654435761) % 32) & 31]).join("")}`;

function entry(n: number) {
  const sessionId = taskId(n);
  const live = LIVE[n];
  const persona = PERSONAS[n % PERSONAS.length];
  return {
    sessionId,
    sessions: [sessionId],
    title: `${TITLES[n % TITLES.length]} ${n}`,
    said: null,
    startedAt: new Date(new Date(FIXTURE_START).getTime() - n * 3_600_000).toISOString(),
    ended: live ? null : n % 3 === 0 ? "stopped" : n % 7 === 0 ? "error" : "done",
    firstTask: sessionId,
    ...(persona ? { persona } : {}),
    ...(live ? { live: { ...live, since: SINCE } } : {}),
  };
}

// A long list of conversations, as the daemon carries them, of every dot and status.
const longList = (page: Page, count = 50) =>
  page.route("**/api/conversations", (route) =>
    route.fulfill({
      json: { conversations: Array.from({ length: count }, (_, n) => entry(n)), archivedCount: 0 },
    }),
  );

const expanded = (page: Page, sessions: boolean) =>
  page.addInitScript(
    ([key, value]) => localStorage.setItem(key, JSON.stringify({ sessions: value })),
    [PANELS, sessions] as const,
  );

const lookOf = (row: Locator) =>
  row
    .locator("[data-wear]")
    .evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.wear));

// Where the rows are on this layout: the rail on a wide screen, the sheet on a phone.
async function openList(page: Page) {
  if (!isPhone(page)) return page.locator(".sessions-item");
  await page
    .getByRole("button", { name: /^Conversations/ })
    .first()
    .click();
  return page.locator(".conversations-row");
}

// A dot's plates show together, once they are all in.
const platesIn = (rows: Locator) =>
  expect(rows.locator(".dot-avatar[data-loading], .dot[data-skin='loading']")).toHaveCount(0);

async function looks(rows: Locator) {
  await expect(rows.first()).toBeVisible();
  await platesIn(rows);
  return rows.evaluateAll((items) =>
    items.map((row) =>
      [...row.querySelectorAll<HTMLElement>("[data-wear]")].map((item) => item.dataset.wear).join(),
    ),
  );
}

const appearance = (page: Page, value: string) =>
  page.evaluate((choice) => {
    localStorage.setItem("localdot.appearance.v1", choice);
    window.dispatchEvent(new StorageEvent("storage", { key: "localdot.appearance.v1" }));
  }, value);

// The first conversation's look chooser, opened from its row's menu.
async function openLookChooser(page: Page) {
  const rows = await openList(page);
  const row = rows.first();
  await expect(row).toBeVisible();
  await platesIn(row);
  if (!isPhone(page)) await row.hover();
  await row.getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Change look" }).click();
  const chooser = page.getByRole("dialog", { name: "Change look" });
  await expect(chooser).toBeVisible();
  return { row, chooser };
}

// Each tile of `groups`, focused in turn by keyboard so it wears its ring, paints its rim, shadow
// and ring inside every box that clips it: across, inside each one's padding box; down, inside the
// nearest scroller's whole range, which scrolling brings into view. Its dot sits in the middle of
// its picture, and the picture in the middle of the tile across.
async function tileFaults(page: Page, groups: Locator) {
  await keyboardFocus(page);
  return groups.evaluateAll((all) => {
    const faults: string[] = [];
    const tiles = all.flatMap((group) => [
      ...group.querySelectorAll<HTMLElement>(":scope > .ui-radio-card"),
    ]);
    for (const tile of tiles) {
      const name = `${tile.parentElement?.getAttribute("aria-label")} ${tile.querySelector(".ui-choice-label")?.textContent}`;
      const off = (what: string, by: number, slack = 0.5) => {
        if (by > slack) faults.push(`${name}: ${what} by ${by.toFixed(1)} px`);
      };
      tile.querySelector("input")?.focus({ preventScroll: true });
      const style = getComputedStyle(tile);
      const box = tile.getBoundingClientRect();
      const ringed = style.outlineStyle !== "none";
      if (!ringed) faults.push(`${name}: no focus ring`);
      const ring = ringed
        ? Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth)
        : 0;
      let [left, top, right, bottom] = [
        box.left - ring,
        box.top - ring,
        box.right + ring,
        box.bottom + ring,
      ];
      for (const shadow of style.boxShadow.replace(/[a-z-]+\([^)]*\)/g, "").split(",")) {
        if (/inset|none/.test(shadow)) continue;
        const [x = 0, y = 0, blur = 0, spread = 0] = shadow
          .trim()
          .split(/\s+/)
          .map(Number.parseFloat);
        left = Math.min(left, box.left + x - blur - spread);
        top = Math.min(top, box.top + y - blur - spread);
        right = Math.max(right, box.right + x + blur + spread);
        bottom = Math.max(bottom, box.bottom + y + blur + spread);
      }
      let scroller = false;
      for (let clip = tile.parentElement; clip; clip = clip.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(clip);
        if (overflowX !== "visible" || overflowY !== "visible") {
          const at = clip.getBoundingClientRect();
          const inner = at.left + clip.clientLeft;
          const what = clip.className.split(" ")[0];
          off(`cut at ${what}'s left`, inner - left);
          off(`cut at ${what}'s right`, right - inner - clip.clientWidth);
          if (!scroller && /auto|scroll/.test(overflowY)) {
            scroller = true;
            const start = at.top + clip.clientTop - clip.scrollTop;
            off(`cut at ${what}'s top`, start - top);
            off(`cut at ${what}'s bottom`, bottom - start - clip.scrollHeight);
          }
        }
        if (clip.getAttribute("role") === "dialog") break;
      }
      const picture = tile.querySelector(".ui-radio-card-preview > *")?.getBoundingClientRect();
      const dot = tile.querySelector(".dot, .dot-avatar")?.getBoundingClientRect();
      if (!picture || !dot) {
        faults.push(`${name}: no dot`);
        continue;
      }
      const across = (rect: DOMRect) => rect.x + rect.width / 2;
      const down = (rect: DOMRect) => rect.y + rect.height / 2;
      off("dot off its picture's middle across", Math.abs(across(dot) - across(picture)), 1);
      off("dot off its picture's middle down", Math.abs(down(dot) - down(picture)), 1);
      off("picture off the tile's middle across", Math.abs(across(picture) - across(box)), 1);
    }
    if (!tiles.length) faults.push("no tiles");
    return faults;
  });
}

// The first row's first and last tiles, at the grid's two edges.
async function edgeTiles(group: Locator) {
  const tiles = group.locator(":scope > .ui-radio-card");
  const tops = await tiles.evaluateAll((items) =>
    items.map((item) => Math.round(item.getBoundingClientRect().top)),
  );
  return [tiles.first(), tiles.nth(tops.filter((top) => top === tops[0]).length - 1)] as const;
}

// The tiles' faults in Graphite and Daylight, with pictures of `frame` in each: the ring on the
// first group's left and right edges, and on the last tile, scrolled to the end.
async function tileFaultsInEach(
  page: Page,
  settle: () => Promise<void>,
  groups: Locator,
  frame: Locator,
) {
  const faults: string[] = [];
  for (const value of ["graphite", "daylight"]) {
    await appearance(page, value);
    await expect(page.locator("html")).toHaveAttribute("data-appearance", value);
    await settle();
    faults.push(...(await tileFaults(page, groups)).map((fault) => `${value} ${fault}`));
    const [left, right] = await edgeTiles(groups.first());
    const end = groups.last().locator(":scope > .ui-radio-card").last();
    for (const [edge, tile] of Object.entries({ left, right, end })) {
      await tile.scrollIntoViewIfNeeded();
      await tile.locator("input").focus();
      await settle();
      await frame.screenshot({ path: test.info().outputPath(`tiles-${value}-${edge}.png`) });
    }
  }
  return faults;
}

test("every task in a long list has a dot of its own, the same after a reload", async ({
  page,
  ui,
}) => {
  await longList(page);
  await expanded(page, true);
  await ui.open("ready");
  let rows = await openList(page);
  const first = await looks(rows);
  expect(first.length).toBeGreaterThanOrEqual(10);
  expect(first.filter((look) => look === "")).toEqual([]);
  let same = 0;
  for (let at = 1; at < first.length; at++) if (first[at] === first[at - 1]) same += 1;
  expect(same).toBeLessThan(2);
  await ui.settle();
  for (const value of ["graphite", "daylight"]) {
    await appearance(page, value);
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath(`list-${value}.png`) });
  }
  await page.waitForLoadState("networkidle");
  await page.reload();
  rows = await openList(page);
  expect(await looks(rows)).toEqual(first);
});

test("a long list stays still: only the tasks under way have a live dot", async ({ page, ui }) => {
  await longList(page);
  await expanded(page, true);
  await ui.open("ready");
  const rows = await openList(page);
  await expect(rows.first()).toBeVisible();
  await ui.settle();
  const live = await rows.locator(".dot").count();
  const still = await rows.locator(".dot-avatar").count();
  expect(live).toBeLessThanOrEqual(LIVE.length);
  expect(still).toBeGreaterThan(5);
  // A still dot is a handful of elements with no canvas, and no gradient of its own.
  const parts = await rows
    .locator(".dot-avatar")
    .first()
    .evaluate((avatar) => ({
      nodes: avatar.querySelectorAll("*").length,
      canvases: avatar.querySelectorAll("canvas, linearGradient, radialGradient").length,
    }));
  expect(parts.nodes).toBeLessThan(10);
  expect(parts.canvases).toBe(0);
});

test("a status stays readable beside its dot, however the rail is", async ({ page, ui }) => {
  test.skip(isPhone(page), "a phone has no rail");
  await longList(page, 14);
  await expanded(page, false);
  await ui.open("ready");
  const rows = page.locator(".sessions-item");
  await expect(rows.first()).toBeVisible();
  const badges = rows.locator(".conversation-avatar-status .ui-session-glyph");
  await expect(badges).toHaveCount(14);
  const box = await badges.first().boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(12);
  for (const value of ["graphite", "daylight"]) {
    await appearance(page, value);
    await ui.settle();
    await page.screenshot({ path: test.info().outputPath(`rail-collapsed-${value}.png`) });
  }
});

test("a task's look is changed from its menu, is saved, and can be given back", async ({
  page,
  ui,
}) => {
  await expanded(page, true);
  const fixture = await ui.open("conversations");
  const { row, chooser } = await openLookChooser(page);
  const before = await lookOf(row);
  // A head it isn't wearing, so choosing it is a change: the fixture's ids, which draw the look,
  // are new on every run.
  const [head, label] = before.includes("crown") ? ["top-hat", "Top hat"] : ["crown", "Crown"];
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("look-chooser.png") });
  await chooser.getByRole("radio", { name: label, exact: true }).click({ force: true });
  await expect(row.locator(`[data-wear="${head}"]`)).toHaveCount(1);
  await expect
    .poll(async () => {
      const list = await page.request.get(`${fixture.origin}/api/conversations`, {
        headers: { authorization: `Bearer ${"a".repeat(43)}` },
      });
      const { conversations } = (await list.json()) as { conversations: { look?: string[] }[] };
      return conversations.flatMap((conversation) => conversation.look ?? []);
    })
    .toContain(head);
  await chooser.getByRole("button", { name: "Reset" }).click();
  await expect.poll(() => lookOf(row)).toEqual(before);
});

test("the look chooser's tiles show whole, rims and rings, each dot in its middle", async ({
  page,
  ui,
}) => {
  await expanded(page, true);
  await ui.open("conversations");
  const { chooser } = await openLookChooser(page);
  await platesIn(chooser);
  const groups = chooser.locator(".ui-radio-cards");
  expect(await tileFaultsInEach(page, ui.settle, groups, chooser)).toEqual([]);
});

test("Settings' dot and accessory tiles show whole, rims and rings, each dot in its middle", async ({
  page,
  ui,
}) => {
  await ui.open("ready");
  const sheet = await openSettings(page, undefined, "Your dot");
  const groups = sheet.locator(".persona-picker, .accessory-picker");
  await groups.last().scrollIntoViewIfNeeded();
  await platesIn(groups);
  expect(await tileFaultsInEach(page, ui.settle, groups, sheet)).toEqual([]);
});

const wornIn = (where: Locator) =>
  where.locator("[data-wear]").evaluateAll((items) =>
    items
      .map((item) => (item as HTMLElement).dataset.wear)
      .sort()
      .join(" "),
  );

// The conversation's row, where this layout keeps it, comes to wear `look`; on a phone its list
// opens and is left again. The fixture pushes no live status, so the page is looked at again, which
// reads the list as a push would.
async function rowWears(page: Page, title: string, look: string) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const chat = (await page.locator(".app").getAttribute("data-view")) === "chat";
  if (chat && isPhone(page))
    await page.getByRole("button", { name: "Back to conversations" }).click();
  // On a phone, one under way is a card of the list's deck.
  const rows = chat ? page.locator(".phone-row-wrap") : await openList(page);
  const row = rows.or(page.locator(".live-card")).filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  await platesIn(row);
  await expect.poll(() => wornIn(row)).toBe(look);
  if (!isPhone(page)) return;
  if (chat) await row.click();
  else await page.keyboard.press("Escape");
}

// The dot on screen, the line naming its dot and its row all wear one look.
async function oneLook(page: Page, title: string) {
  const line = page.locator(".thread-dot").last();
  const presence = page.locator(".presence-frame");
  await platesIn(line);
  await expect
    .poll(async () => {
      const [dot, said] = [await wornIn(presence), await wornIn(line)];
      return dot === said ? "one look" : `dot: ${dot}; line: ${said}`;
    })
    .toBe("one look");
  const look = await wornIn(line);
  await rowWears(page, title, look);
  await expect.poll(() => wornIn(presence)).toBe(look);
  return look;
}

for (const style of ["studio", "chat"] as const)
  test.describe(style, () => {
    test.use({ viewStyle: style });

    test("a task wears one look everywhere: after Auto, a switch and a reload", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("ready");
      const headers = { authorization: `Bearer ${"a".repeat(43)}` };
      await page.request.put(`${fixture.origin}/api/agent/settings`, {
        headers,
        data: await (await page.request.get(`${fixture.origin}/api/agent/settings`, { headers }))
          .json()
          .then((saved) => ({
            ...saved,
            persona: "everyday",
            accessory: "cap",
            autoPersona: true,
          })),
      });
      await page.waitForLoadState("networkidle");
      await page.reload();
      await page.request.post(`${fixture.origin}/__qa/first-look`, {
        data: { title: "A poster", persona: "design", reason: "A visual brief" },
      });
      const form = page.getByRole("form", { name: "Message dot" }).last();
      const box = form.getByRole("textbox", { name: /^(New task|Message)$/ });
      await expect(async () => {
        await box.fill("make a poster for the fair");
        await expect(box).toHaveValue("make a poster for the fair", { timeout: 500 });
      }).toPass();
      await form.getByRole("button", { name: /^(Start task|Send)$/ }).click();
      // The fixture names no current conversation for a phone's new one: it is opened from the list.
      if (style === "chat" && isPhone(page)) {
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.getByRole("button", { name: "Back to conversations" }).click();
        await page.locator(".phone-row-wrap").filter({ hasText: "A poster" }).click();
      }
      const line = page.locator(".thread-dot").last();
      await expect(line).toContainText("Auto chose Designer");
      const picked = await oneLook(page, "A poster");
      expect(picked.split(" ")).toContain("beret");
      expect(picked.split(" ")).not.toContain("cap");

      const coder = page.getByRole("menuitemradio", { name: "Coder" });
      await expect(async () => {
        if (!(await coder.isVisible())) await line.getByRole("button", { name: "Change" }).click();
        await coder.click({ timeout: 2_000 });
        await expect(page.locator(".thread-dot").last()).toContainText("You chose Coder", {
          timeout: 2_000,
        });
      }).toPass();
      const switched = await oneLook(page, "A poster");
      expect(switched.split(" ")).toContain("hoodie");
      for (const value of ["graphite", "daylight"]) {
        await appearance(page, value);
        await ui.settle();
        await page.screenshot({ path: test.info().outputPath(`one-look-${style}-${value}.png`) });
      }

      await page.waitForLoadState("networkidle");
      await page.reload();
      await expect(page.locator(".thread-dot").last()).toContainText("You chose Coder");
      expect(await oneLook(page, "A poster")).toBe(switched);
    });
  });
