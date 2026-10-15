// The demo's window as the site shows it, for the film: Breakout at work, the same moment with the
// visitor in control, and where the Theatre, the dock, dot's line and Hand back are in it. The film
// draws dot and its line itself. Against the site's
// dev server:
//   SITE_URL=http://127.0.0.1:4321 node film/capture.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const origin = process.env.SITE_URL || "http://127.0.0.1:4321";
const out = new URL("./assets/app/", import.meta.url);
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
});
await page.goto(origin, { waitUntil: "networkidle" });
// The page opens still on the task picker: Breakout is the first task.
await page.locator(".site-app .site-demo").first().click();
// The film puts its own dot in the dock, and frames the window itself.
await page.addStyleTag({
  content:
    "#scene, .narrator-dock > *, .site-app .narration { visibility: hidden !important; } .hero { border-radius: 0 !important; box-shadow: none !important; }",
});
await page.waitForFunction(
  () => (document.querySelector(".site-video")?.currentTime ?? 0) >= 19.5,
  null,
  {
    timeout: 90000,
  },
);

const box = (selector) =>
  page.evaluate((selector) => {
    const r = document.querySelector(selector)?.getBoundingClientRect();
    const o = document.querySelector(".hero").getBoundingClientRect();
    return r ? { x: r.x - o.x, y: r.y - o.y, w: r.width, h: r.height } : null;
  }, selector);

const hero = page.locator(".hero");
await hero.screenshot({ path: new URL("work.png", out).pathname });
const size = await page.evaluate(() => {
  const r = document.querySelector(".hero").getBoundingClientRect();
  return { w: r.width, h: r.height };
});
const layout = {
  size,
  theatre: await box(".site-app .stage-frame video"),
  dock: await box(".site-app .narrator-dock"),
  line: {
    ...(await box(".site-app .narration")),
    text: await page.evaluate(() =>
      document.querySelector(".site-app .narration-line")?.textContent?.replace(/^dot: /, ""),
    ),
  },
};

await page.evaluate(() => document.querySelector('[data-act="control"]')?.click());
await page.waitForTimeout(900);
await hero.screenshot({ path: new URL("yours.png", out).pathname });
layout.handBack = await page.evaluate(() => {
  const button = [...document.querySelectorAll(".site-app button")].find(
    (b) => b.textContent?.trim() === "Hand back",
  );
  const r = button?.getBoundingClientRect();
  const o = document.querySelector(".hero").getBoundingClientRect();
  return r ? { x: r.x - o.x, y: r.y - o.y, w: r.width, h: r.height } : null;
});

await writeFile(new URL("layout.json", out), JSON.stringify(layout, null, 2));
console.log(JSON.stringify(layout));
await browser.close();
