// Studio on a desktop, takes of the real app against the UI fixture: Studio with the game, then the
// windows of the several-at-once scene, each a task of its own:
//   node film-update/capture/desktop.mjs [--draft] [view] [landlord] [invoice] [flights] ...
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { startFixture, TOKEN } from "./fixture.mjs";
import { paintEach, paintGame, routePicture } from "./picture.mjs";
import { CLOCK_INIT, Take } from "./take.mjs";
import { DOT_RUN, routeWorld, WORKERS } from "./world.mjs";

const draft = process.argv.includes("--draft");
const asked = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const wanted = (name) => !asked.length || asked.includes(name);
const scale = draft ? 1 : 2;
const ASSETS = new URL("../assets/", import.meta.url).pathname;
const NOW = "2026-11-05T09:38:00.000Z";
const FULL = { width: 1600, height: 900 };
const ROOM = { width: 1280, height: 720 };
// Studio as the app lays it out on a tablet, its stage over its chat, for the 9:16 cut.
const TABLET = { width: 760, height: 760 };
const M = JSON.parse(readFileSync(new URL("../cues.json", import.meta.url), "utf8")).marks;

const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });

async function open({ hero, swap, view, size, screens, onBrowser = true }) {
  const fixture = await startFixture({ QA_SCENARIO: "running", QA_PAST: "1", QA_NOW: NOW });
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: scale,
    colorScheme: "dark",
    reducedMotion: "no-preference",
    locale: "en-GB",
    timezoneId: "UTC",
    serviceWorkers: "block",
    // For the one style the takes add: no caret.
    bypassCSP: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.addInitScript((view) => {
    // Once, in the page itself: a screen's frame writing these again would reach the page as a change.
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
  await routePicture(page, { dir: `${ASSETS}capture/frames`, screens });
  await page.goto(`${fixture.origin}/#token=${TOKEN}`);
  await page.waitForFunction(() => !window.location.hash.includes("token="));
  // A text field's caret blinks on the browser's own clock, which the take doesn't step: none shows.
  await page.addStyleTag({ content: "* { caret-color: transparent !important; }" });
  await page.waitForTimeout(1500);
  // dot on the web browser, or on the desktop with the browser warmed up beside it.
  await fetch(`${fixture.origin}/__qa/${onBrowser ? "screen?to=browser" : "browser/start"}`, {
    method: "POST",
  });
  await page.waitForTimeout(2500);
  return { page, fixture };
}

const newTake = (page, name, from, fps = draft ? 30 : 60) =>
  new Take(page, {
    out: `${ASSETS}capture/studio-${name}${draft ? "-draft" : ""}.mp4`,
    scale,
    fps,
    from,
    preset: draft ? "veryfast" : "medium",
  });

const ON_GAME = {
  "owned-preview.js": "/film-frames/dotrun/0001.jpg",
  "owned-browser.js": "/film-frames/landlord/0001.jpg",
};

for (const [name, size] of [
  ["view", ROOM],
  ["view-tall", TABLET],
]) {
  if (!wanted(name)) continue;
  const { page, fixture } = await open({
    hero: DOT_RUN,
    view: "studio",
    size,
    onBrowser: false,
    screens: ON_GAME,
  });
  const from = M.desk - 0.1;
  const take = newTake(page, name, from);
  await take.begin(new Date(Date.parse(NOW) + 160_000));
  take.onFrame = paintGame(page);
  await take.until(M.hit + 0.1);
  await take.end();
  await page.context().close();
  await fixture.close();
}

// When each window comes: one, then two, then two, then three, faster each time.
const ARRIVE = [M.several, M.w4, M.w4, M.w6, M.w6, M.w9, M.w9, M.w9];

for (const [i, [name, hero, frames]] of WORKERS.entries()) {
  if (!wanted(name)) continue;
  const { page, fixture } = await open({
    hero,
    swap: { landlord: "dotRun" },
    view: "studio",
    size: FULL,
    screens: {
      "owned-browser.js": `/film-frames/${frames}/0001.jpg`,
      "owned-preview.js": "/film-frames/wallpaper/0001.jpg",
    },
  });
  const from = ARRIVE[i] - 0.1;
  const take = newTake(page, name, from, 30);
  await take.begin(new Date(Date.parse(NOW) + 160_000));
  // The work is under way before its window first shows, so it never comes up blank.
  take.onFrame = paintEach(page, "browser", frames, {
    from: from - 1,
    count: frames === "landlord" || frames === "invoice" ? 180 : 120,
  });
  await take.until(M.hit + 0.1);
  await take.end();
  await page.context().close();
  await fixture.close();
}

await browser.close();
console.log("done");
