import { mulberry32, type SpringParams } from "@localdot/stage";
import { Channel } from "./channel.ts";
import { clamp } from "./math.ts";
import { hash01, lognormal } from "./rng.ts";
import { EYE_ANCHORS, type EyeFrame, eyeFrame, GAZE_MAX, R } from "./sphere.ts";
import {
  ASLEEP,
  BASE_POSE,
  type DotState,
  type Lod,
  POSE_KEYS,
  type Pose,
  type Reaction,
  RICH_LODS,
  SPRINGS,
  SQUASH_CAP,
  STATE_HOLD_MS,
  STATES,
  STILL_EYES,
  SUCCESS_GAP_MS,
  spring,
} from "./states.ts";

type Motion = "gx" | "gy" | "mx" | "my" | "squash" | "lift" | "shake" | "eyeSY" | "rim";
type BlinkTiming = readonly [close: number, hold: number, open: number];
type LookKind = "saccade" | "drift" | "pursuit";
interface Point {
  x: number;
  y: number;
}
interface Scheduled {
  t: number;
  // -1 survives state changes; anything else belongs to that state generation.
  gen: number;
  run(t: number): void;
}

const BLINK: BlinkTiming = [70, 30, 140];
const BLINK_PEAK = 0.9;
// Where dot rests its gaze (toward the stage) and the places it attends to, in frame units.
const BIAS: Point = { x: 0.25 * GAZE_MAX.x, y: 0.12 * GAZE_MAX.y };
const COMPOSER: Point = { x: -3.5, y: 4.5 };
const CARD: Point = { x: 4.5, y: 3.5 };
const ANNOYED_WINDOW_MS = 60_000;
// How far one unit of each channel moves something on screen, in frame units, so activity() can
// compare them: lids and eye shapes by the eye's height, a body scale by its height, tilt and roll
// by how far a degree swings a lid corner or an eye, and a full fade counts as a 20-unit move.
const EYE_H = 10;
const FADE = 20;
const SPEED_UNITS: Record<keyof Pose | Motion, number> = {
  gx: 1,
  gy: 1,
  mx: 1,
  my: 1,
  bodyX: 1,
  bodyY: 1,
  lift: 1,
  shake: 1,
  breath: 1,
  squash: 2 * R,
  size: 2 * R,
  upL: EYE_H,
  upR: EYE_H,
  lo: EYE_H,
  loArch: EYE_H,
  eyeSY: EYE_H,
  eyeScale: EYE_H,
  happy: EYE_H,
  closed: EYE_H,
  tiltL: 0.15,
  tiltR: 0.15,
  roll: 0.12,
  eyeOpacity: FADE,
  dim: FADE,
  rim: FADE,
};
const SPEED_KEYS = Object.keys(SPEED_UNITS) as (keyof Pose | Motion)[];
// Channels that show only where the body animates.
const RICH_ONLY: ReadonlySet<keyof Pose | Motion> = new Set([
  "mx",
  "my",
  "lift",
  "shake",
  "squash",
  "breath",
]);

export interface EyePose {
  frame: EyeFrame;
  up: number;
  lo: number;
  loArch: number;
  tilt: number;
  scale: number;
  sy: number;
  happy: number;
  closed: number;
  opacity: number;
}

export interface DotPose {
  t: number;
  state: DotState;
  // Body offset in frame units and its scale; the origin is the body's bottom.
  body: { x: number; y: number; sx: number; sy: number };
  shadow: { s: number; o: number };
  // Crossfade weights of the dim and xenon body plates.
  plate: { dim: number; rim: number };
  eyes: [EyePose, EyePose];
  blink: number;
  talk: number;
  gaze: Point;
}

export interface DotEngineOptions {
  seed: number;
  t: number;
  state?: DotState;
  lod?: Lod;
  reducedMotion?: boolean;
  control?: boolean;
}

