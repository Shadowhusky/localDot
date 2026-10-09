import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { charts } from "./charts.mjs";
import { safety, system, taskLoop } from "./drawings.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const OUT = new URL("../readme/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const only = process.argv.slice(2);
const drawings = { system, "task-loop": taskLoop, safety, ...charts };
const browser = await chromium.launch();
// The sheets are drawn about 1.7x wider than a README column, so 1x is already sharp there.
const page = await browser.newPage({ deviceScaleFactor: 1 });
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
    "70-92",
    "--output",
    png,
    png,
  ]);
  console.log(`${name}: ${sheet.width}x${sheet.height}, ${Math.round(svg.length / 1024)} kB svg`);
}
await browser.close();
