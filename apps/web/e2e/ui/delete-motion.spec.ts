import type { Locator, Page } from "@playwright/test";
import { hostExport } from "../../src/testing/host-export.ts";
import { TOKEN, type UiFixture } from "../fixtures/start-ui-fixture.ts";
import { nestedKeys, openSettings } from "../settings-ui.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

// Rows leaving with real motion, frame by frame: a deleted conversation's dot bursts, its row goes and
// the list closes without a jump, in about half a second; several ripple and end within a second; a
// refused one never moves; reduced motion plays no burst.
runAt("c14", "w14", "c39", "w39");
test.use({ fixedClock: false, reducedMotion: "no-preference" });

const REFUSED = "Stop this conversation's task before deleting it.";
// What one deletion may take, burst to rest, and several; the frame reporting it adds a little.
const ONE_MS = 620;
const SEVERAL_MS = 1120;

interface Frame {
  t: number;
  // The burst's copies of dots and how many of its drops show.
  pops: number;
  drops: number;
  // The rows marked as leaving.
  gone: string[];
  // Where each row on show is and how much of it shows.
  rows: Record<string, { top: number; opacity: number }>;
  // What else is being watched, as recordFrames was asked.
  extra: { bottom: number; opacity: number } | null;
}

declare global {
  interface Window {
    motionFrames?: Frame[];
    motionWatching?: boolean;
  }
}

// Every frame from here on, as the page has it to paint. A row's place includes what moves it.
async function recordFrames(page: Page, watching?: string) {
  await page.evaluate((extra) => {
    const frames: Frame[] = [];
    window.motionFrames = frames;
    window.motionWatching = true;
    const shownOpacity = (element: Element) => {
      let opacity = 1;
      for (let at: Element | null = element; at; at = at.parentElement)
        opacity *= Number(getComputedStyle(at).opacity);
      return opacity;
    };
    const tick = () => {
      if (!window.motionWatching) return;
      const rows: Frame["rows"] = {};
      for (const row of document.querySelectorAll<HTMLElement>("[data-conversation]")) {
        if (!row.getClientRects().length) continue;
        rows[row.dataset.conversation ?? ""] = {
          top: row.getBoundingClientRect().top,
          opacity: shownOpacity(row),
        };
      }
      const other = extra ? document.querySelector(extra) : null;
      frames.push({
        t: performance.now(),
        pops: document.querySelectorAll(".dot-pop").length,
        drops: [...document.querySelectorAll(".dot-pop-bit")].filter(
          (drop) => Number(getComputedStyle(drop).opacity) > 0,
        ).length,
        gone: [...document.querySelectorAll<HTMLElement>("[data-conversation][data-leaving]")].map(
          (row) => row.dataset.conversation ?? "",
        ),
        rows,
        extra: other
          ? { bottom: other.getBoundingClientRect().bottom, opacity: shownOpacity(other) }
          : null,
      });
      requestAnimationFrame(tick);
    };
    tick();
  }, watching);
}

const stopFrames = (page: Page): Promise<Frame[]> =>
  page.evaluate(() => {
    window.motionWatching = false;
    return window.motionFrames ?? [];
  });

