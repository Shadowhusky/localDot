// V0-2: writes a toy Spine 4.3 skeleton (JSON + images) that proves additive head-turn sliders
// deforming one mesh, plus a physics constraint on a hair bone.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const IMAGES = join(OUT, "images");
const SIZE = 256;
const GRID = 5;
const HALF = SIZE / 2;
const TURN_PX = 28;

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function paint(width, height, colorAt) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set(colorAt(x, y), (y * width + x) * 4);
  }
  return png(width, height, rgba);
}

// A face with a visible grid, so parallax and seams are easy to judge on the contact sheet.
const face = paint(SIZE, SIZE, (x, y) => {
  const dx = x - HALF;
  const dy = y - HALF;
  const r = Math.hypot(dx, dy);
  if (r > HALF - 2) return [0, 0, 0, 0];
  if (Math.hypot(dx + 40, dy + 20) < 14 || Math.hypot(dx - 40, dy + 20) < 14) return [20, 22, 28, 255];
  if (Math.abs(dy - 45) < 5 && Math.abs(dx) < 30) return [190, 70, 80, 255];
  if (Math.abs(dx) < 4 && dy > -5 && dy < 20) return [200, 150, 140, 255];
  if (x % 32 < 2 || y % 32 < 2) return [180, 200, 215, 255];
  return [240, 220, 205, 255];
});
const hair = paint(32, 120, (x, y) => (x > 3 && x < 28 ? [60, 90, 120, 255] : [0, 0, 0, 0]));

// Hull vertices first, in order around the edge, then the interior ones (Spine's mesh layout).
const cells = [];
for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) cells.push([i, j]);
const onEdge = ([i, j]) => i === 0 || j === 0 || i === GRID - 1 || j === GRID - 1;
const ring = [];
for (let i = 0; i < GRID; i++) ring.push([i, 0]);
for (let j = 1; j < GRID; j++) ring.push([GRID - 1, j]);
for (let i = GRID - 2; i >= 0; i--) ring.push([i, GRID - 1]);
for (let j = GRID - 2; j > 0; j--) ring.push([0, j]);
const order = [...ring, ...cells.filter((c) => !onEdge(c))];
const indexOf = new Map(order.map(([i, j], k) => [`${i},${j}`, k]));
const uv = ([i, j]) => [i / (GRID - 1), j / (GRID - 1)];
const uvs = order.flatMap(uv);
// Spine is y-up; texture v runs down.
const vertices = order.flatMap((c) => {
  const [u, v] = uv(c);
  return [(u - 0.5) * SIZE, (0.5 - v) * SIZE];
});
const triangles = [];
for (let j = 0; j < GRID - 1; j++) {
  for (let i = 0; i < GRID - 1; i++) {
    const a = indexOf.get(`${i},${j}`);
    const b = indexOf.get(`${i + 1},${j}`);
    const c = indexOf.get(`${i},${j + 1}`);
    const d = indexOf.get(`${i + 1},${j + 1}`);
    triangles.push(a, c, b, b, c, d);
  }
}

// 2.5D parallax: the middle of the face travels, the rim stays put, like a turning sphere.
const turnDeform = (axis, amount) =>
  order.flatMap((c) => {
    const [u, v] = uv(c);
    const bulge = Math.cos(Math.PI * (u - 0.5)) * Math.cos(Math.PI * (v - 0.5));
    const shift = TURN_PX * amount * bulge;
    return axis === "x" ? [shift, 0] : [0, shift];
  });
const turnAnimation = (axis) => ({
  attachments: {
    default: {
      face: {
        face: {
          deform: [
            { time: 0, vertices: turnDeform(axis, -1) },
            { time: 0.5 },
            { time: 1, vertices: turnDeform(axis, 1) },
          ],
        },
      },
    },
  },
});

const skeleton = {
  skeleton: { spine: "4.3.26", x: -HALF, y: -HALF, width: SIZE, height: SIZE + 60, images: "./images/" },
  bones: [
    { name: "root" },
    { name: "head", parent: "root" },
    { name: "hair", parent: "head", x: 70, y: 90, rotation: -90, length: 110 },
  ],
  slots: [
    { name: "hair", bone: "hair", attachment: "hair" },
    { name: "face", bone: "head", attachment: "face" },
  ],
  constraints: [
    { name: "head-x", type: "slider", additive: true, time: 0.5, animation: "head-x" },
    { name: "head-y", type: "slider", additive: true, time: 0.5, animation: "head-y" },
    { name: "hair-physics", type: "physics", bone: "hair", rotate: 1, inertia: 0.5, strength: 100, damping: 0.85, mass: 1, gravity: 0 },
  ],
  skins: [
    {
      name: "default",
      attachments: {
        hair: { hair: { x: 55, rotation: 90, width: 32, height: 120 } },
        face: { face: { type: "mesh", uvs, triangles, vertices, hull: ring.length, width: SIZE, height: SIZE } },
      },
    },
  ],
  animations: { "head-x": turnAnimation("x"), "head-y": turnAnimation("y") },
};

mkdirSync(IMAGES, { recursive: true });
writeFileSync(join(IMAGES, "face.png"), face);
writeFileSync(join(IMAGES, "hair.png"), hair);
writeFileSync(join(OUT, "toy.json"), JSON.stringify(skeleton, null, 2));
console.log(`wrote toy.json: ${order.length} vertices, ${triangles.length / 3} triangles, hull ${ring.length}`);
