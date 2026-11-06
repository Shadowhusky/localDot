import { matches, REDUCED_MOTION } from "../ui/media.ts";

export interface SpringMove {
  // Seconds per cycle, as Apple's springs have it.
  response?: number;
  // 1 is critically damped.
  damping?: number;
  velocity?: number;
  done?(): void;
}

const active = new Set<Spring>();
const redraws = new Set<() => void>();
let raf = 0;
let last = 0;

const STEP_S = 1 / 240;
const LONGEST_FRAME_S = 1 / 30;
const SETTLE_SPEED = 0.01;
const SETTLE_PX = 0.0006;

function frame(t: number) {
  raf = 0;
  const dt = Math.min(LONGEST_FRAME_S, (t - last) / 1000 || 1 / 60);
  last = t;
  for (const spring of [...active]) spring.step(dt);
  for (const redraw of redraws) redraw();
  if (active.size) kick();
}

function kick() {
  if (raf || typeof requestAnimationFrame !== "function") return;
  if (performance.now() - last > 100) last = performance.now();
  raf = requestAnimationFrame(frame);
}

// A function that draws a frame while any spring runs, and once more when each one settles.
export function onSpringFrame(draw: () => void): () => void {
  redraws.add(draw);
  return () => redraws.delete(draw);
}

// A value that moves by its response and damping ratio, always from where it is now, so a finger or
// a new target takes over mid-flight. Under reduced motion it goes straight there.
export class Spring {
  x: number;
  v = 0;
  target: number;
  private k = 170;
  private c = 26;
  private done: (() => void) | null = null;

  constructor(x = 0) {
    this.x = x;
    this.target = x;
  }

  get moving(): boolean {
    return active.has(this);
  }

  to(target: number, { response = 0.38, damping = 1, velocity, done }: SpringMove = {}): void {
    this.target = target;
    const w = (2 * Math.PI) / response;
    this.k = w * w;
    this.c = 2 * damping * w;
    if (velocity !== undefined) this.v = velocity;
    this.done = done ?? null;
    if (matches(REDUCED_MOTION)) {
      this.set(target, true);
      return;
    }
    active.add(this);
    kick();
  }

  // Straight to a value, as a finger moves it; `fire` says the move in hand has finished.
  set(x: number, fire = false): void {
    this.x = x;
    this.v = 0;
    this.target = x;
    active.delete(this);
    const done = this.done;
    this.done = null;
    if (fire) done?.();
    kick();
  }

  step(dt: number): void {
    for (let t = 0; t < dt; t += STEP_S) {
      const a = -this.k * (this.x - this.target) - this.c * this.v;
      this.v += a * STEP_S;
      this.x += this.v * STEP_S;
    }
    const near = SETTLE_PX * (Math.abs(this.target) > 2 ? 100 : 1);
    if (Math.abs(this.x - this.target) < near && Math.abs(this.v) < SETTLE_SPEED)
      this.set(this.target, true);
  }
}

const HISTORY_MS = 90;
const STALE_MS = 60;

// How fast a finger is moving as it lets go, from the last moment of its travel; one that stopped
// before lifting carries no speed.
export class Velocity {
  private readonly history: [number, number][] = [];

  add(value: number): void {
    const t = performance.now();
    this.history.push([t, value]);
    while (this.history.length > 2 && t - (this.history[0]?.[0] ?? t) > HISTORY_MS)
      this.history.shift();
  }

  get(): number {
    const first = this.history[0];
    const latest = this.history.at(-1);
    if (!first || !latest || first === latest) return 0;
    const [t0, v0] = first;
    const [t1, v1] = latest;
    if (performance.now() - t1 > STALE_MS || t1 === t0) return 0;
    return ((v1 - v0) / (t1 - t0)) * 1000;
  }
}

export const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
