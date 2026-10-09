import type { SpringParams } from "@localdot/stage";
import { Channel } from "./engine/channel.ts";
import { spring } from "./engine/states.ts";

// A dot's frame on the page: its top-left corner and its size, in CSS px.
export interface Box {
  x: number;
  y: number;
  size: number;
}

interface Path {
  x: SpringParams;
  y: SpringParams;
}

// Going down, dot drops first and then slides into its seat; going up retraces the same L-curve.
const DOWN: Path = { x: spring(1, 0.52), y: spring(1, 0.38) };
const UP: Path = { x: spring(1, 0.38), y: spring(1, 0.52) };
// Size leads on the way out and trails on the way in.
const GROW = spring(1, 0.26);
const SHRINK = spring(1, 0.5);
// A new box for the place dot is at, or a place that moves under it mid-flight, is followed rather
// than flown to.
const FOLLOW = spring(1, 0.3);
const STILL: Path = { x: FOLLOW, y: FOLLOW };
// Out of the island's badge slot dot grows first, then travels.
const BADGE_LEAD_MS = 120;
const SETTLE_PX = 0.4;
const SETTLE_SPEED = 8;

// dot's flight between its places as one element, on critically damped X, Y and size springs. Every
// change of place starts from where dot is at that moment and keeps its velocity, so a new place
// mid-flight bends the path instead of restarting it. at() only reads, so a path can be sampled ahead.
export class Flight {
  target: Box;
  private readonly x: Channel;
  private readonly y: Channel;
  private readonly size: Channel;
  private path: Path = STILL;
  private sizing = FOLLOW;

  constructor(at: Box) {
    this.target = at;
    this.x = new Channel(at.x, FOLLOW);
    this.y = new Channel(at.y, FOLLOW);
    this.size = new Channel(at.size, GROW);
  }

  fly(to: Box, t: number, fromBadge = false): void {
    const now = this.at(t);
    this.path = to.y >= now.y ? DOWN : UP;
    this.sizing = to.size >= now.size ? GROW : SHRINK;
    // Only a dot at rest in the badge grows before it leaves; one already moving just turns.
    const start = fromBadge && now.settled ? t + BADGE_LEAD_MS : t;
    this.target = to;
    this.size.set(to.size, t, this.sizing);
    this.x.set(to.x, start, this.path.x);
    this.y.set(to.y, start, this.path.y);
  }

  // The place moved under dot: a flight keeps its own curve to the new spot.
  follow(to: Box, t: number): void {
    if (this.at(t).settled) {
      this.path = STILL;
      this.sizing = FOLLOW;
    }
    this.target = to;
    this.x.set(to.x, t, this.path.x);
    this.y.set(to.y, t, this.path.y);
    this.size.set(to.size, t, this.sizing);
  }

  jump(to: Box, t: number): void {
    this.target = to;
    this.path = STILL;
    this.sizing = FOLLOW;
    this.x.jump(to.x, t);
    this.y.jump(to.y, t);
    this.size.jump(to.size, t);
  }

  at(t: number): Box & { settled: boolean } {
    const x = this.x.value(t);
    const y = this.y.value(t);
    const size = this.size.value(t);
    const settled =
      Math.abs(x - this.target.x) < SETTLE_PX &&
      Math.abs(y - this.target.y) < SETTLE_PX &&
      Math.abs(size - this.target.size) < SETTLE_PX &&
      Math.hypot(this.x.speed(t), this.y.speed(t)) < SETTLE_SPEED &&
      this.size.speed(t) < SETTLE_SPEED;
    return settled ? { ...this.target, settled } : { x, y, size, settled };
  }
}
