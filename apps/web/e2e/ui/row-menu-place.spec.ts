import type { Locator, Page } from "@playwright/test";
import { expect, isPhone, runAt, test } from "./harness.ts";

// A conversation's menu is attached to its row: beside the list, against its edge and level with
// the row, however it is opened (a right click, More, or the menu key), with the list scrolled;
// where there is no room beside the list it flips to the other side, and on a phone it goes under
// or over the row. A hold on a phone still lifts the row into its preview (lift-motion).
runAt("c14", "c39", "w14", "w39");

const GAP = 8;
const id = (n: number) => `01M4ECBR5X0R92SYA389${String(n).padStart(6, "0")}`;

// Thirty more conversations, so every list scrolls.
async function many(page: Page) {
  await page.route("**/api/conversations", async (route) => {
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    const { conversations, archivedCount } = await reply.json();
    const last = conversations.at(-1);
    const more = Array.from({ length: 30 }, (_, n) => ({
      ...last,
      sessionId: id(n),
      sessions: [id(n)],
      title: `Older conversation ${n}`,
      pinned: false,
      tag: undefined,
    }));
    await route.fulfill({ json: { archivedCount, conversations: [...conversations, ...more] } });
  });
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
}

const menu = (page: Page) => page.getByRole("menu", { name: "Conversation actions" });

// Opens the menu by `how`, reads where it and `row` stand once placed, and closes it again.
async function placed(page: Page, row: Locator, how: () => Promise<void>) {
  await how();
  await expect(menu(page)).toBeVisible();
  await page.waitForTimeout(300);
  const at = await box(menu(page));
  const level = await box(row);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  return { ...at, row: level };
}

// Beside the list on its right, or flipped to its left, with its top level with the row's unless
// that would take it past the screen's bottom edge.
function besideList(at: Box & { row: Box }, list: Box, page: Page, flipped = false) {
  const row = at.row;
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport");
  if (flipped) expect(at.x + at.width).toBeCloseTo(list.x - GAP, 0);
  else expect(at.x).toBeCloseTo(list.x + list.width + GAP, 0);
  const top = Math.min(row.y, viewport.height - GAP - at.height);
  expect(at.y).toBeCloseTo(top, 0);
  expect(at.y + at.height).toBeLessThanOrEqual(viewport.height - GAP + 1);
}

const same = (a: Box, b: Box) => {
  for (const key of ["x", "y", "width", "height"] as const) expect(a[key]).toBeCloseTo(b[key], 0);
};

test.describe("Chat", () => {
  test.use({ viewStyle: "chat", phoneList: true });

  test("a row's menu stands beside the list, level with the row, however it is opened", async ({
    page,
    ui,
  }) => {
    await many(page);
    await ui.open("conversations");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    const scroller = page.locator(".phone-list-scroll");
    await expect(page.locator(`[data-conversation="${id(12)}"]`)).toBeAttached();
    await scroller.evaluate((element) => {
      element.scrollTop = 700;
    });
    const wrap = page.locator(`.phone-list [data-conversation="${id(6)}"]`).first();
    const row = wrap.locator(".phone-row");
    await expect(row).toBeInViewport();
    const list = await box(page.locator(".phone-list-screen").first());
    expect((await box(wrap)).y).toBeLessThan(700);

    const byKeys = await placed(page, wrap, async () => {
      await row.focus();
      await page.keyboard.press("Shift+F10");
    });
    const byMore = await placed(page, wrap, async () => {
      await wrap.locator(".phone-row-actions").focus();
      await page.keyboard.press("Enter");
    });
    if (isPhone(page)) {
      // No room beside a phone's list: under the row, or over it, on the screen.
      const at = byKeys.row;
      expect(byKeys.x).toBeGreaterThanOrEqual(GAP - 1);
      expect(byKeys.x + byKeys.width).toBeLessThanOrEqual(list.width - GAP + 1);
      const under = byKeys.y >= at.y + at.height;
      const over = byKeys.y + byKeys.height <= at.y;
      expect(under || over).toBe(true);
      same(byMore, byKeys);
      await row.focus();
      await page.keyboard.press("Shift+F10");
      await page.waitForTimeout(300);
      await page.screenshot({ path: test.info().outputPath("phone-keys.png") });
      return;
    }
    besideList(byKeys, list, page);
    same(byMore, byKeys);
    const byClick = await placed(page, wrap, () => row.click({ button: "right" }));
    same(byClick, byKeys);
    // No preview lifts beside the conversation: the right click opens the menu itself.
    await expect(page.locator(".peek-card")).toHaveCount(0);

    // A row near the screen's foot keeps its menu on screen, as close to level as it can.
    const low = page.locator(`.phone-list [data-conversation="${id(13)}"]`).first();
    await expect(low).toBeInViewport();
    const lowMenu = await placed(page, low, () =>
      low.locator(".phone-row").click({ button: "right" }),
    );
    expect(lowMenu.y).toBeLessThan(lowMenu.row.y);
    besideList(lowMenu, list, page);
    await low.locator(".phone-row").click({ button: "right" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: test.info().outputPath("beside-list.png") });
  });
});

