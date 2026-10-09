import { clamp, smoothstep } from "./math.ts";
import { hash01 } from "./rng.ts";
import { GAZE_MAX } from "./sphere.ts";

// What dot is doing with its hands, as it were: each tool brings a small prop and a way of
// holding the body and eyes. Times are in milliseconds, places in the 64-unit frame.
export type DotTool =
  | "typing"
  | "terminal"
  | "browsing"
  | "pointing"
  | "dragging"
  | "looking"
  | "thinking"
  | "waiting"
  | "needs-you"
  | "sending"
  | "filing"
  | "recalling";

export const TOOLS: readonly DotTool[] = [
  "typing",
  "terminal",
  "browsing",
  "pointing",
  "dragging",
  "looking",
  "thinking",
  "waiting",
  "needs-you",
  "sending",
  "filing",
  "recalling",
];

// A prop stays out at least this long, so a quick run of actions never flickers between poses.
export const TOOL_HOLD_MS = 900;
// A pause in the work (thinking, a look at the screen, a wait, or nothing) waits this long before
// it replaces the work's prop, so the short pause between two actions keeps the prop out. The same
// patience as the narrated line's hold.
export const TOOL_GAP_MS = 1500;
export const PAUSES: ReadonlySet<DotTool | null> = new Set([
  null,
  "thinking",
  "looking",
  "waiting",
]);

// No beat shows after this long, so dropping older ones never changes a frame.
export const BEAT_REACH_MS = 1500;

export interface Beat {
  // How long ago it happened, and a stable draw that picks its key, line or page.
  age: number;
  k: number;
}

// One prop as the renderers draw it.
export interface PropPose {
  tool: DotTool;
  // 0 tucked into dot … 1 fully out; a critically damped spring either way.
  amount: number;
  // How long the prop has been out: the clock its loops run on, held still under reduced motion.
  clock: number;
  beats: readonly Beat[];
  // Lines scrolled so far (terminal, browser), springing toward `lines`.
  scroll: number;
  lines: number;
  // Toward the action point (pointer), radians in screen space.
  angle: number;
  // A stable draw per entrance, so the terminal's and the page's lines differ each time.
  seed: number;
  // Reduced motion: the prop only fades, in place, and its loops hold still.
  still: boolean;
}

// How each tool holds the body (an offset in frame units and a scale about its base), how much of
// the gaze it takes from the state, and how far the upper lids drop for it.
interface ToolLook {
  x: number;
  y: number;
  s: number;
  gaze: number;
  up: number;
}

export const TOOL_LOOK: Record<DotTool, ToolLook> = {
  typing: { x: 0, y: -4, s: 0.84, gaze: 0.95, up: 0.26 },
  terminal: { x: -9, y: -1, s: 0.82, gaze: 0.85, up: 0.06 },
  browsing: { x: -9, y: -1, s: 0.82, gaze: 0.85, up: -0.04 },
  pointing: { x: 0, y: 0, s: 0.88, gaze: 0.7, up: 0 },
  dragging: { x: 0, y: 0, s: 0.88, gaze: 0.7, up: 0.04 },
  looking: { x: -2, y: 0, s: 0.92, gaze: 0.9, up: 0 },
  thinking: { x: 0, y: 1.5, s: 0.9, gaze: 0.45, up: 0 },
  waiting: { x: -4, y: 0, s: 0.88, gaze: 0.5, up: 0.08 },
  "needs-you": { x: 2, y: -1, s: 0.92, gaze: 1, up: -0.04 },
  sending: { x: -6, y: 1, s: 0.86, gaze: 0.75, up: 0 },
  filing: { x: -9, y: 0, s: 0.84, gaze: 0.8, up: 0.08 },
  recalling: { x: -9, y: 0, s: 0.84, gaze: 0.8, up: 0.1 },
};

export const DEFAULT_ANGLE = 0.7;

