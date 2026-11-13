import type { Locator, Page } from "@playwright/test";
import sharp from "sharp";
import { PANEL_NAME } from "../../src/shell/panel-name.ts";
import { expect, type Harness, isPhone, runAt, test } from "./harness.ts";

// The open plan is one solid card over the steps: nothing of theirs is drawn where it lies, in any
// browser, whatever that browser stacks on top. iOS Safari drew the steps' scrolling list over it.
runAt("c14", "c39", "w14", "w39");

const SHORT = [
  "Read the paper and find the Jianbao skill and production requirements",
  "Develop and fact-check a natural, non-specialist script and storyboard",
  "Produce the narrated video using Jianbao",
  "Review the finished video and deliver the video and script",
];
const CHINESE = [
  "阅读论文并找到剪报技能和制作要求，确认每一项都能在这台电脑上完成，再开始写脚本和分镜",
  "编写并核实一个自然易懂、面向非专业观众的脚本和分镜",
  "使用剪报制作带旁白的视频",
  "检查成片并交付视频和脚本",
];
const LONG = Array.from(
  { length: 30 },
  (_, n) => `Step ${n + 1} of the long plan, with enough words to wrap on a narrow panel`,
);

const items = (texts: readonly string[]) =>
  texts.map((text, n) => ({ id: `item-${n}`, text, status: n < 2 ? "done" : "todo" }));

async function openPanel(page: Page) {
  if (isPhone(page)) await page.getByRole("button", { name: PANEL_NAME, exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: PANEL_NAME, exact: true }).click();
  await expect(page.getByRole("tablist", { name: PANEL_NAME })).toBeVisible();
}

async function openPlan(page: Page, ui: Harness, texts: readonly string[]) {
  const fixture = await ui.open("running");
  const set = await page.request.post(`${fixture.origin}/__qa/plan`, {
    data: { items: items(texts) },
  });
  expect(set.ok(), await set.text()).toBe(true);
  // Enough steps that they fill the list under the card.
  await page.request.post(`${fixture.origin}/__qa/steps?n=24`);
  await openPanel(page);
  const toggle = page.locator(".activity-plan .ui-disclosure-trigger");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".plan-card .plan-list")).toBeVisible();
  await ui.settle();
  return page.locator(".plan-strip");
}

// A step's words or thread differ from the page by far more (over 200 levels with nothing cut out).
// The page behind the panel's edge may itself move by a few levels between the two pictures.
const NOTHING_DRAWN = 16;

// How much the list draws where the card lies: the page there with the card taken away, against the
// page with the list taken away as well.
async function drawnUnderCard(page: Page, card: Locator) {
  const list = page.locator(".activity-plan ~ .activity-scroll");
  const [box, port] = await Promise.all([card.boundingBox(), list.boundingBox()]);
  if (!box || !port) throw new Error("Missing the card or the list");
  const top = Math.ceil(port.y);
  const height = Math.floor(box.y + box.height) - top;
  expect(height, "the card lies over the list").toBeGreaterThan(0);
  const shot = async () =>
    sharp(
      await page.screenshot({
        clip: { x: Math.ceil(box.x) + 2, y: top, width: Math.floor(box.width) - 4, height },
      }),
    )
      .raw()
      .toBuffer();
  const hide = (node: Locator, how: string) =>
    node.evaluate((element: HTMLElement, value) => {
      element.style.visibility = value;
    }, how);
  await hide(card, "hidden");
  const without = await shot();
  await hide(list, "hidden");
  const blank = await shot();
  await hide(list, "");
  await hide(card, "");
  return without.reduce((most, value, at) => Math.max(most, Math.abs(value - (blank[at] ?? 0))), 0);
}

