import { test as base, expect, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { PANEL_NAME } from "../../src/shell/panel-name.ts";
import { VIEW_STYLE_KEY, type ViewStyle } from "../../src/shell/view-style.ts";
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
  // Before an action that takes the page to another address, which a reload needs no telling of:
  // WebKit reports the page's own requests that the navigation cuts off as errors, which are not
  // the page's fault.
  leaving(): void;
}

const CUT_OFF = /due to access control checks|^Load failed$|^Importing a module script failed\.$/;

declare global {
  interface Window {
    recordCspViolation(text: string): Promise<void>;
  }
}

// The view style this device has chosen, kept once set as a real choice is.
export function chooseView(page: Page, style: ViewStyle) {
  return page.addInitScript(
    ([key, value]) => {
      // A sandboxed frame has no storage to set it in.
      try {
        if (!localStorage.getItem(key as string))
          localStorage.setItem(key as string, value as string);
      } catch {}
    },
    [VIEW_STYLE_KEY, style],
  );
}

// Each test gets a page that fails it on a page error, a CSP violation or any request that leaves
// the fixture's origin, which is aborted.
export const test = base.extend<{
  ui: Harness;
  fixedClock: boolean;
  phoneList: boolean;
  viewStyle: ViewStyle | null;
  viewChosen: void;
}>({
  // The page's clock stands still; a test of real frames and timers turns it off.
  fixedClock: [true, { option: true }],
  // Chat on a phone opens on its list of conversations; most flows start inside the current one, by
  // its address, as a link does.
  phoneList: [false, { option: true }],
  // The style this device has chosen; null for none yet.
  viewStyle: ["studio", { option: true }],
  // Set up for every test, whether it goes through `ui` or starts its own fixture.
  viewChosen: [
    async ({ page, viewStyle }, use) => {
      if (viewStyle) await chooseView(page, viewStyle);
      await use();
    },
    { auto: true },
  ],
  ui: async ({ page, fixedClock, phoneList, viewStyle }, use) => {
    const chat = viewStyle === "chat";
    const probe: Probe = { errors: [], csp: [], external: [] };
    let fixture: UiFixture | undefined;
    let paused = false;
    let leaving = false;
    page.on("pageerror", (error) => {
      if (!leaving || !CUT_OFF.test(error.message)) probe.errors.push(error.message);
    });
    const reload = page.reload.bind(page);
    page.reload = (options) => {
      leaving = true;
      return reload(options);
    };
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
        const address = path?.(opened) ?? "/";
        await page.goto(`${opened.origin}${address}${link}`);
        if (chat && isPhone(page) && !phoneList && !address.includes("replay=")) {
          await page.waitForFunction(() => !window.location.hash.includes("token="));
          await page.evaluate(() => {
            window.location.hash = "#/c/current";
          });
        }
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
      async picture(given) {
        // A phone asks for no frames while nothing shows the picture: the task doesn't hold it.
        if (!given && chat) {
          await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
          if (await page.locator(".phone-picture[data-place='away']").count()) return;
        }
        const stage = given ?? page.locator(".stage").first();
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
      leaving() {
        leaving = true;
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
// Opens a file dot handed over from its row's menu, which holds Open wherever the row is narrow.
export async function openFile(page: Page, name: string, within: Page | Locator = page) {
  await within.getByRole("button", { name: `More for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Open", exact: true }).click();
}

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 700;

// A finger on the page. Chromium is touched for real, through the DevTools protocol, so the browser
// decides on scrolling and sends its own clicks. Playwright's WebKit sends no touch moves, so there
// the finger is the pointer events a touch makes, dispatched where it is.
export async function finger(page: Page) {
  const real = test.info().project.name.startsWith("c");
  const cdp = real ? await page.context().newCDPSession(page) : null;
  let at = { x: 0, y: 0 };
  const send = async (type: "down" | "move" | "up", x: number, y: number) => {
    at = { x, y };
    if (cdp) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: type === "down" ? "touchStart" : type === "move" ? "touchMove" : "touchEnd",
        touchPoints: type === "up" ? [] : [{ x, y }],
      });
      return;
    }
    await page.evaluate(
      ([kind, x, y]) => {
        const held = window as { fingerOn?: Element | null };
        if (kind === "down") held.fingerOn = document.elementFromPoint(x, y);
        held.fingerOn?.dispatchEvent(
          new PointerEvent(`pointer${kind}`, {
            pointerId: 9,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
        if (kind === "up") held.fingerOn = null;
      },
      [type, x, y] as const,
    );
  };
  const drag = async (fromX: number, fromY: number, toX: number, toY: number, lift = true) => {
    await send("down", fromX, fromY);
    for (let step = 1; step <= 14; step++) {
      await send("move", fromX + ((toX - fromX) * step) / 14, fromY + ((toY - fromY) * step) / 14);
      await page.waitForTimeout(16);
    }
    if (lift) {
      await page.waitForTimeout(120);
      await send("up", toX, toY);
    }
  };
  return {
    drag,
    // Across a row by `share` of its width, leftward when negative, stopping before it lifts.
    async swipe(target: Locator, share: number) {
      const box = await target.boundingBox();
      if (!box) throw new Error("Nothing to swipe");
      const y = box.y + box.height / 2;
      const from = share < 0 ? box.x + box.width - 40 : box.x + 40;
      await drag(from, y, from + share * box.width, y);
    },
    async hold(target: Locator) {
      const box = await target.boundingBox();
      if (!box) throw new Error("Nothing to hold");
      await send("down", box.x + box.width / 3, box.y + box.height / 2);
      await page.waitForTimeout(650);
    },
    async tap(target: Locator) {
      const box = await target.boundingBox();
      if (!box) throw new Error("Nothing to tap");
      await send("down", box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(40);
      await send("up", box.x + box.width / 2, box.y + box.height / 2);
    },
    lift: () => send("up", at.x, at.y),
  };
}

// In Chat: the Workspace panel, a sheet from the conversation's ⋯.
export async function openWorkspace(page: Page) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: PANEL_NAME, exact: true }).click();
}

// What Chat keeps on its computer pill, over the list: Routines, Replay, Settings, Keys and the rest.
// From a conversation it goes back to the list first.
export async function openFromPill(page: Page, item: string) {
  const back = page.getByRole("button", { name: "Back to conversations" });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: /this computer and app settings$/ }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

// Chat's computer screen, whose controls and status Studio's island holds.
export async function openComputerScreen(page: Page) {
  await page
    .getByRole("button", { name: /^Open the computer/ })
    .first()
    .click();
  await expect(page.locator(".phone-stack")).toHaveAttribute("data-level", "2");
}

// The rail on its chat, which it opens on; a phone's rail is only the chat, under the stage.
export async function chatRail(page: Page) {
  if (!isPhone(page))
    await expect(page.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "true");
  return page.getByRole("complementary", { name: "Conversation" });
}

export async function composer(page: Page) {
  return (await chatRail(page)).getByRole("form", { name: "Message dot" });
}

// Queues the draft: from the composer's own menu, or a phone's More menu. The menu stays open while
// Send is held off, so a second press needn't open it.
export async function sendAfterThisTask(page: Page, timeout?: number) {
  const item = page.getByRole("menuitem", { name: "Send after this task" });
  if (!(await item.isVisible()))
    await page
      .getByRole("button", { name: isPhone(page) ? "More" : "Message options", exact: true })
      .first()
      .click({ timeout });
  await item.click({ timeout });
}

// The composer with its field in use, which is when it shows all its controls.
export async function openComposer(page: Page) {
  const card = await composer(page);
  await card.getByRole("textbox").first().focus();
  return card;
}

// A spec's flows run at these projects of the matrix only.
export function runAt(...projects: string[]) {
  test.beforeEach(() => {
    test.skip(!projects.includes(test.info().project.name), `Runs at ${projects.join(" and ")}`);
  });
}

export { expect };
