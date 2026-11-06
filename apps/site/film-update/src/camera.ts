import type { Layout } from "./layout.ts";

// The film at 16:9: the phone to the right of its titles, Studio's window just right of the phone, and
// the grid of windows round it.
export const WIDE: Layout = {
  W: 1920,
  H: 1080,
  // The phone, bezel and all, inside the frame's height with room to spare, drift included.
  chat: { cx: 1290, cy: 540, s: 1.05, w: 402, h: 874 },
  // Studio's window beside the phone at the phone's own scale, so the camera only pans across to it.
  grid: { cx: 1575 + 573, cy: 640, w: 1146, h: 644.6, gap: 40 },
  order: [
    [-1, 0],
    [1, 0],
    [0, 1],
    [-1, 1],
    [1, 1],
    [-1, -1],
    [0, -1],
    [1, -1],
  ],
  room: { w: 1280, h: 720 },
  window: { w: 1600, h: 900 },
  studio: 1400,
  gridAt: [960, 640],
  gridK: 0.404,
  dot: 37,
  focus: { room: [960, 640] },
  band: { top: 200, bottom: 1080 },
  spots: {
    auto: { x: 1290, y: 540, r: 170 },
    perch: { x: 1740, y: 540, r: 64 },
    end: { x: 0.33 * 1920, y: 0.5 * 1080, r: 0.11 * 1080 },
  },
  chatLook: [-7, 0],
  sparks: [
    [500, 400],
    [770, 420],
    [800, 640],
    [470, 660],
  ],
};
