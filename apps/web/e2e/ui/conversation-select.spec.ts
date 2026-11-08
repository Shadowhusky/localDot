import type { Locator, Page } from "@playwright/test";
import { TOKEN, type UiFixture } from "../fixtures/start-ui-fixture.ts";
import { wearAppearance } from "./contrast.ts";
import { expect, finger, type Harness, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "w14", "c39", "w39");

const RUNNING = "One of these has a task under way. Stop it or unselect it before deleting.";

const expandedAtStart = (page: Page) =>
  page.addInitScript(() =>
    localStorage.setItem("localdot.panels.v1", JSON.stringify({ sessions: true })),
  );
const rail = (page: Page) => page.getByRole("navigation", { name: "Conversations" });
const ticked = (scope: Locator) => scope.locator("[role='checkbox'][aria-checked='true']");
const heard = (page: Page, text: string) =>
  expect(page.locator("[role='status'][aria-live='polite']").filter({ hasText: text })).toHaveCount(
    1,
  );

// The daemon's own list, by title.
async function listed(page: Page, fixture: UiFixture): Promise<string[]> {
  const reply = await page.request.get(`${fixture.origin}/api/conversations`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const { conversations } = await reply.json();
  return conversations.map((each: { title: string | null }) => each.title ?? "");
}

// Every tick stands in one column with Select all's box when it has one, level with its row's title
// (or the row's middle, where the title is one of two lines), and the bar's count and actions share
// one middle line.
async function aligned(page: Page, rows: string, level: string | null, bar: string) {
  const found = await page.evaluate(
    ([rowsAt, levelAt, barAt]) => {
      const middle = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      const ticks = [...document.querySelectorAll(`${rowsAt} .ui-checkbox`)].map((tick) => {
        const row = tick.closest("[data-flip], [role='row'], li, label");
        const line = (levelAt && row?.querySelector(levelAt)) || row;
        return { tick: middle(tick), line: line ? middle(line).y : Number.NaN };
      });
      const tools = [...document.querySelectorAll(`${barAt} :is(.conversations-chosen, button)`)];
      return {
        ticks: ticks.length,
        columns: ticks.map(({ tick }) => tick.x),
        offLine: ticks.map(({ tick, line }) => Math.abs(tick.y - line)),
        bar: tools.map((tool) => middle(tool).y),
      };
    },
    [rows, level, bar] as const,
  );
  expect(found.ticks).toBeGreaterThan(1);
  expect(Math.max(...found.columns) - Math.min(...found.columns)).toBeLessThanOrEqual(1);
  for (const off of found.offLine) expect(off).toBeLessThanOrEqual(1);
  expect(found.bar.length).toBeGreaterThan(1);
  expect(Math.max(...found.bar) - Math.min(...found.bar)).toBeLessThanOrEqual(1);
}

// Until `target` has stopped moving, as a sheet coming up carries it.
async function resting(target: Locator) {
  let last = "";
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await target.boundingBox());
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [100] },
    )
    .toBe(true);
}

async function shoot(page: Page, ui: Harness, name: string) {
  for (const appearance of ["graphite", "daylight"] as const) {
    await wearAppearance(page, appearance);
    await ui.settle();
    await ui.still();
    await page.screenshot({
      path: test.info().outputPath(`${name}-${appearance}.png`),
      animations: "disabled",
    });
  }
  await wearAppearance(page, "graphite");
}

