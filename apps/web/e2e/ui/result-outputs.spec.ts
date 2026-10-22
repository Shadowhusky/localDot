import { reach } from "../reach.ts";
import { expect, isPhone, runAt, test } from "./harness.ts";

// A result's outputs stay short in the chat: one line a file with its preview closed, the files
// after the first three folded, and the replay on one row with Export in its menu.
runAt("c14", "c39", "w39");

const WATCH = /^Watch replay \(\d+:\d\d\)$/;

async function handFiveFiles(page: import("@playwright/test").Page, origin: string, lent: string) {
  const handed = await page.request.post(`${origin}/__qa/files?count=5&recording=${lent}`);
  expect(handed.ok(), await handed.text()).toBe(true);
  const card = page.getByRole("region", { name: "Task result" }).last();
  await expect(card.getByRole("button", { name: WATCH })).toBeVisible();
  return card;
}

test("five files and their proof stay compact until asked", async ({ page, ui }) => {
  const fixture = await ui.open("running");
  const card = await handFiveFiles(page, fixture.origin, fixture.seeded[0] ?? "");
  const list = card.getByRole("list", { name: /^Files in result / });
  const proof = card.getByRole("region", { name: "Proof" });
  const phone = isPhone(page);
  const line = phone ? 44 : 40;

  // Three files show, each one line with its preview closed; the image shows its own picture.
  await expect(list.getByRole("listitem")).toHaveCount(3);
  for (const name of ["chart.png", "totals.csv", "notes.md"]) {
    const row = list.getByRole("listitem", { name });
    await expect(row.getByRole("button", { name: `Show ${name}` })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect((await row.boundingBox())?.height).toBe(line);
  }
  const picture = list.getByRole("listitem", { name: "chart.png" }).locator(".ui-file-tile > img");
  await expect(picture).toBeVisible();
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(card.locator("table, pre, figure")).toHaveCount(0);

  // The replay is one row, and the files with it take about 240 px, 280 on a phone.
  await expect(proof.getByText(/^Checked: opens, 4 sheets$/)).toBeAttached();
  expect((await proof.boundingBox())?.height).toBe(line);
  const top = (await card.locator(".result-files").boundingBox())?.y ?? 0;
  const proofBox = await proof.boundingBox();
  const span = (proofBox?.y ?? 0) + (proofBox?.height ?? 0) - top;
  expect(span).toBeLessThanOrEqual(phone ? 288 : 248);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("compact.png") });

  if (phone)
    for (const button of await card.getByRole("button").all())
      expect(await button.evaluate(reach), (await button.getAttribute("aria-label")) ?? "").toEqual(
        { width: 44, height: 44 },
      );

  // Show more unfolds the rest in place, and folds them again.
  await card.getByRole("button", { name: "Show 2 more files" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(5);
  await expect(list.getByRole("listitem", { name: "brief.docx" })).toBeVisible();
  const fewer = card.getByRole("button", { name: "Show fewer files" });
  await expect(fewer).toHaveAttribute("aria-expanded", "true");
  await fewer.click();
  await expect(list.getByRole("listitem")).toHaveCount(3);

  // A row opens its preview under it, with Revise beside it.
  await list.getByRole("button", { name: "Show totals.csv" }).click();
  const rows = card.getByRole("region", { name: "First rows of totals.csv" });
  await expect(rows.getByRole("cell", { name: "12000" })).toBeVisible();
  await expect(
    list.getByRole("listitem", { name: "totals.csv" }).getByRole("button", { name: "Revise" }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("preview.png") });
  await list.getByRole("button", { name: "Hide totals.csv" }).click();
  await expect(rows).toHaveCount(0);

  // Export waits in the replay's menu and opens Replay on this result's part of the recording.
  const { sessionId } = (await (await page.request.get(`${fixture.origin}/__qa/state`)).json()) as {
    sessionId: string;
  };
  await page.evaluate(() => {
    const push = history.pushState.bind(history);
    const seen: string[] = [];
    Object.assign(window, { pushed: seen });
    history.pushState = (state, unused, url) => {
      seen.push(String(url));
      push(state, unused, url);
    };
  });
  await proof.getByRole("button", { name: "More for this replay" }).click();
  const menu = page.getByRole("menu", { name: "More for this replay" });
  await expect(menu.getByRole("menuitem", { name: "Export proof video" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("menu.png") });
  await menu.getByRole("menuitem", { name: "Export proof video" }).click();
  await expect(page.getByRole("main", { name: "Replay" })).toBeVisible();
  const pushed = await page.evaluate(() => (window as unknown as { pushed: string[] }).pushed);
  const asked = new URL(pushed.at(-1) ?? "", fixture.origin).searchParams;
  expect(asked.get("replay")).toBe(sessionId);
  expect(asked.get("export")).toMatch(/^0-\d{4,}$/);
  expect(asked.get("t")).toBe("0");
});

test("the outputs can be worked from the keyboard alone", async ({ page, ui }) => {
  test.skip(isPhone(page), "A phone has no keyboard to walk the rows with");
  const fixture = await ui.open("running");
  const card = await handFiveFiles(page, fixture.origin, fixture.seeded[0] ?? "");
  const label = () =>
    page.evaluate(() => {
      const focused = document.activeElement;
      return focused?.getAttribute("aria-label") ?? focused?.textContent ?? "";
    });
  await card.getByRole("button", { name: "Download all 5 files" }).focus();
  const order = [await label()];
  for (let stop = 0; stop < 12; stop++) {
    await page.keyboard.press("Tab");
    order.push(await label());
  }
  expect(order.slice(0, 11)).toEqual([
    "Download all 5 files",
    "Show chart.png",
    "Open chart.png",
    "Download chart.png",
    "Show totals.csv",
    "Open totals.csv",
    "Download totals.csv",
    "Show notes.md",
    "Open notes.md",
    "Download notes.md",
    "Show 2 more files",
  ]);
  expect(order[11]).toMatch(WATCH);
  expect(order[12]).toBe("More for this replay");

  // The menu takes the keyboard and gives focus back when it closes.
  await page.keyboard.press("Enter");
  const item = page.getByRole("menuitem", { name: "Export proof video" });
  await expect(item).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "More for this replay" })).toBeFocused();

  // Show more unfolds from the keyboard and keeps focus where it was.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  const fewer = card.getByRole("button", { name: "Show fewer files" });
  await expect(fewer).toBeFocused();
  await expect(
    card.getByRole("list", { name: /^Files in result / }).getByRole("listitem"),
  ).toHaveCount(5);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await label()).toBe("Show brief.docx");
  await page.keyboard.press("Enter");
  await expect(card.getByRole("button", { name: "Hide brief.docx" })).toBeFocused();
  await expect(card.getByRole("button", { name: "Hide brief.docx" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});
