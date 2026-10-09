import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Renders the Home Screen icons from the favicon. Run after the glyph changes:
// node apps/web/scripts/pwa-icons.mjs
const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const glyph = readFileSync(join(web, "src", "favicon.svg"));
const out = join(web, "public", "icons");
mkdirSync(out, { recursive: true });
const VOID = "#0a0b0d";

for (const [name, size] of [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
]) {
  await sharp(glyph, { density: 72 * (size / 32) })
    .resize(size, size)
    .flatten({ background: VOID })
    .png()
    .toFile(join(out, name));
}
// Maskable: the glyph inside the 80% safe zone on a full void square.
const inner = await sharp(glyph, { density: 72 * (410 / 32) })
  .resize(410, 410)
  .png()
  .toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: VOID } })
  .composite([{ input: inner, gravity: "center" }])
  .png()
  .toFile(join(out, "icon-maskable-512.png"));
