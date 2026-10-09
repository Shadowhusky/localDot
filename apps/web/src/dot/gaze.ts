import type { Point } from "./engine/engine.ts";
import { GAZE_MAX } from "./engine/sphere.ts";

// From dot's centre to a target on the page, in CSS px, to where its eyes turn. tanh keeps the
// direction legible for far targets while near ones still resolve.
export function gazeTo(dx: number, dy: number): Point {
  return { x: GAZE_MAX.x * Math.tanh(dx / 360), y: GAZE_MAX.y * Math.tanh(dy / 240) };
}
