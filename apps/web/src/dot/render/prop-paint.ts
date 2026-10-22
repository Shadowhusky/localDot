import type { DotPose } from "../engine/engine.ts";
import { clamp, smoothstep } from "../engine/math.ts";
import { hash01 } from "../engine/rng.ts";
import {
  BOOK,
  commandChars,
  dragSway,
  FILE_EVERY_MS,
  flipOf,
  HELPER_SLOTS,
  type HelperPose,
  handAt,
  KEYBOARD,
  keyOf,
  keyRow,
  lensAt,
  NOTE_LINES,
  PAGE_TURN_MS,
  PLAN,
  PLANE_EVERY_MS,
  PLANE_FIRST_MS,
  PLANE_FLIGHT_MS,
  type PropPose,
  planeAt,
  planOffset,
  planY,
  pressOf,
  RESULTS,
  type Run,
  resultY,
  SCHEDULE,
  TERMINAL,
  TICK_MS,
  tapOf,
  terminalRows,
  typeMs,
  WRITE_MS,
} from "../engine/tools.ts";
import { mixColours as mix, PEARL_STOPS, PROP } from "./dot-colours.ts";

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
interface Point {
  x: number;
  y: number;
}
interface Ball extends Point {
  r: number;
}

// Behind the body: the far half of the thinking sparks and the raised hand. In front: the rest.
export type PropLayer = "back" | "front";

// Draws dot's props for one layer, in the 64-unit frame (the caller scales the context to it).
// The accent is the porcelain highlight, warming to xenon as dot takes control. The body's plate,
// once it has loaded, draws the helpers; without it they are drawn as the SVG skin draws dot.
export function paintProps(
  ctx: Context,
  pose: DotPose,
  layer: PropLayer,
  xenon: string,
  plate: CanvasImageSource | null = null,
): void {
  if (!pose.props.length) return;
  const ball: Ball = {
    x: 32 + pose.body.x,
    y: 56 + pose.body.y - 24 * pose.body.sy,
    r: 24 * pose.body.sx,
  };
  const accent = mix(PROP.accentRest, xenon, pose.plate.rim * (1 - pose.plate.dim));
  for (const p of pose.props) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (layer === "back") {
      if (p.tool === "thinking") sparks(ctx, p, ball, accent, "back");
      else if (p.tool === "needs-you") hand(ctx, p, ball);
    } else {
      PAINT[p.tool]?.(ctx, p, ball, accent, pose, plate);
    }
    ctx.restore();
  }
}

type Painter = (
  ctx: Context,
  p: PropPose,
  ball: Ball,
  accent: string,
  pose: DotPose,
  plate: CanvasImageSource | null,
) => void;

const PAINT: Partial<Record<PropPose["tool"], Painter>> = {
  typing: (ctx, p, ball, accent, pose) => keyboard(ctx, p, ball, accent, pose.fine),
  terminal: (ctx, p, ball, accent, pose) => terminal(ctx, p, ball, accent, pose.fine),
  reading: (ctx, p, ball) => paper(ctx, p, ball),
  searching: (ctx, p, ball, accent) => results(ctx, p, ball, accent),
  browsing: (ctx, p, ball, accent) => browser(ctx, p, ball, accent),
  pointing: (ctx, p, ball, accent) => pointer(ctx, p, ball, accent),
  dragging: (ctx, p, ball, accent) => pointer(ctx, p, ball, accent),
  looking: (ctx, p, ball, accent, pose) => lens(ctx, p, ball, accent, pose),
  inspecting: (ctx, p, ball, accent, pose) => lens(ctx, p, ball, accent, pose),
  thinking: (ctx, p, ball, accent) => sparks(ctx, p, ball, accent, "front"),
  planning: (ctx, p, ball, accent, pose) => checklist(ctx, p, ball, accent, pose.fine),
  waiting: (ctx, p, ball, accent) => clock(ctx, p, ball, accent),
  scheduling: (ctx, p, ball, accent) => calendar(ctx, p, ball, accent),
  sending: (ctx, p, ball, accent) => plane(ctx, p, ball, accent),
  filing: (ctx, p, ball, accent) => folder(ctx, p, ball, accent),
  recalling: (ctx, p, ball, accent) => book(ctx, p, ball, accent),
  remembering: (ctx, p, ball, accent) => book(ctx, p, ball, accent),
  delegating: (ctx, p, ball, _accent, pose, plate) => helpers(ctx, p, ball, pose.helpers, plate),
};

// A prop comes out of dot's edge: from `from` to its place, growing and fading in on the prop's
// spring. Under reduced motion it only fades, in place.
function emerge(ctx: Context, p: PropPose, from: Point, to: Point): void {
  const a = p.amount;
  if (p.still) {
    ctx.translate(to.x, to.y);
    ctx.globalAlpha *= a;
    return;
  }
  ctx.translate(from.x + (to.x - from.x) * a, from.y + (to.y - from.y) * a);
  const s = 0.45 + 0.55 * a;
  ctx.scale(s, s);
  ctx.globalAlpha *= Math.min(1, a * 1.5);
}

const edge = (ball: Ball, angle: number, out = 1): Point => ({
  x: ball.x + ball.r * out * Math.cos(angle),
  y: ball.y + ball.r * out * Math.sin(angle),
});

function rounded(ctx: Context, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function vertical(ctx: Context, y0: number, y1: number, top: string, bottom: string) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  return g;
}

// A card's soft contact on the house, without a blur.
function shade(ctx: Context, x: number, y: number, w: number, h: number, r: number): void {
  ctx.fillStyle = PROP.shade;
  rounded(ctx, x, y + 0.9, w, h, r);
  ctx.fill();
}

