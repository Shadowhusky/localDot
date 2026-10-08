import type { Point } from "./geometry.ts";

export const MOTION_HZ = 90;
const MAX_HZ = 120;

export interface MotionSample {
  at: Point;
  // Milliseconds after the motion starts.
  t: number;
}

// Minimum jerk: the eased share of a segment covered at time share s.
const minJerk = (s: number) => s * s * s * (10 + s * (6 * s - 15));

// Where a cursor is along waypoints, and when: each segment eases in and out over its share of the
// time, in proportion to its length, sampled at about MOTION_HZ. No two samples are closer than
// 1/MAX_HZ s, so short segments after a long one, or a dense path, take longer than asked rather
// than sending motion faster. Every waypoint is visited, in whole pixels, and a sample that would
// not move the cursor is left out.
export function motionSamples(
  points: readonly Point[],
  durationMs: number,
  hz = MOTION_HZ,
): MotionSample[] {
  const segments = points.slice(1).map((to, i) => {
    const from = points[i] as Point;
    return { from, to, length: Math.hypot(to.x - from.x, to.y - from.y) };
  });
  const moving = segments.filter((s) => s.length > 0);
  const total = moving.reduce((sum, s) => sum + s.length, 0);
  const duration = Math.max(durationMs, (moving.length * 1000) / MAX_HZ);
  const samples: MotionSample[] = [];
  let last = points[0] ? round(points[0]) : undefined;
  let start = 0;
  let previous = 0;
  for (const { from, to, length } of moving) {
    const ms = (duration * length) / total;
    const steps = Math.max(1, Math.round((ms * hz) / 1000));
    for (let k = 1; k <= steps; k++) {
      const s = minJerk(k / steps);
      const at = round({ x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s });
      if (last && at.x === last.x && at.y === last.y) continue;
      previous = Math.max(start + (ms * k) / steps, previous + 1000 / MAX_HZ);
      samples.push({ at, t: previous });
      last = at;
    }
    start += ms;
  }
  return samples;
}

const round = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });
