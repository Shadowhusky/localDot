import { type Browser, expect, type Page, test, webkit } from "@playwright/test";
import { startUiFixture, TOKEN, type UiFixture } from "./fixtures/start-ui-fixture.ts";

test.setTimeout(90_000);

let fixture: UiFixture | undefined;
test.afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const SIZES = [
  { name: "Chrome 1440×900", engine: "chrome", width: 1440, height: 900, phone: false },
  { name: "Chrome 390×844 phone", engine: "chrome", width: 390, height: 844, phone: true },
  { name: "WebKit 390×844 phone", engine: "webkit", width: 390, height: 844, phone: true },
] as const;

async function newPage(browser: Browser, size: (typeof SIZES)[number]) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 2,
    isMobile: size.phone,
    hasTouch: size.phone,
  });
  return context.newPage();
}

const tab = (page: Page, name: RegExp) => page.getByRole("tab", { name, includeHidden: true });

for (const size of SIZES)
  test(`a takeover shows the computer first with the dot on Computer at ${size.name}`, async ({
    browser,
  }) => {
    const owned = size.engine === "webkit" ? await webkit.launch({ channel: undefined }) : null;
    const page = await newPage(owned ?? browser, size);
    try {
      fixture = await startUiFixture();
      await page.goto(`${fixture.origin}/#token=${TOKEN}`);
      await expect(page.getByTestId("hud-status")).toHaveText("Select the Net total cell");
      if (size.phone) await tab(page, /^Conversation/).click();
      await page.request.post(`${fixture.origin}/__qa/takeover`);
      const panel = page.getByRole("region", { name: "Manual control" });
      await expect(panel).toBeAttached();
      await expect(tab(page, /^Computer, needs your attention$/)).toHaveCount(1);
      await expect(tab(page, /^Conversation$/)).toHaveCount(1);
      if (size.phone) await expect(tab(page, /^Computer/)).toHaveAttribute("aria-selected", "true");
      const surface = page.getByRole("button", { name: "Click on the computer" });
      await expect(surface).toBeEnabled();

      const layout = await page.evaluate(() => {
        const stage = document.querySelector(".pane-computer .stage")?.getBoundingClientRect();
        const controls = document
          .querySelector(".pane-computer [aria-label='Manual control']")
          ?.getBoundingClientRect();
        if (!stage || !controls) return null;
        const shown = Math.min(stage.bottom, innerHeight) - Math.max(stage.top, 0);
        const centre = document.elementFromPoint(
          stage.left + stage.width / 2,
          stage.top + stage.height / 2,
        );
        return {
          shown: shown / stage.height,
          inside: stage.left >= 0 && stage.right <= innerWidth,
          controlsBelow: controls.top >= stage.bottom,
          centre: centre?.getAttribute("aria-label") ?? null,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(layout).not.toBeNull();
      expect(layout?.shown).toBeGreaterThanOrEqual(0.95);
      expect(layout?.inside).toBe(true);
      expect(layout?.controlsBelow).toBe(true);
      expect(layout?.centre).toBe("Click on the computer");
      expect(layout?.overflow).toBe(false);
      await expect(panel).toContainText("Click or tap the computer to use it.");

      if (size.phone) {
        await tab(page, /^Conversation/).click();
        await page.waitForTimeout(1500);
        await expect(tab(page, /^Conversation/)).toHaveAttribute("aria-selected", "true");
      }
    } finally {
      await page.context().close();
      await owned?.close();
    }
  });
