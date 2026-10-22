import { clamp, smoothstep } from "./math.ts";
import { hash01 } from "./rng.ts";
import { GAZE_MAX } from "./sphere.ts";

// What dot is doing with its hands, as it were: each tool brings a small prop and a way of
// holding the body and eyes. Times are in milliseconds, places in the 64-unit frame.
export type DotTool =
  | "typing"
  | "terminal"
  | "reading"
  | "searching"
  | "browsing"
  | "pointing"
  | "dragging"
  | "looking"
  | "inspecting"
  | "thinking"
  | "planning"
  | "waiting"
  | "scheduling"
  | "needs-you"
  | "sending"
  | "filing"
  | "recalling"
  | "remembering"
  | "delegating";

export const TOOLS: readonly DotTool[] = [
  "typing",
  "terminal",
  "reading",
  "searching",
  "browsing",
  "pointing",
  "dragging",
  "looking",
  "inspecting",
  "thinking",
  "planning",
  "waiting",
  "scheduling",
  "needs-you",
  "sending",
  "filing",
  "recalling",
  "remembering",
  "delegating",
];

// A prop stays out at least this long, so a quick run of actions never flickers between poses.
export const TOOL_HOLD_MS = 900;
// A pause in the work (thinking, a look at the screen, a wait, helpers at work, or nothing) waits
// this long before it replaces the work's prop, so the short pause between two actions keeps the
// prop out. The same patience as the narrated line's hold.
export const TOOL_GAP_MS = 1500;
export const PAUSES: ReadonlySet<DotTool | null> = new Set([
  null,
  "thinking",
  "looking",
  "waiting",
  "delegating",
]);

// No beat shows after this long, so dropping older ones never changes a frame.
export const BEAT_REACH_MS = 1500;

export interface Beat {
  // How long ago it happened, and a stable draw that picks its key, line or page.
  age: number;
  k: number;
}

// One piece of work done with a prop, such as a command, a page or a search: the line it began at,
// how long ago, and how it ended once it has.
export interface Run {
  line: number;
  age: number;
  end: { ok: boolean; age: number } | null;
}

// One prop as the renderers draw it.
export interface PropPose {
  tool: DotTool;
  // 0 tucked into dot … 1 fully out; a critically damped spring either way.
  amount: number;
  // How long the prop has been out: the clock its loops run on, held still under reduced motion.
  clock: number;
  beats: readonly Beat[];
  // Lines so far (a command's output, pages turned, a plan's items done), and the scroll that
  // springs toward them.
  scroll: number;
  lines: number;
  // The work since the prop came out, newest last.
  runs: readonly Run[];
  // Toward the action point (pointer), radians in screen space.
  angle: number;
  // A stable draw per entrance, so the terminal's and the page's lines differ each time.
  seed: number;
  // Reduced motion: the prop only fades, in place, and its loops hold still.
  still: boolean;
}