// dot's behaviour as a pure function of its seed, its inputs and time: every retarget happens at a
// scheduled event's own time, never at frame time, so pose(t) does not depend on the frame rate.
// Times are in milliseconds.
export class DotEngine {
  private readonly seed: number;
  private readonly rng: () => number;
  private reduced: boolean;
  private lod: Lod;
  private control: boolean;
  private readonly ch: Record<keyof Pose | Motion, Channel>;
  private queue: Scheduled[] = [];
  private gen = 0;
  private current: DotState;
  private since: number;
  private deferred: DotState | null = null;
  private blinks: { t: number; d: BlinkTiming }[] = [];
  private deltas: { t: number; a: number }[] = [];
  private errors: number[] = [];
  private lastSuccess = Number.NEGATIVE_INFINITY;
  private blinkBlockUntil = Number.NEGATIVE_INFINITY;
  private breath: { phase: number; t0: number; period: number };

  constructor(o: DotEngineOptions) {
    this.seed = o.seed;
    this.rng = mulberry32(o.seed);
    this.reduced = o.reducedMotion ?? false;
    this.lod = o.lod ?? "hero";
    this.control = o.control ?? false;
    const ch = {} as Record<keyof Pose | Motion, Channel>;
    for (const k of POSE_KEYS) ch[k] = new Channel(BASE_POSE[k], SPRINGS.pose);
    ch.gx = new Channel(0, SPRINGS.saccade);
    ch.gy = new Channel(0, SPRINGS.saccade);
    ch.mx = new Channel(0, SPRINGS.snap);
    ch.my = new Channel(0, SPRINGS.snap);
    ch.squash = new Channel(0, SPRINGS.body);
    ch.lift = new Channel(0, SPRINGS.hop);
    ch.shake = new Channel(0, SPRINGS.shake);
    ch.eyeSY = new Channel(1, SPRINGS.snap);
    ch.rim = new Channel(this.control ? 1 : 0, SPRINGS.body);
    this.ch = ch;
    this.current = o.state ?? "idle";
    this.since = o.t;
    this.breath = { phase: 0, t0: o.t, period: STATES[this.current].period };
    this.enter(this.current, o.t, null, true);
  }

  setState(name: DotState, t: number): void {
    this.advance(t);
    this.request(name, t);
  }

  react(name: Reaction, t: number): void {
    this.advance(t);
    this.reactAt(name, t);
  }

  // The pointer in frame units of eye travel; the host maps screen space to this.
  pointerAt(x: number, y: number, t: number): void {
    this.advance(t);
    if (this.reduced || this.current !== "your-turn") return;
    const jump = Math.hypot(x - this.ch.gx.to, y - this.ch.gy.to);
    const deg = (Math.asin(clamp(jump / R, -1, 1)) * 180) / Math.PI;
    this.look(x, y, t, deg > 8 ? "saccade" : "pursuit");
  }

  setControl(on: boolean, t: number): void {
    this.advance(t);
    this.control = on;
    this.ch.rim.set(on ? 1 : 0, t, this.sp(SPRINGS.body));
  }

  setLod(lod: Lod, t: number): void {
    this.advance(t);
    if (lod === this.lod) return;
    this.lod = lod;
    this.enter(this.current, t, null);
  }

  setReducedMotion(on: boolean, t: number): void {
    this.advance(t);
    if (on === this.reduced) return;
    this.reduced = on;
    this.enter(this.current, t, null);
  }

  // Jumps to t without simulating the gap, for a view that sat off screen or in a hidden tab.
  skipTo(t: number): void {
    const next = this.deferred ?? this.current;
    this.queue = [];
    this.deferred = null;
    this.blinks = [];
    this.deltas = [];
    for (const k of ["gx", "gy", "mx", "my", "squash", "lift", "shake"] as const) {
      this.ch[k].jump(0, t);
    }
    this.ch.eyeSY.jump(1, t);
    this.ch.rim.jump(this.control ? 1 : 0, t);
    this.enter(next, t, null, true);
  }