test.describe("Studio", () => {
  test.beforeEach(({ page }) => {
    test.skip(isPhone(page), "The rail and the popover are Studio's on a wider screen");
  });

  test("selects several in the rail by click, range and keys, all of them, and lets them go", async ({
    page,
    ui,
  }) => {
    await expandedAtStart(page);
    await ui.open("conversations");
    const list = rail(page);
    await expect(list.getByRole("button", { name: /^Draft a reply/ })).toBeVisible();
    await list.getByRole("button", { name: "Select", exact: true }).click();
    const boxes = list.getByRole("checkbox", { name: /, / });
    await expect(boxes).toHaveCount(7);
    await expect(list.getByRole("button", { name: "New conversation" })).toHaveCount(0);

    await list.getByRole("checkbox", { name: /^Compare flights/ }).click();
    await list.getByRole("checkbox", { name: /^Find a plumber/ }).click();
    await list.getByRole("checkbox", { name: /^Draft a reply/ }).click({ modifiers: ["Shift"] });
    await expect(ticked(list)).toHaveCount(4);
    await expect(list.getByText("4 selected")).toBeVisible();
    await heard(page, "4 selected");

    // The keys: Space ticks the row with the focus and the arrows move between them.
    await list.getByRole("checkbox", { name: /^Rename the holiday/ }).focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await expect(list.getByRole("checkbox", { name: /^Summarise the Q3/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(ticked(list)).toHaveCount(6);
    await aligned(page, ".sessions", ".sessions-title", ".sessions-actions");
    await shoot(page, ui, "rail-selecting");

    const all = list.getByRole("checkbox", { name: "Select all" });
    await all.check();
    await expect(ticked(list)).toHaveCount(7);
    await all.uncheck();
    await expect(ticked(list)).toHaveCount(0);
    await expect(list.getByText("None selected")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(list.getByRole("checkbox")).toHaveCount(0);
    await expect(list.getByRole("button", { name: "Select", exact: true })).toBeVisible();

    // Cmd or Ctrl on a row starts selecting with it, rather than opening it.
    await list
      .getByRole("button", { name: /^Clean up my Downloads/ })
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(ticked(list)).toHaveAccessibleName(/^Clean up my Downloads/);
    await list.getByRole("button", { name: "Cancel" }).click();
    await expect(list.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Conversation history" })).not.toContainText(
      "Also empty the bin",
    );
  });

  test("deletes the chosen after one confirmation and lands on a new conversation when the open one goes", async ({
    page,
    ui,
  }) => {
    await expandedAtStart(page);
    const fixture = await ui.open("conversations");
    const list = rail(page);
    // The finished task holds the computer while its conversation is open, so another is taken up
    // first, as one alone would be before it could be deleted.
    await list.getByRole("button", { name: /^Compare flights/ }).click();
    await expect(list.locator("[aria-current='true']")).toHaveAccessibleName(/^Compare flights/);
    await list.getByRole("button", { name: "Select", exact: true }).click();
    await list.getByRole("checkbox", { name: /^Compare flights/ }).click();
    await list.getByRole("checkbox", { name: /^Find a plumber/ }).click();
    await list.getByRole("button", { name: "Delete…" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete 2 conversations?" });
    await expect(dialog).toContainText("This can't be undone.");
    await shoot(page, ui, "rail-confirm");
    expect(await listed(page, fixture)).toHaveLength(7);
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(list.getByRole("button", { name: /^Compare flights/ })).toHaveCount(0);
    await expect(list.getByRole("button", { name: "Select", exact: true })).toBeFocused();
    await expect
      .poll(() => listed(page, fixture))
      .not.toContain("Compare flights to Lisbon for the first week of May");
    expect(await listed(page, fixture)).not.toContain("Find a plumber near me with good reviews");
    await expect(page.getByRole("heading", { name: "What should we do?" })).toBeVisible();
    await heard(page, "Deleted 2 conversations.");
  });

  test("keeps a working conversation from being deleted or archived, as one alone is", async ({
    page,
    ui,
  }) => {
    await expandedAtStart(page);
    const fixture = await ui.open("conversations-working");
    const list = rail(page);
    await expect(list.getByRole("list", { name: "Active" })).toContainText("Sample");
    await list.getByRole("button", { name: "Select", exact: true }).click();
    const working = list.getByRole("checkbox", { name: /^Sample · monthly report, working/ });
    await working.click();
    await list.getByRole("checkbox", { name: /^Find a plumber/ }).click();
    const remove = list.getByRole("button", { name: "Delete…" });
    await expect(remove).toHaveAttribute("aria-disabled", "true");
    await expect(remove).toHaveAccessibleDescription(RUNNING);
    await expect(list.getByRole("button", { name: "Archive" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(list.getByRole("button", { name: "Pin" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await remove.hover();
    await expect(page.locator(".ui-tooltip", { hasText: RUNNING })).toBeVisible();
    await shoot(page, ui, "rail-running");
    await remove.click({ force: true });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);

    // The daemon refuses it too.
    const { conversations } = await (
      await page.request.get(`${fixture.origin}/api/conversations`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json();
    const live = conversations.find((each: { title: string }) => each.title.startsWith("Sample"));
    const refused = await page.request.delete(
      `${fixture.origin}/api/conversations/${live.sessionId}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(refused.status()).toBe(409);

    await working.click();
    await expect(remove).not.toHaveAttribute("aria-disabled", "true");
    await remove.click();
    const dialog = page.getByRole("alertdialog", { name: "Delete this conversation?" });
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(list.getByRole("button", { name: /^Find a plumber/ })).toHaveCount(0);
    await expect(list.getByRole("button", { name: /^Sample · monthly report/ })).toBeVisible();
  });

  test("selects in the conversations popover, where Escape lets them go before it closes", async ({
    page,
    ui,
  }) => {
    await ui.open("conversations");
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    const popover = page.getByRole("dialog", { name: "Conversations" });
    await popover.getByRole("button", { name: "Select", exact: true }).click();
    await expect(popover.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
    const search = popover.getByRole("combobox", { name: "Search conversations" });
    await search.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(ticked(popover)).toHaveCount(1);
    await popover.getByRole("checkbox", { name: /Clean up my Downloads/ }).click();
    await expect(popover.getByText("2 selected")).toBeVisible();
    await aligned(
      page,
      ".ui-popover .conversations",
      ".conversations-title",
      ".conversations-actions",
    );
    await shoot(page, ui, "popover-selecting");
    await popover.getByRole("checkbox", { name: "Select all" }).check();
    await expect(popover.getByText("7 selected")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover.getByRole("checkbox")).toHaveCount(0);
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  });
});

test.describe("phone", () => {
  test.beforeEach(({ page }) => {
    test.skip(!isPhone(page), "The phone's conversations");
  });

  test("Studio's sheet: a hold starts selecting, Select all, and one confirmation deletes", async ({
    page,
    ui,
  }) => {
    const fixture = await ui.open("conversations");
    await page.getByRole("button", { name: "Conversations", exact: true }).tap();
    const sheet = page.getByRole("dialog", { name: "Conversations" });
    const row = (title: RegExp) => sheet.getByRole("row").filter({ hasText: title });
    await expect(row(/Draft a reply/)).toBeVisible();

    // Held, a row shows its preview and menu, as it always has; Select is in that menu.
    const hand = await finger(page);
    await resting(row(/Rename the holiday/));
    await hand.hold(row(/Rename the holiday/));
    const menu = page.getByRole("menu", { name: "Conversation actions" });
    await expect(menu.getByRole("menuitem", { name: "Select" })).toBeVisible();
    await hand.lift();
    await menu.getByRole("menuitem", { name: "Select" }).tap();
    await expect(ticked(sheet)).toHaveAccessibleName(/Rename the holiday/);
    await row(/Draft a reply/).tap();
    await expect(sheet.getByText("2 selected")).toBeVisible();
    await expect(sheet.locator(".ui-swipe")).toHaveCount(0);
    await aligned(
      page,
      ".conversations[data-layout='sheet']",
      ".conversations-title",
      ".conversations[data-layout='sheet'] > .conversations-actions",
    );
    await shoot(page, ui, "sheet-selecting");

    const all = sheet.getByRole("checkbox", { name: "Select all" });
    await all.tap();
    await expect(ticked(sheet)).toHaveCount(7);
    await all.tap();
    await expect(ticked(sheet)).toHaveCount(0);

    await row(/Clean up my Downloads/).tap();
    await row(/Draft a reply/).tap();
    await sheet.getByRole("button", { name: "Delete…" }).tap();
    const dialog = page.getByRole("alertdialog", { name: "Delete 2 conversations?" });
    await expect(dialog).toContainText("This can't be undone.");
    await dialog.getByRole("button", { name: "Delete", exact: true }).tap();
    await expect(row(/Clean up my Downloads|Draft a reply/)).toHaveCount(0);
    await expect(sheet.getByRole("checkbox")).toHaveCount(0);
    expect(await listed(page, fixture)).toHaveLength(5);
  });

  test.describe("Chat", () => {
    test.use({ viewStyle: "chat", phoneList: true });

    test("the list: Select in the bar, the working one kept, Cancel, and delete", async ({
      page,
      ui,
    }) => {
      const fixture = await ui.open("conversations-working");
      const screen = page.getByRole("region", { name: "Conversations" });
      const bar = screen.locator(".phone-list-bar");
      await expect(screen.getByRole("button", { name: /^Draft a reply/ })).toBeVisible();
      await bar.getByRole("button", { name: "Select", exact: true }).tap();
      await expect(bar.getByRole("checkbox", { name: "Select all" })).toBeVisible();
      await expect(bar.getByRole("button", { name: "New conversation" })).toHaveCount(0);

      await screen.getByRole("checkbox", { name: /^Sample · monthly report\. Working/ }).tap();
      await screen.getByRole("checkbox", { name: /^Find a plumber/ }).tap();
      const actions = page.locator(".phone-select-actions");
      await expect(actions.getByText("2 selected")).toBeVisible();
      const remove = actions.getByRole("button", { name: "Delete…" });
      await expect(remove).toHaveAttribute("aria-disabled", "true");
      await expect(remove).toHaveAccessibleDescription(RUNNING);
      await aligned(page, ".phone-rows", null, ".phone-select-actions");
      await shoot(page, ui, "phone-list-selecting");
      await remove.tap({ force: true });
      await expect(page.getByRole("alertdialog")).toHaveCount(0);

      await bar.getByRole("button", { name: "Cancel" }).tap();
      await expect(screen.getByRole("checkbox")).toHaveCount(0);
      await expect(bar.getByRole("button", { name: "New conversation" })).toBeVisible();

      // A hold opens the row's preview and menu, which starts selecting with it.
      const hand = await finger(page);
      const plumber = screen.locator(".phone-row-wrap").filter({ hasText: "Find a plumber" });
      await resting(plumber);
      await hand.hold(plumber);
      const menu = page.getByRole("menu", { name: "Conversation actions" });
      await expect(menu.getByRole("menuitem", { name: "Select" })).toBeVisible();
      await hand.lift();
      await menu.getByRole("menuitem", { name: "Select" }).tap();
      await expect(ticked(screen)).toHaveAccessibleName(/^Find a plumber/);
      await screen.getByRole("checkbox", { name: /^Clean up my Downloads/ }).tap();
      await actions.getByRole("button", { name: "Delete…" }).tap();
      const dialog = page.getByRole("alertdialog", { name: "Delete 2 conversations?" });
      await dialog.getByRole("button", { name: "Delete", exact: true }).tap();
      await expect(
        screen.getByRole("button", { name: /^Find a plumber|^Clean up my Downloads/ }),
      ).toHaveCount(0);
      await expect.poll(() => listed(page, fixture)).toHaveLength(5);
    });
  });
});