async function idOf(page: Page, fixture: UiFixture, title: RegExp): Promise<string> {
  const reply = await page.request.get(`${fixture.origin}/api/conversations`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const { conversations } = await reply.json();
  const found = conversations.find((each: { title: string }) => title.test(each.title));
  expect(found, `a conversation called ${title}`).toBeTruthy();
  return found.sessionId;
}

const sameTops = (frame: Frame, last: Frame) =>
  Object.entries(last.rows).every(
    ([id, row]) => Math.abs((frame.rows[id]?.top ?? Number.NaN) - row.top) < 0.5,
  );

// From the first frame anything plays to the first with nothing left moving.
function playing(frames: Frame[]): Frame[] {
  const start = frames.findIndex((frame) => frame.pops > 0 || frame.gone.length > 0);
  expect(start, "something plays").toBeGreaterThanOrEqual(0);
  const last = frames.at(-1) as Frame;
  let end = frames.length - 1;
  while (end > start) {
    const before = frames[end - 1] as Frame;
    if (before.pops > 0 || !sameTops(before, last)) break;
    end--;
  }
  return frames.slice(start, end + 1);
}

const span = (frames: Frame[]) => (frames.at(-1) as Frame).t - (frames[0] as Frame).t;

// No step bigger than a fast spring takes in the time it had, weighed by the frames it spans.
function expectNoJump(points: { t: number; top: number }[], name: string) {
  const travel = Math.abs(
    (points.at(-1) as { top: number }).top - (points[0] as { top: number }).top,
  );
  points.forEach((now, index) => {
    const before = points[index - 1];
    if (!before) return;
    const frameSpans = Math.max(1, Math.round((now.t - before.t) / (1000 / 60)));
    const at = Math.round(now.t - (points[0] as { t: number }).t);
    expect(Math.abs(now.top - before.top) / frameSpans, `${name} jumped at ${at} ms`).toBeLessThan(
      Math.max(2, travel * 0.34),
    );
  });
}

function expectClosedSmoothly(frames: Frame[], staying: readonly string[]) {
  for (const id of staying)
    expectNoJump(
      frames.flatMap((frame) => {
        const row = frame.rows[id];
        return row ? [{ t: frame.t, top: row.top }] : [];
      }),
      id,
    );
}

const rail = (page: Page) => page.getByRole("navigation", { name: "Conversations" });
const row = (list: Locator, id: string) => list.locator(`[data-conversation="${id}"]`);
const heard = (page: Page, text: string) =>
  expect(page.locator("[role='status'][aria-live='polite']").filter({ hasText: text })).toHaveCount(
    1,
  );
const expandedAtStart = (page: Page) =>
  page.addInitScript(() =>
    localStorage.setItem("localdot.panels.v1", JSON.stringify({ sessions: true })),
  );
const press = (page: Page, target: Locator) => (isPhone(page) ? target.tap() : target.click());

async function confirm(page: Page) {
  const remove = page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true });
  await expect(remove).toBeVisible();
  // Past the dialog's own entrance.
  await page.waitForTimeout(400);
  return remove;
}

async function fromMenuByHover(page: Page, target: Locator, item: string | RegExp) {
  await target.hover();
  await target.getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

// As a finger reaches a row's Actions, whose press it makes without moving the keyboard's focus. A
// held row's own preview has its specs.
async function fromMenuByFinger(page: Page, target: Locator, item: string | RegExp) {
  await target.getByRole("button", { name: /^Actions for/ }).dispatchEvent("click");
  await page
    .getByRole("menu", { name: "Conversation actions" })
    .getByRole("menuitem", { name: item })
    .tap();
}

// The rows after this one in its list.
const rowsAfter = (list: Locator, id: string) =>
  list.locator("[data-conversation]").evaluateAll((rows, gone) => {
    const ids = rows.map((each) => (each as HTMLElement).dataset.conversation ?? "");
    return ids.slice(ids.indexOf(gone as string) + 1);
  }, id);

// Presses Delete and sees one dot burst, in about half a second, and the rows below it close up.
async function expectBurst(page: Page, list: Locator, id: string, remove: Locator) {
  const below = await rowsAfter(list, id);
  expect(below.length).toBeGreaterThan(0);
  await recordFrames(page);
  await press(page, remove);
  await expect(row(list, id)).toHaveCount(0);
  await expect(page.locator(".dot-pop-layer")).toHaveCount(0);
  await page.waitForTimeout(300);
  const frames = playing(await stopFrames(page));
  expect(frames.some((frame) => frame.pops === 1 && frame.drops > 3)).toBe(true);
  expect(span(frames), "it finishes fast").toBeLessThan(ONE_MS);
  expect(span(frames)).toBeGreaterThan(300);
  expectClosedSmoothly(frames, below);
  await expect(page.getByRole("alertdialog")).toBeHidden();
  return below;
}

// Refuses `id`'s deletion as the daemon does while one of its tasks is under way.
const refuse = (page: Page, id: string) =>
  page.route(`**/api/conversations/${id}`, (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 409, body: "conversation is live" })
      : route.continue(),
  );

