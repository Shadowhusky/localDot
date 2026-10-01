import type { Box, RigDescription, VariantSpec } from "./types.ts";

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
const variants = (part: string, keys: string[], bbox: Box): Record<string, VariantSpec> =>
  Object.fromEntries(keys.map((k) => [k, { image: `${part}-${k}`, bbox }]));

export function toyRig(): RigDescription {
  return {
    name: "toy",
    canvas: { w: 400, h: 600 },
    root: { x: 200, y: 600 },
    images: "./images/",
    headTurn: { x: 24, y: 16 },
    bones: [
      { name: "body", at: { x: 200, y: 520 } },
      { name: "head", parent: "body", at: { x: 200, y: 350 } },
      { name: "head-back", parent: "head", at: { x: 200, y: 350 }, depth: -0.4 },
      { name: "features", parent: "head", at: { x: 200, y: 350 }, depth: 0.6 },
      { name: "head-front", parent: "head", at: { x: 200, y: 350 }, depth: 0.9 },
      { name: "iris-l", parent: "features", at: { x: 160, y: 240 } },
      { name: "iris-r", parent: "features", at: { x: 240, y: 240 } },
      { name: "brow-l", parent: "features", at: { x: 162, y: 206 } },
      { name: "brow-r", parent: "features", at: { x: 238, y: 206 } },
      { name: "hair-tip", parent: "head-front", at: { x: 200, y: 230 } },
    ],
    parts: [
      {
        name: "back-hair",
        bone: "head-back",
        image: "back-hair",
        bbox: box(90, 110, 220, 330),
        mesh: { cols: 4, rows: 6 },
      },
      {
        name: "torso",
        bone: "body",
        image: "torso",
        bbox: box(80, 400, 240, 200),
        variants: { crossed: { image: "torso-crossed", bbox: box(80, 400, 240, 200) } },
      },
      { name: "tie", bone: "body", image: "tie", bbox: box(190, 400, 20, 90) },
      {
        name: "face",
        bone: "head",
        image: "face",
        bbox: box(110, 140, 180, 220),
        mesh: { cols: 5, rows: 5, bulge: 0.5 },
      },
      { name: "blush", bone: "features", image: "blush", bbox: box(130, 270, 140, 30) },
      { name: "eye-white-l", bone: "features", image: "eye-white-l", bbox: box(140, 226, 40, 28) },
      { name: "eye-white-r", bone: "features", image: "eye-white-r", bbox: box(220, 226, 40, 28) },
      { name: "iris-l", bone: "iris-l", image: "iris-l", bbox: box(150, 228, 20, 24) },
      { name: "iris-r", bone: "iris-r", image: "iris-r", bbox: box(230, 228, 20, 24) },
      { name: "lash-l", bone: "features", image: "lash-l", bbox: box(136, 220, 48, 14) },
      { name: "lash-r", bone: "features", image: "lash-r", bbox: box(216, 220, 48, 14) },
      {
        name: "eye-l-state",
        bone: "features",
        image: "eye-l-state-half",
        bbox: box(136, 218, 48, 40),
        hidden: true,
        variants: variants("eye-l-state", ["half", "closed", "smile"], box(136, 218, 48, 40)),
      },
      {
        name: "eye-r-state",
        bone: "features",
        image: "eye-r-state-half",
        bbox: box(216, 218, 48, 40),
        hidden: true,
        variants: variants("eye-r-state", ["half", "closed", "smile"], box(216, 218, 48, 40)),
      },
      { name: "nose", bone: "features", image: "nose", bbox: box(194, 262, 12, 16) },
      {
        name: "mouth",
        bone: "features",
        image: "mouth",
        bbox: box(180, 292, 40, 14),
        variants: variants("mouth", ["A", "I", "U", "E", "O", "N", "smile"], box(176, 284, 48, 30)),
      },
      { name: "brow-l", bone: "brow-l", image: "brow-l", bbox: box(140, 201, 44, 10) },
      { name: "brow-r", bone: "brow-r", image: "brow-r", bbox: box(216, 201, 44, 10) },
      {
        name: "front-hair",
        bone: "head-front",
        image: "front-hair",
        bbox: box(100, 110, 200, 190),
        mesh: { cols: 4, rows: 5 },
        tip: { bone: "hair-tip", from: 0.4 },
      },
    ],
    physics: [{ bone: "hair-tip", x: 1, inertia: 0.5, strength: 100, damping: 0.85, mass: 1 }],
  };
}
