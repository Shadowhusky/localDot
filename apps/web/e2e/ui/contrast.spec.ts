import { writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import type { ViewStyle } from "../../src/shell/view-style.ts";
import { walkTheApp } from "./app-walk.ts";
import { type Appearance, auditContrast, type Reading, wearAppearance } from "./contrast.ts";
import { expect, type Harness, runAt, test } from "./harness.ts";

// The main states of all three appearances, measured: every word at 4.5:1 (3:1 when large), every
// icon, slider rail and field edge at 3:1, each against the pixels really drawn behind it. A state
// is walked to once and read in each appearance where it stands, which is what keeps this quick.
// Nothing here compares pictures; the shots are for looking at.
runAt("c14", "c39", "w39");
test.describe.configure({ timeout: 120_000 });

const APPEARANCES: Appearance[] = ["daylight", "graphite", "midnight"];
// Each project walks in one view, Chat on the phone that has it by default; QA_CONTRAST_VIEW walks
// every project in the view it names.
const WALKS_IN: Record<string, ViewStyle> = { c14: "studio", c39: "studio", w39: "chat" };
const chosenView = process.env.QA_CONTRAST_VIEW as ViewStyle | undefined;

test.use({
  viewStyle: async ({ browserName: _ }, use, info) =>
    use(chosenView ?? WALKS_IN[info.project.name] ?? "studio"),
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("localdot.appearance.v1", "daylight"));
});

const seen: {
  state: string;
  appearance: Appearance;
  view: string | null;
  checked: number;
  failures: Reading[];
}[] = [];

test.afterEach(async ({ page: _ }, info: TestInfo) => {
  writeFileSync(info.outputPath("contrast.json"), JSON.stringify(seen.splice(0)));
});

async function readable(page: Page, ui: Harness | null, state: string) {
  await page.waitForTimeout(150);
  // The gallery's clock is paused, so it has no frames to wait for.
  await ui?.settle();
  const view = await page.evaluate(
    () => document.querySelector(".app")?.getAttribute("data-view") ?? null,
  );
  for (const [turn, appearance] of APPEARANCES.entries()) {
    await wearAppearance(page, appearance);
    const { picture, ...audit } = await auditContrast(page, { stillSince: turn > 0 });
    seen.push({ state, appearance, view, ...audit });
    writeFileSync(test.info().outputPath(`${state}-${appearance}.png`), picture);
    expect
      .soft(
        audit.failures.map(
          (each) =>
            `${each.ratio}:1 < ${each.needs} ${each.kind} ${each.where} "${each.what}" ${each.fg} on ${each.bg}`,
        ),
        `${state} in ${appearance}`,
      )
      .toEqual([]);
  }
}

walkTheApp(readable);

for (const id of ["system", "overlays", "feedback", "activity", "stage"])
  test(`gallery: ${id}`, async ({ page, ui }) => {
    await ui.gallery(id);
    await page.clock.runFor(1000);
    await readable(page, null, `gallery-${id}`);
  });
