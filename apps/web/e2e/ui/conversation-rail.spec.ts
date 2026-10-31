import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, FIXTURE_START, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c12", "c39", "w14", "w39");

const PANELS = "localdot.panels.v1";
// Two minutes before the page's clock, which stands at a minute past the fixture's start.
const SINCE = new Date(new Date(FIXTURE_START).getTime() - 60_000).toISOString();

// The fixture's conversations, with the daemon's word on four of them as the list carries it: one
// at work on the screen, one waiting on the user, one waiting for the computer and one paused. A
// name given through the rename route shows in the next read, as the daemon's would.
async function underWay(page: Page) {
  const names = new Map<string, string | null>();
  await page.route("**/api/conversations/*/title", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3] ?? "";
    names.set(id, route.request().postDataJSON().title);
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/conversations", async (route) => {
    // The rail reads the list every few seconds, so a read can outlast the fixture.
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    const { conversations } = await reply.json();
    const live = [
      undefined,
      { state: "working", onScreen: true, activity: "Comparing the 9:40 and 11:15 fares" },
      { state: "needs-you", onScreen: false },
      { state: "waiting-for-computer", onScreen: false },
      { state: "paused", onScreen: false },
    ];
    await route.fulfill({
      json: {
        conversations: conversations.map(
          (entry: { sessionId: string; title: string | null }, index: number) => ({
            ...entry,
            ...(names.has(entry.sessionId) ? { title: names.get(entry.sessionId) } : {}),
            ...(live[index] ? { ended: null, live: { ...live[index], since: SINCE } } : {}),
          }),
        ),
      },
    });
  });
  return names;
}

const expandedAtStart = (page: Page, expanded: boolean) =>
  page.addInitScript(
    ([key, value]) => localStorage.setItem(key, JSON.stringify({ sessions: value })),
    [PANELS, expanded] as const,
  );

const rail = (page: Page) => page.getByRole("navigation", { name: "Conversations" });
const rowNames = (page: Page) =>
  rail(page)
    .locator(".sessions-item > .sessions-row")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label")));

test("lists the conversations under way first, each with its status, and takes one up", async ({
  page,
  ui,
}) => {
  test.skip(isPhone(page), "A phone has no rail");
  await underWay(page);
  await expandedAtStart(page, true);
  await ui.open("conversations");
  await expect(rail(page).getByRole("button", { name: /^Clean up my Downloads/ })).toBeVisible();
  await expect.poll(() => rowNames(page)).toHaveLength(7);
  const names = await rowNames(page);
  expect(names.slice(0, 4)).toEqual([
    expect.stringMatching(/^Compare flights to Lisbon .*, working, on screen, 2 min$/),
    expect.stringMatching(/^Rename the holiday photos .*, needs you, 2 min$/),
    expect.stringMatching(/^Summarise the Q3 board deck.*, waiting for the computer, 2 min$/),
    expect.stringMatching(/^Find a plumber .*, paused, 2 min$/),
  ]);
  expect(names.slice(4)).toEqual([
    expect.stringMatching(/^Sample · monthly report, done, /),
    expect.stringMatching(/^Clean up my Downloads folder, done, /),
    expect.stringMatching(/^Draft a reply to the landlord .*, stopped, /),
  ]);
  await expect(rail(page).getByText("Comparing the 9:40 and 11:15 fares")).toBeVisible();
  const current = rail(page).locator("[aria-current='true']");
  await expect(current).toHaveAccessibleName(/^Sample · monthly report/);

  const chosen = rail(page).getByRole("button", { name: /^Clean up my Downloads/ });
  const continued = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/conversation/continue",
  );
  await chosen.click();
  await continued;
  await expect(chosen).toHaveAttribute("aria-current", "true");
  await expect(rail(page).locator("[aria-current='true']")).toHaveCount(1);
});

test("follows a conversation's state as the daemon pushes it on /api/events", async ({
  page,
  ui,
}) => {
  test.skip(isPhone(page), "A phone has no rail");
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/api\/events$/, (socket) => {
    socket.connectToServer();
    sockets.push(socket);
  });
  await expandedAtStart(page, true);
  await ui.open("conversations");
  const row = rail(page).getByRole("button", { name: /^Clean up my Downloads/ });
  await expect(row).toHaveAccessibleName(/^Clean up my Downloads folder, done, /);
  const sessionId = await row.evaluate((button) =>
    button.closest("[data-flip]")?.getAttribute("data-flip"),
  );
  const live = { state: "needs-you", since: SINCE, onScreen: false };
  for (const socket of sockets)
    socket.send(JSON.stringify({ type: "conversation.live", sessionId, live }));
  await expect(row).toHaveAccessibleName("Clean up my Downloads folder, needs you, 2 min");
  expect((await rowNames(page))[0]).toBe("Clean up my Downloads folder, needs you, 2 min");
});