const fakeId = (n: number) => `01M4ECBR5X0R92SYA389${String(n).padStart(6, "0")}`;

// As if the daemon held `count` finished conversations, and let them be deleted.
async function longList(page: Page, count: number) {
  const gone = new Set<string>();
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const original = await route.fetch();
    const { conversations } = await original.json();
    const ended = conversations.find((each: { ended: string | null }) => each.ended === "done");
    await route.fulfill({
      json: {
        conversations: Array.from({ length: count }, (_, n) => ({
          ...ended,
          sessionId: fakeId(n),
          sessions: [fakeId(n)],
          title: `Conversation ${n}`,
        })).filter((each) => !gone.has(each.sessionId)),
      },
    });
  });
  await page.route("**/api/conversations/*", (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    gone.add(route.request().url().split("/").at(-1) ?? "");
    return route.fulfill({ status: 204 });
  });
}

test.describe("a phone's list", () => {
  test.use({ viewStyle: "chat", phoneList: true });
  test.beforeEach(({ page }) => {
    test.skip(!isPhone(page), "A phone's list");
  });

  test("the dot bursts, the row goes and the list closes without a jump", async ({ page, ui }) => {
    const fixture = await ui.open("conversations");
    const screen = page.getByRole("region", { name: "Conversations" });
    await expect(screen.getByRole("button", { name: /^Find a plumber/ })).toBeVisible();
    const id = await idOf(page, fixture, /^Find a plumber/);
    await fromMenuByFinger(page, row(screen, id), /Delete/);
    const below = await expectBurst(page, screen, id, await confirm(page));
    // The next row takes the focus, with no ring: a finger did this, not the keys.
    const next = row(screen, below[0] as string).locator(".phone-row");
    await expect(next).toBeFocused();
    expect(await next.evaluate((each) => each.matches(":focus-visible"))).toBe(false);
  });

  test("several ripple and all are done within a second", async ({ page, ui }) => {
    const fixture = await ui.open("conversations");
    const screen = page.getByRole("region", { name: "Conversations" });
    await expect(screen.getByRole("button", { name: /^Find a plumber/ })).toBeVisible();
    await screen
      .locator(".phone-list-bar")
      .getByRole("button", { name: "Select", exact: true })
      .tap();
    const titles = [/^Compare flights/, /^Find a plumber/, /^Rename the holiday/];
    for (const title of titles) await screen.getByRole("checkbox", { name: title }).tap();
    const ids = await Promise.all(titles.map((title) => idOf(page, fixture, title)));
    await screen.getByRole("button", { name: "Delete…" }).tap();
    const remove = await confirm(page);
    await recordFrames(page);
    await remove.tap();
    for (const id of ids) await expect(row(page.locator("body"), id)).toHaveCount(0);
    await expect(page.locator(".dot-pop-layer")).toHaveCount(0);
    await page.waitForTimeout(300);
    const frames = playing(await stopFrames(page));
    expect(Math.max(...frames.map((frame) => frame.pops))).toBe(3);
    expect(span(frames)).toBeLessThan(SEVERAL_MS);
    await heard(page, "Deleted 3 conversations.");
  });

  test("a refused deletion never moves", async ({ page, ui }) => {
    const fixture = await ui.open("conversations");
    const screen = page.getByRole("region", { name: "Conversations" });
    await expect(screen.getByRole("button", { name: /^Find a plumber/ })).toBeVisible();
    const id = await idOf(page, fixture, /^Find a plumber/);
    await refuse(page, id);
    await fromMenuByFinger(page, row(screen, id), /Delete/);
    const remove = await confirm(page);
    await recordFrames(page);
    await remove.tap();
    await expect(page.getByRole("alertdialog")).toContainText(REFUSED);
    await page.waitForTimeout(600);
    const frames = await stopFrames(page);
    expect(frames.every((frame) => frame.pops === 0 && frame.gone.length === 0)).toBe(true);
    await page.getByRole("button", { name: "Cancel" }).tap();
    await expect(row(screen, id)).toHaveCSS("opacity", "1");
    await expect(row(screen, id).locator(".dot-avatar")).toBeVisible();
  });

  test("pinned, its big dot bursts too and the pinned rail closes", async ({ page, ui }) => {
    const fixture = await ui.open("conversations");
    const screen = page.getByRole("region", { name: "Conversations" });
    await expect(screen.getByRole("button", { name: /^Find a plumber/ })).toBeVisible();
    const first = await idOf(page, fixture, /^Find a plumber/);
    const second = await idOf(page, fixture, /^Rename the holiday/);
    for (const id of [first, second]) await fromMenuByFinger(page, row(screen, id), "Pin to top");
    const pinned = screen.locator(".phone-rail");
    await expect(pinned.locator("[data-conversation]")).toHaveCount(2);
    await page.waitForTimeout(600);
    await row(pinned, first).locator("button").focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: /Delete/ }).tap();
    const remove = await confirm(page);
    await recordFrames(page);
    await remove.tap();
    await expect(row(pinned, first)).toHaveCount(0);
    await expect(page.locator(".dot-pop-layer")).toHaveCount(0);
    const frames = await stopFrames(page);
    expect(Math.max(...frames.map((frame) => frame.pops))).toBe(1);
  });
});