function keyboard(ctx: Context, p: PropPose, ball: Ball, accent: string, fine: boolean): void {
  const { back, front, lip } = KEYBOARD;
  emerge(ctx, p, { x: ball.x, y: ball.y + ball.r * 0.85 }, { x: KEYBOARD.cx, y: KEYBOARD.cy });
  const slab = () => {
    ctx.beginPath();
    ctx.moveTo(-back.hw, back.y);
    ctx.lineTo(back.hw, back.y);
    ctx.lineTo(front.hw, front.y);
    ctx.lineTo(-front.hw, front.y);
    ctx.closePath();
  };
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-front.hw, front.y);
  ctx.lineTo(front.hw, front.y);
  ctx.lineTo(front.hw - 0.6, front.y + lip);
  ctx.lineTo(-front.hw + 0.6, front.y + lip);
  ctx.closePath();
  ctx.fillStyle = PROP.graphiteLo;
  ctx.strokeStyle = PROP.graphiteLo;
  ctx.fill();
  ctx.stroke();
  slab();
  const top = vertical(ctx, back.y, front.y, PROP.graphiteHi, PROP.graphite);
  ctx.fillStyle = top;
  ctx.strokeStyle = top;
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = PROP.hairline;
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  ctx.moveTo(-back.hw + 0.4, back.y - 0.55);
  ctx.lineTo(back.hw - 0.4, back.y - 0.55);
  ctx.stroke();

  const pressed = new Map<string, number>();
  for (const b of p.beats) {
    const { row, index } = keyOf(b.k, fine);
    const key = `${row}:${index}`;
    pressed.set(key, Math.max(pressed.get(key) ?? 0, pressOf(b.age)));
  }
  for (let row = 0; row < 3; row++) {
    for (const [index, k] of keyRow(row, fine).entries()) {
      const press = pressed.get(`${row}:${index}`) ?? 0;
      const x = k.x - k.w / 2;
      const y = k.y - k.h / 2 + 0.4 * press;
      ctx.fillStyle = PROP.keyEdge;
      rounded(ctx, x, y + 0.3, k.w, k.h, 0.55);
      ctx.fill();
      ctx.fillStyle = press > 0.02 ? mix(PROP.key, PROP.keyDown, press) : PROP.key;
      rounded(ctx, x, y, k.w, k.h, 0.55);
      ctx.fill();
      if (press > 0.02) {
        ctx.save();
        ctx.globalAlpha *= 0.85 * press;
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.restore();
      }
    }
  }
}

// The terminal: each command is typed onto its prompt line a character at a time, its output
// scrolls in a line at a time as it arrives, and a tick or a cross lands on the prompt as it exits.
function terminal(ctx: Context, p: PropPose, ball: Ball, accent: string, fine: boolean): void {
  const { hw, hh } = TERMINAL;
  emerge(ctx, p, edge(ball, 0.35, 0.8), { x: TERMINAL.cx, y: TERMINAL.cy });
  shade(ctx, -hw, -hh, 2 * hw, 2 * hh, 3.2);
  rounded(ctx, -hw, -hh, 2 * hw, 2 * hh, 3.2);
  ctx.fillStyle = PROP.cardDark;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = PROP.cardDarkBar;
  ctx.fillRect(-hw, -hh, 2 * hw, 3.4);
  ctx.restore();
  ctx.strokeStyle = PROP.hairline;
  ctx.lineWidth = 0.45;
  ctx.stroke();
  ctx.fillStyle = PROP.dots;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(-hw + 2.2 + i * 1.9, -hh + 1.7, 0.62, 0, Math.PI * 2);
    ctx.fill();
  }

  const rows = terminalRows(fine);
  const lh = fine ? 3 : 3.4;
  const bar = fine ? 1.1 : 1.45;
  const x0 = -hw + 2;
  // Output stops short of the right edge, where a command's exit lands.
  const room = 2 * hw - 8.4;
  const top = -hh + 6;
  const offset = Math.max(0, p.scroll - (rows - 1));
  const seed = Math.floor(p.seed * 1e6);
  const prompts = new Map(p.runs.map((run) => [run.line, run]));
  const first = p.runs[0]?.line ?? Number.POSITIVE_INFINITY;
  let end: Point | null = null;
  ctx.save();
  ctx.beginPath();
  ctx.rect(-hw + 1, -hh + 3.8, 2 * hw - 2, 2 * hh - 4.8);
  ctx.clip();
  for (let i = Math.max(first, Math.floor(offset)); i <= p.lines; i++) {
    const y = top + (i - offset) * lh;
    ctx.save();
    // A line fades as it scrolls up under the title bar.
    ctx.globalAlpha *= smoothstep(top - lh, top - 0.2 * lh, y);
    const run = prompts.get(i);
    if (run) {
      end = { x: command(ctx, run, seed, x0, y, bar, accent, p.still), y };
      const typed = run.age - typeMs(commandChars(seed, run.line));
      if (run.end && (p.still || typed >= 0))
        exit(ctx, hw - 3.6, y, run.end.ok, Math.min(run.end.age, typed), accent, p.still);
    } else {
      const w = (0.24 + 0.6 * hash01(seed, i + 7919)) * room;
      ctx.fillStyle = PROP.lineLight;
      rounded(ctx, x0, y - bar / 2, w, bar, bar / 2);
      ctx.fill();
      end = { x: x0 + w, y };
    }
    ctx.restore();
  }
  // The cursor waits at the end of the newest line while the command runs.
  const run = p.runs.at(-1);
  if (end && run && !run.end) {
    const last = p.beats.at(-1);
    const busy =
      run.age < typeMs(commandChars(seed, run.line)) || (last !== undefined && last.age < 600);
    if (p.still || busy || Math.floor(p.clock / 530) % 2 === 0) {
      ctx.fillStyle = accent;
      ctx.fillRect(Math.min(end.x + 0.7, hw - 2.2), end.y - 1.1, 1.2, 2.2);
    }
  }
  ctx.restore();
}

// A command on its prompt line: the accent's chevron, then its words as they are typed. Returns
// where the typing has got to.
function command(
  ctx: Context,
  run: Run,
  seed: number,
  x0: number,
  y: number,
  bar: number,
  accent: string,
  still: boolean,
): number {
  ctx.strokeStyle = accent;
  ctx.lineWidth = bar * 0.75;
  ctx.beginPath();
  ctx.moveTo(x0, y - 0.8);
  ctx.lineTo(x0 + 0.9, y);
  ctx.lineTo(x0, y + 0.8);
  ctx.stroke();
  const chars = commandChars(seed, run.line);
  let left = still ? chars : Math.floor(clamp(run.age / typeMs(chars), 0, 1) * chars);
  const cw = 0.7;
  let x = x0 + 2.4;
  ctx.fillStyle = PROP.command;
  for (let word = 0, at = 0; at < chars && left > 0; word++) {
    const len = Math.min(chars - at, 2 + Math.floor(hash01(seed, run.line * 31 + word) * 5));
    const shown = Math.min(len, left);
    rounded(ctx, x, y - bar / 2, shown * cw, bar, bar / 2);
    ctx.fill();
    x += shown * cw;
    if (shown < len) break;
    x += cw;
    at += len + 1;
    left -= len + 1;
  }
  return x;
}