test.describe("Studio", () => {
  test.beforeEach(({ page }) => {
    test.skip(isPhone(page), "A phone's conversations are a sheet");
  });

  test("the rail's menu stands beside the rail, level with the row, expanded or collapsed", async ({
    page,
    ui,
  }) => {
    await many(page);
    await ui.open("conversations");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    await page.mouse.move(800, 500);
    await page.keyboard.press("ControlOrMeta+Backslash");
    await expect(page.locator(".app")).toHaveAttribute("data-sessions", "expanded");
    const rail = page.locator("nav.sessions");
    await expect.poll(async () => (await box(rail)).width).toBeGreaterThan(200);
    await page.waitForTimeout(500);
    await page.locator(".sessions-scroll").evaluate((element) => {
      element.scrollTop = 500;
    });
    const item = page.locator(`.sessions-item[data-flip="${id(12)}"]`).first();
    const row = item.locator(".sessions-row");
    await expect(row).toBeInViewport();
    const list = await box(rail);

    const byClick = await placed(page, item, () => row.click({ button: "right" }));
    besideList(byClick, list, page);
    const byKeys = await placed(page, item, async () => {
      await row.focus();
      await page.keyboard.press("Shift+F10");
    });
    same(byKeys, byClick);
    const byMore = await placed(page, item, async () => {
      await row.hover();
      await item.locator(".sessions-more").click();
    });
    same(byMore, byClick);
    await row.click({ button: "right" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: test.info().outputPath("rail-expanded.png") });
    await page.keyboard.press("Escape");

    // Collapsed to its marks, the menu stands beside the narrow rail.
    await page.mouse.move(800, 500);
    await page.keyboard.press("ControlOrMeta+Backslash");
    await expect(page.locator(".app")).not.toHaveAttribute("data-sessions", "expanded");
    await expect.poll(async () => (await box(rail)).width).toBeLessThan(100);
    await page.waitForTimeout(500);
    const mark = page.locator(".sessions-item").nth(4);
    const byMark = await placed(page, mark, async () => {
      await mark.locator(".sessions-row").focus();
      await page.keyboard.press("Shift+F10");
    });
    besideList(byMark, await box(rail), page);
  });

  test("the conversations popover's menu flips to the popover's free side, level with the row", async ({
    page,
    ui,
  }) => {
    await many(page);
    await ui.open("conversations");
    await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    const popover = page.locator(".ui-popover").filter({ has: page.locator(".conversations") });
    await expect(popover).toBeVisible();
    await page.locator(".ui-popover .conversations-body").evaluate((element) => {
      element.scrollTop = 400;
    });
    const row = page.locator(`.ui-popover .conversations-row[id$="${id(8)}"]`).first();
    await expect(row).toBeInViewport();
    const list = await box(popover);

    const byClick = await placed(page, row, () => row.click({ button: "right" }));
    besideList(byClick, list, page, true);
    const byMore = await placed(page, row, async () => {
      await row.hover();
      await row.getByRole("button", { name: /^Actions for/ }).click();
    });
    same(byMore, byClick);
    await row.click({ button: "right" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: test.info().outputPath("popover.png") });
  });
});

test("on a phone, Studio's sheet hangs a row's menu from the row, by its More", async ({
  page,
  ui,
}) => {
  test.skip(!isPhone(page), "The phone's sheet");
  await many(page);
  await ui.open("conversations");
  const sheet = page.getByRole("dialog", { name: "Conversations" });
  await expect(async () => {
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    await expect(sheet).toBeVisible({ timeout: 2000 });
  }).toPass();
  await page.waitForTimeout(600);
  await sheet.locator(".conversations-body").evaluate((element) => {
    element.scrollTop = 400;
  });
  const row = sheet.locator(`.conversations-row[id$="${id(5)}"]`).first();
  await expect(row).toBeInViewport();
  const more = await box(row.getByRole("button", { name: /^Actions for/ }));
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport");
  const found = await placed(page, row, () =>
    row.getByRole("button", { name: /^Actions for/ }).click(),
  );
  const at = found.row;
  const under = found.y >= at.y + at.height;
  const over = found.y + found.height <= at.y;
  expect(under || over).toBe(true);
  expect(found.x + found.width).toBeCloseTo(Math.min(viewport.width - GAP, at.x + at.width), 0);
  expect(found.x + found.width).toBeGreaterThanOrEqual(more.x + more.width - GAP);
  await row.getByRole("button", { name: /^Actions for/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath("sheet-more.png") });
});
