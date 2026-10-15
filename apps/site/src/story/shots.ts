import type { ChapterName } from "./director.ts";

// Where the camera is and where dot shows, at moments of the story. Between two shots everything
// eases from one to the next; scrolling back plays it backwards.
//
// camera and target are in world units, where the app's screen is the z = 0 plane two units tall.
// dot is where its centre shows (fractions of the stage's width and height), its radius (a fraction
// of the stage's shorter side) and how far in front of the camera it is (a fraction of the
// camera's distance to its target).
export interface Shot {
  chapter: ChapterName;
  // Progress through that chapter.
  at: number;
  camera: readonly [number, number, number];
  target: readonly [number, number, number];
  dot: { x: number; y: number; r: number; depth: number };
  // How visible the app's screen is.
  screen: number;
}

const D = 1 / Math.tan((30 * Math.PI) / 360);

export const WIDE: readonly Shot[] = [
  {
    chapter: "out",
    at: 0.9,
    camera: [0, 0.25, D * 2.7],
    target: [0, -0.62, 0],
    dot: { x: 0.5, y: 0.5, r: 0.14, depth: 0.55 },
    screen: 1,
  },
  // Watch: the screen comes back as dot's monitor, dot beside it watching.
  {
    chapter: "watch",
    at: 0.18,
    camera: [-0.55, 0.05, D * 1.62],
    target: [-1.22, 0, 0],
    dot: { x: 0.36, y: 0.82, r: 0.065, depth: 0.5 },
    screen: 1,
  },
  {
    chapter: "watch",
    at: 0.85,
    camera: [-0.4, 0.0, D * 1.68],
    target: [-1.2, 0, 0],
    dot: { x: 0.36, y: 0.82, r: 0.065, depth: 0.5 },
    screen: 1,
  },
  // Models: the screen goes far back; dot in the middle of its ring.
  {
    chapter: "models",
    at: 0.25,
    camera: [0, 0.6, D * 4.2],
    target: [0, -0.4, 0],
    dot: { x: 0.5, y: 0.37, r: 0.11, depth: 0.42 },
    screen: 0,
  },
  {
    chapter: "models",
    at: 0.85,
    camera: [0, 0.6, D * 4.2],
    target: [0, -0.4, 0],
    dot: { x: 0.5, y: 0.37, r: 0.11, depth: 0.42 },
    screen: 0,
  },
  // Replay: the screen in front again, square on, dot at its corner.
  {
    chapter: "replay",
    at: 0.2,
    camera: [-0.9, 0.0, D * 1.72],
    target: [-1.25, 0, 0],
    dot: { x: 0.36, y: 0.82, r: 0.065, depth: 0.5 },
    screen: 1,
  },
  {
    chapter: "replay",
    at: 0.9,
    camera: [-0.9, 0.05, D * 2.3],
    target: [-1.25, -0.05, 0],
    dot: { x: 0.36, y: 0.82, r: 0.065, depth: 0.5 },
    screen: 0.35,
  },
  // Dots: centre stage on the turntable.
  {
    chapter: "dots",
    at: 0.08,
    camera: [0, 0.4, D * 4],
    target: [0, -0.5, 0],
    dot: { x: 0.5, y: 0.44, r: 0.15, depth: 0.45 },
    screen: 0,
  },
  {
    chapter: "dots",
    at: 0.78,
    camera: [0, 0.4, D * 4],
    target: [0, -0.5, 0],
    dot: { x: 0.5, y: 0.44, r: 0.15, depth: 0.45 },
    screen: 0,
  },
  // The line-up: dot takes its place among the others.
  {
    chapter: "dots",
    at: 0.86,
    camera: [0, 0.4, D * 4],
    target: [0, -0.5, 0],
    dot: { x: 0.435, y: 0.42, r: 0.07, depth: 0.45 },
    screen: 0,
  },
  {
    chapter: "dots",
    at: 0.97,
    camera: [0, 0.4, D * 4],
    target: [0, -0.5, 0],
    dot: { x: 0.435, y: 0.42, r: 0.07, depth: 0.45 },
    screen: 0,
  },
  {
    chapter: "yours",
    at: 0.3,
    camera: [0, 0.3, D * 4],
    target: [0, -0.4, 0],
    dot: { x: 0.68, y: 0.5, r: 0.13, depth: 0.45 },
    screen: 0,
  },
  {
    chapter: "install",
    at: 0.3,
    camera: [0, 0.3, D * 4],
    target: [0, -0.4, 0],
    dot: { x: 0.3, y: 0.5, r: 0.12, depth: 0.45 },
    screen: 0,
  },
];

