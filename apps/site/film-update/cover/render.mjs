// Renders the covers from compose.html at twice their size, then down to the exact delivery size;
// deliver.sh takes them from out/draft:
//   node film-update/cover/render.mjs [douyin-zh] [rednote-zh] [landscape-zh] [landscape-en] [--guides]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "@playwright/test";
import { FORMATS } from "./formats.js";

const FILM = new URL("../", import.meta.url).pathname;
const HERE = new URL("./", import.meta.url).pathname;
const OUT = `${HERE}out/`;
const JOBS = {
  "douyin-zh": ["douyin", "zh", "douyin-9x16-zh"],
  "rednote-zh": ["rednote", "zh", "rednote-3x4-zh"],
  "landscape-zh": ["landscape", "zh", "landscape-zh"],
  "landscape-en": ["landscape", "en", "landscape-en"],
};
const args = process.argv.slice(2);
const guides = args.includes("--guides");
const asked = args.filter((a) => !a.startsWith("--"));
const jobs = asked.length ? asked : Object.keys(JOBS);
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};
const SCALE = 2;

mkdirSync(`${OUT}draft`, { recursive: true });
const browser = await chromium.launch();
for (const job of jobs) {
  const [f, lang, name] = JOBS[job];
  const { w, h } = FORMATS[f];
  const page = await browser.newPage({
    viewport: { width: w, height: h },
    deviceScaleFactor: SCALE,
  });
  page.on("console", (m) => m.type() === "error" && console.log(job, m.text()));
  page.on("pageerror", (e) => console.log(job, e.message));
  await page.route("http://cover.local/**", (route) => {
    const path = join(FILM, new URL(route.request().url()).pathname);
    if (!existsSync(path)) return route.fulfill({ status: 404, body: "" });
    route.fulfill({
      contentType: TYPES[extname(path)] ?? "application/octet-stream",
      body: readFileSync(path),
    });
  });
  await page.goto(
    `http://cover.local/cover/compose.html?f=${f}&lang=${lang}${guides ? "&guides" : ""}`,
  );
  await page.waitForSelector("body[data-ready]", { timeout: 15000 });
  await page.waitForTimeout(300);
  const big = `${OUT}draft/${name}@2x.png`;
  await page.locator("#canvas").screenshot({ path: big });
  const small = `${OUT}draft/${name}${guides ? "-guides" : ""}.png`;
  execFileSync("magick", [big, "-filter", "Lanczos", "-resize", `${w}x${h}!`, "-strip", small]);
  console.log(job, small);
  await page.close();
}
await browser.close();
