import type { Wearable } from "@localdot/protocol";
import { clamp01, ease, span } from "../../src/story/tracks.ts";
import { CUES, M } from "./cues.ts";

// Where a captured screen is in the world: its centre and its scale from the screen's own CSS pixels.
export interface Shot {
  cx: number;
  cy: number;
  s: number;
}

export interface Spot {
  x: number;
  y: number;
  r: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Point = readonly [number, number];

// The two formats' framings. The world is what the camera looks at: each screen has one place in it, and
// comes and goes there.
export interface Layout {
  W: number;
  H: number;
  chat: Shot & { w: number; h: number };
  // The grid of Studio windows, in the world: Studio's own in the middle, the others round it in the
  // order they arrive, every one a cell of this size.
  grid: { cx: number; cy: number; w: number; h: number; gap: number };
  // The order the other windows take their cells in, as columns and rows from Studio's, and each take's
  // size in its CSS pixels: Studio's window and the others.
  order: readonly Point[];
  room: { w: number; h: number };
  window: { w: number; h: number };
  // How wide Studio's window is on screen before the grid grows round it, and where on screen the whole
  // grid's middle is once it has: inside the safe area.
  studio: number;
  gridAt: Point;
  // How close the camera is once the whole grid is in, and how large a window's dot may be on screen.
  gridK: number;
  dot: number;
  focus: { room: Point };
  // Where the world shows while the camera is in close, clear of the titles.
  band: { top: number; bottom: number };
  spots: { auto: Spot; perch: Spot; end: Spot };
  chatLook: Point;
  sparks: readonly Point[];
}

// Long and soft, with no abrupt start or stop.
export const soft = (t: number, from: number, duration: number) =>
  (1 - Math.cos(Math.PI * span(t, from, from + duration))) / 2;

const HALF = 0.25;
const during = (t: number, from: number, to: number) => (t >= from && t < to ? 1 : 0);

// The phone is there from the intro until the camera has moved on from it to the desk.
export const chatShown = (t: number) => soft(t, M.ask, 0.5) * during(t, 0, M.desk + 0.5);

// A picture carried on the phone from one place to another in one move over the beat after its tap,
// the screen round it fading out as it goes and the next fading in round it as it lands.
const MOVE = 0.5;
const moving = (t: number, at: number) =>
  t >= at && t < at + MOVE ? ease.inOut((t - at) / MOVE) : null;
const arriving = (t: number, at: number) => soft(t, at + MOVE - 0.125, 0.125);
// The screen being left stays, dimmed behind the picture, until the next is in over it.
const leaving = (t: number, at: number) =>
  t >= at && t < at + MOVE ? 1 - 0.6 * soft(t, at, HALF) : 0;

// The live picture grows into the computer's view.
export const growAt = (t: number) => moving(t, M.thumb);
export const askAround = (t: number) => (t < M.thumb ? 1 : arriving(t, M.thumb));
export const heldAround = (t: number) => leaving(t, M.thumb);
// The computer's view shrinks into the preview card it made.
export const shrinkAt = (t: number) => moving(t, M.preview);
export const stageHeld = (t: number) => leaving(t, M.preview);
export const cardAround = (t: number) => arriving(t, M.preview);
// The card opens into the phone's own browser tab.
export const expandAt = (t: number) => moving(t, M.open);

// Which take each screen shows.
export const SCREENS: readonly (readonly [id: string, from: number, to: number])[] = [
  ["s-ask", 0, M.preview],
  ["s-card", M.preview, M.open + MOVE],
  ["s-tab", M.open, CUES.length],
];
export const screenOn = (t: number, from: number, to: number) => t >= from && t < to;

// The windows of the several-at-once scene, in the order they arrive: one, then two, then two, then
// three, on the beat and faster each time, after Studio's own, which the camera came to first.
export const ARRIVE = [M.several, M.w4, M.w4, M.w6, M.w6, M.w9, M.w9, M.w9];
export const cellAt = (layout: Layout, i: number): Point => {
  const { grid } = layout;
  const [col, row] = i < 0 ? [0, 0] : (layout.order[i] as Point);
  return [grid.cx + col * (grid.w + grid.gap), grid.cy + row * (grid.h + grid.gap)];
};
// A window's place, scale and opacity: it pops in on its beat, and at the end every window falls into
// the middle as dot lands.
export function windowAt(t: number, layout: Layout, i: number) {
  const from = i < 0 ? M.desk : (ARRIVE[i] as number);
  if (t < from || t >= M.hit) return null;
  const pop = i < 0 ? 1 : ease.out(clamp01((t - from) / 0.15));
  const fall = ease.inOut(clamp01((t - M.away) / (M.hit - M.away)));
  const [x, y] = cellAt(layout, i);
  return {
    x: x + (layout.grid.cx - x) * fall,
    y: y + (layout.grid.cy - y) * fall,
    scale: (0.92 + 0.08 * pop) * (1 - 0.7 * fall),
    opacity: pop * (1 - fall),
  };
}

// Each window's own dot, in its own outfit, perched on the window's top edge: one with each window, on
// its beat, the later ones a sixteenth apart, so the count goes 2, 4, 6, 9; each toward the middle.
export const CREW: readonly { pop: number; wears: readonly Wearable[] }[] = [
  { pop: M.several, wears: ["hoodie"] },
  { pop: M.several, wears: ["beret", "scarf"] },
  { pop: M.w4, wears: ["mortarboard", "round-glasses"] },
  { pop: M.w4, wears: ["sunglasses", "cap"] },
  { pop: M.w6, wears: ["bow"] },
  { pop: M.w6 + 0.125, wears: ["suit", "round-glasses"] },
  { pop: M.w9, wears: ["headphones"] },
  { pop: M.w9 + 0.125, wears: ["star-pin", "scarf"] },
  { pop: M.w9 + 0.25, wears: ["mustache"] },
];

// The camera: the world's point (fx, fy) at the frame's (px, py), k times as large as it is.
export interface Camera {
  k: number;
  fx: number;
  fy: number;
  px: number;
  py: number;
}

export const toFrame = (c: Camera, x: number, y: number): Point => [
  c.px + (x - c.fx) * c.k,
  c.py + (y - c.fy) * c.k,
];
export const rectToFrame = (c: Camera, r: Rect): Rect => {
  const [x, y] = toFrame(c, r.x, r.y);
  return { x, y, w: r.w * c.k, h: r.h * c.k };
};
export const shotToFrame = (c: Camera, s: Shot): Shot => {
  const [cx, cy] = toFrame(c, s.cx, s.cy);
  return { cx, cy, s: s.s * c.k };
};

// A move from one camera to the next over [from, to], or a cut when they are the same moment. The move
// marked out is the one pull-back; every other only ever goes in.
export type CameraKey = readonly [from: number, to: number, camera: Camera, out?: "out"];

// The pull-back is quick at first and nearly done by the last window, then settles.
const settle = (u: number) => 1 - (1 - u) ** 5;

// Never still: between moves the camera keeps going in on what it frames, slowly enough that over the
// longest hold it grows only a few percent, so what it frames stays whole in the frame.
const DRIFT = 0.0025;
const drift = (c: Camera, seconds: number): Camera => ({
  ...c,
  k: c.k * (1 + Math.min(DRIFT * seconds, 0.035)),
});

export function cameraAt(t: number, start: Camera, keys: readonly CameraKey[]): Camera {
  let now = start;
  let since = 0;
  // Once pulled back, it stays: going in again would be the there-and-back the film never does.
  let back = false;
  for (const [from, to, target, out] of keys) {
    if (t < from) break;
    const was = back ? now : drift(now, from - since);
    const next = out || to <= from ? target : { ...target, k: Math.max(target.k, was.k) };
    if (to <= from || t >= to) {
      now = next;
      since = to;
      back = !!out;
      continue;
    }
    const u = (out ? settle : ease.inOut)(clamp01((t - from) / (to - from)));
    return {
      k: was.k * (next.k / was.k) ** u,
      fx: was.fx + (next.fx - was.fx) * u,
      fy: was.fy + (next.fy - was.fy) * u,
      px: was.px + (next.px - was.px) * u,
      py: was.py + (next.py - was.py) * u,
    };
  }
  return back ? now : drift(now, t - since);
}

// A screen element's rect, in the world, from its rect in the take's own pixels.
export const onScreen = (shot: Shot & { w: number; h: number }, r: Rect): Rect => ({
  x: shot.cx + (r.x - shot.w / 2) * shot.s,
  y: shot.cy + (r.y - shot.h / 2) * shot.s,
  w: r.w * shot.s,
  h: r.h * shot.s,
});

export interface Light {
  on: number;
  fadeIn: number;
  off: number;
  fadeOut: number;
  rects: readonly Rect[];
}

export const lightAt = (t: number, light: Light) =>
  soft(t, light.on, light.fadeIn) * (1 - soft(t, light.off, light.fadeOut));

export interface Takes {
  choice: Rect;
  choiceWords: Rect;
  thumb: Rect;
  thumbPicture: Rect;
  stage: Rect;
  stagePicture: Rect;
  card: Rect;
  game: Rect;
}

export function direction(layout: Layout, takes: Takes) {
  const { chat, grid, focus } = layout;
  const base: Camera = {
    k: 1,
    fx: layout.W / 2,
    fy: layout.H / 2,
    px: layout.W / 2,
    py: layout.H / 2,
  };
  const phone = (r: Rect) => onScreen(chat, r);
  // Auto's line: its dot and its words.
  const choice: Rect = {
    ...takes.choice,
    w: takes.choiceWords.x + takes.choiceWords.w - takes.choice.x,
  };
  const studio: Camera = {
    k: layout.studio / grid.w,
    fx: grid.cx,
    fy: grid.cy,
    px: focus.room[0],
    py: focus.room[1],
  };
  // The whole grid, dots on its top row and all, inside the frame.
  const all: Camera = {
    k: layout.gridK,
    fx: grid.cx,
    fy: grid.cy,
    px: layout.gridAt[0],
    py: layout.gridAt[1],
  };
  // The phone stays whole in the frame, framed as it is; rings mark what to look at on it.
  const keys: CameraKey[] = [
    // From the phone over to Studio on the desk, in one move.
    [M.desk, M.desk + 0.5, studio],
    // And back, once, as the windows come: the grid grows round Studio's, all in by the last of them.
    [M.several, M.away, all, "out"],
    [M.hit, M.hit, base],
  ];
  // A ring only where what's shown has something to stand out from, and nothing dimmed round it: each
  // comes up in a quarter of a second from its beat, and goes as quickly.
  const lights: Light[] = [
    // Gone before dot's answer moves the line up.
    { on: M.choice, fadeIn: HALF, off: M.reply - HALF, fadeOut: HALF, rects: [phone(choice)] },
    { on: M.card, fadeIn: HALF, off: M.open, fadeOut: HALF, rects: [phone(takes.card)] },
  ];

  // How close the camera is, 0 to 1, for the band the world shows through.
  const closeness = (c: Camera) => clamp01((c.k - 1) / 0.15);
  return { base, keys, lights, closeness };
}

export interface Touch {
  label: string;
  from: number;
  up: number;
  x: number;
  y: number;
}

// A fingertip on the screen, or none: it appears beside nothing but its own target, presses, and lifts
// at once.
export function touchAt(t: number, touches: readonly Touch[]) {
  for (const touch of touches) {
    if (t < touch.from || t > touch.up + HALF) continue;
    const down = soft(t, touch.from, HALF);
    const lift = soft(t, touch.up, HALF);
    return {
      x: touch.x,
      y: touch.y,
      opacity: down * (1 - lift),
      scale: 1.2 - 0.2 * down + 0.2 * lift,
    };
  }
  return null;
}

// One sparkle of a burst, where a dot lands, or none.
export function sparkAt(t: number, at: number, i: number) {
  const u = t - at;
  if (u <= 0 || u >= 1) return null;
  const bell = Math.sin(Math.PI * u);
  return {
    opacity: Math.min(1, bell * 1.6),
    scale: bell * ([0.9, 0.55, 0.7][i % 3] as number),
    rotation: -30 + 80 * u,
  };
}
