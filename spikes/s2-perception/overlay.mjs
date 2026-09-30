import { readFileSync } from "node:fs";
import sharp from "sharp";

const [, , screenshotPng, stateJson, outPng, scaleArg = "1"] = process.argv;
const scale = Number(scaleArg);
const state = JSON.parse(readFileSync(stateJson, "utf8"));
const frames = [];
const walk = (node) => {
  if (!node || typeof node !== "object") return;
  const f = node.frame ?? node.bounds;
  if (f && Number.isFinite(f.x) && Number.isFinite(f.width ?? f.w)) {
    frames.push({ x: f.x, y: f.y, w: f.width ?? f.w, h: f.height ?? f.h, label: `${node.role ?? ""} ${node.name ?? ""}`.trim() });
  }
  for (const v of Object.values(node)) if (typeof v === "object") walk(v);
};
walk(state);
const meta = await sharp(screenshotPng).metadata();
const boxes = frames
  .map((f) => `<rect x="${f.x * scale}" y="${f.y * scale}" width="${f.w * scale}" height="${f.h * scale}" fill="none" stroke="#00b3ff" stroke-width="${scale}"/>`)
  .join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">${boxes}</svg>`;
await sharp(screenshotPng).composite([{ input: Buffer.from(svg) }]).toFile(outPng);
console.log(`${frames.length} frames drawn to ${outPng}`);
