import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { charts } from "./charts.mjs";
import {
  capabilities,
  capabilitiesMobile,
  safety,
  safetyMobile,
  system,
  systemMobile,
  taskLoop,
  taskLoopMobile,
} from "./drawings.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const OUT = new URL("../readme/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const only = process.argv.slice(2);
const drawings = {
  capabilities,
  system,
  "task-loop": taskLoop,
  safety,
  "capabilities-mobile": capabilitiesMobile,
  "system-mobile": systemMobile,
  "task-loop-mobile": taskLoopMobile,
  "safety-mobile": safetyMobile,
  ...charts,
};
const browser = await chromium.launch();
// Desktop PNGs are fallbacks for large SVG sheets. Phone fallbacks use 2× resolution.
for (const [name, draw] of Object.entries(drawings)) {
  if (only.length && !only.includes(name)) continue;
  const page = await browser.newPage({ deviceScaleFactor: name.endsWith("-mobile") ? 2 : 2 / 3 });
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
  await page.close();
  console.log(`${name}: ${sheet.width}x${sheet.height}, ${Math.round(svg.length / 1024)} kB svg`);
}
await browser.close();