  pose(t: number): DotPose {
    this.advance(t);
    const v = (k: keyof Pose | Motion) => this.ch[k].value(t);
    const rich = this.rich && !this.reduced;
    const b = rich ? v("breath") * this.breathValue(t) : 0;
    const talk = this.current === "speaking" ? this.talk(t) * (this.reduced ? 0.5 : 1) : 0;
    const cap = SQUASH_CAP[this.lod];
    const squash = rich ? clamp(v("squash"), -cap, cap) : 0;
    const size = v("size");
    const sy = (1 + squash) * (1 + 0.015 * b) * (1 + 0.025 * talk) * size;
    const sx = (1 / (1 + squash)) * (1 - 0.007 * b) * size;
    const bodyX = v("bodyX") + (rich ? v("shake") : 0);
    const bodyY = v("bodyY") + (rich ? v("lift") : 0) - 0.4 * b;
    const blink = this.blinkAmount(t);
    const gx = v("gx") + (rich ? v("mx") : 0);
    const gy = v("gy") + (rich ? v("my") : 0);
    const roll = v("roll");
    const eye = (i: 0 | 1): EyePose => {
      const up = v(i === 0 ? "upL" : "upR");
      const lo = v("lo");
      const open = Math.max(0, 1 - up - lo);
      return {
        frame: eyeFrame(EYE_ANCHORS[i], gx, gy, roll),
        up: up + open * blink * 0.86,
        lo: lo + open * blink * 0.14,
        loArch: v("loArch"),
        tilt: v(i === 0 ? "tiltL" : "tiltR") * (i === 0 ? 1 : -1),
        scale: v("eyeScale"),
        sy: v("eyeSY") * (1 - 0.08 * talk),
        happy: clamp(v("happy"), 0, 1),
        closed: clamp(v("closed"), 0, 1),
        opacity: v("eyeOpacity"),
      };
    };
    return {
      t,
      state: this.current,
      body: { x: bodyX, y: bodyY, sx, sy },
      shadow: {
        s: clamp(1 + 0.035 * Math.min(0, bodyY) + 0.02 * Math.max(0, bodyY), 0.8, 1.1),
        o: clamp(1 + 0.08 * Math.min(0, bodyY), 0.5, 1),
      },
      plate: { dim: clamp(v("dim"), 0, 1), rim: clamp(v("rim"), 0, 1) },
      eyes: [eye(0), eye(1)],
      blink,
      talk,
      gaze: { x: gx, y: gy },
    };
  }

  // An upper bound on how fast anything visible is moving, in frame units per second; a renderer
  // slows down while it is calm.
  activity(t: number): number {
    this.advance(t);
    const rich = this.rich && !this.reduced;
    let m = 0;
    for (const k of SPEED_KEYS) {
      if (rich || !RICH_ONLY.has(k)) m = Math.max(m, this.ch[k].speed(t) * SPEED_UNITS[k]);
    }
    return m + this.blinkAmount(t) * 50 + this.talk(t) * 50;
  }

  private get rich(): boolean {
    return RICH_LODS.has(this.lod);
  }

  private sp(p: SpringParams): SpringParams {
    return this.reduced ? SPRINGS.reduced : p;
  }

  private rand(a: number, b: number): number {
    return a + (b - a) * this.rng();
  }

  private at(t: number, run: (t: number) => void, keep = false): void {
    let i = this.queue.length;
    while (i > 0 && (this.queue[i - 1] as Scheduled).t > t) i--;
    this.queue.splice(i, 0, { t, gen: keep ? -1 : this.gen, run });
  }

  private advance(t: number): void {
    for (let ev = this.queue[0]; ev && ev.t <= t; ev = this.queue[0]) {
      this.queue.shift();
      if (ev.gen === -1 || ev.gen === this.gen) ev.run(ev.t);
    }
  }

  // Repeats fn after each gap while the current state lasts.
  private loop(t: number, gap: () => number, fn: (t: number) => void): void {
    const tick = (tt: number) => {
      fn(tt);
      this.at(tt + gap(), tick);
    };
    this.at(t + gap(), tick);
  }

