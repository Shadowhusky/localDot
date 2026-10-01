import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

export const TARGETS = [
  { label: "Alpha", x: 120, y: 140, w: 180, h: 64 },
  { label: "Gamma", x: 900, y: 610, w: 180, h: 64 },
  { label: "Delta", x: 560, y: 380, w: 160, h: 56 },
  { label: "Omega", x: 1040, y: 90, w: 150, h: 52 },
];
export const centre = (t) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 });

const buttons = TARGETS.map((t) =>
  `<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" rx="10" fill="#e9eef5" stroke="#5b6b80"/>` +
  `<text x="${t.x + t.w / 2}" y="${t.y + t.h / 2 + 8}" font-family="Helvetica" font-size="24" text-anchor="middle" fill="#1b2330">${t.label}</text>`,
).join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#ffffff"/>${buttons}</svg>`;

if (process.argv[1]?.endsWith("probe-image.mjs")) {
  mkdirSync("out", { recursive: true });
  writeFileSync("out/probe.png", await sharp(Buffer.from(svg)).png().toBuffer());
  console.log("wrote out/probe.png");
}
