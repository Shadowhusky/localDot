import { expect, runAt, test } from "./harness.ts";

// dot's sub-agents at every size: coming out, at work, finishing and failing, for the eye. The
// arrangement itself is checked in engine/tools.test.ts.
runAt("c14");

test.use({ reducedMotion: "no-preference", viewport: { width: 1200, height: 3400 } });

for (const scheme of ["dark", "light"] as const)
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });
    test("the crew reads at each size, in each stage", async ({ page, ui }) => {
      await page.addInitScript(
        (value) => localStorage.setItem("localdot.appearance.v1", value),
        scheme === "dark" ? "graphite" : "daylight",
      );
      await ui.gallery("helpers");
      await expect(page.locator(".gallery-helpers .dot")).toHaveCount(108);
      let at = 0;
      for (const [name, t] of [
        ["entering", 160],
        ["at-work", 1600],
        ["finishing", 2700],
        ["failing", 3500],
        ["closed-up", 5200],
      ] as const) {
        await page.clock.runFor(t - at);
        at = t;
        await page.screenshot({ path: test.info().outputPath(`helpers-${scheme}-${name}.png`) });
      }
    });
  });
