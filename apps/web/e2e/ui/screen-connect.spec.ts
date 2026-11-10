import type { Page } from "@playwright/test";
import { expect, type Harness, isPhone, openComputerScreen, runAt, test } from "./harness.ts";

runAt("c14", "c39", "w14", "w39");
test.use({ fixedClock: false });

const STUCK = "Can't show your screen yet";
const canvas = (page: Page) => page.locator("canvas.stage-canvas").first();
const curtain = (page: Page) => page.locator(".curtain");

const control = (page: Page, origin: string) => async (path: string) => {
  const reply = await page.request.post(`${origin}/__qa/${path}`);
  expect(reply.ok(), await reply.text()).toBe(true);
};

// Everything a test asks about the page from here on: its own loads, which a recovery must never
// need, and the stream clients it ever ran at once, of which there must never be two.
async function watch(page: Page) {
  await page.addInitScript(() => {
    if (window.parent !== window) return;
    const seen = { most: 0 };
    Object.assign(window, { clientsSeen: seen });
    const look = () => {
      const now = document.querySelectorAll("iframe.desktop-frame").length;
      seen.most = Math.max(seen.most, now);
    };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  });
  const tickets: { path: string; at: number }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /stream-ticket$/.test(request.url()))
      tickets.push({ path: new URL(request.url()).pathname, at: Date.now() });
  });
  let loads = 0;
  page.on("load", () => loads++);
  return {
    tickets,
    loads: () => loads,
    mostClients: () =>
      page.evaluate(
        () => (window as unknown as { clientsSeen: { most: number } }).clientsSeen.most,
      ),
  };
}

// The curtain lifts off a real picture, by itself.
async function pictureArrives(page: Page, ui: Harness, within = 30_000) {
  await expect(curtain(page)).toHaveCount(0, { timeout: within });
  await expect
    .poll(async () => Number(await canvas(page).getAttribute("data-frames")))
    .toBeGreaterThan(0);
  await ui.picture();
}

// Opens the page once, then again with `stall` set, so the stall meets a first connection.
async function reopen(page: Page, ui: Harness, stall?: string) {
  const fixture = await ui.open("ready");
  const qa = control(page, fixture.origin);
  await pictureArrives(page, ui);
  if (stall) await qa(stall);
  const seen = await watch(page);
  await page.reload();
  return { qa, seen };
}

const STAGES = {
  "a socket that never opens": "stream-stall?stage=socket",
  "an open socket with a silent track": "stream-stall?stage=frame",
  "an open socket with no track": "stream-stall?stage=track",
  "a ticket the daemon refuses": "stream-stall?stage=ticket&times=2",
  "a client page that fails": "stream-stall?stage=page",
};

for (const [name, stall] of Object.entries(STAGES))
  test(`${name} recovers without a refresh`, async ({ page, ui }) => {
    const { seen } = await reopen(page, ui, stall);
    await pictureArrives(page, ui);
    expect(seen.loads()).toBe(1);
    expect(await seen.mostClients()).toBe(1);
  });

test("a socket that was refused gets a fresh client soon, not after the client's own retry", async ({
  page,
  ui,
}) => {
  const { seen } = await reopen(page, ui, "stream-stall?stage=refused");
  await pictureArrives(page, ui, 4_000);
  expect(seen.loads()).toBe(1);
  expect(await seen.mostClients()).toBe(1);
});

test("a connection that keeps failing gets more time for each try", async ({ page, ui }) => {
  test.setTimeout(90_000);
  const { seen } = await reopen(page, ui, "stream-stall?stage=frame&times=3");
  await pictureArrives(page, ui, 70_000);
  const at = seen.tickets.map((ticket) => ticket.at);
  expect(at.length).toBe(4);
  const gaps = at.slice(1).map((time, n) => time - (at[n] ?? 0));
  expect(gaps[1] ?? 0).toBeGreaterThan((gaps[0] ?? 0) + 1_000);
  expect(gaps[2] ?? 0).toBeGreaterThan((gaps[1] ?? 0) + 1_000);
  expect(seen.loads()).toBe(1);
  expect(await seen.mostClients()).toBe(1);
});

