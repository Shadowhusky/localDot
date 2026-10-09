import type { Frame, OracleCall, OracleView, Policy, ScreenWindow } from "./oracle.ts";

export interface Step {
  name: string;
  // Until this holds, the policy waits a second and looks again.
  ready?(view: OracleView): boolean;
  act(view: OracleView): OracleCall[];
  // Checked on the next turn; a false result runs the step again.
  done?(view: OracleView): boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_WAITS = 45;
const MAX_TRIES = 3;
const MAX_LOOKS = 3;

export const click = (x: number, y: number): OracleCall => [
  "computer",
  { action: "left_click", coordinate: [Math.round(x), Math.round(y)] },
];
export const tripleClick = (x: number, y: number): OracleCall => [
  "computer",
  { action: "triple_click", coordinate: [Math.round(x), Math.round(y)] },
];
export const doubleClick = (x: number, y: number): OracleCall => [
  "computer",
  { action: "double_click", coordinate: [Math.round(x), Math.round(y)] },
];
export const modifierClick = (x: number, y: number, keys: string): OracleCall => [
  "computer",
  { action: "left_click", coordinate: [Math.round(x), Math.round(y)], text: keys },
];
export const key = (combo: string, repeat?: number): OracleCall => [
  "computer",
  { action: "key", text: combo, ...(repeat ? { repeat } : {}) },
];
export const type = (text: string): OracleCall => ["computer", { action: "type", text }];
export const wait = (seconds: number): OracleCall => [
  "computer",
  { action: "wait", duration: seconds },
];
export const drag = (from: [number, number], to: [number, number]): OracleCall => [
  "computer",
  {
    action: "left_click_drag",
    start_coordinate: from.map(Math.round),
    coordinate: to.map(Math.round),
  },
];
// A stroke along a path: press, move through every point, release.
export const stroke = (points: [number, number][]): OracleCall[] => {
  const [first, ...rest] = points.map(([x, y]) => [Math.round(x), Math.round(y)]);
  return [
    ["computer", { action: "mouse_move", coordinate: first }],
    ["computer", { action: "left_mouse_down" }],
    ...rest.map((p): OracleCall => ["computer", { action: "mouse_move", coordinate: p }]),
    ["computer", { action: "left_mouse_up" }],
  ];
};

// A scripted policy: each step acts once, and its done() check is read from the next screenshot.
// A step whose check does not hold yet looks again (the app may still be opening a window), then
// acts again, up to three times. A failed input that the simulated user completed when the
// product handed the screen over counts as acted, as it would for a person helping.
export function scripted(steps: readonly Step[], summary: string): Policy {
  let index = 0;
  let acted = false;
  let tries = 0;
  let looks = 0;
  let waits = 0;
  let handoffsAtAct = 0;
  return (view) => {
    for (;;) {
      const step = steps[index];
      if (!step) return [["done", { summary }]];
      if (acted) {
        const failed = view.results.some((r) => !r.ok) && view.handoffs <= handoffsAtAct;
        if (!failed && (step.done?.(view) ?? true)) {
          index += 1;
          acted = false;
          tries = 0;
          waits = 0;
          continue;
        }
        if (!failed && looks < MAX_LOOKS) {
          looks += 1;
          return [wait(1)];
        }
        if (tries >= MAX_TRIES)
          return [["done", { summary: `Stopped: ${step.name} did not work.` }]];
        acted = false;
      }
      if (step.ready && !step.ready(view) && waits < MAX_WAITS) {
        waits += 1;
        return [wait(1)];
      }
      acted = true;
      tries += 1;
      looks = 0;
      handoffsAtAct = view.handoffs;
      return step.act(view);
    }
  };
}

export function windowTitled(view: OracleView, pattern: RegExp): ScreenWindow | undefined {
  return view.windows.find((w) => pattern.test(w.title));
}

export function near(
  [r, g, b]: [number, number, number],
  [tr, tg, tb]: [number, number, number],
  tolerance = 12,
): boolean {
  return (
    Math.abs(r - tr) <= tolerance && Math.abs(g - tg) <= tolerance && Math.abs(b - tb) <= tolerance
  );
}

function rgbAt(frame: Frame, x: number, y: number): [number, number, number] {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i] ?? 0, frame.data[i + 1] ?? 0, frame.data[i + 2] ?? 0];
}

// The first square block of a colour inside a region, scanning rows top to bottom.
export function findBlock(
  frame: Frame,
  colour: [number, number, number],
  region: Rect,
  size = 8,
  tolerance = 12,
): { x: number; y: number } | undefined {
  const x1 = Math.min(frame.width - size, Math.round(region.x + region.w));
  const y1 = Math.min(frame.height - size, Math.round(region.y + region.h));
  for (let y = Math.max(0, Math.round(region.y)); y < y1; y++)
    for (let x = Math.max(0, Math.round(region.x)); x < x1; x++) {
      let all = true;
      for (let dy = 0; dy < size && all; dy++)
        for (let dx = 0; dx < size && all; dx++)
          all = near(rgbAt(frame, x + dx, y + dy), colour, tolerance);
      if (all) return { x, y };
    }
  return undefined;
}

// The extent of the run of one colour through a point, along its row and its column.
export function colourExtent(
  frame: Frame,
  at: { x: number; y: number },
  colour: [number, number, number],
  tolerance = 6,
): Rect | undefined {
  const x0 = Math.round(at.x);
  const y0 = Math.round(at.y);
  if (!near(rgbAt(frame, x0, y0), colour, tolerance)) return undefined;
  const same = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < frame.width &&
    y < frame.height &&
    near(rgbAt(frame, x, y), colour, tolerance);
  let left = x0;
  let right = x0;
  let top = y0;
  let bottom = y0;
  while (same(left - 1, y0)) left--;
  while (same(right + 1, y0)) right++;
  while (same(x0, top - 1)) top--;
  while (same(x0, bottom + 1)) bottom++;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

export function ellipse(centre: { x: number; y: number }, rx: number, ry: number, points = 40) {
  return Array.from({ length: points + 1 }, (_, i): [number, number] => {
    const angle = (2 * Math.PI * i) / points;
    return [centre.x + rx * Math.cos(angle), centre.y + ry * Math.sin(angle)];
  });
}