  private request(name: DotState, t: number): void {
    if (this.deferred !== null) {
      // The latest request wins; superseded ones never show.
      this.deferred = name;
      return;
    }
    if (name === this.current) return;
    const ready = this.since + STATE_HOLD_MS;
    if (t >= ready) {
      this.enter(name, t, this.current);
      return;
    }
    this.deferred = name;
    this.at(
      ready,
      (tt) => {
        const next = this.deferred ?? this.current;
        this.deferred = null;
        if (next !== this.current) this.enter(next, tt, this.current);
      },
      true,
    );
  }

  private enter(name: DotState, t: number, prev: DotState | null, initial = false): void {
    this.gen++;
    this.current = name;
    this.since = t;
    const def = STATES[name];
    const pose: Pose = { ...BASE_POSE, ...def.pose };
    for (const k of POSE_KEYS) {
      if (initial) this.ch[k].jump(pose[k], t);
      else this.ch[k].set(pose[k], t, this.sp(SPRINGS.pose));
    }
    this.breath = { phase: this.breathPhase(t), t0: t, period: def.period };
    this.ch.mx.set(0, t);
    this.ch.my.set(0, t);
    this.blinkBlockUntil = Number.NEGATIVE_INFINITY;
    if (prev && prev !== "offline" && ASLEEP.has(prev) && !ASLEEP.has(name)) {
      this.reactAt("live", t);
    }
    this.scheduleBlink(t);
    this.onEnter(name, t);
    if (this.rich && !this.reduced) this.scheduleMicro(t);
  }

  private onEnter(name: DotState, t: number): void {
    switch (name) {
      case "offline":
        this.look(0, 0, t, "drift");
        return;
      case "sleeping":
        this.look(0, 1, t, "drift");
        return;
      case "waking":
        this.look(BIAS.x * 0.5, BIAS.y * 0.5, t, "drift");
        if (this.reduced) return;
        this.loop(
          t,
          () => this.rand(1600, 2800),
          (tt) => this.look(this.rand(-3, 3), this.rand(-1.5, 1.5), tt, "drift"),
        );
        return;
      case "reconnecting": {
        let side = 1;
        this.look(4, 0, t, "drift");
        if (this.reduced) return;
        this.loop(
          t,
          () => 1400,
          (tt) => {
            side = -side;
            this.look(4 * side, this.rand(-0.6, 0.6), tt, "drift");
          },
        );
        return;
      }
      case "idle":
        this.enterIdle(t);
        return;
      case "listening":
        this.look(COMPOSER.x, COMPOSER.y, t);
        if (this.reduced) return;
        this.loop(
          t,
          () => this.rand(900, 1800),
          (tt) =>
            this.look(
              COMPOSER.x + this.rand(-1.2, 1.2),
              COMPOSER.y + this.rand(-0.5, 0.5),
              tt,
              "drift",
            ),
        );
        return;
      case "thinking":
        this.enterThinking(t);
        return;
      case "acting":
        this.enterActing(t);
        return;
      case "observing":
        this.enterObserving(t);
        return;
      case "speaking":
        this.enterSpeaking(t);
        return;
      case "waiting":
        this.enterWaiting(t);
        return;
      case "your-turn":
        this.look(0, 0, t);
        return;
      case "resting":
        this.look(0, 0.5, t, "drift");
        return;
      case "error":
        this.reactAt("error", t);
        return;
      case "annoyed":
        this.look(0, 0, t);
        return;
    }
  }

  private enterIdle(t: number): void {
    this.look(BIAS.x, BIAS.y, t + 60);
    if (this.reduced) return;
    // Mostly small fixations around the resting point, now and then a look at the user.
    let nextUser = t + this.rand(6000, 14000);
    const fix = (tt: number) => {
      let hold: number;
      if (tt >= nextUser) {
        this.look(0, 0, tt);
        hold = this.rand(1000, 2000);
        nextUser = tt + this.rand(6000, 14000);
      } else {
        this.look(BIAS.x + this.rand(-4, 4), BIAS.y + this.rand(-2.5, 2.5), tt);
        hold = this.rand(800, 3000);
      }
      this.at(tt + hold, fix);
    };
    this.at(t + this.rand(800, 2200), fix);
  }

