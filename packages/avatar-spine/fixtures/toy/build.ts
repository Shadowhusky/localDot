import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { buildSkeleton, toyRig } from "@localdot/rig-gen";
import { toyBinding } from "../../src/toy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, "work");
const PACK = join(HERE, "pack");
const SPINE = "/Applications/Spine.app/Contents/MacOS/Spine";

type Rgba = [number, number, number, number];
type Painter = (x: number, y: number, w: number, h: number) => Rgba | null;

function png(width: number, height: number, paint: Painter): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++)
      raw.set(paint(x, y, width, height) ?? [0, 0, 0, 0], y * (width * 4 + 1) + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ellipse =
  (color: Rgba, sx = 1, sy = 1): Painter =>
  (x, y, w, h) => {
    const dx = (x + 0.5 - w / 2) / ((w / 2) * sx);
    const dy = (y + 0.5 - h / 2) / ((h / 2) * sy);
    return dx * dx + dy * dy <= 1 ? color : null;
  };
const rect =
  (color: Rgba): Painter =>
  () =>
    color;
// Image y runs downwards: a positive curve lifts the ends (a smile), a negative one arches.
const bar =
  (color: Rgba, thickness: number, curve = 0): Painter =>
  (x, y, w, h) => {
    const t = (x / w) * 2 - 1;
    const centre = h / 2 - curve * (t * t - 0.5) * h;
    return Math.abs(y - centre) <= thickness / 2 ? color : null;
  };

const SKIN: Rgba = [240, 222, 208, 255];
const HAIR: Rgba = [44, 72, 86, 255];
const DARK: Rgba = [24, 26, 32, 255];
const IRIS: Rgba = [70, 110, 130, 255];
const PAINTERS: Record<string, Painter> = {
  "back-hair": ellipse(HAIR),
  torso: rect([38, 52, 92, 255]),
  "torso-crossed": (x, y, w, h) =>
    Math.abs(y - h * 0.45 - (x - w / 2) * 0.3) < 14 ||
    Math.abs(y - h * 0.45 + (x - w / 2) * 0.3) < 14
      ? [220, 224, 230, 255]
      : [38, 52, 92, 255],
  tie: rect([180, 40, 50, 255]),
  face: ellipse(SKIN),
  blush: ellipse([232, 138, 160, 200]),
  "eye-white-l": ellipse([250, 250, 252, 255]),
  "eye-white-r": ellipse([250, 250, 252, 255]),
  "iris-l": ellipse(IRIS),
  "iris-r": ellipse(IRIS),
  "lash-l": bar(DARK, 4, -0.4),
  "lash-r": bar(DARK, 4, -0.4),
  nose: ellipse([214, 180, 168, 255], 0.5, 1),
  mouth: bar([150, 60, 70, 255], 3),
  "mouth-A": ellipse([110, 40, 52, 255], 0.8, 1),
  "mouth-I": ellipse([110, 40, 52, 255], 1, 0.3),
  "mouth-U": ellipse([110, 40, 52, 255], 0.4, 0.5),
  "mouth-E": ellipse([110, 40, 52, 255], 0.9, 0.6),
  "mouth-O": ellipse([110, 40, 52, 255], 0.55, 0.9),
  "mouth-N": bar([150, 60, 70, 255], 2),
  "mouth-smile": bar([150, 60, 70, 255], 3, 0.5),
  "brow-l": bar(HAIR, 4, -0.3),
  "brow-r": bar(HAIR, 4, -0.3),
  "front-hair": (x, y, w, h) => (y < h * 0.45 || x < w * 0.18 || x > w * 0.82 ? HAIR : null),
};
for (const side of ["l", "r"]) {
  PAINTERS[`eye-${side}-state-half`] = (x, y, w, h) =>
    y > h * 0.35 && y < h * 0.6 && Math.abs(x - w / 2) < w * 0.4
      ? y < h * 0.42
        ? DARK
        : IRIS
      : null;
  PAINTERS[`eye-${side}-state-closed`] = bar(DARK, 3, 0.3);
  PAINTERS[`eye-${side}-state-smile`] = bar(DARK, 3, -0.6);
}

const rig = toyRig();
rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(WORK, "images"), { recursive: true });
for (const part of rig.parts) {
  const images = [{ image: part.image, bbox: part.bbox }, ...Object.values(part.variants ?? {})];
  for (const { image, bbox } of images) {
    const paint = PAINTERS[image];
    if (!paint) throw new Error(`no painter for toy image "${image}"`);
    writeFileSync(join(WORK, "images", `${image}.png`), png(bbox.w, bbox.h, paint));
  }
}
writeFileSync(join(WORK, "rig.json"), JSON.stringify(buildSkeleton(rig)));
const spine = (args: string[]) => {
  const result = spawnSync(SPINE, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`Spine ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
};
spine(["-i", join(WORK, "rig.json"), "-o", join(WORK, "rig.spine"), "-r"]);
rmSync(PACK, { recursive: true, force: true });
spine(["-i", join(WORK, "rig.spine"), "-o", PACK, "-e", "binary+pack"]);
writeFileSync(join(PACK, "binding.json"), JSON.stringify(toyBinding, null, 2));
writeFileSync(
  join(PACK, "pack.json"),
  JSON.stringify(
    {
      root: rig.root,
      frames: { glance: { x: 0, y: 60, w: 400, h: 540 }, watch: { x: 70, y: 90, w: 260, h: 300 } },
    },
    null,
    2,
  ),
);
copyFileSync(join(WORK, "rig.json"), join(PACK, "rig.json"));
rmSync(WORK, { recursive: true, force: true });
console.log(`toy pack written to ${PACK}`);
