import type { Point } from "@localdot/protocol";
import { mulberry32 } from "./random.ts";

export interface PointerPlan {
  from: Point;
  to: Point;
  startsAt: number;
  durationMs: number;
  seed: number;
}

// The primary sub-movement overshoots slightly and a corrective one settles on the target, as a
// human hand does; both are minimum-jerk so the path has no velocity jumps.
const PRIMARY_SHARE = 0.85;

const minJerk = (u: number) => u * u * u * (10 - 15 * u + 6 * u * u);

const progress = (tau: number, overshoot: number) =>
  tau < PRIMARY_SHARE
    ? (1 + overshoot) * minJerk(tau / PRIMARY_SHARE)
    : 1 + overshoot - overshoot * minJerk((tau - PRIMARY_SHARE) / (1 - PRIMARY_SHARE));

export function pointerAt(plan: PointerPlan, tMs: number): Point {
  const { from, to, startsAt, durationMs, seed } = plan;
  if (durationMs <= 0 || tMs >= startsAt + durationMs) return { x: to.x, y: to.y };
  if (tMs <= startsAt) return { x: from.x, y: from.y };

  const random = mulberry32(seed);
  const overshoot = 0.02 + random() * 0.01;
  const side = random() < 0.5 ? -1 : 1;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: from.x, y: from.y };

  const tau = (tMs - startsAt) / durationMs;
  const along = progress(tau, overshoot);
  const bow =
    side * Math.min(0.05 * distance, 36) * Math.sin(Math.PI * Math.min(1, tau / PRIMARY_SHARE));
  const nx = -dy / distance;
  const ny = dx / distance;
  return { x: from.x + dx * along + nx * bow, y: from.y + dy * along + ny * bow };
}
