// Dot Run, the game in the film, built and drawn as the computer's screen shows it: the real browser
// window round it, from the first film's footage, with the game's page in it, a frame per film frame:
//   node film-update/capture/game.mjs [--draft]
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { deskLook, WINDOW_FRAMES } from "./picture.mjs";

const draft = process.argv.includes("--draft");
const ASSETS = new URL("../assets/", import.meta.url).pathname;
export const GAME = `${ASSETS}capture/dot-run`;
const WEB = new URL("../../../web/src", import.meta.url).pathname;

export async function buildGame() {
  await build({
    root: new URL("./site/dot-run", import.meta.url).pathname,
    base: "./",
    logLevel: "error",
    configFile: false,
    resolve: { alias: { "@app": WEB } },
    build: { outDir: GAME, emptyOutDir: true },
  });
  // The browser's own title bar, tabs and address, from the first film's footage of the game.
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    `${ASSETS}capture/frames/breakout/0001.jpg`,
    "-vf",
    "crop=1920:118:0:0",
    `${GAME}/chrome.png`,
  ]);
}

// Serves the built game to a page at http://game.film/.
export const serveGame = (page) =>
  page.route("http://game.film/**", (route) =>
    route.fulfill({ path: `${GAME}${new URL(route.request().url()).pathname}` }),
  );

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildGame();
  const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await serveGame(page);
  await page.goto("http://game.film/index.html?desk");
  while (!(await page.evaluate(() => window.ready))) await new Promise((r) => setTimeout(r, 100));
  const dir = `${ASSETS}capture/frames/dotrun`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const count = draft ? 3 : WINDOW_FRAMES;
  for (let i = 0; i < count; i++) {
    const seconds = draft ? i * 4 : i / 30;
    await page.evaluate(([s, look]) => window.render(s, look), [seconds, deskLook(seconds)]);
    const shot = await page.screenshot({ type: "jpeg", quality: 92 });
    writeFileSync(`${dir}/${String(i + 1).padStart(4, "0")}.jpg`, shot);
    if (i % 60 === 0) console.log("dot run", i);
  }
  await browser.close();
  console.log("done");
}