// How a command exited: a tick or a cross that lands with a ring of light, then stays.
function exit(
  ctx: Context,
  x: number,
  y: number,
  ok: boolean,
  age: number,
  accent: string,
  still: boolean,
): void {
  const land = still ? 1 : smoothstep(0, 220, age);
  if (land <= 0) return;
  const colour = ok ? accent : PROP.lineLight;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = colour;
  if (!still && age < 640) {
    const u = age / 640;
    ctx.save();
    ctx.globalAlpha *= 0.5 * (1 - u) ** 2;
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    ctx.arc(0, 0, 1.2 + 2.2 * (1 - (1 - u) ** 3), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  const s = 0.6 + 0.4 * land;
  ctx.scale(s, s);
  ctx.globalAlpha *= land;
  ctx.lineWidth = 0.62;
  ctx.beginPath();
  if (ok) {
    ctx.moveTo(-1, 0.05);
    ctx.lineTo(-0.3, 0.75);
    ctx.lineTo(1.05, -0.8);
  } else {
    ctx.moveTo(-0.75, -0.75);
    ctx.lineTo(0.75, 0.75);
    ctx.moveTo(0.75, -0.75);
    ctx.lineTo(-0.75, 0.75);
  }
  ctx.stroke();
  ctx.restore();
}

// A file dot reads: a plain sheet on a small stack. As what it holds arrives, the top sheet's corner
// nearest dot lifts, folds back and the sheet comes away, and the next page shows under it.
const PAPER = { cx: 48.5, cy: 41.5, hw: 11.5, hh: 13.5 } as const;

function paper(ctx: Context, p: PropPose, ball: Ball): void {
  const { hw, hh } = PAPER;
  emerge(ctx, p, edge(ball, 0.25, 0.8), { x: PAPER.cx, y: PAPER.cy });
  shade(ctx, -hw, -hh, 2 * hw + 1.1, 2 * hh + 1.1, 2.4);
  for (const [d, fill] of [
    [1.1, PROP.pageBack],
    [0.55, PROP.porcelainLo],
  ] as const) {
    rounded(ctx, -hw + d, -hh + d, 2 * hw, 2 * hh, 2.4);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  const seed = Math.floor(p.seed * 1e6);
  // A page turns once the sheet is out, from when what fills it arrived.
  const age = Math.min(p.beats.at(-1)?.age ?? Number.POSITIVE_INFINITY, p.clock - 320);
  const u = p.still ? 1 : clamp(age / PAGE_TURN_MS, 0, 1);
  sheet(ctx, seed, p.lines);
  if (u < 1 && p.lines > 0) curl(ctx, u, () => sheet(ctx, seed, p.lines - 1));
}

function sheet(ctx: Context, seed: number, page: number): void {
  const { hw, hh } = PAPER;
  rounded(ctx, -hw, -hh, 2 * hw, 2 * hh, 2.4);
  ctx.fillStyle = vertical(ctx, -hh, hh, PROP.porcelainHi, PROP.porcelainLo);
  ctx.fill();
  const room = 2 * hw - 5;
  const draw = (i: number) => hash01(seed, page * 97 + i);
  ctx.fillStyle = PROP.lineDark;
  rounded(ctx, -hw + 2.5, -hh + 2.4, (0.36 + 0.3 * draw(0)) * room, 1.5, 0.75);
  ctx.fill();
  ctx.fillStyle = PROP.lineMid;
  for (let i = 1, y = -hh + 6.2; y < hh - 2; i++) {
    // Now and then a paragraph ends, short, before a gap.
    const last = draw(i) < 0.22;
    const w = (last ? 0.3 + 0.35 * draw(i + 50) : 0.84 + 0.14 * draw(i + 50)) * room;
    rounded(ctx, -hw + 2.5, y - 0.45, w, 0.9, 0.45);
    ctx.fill();
    y += last ? 3.6 : 2.15;
  }
}

// The top sheet coming away: its lower left corner folds back across it, then it lifts off up and
// to the right, away from dot.
function curl(ctx: Context, u: number, draw: () => void): void {
  const { hw, hh } = PAPER;
  const s = 1.5 * hw * smoothstep(0, 0.6, u);
  const lift = smoothstep(0.45, 1, u);
  // The fold runs where y - x = c; the sheet keeps the side toward its top right.
  const c = hw + hh - s;
  const m = 40;
  ctx.save();
  ctx.translate(3 * lift, -3.4 * lift);
  ctx.rotate(0.07 * lift);
  ctx.globalAlpha *= 1 - smoothstep(0.45, 0.85, u);
  ctx.beginPath();
  ctx.moveTo(-m, -m);
  ctx.lineTo(m, -m);
  ctx.lineTo(m, m);
  ctx.lineTo(m - c, m);
  ctx.lineTo(-m, c - m);
  ctx.closePath();
  ctx.save();
  ctx.clip();
  draw();
  if (s > 0.05) {
    // The folded corner's shadow on the sheet.
    ctx.fillStyle = PROP.shade;
    flap(ctx, s, 0.7);
    ctx.fill();
  }
  ctx.restore();
  if (s > 0.05) {
    const g = ctx.createLinearGradient(-hw + s / 2, hh - s / 2, -hw + s, hh - s);
    g.addColorStop(0, PROP.porcelainFold);
    g.addColorStop(1, PROP.porcelainHi);
    ctx.fillStyle = g;
    flap(ctx, s, 0);
    ctx.fill();
  }
  ctx.restore();
}

// The corner folded back across the sheet: the corner's triangle mirrored over the fold.
function flap(ctx: Context, s: number, offset: number): void {
  const { hw, hh } = PAPER;
  ctx.beginPath();
  ctx.moveTo(-hw + s + offset, hh + offset);
  ctx.lineTo(-hw + offset, hh - s + offset);
  ctx.lineTo(-hw + s + offset, hh - s + offset);
  ctx.closePath();
}

// A search: the lens reads down a short card of results while it runs; when results come, the row
// it found lights up and the lens settles on it.
function results(ctx: Context, p: PropPose, ball: Ball, accent: string): void {
  const { hw, hh } = RESULTS;
  emerge(ctx, p, edge(ball, 0.3, 0.8), { x: RESULTS.cx, y: RESULTS.cy });
  shade(ctx, -hw, -hh, 2 * hw, 2 * hh, 2.6);
  rounded(ctx, -hw, -hh, 2 * hw, 2 * hh, 2.6);
  ctx.fillStyle = vertical(ctx, -hh, hh, PROP.porcelainHi, PROP.porcelainLo);
  ctx.fill();
  // Each search finds rows of its own.
  const seed = Math.floor(p.seed * 1e6) + 131 * p.runs.length;
  const room = 2 * hw - 4.4;
  ctx.fillStyle = PROP.pageBar;
  rounded(ctx, -hw + 1.6, -hh + 1.5, 2 * hw - 3.2, 2.6, 1.3);
  ctx.fill();
  ctx.fillStyle = PROP.lineDark;
  rounded(ctx, -hw + 3, -hh + 2.45, (0.3 + 0.3 * hash01(seed, 1)) * room, 0.7, 0.35);
  ctx.fill();
  const lens = lensAt(p);
  for (let row = 0; row < 3; row++) {
    const y = resultY(row);
    const lit = row === lens.lit ? lens.found : 0;
    if (lit > 0) {
      ctx.save();
      ctx.globalAlpha *= lit;
      ctx.fillStyle = PROP.graphite;
      rounded(ctx, -hw + 1.2, y - 1.75, 2 * hw - 2.4, 4.6, 1.3);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = lit > 0 ? mix(PROP.lineDark, accent, lit) : PROP.lineDark;
    rounded(ctx, -hw + 2.2, y - 0.6, (0.42 + 0.3 * hash01(seed, row + 2)) * room, 1.2, 0.6);
    ctx.fill();
    ctx.fillStyle = lit > 0 ? mix(PROP.lineMid, PROP.lineLight, lit) : PROP.lineMid;
    rounded(ctx, -hw + 2.2, y + 1.3, (0.66 + 0.26 * hash01(seed, row + 9)) * room, 0.8, 0.4);
    ctx.fill();
  }
  ctx.translate(lens.x, lens.y);
  glass(ctx, 3.3, accent);
}

// A page's rows, repeating: heading, text, an image across three rows.
const PAGE = ["h", "t", "t", "t", "i", "", "", "t", "t", "h", "t", "t", "t", "t"] as const;

function browser(ctx: Context, p: PropPose, ball: Ball, accent: string): void {
  const hw = 13;
  const hh = 14;
  emerge(ctx, p, edge(ball, 0.25, 0.8), { x: 48.5, y: 41 });
  shade(ctx, -hw, -hh, 2 * hw, 2 * hh, 3.2);
  rounded(ctx, -hw, -hh, 2 * hw, 2 * hh, 3.2);
  ctx.fillStyle = vertical(ctx, -hh, hh, PROP.porcelainHi, PROP.porcelainLo);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = PROP.pageBar;
  ctx.fillRect(-hw, -hh, 2 * hw, 4.4);
  const last = p.beats.at(-1);
  if (last && last.age >= 0 && last.age < 1600) {
    const progress = 1 - Math.exp(-last.age / 420);
    ctx.globalAlpha *= 1 - smoothstep(1250, 1600, last.age);
    ctx.fillStyle = accent;
    ctx.fillRect(-hw, -hh + 4.05, 2 * hw * progress, 0.7);
  }
  ctx.restore();
  ctx.fillStyle = PROP.pagePill;
  rounded(ctx, -hw + 2.4, -hh + 1.1, 2 * hw - 4.8, 2.2, 1.1);
  ctx.fill();

  const row = 2.4;
  const offset = p.scroll * 4 + p.clock * 0.0016;
  const top = -hh + 6;
  const seed = Math.floor(p.seed * 1e6);
  const shift = Math.floor(p.seed * PAGE.length);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-hw + 1.6, -hh + 5, 2 * hw - 3.2, 2 * hh - 6.4);
  ctx.clip();
  const first = Math.floor(offset / row) - 3;
  for (let r = first; r < first + 15; r++) {
    const kind = PAGE[(((r + shift) % PAGE.length) + PAGE.length) % PAGE.length];
    const y = top + r * row - offset;
    const w = (0.55 + 0.4 * hash01(seed, r)) * (2 * hw - 5);
    if (kind === "h") {
      ctx.fillStyle = PROP.lineDark;
      rounded(ctx, -hw + 2.5, y - 0.75, w * 0.6, 1.5, 0.75);
      ctx.fill();
    } else if (kind === "t") {
      ctx.fillStyle = PROP.lineMid;
      rounded(ctx, -hw + 2.5, y - 0.45, w, 0.9, 0.45);
      ctx.fill();
    } else if (kind === "i") {
      ctx.fillStyle = PROP.pageImage;
      rounded(ctx, -hw + 2.5, y - 1, 2 * hw - 5, 3 * row - 0.6, 1);
      ctx.fill();
    }
  }
  ctx.restore();
}

// The system pointer, its tip at the origin, pointing up and to the left.
const ARROW = [
  [0, 0],
  [0, 8.6],
  [2.2, 6.6],
  [3.7, 9.9],
  [5.3, 9.2],
  [3.8, 6],
  [6.6, 6],
] as const;
const ARROW_POINTS = Math.atan2(-0.924, -0.383);

function pointer(ctx: Context, p: PropPose, ball: Ball, accent: string): void {
  const drag = p.tool === "dragging";
  const a = p.angle + (drag && !p.still ? dragSway(p.clock) : 0);
  const poke = p.beats.reduce((m, b) => Math.max(m, tapOf(b.age)), 0);
  const reach = ball.r + 3.4 + 1.4 * poke;
  const tip = {
    x: clamp(ball.x + reach * Math.cos(a), 3, 61),
    y: clamp(ball.y + reach * Math.sin(a), 3, 61),
  };
  if (drag) {
    const from = p.angle - 0.45;
    if (a > from + 0.02) {
      ctx.save();
      ctx.globalAlpha *= 0.8 * p.amount;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 0.6;
      ctx.setLineDash([1.1, 1.3]);
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.r + 3.4, from, a);
      ctx.stroke();
      ctx.restore();
    }
  }
  for (const b of p.beats) {
    if (b.age < 0 || b.age > 520) continue;
    const u = b.age / 520;
    ctx.save();
    ctx.globalAlpha *= 0.9 * (1 - u) ** 1.5 * p.amount;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 1 + 5.5 * (1 - (1 - u) ** 3), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  emerge(ctx, p, edge(ball, a), tip);
  if (drag) {
    ctx.fillStyle = accent;
    ctx.globalAlpha *= 0.5;
    ctx.beginPath();
    ctx.arc(0, 0, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha /= 0.5;
  }
  ctx.rotate(a - ARROW_POINTS);
  const s = 1 - 0.15 * poke;
  ctx.scale(s, s);
  ctx.beginPath();
  for (const [i, [x, y]] of ARROW.entries()) {
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = PROP.porcelainHi;
  ctx.strokeStyle = PROP.ink;
  ctx.lineWidth = 0.7;
  ctx.fill();
  ctx.stroke();
}

function lens(ctx: Context, p: PropPose, ball: Ball, accent: string, pose: DotPose): void {
  const f = pose.eyes[1].frame;
  const { body } = pose;
  const eye = {
    x: 32 + body.x + f.cx * body.sx,
    y: 56 + body.y + (32 + f.cy - 56) * body.sy,
  };
  emerge(ctx, p, edge(ball, 0.5, 1.05), eye);
  glass(ctx, 6.3 * body.sx, accent, 1);
}

// A magnifying glass about the origin, its handle down and to the right; k scales its strokes.
function glass(ctx: Context, r: number, accent: string, k = r / 6.3): void {
  ctx.strokeStyle = PROP.graphiteLo;
  ctx.lineWidth = 2.6 * k;
  ctx.beginPath();
  ctx.moveTo(r * Math.cos(0.85), r * Math.sin(0.85));
  ctx.lineTo((r + 8 * k) * Math.cos(0.85), (r + 8 * k) * Math.sin(0.85));
  ctx.stroke();
  ctx.fillStyle = PROP.glass;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5 * k;
  ctx.stroke();
  ctx.strokeStyle = PROP.glassEdge;
  ctx.lineWidth = 0.35 * k;
  ctx.beginPath();
  ctx.arc(0, 0, r - 0.9 * k, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 0.55 * k;
  ctx.beginPath();
  ctx.arc(0, 0, r - 1.8 * k, 3.55, 4.35);
  ctx.stroke();
}

function sparks(ctx: Context, p: PropPose, ball: Ball, accent: string, layer: "back" | "front") {
  const cx = ball.x;
  const cy = ball.y - ball.r - 1.8;
  const rx = ball.r * 0.78;
  const from = { x: ball.x, y: ball.y - ball.r * 0.6 };
  for (let i = 0; i < 3; i++) {
    const turn = p.clock * ((2 * Math.PI) / 5200) + (i * 2 * Math.PI) / 3 + 0.5;
    const depth = Math.sin(turn);
    if (depth < 0 !== (layer === "back")) continue;
    const at = { x: cx + rx * Math.cos(turn), y: cy + 3.4 * depth };
    const twinkle = p.still ? 1 : 1 + 0.14 * Math.sin(p.clock / 260 + 2 * i);
    const size = [2.9, 2.2, 1.8][i] as number;
    ctx.save();
    emerge(ctx, p, from, at);
    ctx.globalAlpha *= 0.55 + 0.45 * ((depth + 1) / 2);
    const r = size * (0.8 + 0.2 * depth) * twinkle;
    ctx.beginPath();
    for (let j = 0; j < 8; j++) {
      const rr = j % 2 ? r * 0.42 : r;
      const an = (j * Math.PI) / 4 - Math.PI / 2;
      if (j === 0) ctx.moveTo(rr * Math.cos(an), rr * Math.sin(an));
      else ctx.lineTo(rr * Math.cos(an), rr * Math.sin(an));
    }
    ctx.closePath();
    ctx.fillStyle = i === 0 ? accent : PROP.porcelainHi;
    ctx.fill();
    ctx.restore();
  }
}

function clock(ctx: Context, p: PropPose, ball: Ball, accent: string): void {
  const r = 6.6;
  emerge(ctx, p, edge(ball, 0.65, 0.75), { x: 52.5, y: 49 });
  ctx.fillStyle = PROP.shade;
  ctx.beginPath();
  ctx.arc(0, 0.8, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = vertical(ctx, -r, r, PROP.porcelainHi, PROP.porcelainLo);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PROP.ink;
  ctx.lineWidth = 0.5;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo((r - 1.5) * Math.cos(a), (r - 1.5) * Math.sin(a));
    ctx.lineTo((r - 0.8) * Math.cos(a), (r - 0.8) * Math.sin(a));
    ctx.stroke();
  }
  const hand = -Math.PI / 2 + (p.clock * 2 * Math.PI) / 2400;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 0.75;
  ctx.globalAlpha *= 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, r - 2, hand - 1.1, hand);
  ctx.stroke();
  ctx.globalAlpha /= 0.9;
  ctx.strokeStyle = PROP.ink;
  ctx.lineWidth = 0.95;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  const hour = -Math.PI / 2 + 2 + (p.clock * 2 * Math.PI) / 28_800;
  ctx.lineTo(2.4 * Math.cos(hour), 2.4 * Math.sin(hour));
  ctx.moveTo(0, 0);
  ctx.lineTo((r - 1.6) * Math.cos(hand), (r - 1.6) * Math.sin(hand));
  ctx.stroke();
  ctx.fillStyle = PROP.ink;
  ctx.beginPath();
  ctx.arc(0, 0, 0.65, 0, Math.PI * 2);
  ctx.fill();
}

// A hand raised from behind dot's shoulder, waving twice every few seconds.
function hand(ctx: Context, p: PropPose, ball: Ball): void {
  const wrist = edge(ball, 3.72, 0.74);
  const u = p.clock % 3200;
  const wave =
    p.still || u > 1200
      ? 0
      : 0.26 * Math.sin((2 * Math.PI * u) / 600) * Math.sin((Math.PI * u) / 1200);
  ctx.translate(wrist.x, wrist.y);
  ctx.rotate(-0.5 + wave);
  const a = p.amount;
  if (p.still) ctx.globalAlpha *= a;
  else {
    ctx.translate(0, (1 - a) * 12);
    ctx.globalAlpha *= Math.min(1, a * 1.5);
  }
  ctx.fillStyle = vertical(ctx, -17, 3, PROP.porcelainHi, PROP.porcelainLo);
  rounded(ctx, -2.1, -6, 4.2, 9, 2.1);
  ctx.fill();
  rounded(ctx, -3.7, -12.6, 7.4, 7.8, 2.6);
  ctx.fill();
  for (const [x, top] of [
    [-2.75, -15.4],
    [-0.92, -16.5],
    [0.92, -16.3],
    [2.75, -15],
  ] as const) {
    rounded(ctx, x - 0.85, top, 1.7, -10.5 - top, 0.85);
    ctx.fill();
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = PROP.porcelainLo;
  ctx.beginPath();
  ctx.moveTo(3, -8);
  ctx.lineTo(5.3, -11.2);
  ctx.stroke();
}

function plane(ctx: Context, p: PropPose, ball: Ball, accent: string): void {
  const ready = edge(ball, 0.2, 1.12);
  const { flight, launch } = p.still ? { flight: -1, launch: 0 } : planeAt(p.clock);
  let grow = 1;
  if (!p.still && flight < 0) {
    grow =
      p.clock < PLANE_FIRST_MS
        ? smoothstep(0, PLANE_FIRST_MS * 0.8, p.clock)
        : smoothstep(
            0,
            0.35,
            (p.clock - launch - PLANE_FLIGHT_MS) / (PLANE_EVERY_MS - PLANE_FLIGHT_MS),
          );
  }
  ctx.save();
  emerge(ctx, p, { x: ball.x + ball.r * 0.5, y: ball.y }, ready);
  if (flight < 0) {
    ctx.rotate(-0.35);
    ctx.scale(grow, grow);
    paperPlane(ctx);
    ctx.restore();
    return;
  }
  ctx.restore();
  const e = flight ** 1.6;
  const control = { x: ready.x + 9, y: ready.y - 15 };
  const end = { x: 70, y: -4 };
  const at = (s: number) => ({
    x: (1 - s) ** 2 * ready.x + 2 * (1 - s) * s * control.x + s * s * end.x,
    y: (1 - s) ** 2 * ready.y + 2 * (1 - s) * s * control.y + s * s * end.y,
  });
  ctx.globalAlpha *= Math.min(1, p.amount * 1.5);
  ctx.save();
  ctx.globalAlpha *= 0.6 * (1 - flight);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 0.55;
  ctx.setLineDash([1, 1.4]);
  ctx.beginPath();
  for (let s = Math.max(0, e - 0.35), i = 0; s <= e; s += 0.04, i++) {
    const q = at(s);
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  ctx.restore();
  const q = at(e);
  const ahead = at(Math.min(1, e + 0.02));
  ctx.translate(q.x, q.y);
  ctx.rotate(Math.atan2(ahead.y - q.y, ahead.x - q.x));
  const s = 1 - 0.35 * e;
  ctx.scale(s, s);
  ctx.globalAlpha *= 1 - smoothstep(0.65, 1, flight);
  paperPlane(ctx);
}

function paperPlane(ctx: Context): void {
  ctx.scale(1.3, 1.3);
  ctx.fillStyle = PROP.porcelainHi;
  ctx.beginPath();
  ctx.moveTo(-4.6, -3);
  ctx.lineTo(5.2, 0);
  ctx.lineTo(-2.4, 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = PROP.porcelainFold;
  ctx.beginPath();
  ctx.moveTo(-2.4, 0.3);
  ctx.lineTo(5.2, 0);
  ctx.lineTo(-3.6, 2.6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = PROP.fold;
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  ctx.moveTo(-2.4, 0.3);
  ctx.lineTo(5.2, 0);
  ctx.stroke();
}

function folder(ctx: Context, p: PropPose, ball: Ball, accent: string): void {
  emerge(ctx, p, edge(ball, 0.4, 0.8), { x: 49.5, y: 47.5 });
  ctx.fillStyle = PROP.graphite;
  rounded(ctx, -10, -8.6, 7.5, 3.4, 1);
  ctx.fill();
  rounded(ctx, -10, -6.5, 20, 13.5, 1.6);
  ctx.fill();
  const u = p.still ? 0.3 : (p.clock % FILE_EVERY_MS) / FILE_EVERY_MS;
  const drop = 1 - (1 - clamp(u / 0.45, 0, 1)) ** 3;
  const fold = smoothstep(0.45, 0.72, u);
  const hs = 1 - 0.45 * fold;
  ctx.save();
  ctx.translate(0, -17 + 14 * drop + 2.5 * fold);
  ctx.rotate(-0.18 * (1 - drop));
  ctx.globalAlpha *= p.still ? 1 : smoothstep(0, 0.1, u) * (1 - smoothstep(0.72, 0.8, u));
  ctx.fillStyle = PROP.porcelainHi;
  rounded(ctx, -5.5, -6.5 * hs, 11, 13 * hs, 0.8);
  ctx.fill();
  ctx.fillStyle = PROP.lineMid;
  for (const y of [-3.6, -1.6, 0.4]) {
    rounded(ctx, -3.6, y * hs - 0.4, y === 0.4 ? 4.5 : 7.2, 0.8, 0.4);
    ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = vertical(ctx, -1.8, 7, PROP.graphiteHi, PROP.graphite);
  rounded(ctx, -10, -1.8, 20, 8.8, 1.6);
  ctx.fill();
  const flash = Math.sin(Math.PI * clamp((u - 0.6) / 0.35, 0, 1));
  ctx.globalAlpha *= 0.35 + 0.65 * (p.still ? 0 : flash);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 0.55;
  ctx.beginPath();
  ctx.moveTo(-8.4, -1.8);
  ctx.lineTo(8.4, -1.8);
  ctx.stroke();
}

// The book dot keeps what it knows in: a page turns as each lookup starts, and each note saved is
// written onto the right-hand page, a line at a time, with a pen.
function book(ctx: Context, p: PropPose, ball: Ball, accent: string): void {
  emerge(ctx, p, edge(ball, 0.4, 0.8), { x: BOOK.cx, y: BOOK.cy });
  ctx.fillStyle = PROP.graphite;
  rounded(ctx, -11.2, -7, 22.4, 14.4, 1.4);
  ctx.fill();
  const page = (side: -1 | 1, w: number, fill: string, lines: number) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.quadraticCurveTo(side * w * 0.5, -6.9, side * w, -6);
    ctx.lineTo(side * w, 6.4);
    ctx.quadraticCurveTo(side * w * 0.5, 5.6, 0, 6.4);
    ctx.closePath();
    ctx.fill();
    if (lines <= 0.02) return;
    ctx.save();
    ctx.globalAlpha *= lines;
    ctx.fillStyle = PROP.lineMid;
    for (const [i, y] of NOTE_LINES.entries()) {
      const len = (i === 3 ? 0.45 : 0.75) * Math.abs(w);
      const x = side > 0 ? 1.6 : -1.6 - len;
      rounded(ctx, x, y - 0.35, len, 0.7, 0.35);
      ctx.fill();
    }
    ctx.restore();
  };
  const writing = p.tool === "remembering";
  page(-1, 10.2, PROP.porcelainLo, 1);
  page(1, 10.2, PROP.porcelainHi, writing ? 0 : 1);
  ctx.fillStyle = PROP.spine;
  ctx.fillRect(-0.45, -6, 0.9, 12.4);
  if (writing) notes(ctx, p);
  else {
    const u = flipOf(p.runs.at(-1), p.still);
    if (u > 0 && u < 1) {
      const c = Math.cos(Math.PI * smoothstep(0, 1, u));
      if (c >= 0) page(1, 10.2 * c, PROP.porcelainHi, c);
      else page(-1, -10.2 * c, PROP.pageBack, -c);
    }
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(1.6, 6.2);
  ctx.lineTo(1.9, 9.6);
  ctx.stroke();
}

// The notes written since the book came out, the newest drawn in after the pen, which then lifts.
function notes(ctx: Context, p: PropPose): void {
  if (p.lines === 0) return;
  const shown = ((p.lines - 1) % NOTE_LINES.length) + 1;
  const age = p.still
    ? Number.POSITIVE_INFINITY
    : (p.beats.at(-1)?.age ?? Number.POSITIVE_INFINITY);
  const drawn = smoothstep(0, WRITE_MS, age);
  let nib: Point = { x: 1.6, y: 0 };
  for (let i = 0; i < shown; i++) {
    const y = NOTE_LINES[i] ?? 0;
    const len = (i === 3 ? 0.45 : 0.75) * 10.2;
    const newest = i === shown - 1;
    const w = newest ? len * drawn : len;
    // Fresh ink is dark, and dries to the page's grey.
    ctx.fillStyle = newest
      ? mix(PROP.ink, PROP.lineMid, smoothstep(WRITE_MS, WRITE_MS + 600, age))
      : PROP.lineMid;
    if (w > 0.05) {
      rounded(ctx, 1.6, y - 0.35, w, 0.7, 0.35);
      ctx.fill();
    }
    if (newest) nib = { x: 1.6 + w, y };
  }
  const lift = smoothstep(WRITE_MS, WRITE_MS + 280, age);
  if (lift >= 1) return;
  ctx.save();
  ctx.globalAlpha *= smoothstep(0, 140, age) * (1 - lift);
  ctx.translate(nib.x + 0.4 * lift, nib.y - 0.35 - 2.2 * lift);
  pen(ctx);
  ctx.restore();
}

// A pen with its nib at the origin, leaning up and to the right.
function pen(ctx: Context): void {
  ctx.rotate(-1.05);
  ctx.fillStyle = PROP.graphiteLo;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(1.5, -0.6);
  ctx.lineTo(1.5, 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = vertical(ctx, -0.6, 0.6, PROP.graphiteHi, PROP.graphite);
  rounded(ctx, 1.3, -0.6, 6.4, 1.2, 0.5);
  ctx.fill();
  ctx.fillStyle = PROP.porcelainLo;
  rounded(ctx, 6.2, -0.6, 1.5, 1.2, 0.5);
  ctx.fill();
}

// The plan: a checklist whose next item is ticked off as the plan is updated; done items scroll up
// and away, keeping the next in view.
function checklist(ctx: Context, p: PropPose, ball: Ball, accent: string, fine: boolean): void {
  const { hw, hh } = PLAN;
  emerge(ctx, p, edge(ball, 0.35, 0.8), { x: PLAN.cx, y: PLAN.cy });
  shade(ctx, -hw, -hh, 2 * hw, 2 * hh, 2.4);
  rounded(ctx, -hw, -hh, 2 * hw, 2 * hh, 2.4);
  ctx.fillStyle = vertical(ctx, -hh, hh, PROP.porcelainHi, PROP.porcelainLo);
  ctx.fill();
  ctx.fillStyle = PROP.lineDark;
  rounded(ctx, -hw + 2.2, -hh + 1.9, 7.5, 1.4, 0.7);
  ctx.fill();
  const offset = planOffset(p.scroll);
  const seed = Math.floor(p.seed * 1e6);
  const room = 2 * hw - 8.6;
  const box = fine ? 2.6 : 3;
  const top = -hh + 4;
  ctx.save();
  ctx.beginPath();
  ctx.rect(-hw, top, 2 * hw, hh - 1 - top);
  ctx.clip();
  for (let i = Math.max(0, Math.floor(offset) - 1); i <= offset + 3; i++) {
    const y = planY(i, offset);
    // Items fade as they slide past the card's edges.
    const fade = smoothstep(top - 1, top + 2.2, y) * (1 - smoothstep(hh - 4.2, hh - 1.2, y));
    if (fade <= 0) continue;
    ctx.save();
    ctx.globalAlpha *= fade;
    const done = i < p.lines;
    const next = i === p.lines;
    // Each item done since the list came out ticks with its own beat, the last beat the newest.
    const beat = p.beats[p.beats.length - (p.lines - i)];
    const tick = !done ? 0 : beat && !p.still ? clamp(beat.age / TICK_MS, 0, 1) : 1;
    const bx = -hw + 2.2;
    if (tick > 0) {
      ctx.save();
      ctx.globalAlpha *= smoothstep(0, 0.35, tick);
      ctx.fillStyle = PROP.graphite;
      rounded(ctx, bx, y - box / 2, box, box, 0.75);
      ctx.fill();
      ctx.restore();
      ticked(ctx, bx + box / 2, y, box / 2.6, smoothstep(0.2, 1, tick), accent);
    } else {
      ctx.strokeStyle = next ? PROP.lineDark : PROP.lineMid;
      ctx.lineWidth = 0.42;
      rounded(ctx, bx + 0.2, y - box / 2 + 0.2, box - 0.4, box - 0.4, 0.65);
      ctx.stroke();
    }
    ctx.fillStyle = next ? PROP.lineDark : PROP.lineMid;
    if (done) ctx.globalAlpha *= 1 - 0.45 * tick;
    rounded(ctx, -hw + 6, y - 0.52, (0.42 + 0.45 * hash01(seed, i)) * room, 1.05, 0.52);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// A tick about (x, y), drawn this far along its stroke.
function ticked(
  ctx: Context,
  x: number,
  y: number,
  s: number,
  drawn: number,
  colour: string,
): void {
  if (drawn <= 0) return;
  const points = [
    [-0.78, 0.04],
    [-0.22, 0.6],
    [0.82, -0.62],
  ] as const;
  const a = Math.hypot(0.56, 0.56);
  const b = Math.hypot(1.04, 1.22);
  let left = drawn * (a + b);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 0.42 * s * 1.6;
  ctx.beginPath();
  ctx.moveTo(x + points[0][0] * s, y + points[0][1] * s);
  for (const [i, length] of [a, b].entries()) {
    const [x0, y0] = points[i] as readonly [number, number];
    const [x1, y1] = points[i + 1] as readonly [number, number];
    const u = Math.min(1, left / length);
    ctx.lineTo(x + (x0 + (x1 - x0) * u) * s, y + (y0 + (y1 - y0) * u) * s);
    left -= length;
    if (left <= 0) break;
  }
  ctx.stroke();
}

// A schedule: a calendar behind a clock whose minute hand sweeps round to the time set. A mark lands
// there and the day is marked on the calendar.
function calendar(ctx: Context, p: PropPose, ball: Ball, accent: string): void {
  const { clock: c, card } = SCHEDULE;
  emerge(ctx, p, edge(ball, 0.5, 0.8), c);
  const { angle, mark, set, k } = handAt(p);
  const marked = smoothstep(0.82, 1, set);
  ctx.save();
  ctx.translate(card.x - c.x, card.y - c.y);
  shade(ctx, -card.hw, -card.hh, 2 * card.hw, 2 * card.hh, 1.4);
  rounded(ctx, -card.hw, -card.hh, 2 * card.hw, 2 * card.hh, 1.4);
  ctx.fillStyle = vertical(ctx, -card.hh, card.hh, PROP.porcelainHi, PROP.porcelainLo);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = PROP.graphite;
  ctx.fillRect(-card.hw, -card.hh, 2 * card.hw, 2.8);
  ctx.restore();
  ctx.fillStyle = PROP.porcelainHi;
  for (const x of [-2.4, 2.4]) {
    rounded(ctx, x - 0.45, -card.hh - 0.9, 0.9, 2.2, 0.45);
    ctx.fill();
  }
  const day = Math.floor(k * 11);
  for (let i = 0; i < 12; i++) {
    const x = -card.hw + 1.25 + (i % 4) * 2.65;
    const y = -card.hh + 4.3 + Math.floor(i / 4) * 2.15;
    if (i === day && marked > 0) {
      ctx.save();
      ctx.globalAlpha *= marked;
      ctx.fillStyle = PROP.graphite;
      ctx.beginPath();
      ctx.arc(x + 0.45, y + 0.45, 1.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(x + 0.45, y + 0.45, 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      continue;
    }
    ctx.fillStyle = PROP.lineMid;
    rounded(ctx, x, y, 0.9, 0.9, 0.25);
    ctx.fill();
  }
  ctx.restore();

  const r = c.r;
  ctx.fillStyle = PROP.shade;
  ctx.beginPath();
  ctx.arc(0, 0.8, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = vertical(ctx, -r, r, PROP.porcelainHi, PROP.porcelainLo);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PROP.ink;
  ctx.lineWidth = 0.5;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo((r - 1.5) * Math.cos(a), (r - 1.5) * Math.sin(a));
    ctx.lineTo((r - 0.8) * Math.cos(a), (r - 0.8) * Math.sin(a));
    ctx.stroke();
  }
  if (marked > 0) {
    ctx.save();
    ctx.globalAlpha *= marked;
    ctx.strokeStyle = PROP.graphite;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo((r - 2.1) * Math.cos(mark), (r - 2.1) * Math.sin(mark));
    ctx.lineTo((r - 0.75) * Math.cos(mark), (r - 0.75) * Math.sin(mark));
    ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = PROP.ink;
  ctx.lineWidth = 0.95;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  const hour = -Math.PI / 2 + 2 * Math.PI * hash01(Math.floor(p.seed * 1e6), 3);
  ctx.lineTo(2.4 * Math.cos(hour), 2.4 * Math.sin(hour));
  ctx.moveTo(0, 0);
  ctx.lineTo((r - 1.6) * Math.cos(angle), (r - 1.6) * Math.sin(angle));
  ctx.stroke();
  ctx.fillStyle = PROP.ink;
  ctx.beginPath();
  ctx.arc(0, 0, 0.65, 0, Math.PI * 2);
  ctx.fill();
}

// Sub-agents at work: a small dot hops out of dot for each and floats beside it, bobbing, its eyes
// on dot. When its work is done it smiles if it went well, and pops back in.
function helpers(
  ctx: Context,
  p: PropPose,
  ball: Ball,
  list: readonly HelperPose[],
  plate: CanvasImageSource | null,
): void {
  for (const h of list) {
    const slot = HELPER_SLOTS[h.slot];
    if (!slot) continue;
    const out = h.amount * p.amount;
    const from = edge(ball, Math.atan2(slot.y - ball.y, slot.x - ball.x), 0.55);
    let { x, y } = slot;
    let r = slot.r;
    ctx.save();
    if (p.still) ctx.globalAlpha *= out;
    else {
      x = from.x + (slot.x - from.x) * out;
      y = from.y + (slot.y - from.y) * out - 4.5 * Math.sin(Math.PI * out);
      r *= 0.35 + 0.65 * out;
      ctx.globalAlpha *= Math.min(1, out * 1.6);
      // Out and settled, it bobs gently, each to its own time.
      const period = 2000 + 700 * h.seed;
      const bob = 0.5 - 0.5 * Math.cos((2 * Math.PI * (h.age + 2000 * h.seed)) / period);
      y -= 0.7 * bob * smoothstep(0.85, 1, h.amount);
    }
    const s = r / 24;
    if (plate) ctx.drawImage(plate, x - 32 * s, y - 32 * s, 64 * s, 64 * s);
    else pearl(ctx, x, y, r);
    helperEyes(ctx, x, y, s, h, ball, p.still);
    ctx.restore();
  }
}

// A helper's eyes, a small copy of dot's own, turned toward dot; they blink now and then and become
// smiles when its work is done well.
function helperEyes(
  ctx: Context,
  x: number,
  y: number,
  s: number,
  h: HelperPose,
  toward: Point,
  still: boolean,
): void {
  const happy = h.end?.ok ? (still ? 1 : smoothstep(0, 160, h.end.age)) : 0;
  const d = Math.hypot(toward.x - x, toward.y - y) || 1;
  const gx = (1.8 * (toward.x - x)) / d;
  const gy = (1.2 * (toward.y - y)) / d;
  const cycle = still ? 1000 : (h.age + 4100 * h.seed) % 3900;
  const blink = cycle < 150 ? Math.sin((Math.PI * cycle) / 150) : 0;
  ctx.fillStyle = PROP.ink;
  ctx.strokeStyle = PROP.ink;
  ctx.lineCap = "round";
  for (const side of [-1, 1]) {
    const ex = x + (side * 5.5 + gx) * s;
    const ey = y + (-4.5 + gy) * s;
    if (happy < 1) {
      const w = 5.4 * s;
      const hgt = 10 * s * (1 - 0.85 * blink);
      ctx.save();
      ctx.globalAlpha *= 1 - happy;
      rounded(ctx, ex - w / 2, ey - hgt / 2, w, hgt, w / 2);
      ctx.fill();
      ctx.restore();
    }
    if (happy > 0) {
      ctx.save();
      ctx.globalAlpha *= happy;
      ctx.lineWidth = 2.1 * s;
      ctx.beginPath();
      ctx.moveTo(ex - 3.45 * s, ey + 1.1 * s);
      ctx.quadraticCurveTo(ex, ey - 4.1 * s, ex + 3.45 * s, ey + 1.1 * s);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// A small dot's body where the plate has not loaded: the porcelain of DotView's SVG skin.
function pearl(ctx: Context, x: number, y: number, r: number): void {
  const g = ctx.createRadialGradient(
    x - 0.26 * r,
    y - 0.4 * r,
    0,
    x - 0.26 * r,
    y - 0.4 * r,
    1.56 * r,
  );
  for (const [offset, colour] of PEARL_STOPS) g.addColorStop(offset, colour);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