  private enterThinking(t: number): void {
    const points: Point[] = [];
    const n = this.rng() < 0.5 ? 2 : 3;
    for (let i = 0; i < n; i++) points.push({ x: this.rand(-6, -2), y: this.rand(-4.8, -3) });
    const first = points[0] as Point;
    this.look(first.x, first.y, t);
    this.at(t + 5000, (tt) => {
      // "Hmm": one skeptical lid after five seconds of thinking.
      this.ch.tiltR.set(12, tt, this.sp(SPRINGS.pose));
      this.ch.upR.set(0.3, tt, this.sp(SPRINGS.pose));
      this.ch.roll.set(-5, tt, this.sp(SPRINGS.body));
    });
    if (this.reduced) return;
    let i = 0;
    this.loop(
      t,
      () => this.rand(800, 1600),
      (tt) => {
        i = (i + 1) % points.length;
        const p = points[i] as Point;
        this.look(p.x + this.rand(-0.4, 0.4), p.y, tt, "drift");
      },
    );
  }

  private enterActing(t: number): void {
    const act = (tt: number) => {
      const target = { x: this.rand(1.5, 7), y: this.rand(-3, 4) };
      this.blinkBlockUntil = tt + 900;
      this.look(target.x, target.y, tt, "saccade");
      const dispatch = tt + this.rand(320, 520);
      this.at(dispatch, (td) => {
        this.reactAt("dispatch", td);
        if (this.rng() < 0.5) this.at(td + this.rand(150, 400), (tb) => this.blink(tb));
      });
      this.at(dispatch + this.rand(900, 1700), act);
    };
    this.at(t + 120, act);
  }

  private enterObserving(t: number): void {
    const scan = (tt: number) => {
      const n = 2 + Math.floor(this.rng() * 3);
      let at = tt;
      this.blinkBlockUntil = tt + 1400;
      for (let i = 0; i < n; i++) {
        const p = { x: this.rand(1, 6.5), y: this.rand(-3.5, 3.5) };
        this.at(at, (ts) => this.look(p.x, p.y, ts, "saccade"));
        at += this.rand(150, 300);
      }
      this.at(at + 120, (tb) => {
        if (this.rng() < 0.8) this.blink(tb);
      });
      this.at(at + this.rand(900, 1600), scan);
    };
    this.at(t + 60, scan);
  }

  private enterSpeaking(t: number): void {
    this.look(0, 0.4, t);
    const phrase = (tt: number) => {
      const len = this.rand(1200, 2800);
      let at = tt;
      while (at < tt + len) {
        const a = this.rand(0.35, 1);
        this.at(at, (td) => this.textDelta(td, a));
        at += this.rand(40, 110);
      }
      const pause = this.rand(300, 700);
      this.at(at + 30, (tp) => {
        if (this.rng() < 0.65) this.blink(tp);
        if (!this.reduced) this.look(this.rand(-1.2, 1.2), this.rand(0, 1), tp, "drift");
      });
      this.at(at + pause, phrase);
    };
    this.at(t + 120, phrase);
  }

  private enterWaiting(t: number): void {
    let atUser = true;
    this.look(0, 0, t);
    this.hop(t);
    this.loop(
      t,
      () => this.rand(3000, 5000),
      (tt) => {
        atUser = !atUser;
        const p = atUser ? { x: 0, y: 0 } : CARD;
        this.look(p.x, p.y, tt);
      },
    );
    // Hops every 8 s, then every 20 s after a minute; never a pulse.
    const hop = (tt: number) => {
      this.hop(tt);
      this.at(tt + (tt - this.since > 60_000 ? 20_000 : 8000), hop);
    };
    this.at(t + 8000, hop);
  }

  private scheduleMicro(t: number): void {
    this.at(t + this.rand(600, 2000), (tt) => {
      if (!STILL_EYES.has(this.current)) {
        this.ch.mx.set(this.rand(-0.25, 0.25), tt, SPRINGS.snap);
        this.ch.my.set(this.rand(-0.25, 0.25), tt, SPRINGS.snap);
      }
      this.scheduleMicro(tt);
    });
  }