test.describe("Studio's sheet on a phone", () => {
  test.beforeEach(({ page }) => {
    test.skip(!isPhone(page), "A phone's sheet");
  });

  test("the dot bursts over the sheet and the rows close up", async ({ page, ui }) => {
    const fixture = await ui.open("conversations");
    await page.getByRole("button", { name: "Conversations", exact: true }).tap();
    const sheet = page.getByRole("dialog", { name: "Conversations" });
    const id = await idOf(page, fixture, /^Rename the holiday/);
    await expect(row(sheet, id)).toBeVisible();
    await page.waitForTimeout(600);
    await fromMenuByFinger(page, row(sheet, id), /Delete/);
    await expectBurst(page, sheet, id, await confirm(page));
  });
});

test.describe("Studio's popover", () => {
  test.beforeEach(({ page }) => {
    test.skip(isPhone(page), "On a wider screen");
  });

  test("the dot bursts and the rows glide up in a popover that keeps its size", async ({
    page,
    ui,
  }) => {
    await longList(page, 5);
    await ui.open("conversations");
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    const popover = page.getByRole("dialog", { name: "Conversations" });
    const id = fakeId(1);
    await expect(row(popover, id)).toBeVisible();
    await page.waitForTimeout(500);
    await fromMenuByHover(page, row(popover, id), /Delete/);
    const remove = await confirm(page);
    const below = await rowsAfter(popover, id);
    await recordFrames(page, ".ui-popover");
    await remove.click();
    await expect(row(popover, id)).toHaveCount(0);
    await expect(page.locator(".dot-pop-layer")).toHaveCount(0);
    await page.waitForTimeout(300);
    const frames = playing(await stopFrames(page));
    expect(span(frames)).toBeLessThan(ONE_MS);
    expectClosedSmoothly(frames, below);
    const edges = frames.flatMap((frame) => frame.extra?.bottom ?? []);
    expect(Math.max(...edges) - Math.min(...edges)).toBeLessThan(1);
    // Where a field keeps the arrows, the keys go to the next row's menu, as they had this one's.
    await expect(row(popover, below[0] as string).locator(".conversations-more")).toBeFocused();
    await expect(popover).toBeVisible();
  });
});

