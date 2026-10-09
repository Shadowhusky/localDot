import type { Point, PointerPlan } from "@localdot/protocol";
import { mulberry32 } from "./random.ts";

// The primary sub-movement overshoots slightly and a corrective one settles on the target, as a
// human hand does. Both, and the sideways bow over the primary, are minimum-jerk eased so the path
// has no velocity jumps. The overshoot is 2–3 % of the distance, capped so a long move does not
// sail 60 px past its target.
const PRIMARY_SHARE = 0.85;
export const OVERSHOOT_CAP_PX = 12;

const minJerk = (u: number) => u * u * u * (10 - 15 * u + 6 * u * u);

const progress = (tau: number, overshoot: number) =>
  tau < PRIMARY_SHARE
    ? (1 + overshoot) * minJerk(tau / PRIMARY_SHARE)
    : 1 + overshoot - overshoot * minJerk((tau - PRIMARY_SHARE) / (1 - PRIMARY_SHARE));

function assertFinitePlan(plan: PointerPlan, tMs: number): void {
  const values = [
    plan.from.x,
    plan.from.y,
    plan.to.x,
    plan.to.y,
    plan.startsAt,
    plan.durationMs,
    plan.seed,
    tMs,
  ];
  if (!values.every(Number.isFinite)) throw new RangeError("pointer plan and time must be finite");
}

// `line`: the straight way a held button glides, which desktopd follows, rather than the plan's
// curve.
export function pointerAt(plan: PointerPlan, tMs: number, line = false): Point {
  assertFinitePlan(plan, tMs);
  const { from, to, startsAt, durationMs } = plan;
  if (tMs < startsAt) return { x: from.x, y: from.y };
  if (durationMs <= 0 || tMs >= startsAt + durationMs) return { x: to.x, y: to.y };
  const tau = (tMs - startsAt) / durationMs;
  // A log written by a newer renderer may name a curve this one does not know: draw a straight,
  // minimum-jerk line rather than nothing (the schema's version tag versions the renderer).
  const curve: string = plan.curve;
  return curve === "minjerk-bow-v1" && !line ? minJerkBow(plan, tau) : straight(plan, tau);
}

function straight(plan: PointerPlan, tau: number): Point {
  const s = minJerk(tau);
  return {
    x: plan.from.x + (plan.to.x - plan.from.x) * s,
    y: plan.from.y + (plan.to.y - plan.from.y) * s,
  };
}

function minJerkBow(plan: PointerPlan, tau: number): Point {
  const { from, to, seed } = plan;
  const random = mulberry32(seed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: from.x, y: from.y };
  const overshoot = Math.min(0.02 + random() * 0.01, OVERSHOOT_CAP_PX / distance);
  const side = random() < 0.5 ? -1 : 1;
  const along = progress(tau, overshoot);
  const bow =
    side *
    Math.min(0.05 * distance, 36) *
    Math.sin(Math.PI * minJerk(Math.min(1, tau / PRIMARY_SHARE)));
  const nx = -dy / distance;
  const ny = dx / distance;
  return { x: from.x + dx * along + nx * bow, y: from.y + dy * along + ny * bow };
}
