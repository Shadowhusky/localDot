import type { Locator, Page } from "@playwright/test";
import { expect, type Harness, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");

// The room every panel keeps under the tab bar: the spacing scale's 8 px.
const GAP = 8;

async function activity(page: Page) {
  if (isPhone(page)) await page.getByRole("button", { name: "Activity", exact: true }).click();
  else
    await page.locator(".rail-chat").getByRole("radio", { name: "Activity", exact: true }).click();
  return page.getByRole("tablist", { name: "Activity" });
}

// A research task part-way through, so Sources joins the tabs.
async function research(ui: Harness) {
  process.env.QA_ACTIVITY = "research";
  try {
    return await ui.open("running");
  } finally {
    delete process.env.QA_ACTIVITY;
  }
}

const bottom = async (locator: Locator) => {
  const box = await locator.boundingBox();
  return (box?.y ?? 0) + (box?.height ?? 0);
};

// Where a block's first line of text starts, past any padding above it.
const textTop = (locator: Locator) =>
  locator.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getClientRects()[0]?.top ?? Number.NaN;
  });

test("empty panels keep a gap under the tab bar", async ({ page, ui }) => {
  await ui.open("ready");
  const tabs = await activity(page);
  for (const [tab, text] of [
    ["Agents", "Delegated agents appear here when dot starts them."],
    ["Steps", "Plan and steps appear here once dot starts."],
  ] as const) {
    await tabs.getByRole("tab", { name: tab }).click();
    const empty = page.getByRole("tabpanel", { name: tab }).getByText(text);
    await expect(empty).toBeVisible();
    expect((await textTop(empty)) - (await bottom(tabs))).toBeGreaterThanOrEqual(GAP);
  }
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("empty-panel.png") });
});

test("the plan keeps a gap under the tab bar", async ({ page, ui }) => {
  await ui.open("running");
  const tabs = await activity(page);
  const plan = page.locator(".activity-plan");
  await expect(plan).toBeVisible();
  const top = (await plan.boundingBox())?.y ?? 0;
  expect(top - (await bottom(tabs))).toBeGreaterThanOrEqual(GAP);
  // Open, the plan lifts into a card over the steps from the same place.
  await plan.getByRole("button", { name: /Plan/ }).click();
  await expect(plan.locator(".plan-card")).toHaveAttribute("data-lifted");
  const card = (await plan.locator(".plan-strip").boundingBox())?.y ?? 0;
  expect(card - (await bottom(tabs))).toBeGreaterThanOrEqual(GAP);
  await ui.settle();
  await page.screenshot({ path: test.info().outputPath("plan.png") });
});

// Every tab shows all of its name, or, where the names don't all fit, its icon with the name kept
// for assistive technology; nothing is cut and the underline sits under the chosen tab.
async function expectWholeTabs(tabs: Locator) {
  const report = await tabs.evaluate((list) => {
    const edge = list.getBoundingClientRect();
    const iconic = list.hasAttribute("data-iconic");
    const thumb = list.querySelector(".ui-segmented-thumb")?.getBoundingClientRect();
    const chosen = list.querySelector('[aria-selected="true"]')?.getBoundingClientRect();
    return {
      iconic,
      underline:
        !!thumb &&
        !!chosen &&
        Math.abs(thumb.left - chosen.left) < 1.5 &&
        Math.abs(thumb.width - chosen.width) < 1.5,
      cut: [...list.querySelectorAll<HTMLElement>('[role="tab"]')]
        .filter((tab) => {
          const box = tab.getBoundingClientRect();
          const label = tab.querySelector<HTMLElement>(".ui-segment-label");
          return (
            tab.scrollWidth > tab.clientWidth + 1 ||
            box.left < edge.left - 0.5 ||
            box.right > edge.right + 0.5 ||
            (!iconic && !!label && label.scrollWidth > label.clientWidth)
          );
        })
        .map((tab) => tab.textContent),
    };
  });
  expect(report.cut).toEqual([]);
  expect(report.underline).toBe(true);
  return report.iconic;
}

test("Activity's tabs are never cut, however many there are", async ({ page, ui }) => {
  const fixture = await research(ui);
  const tabs = await activity(page);
  for (const extra of ["/__qa/agents", "/__qa/work?kind=files", "/__qa/research?n=3"]) {
    const reply = await page.request.post(`${fixture.origin}${extra}`);
    expect(reply.ok(), await reply.text()).toBe(true);
  }
  await expect(tabs.getByRole("tab")).toHaveCount(5);
  await tabs.getByRole("tab", { name: "Agents 2" }).click();
  await expect(tabs.getByRole("tab", { name: "Agents 2" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(tabs.getByRole("tab", { name: "Sources 8" })).toBeVisible();
  await ui.settle();
  // A phone's sheet has room for every name; the desktop rail shows icons for five.
  expect(await expectWholeTabs(tabs)).toBe(!isPhone(page));
  await page.screenshot({ path: test.info().outputPath("five-tabs.png") });
  if (!isPhone(page)) {
    await tabs.getByRole("tab", { name: "Files 1" }).hover();
    await expect(page.locator(".ui-tooltip", { hasText: "Files" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("five-tabs-tooltip.png") });
  }
});

test("four tabs keep their names in the narrowest chat rail", async ({ page, ui }) => {
  test.skip(isPhone(page), "A phone has no rail to narrow");
  await page.addInitScript(() => localStorage.setItem("localdot.width.chat", "320"));
  const fixture = await ui.open("running");
  const tabs = await activity(page);
  await page.request.post(`${fixture.origin}/__qa/agents`);
  await page.request.post(`${fixture.origin}/__qa/work?kind=files`);
  await expect(tabs.getByRole("tab")).toHaveCount(4);
  await ui.settle();
  expect(await expectWholeTabs(tabs)).toBe(false);
  await page.screenshot({ path: test.info().outputPath("four-tabs-320.png") });
});