test.describe("Studio's rail", () => {
  test.beforeEach(({ page }) => {
    test.skip(isPhone(page), "On a wider screen");
  });

  test("the dot bursts, the row goes, the list closes without a jump, and focus lands beside it", async ({
    page,
    ui,
  }) => {
    await expandedAtStart(page);
    const fixture = await ui.open("conversations");
    const list = rail(page);
    await expect(list.getByRole("button", { name: /^Find a plumber/ })).toBeVisible();
    const id = await idOf(page, fixture, /^Find a plumber/);
    await fromMenuByHover(page, row(list, id), /Delete/);
    const below = await expectBurst(page, list, id, await confirm(page));
    // The row after it takes the keys, and the announcement still comes.
    await expect(row(list, below[0] as string).locator(".sessions-row")).toBeFocused();
    await heard(page, "Deleted 1 conversation.");
  });

  test("forty at once: a ripple over those on show, done within a second", async ({ page, ui }) => {
    await expandedAtStart(page);
    await longList(page, 40);
    await ui.open("conversations");
    const list = rail(page);
    await expect(row(list, fakeId(0))).toBeVisible();
    await list.getByRole("button", { name: "Select", exact: true }).click();
    await list.getByRole("checkbox", { name: "Select all" }).check();
    await list.getByRole("button", { name: "Delete…" }).click();
    const remove = await confirm(page);
    await recordFrames(page);
    await remove.click();
    await expect(page.locator("[data-conversation]")).toHaveCount(0);
    await expect(page.locator(".dot-pop-layer")).toHaveCount(0);
    await page.waitForTimeout(200);
    const frames = playing(await stopFrames(page));
    const most = Math.max(...frames.map((frame) => frame.pops));
    expect(most).toBeGreaterThan(5);
    expect(most).toBeLessThanOrEqual(20);
    expect(span(frames)).toBeLessThan(SEVERAL_MS);
    // A ripple: those further down are still whole after the first has gone.
    const midway = frames.find((frame) => (frame.rows[fakeId(0)]?.opacity ?? 1) < 0.05) as Frame;
    expect(midway.rows[fakeId(9)]?.opacity ?? 0).toBeGreaterThan(0.5);
    // Keys land on what is left, not on the page.
    await expect(list.getByRole("button", { name: "New conversation" })).toBeFocused();
  });

  test("a refused deletion never moves: the row stays whole and the confirmation says why", async ({
    page,
    ui,
  }) => {
    await expandedAtStart(page);
    const fixture = await ui.open("conversations");
    const list = rail(page);
    await expect(list.getByRole("button", { name: /^Find a plumber/ })).toBeVisible();
    const id = await idOf(page, fixture, /^Find a plumber/);
    await refuse(page, id);
    await fromMenuByHover(page, row(list, id), /Delete/);
    const remove = await confirm(page);
    await recordFrames(page);
    await remove.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(REFUSED);
    await page.waitForTimeout(700);
    const frames = await stopFrames(page);
    expect(frames.every((frame) => frame.pops === 0 && frame.gone.length === 0)).toBe(true);
    expect(new Set(frames.map((frame) => frame.rows[id]?.top)).size).toBe(1);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(row(list, id)).toHaveCSS("opacity", "1");
    await expect(row(list, id)).not.toHaveAttribute("inert");
    await expect(row(list, id).locator(".dot-avatar")).toBeVisible();
  });

  test("some refused: those gone burst, the rest stay chosen and the confirmation says so", async ({
    page,
    ui,
  }) => {
    await expandedAtStart(page);
    const fixture = await ui.open("conversations");
    const list = rail(page);
    await expect(list.getByRole("button", { name: /^Find a plumber/ })).toBeVisible();
    const kept = await idOf(page, fixture, /^Find a plumber/);
    const lost = await idOf(page, fixture, /^Rename the holiday/);
    await refuse(page, kept);
    await list.getByRole("button", { name: "Select", exact: true }).click();
    await list.getByRole("checkbox", { name: /^Find a plumber/ }).click();
    await list.getByRole("checkbox", { name: /^Rename the holiday/ }).click();
    await list.getByRole("button", { name: "Delete…" }).click();
    const remove = await confirm(page);
    await recordFrames(page);
    await remove.click();
    await expect(page.getByRole("alertdialog")).toContainText("has a task under way");
    await expect(row(list, lost)).toHaveCount(0);
    await expect(page.locator(".dot-pop-layer")).toHaveCount(0);
    const frames = await stopFrames(page);
    expect(Math.max(...frames.map((frame) => frame.pops))).toBe(1);
    expect(frames.every((frame) => !frame.gone.includes(kept))).toBe(true);
    await expect(row(list, kept)).toHaveCSS("opacity", "1");
    await expect(list.getByRole("checkbox", { name: /^Find a plumber/ })).toBeChecked();
  });

  test("at the end of a long list, what the scroller gives back moves smoothly too", async ({
    page,
    ui,
  }) => {
    await expandedAtStart(page);
    await longList(page, 40);
    await ui.open("conversations");
    const list = rail(page);
    const last = row(list, fakeId(39));
    await expect(row(list, fakeId(0))).toBeVisible();
    const toTheEnd = () =>
      list.locator(".sessions-scroll").evaluate((scroller) => {
        scroller.scrollTop = scroller.scrollHeight;
      });
    await toTheEnd();
    await fromMenuByHover(page, last, /Delete/);
    const remove = await confirm(page);
    await toTheEnd();
    await recordFrames(page);
    await remove.click();
    await expect(last).toHaveCount(0);
    await expect(page.locator(".dot-pop-layer")).toHaveCount(0);
    await page.waitForTimeout(300);
    const frames = playing(await stopFrames(page));
    expectClosedSmoothly(frames, [fakeId(38), fakeId(37), fakeId(36)]);
    const moved =
      ((frames.at(-1) as Frame).rows[fakeId(38)]?.top ?? 0) -
      ((frames[0] as Frame).rows[fakeId(38)]?.top ?? 0);
    expect(moved, "the scroller gave back a row").toBeGreaterThan(30);
  });

  test("archiving fades the row and closes the list, with no burst", async ({ page, ui }) => {
    await expandedAtStart(page);
    const fixture = await ui.open("conversations");
    const list = rail(page);
    await expect(list.getByRole("button", { name: /^Find a plumber/ })).toBeVisible();
    const id = await idOf(page, fixture, /^Find a plumber/);
    const below = await rowsAfter(list, id);
    await row(list, id).hover();
    await row(list, id)
      .getByRole("button", { name: /^Actions for/ })
      .click();
    const archive = page.getByRole("menuitem", { name: "Archive" });
    await recordFrames(page);
    await archive.click();
    await expect(row(list, id)).toHaveCount(0);
    await page.waitForTimeout(450);
    const frames = await stopFrames(page);
    expect(frames.every((frame) => frame.pops === 0)).toBe(true);
    const faded = frames.flatMap((frame) => frame.rows[id]?.opacity ?? []);
    expect(faded.some((opacity) => opacity > 0.05 && opacity < 0.95)).toBe(true);
    expectClosedSmoothly(frames, below);
  });

  test("the last of a group takes its heading with it", async ({ page, ui }) => {
    await expandedAtStart(page);
    const fixture = await ui.open("conversations");
    const list = rail(page);
    await expect(list.getByRole("button", { name: /^Find a plumber/ })).toBeVisible();
    const id = await idOf(page, fixture, /^Find a plumber/);
    await fromMenuByHover(page, row(list, id), "Pin to top");
    await expect(list.getByRole("list", { name: "Pinned" })).toContainText("Find a plumber");
    await page.waitForTimeout(600);
    await fromMenuByHover(page, row(list, id), /Delete/);
    const remove = await confirm(page);
    await recordFrames(page, ".sessions-group-label");
    await remove.click();
    await expect(list.locator(".sessions-group-label", { hasText: "Pinned" })).toHaveCount(0);
    const frames = await stopFrames(page);
    const fading = frames.flatMap((frame) => frame.extra?.opacity ?? []);
    expect(fading.some((opacity) => opacity > 0.05 && opacity < 0.95)).toBe(true);
  });
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("nothing bursts or bounces: the row only fades, and quickly", async ({ page, ui }) => {
    test.skip(isPhone(page), "One list says it; a phone's goes the same way");
    await expandedAtStart(page);
    const fixture = await ui.open("conversations");
    const list = rail(page);
    await expect(list.getByRole("button", { name: /^Find a plumber/ })).toBeVisible();
    const id = await idOf(page, fixture, /^Find a plumber/);
    const next = (await rowsAfter(list, id))[0] as string;
    await fromMenuByHover(page, row(list, id), /Delete/);
    const remove = await confirm(page);
    await recordFrames(page);
    await remove.click();
    await expect(row(list, id)).toHaveCount(0);
    await page.waitForTimeout(200);
    const frames = await stopFrames(page);
    expect(frames.every((frame) => frame.pops === 0 && frame.drops === 0)).toBe(true);
    const going = frames.filter((frame) => frame.gone.includes(id));
    expect(going.length).toBeGreaterThan(0);
    expect(span(going)).toBeLessThan(260);
    // What stays takes its new place at once, rather than gliding.
    const after = frames.slice(frames.indexOf(going.at(-1) as Frame) + 1);
    expect(new Set(after.map((frame) => frame.rows[next]?.top)).size).toBeLessThanOrEqual(2);
  });
});