  private look(x: number, y: number, t: number, kind: LookKind = "saccade"): void {
    const gx = clamp(x, -GAZE_MAX.x, GAZE_MAX.x);
    const gy = clamp(y, -GAZE_MAX.y, GAZE_MAX.y);
    if (this.reduced) {
      this.ch.gx.jump(gx, t);
      this.ch.gy.jump(gy, t);
      return;
    }
    const p = SPRINGS[kind];
    const dist = Math.hypot(gx - this.ch.gx.value(t), gy - this.ch.gy.value(t));
    if (kind === "saccade" && dist > 0.6 * GAZE_MAX.x && this.blinkAllowed(t) && this.rng() < 0.7) {
      // A big saccade usually rides on a blink.
      this.blink(t);
      this.at(t + this.rand(0, 40), (tt) => {
        this.ch.gx.set(gx, tt, p);
        this.ch.gy.set(gy, tt, p);
      });
      return;
    }
    this.ch.gx.set(gx, t, p);
    this.ch.gy.set(gy, t, p);
  }

  private hop(t: number): void {
    if (this.reduced || !this.rich) return;
    this.ch.squash.set(-0.04, t, SPRINGS.snap);
    this.at(
      t + 80,
      (tt) => {
        this.ch.squash.set(0.035, tt, SPRINGS.snap);
        this.ch.lift.set(-1.5, tt, SPRINGS.hop);
        this.at(
          tt + 160,
          (tl) => {
            this.ch.lift.set(0, tl, SPRINGS.hop);
            this.ch.squash.set(0, tl, SPRINGS.hop);
          },
          true,
        );
      },
      true,
    );
  }

  private blinkAllowed(t: number): boolean {
    return t >= this.blinkBlockUntil && STATES[this.current].blink > 0;
  }

  private blink(t: number, timing?: BlinkTiming): void {
    const k = STATES[this.current].blinkDur ?? 1;
    const d = timing ?? ([BLINK[0] * k, BLINK[1] * k, BLINK[2] * k] as const);
    const last = this.blinks.at(-1);
    if (last && t - last.t < 120) return;
    this.blinks.push({ t, d });
    if (this.blinks.length > 8) this.blinks.shift();
  }

  // How far the lids are closed by blinks: an easeInQuad close, a hold, then an exponential open.
  private blinkAmount(t: number): number {
    let a = 0;
    for (const { t: start, d } of this.blinks) {
      const [c, h, o] = d;
      const dt = t - start;
      if (dt < 0 || dt > c + h + o) continue;
      let v: number;
      if (dt < c) {
        const u = dt / c;
        v = u * u;
      } else if (dt < c + h) {
        v = 1;
      } else {
        const tau = o * (40 / 140);
        v = (Math.exp(-(dt - c - h) / tau) - Math.exp(-o / tau)) / (1 - Math.exp(-o / tau));
      }
      a = Math.max(a, BLINK_PEAK * v);
    }
    return a;
  }

  private scheduleBlink(t: number): void {
    const rate = STATES[this.current].blink;
    if (!rate) return;
    const gap = clamp(lognormal(this.rng, 3400, 0.45), 1800, 7000) / rate;
    this.at(t + gap, (tt) => {
      if (this.blinkAllowed(tt)) {
        this.blink(tt);
        if (this.rng() < 0.12) this.blink(tt + 140);
      }
      this.scheduleBlink(tt);
    });
  }

  private breathPhase(t: number): number {
    const b = this.breath;
    const dt = t - b.t0;
    return b.phase + dt / b.period + 0.035 * Math.sin((2 * Math.PI * dt) / (3.3 * b.period));
  }

  // Asymmetric breath: 40% in, 60% out, with a per-cycle amplitude from the seed.
  private breathValue(t: number): number {
    const ph = this.breathPhase(t);
    const k = Math.floor(ph);
    const p = ph - k;
    const amp = 1 + 0.16 * (hash01(this.seed, k) - 0.5);
    const w =
      p < 0.4
        ? 0.5 - 0.5 * Math.cos((Math.PI * p) / 0.4)
        : 0.5 + 0.5 * Math.cos((Math.PI * (p - 0.4)) / 0.6);
    return w * amp;
  }