test("a stream that is merely slow keeps its first try", async ({ page, ui }) => {
  test.setTimeout(60_000);
  const { seen } = await reopen(page, ui, "stream-stall?stage=slow&ms=6000");
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("heading", { name: "Connecting your screen" })).toBeVisible();
  const first = await page.locator("iframe.desktop-frame").elementHandle();
  await pictureArrives(page, ui);
  expect(await first?.evaluate((frame) => frame.isConnected)).toBe(true);
  expect(seen.tickets).toHaveLength(1);
});

test("a stage whose renderer never loaded starts again", async ({ page, ui }) => {
  await ui.open("ready");
  await pictureArrives(page, ui);
  let asked = 0;
  await page.route("**/assets/render-worker*", async (route) => {
    if (++asked === 1) await route.abort();
    else await route.continue();
  });
  const seen = await watch(page);
  await page.reload();
  await pictureArrives(page, ui);
  expect(asked).toBeGreaterThanOrEqual(2);
  expect(seen.loads()).toBe(1);
});

// The first worker of a page stops reporting while `workerQuiet` is set, as a canvas stuck after a
// sleep stops painting.
const quietenFirstWorker = (page: Page, quiet: boolean) =>
  page.addInitScript((from) => {
    if (window.parent !== window) return;
    Object.assign(window, { workerQuiet: from });
    const Native = window.Worker;
    let made = 0;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (++made > 1) return;
        let handler: ((event: MessageEvent) => void) | null = null;
        Object.defineProperty(this, "onmessage", {
          get: () => handler,
          set: (next: (event: MessageEvent) => void) => {
            handler = next;
          },
        });
        this.addEventListener("message", (event) => {
          const quiet = (window as unknown as { workerQuiet: boolean }).workerQuiet;
          if (!quiet || (event.data as { type?: string }).type !== "stats") handler?.(event);
        });
      }
    } as typeof Worker;
  }, quiet);

const setVisibility = (page: Page, value: DocumentVisibilityState) =>
  page.evaluate((visibility) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);

test("a stage whose renderer goes quiet starts again, with one stream", async ({ page, ui }) => {
  await ui.open("ready");
  await pictureArrives(page, ui);
  await quietenFirstWorker(page, true);
  const seen = await watch(page);
  await page.reload();
  await pictureArrives(page, ui);
  expect(seen.loads()).toBe(1);
  expect(await seen.mostClients()).toBe(1);
});

test("a stage stuck after the page was away starts again by itself", async ({ page, ui }) => {
  test.setTimeout(60_000);
  await quietenFirstWorker(page, false);
  const seen = await watch(page);
  await ui.open("ready");
  await pictureArrives(page, ui);
  const before = seen.loads();
  const stuck = await canvas(page).elementHandle();
  await setVisibility(page, "hidden");
  await page.evaluate(() => Object.assign(window, { workerQuiet: true }));
  await setVisibility(page, "visible");
  await expect
    .poll(() => stuck?.evaluate((old) => old.isConnected), { timeout: 30_000 })
    .toBe(false);
  await expect
    .poll(async () => Number(await canvas(page).getAttribute("data-frames")))
    .toBeGreaterThan(0);
  await ui.picture();
  await expect(page.locator(".stage-away-card")).toHaveCount(0, { timeout: 15_000 });
  expect(seen.loads()).toBe(before);
});

// The client's socket as it reads, once its script has run.
const socketReads = (page: Page, readyState: number) =>
  expect
    .poll(() =>
      page
        .frameLocator("iframe.desktop-frame")
        .locator("body")
        .evaluate(() => (window as { selkiesTransport?: { readyState: number } }).selkiesTransport)
        .then((transport) => transport?.readyState)
        .catch(() => null),
    )
    .toBe(readyState);

