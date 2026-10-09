import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { charts } from "./charts.mjs";
import { capabilities, safety, system, taskLoop } from "./drawings.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const OUT = new URL("../readme/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const only = process.argv.slice(2);
const drawings = { capabilities, system, "task-loop": taskLoop, safety, ...charts };
const browser = await chromium.launch();
// The PNG only stands in where the SVG can't show. Sheets are drawn about 1.7x wider than a README
// column, so two thirds still fills it, and the paper grain stays under about 400 kB.
const page = await browser.newPage({ deviceScaleFactor: 2 / 3 });
for (const [name, draw] of Object.entries(drawings)) {
  if (only.length && !only.includes(name)) continue;
  const { sheet, title } = draw();
  const svg = sheet.svg(title);
  writeFileSync(new URL(`${name}.svg`, OUT), svg);
  await page.setViewportSize({ width: sheet.width, height: sheet.height });
  await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`);
  const png = new URL(`${name}.png`, OUT).pathname;
  await page.screenshot({ path: png });
  spawnSync("pngquant", [
    "--force",
    "--skip-if-larger",
    "--quality",
    "60-85",
    "--output",
    png,
    png,
  ]);
  console.log(`${name}: ${sheet.width}x${sheet.height}, ${Math.round(svg.length / 1024)} kB svg`);
}
await browser.close();
