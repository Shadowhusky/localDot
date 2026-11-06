// The sample web pages dot works in, painted to frames for the fixture's computer to show:
//   node film-update/capture/frames.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const ASSETS = new URL("../assets/", import.meta.url).pathname;
const FPS = 30;

// Breakout at work, from the first film's demo clip: a real round, from its start to the win.
const BREAKOUT = `${ASSETS}capture/frames/breakout`;
rmSync(BREAKOUT, { recursive: true, force: true });
mkdirSync(BREAKOUT, { recursive: true });
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-ss",
  "16",
  "-t",
  "21",
  "-i",
  `${ASSETS}clips/breakout.mp4`,
  "-q:v",
  "2",
  `${BREAKOUT}/%04d.jpg`,
]);

const SITE = new URL("./site/postbox.html", import.meta.url).href;
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});
await page.goto(SITE);
await page.evaluate(() => document.fonts.ready);

async function paint(name, seconds, state) {
  const dir = `${ASSETS}capture/frames/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < Math.round(seconds * FPS); i++) {
    await page.evaluate((s) => window.render(s), state(i / FPS));
    const shot = await page.screenshot({ type: "jpeg", quality: 95 });
    writeFileSync(`${dir}/${String(i + 1).padStart(4, "0")}.jpg`, shot);
  }
  console.log(name, seconds * FPS);
}

await page.evaluate(() => {
  document.body.dataset.wallpaper = "";
});
await paint("wallpaper", 1 / FPS, () => ({ front: "a", t: 0 }));
await page.evaluate(() => {
  delete document.body.dataset.wallpaper;
  document.body.dataset.browser = "";
});
await paint("landlord", 6, (t) => ({ front: "a", t }));
await paint("invoice", 6, (t) => ({ front: "b", t }));
for (const page of ["flights", "photos", "sheet", "dinner", "plumber", "downloads"])
  await paint(page, 4, (t) => ({ page, t }));

await browser.close();
console.log("done");
