import type { DotPose } from "../engine/engine.ts";
import { clamp, smoothstep } from "../engine/math.ts";
import { hash01 } from "../engine/rng.ts";
import {
  dragSway,
  FILE_EVERY_MS,
  KEYBOARD,
  keyOf,
  keyRow,
  PAGE_EVERY_MS,
  PAGE_FLIP_MS,
  PLANE_EVERY_MS,
  PLANE_FIRST_MS,
  PLANE_FLIGHT_MS,
  type PropPose,
  planeAt,
  pressOf,
  tapOf,
} from "../engine/tools.ts";
import { PROP } from "./dot-colours.ts";

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
// The accent is the porcelain highlight, warming to xenon as dot takes control.
export function paintProps(ctx: Context, pose: DotPose, layer: PropLayer, xenon: string): void {
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
      PAINT[p.tool]?.(ctx, p, ball, accent, pose);
    }
    ctx.restore();
  }
}

type Painter = (ctx: Context, p: PropPose, ball: Ball, accent: string, pose: DotPose) => void;

const PAINT: Partial<Record<PropPose["tool"], Painter>> = {
  typing: (ctx, p, ball, accent, pose) => keyboard(ctx, p, ball, accent, pose.fine),
  terminal: (ctx, p, ball, accent, pose) => terminal(ctx, p, ball, accent, pose.fine),
  browsing: (ctx, p, ball, accent) => browser(ctx, p, ball, accent),
  pointing: (ctx, p, ball, accent) => pointer(ctx, p, ball, accent),
  dragging: (ctx, p, ball, accent) => pointer(ctx, p, ball, accent),
  looking: (ctx, p, ball, accent, pose) => lens(ctx, p, ball, accent, pose),
  thinking: (ctx, p, ball, accent) => sparks(ctx, p, ball, accent, "front"),
  waiting: (ctx, p, ball, accent) => clock(ctx, p, ball, accent),
  sending: (ctx, p, ball, accent) => plane(ctx, p, ball, accent),
  filing: (ctx, p, ball, accent) => folder(ctx, p, ball, accent),
  recalling: (ctx, p, ball, accent) => book(ctx, p, ball, accent),
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

function terminal(ctx: Context, p: PropPose, ball: Ball, accent: string, fine: boolean): void {
  const hw = 13;
  const hh = 12;
  emerge(ctx, p, edge(ball, 0.35, 0.8), { x: 48.5, y: 42.5 });
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

  const lh = fine ? 3 : 3.4;
  const bar = fine ? 1.1 : 1.45;
  const x0 = -hw + 2;
  const bottom = hh - 2.8;
  const seed = Math.floor(p.seed * 1e6);
  const widthOf = (i: number) => (0.28 + 0.6 * hash01(seed, i)) * (2 * hw - 5);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-hw + 1, -hh + 4.2, 2 * hw - 2, 2 * hh - 5.4);
  ctx.clip();
  for (let i = p.lines - 7; i <= p.lines; i++) {
    const y = bottom + (i - p.scroll) * lh;
    let x = x0;
    if (hash01(seed, i + 7919) < 0.3) {
      ctx.strokeStyle = PROP.lineLight;
      ctx.lineWidth = bar * 0.75;
      ctx.beginPath();
      ctx.moveTo(x, y - 0.8);
      ctx.lineTo(x + 0.9, y);
      ctx.lineTo(x, y + 0.8);
      ctx.stroke();
      x += 2.2;
    }
    ctx.fillStyle = PROP.lineLight;
    rounded(ctx, x, y - bar / 2, Math.min(widthOf(i), hw - x - 1.5), bar, bar / 2);
    ctx.fill();
  }
  const last = p.beats.at(-1);
  const busy = last !== undefined && last.age < 600;
  const on = p.still || busy || Math.floor(p.clock / 530) % 2 === 0;
  if (on) {
    const y = bottom + (p.lines - p.scroll) * lh;
    const x = x0 + Math.min(widthOf(p.lines), hw - x0 - 1.5) + 0.9;
    ctx.fillStyle = accent;
    ctx.fillRect(Math.min(x, hw - 2.2), y - 1.1, 1.2, 2.2);
  }
  ctx.restore();
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
  const r = 6.3 * body.sx;
  emerge(ctx, p, edge(ball, 0.5, 1.05), eye);
  ctx.strokeStyle = PROP.graphiteLo;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(r * Math.cos(0.85), r * Math.sin(0.85));
  ctx.lineTo((r + 8) * Math.cos(0.85), (r + 8) * Math.sin(0.85));
  ctx.stroke();
  ctx.fillStyle = PROP.glass;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.strokeStyle = PROP.glassEdge;
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  ctx.arc(0, 0, r - 0.9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 0.55;
  ctx.beginPath();
  ctx.arc(0, 0, r - 1.8, 3.55, 4.35);
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

function book(ctx: Context, p: PropPose, ball: Ball, accent: string): void {
  emerge(ctx, p, edge(ball, 0.4, 0.8), { x: 49.5, y: 48.5 });
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
    for (const [i, y] of [-3.4, -1.4, 0.6, 2.6].entries()) {
      const len = (i === 3 ? 0.45 : 0.75) * Math.abs(w);
      const x = side > 0 ? 1.6 : -1.6 - len;
      rounded(ctx, x, y - 0.35, len, 0.7, 0.35);
      ctx.fill();
    }
    ctx.restore();
  };
  page(-1, 10.2, PROP.porcelainLo, 1);
  page(1, 10.2, PROP.porcelainHi, 1);
  ctx.fillStyle = PROP.spine;
  ctx.fillRect(-0.45, -6, 0.9, 12.4);
  const u = p.still ? 0 : clamp(((p.clock % PAGE_EVERY_MS) - 300) / PAGE_FLIP_MS, 0, 1);
  if (u > 0 && u < 1) {
    const c = Math.cos(Math.PI * smoothstep(0, 1, u));
    if (c >= 0) page(1, 10.2 * c, PROP.porcelainHi, c);
    else page(-1, -10.2 * c, PROP.pageBack, -c);
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(1.6, 6.2);
  ctx.lineTo(1.9, 9.6);
  ctx.stroke();
}

// Mixes two colours given as #rrggbb or rgb()/rgba() (whose alpha is dropped).
function mix(a: string, b: string, t: number): string {
  const pa = rgb(a);
  const pb = rgb(b);
  if (!pa || !pb) return t < 0.5 ? a : b;
  const c = pa.map((v, i) => Math.round(v + ((pb[i] as number) - v) * clamp(t, 0, 1)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function rgb(colour: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(colour.trim());
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null;
}
