import { parseCssColor } from "../../stage/theme.ts";

// dot's materials where dot.css does not reach: the gradients of DotView's SVG skin and the canvas
// that paints dot into an exported video, in a worker. The eye colours are dot.css's --dot-eye*.
export const EYE = "#0b0c0f";
const GRAPHITE = "#23262c";
export const EYE_STOPS: [offset: number, color: string][] = [
  [0, GRAPHITE],
  [0.42, EYE],
  [1, "#050607"],
];
// What the body darkens toward as dot dims.
export const VOID = "#0a0b0d";
// The porcelain, from its lit crown to its shaded foot.
const PEARL = ["#f6f7f8", "#eceef0", "#d3d6db", "#a9adb5", "#8d929a"] as const;
export const PEARL_STOPS: [offset: number, color: string][] = [
  [0, PEARL[0]],
  [0.36, PEARL[1]],
  [0.68, PEARL[2]],
  [0.9, PEARL[3]],
  [1, PEARL[4]],
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

// One of these colours at an opacity.
export function shadeOf(colour: string, alpha: number): string {
  return canvasColour({ color: parseCssColor(colour).color, alpha });
}

// A colour part way from a to b, as #rrggbb or rgb()/rgba().
export function mixColours(a: string, b: string, t: number): string {
  const x = parseCssColor(a);
  const y = parseCssColor(b);
  const k = Math.min(1, Math.max(0, t));
  const channel = (shift: number) => {
    const from = (x.color >> shift) & 255;
    return Math.round(from + (((y.color >> shift) & 255) - from) * k) << shift;
  };
  return canvasColour({
    color: channel(16) | channel(8) | channel(0),
    alpha: x.alpha + (y.alpha - x.alpha) * k,
  });
}

// The props dot works with, in its own porcelain, graphite and ink; the painter supplies the accent.
export const PROP = {
  accentRest: PEARL[1],
  shade: SHADE,
  graphite: GRAPHITE,
  graphiteHi: mixColours(GRAPHITE, PEARL[3], 0.1),
  graphiteLo: mixColours(GRAPHITE, VOID, 0.6),
  hairline: shadeOf(PEARL[0], 0.12),
  key: PEARL[1],
  keyDown: PEARL[3],
  keyEdge: PEARL[4],
  cardDark: mixColours(GRAPHITE, VOID, 0.65),
  cardDarkBar: mixColours(GRAPHITE, VOID, 0.2),
  dots: shadeOf(PEARL[0], 0.22),
  lineLight: shadeOf(PEARL[2], 0.62),
  porcelainHi: PEARL[0],
  porcelainLo: PEARL[2],
  porcelainFold: mixColours(PEARL[2], PEARL[3], 0.45),
  pageBar: mixColours(PEARL[2], PEARL[3], 0.2),
  pagePill: PEARL[0],
  pageImage: shadeOf(GRAPHITE, 0.13),
  pageBack: PEARL[1],
  lineDark: mixColours(GRAPHITE, PEARL[3], 0.25),
  lineMid: shadeOf(GRAPHITE, 0.42),
  ink: EYE,
  glass: shadeOf(PEARL[0], 0.1),
  glassEdge: shadeOf(PEARL[0], 0.3),
  fold: shadeOf(EYE, 0.4),
  spine: shadeOf(VOID, 0.2),
} as const;
