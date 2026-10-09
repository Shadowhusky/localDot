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

// The props dot works with: flat porcelain and graphite, with one accent the painter supplies.
export const PROP = {
  accentRest: "#e8eaed",
  shade: "rgba(0,0,0,0.32)",
  graphite: "#26282d",
  graphiteHi: "#34373d",
  graphiteLo: "#17181c",
  hairline: "rgba(255,255,255,0.12)",
  key: "#dfe2e6",
  keyDown: "#aeb3ba",
  keyEdge: "#8d929a",
  cardDark: "#16171b",
  cardDarkBar: "#212227",
  dots: "rgba(255,255,255,0.22)",
  lineLight: "rgba(205,209,215,0.62)",
  porcelainHi: "#f4f5f7",
  porcelainLo: "#d6d9dd",
  porcelainFold: "#c3c7cd",
  pageBar: "#d0d3d8",
  pagePill: "#f7f8f9",
  pageImage: "rgba(40,44,52,0.13)",
  pageBack: "#e3e5e8",
  lineDark: "#41454c",
  lineMid: "rgba(65,69,76,0.42)",
  ink: "#0b0c0f",
  glass: "rgba(225,238,248,0.10)",
  glassEdge: "rgba(255,255,255,0.3)",
  fold: "rgba(11,12,15,0.4)",
  spine: "rgba(0,0,0,0.2)",
} as const;