test("returning to a socket that went silent while away takes a fresh client soon", async ({
  page,
  ui,
}) => {
  const { seen } = await reopen(page, ui, "stream-stall?stage=frame");
  await socketReads(page, 1);
  const silent = await page.locator("iframe.desktop-frame").elementHandle();
  await setVisibility(page, "hidden");
  await page.waitForTimeout(500);
  await expect.poll(() => silent?.evaluate((frame) => frame.isConnected)).toBe(true);
  await setVisibility(page, "visible");
  await pictureArrives(page, ui, 6_000);
  expect(await silent?.evaluate((frame) => frame.isConnected)).toBe(false);
  expect(seen.loads()).toBe(1);
  expect(await seen.mostClients()).toBe(1);
});

test("hiding the page while its socket connects lets it go, and returning starts afresh", async ({
  page,
  ui,
}) => {
  const { seen } = await reopen(page, ui, "stream-stall?stage=socket");
  await socketReads(page, 0);
  await setVisibility(page, "hidden");
  await expect(page.locator("iframe.desktop-frame")).toHaveCount(0);
  await page.waitForTimeout(500);
  await setVisibility(page, "visible");
  await pictureArrives(page, ui, 6_000);
  expect(seen.loads()).toBe(1);
});

test("a daemon that restarts during the connection is followed by a fresh ticket", async ({
  page,
  ui,
}) => {
  test.setTimeout(60_000);
  const { qa, seen } = await reopen(page, ui, "stream-stall?stage=socket");
  await expect(page.locator("iframe.desktop-frame")).toHaveCount(1);
  await qa("daemon/restart?ms=2000");
  await pictureArrives(page, ui);
  expect(seen.loads()).toBe(1);
  expect(await seen.mostClients()).toBe(1);
});

test("the curtain says so when no picture comes, and its Retry works", async ({ page, ui }) => {
  test.setTimeout(90_000);
  const { qa, seen } = await reopen(page, ui, "stream-stall?stage=frame&times=99");
  await expect(page.getByRole("heading", { name: "Connecting your screen" })).toBeVisible();
  const heading = page.getByRole("heading", { name: STUCK });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".curtain-act[data-progress]")).toHaveCount(0);
  for (const appearance of ["graphite", "midnight"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await ui.settle();
    await ui.still();
    await page.screenshot({ path: test.info().outputPath(`no-picture-${appearance}.png`) });
  }

  // The button works while the stream still fails, and it counts again from there.
  const before = seen.tickets.length;
  const retry = curtain(page).getByRole("button", { name: "Try again" });
  await retry.click();
  await expect.poll(() => seen.tickets.length).toBeGreaterThan(before);
  await expect(page.getByRole("heading", { name: "Connecting your screen" })).toBeVisible();
  await expect(heading).toBeVisible({ timeout: 30_000 });

  await qa("stream-stall?stage=none");
  await curtain(page).getByRole("button", { name: "Try again" }).click();
  await pictureArrives(page, ui, 15_000);
  expect(seen.loads()).toBe(1);
  expect(await seen.mostClients()).toBe(1);
});

test("a web browser that never comes up offers the desktop instead", async ({ page, ui }) => {
  test.setTimeout(60_000);
  const fixture = await ui.open("running");
  const qa = control(page, fixture.origin);
  await ui.picture();
  await qa("screen?to=browser");
  await qa("browser/restart?ms=600000");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connecting your screen" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The web browser isn't ready" })).toBeVisible({
    timeout: 30_000,
  });
  await curtain(page).getByRole("button", { name: "Show the desktop" }).click();
  await pictureArrives(page, ui);
});

test.describe("Chat", () => {
  test.use({ viewStyle: "chat" });

  test("the computer screen recovers its first connection too", async ({ page, ui }) => {
    test.skip(!isPhone(page), "A phone's computer screen is a place of its own");
    const fixture = await ui.open("running");
    const qa = control(page, fixture.origin);
    await qa("stream-stall?stage=socket");
    await page.reload();
    await page.waitForFunction(() => !window.location.hash.includes("token="));
    await openComputerScreen(page);
    await expect
      .poll(async () => Number(await canvas(page).getAttribute("data-frames")), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect(curtain(page)).toHaveCount(0);
  });
});
