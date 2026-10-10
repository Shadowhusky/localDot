// Compact, single-column figures: type remains readable in a 288 px README column.
// Run from the repo root: node docs/diagrams/readme-cards.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const out = new URL("../readme/", import.meta.url);
const text = (x, y, value, size = 23, weight = 400, fill = "#24292f") =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}">${value}</text>`;
const frame = (title, height, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="${height}" viewBox="0 0 440 ${height}" role="img" aria-label="${title}"><title>${title}</title><rect width="440" height="${height}" rx="20" fill="#f6f8fa"/><g font-family="system-ui, -apple-system, sans-serif">${body}</g></svg>`;
const box = (y, title, lines) =>
  `<rect x="24" y="${y}" width="392" height="112" rx="14" fill="white" stroke="#b6c3ce"/>${text(44, y + 34, title, 25, 650)}${lines.map((line, i) => text(44, y + 64 + i * 28, line, 22, 400, "#465565")).join("")}`;
const arrow = (y) =>
  `<path d="M220 ${y}v22m-7-7 7 7 7-7" fill="none" stroke="#087b9d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
const architecture = frame(
  "How localDot works",
  632,
  text(24, 44, "How localDot works", 28, 700) +
    box(68, "1. You ask", "Browser on your computer|or phone".split("|")) +
    arrow(190) +
    box(224, "2. dot works", "Isolated desktop, browser|and agent containers".split("|")) +
    arrow(346) +
    box(
      380,
      "3. Requests are checked",
      "Network gate and local vault|Credentials stay out of the model".split("|"),
    ) +
    arrow(502) +
    text(220, 560, "Your model, websites and apps", 23, 600).replace(
      'x="220"',
      'x="220" text-anchor="middle"',
    ) +
    text(220, 599, "Screenshots and task text go to your model.", 20, 400, "#465565").replace(
      'x="220"',
      'x="220" text-anchor="middle"',
    ),
);
let bars = text(24, 44, "Measured improvements", 28, 700);
const rows = [
  {
    y: 84,
    title: "Screenshots · 7 tasks",
    before: 107,
    after: 50,
    unit: "",
    note: "Same 51 model turns",
  },
  {
    y: 266,
    title: "Export · 2-minute recording",
    before: 25.7,
    after: 5.9,
    unit: " s",
    note: "Old exporter → Quality preset",
  },
  {
    y: 448,
    title: "Key press → screen",
    before: 1371,
    after: 116,
    unit: " ms",
    note: "5 Mbps link · 80 ms round trip",
  },
];
for (const row of rows) {
  bars += text(24, row.y, row.title, 24, 650);
  for (const [i, label, value, color] of [
    [0, "Before", row.before, "#647485"],
    [1, "After", row.after, "#087b9d"],
  ]) {
    const y = row.y + 24 + i * 40;
    bars +=
      text(24, y + 21, label, 21) +
      `<rect x="110" y="${y}" width="${(230 * value) / row.before}" height="27" rx="4" fill="${color}"/>` +
      text(350, y + 22, `${value}${row.unit}`, 20, 600);
  }
  bars += text(24, row.y + 127, row.note, 21, 400, "#465565");
}
const performance = frame("Measured before and after results on an M3 Ultra", 610, bars);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  for (const [name, svg, height] of [
    ["architecture-compact", architecture, 632],
    ["performance-compact", performance, 610],
  ]) {
    writeFileSync(new URL(`${name}.svg`, out), svg);
    await page.setViewportSize({ width: 440, height });
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    await page.screenshot({ path: new URL(`${name}.png`, out).pathname });
  }
} finally {
  await browser.close();
}