// Every line of the card is inside it, and none runs over the next.
async function expectWholeCard(card: Locator) {
  const report = await card.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const list = node.querySelector(".plan-list") as HTMLElement;
    const port = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll(".plan-item")].map((row) => row.getBoundingClientRect());
    return {
      solid: getComputedStyle(node).backgroundColor,
      fits: Math.abs(port.bottom - box.bottom) < 1,
      scrolls: list.scrollHeight > list.clientHeight + 1,
      overlaps: rows.filter((row, at) => at > 0 && row.top < (rows[at - 1]?.bottom ?? 0) - 0.5)
        .length,
      outside: rows.filter((row) => row.left < box.left || row.right > box.right).length,
      // A list that doesn't scroll is as tall as its rows.
      slack: port.bottom - (rows.at(-1)?.bottom ?? 0),
    };
  });
  expect(report.solid).toMatch(/^rgb\(/);
  expect(report.fits).toBe(true);
  expect(report.overlaps).toBe(0);
  expect(report.outside).toBe(0);
  return report;
}

for (const [name, texts] of [
  ["a short plan", SHORT],
  ["a plan in Chinese", CHINESE],
] as const)
  test(`${name} opens solid over the steps, in both appearances`, async ({ page, ui }) => {
    const card = await openPlan(page, ui, texts);
    const report = await expectWholeCard(card);
    expect(report.scrolls).toBe(false);
    expect(report.slack).toBeGreaterThanOrEqual(0);
    expect(report.slack).toBeLessThan(16);
    for (const appearance of ["daylight", "graphite"] as const) {
      await page.evaluate((value) => {
        document.documentElement.dataset.appearance = value;
      }, appearance);
      await ui.settle();
      expect(await drawnUnderCard(page, card), "steps under the card").toBeLessThan(NOTHING_DRAWN);
      await page.screenshot({ path: test.info().outputPath(`plan-${appearance}.png`) });
    }
  });

// The open card is part of the panel, edged as its other cards are: a popover's long shadow fell
// over the tabs above it and the steps below it.
test("the open plan casts no long shadow over the tabs or the steps", async ({ page, ui }) => {
  const card = await openPlan(page, ui, SHORT);
  const shadows = await card.evaluate((node) =>
    [...getComputedStyle(node).boxShadow.matchAll(/(-?[\d.]+)px (-?[\d.]+)px ([\d.]+)px/g)].map(
      ([, x, y, blur]) => Math.abs(Number(y)) + Number(blur),
    ),
  );
  expect(shadows.length).toBeGreaterThan(0);
  expect(Math.max(...shadows)).toBeLessThanOrEqual(4);
});

test("a long plan scrolls inside its card, which stays in the panel", async ({ page, ui }) => {
  const card = await openPlan(page, ui, LONG);
  const report = await expectWholeCard(card);
  expect(report.scrolls).toBe(true);
  expect(await drawnUnderCard(page, card), "steps under the card").toBeLessThan(NOTHING_DRAWN);
  const panel = await page.locator(".activity-rail").boundingBox();
  const box = await card.boundingBox();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
    (panel?.y ?? 0) + (panel?.height ?? 0),
  );
  const last = card.locator(".plan-item").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("plan-long.png") });
});

test("a long plan on a short screen still ends inside the panel", async ({ page, ui }) => {
  test.skip(!isPhone(page), "A phone's sheet is what gets short");
  await page.setViewportSize({ width: 390, height: 568 });
  const card = await openPlan(page, ui, LONG);
  const panel = await page.locator(".activity-rail").boundingBox();
  const box = await card.boundingBox();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
    (panel?.y ?? 0) + (panel?.height ?? 0),
  );
  const last = card.locator(".plan-item").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("plan-short-screen.png") });
});

test("folding the plan away gives the steps back", async ({ page, ui }) => {
  const card = await openPlan(page, ui, SHORT);
  const list = page.locator(".activity-plan ~ .activity-scroll");
  await page.locator(".activity-plan .ui-disclosure-trigger").click();
  await expect(page.locator(".plan-card")).not.toHaveAttribute("data-lifted");
  await expect.poll(() => list.evaluate((node) => getComputedStyle(node).clipPath)).toBe("none");
  await expect(card.locator(".plan-list")).toHaveCount(0);
});