// The keyboard: a low slab in perspective, its top face from the back edge to the front.
export const KEYBOARD = {
  cx: 32,
  cy: 54,
  back: { y: -4.5, hw: 17 },
  front: { y: 3.5, hw: 21 },
  lip: 1.7,
} as const;

export interface Key {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ROWS = [0.2, 0.5, 0.8] as const;

// The keys of one row, left to right, relative to the keyboard's centre. The last row is a space
// bar between two keys. Fewer keys where dot is small.
export function keyRow(row: number, fine: boolean): Key[] {
  const v = ROWS[row] ?? 0.5;
  const y = KEYBOARD.back.y + (KEYBOARD.front.y - KEYBOARD.back.y) * v;
  const hw = KEYBOARD.back.hw + (KEYBOARD.front.hw - KEYBOARD.back.hw) * v - 1.8;
  const h = 1.7 + 0.5 * v;
  const gap = fine ? 0.55 : 0.8;
  if (row === 2) {
    const side = fine ? 2 : 1;
    const unit = (2 * hw - gap * (2 * side)) / (2 * side + 5);
    const keys: Key[] = [];
    let x = -hw;
    for (let i = 0; i < 2 * side + 1; i++) {
      const w = i === side ? 5 * unit : unit;
      keys.push({ x: x + w / 2, y, w, h });
      x += w + gap;
    }
    return keys;
  }
  const n = fine ? 10 - row : 7 - row;
  const w = (2 * hw - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x: -hw + w / 2 + i * (w + gap), y, w, h }));
}

// Which key a keystroke lands on: mostly letters, a space now and then.
export function keyOf(k: number, fine: boolean): { row: number; index: number } {
  if (k < 0.16) return { row: 2, index: fine ? 2 : 1 };
  const row = k < 0.58 ? 0 : 1;
  const n = keyRow(row, fine).length;
  return { row, index: Math.floor(hash01(Math.floor(k * 1e6), row) * n) };
}

// A keystroke's press: down in 40 ms, back up over the next ~250.
export function pressOf(age: number): number {
  if (age < 0 || age > BEAT_REACH_MS) return 0;
  if (age < 40) return age / 40;
  return Math.exp(-(age - 40) / 110);
}

// A click's tap: a quick poke and release.
export function tapOf(age: number): number {
  if (age < 0 || age > 700) return 0;
  if (age < 60) return age / 60;
  return Math.exp(-(age - 60) / 140);
}

export const PLANE_EVERY_MS = 2000;
export const PLANE_FIRST_MS = 450;
export const PLANE_FLIGHT_MS = 1200;

// Where the current paper plane is in its flight: -1 waiting at dot's edge, 0…1 in flight.
export function planeAt(clock: number): { flight: number; launch: number } {
  if (clock < PLANE_FIRST_MS) return { flight: -1, launch: Number.NEGATIVE_INFINITY };
  const n = Math.floor((clock - PLANE_FIRST_MS) / PLANE_EVERY_MS);
  const launch = PLANE_FIRST_MS + n * PLANE_EVERY_MS;
  const u = (clock - launch) / PLANE_FLIGHT_MS;
  return { flight: u <= 1 ? u : -1, launch };
}

export const FILE_EVERY_MS = 1700;
export const PAGE_EVERY_MS = 1500;
export const PAGE_FLIP_MS = 620;

// Body and eyes for one tool at a moment: an offset and roll for the body, and where the eyes go,
// in gaze units. Pure in the prop's own clock and beats, so it plays the same at any frame rate.
export interface ToolMotion {
  x: number;
  y: number;
  roll: number;
  gx: number;
  gy: number;
}

const wave = (clock: number, period: number) => Math.sin((2 * Math.PI * clock) / period);

