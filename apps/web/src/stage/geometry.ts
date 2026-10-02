import { RING_FADE_MS, RING_PX, RING_SCALE_MS } from "@localdot/stage";

// The mockup's arrow (c-theatre.html), tip at the origin, 24 px tall at scale 1, tilted 12°.
const ARROW = [0, 0, 0, 17.6, 4.5, 13.3, 7.5, 20.2, 10.8, 18.8, 7.9, 12.2, 14.2, 12.2];
export const CURSOR_HEIGHT_PX = 24;
export const CURSOR_TILT_RAD = (-12 * Math.PI) / 180;
const ARROW_SCALE = CURSOR_HEIGHT_PX / 20.2;

export function cursorPolygon(scale: number): number[] {
  return ARROW.map((v) => v * ARROW_SCALE * scale);
}

// Research §4.3.3: scale 0.6→1.0 over 225 ms (ease-out), opacity 0.7→0 over 300 ms.
export function ringRadius(p: number): { outer: number; alpha: number } {
  const u = Math.min(1, (p * RING_FADE_MS) / RING_SCALE_MS);
  const eased = 1 - (1 - u) ** 3;
  return { outer: (RING_PX / 2) * (0.6 + 0.4 * eased), alpha: 0.7 * (1 - p) };
}

export function videoPlacement(
  frame: { w: number; h: number },
  screen: { w: number; h: number },
): { sx: number; sy: number; mismatch: boolean } {
  const sx = screen.w / frame.w;
  const sy = screen.h / frame.h;
  return { sx, sy, mismatch: sx !== 1 || sy !== 1 };
}
