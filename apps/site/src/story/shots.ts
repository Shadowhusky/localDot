import type { Wearable } from "@localdot/protocol";
import type { PhoneKey } from "../scene/phone.ts";
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
  // Chat: the phone in front, the screen dimmed behind it and dot beside it.
  {
    chapter: "views",
    at: 0.16,
    camera: [-0.85, 0, D * 2.25],
    target: [-1.2, 0, 0],
    dot: { x: 0.45, y: 0.8, r: 0.06, depth: 0.5 },
    screen: 0.32,
  },
  {
    chapter: "views",
    at: 0.34,
    camera: [-0.85, 0, D * 2.25],
    target: [-1.2, 0, 0],
    dot: { x: 0.45, y: 0.8, r: 0.06, depth: 0.5 },
    screen: 0.32,
  },
  // Studio: the whole window, with the phone come down to its corner.
  {
    chapter: "views",
    at: 0.5,
    camera: [-1.03, -0.15, D * 2.4],
    target: [-1.39, -0.18, 0],
    dot: { x: 0.45, y: 0.82, r: 0.055, depth: 0.5 },
    screen: 1,
  },
  {
    chapter: "views",
    at: 0.64,
    camera: [-1.03, -0.15, D * 2.4],
    target: [-1.39, -0.18, 0],
    dot: { x: 0.45, y: 0.82, r: 0.055, depth: 0.5 },
    screen: 1,
  },
  // Several at once: a row of dots at the foot of the window, one for each task.
  {
    chapter: "views",
    at: 0.78,
    camera: [-1.03, -0.2, D * 2.4],
    target: [-1.39, -0.23, 0],
    dot: { x: 0.5, y: 0.84, r: 0.045, depth: 0.5 },
    screen: 1,
  },
  {
    chapter: "views",
    at: 0.93,
    camera: [-1.03, -0.2, D * 2.4],
    target: [-1.39, -0.23, 0],
    dot: { x: 0.5, y: 0.84, r: 0.045, depth: 0.5 },
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
    chapter: "views",
    at: 0.16,
    camera: [0, -0.25, D * 2.2],
    target: [0, -0.75, 0],
    dot: { x: 0.14, y: 0.6, r: 0.09, depth: 0.5 },
    screen: 0.28,
  },
  {
    chapter: "views",
    at: 0.34,
    camera: [0, -0.25, D * 2.2],
    target: [0, -0.75, 0],
    dot: { x: 0.14, y: 0.6, r: 0.09, depth: 0.5 },
    screen: 0.28,
  },
  {
    chapter: "views",
    at: 0.5,
    camera: [0.15, -0.25, D * 2.2],
    target: [0.37, -0.72, 0],
    dot: { x: 0.14, y: 0.66, r: 0.075, depth: 0.5 },
    screen: 1,
  },
  {
    chapter: "views",
    at: 0.64,
    camera: [0.15, -0.25, D * 2.2],
    target: [0.37, -0.72, 0],
    dot: { x: 0.14, y: 0.66, r: 0.075, depth: 0.5 },
    screen: 1,
  },
  {
    chapter: "views",
    at: 0.78,
    camera: [0, -0.25, D * 2.3],
    target: [0, -0.86, 0],
    dot: { x: 0.14, y: 0.64, r: 0.075, depth: 0.5 },
    screen: 1,
  },
  {
    chapter: "views",
    at: 0.93,
    camera: [0, -0.25, D * 2.3],
    target: [0, -0.86, 0],
    dot: { x: 0.14, y: 0.64, r: 0.075, depth: 0.5 },
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

// The phone that shows Chat, through its chapter: up into the frame, then down to the window's corner
// as the window comes forward, and away for the row of dots.
export const PHONE_WIDE: readonly PhoneKey[] = [
  { at: 0.02, x: 0.68, y: 1.3, h: 0.8, yaw: 0.42, o: 0 },
  { at: 0.16, x: 0.68, y: 0.55, h: 0.8, yaw: 0.14, o: 1 },
  { at: 0.34, x: 0.68, y: 0.55, h: 0.8, yaw: 0.08, o: 1 },
  { at: 0.5, x: 0.92, y: 0.73, h: 0.48, yaw: -0.14, o: 1 },
  { at: 0.64, x: 0.92, y: 0.73, h: 0.48, yaw: -0.18, o: 1 },
  { at: 0.74, x: 1.12, y: 0.78, h: 0.44, yaw: -0.34, o: 0 },
];

export const PHONE_TALL: readonly PhoneKey[] = [
  { at: 0.02, x: 0.56, y: 1.1, h: 0.52, yaw: 0.34, o: 0 },
  { at: 0.16, x: 0.56, y: 0.36, h: 0.52, yaw: 0.1, o: 1 },
  { at: 0.34, x: 0.56, y: 0.36, h: 0.52, yaw: 0.06, o: 1 },
  { at: 0.5, x: 0.78, y: 0.4, h: 0.38, yaw: -0.1, o: 1 },
  { at: 0.64, x: 0.78, y: 0.4, h: 0.38, yaw: -0.14, o: 1 },
  { at: 0.74, x: 1.1, y: 0.44, h: 0.34, yaw: -0.3, o: 0 },
];

// With reduced motion the chapter is one still: the window, and the phone at its corner.
export const PHONE_STILL_AT = 0.6;

// The row of dots in Several at once, from dot's own place: where each shows on the stage.
export const CREW_WIDE: readonly { x: number; y: number }[] = [
  { x: 0.59, y: 0.84 },
  { x: 0.68, y: 0.84 },
  { x: 0.77, y: 0.84 },
  { x: 0.86, y: 0.84 },
];

export const CREW_TALL: readonly { x: number; y: number }[] = [
  { x: 0.32, y: 0.64 },
  { x: 0.5, y: 0.64 },
  { x: 0.68, y: 0.64 },
  { x: 0.86, y: 0.64 },
];

// What sets each task in the row apart.
export const CREW_LOOKS: readonly (readonly Wearable[])[] = [
  ["cap"],
  ["sunglasses"],
  ["bow"],
  ["star-pin"],
];