test.describe("short lists", () => {
  // Starts watching how tall it is, frame by frame, until it has gone.
  const heightsOf = (item: Locator) =>
    item.evaluate(
      (each) =>
        new Promise<{ t: number; top: number }[]>((resolve) => {
          const seen: { t: number; top: number }[] = [];
          const tick = () => {
            if (!each.isConnected || seen.length > 600) resolve(seen);
            else {
              seen.push({ t: performance.now(), top: each.getBoundingClientRect().height });
              requestAnimationFrame(tick);
            }
          };
          tick();
        }),
    );
  const expectFolded = (heights: { t: number; top: number }[]) => {
    const whole = (heights[0] as { top: number }).top;
    expect(whole).toBeGreaterThan(20);
    expect(heights.some(({ top }) => top > 1 && top < whole - 1)).toBe(true);
    expectNoJump(heights, "the row's height");
  };

  test("a saved login folds away and the keys go to the one beside it", async ({ page, ui }) => {
    const fixture = await ui.open("ready");
    expect((await page.request.post(`${fixture.origin}/__qa/logins`)).ok()).toBe(true);
    await ui.picture();
    if (isPhone(page)) {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Keys", exact: true }).click();
    } else await page.getByTestId("keys-button").click();
    const sheet = nestedKeys(page);
    await expect(sheet.getByRole("heading", { name: "Saved logins" })).toBeVisible();
    const list = sheet.getByRole("list", { name: "Saved logins" });
    const item = list.locator(".keys-row", { hasText: "github.com" });
    const beside = list.locator(".keys-row", { hasNotText: "github.com" }).first();
    await expect(item).toBeVisible();
    // From the keys: a press with a mouse leaves WebKit's focus outside the row.
    await sheet.getByRole("button", { name: "Remove login for github.com" }).focus();
    await page.keyboard.press("Enter");
    const armed = sheet.getByRole("button", { name: "Confirm remove login for github.com" });
    await armed.focus();
    const heights = heightsOf(item);
    await page.keyboard.press("Enter");
    expectFolded(await heights);
    await expect(item).toHaveCount(0);
    await expect(beside.getByRole("button").first()).toBeFocused();
  });

  test("a routine folds away once it is deleted, and one that wasn't stays", async ({
    page,
    ui,
  }) => {
    const fixture = await ui.open("first-run");
    expect((await page.request.post(`${fixture.origin}/__qa/routine/runs`)).ok()).toBe(true);
    if (isPhone(page)) {
      await page.getByRole("button", { name: "More", exact: true }).last().tap();
      await page.getByRole("menuitem", { name: "Routines" }).tap();
    } else await page.getByRole("radio", { name: "Routines" }).click();
    const item = page.locator(".routine-row", { hasText: "Morning bills" });
    await expect(item).toBeVisible();
    const ask = async () => {
      if (!isPhone(page)) await item.hover();
      await press(page, item.getByRole("button", { name: /^More for/ }));
      await press(page, page.getByRole("menuitem", { name: "Delete…" }));
    };
    let refusing = true;
    await page.route("**/api/routines/*", (route) =>
      refusing && route.request().method() === "DELETE"
        ? route.fulfill({ status: 500, body: "no" })
        : route.continue(),
    );
    await ask();
    await press(page, page.getByRole("alertdialog").getByRole("button", { name: /^Delete/ }));
    await expect(page.locator(".routines-problem")).toBeVisible();
    await expect(item).toHaveCSS("opacity", "1");
    await expect(item).not.toHaveAttribute("inert");
    refusing = false;
    await ask();
    const heights = heightsOf(item);
    await press(page, page.getByRole("alertdialog").getByRole("button", { name: /^Delete/ }));
    expectFolded(await heights);
    await expect(item).toHaveCount(0);
  });

  test("an exported video folds away once it is removed", async ({ page, ui }) => {
    const fake = hostExport({ phase: "done", name: "demo.mp4", bytes: 1000 });
    const other = hostExport({ phase: "done", name: "other.mp4", bytes: 1000 });
    let exports = [fake, { ...other, id: fakeId(1) }];
    await page.routeWebSocket("**/api/exports/stream", () => {});
    await page.route("**/api/exports", (route) =>
      route.fulfill({
        json: { host: { state: "ready", maxPixels: { mp4: 2000000, webm: 2000000 } }, exports },
      }),
    );
    await page.route("**/api/exports/*", (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      exports = exports.filter((each) => !route.request().url().endsWith(each.id));
      return route.fulfill({ status: 204 });
    });
    await ui.open("done", () => "/?replay=library");
    const item = page.locator(".export-row", { hasText: "demo.mp4" });
    await expect(item).toBeVisible();
    await expect(page.locator(".export-row", { hasText: "other.mp4" })).toBeVisible();
    test.skip(isPhone(page), "A phone swipes a row away, and that face has its own spec");
    const heights = heightsOf(item);
    await item.hover();
    await item.getByRole("button", { name: "Remove demo.mp4" }).click();
    expectFolded(await heights);
    await expect(item).toHaveCount(0);
  });

  test("a model folds away from its group", async ({ page, ui }) => {
    const { origin } = await ui.open("ready");
    await page.request.post(`${origin}/__qa/own-endpoint`);
    const settings = await openSettings(page, undefined, "Models");
    const section = settings.getByRole("region", { name: "Your models" });
    await press(page, section.getByRole("button", { name: "Add models" }));
    const sheet = page.getByRole("dialog", { name: "Add models" });
    await press(page, sheet.getByRole("combobox", { name: "From" }));
    await press(page, page.getByRole("option", { name: /relay\.example/ }));
    await press(page, sheet.getByText("gpt-6.1-terra", { exact: true }));
    await sheet.getByLabel("Add by ID").fill("gpt-6-luna-new");
    await sheet.getByLabel("Input price").fill("1");
    await sheet.getByLabel("Output price").fill("2");
    await press(page, sheet.getByRole("button", { name: "Add 2 models", exact: true }));
    await expect(sheet).toBeHidden();
    const item = section.locator(".settings-model-row", { hasText: "gpt-6-luna-new" });
    await expect(item).toBeVisible();
    await press(page, item.getByRole("button", { name: /^More for/ }));
    const heights = heightsOf(item);
    await press(page, page.getByRole("menuitem", { name: "Remove" }));
    expectFolded(await heights);
    await expect(item).toHaveCount(0);
  });
});
