import type { Layout } from "./layout.ts";

// The film at 9:16: titles at the top, the phone below them framed whole, Studio's window below the phone
// and the grid of windows round it.
export const TALL: Layout = {
  W: 1080,
  H: 1920,
  // Whole inside the safe area, drift and all: clear of the titles above and the platform's own bar below.
  chat: { cx: 440, cy: 985, s: 1.85, w: 402, h: 500 },
  // Studio, stacked as the app lays it out on a tablet, below the phone at the phone's own scale, so the
  // camera only pans down to it; then square tiles round it, two wide, 2 by 2, 2 by 3, 3 by 3, filling
  // the safe area.
  grid: { cx: 475, cy: 1530 + 417, w: 835, h: 835, gap: 36 },
  order: [
    [1, 0],
    [0, 1],
    [1, 1],
    [0, -1],
    [1, -1],
    [-1, -1],
    [-1, 0],
    [-1, 1],
  ],
  room: { w: 760, h: 760 },
  window: { w: 900, h: 900 },
  studio: 830,
  gridAt: [465, 975],
  gridK: 0.334,
  dot: 26,
  focus: { room: [465, 975] },
  band: { top: 450, bottom: 1500 },
  spots: {
    auto: { x: 540, y: 930, r: 200 },
    perch: { x: 970, y: 560, r: 52 },
    end: { x: 540, y: 560, r: 150 },
  },
  chatLook: [-7, 1],
  sparks: [
    [360, 420],
    [720, 440],
    [745, 670],
    [335, 690],
  ],
};
