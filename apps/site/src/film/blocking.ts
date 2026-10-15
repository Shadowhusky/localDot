import type { PersonaId } from "@localdot/protocol";
import { LAND, SWAP, spinJump } from "../dot3d/jump.ts";
import { ease, track } from "../story/tracks.ts";
import { CUES, M } from "./cues.ts";

// Where dot shows when it is free of the app: fractions of the frame's width and height, and its
// radius as a fraction of the frame's height.
export interface Spot {
  x: number;
  y: number;
  r: number;
}

// Everything the film's 3D layer shows at a moment, in seconds.
export interface Block {
  spot: Spot;
  // 0 free at its spot, 1 sitting in the app's dock.
  docked: number;
  // Positive flattens dot, negative stretches it.
  squash: number;
  // The turntable's turn, in radians.
  spin: number;
  persona: PersonaId;
  pinned: boolean;
  app: {
    // Its centre (fractions of the frame), height (fraction of the frame's), turn about the vertical
    // (radians) and how far behind the frame it is (world units).
    x: number;
    y: number;
    h: number;
    yaw: number;
    back: number;
    shown: number;
    // 0 framed beside the words, 1 its Theatre filling the frame.
    focus: number;
    // Showing the visitor in control.
    yours: boolean;
  };
  ring: { shown: number; turn: number; size: number };
  // The five line-up dots and then dot itself, last in the line.
  lineup: { shown: number; hops: Hop[] };
  // The studio takes on the colour of the dot on the turntable.
  wash: PersonaId | null;
}

// How high a dot is off the ground, as a fraction of the frame's height, and how flattened.
export interface Hop {
  lift: number;
  squash: number;
}

const linear = ease.linear;
// The app arrives, with dot shrinking into its dock as it comes, leaves for the models and comes
// back for the replay.
const DOCK_IN = M.screen;
const DOCKING = 0.8;
const UNDOCK = M.models - 0.2;
const REDOCK = M.replay;
const LEAVE = M.yours - 0.4;

const dockedAt = track(
  [
    [0, 0],
    [DOCK_IN, 0],
    [DOCK_IN + DOCKING, 1],
    [UNDOCK, 1],
    [UNDOCK + 0.6, 0],
    [REDOCK, 0],
    [REDOCK + 0.6, 1],
    [LEAVE, 1],
    [LEAVE + 0.7, 0],
  ],
  ease.inOut,
);

// The fall onto the first mark speeds up all the way down; at the first frame dot is already falling.
const fallY = track(
  [
    [M.land - 0.6, -0.2],
    [M.land, 0.55],
  ],
  ease.in,
);
const spotX = track([
  [0, 0.68],
  [DOCK_IN, 0.68],
  [UNDOCK, 0.5],
  [M.lineup, 0.5],
  [M.lineup + 0.4, 0.825],
  [M.rewind, 0.825],
  [M.replay, 0.5],
  [M.save, 0.66],
  [M.end, 0.66],
  [M.hit, 0.33],
]);
const spotY = track([
  [M.land, 0.55],
  [UNDOCK, 0.42],
  [M.jobs - 0.2, 0.42],
  [M.jobs, 0.5],
  [M.lineup, 0.5],
  [M.lineup + 0.4, 0.56],
  [M.rewind, 0.56],
  [M.replay, 0.5],
  [M.save, 0.52],
  [M.end, 0.52],
  [M.hit, 0.5],
]);
const spotR = track([
  [0, 0.13],
  [UNDOCK, 0.12],
  [M.jobs - 0.2, 0.12],
  [M.jobs, 0.17],
  [M.lineup, 0.17],
  [M.lineup + 0.4, 0.065],
  [M.rewind, 0.065],
  [M.replay, 0.17],
  [M.save, 0.15],
  [M.end, 0.15],
  [M.hit, 0.11],
]);

// Hops between places: their windows and how high they arc, as a fraction of the frame's height.
const HOPS: readonly [number, number, number][] = [
  [DOCK_IN, DOCK_IN + DOCKING, 0.05],
  [UNDOCK, UNDOCK + 0.6, 0.12],
  [REDOCK, REDOCK + 0.6, 0.1],
  [LEAVE, LEAVE + 0.7, 0.08],
  [M.end, M.hit, 0.1],
];

// Landings and beats: a jolt that flattens dot and rings out.
const JOLTS: readonly [number, number][] = [
  [M.land, 0.24],
  [1, 0.05],
  [1.5, 0.05],
  [DOCK_IN + DOCKING, 0.06],
  [UNDOCK + 0.6, 0.08],
  [M.lineup + 0.4, 0.1],
  [REDOCK + 0.6, 0.08],
  [LEAVE + 0.7, 0.08],
  [M.hit, 0.16],
];

function squashAt(t: number): number {
  let s = 0;
  for (const [at, amp] of JOLTS) {
    const d = t - at;
    if (d < 0 || d > 0.7) continue;
    s += amp * Math.exp(-d / 0.1) * Math.cos((2 * Math.PI * d) / 0.28);
  }
  // The crouch before the drop.
  const crouch = (t - (M.jobs - 0.35)) / 0.35;
  if (crouch > 0 && crouch < 1) s += 0.12 * Math.sin((Math.PI / 2) * crouch);
  return s;
}

