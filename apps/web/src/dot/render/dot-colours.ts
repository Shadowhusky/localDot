// dot's materials where dot.css does not reach: the gradients of DotView's SVG skin and the canvas
// that paints dot into an exported video, in a worker. The eye colours are dot.css's --dot-eye*.
export const EYE = "#0b0c0f";
export const EYE_STOPS: [offset: number, color: string][] = [
  [0, "#23262c"],
  [0.42, EYE],
  [1, "#050607"],
];
// What the body darkens toward as dot dims.
export const VOID = "#0a0b0d";
export const PEARL_STOPS: [offset: number, color: string][] = [
  [0, "#f6f7f8"],
  [0.36, "#eceef0"],
  [0.68, "#d3d6db"],
  [0.9, "#a9adb5"],
  [1, "#8d929a"],
];
const CLEAR = "rgba(255,255,255,0)";
// The light along the body's lower left edge.
export const SHEEN_STOPS: [offset: number, color: string][] = [
  [0, CLEAR],
  [0.86, CLEAR],
  [0.97, "rgba(255,255,255,0.55)"],
  [1, CLEAR],
];
export const GLOSS_STOPS: [offset: number, color: string][] = [
  [0, "rgba(255,255,255,0.75)"],
  [0.55, "rgba(255,255,255,0.22)"],
  [1, CLEAR],
];
// The shade under the ball where it sits on a picture.
export const SHADE = "rgba(0,0,0,0.26)";

// A theme colour (src/stage/theme.ts) as a canvas fill or gradient stop.
export function canvasColour({ color, alpha }: { color: number; alpha: number }): string {
  return `rgba(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255},${alpha})`;
}
