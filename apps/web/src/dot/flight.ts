import type { SpringParams } from "@localdot/stage";
import { Channel } from "./engine/channel.ts";
import { spring } from "./engine/states.ts";

// A dot's frame on the page: its top-left corner and its size, in CSS px.
export interface Box {
  x: number;
  y: number;
  size: number;
}

// Going down, dot drops first and then slides into its seat; going up retraces the same L-curve.
const DOWN = { x: spring(1, 0.52), y: spring(1, 0.38) };
const UP = { x: spring(1, 0.38), y: spring(1, 0.52) };
// Size leads on the way out and trails on the way in.
const GROW = spring(1, 0.26);
const SHRINK = spring(1, 0.5);
// A place that moves under dot, such as a reflow, is followed rather than flown to.
const FOLLOW = spring(1, 0.3);
// Out of the island's badge slot dot grows first, then travels.
const BADGE_LEAD_MS = 120;
const SETTLE_PX = 0.4;
const SETTLE_SPEED = 8;

// dot's flight between its places as one element, on critically damped X, Y and size springs that
// start from where it is drawn and keep its velocity, so a new place mid-flight bends the path.
export class Flight {
  target: Box;
  private readonly x: Channel;
  private readonly y: Channel;
  private readonly size: Channel;
  private pending: { to: Box; t: number; p: { x: SpringParams; y: SpringParams } } | null = null;

  constructor(at: Box) {
    this.target = at;
    this.x = new Channel(at.x, FOLLOW);
    this.y = new Channel(at.y, FOLLOW);
    this.size = new Channel(at.size, GROW);
  }

  fly(to: Box, t: number, fromBadge = false): void {
    const now = this.at(t);
    const p = to.y >= now.y ? DOWN : UP;
    this.target = to;
    this.size.set(to.size, t, to.size >= now.size ? GROW : SHRINK);
    if (fromBadge) {
      this.pending = { to, t: t + BADGE_LEAD_MS, p };
      return;
    }
    this.pending = null;
    this.x.set(to.x, t, p.x);
    this.y.set(to.y, t, p.y);
  }

  follow(to: Box, t: number): void {
    this.target = to;
    if (this.pending) {
      this.pending.to = to;
      return;
    }
    this.x.set(to.x, t, FOLLOW);
    this.y.set(to.y, t, FOLLOW);
    this.size.set(to.size, t, FOLLOW);
  }

  jump(to: Box, t: number): void {
    this.target = to;
    this.pending = null;
    this.x.jump(to.x, t);
    this.y.jump(to.y, t);
    this.size.jump(to.size, t);
  }

  at(t: number): Box & { settled: boolean } {
    const pending = this.pending;
    if (pending && t >= pending.t) {
      this.pending = null;
      this.x.set(pending.to.x, pending.t, pending.p.x);
      this.y.set(pending.to.y, pending.t, pending.p.y);
    }
    const x = this.x.value(t);
    const y = this.y.value(t);
    const size = this.size.value(t);
    const settled =
      !this.pending &&
      Math.abs(x - this.target.x) < SETTLE_PX &&
      Math.abs(y - this.target.y) < SETTLE_PX &&
      Math.abs(size - this.target.size) < SETTLE_PX &&
      Math.hypot(this.x.speed(t), this.y.speed(t)) < SETTLE_SPEED &&
      this.size.speed(t) < SETTLE_SPEED;
    return settled ? { ...this.target, settled } : { x, y, size, settled };
  }
}
