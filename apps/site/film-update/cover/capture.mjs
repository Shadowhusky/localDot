// Stills of the real app for the update covers, against the app's own UI fixture (never :4750):
//   node film-update/cover/capture.mjs [frame] [list] [chat] [studio]
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { startFixture, TOKEN } from "../capture/fixture.mjs";
import { routePicture } from "../capture/picture.mjs";
import { CLOCK_INIT } from "../capture/take.mjs";
import { conversationList, INVOICE, LANDLORD, routeWorld } from "../capture/world.mjs";

const asked = process.argv.slice(2);
const wanted = (name) => !asked.length || asked.includes(name);
const HERE = new URL("./", import.meta.url).pathname;
const UI = `${HERE}ui/`;
const FRAMES = `${HERE}ui/frames/`;
const NOW = "2026-11-05T09:38:00.000Z";
const MIN = 60_000;
const HOUR = 60 * MIN;
mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });

// Postbox for the cover: the inbox full, and the reply to Tom written to its sign-off, the caret still in
// it. Laid out at 1120 by 700 so it reads larger on the stage; the stage's picture is 2560 by 1600.
if (wanted("frame")) {
  const cover = await browser.newPage({
    viewport: { width: 1120, height: 700 },
    deviceScaleFactor: 2560 / 1120,
  });
  await cover.goto(new URL("./site/postbox-cover.html", import.meta.url).href);
  await cover.evaluate(() => document.fonts.ready);
  writeFileSync(`${FRAMES}landlord.jpg`, await cover.screenshot({ type: "jpeg", quality: 97 }));
  await cover.close();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  await page.goto(new URL("./site/postbox.html", import.meta.url).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    document.body.dataset.browser = "";
  });
  await page.evaluate(() => window.render({ front: "b", t: 9 }));
  writeFileSync(`${FRAMES}invoice.jpg`, await page.screenshot({ type: "jpeg", quality: 97 }));
  await page.evaluate(() => {
    delete document.body.dataset.browser;
    document.body.dataset.wallpaper = "";
  });
  writeFileSync(`${FRAMES}wallpaper.jpg`, await page.screenshot({ type: "jpeg", quality: 97 }));
  await page.close();
}

// The list's times as a morning's would read: the plumber earlier this morning, not at 03:38.
const RETIME = { "Find a plumber near me": 3 * HOUR + 10 * MIN };
// The landlord's reply is everyday work, so its dot wears no Designer beret: a beanie and scarf.
const LOOKS = { "Reply to the landlord": ["beanie", "scarf"] };
const CHOICE = { persona: "everyday", by: "auto", reason: "A quick email reply" };
const REPLY = {
  ...LANDLORD,
  look: LOOKS["Reply to the landlord"],
  events: [...LANDLORD.events.slice(0, 2), ["persona.choice", CHOICE], ...LANDLORD.events.slice(2)],
};
async function routeList(page, { hero, swap }) {
  await page.route("**/api/conversations", async (route) => {
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    const body = conversationList(await reply.json(), { now: NOW, hero, swap });
    for (const entry of body.conversations) {
      if (LOOKS[entry.title]) entry.look = LOOKS[entry.title];
      const ago = RETIME[entry.title];
      if (!ago) continue;
      const at = new Date(Date.parse(NOW) - ago).toISOString();
      for (const key of ["updatedAt", "lastActivityAt", "createdAt", "startedAt", "endedAt", "at"])
        if (typeof entry[key] === "string") entry[key] = at;
    }
    writeFileSync(`${UI}conversations.json`, JSON.stringify(body, null, 1));
    await route.fulfill({ json: body });
  });
}

async function open({ size, phone = false, view, hero, swap, env = {}, screens }) {
  const fixture = await startFixture({ QA_SCENARIO: "running", QA_PAST: "1", QA_NOW: NOW, ...env });
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: phone ? 3 : 2,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-GB",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.addInitScript((view) => {
    if (window.top !== window || localStorage.getItem("localdot.view-style.v1")) return;
    localStorage.setItem("localdot.view-style.v1", view);
    localStorage.setItem("localdot.appearance.v1", "midnight");
    localStorage.setItem(
      "localdot.onboarding.v1",
      JSON.stringify({ step: "welcome", dismissed: true }),
    );
  }, view);
  await page.addInitScript(CLOCK_INIT);
  await page.clock.install({ time: new Date(Date.parse(NOW) + 150_000) });
  await routeWorld(page, { now: NOW, hero, swap });
  await routeList(page, { hero, swap });
  await routePicture(page, { dir: FRAMES, screens });
  if (phone) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 62, right: 0, bottom: 34, left: 0 },
    });
  }
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await page.waitForFunction(() => !window.location.hash.includes("token="));
  await page.waitForTimeout(1500);
  return { page, fixture };
}

const done = async ({ page, fixture }) => {
  await page.context().close();
  await fixture.close();
};

const ON_POSTBOX = (name) => ({
  "owned-browser.js": `/film-frames/${name}.jpg`,
  "owned-preview.js": "/film-frames/wallpaper.jpg",
});

if (wanted("list")) {
  const run = await open({
    size: { width: 402, height: 874 },
    phone: true,
    view: "chat",
    hero: INVOICE,
    screens: ON_POSTBOX("invoice"),
  });
  await run.page.getByRole("heading", { name: "Conversations" }).waitFor();
  await run.page.waitForTimeout(2500);
  await run.page.screenshot({ path: `${UI}phone-list.png` });
  await done(run);
}

if (wanted("studio")) {
  const run = await open({
    size: { width: 1280, height: 800 },
    view: "studio",
    hero: REPLY,
    swap: { landlord: "invoice" },
    screens: ON_POSTBOX("landlord"),
  });
  await fetch(`${run.fixture.origin}/__qa/screen?to=browser`, { method: "POST" });
  await run.page.waitForTimeout(3000);
  const notice = run.page.getByText("dot moved to the web browser");
  if (await notice.count()) {
    await run.page.locator(".ui-toaster li button").first().click();
    await notice
      .waitFor({ state: "hidden", timeout: 8000 })
      .catch(() => console.log("notice stayed"));
  }
  await run.page.mouse.move(1150, 250);
  await run.page.waitForTimeout(4000);
  await run.page.screenshot({ path: `${UI}studio-landlord.png` });
  await done(run);
}

await browser.close();
console.log("done");
