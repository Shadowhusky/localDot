import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WEAR_SLOT, Wearable } from "@localdot/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { DotAvatar } from "../DotAvatar.tsx";
import { DotEngine, type DotPose } from "../engine/engine.ts";
import { GAZE_MAX, R } from "../engine/sphere.ts";
import { type Lod, type Reaction, STATE_NAMES } from "../engine/states.ts";
import type { DotTool } from "../engine/tools.ts";
import { type EyeGeometry, eyeGeometry } from "./eye-geometry.ts";
import { LOD_DETAIL } from "./lod.ts";
import { crown, eyeScaleLimit, type FaceTurn, platePivot, plateTransform } from "./wearables.ts";

type Point = readonly [number, number];

const PLATE_PX = 448;
const PER_UNIT = PLATE_PX / 64;
const LODS: readonly Lod[] = ["badge", "presence", "glance", "hero"];
// Sizes a still dot is shown at, one for each level of detail and the chooser's.
const STILL_SIZES = [24, 32, 40, 72, 96];
const REACTIONS: readonly Reaction[] = [
  "success",
  "error",
  "acknowledged",
  "live",
  "dispatch",
  "wince",
];
const TOOLS: readonly DotTool[] = ["looking", "inspecting"];

// What eyewear does with the eyes behind it: hides them, or holds them in a clear lens.
const EYEWEAR: Partial<Record<Wearable, { hides: boolean; eyes: readonly (0 | 1)[] }>> = {
  sunglasses: { hides: true, eyes: [0, 1] },
  "heart-glasses": { hides: true, eyes: [0, 1] },
  "round-glasses": { hides: false, eyes: [0, 1] },
  monocle: { hides: false, eyes: [1] },
};
const OPAQUE = 0.9;
const SOLID = 0.5;
// A shadow a plate carries is not what hides an eye; the wearable itself is.
const IN_THE_WAY = 0.7;
// How much of an eye's area something else worn may lie over, at its largest and furthest from rest.
const EYE_SHARE = 0.1;
// How far past the ball's outline eyewear may reach at the far end of a look.
const OVER_BALL = 1;

interface Plate {
  alpha: Uint8Array;
  // Pixels no clear path reaches from the plate's edge: inside a rim, or under the wearable.
  held: Uint8Array;
}

const plates = new Map<Wearable, Plate>();

async function readPlate(name: Wearable): Promise<Plate> {
  const file = fileURLToPath(new URL(`../plates/wear-${name}-${PLATE_PX}.webp`, import.meta.url));
  const { data } = await sharp(file)
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alpha = new Uint8Array(data);
  const held = new Uint8Array(alpha.length).fill(1);
  const stack: number[] = [];
  const visit = (at: number) => {
    if (held[at] && (alpha[at] ?? 0) < SOLID * 255) {
      held[at] = 0;
      stack.push(at);
    }
  };
  for (let i = 0; i < PLATE_PX; i++) {
    visit(i);
    visit(PLATE_PX * (PLATE_PX - 1) + i);
    visit(PLATE_PX * i);
    visit(PLATE_PX * i + PLATE_PX - 1);
  }
  while (stack.length) {
    const at = stack.pop() ?? 0;
    const x = at % PLATE_PX;
    if (x > 0) visit(at - 1);
    if (x < PLATE_PX - 1) visit(at + 1);
    if (at >= PLATE_PX) visit(at - PLATE_PX);
    if (at < PLATE_PX * (PLATE_PX - 1)) visit(at + PLATE_PX);
  }
  return { alpha, held };
}

const pixel = ([x, y]: Point) => {
  const px = Math.floor(x * PER_UNIT);
  const py = Math.floor(y * PER_UNIT);
  return px < 0 || py < 0 || px >= PLATE_PX || py >= PLATE_PX ? -1 : py * PLATE_PX + px;
};
const alphaAt = (plate: Plate, p: Point) => {
  const at = pixel(p);
  return at < 0 ? 0 : (plate.alpha[at] ?? 0) / 255;
};
const heldAt = (plate: Plate, p: Point) => {
  const at = pixel(p);
  return at >= 0 && plate.held[at] === 1;
};

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function parseTransform(css: string, k = 1): Matrix {
  const matrix = css.match(/matrix\(([^)]+)\)/);
  if (matrix) {
    const [a = 1, b = 0, c = 0, d = 1, dx = 0, dy = 0] = (matrix[1] ?? "").split(",").map(Number);
    return [a, b, c, d, dx / k, dy / k];
  }
  const roll = css.match(/rotate\(([-\d.]+)deg\)/);
  if (!roll) return IDENTITY;
  const r = (Number(roll[1]) * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
}

