import type { Page } from "@playwright/test";
import { TOKEN, type UiFixture } from "../fixtures/start-ui-fixture.ts";
import { skipSetup } from "../skip-setup.ts";
import { expect, runAt, test } from "./harness.ts";

runAt("c14", "w14");

const PANELS = "localdot.panels.v1";
const expandedAtStart = (page: Page, expanded: boolean) =>
  page.addInitScript(
    ([key, value]) => localStorage.setItem(key, JSON.stringify({ sessions: value })),
    [PANELS, expanded] as const,
  );
const rail = (page: Page) => page.getByRole("navigation", { name: "Conversations" });
const row = (page: Page, name: string) =>
  rail(page).getByRole("button", { name: new RegExp(`^${name}`) });

// Organizes conversations through the daemon's own routes, as another viewer would.
async function organize(
  page: Page,
  fixture: UiFixture,
  title: string,
  action: string,
  body: object,
) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  const { conversations } = await (
    await page.request.get(`${fixture.origin}/api/conversations`, { headers })
  ).json();
  const found = conversations.find((each: { title: string }) => each.title.startsWith(title));
  const reply = await page.request.post(
    `${fixture.origin}/api/conversations/${found.sessionId}/${action}`,
    { headers, data: body },
  );
  expect(reply.status()).toBe(204);
}

test("tags, pins and archives a conversation from its menu, and another viewer follows", async ({
  page,
  ui,
  browser,
}) => {
  await expandedAtStart(page, true);
  const fixture = await ui.open("conversations");
  const { viewport } = test.info().project.use;
  const other = await browser.newContext({ viewport });
  try {
    const device = await other.newPage();
    await skipSetup(device);
    await device.goto(`${fixture.origin}/#token=${TOKEN}`);
    await expect(row(device, "Clean up my Downloads")).toBeAttached();

    const downloads = row(page, "Clean up my Downloads");
    await downloads.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "Conversation actions" });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitemradio", { name: "Green" }).click();
    await expect(menu).toBeHidden();
    await expect(downloads).toHaveAccessibleName(/^Clean up my Downloads folder, green tag, done/);
    await expect(row(device, "Clean up my Downloads")).toHaveAccessibleName(/, green tag, /);

    await downloads.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Pin to top" }).click();
    const pinned = rail(page).getByRole("list", { name: "Pinned" });
    await expect(pinned.getByRole("button", { name: /^Clean up my Downloads/ })).toBeVisible();
    await expect(
      rail(device).getByRole("list", { name: "Pinned" }).getByRole("button"),
    ).toHaveAccessibleName(/^Clean up my Downloads/);

    await downloads.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Archive" }).click();
    await expect(downloads).toHaveCount(0);
    await expect(row(device, "Clean up my Downloads")).toHaveCount(0);
    const archived = rail(page).getByRole("button", { name: /^Archived/ });
    await expect(archived).toHaveAttribute("aria-expanded", "false");
    await archived.click();
    await expect(downloads).toHaveAccessibleName(/^Clean up my Downloads folder, green tag/);
    await downloads.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Unarchive" }).click();
    await expect(pinned.getByRole("button", { name: /^Clean up my Downloads/ })).toBeVisible();
    await expect(archived).toHaveCount(0);
    await expect(row(device, "Clean up my Downloads")).toBeAttached();
  } finally {
    await other.close();
  }
});

test("searches names as you type and what was said once you pause, and says why each matched", async ({
  page,
  ui,
}) => {
  await ui.open("conversations");
  const app = page.locator(".app");
  await expect(app).toHaveAttribute("data-sessions", "collapsed");
  // Collapsed, the search mark makes room for names and snippets first.
  await rail(page).getByRole("button", { name: "Search conversations" }).click();
  await expect(app).toHaveAttribute("data-sessions", "expanded");
  const field = rail(page).getByRole("textbox", { name: "Search conversations" });
  await expect(field).toBeFocused();

  await field.pressSequentially("lisbn");
  const results = rail(page).getByRole("list", { name: "Results" });
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await expect(results.getByRole("listitem").getByRole("button").first()).toHaveAccessibleName(
    /^Compare flights to Lisbon/,
  );
  await expect(results.locator("mark")).toHaveText(["Lisbon"]);

  await field.fill("empty bin");
  const downloads = results.getByRole("button", { name: /^Clean up my Downloads/ });
  await expect(downloads).toBeVisible();
  await expect(downloads.locator(".sessions-activity mark")).toHaveText(["empty", "bin"]);
  await expect(downloads).toHaveAccessibleDescription(/Also empty the bin/);

  await page.keyboard.press("ArrowDown");
  await expect(downloads).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(field).toHaveValue("");
  await expect(results).toHaveCount(0);
  await expect(rail(page).getByRole("list", { name: "Recent" })).toBeVisible();
});

// For the eye: the tagged rail collapsed and expanded, a row's menu, and a search that found what
// a conversation said, in Graphite and Daylight.
test("looks right tagged, with its menu open and searching, in Graphite and Daylight", async ({
  page,
  ui,
}) => {
  test.skip(test.info().project.name !== "c14", "Shots at c14");
  const fixture = await ui.open("conversations");
  for (const [title, tag] of [
    ["Compare flights", "blue"],
    ["Rename the holiday", "orange"],
    ["Find a plumber", "green"],
    ["Clean up my Downloads", "purple"],
    ["Draft a reply", "red"],
    ["Summarise the Q3", "yellow"],
  ] as const)
    await organize(page, fixture, title, "tag", { tag });
  await organize(page, fixture, "Find a plumber", "pin", { pinned: true });
  await organize(page, fixture, "Summarise the Q3", "archive", { archived: true });
  await expect(row(page, "Draft a reply")).toHaveAccessibleName(/, red tag, /);
  await ui.picture();
  const shoot = async (name: string) => {
    for (const appearance of ["graphite", "daylight"] as const) {
      await page.evaluate((value) => {
        document.documentElement.dataset.appearance = value;
      }, appearance);
      await ui.settle();
      await ui.still();
      await page.screenshot({
        path: test.info().outputPath(`organize-${name}-${appearance}.png`),
        clip: { x: 0, y: 0, width: 640, height: 640 },
        animations: "disabled",
      });
    }
  };
  const app = page.locator(".app");
  await expect(app).toHaveAttribute("data-sessions", "collapsed");
  await shoot("collapsed");
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(app).toHaveAttribute("data-sessions", "expanded");
  await rail(page)
    .getByRole("button", { name: /^Archived/ })
    .click();
  await expect(row(page, "Summarise the Q3")).toBeVisible();
  await shoot("expanded");

  await row(page, "Clean up my Downloads").hover();
  await rail(page)
    .getByRole("button", { name: "Actions for Clean up my Downloads folder" })
    .click();
  await expect(page.getByRole("menu", { name: "Conversation actions" })).toBeVisible();
  await shoot("menu");
  await page.keyboard.press("Escape");

  await rail(page).getByRole("textbox", { name: "Search conversations" }).fill("empty bin");
  await expect(rail(page).locator(".sessions-activity mark")).toHaveText(["empty", "bin"]);
  await shoot("search");

  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Conversations" });
  await expect(popover.locator(".conversations-day").first()).toHaveText("Pinned");
  await page.mouse.move(0, 0);
  const box = await popover.boundingBox();
  if (!box) throw new Error("No popover");
  for (const appearance of ["graphite", "daylight"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await ui.settle();
    await page.screenshot({
      path: test.info().outputPath(`organize-popover-${appearance}.png`),
      clip: { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 },
      animations: "disabled",
    });
  }
});
