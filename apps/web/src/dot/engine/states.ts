import type { SpringParams } from "@localdot/stage";

export type DotState =
  | "offline"
  | "sleeping"
  | "waking"
  | "reconnecting"
  | "idle"
  | "listening"
  | "thinking"
  | "acting"
  | "observing"
  | "watching"
  | "speaking"
  | "waiting"
  | "your-turn"
  | "resting"
  | "dozing"
  | "error"
  | "annoyed";

export type Reaction = "success" | "error" | "acknowledged" | "live" | "dispatch";

// Levels of detail by CSS size; see render/lod.ts.
export type Lod = "glyph" | "badge" | "presence" | "glance" | "hero";

// Lids are fractions of the eye's height. Tilt is in degrees: positive lowers the inner corner
// (annoyed), negative the outer corner (worried). Body offsets are in frame units.
export interface Pose {
  upL: number;
  upR: number;
  lo: number;
  loArch: number;
  tiltL: number;
  tiltR: number;
  eyeScale: number;
  happy: number;
  closed: number;
  eyeOpacity: number;
  bodyX: number;
  bodyY: number;
  size: number;
  dim: number;
  breath: number;
  roll: number;
}

export const BASE_POSE: Pose = {
  upL: 0,
  upR: 0,
  lo: 0,
  loArch: 0,
  tiltL: 0,
  tiltR: 0,
  eyeScale: 1,
  happy: 0,
  closed: 0,
  eyeOpacity: 1,
  bodyX: 0,
  bodyY: 0,
  size: 1,
  dim: 0,
  breath: 1,
  roll: 0,
};

export const POSE_KEYS = Object.keys(BASE_POSE) as (keyof Pose)[];

export interface StateDef {
  pose: Partial<Pose>;
  // Blink rate relative to the resting rate; 0 never blinks on its own.
  blink: number;
  // Stretches each blink's timing.
  blinkDur?: number;
  // Breath period, ms.
  period: number;
}

export const STATES: Record<DotState, StateDef> = {
  offline: { pose: { eyeOpacity: 0.45, dim: 1, breath: 0 }, blink: 0, period: 4000 },
  sleeping: { pose: { closed: 1, bodyY: 1.5, dim: 0.22, breath: 1.6 }, blink: 0, period: 6500 },
  waking: { pose: { upL: 0.5, upR: 0.5, dim: 0.08 }, blink: 0.45, period: 4300 },
  reconnecting: { pose: { upL: 0.42, upR: 0.42, dim: 0.08 }, blink: 0.5, period: 4300 },
  idle: { pose: {}, blink: 1, period: 4000 },
  listening: { pose: { eyeScale: 1.08, bodyX: -1 }, blink: 1 / 0.75, period: 3800 },
  thinking: {
    pose: { upL: 0.1, upR: 0.1, roll: -3 },
    blink: 1 / 1.4,
    blinkDur: 1.15,
    period: 4600,
  },
  acting: {
    pose: { upL: 0.18, upR: 0.18, lo: 0.02, bodyX: 1, breath: 0.6 },
    blink: 0,
    period: 4000,
  },
  observing: { pose: { upL: 0.06, upR: 0.06, breath: 0.25 }, blink: 0, period: 4000 },
  // Waiting on the computer (a page load, a save): a patient gaze at the work and slow blinks.
  watching: {
    pose: { upL: 0.14, upR: 0.14, breath: 0.8 },
    blink: 0.8,
    blinkDur: 1.1,
    period: 4600,
  },
  speaking: { pose: {}, blink: 0, period: 3600 },
  waiting: { pose: { eyeScale: 1.15, bodyY: -1 }, blink: 1, period: 3800 },
  "your-turn": { pose: { upL: 0.08, upR: 0.08, bodyX: -1, breath: 0.9 }, blink: 1, period: 4200 },
  resting: { pose: { upL: 0.35, upR: 0.35 }, blink: 1 / 1.6, blinkDur: 1.2, period: 5000 },
  // Long idle while the computer is on: heavy lids, never closed, because closed means off.
  dozing: {
    pose: { upL: 0.55, upR: 0.55, bodyY: 0.8, breath: 1.3 },
    blink: 1 / 2.4,
    blinkDur: 1.5,
    period: 6200,
  },
  error: {
    pose: { upL: 0.2, upR: 0.2, tiltL: -14, tiltR: -14, bodyY: 1, size: 0.97 },
    blink: 0.8,
    period: 4400,
  },
  annoyed: { pose: { upL: 0.35, upR: 0.35, tiltL: 12, tiltR: 12 }, blink: 0.8, period: 4200 },
};

export const STATE_NAMES = Object.keys(STATES) as DotState[];

// States in which dot is not awake. Waking from any but offline plays the "live" reaction.
export const ASLEEP: ReadonlySet<DotState> = new Set([
  "offline",
  "sleeping",
  "waking",
  "reconnecting",
]);
// States that hold their gaze without microsaccades.
export const STILL_EYES: ReadonlySet<DotState> = new Set([
  "offline",
  "sleeping",
  "observing",
  "acting",
]);

// Each state holds at least this long; a faster change waits instead of flickering.
export const STATE_HOLD_MS = 250;
// Success celebrates at most once per this long.
export const SUCCESS_GAP_MS = 5000;

// Levels that animate the body (breath, squash, lift, shake) and add microsaccades.
export const RICH_LODS: ReadonlySet<Lod> = new Set(["presence", "glance", "hero"]);
// Squash and stretch cap; at 12% the body reads as an egg.
export const SQUASH_CAP: Record<Lod, number> = {
  glyph: 0.05,
  badge: 0.05,
  presence: 0.05,
  glance: 0.07,
  hero: 0.08,
};

export const spring = (dampingRatio: number, response: number): SpringParams => ({
  dampingRatio,
  response,
});

export const SPRINGS = {
  pose: spring(1, 0.28),
  body: spring(1, 0.35),
  saccade: spring(1, 0.08),
  drift: spring(1, 0.45),
  pursuit: spring(1, 0.15),
  hop: spring(0.8, 0.3),
  snap: spring(1, 0.07),
  shake: spring(0.35, 0.11),
  // Reduced motion keeps short critically damped morphs in place of every other spring.
  reduced: spring(1, 0.24),
} as const;
