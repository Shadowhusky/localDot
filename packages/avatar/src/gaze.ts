import { clamp } from "./params.ts";

export interface Point {
  x: number;
  y: number;
}

export interface GazeLimits {
  head: number;
  eye: number;
}

export interface GazeTargets {
  eyeX: number;
  eyeY: number;
  headX: number;
  headY: number;
}

export const DEFAULT_GAZE_LIMITS: GazeLimits = { head: 0.6, eye: 1 };
export const HEAD_SHARE = 0.6;

const AHEAD: GazeTargets = { eyeX: 0, eyeY: 0, headX: 0, headY: 0 };

// A direction is in reach units: x to the viewer's right, y up, 1 at the edge of the reach.
export function gazeToward(
  direction: Point,
  limits: GazeLimits = DEFAULT_GAZE_LIMITS,
): GazeTargets {
  const dx = clamp(direction.x, -1, 1);
  const dy = clamp(direction.y, -1, 1);
  return {
    eyeX: dx * limits.eye,
    eyeY: dy * limits.eye,
    headX: dx * HEAD_SHARE * limits.head,
    headY: dy * HEAD_SHARE * limits.head,
  };
}

export function gazeTargets(
  point: Point | null,
  headCenter: Point,
  reach: number,
  limits: GazeLimits = DEFAULT_GAZE_LIMITS,
): GazeTargets {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !(reach > 0))
    return { ...AHEAD };
  return gazeToward(
    { x: (point.x - headCenter.x) / reach, y: (headCenter.y - point.y) / reach },
    limits,
  );
}