export const TALL: readonly Shot[] = [
  {
    chapter: "out",
    at: 0.9,
    camera: [0, 0.1, D * 3.1],
    target: [0, -1.15, 0],
    dot: { x: 0.5, y: 0.5, r: 0.2, depth: 0.55 },
    screen: 1,
  },
  {
    chapter: "watch",
    at: 0.18,
    camera: [0, -0.15, D * 1.9],
    target: [0, -0.55, 0],
    dot: { x: 0.2, y: 0.62, r: 0.11, depth: 0.5 },
    screen: 1,
  },
  {
    chapter: "watch",
    at: 0.85,
    camera: [0, -0.15, D * 1.9],
    target: [0, -0.55, 0],
    dot: { x: 0.2, y: 0.62, r: 0.11, depth: 0.5 },
    screen: 1,
  },
  {
    chapter: "models",
    at: 0.25,
    camera: [0, 0.6, D * 5],
    target: [0, -0.4, 0],
    dot: { x: 0.5, y: 0.34, r: 0.16, depth: 0.42 },
    screen: 0,
  },
  {
    chapter: "models",
    at: 0.85,
    camera: [0, 0.6, D * 5],
    target: [0, -0.4, 0],
    dot: { x: 0.5, y: 0.34, r: 0.16, depth: 0.42 },
    screen: 0,
  },
  {
    chapter: "replay",
    at: 0.2,
    camera: [0, -0.3, D * 1.7],
    target: [0, -0.3, 0],
    dot: { x: 0.18, y: 0.66, r: 0.09, depth: 0.5 },
    screen: 1,
  },
  {
    chapter: "replay",
    at: 0.9,
    camera: [0, -0.3, D * 2.4],
    target: [0, -0.3, 0],
    dot: { x: 0.18, y: 0.66, r: 0.09, depth: 0.5 },
    screen: 0.35,
  },
  {
    chapter: "dots",
    at: 0.08,
    camera: [0, 0.4, D * 5],
    target: [0, -0.5, 0],
    dot: { x: 0.5, y: 0.34, r: 0.24, depth: 0.45 },
    screen: 0,
  },
  {
    chapter: "dots",
    at: 0.78,
    camera: [0, 0.4, D * 5],
    target: [0, -0.5, 0],
    dot: { x: 0.5, y: 0.34, r: 0.24, depth: 0.45 },
    screen: 0,
  },
  {
    chapter: "dots",
    at: 0.86,
    camera: [0, 0.4, D * 5],
    target: [0, -0.5, 0],
    dot: { x: 0.5, y: 0.19, r: 0.1, depth: 0.45 },
    screen: 0,
  },
  {
    chapter: "dots",
    at: 0.97,
    camera: [0, 0.4, D * 5],
    target: [0, -0.5, 0],
    dot: { x: 0.5, y: 0.19, r: 0.1, depth: 0.45 },
    screen: 0,
  },
  {
    chapter: "yours",
    at: 0.3,
    camera: [0, 0.3, D * 5],
    target: [0, -0.4, 0],
    dot: { x: 0.5, y: 0.32, r: 0.18, depth: 0.45 },
    screen: 0,
  },
  {
    chapter: "install",
    at: 0.3,
    camera: [0, 0.3, D * 5],
    target: [0, -0.4, 0],
    dot: { x: 0.5, y: 0.26, r: 0.15, depth: 0.45 },
    screen: 0,
  },
];
