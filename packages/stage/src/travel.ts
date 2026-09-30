export type Speed = "watch" | "fast" | "instant";

const SPEED_FACTOR = { watch: 1, fast: 2 } as const;
const UNKNOWN_TARGET_WIDTH = 24;
export const INSTANT_LEAD_MS = 60;

export function travelDurationMs(
  distance: number,
  targetWidth: number | undefined,
  speed: Speed,
): number {
  if (speed === "instant") return 0;
  const width = targetWidth && targetWidth > 0 ? targetWidth : UNKNOWN_TARGET_WIDTH;
  const fitts = 150 + 100 * Math.log2(distance / width + 1);
  return Math.min(700, Math.max(220, fitts)) / SPEED_FACTOR[speed];
}

export function dwellMs(speed: Speed): number {
  return speed === "instant" ? 0 : 90 / SPEED_FACTOR[speed];
}
