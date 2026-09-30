import { readFileSync } from "node:fs";
import sharp from "sharp";

// usage: node markers.mjs <screenshot.png> <state.json> [scale]
// Compares each "marker <colour>" element's frame (times scale) with that colour's pixel box.
const [, , screenshotPng, stateJson, scaleArg = "1"] = process.argv;
const scale = Number(scaleArg);
const colours = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255] };
const { data, info } = await sharp(screenshotPng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const box = ([r, g, b]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) > 24) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};
const elements = JSON.parse(readFileSync(stateJson, "utf8")).structuredContent.elements;
for (const [name, rgb] of Object.entries(colours)) {
  const el = elements.find((e) => e.label === `marker ${name}`);
  const px = box(rgb);
  if (!el?.frame || !px) {
    console.log(`${name}: frame ${JSON.stringify(el?.frame ?? null)} pixels ${JSON.stringify(px)}`);
    continue;
  }
  const f = { x: el.frame.x * scale, y: el.frame.y * scale, w: el.frame.w * scale, h: el.frame.h * scale };
  console.log(`${name}: ${el.role} frame ${JSON.stringify(el.frame)} x${scale} vs pixels ${JSON.stringify(px)} ` +
    `-> dx ${f.x - px.x} dy ${f.y - px.y} dw ${f.w - px.w} dh ${f.h - px.h}`);
}