function hopAt(t: number): number {
  for (const [from, to, height] of HOPS) {
    if (t > from && t < to) return -height * Math.sin(Math.PI * ((t - from) / (to - from)));
  }
  return 0;
}

// A hop in place, t seconds from takeoff: a crouch, the jump and a squash as it lands.
function hop(t: number, height: number): Hop {
  const crouch = 0.1;
  const air = 0.32;
  if (t < -crouch || t > air + 0.5) return { lift: 0, squash: 0 };
  if (t < 0) return { lift: 0, squash: 0.12 * Math.sin((Math.PI / 2) * ((t + crouch) / crouch)) };
  if (t <= air) {
    const u = t / air;
    return { lift: height * Math.sin(Math.PI * u), squash: -0.1 * Math.abs(Math.cos(Math.PI * u)) };
  }
  const d = t - air;
  return { lift: 0, squash: 0.16 * Math.exp(-d / 0.08) * Math.cos((2 * Math.PI * d) / 0.26) };
}

// The line-up's wave: each dot hops in turn from the left, landing before they all smile.
const WAVE = M.lineup + 0.55;
const WAVE_STEP = 0.08;

function waveAt(s: number): Hop[] {
  return Array.from({ length: 6 }, (_, i) => hop(s - (WAVE + i * WAVE_STEP), 0.05));
}

// The outfit changes: each a spin-jump that swaps outfit facing away and lands on its outfit's beat.
// The turns add up, so one that starts while the last settles carries on from it.
function jumpsAt(t: number): { spin: number; lift: number; squash: number } {
  let spin = 0;
  let lift = 0;
  let squash = 0;
  for (const { at } of CUES.outfits) {
    const j = spinJump(t - (at - LAND));
    spin += j.spin;
    lift += j.lift;
    squash += j.squash;
  }
  return { spin: spin % (Math.PI * 2), lift, squash };
}

function personaAt(t: number): PersonaId {
  let persona: PersonaId = "everyday";
  if (t >= M.jobs && t < M.replay)
    for (const o of CUES.outfits) if (t >= o.at - LAND + SWAP) persona = o.persona;
  return persona;
}

const appShown = track(
  [
    [0, 0],
    [M.screen - 0.05, 0],
    [M.screen + 0.3, 1],
    [UNDOCK, 1],
    [UNDOCK + 0.6, 0],
    [REDOCK, 0],
    [REDOCK + 0.3, 1],
    [M.save, 1],
    [M.save + 0.5, 0.35],
    [LEAVE, 0.35],
    [LEAVE + 0.6, 0],
  ],
  linear,
);
const appBack = track(
  [
    [M.screen - 0.05, 9],
    [M.screen + 0.8, 0],
    [UNDOCK, 0],
    [UNDOCK + 0.6, 7],
    [REDOCK - 0.05, 9],
    [REDOCK + 0.6, 0],
    [LEAVE, 0],
    [LEAVE + 0.6, 7],
  ],
  ease.out,
);
const appFocus = track([
  [M.montage - 0.2, 0],
  [M.montage + 0.1, 1],
  [M.step - 0.2, 1],
  [M.step + 0.1, 0],
]);

// The models fly in, then fold into dot, gone before it jumps.
const ringShown = track(
  [
    [M.models + 0.3, 0],
    [M.models + 0.9, 1],
    [M.jobs - 0.6, 1],
    [M.jobs - 0.38, 0],
  ],
  linear,
);
const ringSize = track([
  [M.models + 0.3, 1.25],
  [M.models + 0.9, 1],
  [M.jobs - 0.6, 1],
  [M.jobs - 0.38, 0.55],
]);

const lineupShown = track(
  [
    [M.lineup, 0],
    [M.lineup + 0.45, 1],
  ],
  linear,
);

// The rewind plays the line-up backwards, from its last beat to before it came, in half a second.
const REWIND_SPEED = (M.rewind - M.lineup) / (M.replay - M.rewind);

export function blockAt(t: number): Block {
  const s = t > M.rewind && t < M.replay ? M.rewind - (t - M.rewind) * REWIND_SPEED : t;
  const y = s < M.land ? fallY(s) : spotY(s);
  const jump = jumpsAt(t);
  const r = spotR(s);
  const turn = t > M.models ? 0.5 * (t - M.models) + 0.32 * (t - M.models) ** 2 : 0;
  const hops = s > M.lineup && s < M.replay ? waveAt(s) : [];
  const own = hops[5] ?? { lift: 0, squash: 0 };
  return {
    spot: { x: spotX(s), y: y + hopAt(s) - jump.lift * r - own.lift, r },
    docked: dockedAt(t),
    squash: squashAt(s) + jump.squash + own.squash,
    spin: jump.spin,
    persona: personaAt(t),
    pinned: t >= M.pin,
    app: {
      x: 0.715,
      y: 0.53,
      h: 0.64,
      yaw: (-13 * Math.PI) / 180,
      back: appBack(t),
      shown: appShown(t),
      focus: appFocus(t),
      yours: t >= M.take && t < M.handBack,
    },
    ring: { shown: ringShown(t), turn, size: ringSize(t) },
    lineup: { shown: s >= M.lineup && s < M.replay ? lineupShown(s) : 0, hops },
    wash: t >= M.jobs + 0.6 && t < M.lineup ? personaAt(t) : null,
  };
}