  // Talk-bob envelope from text-delta arrivals: 25 ms attack, 140 ms release.
  private talk(t: number): number {
    let e = 0;
    for (const d of this.deltas) {
      const dt = t - d.t;
      if (dt < 0 || dt > 900) continue;
      e += d.a * (1 - Math.exp(-dt / 25)) * Math.exp(-dt / 140);
    }
    return clamp(e, 0, 1);
  }

  private textDelta(t: number, a: number): void {
    this.deltas.push({ t, a });
    while (this.deltas.length && t - (this.deltas[0] as { t: number }).t > 1000)
      this.deltas.shift();
  }

  private reactAt(name: Reaction, t: number): void {
    switch (name) {
      case "dispatch":
        // The action nod.
        if (this.reduced) return;
        this.ch.lift.set(-0.35, t, SPRINGS.snap);
        this.at(
          t + 50,
          (tt) => {
            this.ch.lift.set(1, tt, spring(1, 0.11));
            this.at(tt + 80, (tb) => this.ch.lift.set(0, tb, spring(1, 0.2)), true);
          },
          true,
        );
        return;
      case "live":
        // Back from sleep: two quick blinks, a stretch, then a look at the user.
        this.blink(t + 40, [60, 20, 110]);
        this.blink(t + 190, [60, 20, 110]);
        if (!this.reduced && this.rich) {
          this.ch.squash.set(0.04, t + 40, spring(0.75, 0.18));
          this.at(t + 200, (tt) => this.ch.squash.set(0, tt, spring(0.7, 0.35)), true);
        }
        this.at(t + 330, (tt) => this.look(0, 0, tt), true);
        return;
      case "acknowledged":
        // One slow blink.
        this.blink(t, [150, 120, 300]);
        return;
      case "error":
        this.reactError(t);
        return;
      case "success":
        this.reactSuccess(t);
        return;
    }
  }

  private reactError(t: number): void {
    this.errors = this.errors.filter((e) => t - e < ANNOYED_WINDOW_MS);
    this.errors.push(t);
    if (this.errors.length >= 2) this.at(t + 900, (tt) => this.request("annoyed", tt));
    this.at(t + 240, (tt) => this.look(0, 0.5, tt), true);
    if (this.reduced) return;
    // A squeeze of the eyes, and a shake where the body moves.
    this.ch.eyeSY.set(0.2, t, spring(1, 0.1));
    this.at(t + 70, (tt) => this.ch.eyeSY.set(1, tt, spring(1, 0.25)), true);
    if (this.rich) this.ch.shake.kick(2, t + 20, SPRINGS.shake);
  }

  private reactSuccess(t: number): void {
    if (t - this.lastSuccess < SUCCESS_GAP_MS) return;
    this.lastSuccess = t;
    const hold = this.reduced ? 600 : 700;
    this.ch.happy.set(1, t, this.sp(spring(1, 0.16)));
    this.at(t + hold + 80, (tt) => this.ch.happy.set(0, tt, this.sp(spring(1, 0.24))), true);
    this.look(0, 0, t);
    this.at(t + 820, (tt) => this.look(CARD.x, CARD.y, tt), true);
    this.at(t + 1120, (tt) => this.look(0, 0.3, tt), true);
    if (this.reduced || !this.rich) return;
    this.ch.squash.set(-0.04, t, spring(1, 0.1));
    this.at(
      t + 80,
      (tt) => {
        this.ch.squash.set(0.04, tt, spring(0.7, 0.3));
        this.ch.lift.set(-3, tt, spring(0.6, 0.35));
        this.at(
          tt + 200,
          (tl) => {
            this.ch.lift.set(0, tl, spring(0.75, 0.32));
            this.ch.squash.set(-0.035, tl, spring(0.7, 0.22));
            this.at(tl + 170, (ts) => this.ch.squash.set(0, ts, spring(0.7, 0.35)), true);
          },
          true,
        );
      },
      true,
    );
  }
}