export function toolMotion(p: PropPose, fine: boolean): ToolMotion {
  const c = p.clock;
  switch (p.tool) {
    case "typing": {
      // Eyes on the keys, drifting toward the one just pressed; each keystroke a small nod down.
      let sum = 0;
      let at = 0;
      let nod = 0;
      for (const b of p.beats) {
        if (b.age < 0 || b.age > BEAT_REACH_MS) continue;
        const e = (1 - Math.exp(-b.age / 60)) * Math.exp(-b.age / 420);
        const { row, index } = keyOf(b.k, fine);
        at += e * (keyRow(row, fine)[index]?.x ?? 0);
        sum += e;
        nod += pressOf(b.age);
      }
      const kx = sum > 1e-4 ? at / sum : 0;
      return {
        x: 0,
        y: 0.55 * Math.min(1, nod),
        roll: 0,
        gx: 0.16 * kx + 0.35 * wave(c, 2300),
        gy: 5,
      };
    }
    case "terminal":
      return { x: 0, y: 0, roll: 0, gx: 5.6 + 0.7 * wave(c, 1900), gy: 2.2 };
    case "browsing": {
      // Reading: a sweep along the line, a quick return, the next line a little lower.
      const u = (c % 1600) / 1600;
      const line = Math.floor(c / 1600) % 3;
      const sweep = u < 0.82 ? u / 0.82 : 1 - smoothstep(0.82, 1, u);
      const next = u < 0.82 ? 0 : smoothstep(0.82, 1, u);
      return {
        x: 0,
        y: 0,
        roll: -1.2,
        gx: 2 + 3.4 * sweep,
        gy: 0.6 + 0.9 * (line === 2 ? 2 * (1 - next) : line + next),
      };
    }
    case "pointing":
    case "dragging": {
      const sway = p.tool === "dragging" ? dragSway(c) : 0;
      const a = p.angle + sway;
      const poke = p.beats.reduce((m, b) => Math.max(m, tapOf(b.age)), 0);
      return {
        x: (2.2 + 0.8 * poke) * Math.cos(a),
        y: (1.2 + 0.6 * poke) * Math.sin(a),
        roll: 4 * Math.cos(a),
        gx: GAZE_MAX.x * 0.85 * Math.cos(a),
        gy: GAZE_MAX.y * 0.85 * Math.sin(a),
      };
    }
    case "looking":
      return {
        x: 0,
        y: 0,
        roll: 2 * wave(c, 2800),
        gx: 1.5 + 3.2 * wave(c, 2800),
        gy: 0.8 + 1.6 * wave(c + 350, 1400),
      };
    case "thinking":
      return { x: 0, y: 0, roll: 0, gx: -3.5 + 0.8 * wave(c, 4100), gy: -4.8 };
    case "waiting":
      return {
        x: 1.3 * wave(c, 3600),
        y: 0,
        roll: 2.5 * wave(c, 3600),
        gx: 4.6,
        gy: 2.6,
      };
    case "needs-you":
      return { x: 0, y: 0, roll: 0, gx: 0, gy: 0 };
    case "sending": {
      const { flight, launch } = planeAt(c);
      const hop = launch > 0 ? Math.max(0, 1 - Math.abs(c - launch - 120) / 160) : 0;
      const u = flight < 0 ? 0 : flight;
      return { x: 0, y: -1.4 * hop, roll: 0, gx: 4 + 2.8 * u, gy: 1.5 - 6 * u };
    }
    case "filing": {
      const u = (c % FILE_EVERY_MS) / FILE_EVERY_MS;
      return { x: 0, y: 0, roll: 0, gx: 5.4, gy: -1.5 + 5 * smoothstep(0, 0.6, u) };
    }
    case "recalling": {
      const u = clamp(((c % PAGE_EVERY_MS) - 300) / PAGE_FLIP_MS, 0, 1);
      return { x: 0, y: 0, roll: 0, gx: 6.2 - 2.4 * smoothstep(0, 1, u), gy: 3 };
    }
  }
}

// A drag swings the pointer along a short arc around dot and back.
export function dragSway(clock: number): number {
  const u = (clock % 1800) / 1800;
  const there = u < 0.5 ? smoothstep(0, 0.5, u) : 1 - smoothstep(0.5, 1, u);
  return 0.9 * (there - 0.5);
}
