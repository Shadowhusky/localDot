import { test as base, expect, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { startUiFixture, TOKEN, type UiFixture } from "../fixtures/start-ui-fixture.ts";
import type { UiScenarioName } from "../fixtures/ui-scenarios.ts";
import { skipSetup } from "../skip-setup.ts";

// The fixture daemon's wall clock starts here and the page's stands still a minute later, so the
// dates and durations the UI prints are the same on every run.
export const FIXTURE_START = "2026-10-08T09:00:00.000Z";
const PAGE_NOW = new Date("2026-10-08T09:01:00.000Z");

export interface Probe {
  errors: string[];
  csp: string[];
  external: string[];
}

export interface Harness {
  // Boots a fixture daemon in `scenario` and opens the app on it, at `path` when given, with a
  // sign-in link in the address (`link`, "" for none).
  open(
    scenario: UiScenarioName,
    path?: (fixture: UiFixture) => string,
    link?: string,
  ): Promise<UiFixture>;
  // Moves the running fixture into a scenario that has a control-plane step.
  step(scenario: UiScenarioName): Promise<void>;
  // Opens a gallery page served by a fixture daemon, under the production page policy, with the
  // page's clock paused: time moves only by `page.clock.runFor`.
  gallery(name: string): Promise<void>;
  // Waits until `stage` shows a picture rather than an empty frame.
  picture(stage?: Locator): Promise<void>;
  // Waits for web fonts and images, then for two frames.
  settle(): Promise<void>;
  // Hides what moves on its own before a screenshot: the live dot, which blinks. The gallery
  // compares the dot itself, on a paused clock.
  still(): Promise<void>;
}

declare global {
  interface Window {
    recordCspViolation(text: string): Promise<void>;
  }
}

// Each test gets a page that fails it on a page error, a CSP violation or any request that leaves
// the fixture's origin, which is aborted.
export const test = base.extend<{ ui: Harness; fixedClock: boolean }>({
  // The page's clock stands still; a test of real frames and timers turns it off.
  fixedClock: [true, { option: true }],
  ui: async ({ page, fixedClock }, use) => {
    const probe: Probe = { errors: [], csp: [], external: [] };
    let fixture: UiFixture | undefined;
    let paused = false;
    page.on("pageerror", (error) => probe.errors.push(error.message));
    await page.exposeFunction("recordCspViolation", (text: string) => probe.csp.push(text));
    await skipSetup(page);
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        // WebKit reports the stylesheet Playwright adds to take a screenshot with no source file,
        // as it does an inline <style> in the served HTML. Chrome names the document for the
        // latter, so the Chrome projects are the ones that catch it.
        if (event.violatedDirective === "style-src-elem" && !event.sourceFile) return;
        void window.recordCspViolation(
          `${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`,
        );
      });
    });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (fixture && url.origin === fixture.origin) return route.continue();
      probe.external.push(url.href);
      return route.abort();
    });
    if (fixedClock) await page.clock.setFixedTime(PAGE_NOW);
    const boot = async (scenario: UiScenarioName) => {
      fixture = await startUiFixture(
        { QA_SCENARIO: scenario, QA_NOW: FIXTURE_START },
        "ui-harness",
      );
      return fixture;
    };
    const running = () => {
      if (!fixture) throw new Error("Open a scenario first");
      return fixture;
    };
    await use({
      async open(scenario, path, link = `#token=${TOKEN}`) {
        const opened = await boot(scenario);
        await page.goto(`${opened.origin}${path?.(opened) ?? "/"}${link}`);
        return opened;
      },
      async step(scenario) {
        const reply = await page.request.post(`${running().origin}/__qa/scenario/${scenario}`);
        expect(reply.ok(), await reply.text()).toBe(true);
      },
      async gallery(name) {
        const opened = fixture ?? (await boot("first-run"));
        if (!paused) await page.clock.pauseAt(new Date(PAGE_NOW.getTime() + 1000));
        paused = true;
        await page.goto(`${opened.origin}/gallery/#${name}`);
        await expect(page.locator(`[data-gallery-page="${name}"]`)).toBeVisible();
      },
      async picture(stage = page.locator(".stage").first()) {
        await expect
          .poll(async () => spread(await stage.screenshot({ animations: "disabled" })), {
            message: "the stage shows a picture",
          })
          .toBeGreaterThan(20);
      },
      settle: () => settle(page),
      async still() {
        await page.locator(".presence-frame .dot, .sign-in .dot").evaluateAll((dots) => {
          for (const dot of dots) (dot as HTMLElement).style.visibility = "hidden";
        });
      },
    });
    // Taken before the fixture stops: requests cut off by the shutdown are not the page's fault.
    const seen = structuredClone(probe);
    await fixture?.close();
    expect(seen, "page errors, CSP violations and outside requests").toEqual({
      errors: [],
      csp: [],
      external: [],
    });
  },
});

// How far the brightest channel's pixels spread: near 0 for an empty frame.
async function spread(png: Buffer): Promise<number> {
  const { channels } = await sharp(png).stats();
  return Math.max(...channels.map((channel) => channel.stdev));
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) =>
        image.complete ? null : image.decode().catch(() => null),
      ),
    );
    for (let frame = 0; frame < 2; frame++) await new Promise(requestAnimationFrame);
  });
}

// Whether the page has a phone's layout: no top bar, and a rail that is only the chat.
export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 700;

// The rail on its chat, which it opens on; a phone's rail is only the chat, under the stage.
export async function chatRail(page: Page) {
  if (!isPhone(page))
    await expect(page.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "true");
  return page.getByRole("complementary", { name: "Conversation" });
}

export async function composer(page: Page) {
  return (await chatRail(page)).getByRole("form", { name: "Message dot" });
}

// A spec's flows run at these projects of the matrix only.
export function runAt(...projects: string[]) {
  test.beforeEach(() => {
    test.skip(!projects.includes(test.info().project.name), `Runs at ${projects.join(" and ")}`);
  });
}

export { expect };