// A sub-agent at work, drawn as a small dot beside dot: its place, how far out it is, how long it
// has been out, how its work ended once it has, and a draw of its own.
export interface HelperPose {
  slot: number;
  amount: number;
  age: number;
  end: { ok: boolean; age: number } | null;
  seed: number;
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

const LENS_LOOK: ToolLook = { x: -2, y: 0, s: 0.92, gaze: 0.9, up: 0 };
const BOOK_LOOK: ToolLook = { x: -9, y: 0, s: 0.84, gaze: 0.8, up: 0.1 };

export const TOOL_LOOK: Record<DotTool, ToolLook> = {
  typing: { x: 0, y: -4, s: 0.84, gaze: 0.95, up: 0.26 },
  terminal: { x: -9, y: -1, s: 0.82, gaze: 0.85, up: 0.06 },
  reading: { x: -9, y: -1, s: 0.82, gaze: 0.85, up: 0.02 },
  searching: { x: -9, y: -1, s: 0.82, gaze: 0.85, up: -0.02 },
  browsing: { x: -9, y: -1, s: 0.82, gaze: 0.85, up: -0.04 },
  pointing: { x: 0, y: 0, s: 0.88, gaze: 0.7, up: 0 },
  dragging: { x: 0, y: 0, s: 0.88, gaze: 0.7, up: 0.04 },
  looking: LENS_LOOK,
  inspecting: LENS_LOOK,
  thinking: { x: 0, y: 1.5, s: 0.9, gaze: 0.45, up: 0 },
  planning: { x: -9, y: 0, s: 0.84, gaze: 0.8, up: 0.06 },
  waiting: { x: -4, y: 0, s: 0.88, gaze: 0.5, up: 0.08 },
  scheduling: { x: -8, y: 0, s: 0.86, gaze: 0.7, up: 0.06 },
  "needs-you": { x: 2, y: -1, s: 0.92, gaze: 1, up: -0.04 },
  sending: { x: -6, y: 1, s: 0.86, gaze: 0.75, up: 0 },
  filing: { x: -9, y: 0, s: 0.84, gaze: 0.8, up: 0.08 },
  recalling: BOOK_LOOK,
  remembering: BOOK_LOOK,
  delegating: { x: -9, y: 0, s: 0.84, gaze: 0.6, up: 0 },
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
export const PAGE_FLIP_MS = 620;

// The terminal: a dark card right of dot. Its lines run from the top, a command's prompt then its
// output, and the newest stays in view.
export const TERMINAL = { cx: 48.5, cy: 42.5, hw: 13, hh: 12 } as const;
export const terminalRows = (fine: boolean) => (fine ? 6 : 5);
// A command goes onto its prompt line a character at a time, then its output scrolls in.
export const typeMs = (chars: number) => 90 + 28 * chars;
export const commandChars = (seed: number, line: number) => 7 + Math.floor(hash01(seed, line) * 13);

// A page turns over this long from when the output that fills it arrives.
export const PAGE_TURN_MS = 760;

// The search's results card, and its rows.
export const RESULTS = { cx: 48.5, cy: 43, hw: 12, hh: 10.5 } as const;
export const resultY = (row: number) => -RESULTS.hh + 6.6 + 5.1 * row;
const SWEEP_ROW_MS = 900;
const SETTLE_MS = 460;

// Where the lens is over the results, in the card's units: reading row after row while the search
// runs, then gliding to the row it found. `lit` is that row, `found` how far the lens has got to it.
export function lensAt(p: PropPose): { x: number; y: number; lit: number; found: number } {
  const run = p.runs.at(-1);
  const t = run ? run.age : p.clock;
  const sweep = (at: number) => {
    const n = Math.max(0, at) / SWEEP_ROW_MS;
    const u = n % 1;
    const row = Math.floor(n) % 3;
    const across = u < 0.72 ? smoothstep(0, 0.72, u) : 1 - smoothstep(0.72, 1, u);
    const down = smoothstep(0.72, 1, u);
    return {
      x: -RESULTS.hw + 5 + (2 * RESULTS.hw - 11) * across,
      y: resultY(row) + (resultY((row + 1) % 3) - resultY(row)) * down,
    };
  };
  if (p.still || !run?.end?.ok) return { ...sweep(p.still ? 0 : t), lit: -1, found: 0 };
  const lit = Math.floor(hash01(Math.floor(p.seed * 1e6), run.line + p.runs.length) * 3);
  const from = sweep(t - run.end.age);
  const found = smoothstep(0, SETTLE_MS, run.end.age);
  const to = { x: RESULTS.hw - 5.6 + 0.6 * wave(run.end.age, 3100), y: resultY(lit) + 0.5 };
  return {
    x: from.x + (to.x - from.x) * found,
    y: from.y + (to.y - from.y) * found,
    lit,
    found,
  };
}

// The plan: a short checklist whose done items scroll up, keeping the next one in view.
export const PLAN = { cx: 49, cy: 44, hw: 11, hh: 10.5 } as const;
export const planOffset = (scroll: number) => Math.max(0, scroll - 1);
export const planY = (item: number, offset: number) => -PLAN.hh + 6.4 + 5.3 * (item - offset);
export const TICK_MS = 300;

// The calendar and the clock whose hand sweeps to the time each run sets.
export const SCHEDULE = {
  clock: { x: 53.6, y: 48.6, r: 6.6 },
  card: { x: 44.6, y: 42.4, hw: 5.8, hh: 5.6 },
} as const;
export const SWEEP_MS = 900;
const markAngle = (k: number) => -Math.PI / 2 + 2 * Math.PI * (0.18 + 0.64 * k);

// The minute hand for the newest run: it sweeps on from the last mark, or from twelve, round to the
// mark this run sets. `set` is how far it has got, and k the run's own draw.
export function handAt(p: PropPose): { angle: number; mark: number; set: number; k: number } {
  const run = p.runs.at(-1);
  if (!run) return { angle: -Math.PI / 2, mark: -Math.PI / 2, set: 0, k: 0 };
  const seed = Math.floor(p.seed * 1e6);
  const k = hash01(seed, run.line + p.runs.length);
  const mark = markAngle(k);
  if (p.still) return { angle: mark, mark, set: 1, k };
  const before = p.runs.at(-2);
  const from = before ? markAngle(hash01(seed, before.line + p.runs.length - 1)) : -Math.PI / 2;
  const set = smoothstep(120, 120 + SWEEP_MS, run.age);
  const forward = (((mark - from) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return { angle: from + forward * set, mark, set, k };
}

// Where the helpers float, in an arc round dot's shoulder, the first nearest; a helper is the body
// drawn small.
export const HELPER_SLOTS = [
  { x: 53.4, y: 28.4, r: 4.6 },
  { x: 58.4, y: 40.2, r: 4 },
  { x: 50.6, y: 16.6, r: 3.6 },
] as const;
// A helper that finished well smiles this long before it pops back into dot.
export const HAPPY_MS = 420;

// The book: a page turns as each lookup starts, and each note is written onto the right-hand page.
export const BOOK = { cx: 49.5, cy: 48.5 } as const;
export const flipOf = (run: Run | undefined, still: boolean) =>
  run && !still ? clamp((run.age - 260) / PAGE_FLIP_MS, 0, 1) : 0;
export const WRITE_MS = 560;
export const NOTE_LINES = [-3.4, -1.4, 0.6, 2.6] as const;

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
const latest = (p: PropPose) => p.beats.at(-1)?.age ?? Number.POSITIVE_INFINITY;

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
    case "terminal": {
      // Eyes on the line being written: the command as it is typed, then its output.
      const rows = terminalRows(fine);
      const row = Math.min(p.scroll, rows - 1) / (rows - 1);
      return { x: 0, y: 0, roll: 0, gx: 5.6 + 0.7 * wave(c, 1900), gy: 0.8 + 2.6 * row };
    }
    case "browsing":
    case "reading": {
      // Reading: a sweep along the line, a quick return, the next line a little lower.
      const u = (c % 1600) / 1600;
      const line = Math.floor(c / 1600) % 3;
      const sweep = u < 0.82 ? u / 0.82 : 1 - smoothstep(0.82, 1, u);
      const next = u < 0.82 ? 0 : smoothstep(0.82, 1, u);
      // A new page sends the eyes back to its top.
      const turn = 1 - smoothstep(0, PAGE_TURN_MS, latest(p));
      return {
        x: 0,
        y: 0,
        roll: -1.2,
        gx: 2 + 3.4 * sweep * (1 - turn),
        gy: 0.6 + 0.9 * (line === 2 ? 2 * (1 - next) : line + next) * (1 - turn) - 0.8 * turn,
      };
    }
    case "searching": {
      const lens = lensAt(p);
      return { x: 0, y: 0, roll: -0.8, gx: 4.2 + 0.24 * lens.x, gy: 1.6 + 0.26 * lens.y };
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
    case "inspecting":
      return {
        x: 0,
        y: 0,
        roll: 2 * wave(c, 2800),
        gx: 1.5 + 3.2 * wave(c, 2800),
        gy: 0.8 + 1.6 * wave(c + 350, 1400),
      };
    case "thinking":
      return { x: 0, y: 0, roll: 0, gx: -3.5 + 0.8 * wave(c, 4100), gy: -4.8 };
    case "planning": {
      // Eyes on the next item, and a small nod as one is ticked off.
      const item = p.lines - planOffset(p.scroll);
      const nod = tapOf(latest(p) - TICK_MS * 0.5);
      return { x: 0, y: 0.5 * nod, roll: 0, gx: 4.4 + 0.5 * wave(c, 2600), gy: 0.6 + 1.5 * item };
    }
    case "waiting":
      return {
        x: 1.3 * wave(c, 3600),
        y: 0,
        roll: 2.5 * wave(c, 3600),
        gx: 4.6,
        gy: 2.6,
      };
    case "scheduling": {
      // Eyes follow the hand round to its mark, then rest on the clock.
      const { angle, set } = handAt(p);
      const follow = Math.sin(Math.PI * set);
      return {
        x: 0,
        y: 0,
        roll: 0,
        gx: 5.2 + 1.2 * follow * Math.cos(angle),
        gy: 2.8 + 1.2 * follow * Math.sin(angle),
      };
    }
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
      const u = flipOf(p.runs.at(-1), p.still);
      return { x: 0, y: 0, roll: 0, gx: 6.2 - 2.4 * smoothstep(0, 1, u), gy: 3 };
    }
    case "remembering": {
      // Eyes follow the pen along the line it writes, then rest on the page.
      const u = smoothstep(0, WRITE_MS, latest(p));
      const writing = latest(p) < WRITE_MS + 300 ? 1 : 0;
      return {
        x: 0,
        y: 0,
        roll: 0,
        gx: 5.6 + writing * (1.6 * u - 0.6),
        gy: 3.2 + 0.4 * Math.min(3, Math.max(0, p.lines - 1)),
      };
    }
    case "delegating":
      // Eyes on the helpers, from one to the next.
      return { x: 0, y: 0, roll: 0, gx: 4.4 + 0.8 * wave(c, 4200), gy: -1.4 + 1.8 * wave(c, 2100) };
  }
}

// A drag swings the pointer along a short arc around dot and back.
export function dragSway(clock: number): number {
  const u = (clock % 1800) / 1800;
  const there = u < 0.5 ? smoothstep(0, 0.5, u) : 1 - smoothstep(0.5, 1, u);
  return 0.9 * (there - 0.5);
}