test("collapses to its marks and expands with Mod+\\, keeps the choice and never covers the stage", async ({
  page,
  ui,
}) => {
  test.skip(isPhone(page), "A phone has no rail");
  await ui.open("conversations");
  const app = page.locator(".app");
  // Below a wide screen the rail starts collapsed, so the stage keeps its room.
  await expect(app).toHaveAttribute("data-sessions", "collapsed");
  await expect(rail(page).getByRole("button", { name: /^Clean up my Downloads/ })).toBeAttached();
  const edges = async () => {
    await ui.settle();
    const box = async (selector: string) => {
      const found = await page.locator(selector).first().boundingBox();
      if (!found) throw new Error(`Missing ${selector}`);
      return found;
    };
    const nav = await box(".sessions");
    return {
      rail: Math.round(nav.width),
      stage: Math.round((await box(".stage-frame")).x),
      bar: Math.round((await box(".app > .bar")).x),
    };
  };
  const collapsed = await edges();
  expect(collapsed.rail).toBe(56);
  expect(collapsed.bar).toBeGreaterThanOrEqual(collapsed.rail);
  expect(collapsed.stage).toBeGreaterThanOrEqual(collapsed.rail);

  await rail(page)
    .getByRole("button", { name: /^Sample/ })
    .focus();
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(app).toHaveAttribute("data-sessions", "expanded");
  await expect(rail(page).getByRole("button", { name: "Collapse conversations" })).toBeVisible();
  const expanded = await edges();
  expect(expanded.rail).toBe(256);
  expect(expanded.bar).toBeGreaterThanOrEqual(expanded.rail);
  expect(expanded.stage).toBeGreaterThanOrEqual(expanded.rail);

  await page.reload();
  await expect(app).toHaveAttribute("data-sessions", "expanded");
  await rail(page).getByRole("button", { name: "Collapse conversations" }).click();
  await expect(app).toHaveAttribute("data-sessions", "collapsed");
});

test("moves through the rows with the arrows and takes one up with Return", async ({
  page,
  ui,
}) => {
  test.skip(isPhone(page), "A phone has no rail");
  await underWay(page);
  await ui.open("conversations");
  const shown = rail(page).locator("[aria-current='true']");
  await expect(shown).toHaveAccessibleName(/^Sample/);
  await shown.focus();
  await page.keyboard.press("ArrowDown");
  const next = rail(page).getByRole("button", { name: /^Clean up my Downloads/ });
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute("tabindex", "0");
  await expect(shown).toHaveAttribute("tabindex", "-1");
  const continued = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/conversation/continue",
  );
  await page.keyboard.press("Enter");
  expect((await continued).postDataJSON()).toEqual({
    sessionId: await next.evaluate((row) => row.closest("[data-flip]")?.getAttribute("data-flip")),
  });
  await expect(next).toHaveAttribute("aria-current", "true");
});

test("renames a conversation from the keyboard and its menu", async ({ page, ui }) => {
  test.skip(isPhone(page), "A phone has no rail");
  const names = await underWay(page);
  await expandedAtStart(page, true);
  await ui.open("conversations");
  const row = rail(page).getByRole("button", { name: /^Clean up my Downloads/ });
  await row.focus();
  await page.keyboard.press("F2");
  const field = rail(page).getByRole("textbox", { name: "Conversation name" });
  await expect(field).toBeFocused();
  await field.fill("Downloads, tidied");
  await page.keyboard.press("Enter");
  const renamed = rail(page).getByRole("button", { name: /^Downloads, tidied, done/ });
  await expect(renamed).toBeFocused();
  expect([...names.values()]).toEqual(["Downloads, tidied"]);

  await renamed.hover();
  await rail(page).getByRole("button", { name: "Actions for Downloads, tidied" }).click();
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  await expect(field).toBeFocused();
  await field.fill("");
  await page.keyboard.press("Enter");
  await expect(rail(page).getByRole("button", { name: /^Clean up my Downloads/ })).toBeVisible();
  expect([...names.values()]).toEqual([null]);
});

test("a phone opens its conversations from the corner, those under way first", async ({
  page,
  ui,
}) => {
  test.skip(!isPhone(page), "Wider screens have the rail");
  await underWay(page);
  await ui.open("conversations");
  await expect(rail(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Conversations" });
  // Those under way are cards above the rest, the one waiting on the user first.
  const deck = sheet.getByRole("region", { name: /^Under way/ });
  expect(
    await deck
      .getByRole("button", { name: /, 2 min$/ })
      .evaluateAll((cards) => cards.map((card) => card.ariaLabel?.split(",").at(-2)?.trim())),
  ).toEqual(["needs you", "on screen", "waiting for the computer", "paused"]);
  await expect(deck.getByText("Comparing the 9:40 and 11:15 fares")).toBeVisible();
  const list = sheet.getByRole("grid", { name: "Recent conversations" });
  await expect(list.locator(".conversations-day").first()).toHaveText("Today");
  await expect(list.getByRole("row")).toHaveCount(3);
});

// The rail beside the stage at a laptop's width, a small laptop's and a phone's, in both
// appearances, collapsed and expanded, for the eye.
test("looks right collapsed and expanded, in Graphite and Midnight", async ({ page, ui }) => {
  test.skip(!["c14", "c39"].includes(test.info().project.name), "Shots at c14 and c39");
  await underWay(page);
  await ui.open("conversations");
  await ui.picture();
  const widths = isPhone(page) ? [390] : [1440, 1024];
  for (const width of widths) {
    if (!isPhone(page)) await page.setViewportSize({ width, height: 900 });
    for (const state of isPhone(page) ? ["sheet"] : ["collapsed", "expanded"]) {
      if (state === "sheet") {
        await page.getByRole("button", { name: "Conversations", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Conversations" })).toBeVisible();
      } else {
        const app = page.locator(".app");
        if ((await app.getAttribute("data-sessions")) !== state)
          await page.keyboard.press("ControlOrMeta+Backslash");
        await expect(app).toHaveAttribute("data-sessions", state);
        await expect(rail(page).getByRole("button", { name: /^Compare flights/ })).toBeVisible();
      }
      for (const appearance of ["graphite", "midnight"] as const) {
        await page.evaluate((value) => {
          document.documentElement.dataset.appearance = value;
        }, appearance);
        await ui.settle();
        await ui.still();
        await page.screenshot({
          path: test.info().outputPath(`rail-${width}-${state}-${appearance}.png`),
          animations: "disabled",
        });
      }
    }
  }
});
