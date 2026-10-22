import { expect, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

const LONG =
  "Compare every flight to Lisbon for the first week of May, the late ones and the cheap ones, then book the best";

test("a long conversation name never squeezes its status point or wraps its time", async ({
  page,
  ui,
}) => {
  await page.route("**/api/conversations", async (route) => {
    const original = await route.fetch();
    const { conversations } = await original.json();
    await route.fulfill({
      json: { conversations: conversations.map((entry: object) => ({ ...entry, title: LONG })) },
    });
  });
  await ui.open("conversations");
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Conversations", exact: true }).click();
  } else await page.getByRole("button", { name: "Conversations", exact: true }).click();
  const list = page.getByRole("grid", { name: "Recent conversations" });
  await expect(list.getByRole("row").first()).toContainText("Compare every flight");
  await ui.settle();
  const rows = await page.locator(".conversations-row").evaluateAll((list) =>
    list.map((row) => {
      const part = (selector: string) => {
        const element = row.querySelector(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        return element;
      };
      const point = part(".conversations-status").getBoundingClientRect();
      const title = part(".conversations-title");
      const when = part(".conversations-when");
      return {
        point: [point.width, point.height],
        gap: Math.round(title.getBoundingClientRect().left - point.right),
        cut: title.scrollWidth > title.clientWidth,
        lines: Math.round(
          when.getBoundingClientRect().height /
            Number.parseFloat(getComputedStyle(when).lineHeight),
        ),
      };
    }),
  );
  expect(rows.length).toBeGreaterThan(1);
  for (const row of rows) expect(row).toEqual({ point: [8, 8], gap: 12, cut: true, lines: 1 });
  await page.screenshot({ path: test.info().outputPath("conversations-long.png") });
});