// From the frame, where something shows, back to the plate's own frame; and on from the plate.
function toPlate(name: Wearable, m: Matrix, [x, y]: Point): Point {
  const [px, py] = platePivot(name);
  const [a, b, c, d, dx, dy] = m;
  const u = x - (32 + px) - dx;
  const v = y - (32 + py) - dy;
  const det = a * d - b * c;
  return [32 + px + (d * u - c * v) / det, 32 + py + (a * v - b * u) / det];
}

function fromPlate(name: Wearable, m: Matrix, [x, y]: Point): Point {
  const [px, py] = platePivot(name);
  const [a, b, c, d, dx, dy] = m;
  const u = x - (32 + px);
  const v = y - (32 + py);
  return [32 + px + a * u + c * v + dx, 32 + py + b * u + d * v + dy];
}

function capsule(cx: number, cy: number, hw: number, hh: number, count = 40): Point[] {
  const r = Math.min(hw, hh);
  const points: Point[] = [[cx, cy]];
  for (let k = 0; k < count; k++) {
    const a = (2 * Math.PI * k) / count;
    const [cos, sin] = [Math.cos(a), Math.sin(a)];
    points.push([
      cx + (hw - r) * Math.sign(cos) + r * cos,
      cy + (hh - r) * Math.sign(sin) + r * sin,
    ]);
  }
  return points;
}

const inFrame = (g: EyeGeometry, points: readonly Point[]): Point[] =>
  points.map(([x, y]) => [g.a * x + g.c * y + g.ex, g.b * x + g.d * y + g.ey]);

// Where an open eye is, evenly over its area.
function eyeArea(g: EyeGeometry): Point[] {
  const points: Point[] = [];
  const r = Math.min(g.hw, g.hh);
  for (let i = -8; i <= 8; i++)
    for (let j = -8; j <= 8; j++) {
      const x = (i / 8) * g.hw;
      const y = (j / 8) * g.hh;
      const beyond = Math.max(0, Math.abs(y) - (g.hh - r));
      if (Math.hypot(x, beyond) <= r) points.push([x, y]);
    }
  return inFrame(g, points);
}

// The edges of all an eye draws: its capsule, and the arcs a happy or a sleeping eye morphs into.
function eyePoints(g: EyeGeometry): Point[] {
  const local: Point[] = g.capsule > 0.01 ? capsule(0, 0, g.hw, g.hh) : [];
  for (const arc of [g.happy, g.closed]) {
    if (arc.opacity <= 0.01) continue;
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const x = -arc.aw + 2 * arc.aw * t;
      const y = arc.y * (1 - 2 * t * (1 - t)) + arc.peak * 2 * t * (1 - t);
      local.push([x, y - arc.stroke / 2], [x, y + arc.stroke / 2]);
    }
  }
  return inFrame(g, local);
}

const key = (p: DotPose) =>
  [
    p.gaze.x.toFixed(1),
    p.gaze.y.toFixed(1),
    p.roll.toFixed(1),
    ...p.eyes.flatMap((e) => [
      e.scale.toFixed(2),
      e.sy.toFixed(2),
      e.happy.toFixed(1),
      e.closed.toFixed(1),
    ]),
  ].join();

// What the real engine does at a level of detail: every state, at rest and looking to the far ends of
// its range, every reaction, and the tools that change an eye's size.
function posesAt(lod: Lod): DotPose[] {
  const seen = new Map<string, DotPose>();
  const keep = (engine: DotEngine, from: number, to: number, step: number) => {
    for (let t = from; t <= to; t += step) {
      const pose = engine.pose(t);
      seen.set(key(pose), pose);
    }
  };
  const start = (state: (typeof STATE_NAMES)[number]) =>
    new DotEngine({ seed: 11, t: 0, state, lod, reducedMotion: false, control: false });
  const foci = [
    null,
    ...[-1, 1].flatMap((x) => [-1, 1].map((y) => ({ x: x * GAZE_MAX.x, y: y * GAZE_MAX.y }))),
  ];
  for (const state of STATE_NAMES)
    for (const focus of foci) {
      const engine = start(state);
      if (focus) engine.setFocus(focus, 0);
      keep(engine, 0, 4000, 200);
    }
  for (const reaction of REACTIONS) {
    const engine = start("idle");
    engine.react(reaction, 500);
    keep(engine, 500, 2500, 30);
  }
  for (const tool of TOOLS) {
    const engine = start("observing");
    engine.setTool(tool, 0);
    keep(engine, 0, 5000, 100);
  }
  return [...seen.values()];
}

