import type { Wearable } from "@localdot/protocol";
import { LAND, spinJump } from "../../src/dot3d/jump.ts";
import { ease, mix } from "../../src/story/tracks.ts";
import { M } from "./cues.ts";
import { CREW, type Layout, windowAt } from "./layout.ts";

// Where a dot is, in film pixels and its radius in pixels.
export interface Place {
  x: number;
  y: number;
  r: number;
  squash: number;
  spin: number;
  shown: boolean;
  wears: readonly Wearable[];
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

// A dot comes on with a little overshoot, and goes as softly.
const grow = (u: number) => 1 + 2.2 * (clamp(u) - 1) ** 3 + 1.2 * (clamp(u) - 1) ** 2;
const presence = (t: number, ins: readonly number[], outs: readonly number[]) => {
  let scale = 0;
  for (const at of [...ins, ...outs].sort((a, b) => a - b)) {
    if (t < at) break;
    scale = ins.includes(at) ? grow((t - at) / 0.5) : 1 - ease.inOut(clamp((t - at) / 0.5));
  }
  return scale;
};

const JOLTS: readonly (readonly [number, number])[] = [
  [M.land, 0.15],
  [M.perch + 0.5, 0.1],
  [M.choice, 0.12],
  [M.hit, 0.2],
];

function jolt(t: number): number {
  let s = 0;
  for (const [at, amp] of JOLTS) {
    const d = t - at;
    if (d < 0 || d > 0.7) continue;
    s += amp * Math.exp(-d / 0.1) * Math.cos((2 * Math.PI * d) / 0.28);
  }
  return s;
}

// dot jumps in to land on the intro's first beat, jumps into Coder's hoodie to land as Auto picks it,
// and jumps again to land on the last hit.
function jumpAt(t: number) {
  const starts = [M.land - LAND, M.choice - LAND, M.hit - LAND];
  let at = -1;
  for (const from of starts) if (t >= from) at = from;
  if (at < 0) return { lift: 0, squash: 0, spin: 0 };
  const jump = spinJump(t - at);
  return { lift: jump.lift, squash: jump.squash, spin: jump.spin % (Math.PI * 2) };
}

// The film's dot. It says hello, waits beside the phone, stays out of every close shot and the windows,
// and comes back for the end.
function main(t: number, layout: Layout): Place {
  const { auto, perch, end } = layout.spots;
  let place = { x: auto.x, y: auto.y, r: auto.r };
  if (t >= M.perch) {
    const k = ease.inOut(clamp((t - M.perch) / 0.5));
    place = {
      x: mix(auto.x, perch.x, k),
      y: mix(auto.y, perch.y, k),
      r: mix(auto.r, perch.r, k),
    };
  }
  if (t >= M.away) place = { x: end.x, y: end.y, r: end.r };
  const scale = presence(t, [-1, M.away], [M.desk]);
  const jump = jumpAt(t);
  return {
    x: place.x,
    y: place.y - jump.lift * place.r,
    r: place.r * scale,
    squash: jolt(t) + jump.squash,
    spin: jump.spin,
    shown: scale > 0.01,
    // The task's one look, from when Auto picks Coder: the same as its dot in the app.
    wears: t >= M.choice && t < M.hit ? ["hoodie"] : [],
  };
}

// A window's own dot, in the world: its place on its window's top edge, popping in on its beat and going
// as the windows fall in. The stage seats it there at its size on screen.
function crew(t: number, layout: Layout, i: number): Place {
  const { pop, wears } = CREW[i] as (typeof CREW)[number];
  // Toward the middle of the grid.
  const [col] = i === 0 ? [0] : (layout.order[i - 1] as readonly [number, number]);
  const side = col > 0 ? -0.3 : 0.3;
  const win = windowAt(t, layout, i - 1);
  const scale = presence(t, [pop], [M.away]);
  const { w, h } = layout.grid;
  const s = win?.scale ?? 1;
  const r = w * 0.07 * s;
  return {
    x: (win?.x ?? 0) + side * w * s,
    y: (win?.y ?? 0) - (h / 2) * s,
    r: r * scale,
    squash: 0,
    spin: 0,
    shown: !!win && scale > 0.01,
    wears,
  };
}

export const blockAt = (t: number, layout: Layout) => ({
  main: main(t, layout),
  crew: CREW.map((_, i) => crew(t, layout, i)),
});
