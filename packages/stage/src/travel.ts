import { requireFinite } from "@localdot/protocol";
import { INTENT_LEAD_MS } from "./timing.ts";

export type Speed = "watch" | "fast" | "instant";

const SPEED_FACTOR = { watch: 1, fast: 2 } as const;
const UNKNOWN_TARGET_WIDTH = 24;
export const INSTANT_LEAD_MS = 60;

export function travelDurationMs(
  distance: number,
  targetWidth: number | undefined,
  speed: Speed,
): number {
  if (requireFinite(distance, "distance") < 0) throw new RangeError("distance must be >= 0");
  if (targetWidth !== undefined) requireFinite(targetWidth, "target width");
  if (speed === "instant") return 0;
  const width = targetWidth && targetWidth > 0 ? targetWidth : UNKNOWN_TARGET_WIDTH;
  const fitts = 150 + 100 * Math.log2(distance / width + 1);
  return Math.min(700, Math.max(220, fitts)) / SPEED_FACTOR[speed];
}

export function dwellMs(speed: Speed): number {
  return speed === "instant" ? 0 : 90 / SPEED_FACTOR[speed];
}

export function intentLeadMs(speed: Speed): number {
  return speed === "instant" ? 0 : INTENT_LEAD_MS / SPEED_FACTOR[speed];
}

// Watched, the first 60 characters still appear one by one, several times faster than anyone types.
// Past them, and with nobody watching, keys go as fast as the app takes them.
export function typingPaceMs(speed: Speed, index: number): number {
  return speed === "watch" && index < 60 ? 12 : 0;
}
