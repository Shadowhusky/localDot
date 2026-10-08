import { type SpringParams, springValue } from "@localdot/stage";
import { settleMs, springVelocity } from "./spring.ts";

// One animated value: a spring toward `to` that keeps its current value and velocity when it is
// retargeted. Times are in milliseconds.
export class Channel {
  to: number;
  private from: number;
  private v0 = 0;
  private t0 = 0;
  private p: SpringParams;
  private settled = Number.NEGATIVE_INFINITY;

  constructor(value: number, p: SpringParams) {
    this.to = value;
    this.from = value;
    this.p = p;
  }

  value(t: number): number {
    return springValue(this.from, this.to, this.v0, this.elapsed(t), this.p);
  }

  speed(t: number): number {
    if (t >= this.settled) return 0;
    return Math.abs(springVelocity(this.from, this.to, this.v0, this.elapsed(t), this.p));
  }

  set(to: number, t: number, p?: SpringParams): void {
    this.restart(this.value(t), this.velocity(t), t, p);
    this.to = to;
  }

  jump(value: number, t: number): void {
    this.to = value;
    this.restart(value, 0, t);
  }

  // Displaces the value without moving the target, so the spring rings back to it.
  kick(dx: number, t: number, p?: SpringParams): void {
    this.restart(this.value(t) + dx, this.velocity(t), t, p);
  }

  private elapsed(t: number): number {
    return Math.max(0, t - this.t0) / 1000;
  }

  private velocity(t: number): number {
    return springVelocity(this.from, this.to, this.v0, this.elapsed(t), this.p);
  }

  private restart(from: number, v0: number, t: number, p?: SpringParams): void {
    this.from = from;
    this.v0 = v0;
    this.t0 = t;
    if (p) this.p = p;
    this.settled = t + settleMs(this.p);
  }
}