const POSES = new Map(LODS.map((lod) => [lod, posesAt(lod)]));
const LOOKS: readonly FaceTurn[] = [-1, 0, 1].flatMap((x) =>
  [-1, 0, 1].flatMap((y) =>
    [-5, 0, 5].map((roll) => ({ gaze: { x: x * GAZE_MAX.x, y: y * GAZE_MAX.y }, roll })),
  ),
);

const summary = (faults: readonly string[]) =>
  faults.length > 8 ? [...faults.slice(0, 8), `and ${faults.length - 8} more`] : faults;

// How eyewear fails to cover these points on its plate: a point it should hide that shows, or one it
// should hold in a lens that falls outside its rim.
function uncovered(name: Wearable, m: Matrix, points: readonly Point[]): Point | undefined {
  const plate = plates.get(name);
  const fit = EYEWEAR[name];
  if (!plate || !fit) return points[0];
  return points.find((p) => {
    const on = toPlate(name, m, p);
    return fit.hides ? alphaAt(plate, on) < OPAQUE : !heldAt(plate, on);
  });
}

const stillDot = (name: Wearable, size: number, seed: string) =>
  renderToStaticMarkup(createElement(DotAvatar, { size, wearables: [name], seed }));

function stillEyes(html: string): Point[][] {
  return [
    ...html.matchAll(
      /<rect class="dot-eye" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g,
    ),
  ].map(([, x, y, w, h]) => {
    const [hw, hh] = [Number(w) / 2, Number(h) / 2];
    return capsule(Number(x) + hw, Number(y) + hh, hw, hh);
  });
}

