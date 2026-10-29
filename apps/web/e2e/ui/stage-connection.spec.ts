import type { Page } from "@playwright/test";
import { expect, type Harness, isPhone, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w39");
test.use({ fixedClock: false });

const WORKING = "Select the Net total cell";

// Notes, from now on, each time the page covers the stage with a curtain (first connection, or
// the computer off) or says it is connecting, under the fixture step that was last taken.
async function watchFirstConnection(page: Page) {
  await expect(page.locator(".curtain")).toHaveCount(0);
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { firstConnection: seen });
    const look = () => {
      const step = (window as unknown as { step?: string }).step;
      const curtain = document.querySelector(".curtain")?.getAttribute("aria-label");
      const status = document.querySelector('[data-testid="hud-status"]')?.textContent;
      const line = curtain
        ? `${step}: ${curtain}`
        : status === "Connecting…"
          ? `${step}: ${status}`
          : null;
      if (line && seen.at(-1) !== line) seen.push(line);
    };
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    look();
  });
}
const firstConnection = (page: Page) =>
  page.evaluate(() => (window as unknown as { firstConnection: string[] }).firstConnection);

// Takes a fixture step, noting it for the watch above.
const control = (page: Page, origin: string) => async (path: string) => {
  await page.evaluate((step) => Object.assign(window, { step }), path);
  const reply = await page.request.post(`${origin}/__qa/${path}`);
  expect(reply.ok(), await reply.text()).toBe(true);
};

// The page in each appearance, at this project's width.
async function shots(page: Page, ui: Harness, name: string) {
  for (const appearance of ["graphite", "midnight"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await ui.settle();
    await ui.still();
    await page.screenshot({ path: test.info().outputPath(`${name}-${appearance}.png`) });
  }
}

test("a dropped stream keeps its last picture, says it is reconnecting, then offers to try again", async ({
  page,
  ui,
}) => {
  test.setTimeout(90_000);
  const fixture = await ui.open("running");
  const qa = control(page, fixture.origin);
  await ui.picture();
  const status = page.getByTestId("hud-status");
  await expect(status).toHaveText(WORKING);
  await watchFirstConnection(page);
  const canvas = page.locator(".stage > canvas").first();
  const notice = page.locator(".stage-away-card");

  // A blip leaves the stage and the HUD as they were.
  await qa("picture/drop");
  await page.waitForTimeout(250);
  await qa("picture/resume");
  await page.waitForTimeout(2_000);
  await expect(notice).toHaveCount(0);
  await expect(status).toHaveText(WORKING);

  await qa("picture/drop");
  await expect(notice).toHaveText("Reconnecting…");
  await expect(status).toHaveText("Reconnecting…");
  await expect(canvas).toHaveCSS("opacity", "0.55");
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await shots(page, ui, "reconnecting");

  await expect(notice).toContainText("Still reconnecting", { timeout: 15_000 });
  await expect(notice).toContainText("Your computer keeps running. This is its last picture.");
  await shots(page, ui, "still-reconnecting");
  const ticket = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/stream-ticket"),
  );
  await notice.getByRole("button", { name: "Try again" }).click();
  await ticket;

  await qa("picture/resume");
  await expect(notice).toHaveCount(0, { timeout: 15_000 });
  await expect(status).toHaveText(WORKING);
  await expect(canvas).toHaveCSS("opacity", "1");
  await ui.picture();

  // Nor is a visit to Replay and back a first connection.
  if (isPhone(page)) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Replay", exact: true }).click();
  } else await page.getByRole("radio", { name: "Replay", exact: true }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-replaying", "");
  if (isPhone(page))
    await page.getByRole("navigation").getByRole("button", { name: "Watch", exact: true }).click();
  else await page.getByRole("radio", { name: "Watch", exact: true }).click();
  await expect(page.locator(".app")).not.toHaveAttribute("data-replaying");
  await ui.picture();
  await expect(status).toHaveText(WORKING);
  expect(await firstConnection(page)).toEqual([]);
});

test("dot moving to the web browser, and the browser starting again, hold the last picture", async ({
  page,
  ui,
}) => {
  test.setTimeout(90_000);
  const fixture = await ui.open("running");
  const qa = control(page, fixture.origin);
  await ui.picture();
  const status = page.getByTestId("hud-status");
  await watchFirstConnection(page);
  const notice = page.locator(".stage-away-card");

  // The browser's first picture is late: the desktop's stays, dimmed, under the switch.
  await qa("picture/drop?screen=browser");
  await qa("screen?to=browser");
  await expect(notice).toHaveText("Switching to the web browser…");
  // The switch is the stage's to tell: the HUD goes on with dot's work.
  await expect(status).not.toHaveText(/Connecting|Reconnecting/);
  await shots(page, ui, "switching");
  await qa("picture/resume?screen=browser");
  await expect(notice).toHaveCount(0, { timeout: 15_000 });
  await ui.picture();
  await shots(page, ui, "browser");

  await qa("browser/restart?ms=5000");
  await expect(notice).toHaveText("The web browser is restarting…");
  await expect(status).toHaveText("Reconnecting…");
  await shots(page, ui, "browser-restarting");
  await expect(notice).toHaveCount(0, { timeout: 20_000 });
  await expect(status).not.toHaveText(/Connecting|Reconnecting/);

  // Back to the desktop.
  await qa("screen");
  await expect(notice).toHaveCount(0);
  await ui.picture();
  expect(await firstConnection(page)).toEqual([]);
});