function stillPlate(html: string, name: Wearable, size: number): Matrix {
  const img = html.match(new RegExp(`<img[^>]*data-wear="${name}"[^>]*>`))?.[0] ?? "";
  return parseTransform(img.match(/transform:([^;"]+)/)?.[1] ?? "", size / 64);
}

beforeAll(async () => {
  await Promise.all(
    Wearable.options.map(async (name) => {
      plates.set(name, await readPlate(name));
    }),
  );
});

describe.each(Object.keys(EYEWEAR) as Wearable[])("%s on the face", (name) => {
  const eyes = EYEWEAR[name]?.eyes ?? [];

  it("covers the eyes in every pose of a live dot", () => {
    const faults: string[] = [];
    for (const [lod, poses] of POSES)
      for (const pose of poses) {
        const m = parseTransform(plateTransform(name, pose, 1));
        for (const i of eyes) {
          const eye = pose.eyes[i];
          if (!eye) continue;
          const g = eyeGeometry(eye, LOD_DETAIL[lod], 2, eyeScaleLimit([name]));
          const out = uncovered(name, m, eyePoints(g));
          if (out)
            faults.push(
              `${lod} eye ${i} gaze ${pose.gaze.x.toFixed(1)},${pose.gaze.y.toFixed(1)} roll ${pose.roll.toFixed(1)} at ${out.map((v) => v.toFixed(1))}`,
            );
        }
      }
    expect(summary(faults)).toEqual([]);
  });

  it("covers the eyes of a still dot, wherever its seed has it look", () => {
    const faults: string[] = [];
    for (const size of STILL_SIZES)
      for (let n = 0; n < 24; n++) {
        const html = stillDot(name, size, `task-${n}`);
        const m = stillPlate(html, name, size);
        const shown = stillEyes(html);
        expect(shown).toHaveLength(2);
        for (const i of eyes) {
          const out = uncovered(name, m, shown[i] ?? []);
          if (out) faults.push(`${size} px seed ${n} eye ${i} at ${out.map((v) => v.toFixed(1))}`);
        }
      }
    expect(summary(faults)).toEqual([]);
  });

  it("stays on the ball when dot looks as far as it can", () => {
    const plate = plates.get(name);
    if (!plate) throw new Error(`no plate for ${name}`);
    const solid: Point[] = [];
    for (let y = 0; y < PLATE_PX; y += 2)
      for (let x = 0; x < PLATE_PX; x += 2)
        if ((plate.alpha[y * PLATE_PX + x] ?? 0) >= SOLID * 255)
          solid.push([x / PER_UNIT, y / PER_UNIT]);
    let furthest = 0;
    for (const turn of LOOKS) {
      const m = parseTransform(plateTransform(name, turn, 1));
      for (const p of solid) {
        const [x, y] = fromPlate(name, m, p);
        furthest = Math.max(furthest, Math.hypot(x - 32, y - 32));
      }
    }
    expect(furthest).toBeLessThanOrEqual(R + OVER_BALL);
  });
});

describe("clear lenses", () => {
  it.each([
    ["round-glasses", 0, -5.5],
    ["round-glasses", 1, 5.5],
    ["monocle", 1, 5.5],
  ] as const)("%s keeps eye %i near the middle of its lens", (name, _eye, eyeX) => {
    const plate = plates.get(name);
    if (!plate) throw new Error(`no plate for ${name}`);
    const start = pixel([32 + eyeX, 27.5]);
    const seen = new Set([start]);
    const stack = [start];
    let [sumX, sumY] = [0, 0];
    while (stack.length) {
      const at = stack.pop() ?? 0;
      sumX += at % PLATE_PX;
      sumY += Math.floor(at / PLATE_PX);
      for (const next of [at - 1, at + 1, at - PLATE_PX, at + PLATE_PX]) {
        if (next < 0 || next >= plate.alpha.length || seen.has(next)) continue;
        if ((plate.alpha[next] ?? 0) >= SOLID * 255) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    const x = sumX / seen.size / PER_UNIT - 32;
    const y = sumY / seen.size / PER_UNIT - 32;
    expect(Math.abs(x - eyeX)).toBeLessThanOrEqual(1.8);
    expect(Math.abs(y + 4.5)).toBeLessThanOrEqual(0.6);
  });
});

describe("what else dot wears", () => {
  const others = Wearable.options.filter((name) => !EYEWEAR[name]);

  it.each(others)("%s leaves the eyes clear", (name) => {
    const plate = plates.get(name);
    if (!plate) throw new Error(`no plate for ${name}`);
    let worst = 0;
    for (const [lod, poses] of POSES)
      for (const pose of poses) {
        const m = parseTransform(plateTransform(name, pose, 1));
        for (const eye of pose.eyes) {
          const points = eyeArea(eyeGeometry(eye, LOD_DETAIL[lod], 2, eyeScaleLimit([name])));
          const over = points.filter((p) => alphaAt(plate, toPlate(name, m, p)) >= IN_THE_WAY);
          worst = Math.max(worst, over.length / points.length);
        }
      }
    expect(worst).toBeLessThanOrEqual(EYE_SHARE);
  });
});

describe("the frame", () => {
  it("doesn't cut off a hat that a look carries past it", () => {
    const plate = plates.get("beanie");
    if (!plate) throw new Error("no plate for beanie");
    const m = parseTransform(
      plateTransform("beanie", { gaze: { x: 0, y: -GAZE_MAX.y }, roll: 0 }, 1),
    );
    let top = PLATE_PX;
    for (let at = 0; at < plate.alpha.length && top === PLATE_PX; at++)
      if ((plate.alpha[at] ?? 0) >= SOLID * 255) top = Math.floor(at / PLATE_PX);
    const [, y] = fromPlate("beanie", m, [32, top / PER_UNIT]);
    expect(y).toBeLessThan(0);
    const css = readFileSync(fileURLToPath(new URL("../dot.css", import.meta.url)), "utf8");
    expect(css.match(/\.dot \{[^}]*\}/)?.[0]).not.toMatch(/contain:[^;]*paint/);
  });
});

describe.each(Wearable.options)("the %s plate", (name) => {
  const solidRows = (plate: Plate) => {
    let top = PLATE_PX;
    for (let y = 0; y < PLATE_PX && top === PLATE_PX; y++)
      for (let x = 0; x < PLATE_PX; x++)
        if ((plate.alpha[y * PLATE_PX + x] ?? 0) >= SOLID * 255) {
          top = y;
          break;
        }
    return top;
  };

  it("has all of its art inside the frame", () => {
    const plate = plates.get(name);
    if (!plate) throw new Error(`no plate for ${name}`);
    let edge = 0;
    for (let i = 0; i < PLATE_PX; i++)
      for (const at of [
        i,
        PLATE_PX * (PLATE_PX - 1) + i,
        PLATE_PX * i,
        PLATE_PX * i + PLATE_PX - 1,
      ])
        edge = Math.max(edge, plate.alpha[at] ?? 0);
    expect(edge).toBeLessThanOrEqual(16);
  });

  it("says truly how far it rises above the ball", () => {
    const plate = plates.get(name);
    if (!plate) throw new Error(`no plate for ${name}`);
    const rise = 32 - R - solidRows(plate) / PER_UNIT;
    if (WEAR_SLOT[name] === "head") {
      expect(crown([name])).toBeGreaterThanOrEqual(rise - 0.5);
      expect(crown([name])).toBeLessThanOrEqual(Math.max(rise, 0) + 1.5);
    } else {
      expect(rise).toBeLessThanOrEqual(0);
    }
  });
});
