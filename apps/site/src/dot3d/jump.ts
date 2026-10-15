// dot changing outfit: it crouches, springs up into a full turn that carries a little past and
// settles back, swaps outfit while facing away, and lands with a squash that rings out. Times are in
// seconds from the start; lift is in body radii; squash flattens when positive.

const TAKEOFF = 0.1;
export const LAND = 0.5;
const HEIGHT = 0.55;
const CROUCH = 0.14;
const STRETCH = 0.12;
// The turn: an underdamped spring that starts as dot leaves the ground.
const SPIN_FROM = 0.08;
const DAMPING = 0.7;
const FREQUENCY = 7;

// How long it takes to settle, and when it faces away.
export const JUMP = 1.2;
export const SWAP = findSwap();

export interface Jump {
  spin: number;
  lift: number;
  squash: number;
  swapped: boolean;
}

function turn(s: number): number {
  const t = s - SPIN_FROM;
  if (t <= 0) return 0;
  const wd = FREQUENCY * Math.sqrt(1 - DAMPING * DAMPING);
  const decay = Math.exp(-DAMPING * FREQUENCY * t);
  const x = 1 - decay * (Math.cos(wd * t) + ((DAMPING * FREQUENCY) / wd) * Math.sin(wd * t));
  return x * Math.PI * 2;
}

function findSwap(): number {
  let lo = SPIN_FROM;
  let hi = LAND;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (turn(mid) < Math.PI) lo = mid;
    else hi = mid;
  }
  return hi;
}

function squash(s: number): number {
  if (s < TAKEOFF) return CROUCH * Math.sin((Math.PI / 2) * (s / TAKEOFF));
  if (s < LAND) {
    const release = Math.min(1, (s - TAKEOFF) / 0.06);
    const eased = release * release * (3 - 2 * release);
    const stretch = -STRETCH * Math.exp(-Math.max(0, s - TAKEOFF - 0.06) / 0.09);
    return CROUCH + (stretch - CROUCH) * eased;
  }
  const d = s - LAND;
  return 0.16 * Math.exp(-d / 0.1) * Math.cos((2 * Math.PI * d) / 0.28);
}

export function spinJump(s: number): Jump {
  if (s < 0) return { spin: 0, lift: 0, squash: 0, swapped: false };
  const u = (s - TAKEOFF) / (LAND - TAKEOFF);
  return {
    spin: turn(s),
    lift: u > 0 && u < 1 ? HEIGHT * 4 * u * (1 - u) : 0,
    squash: s < JUMP ? squash(s) : 0,
    swapped: s >= SWAP,
  };
}

// A spin-jump that starts already turned `from`, as when a new dot comes while the last still
// turns, goes on to the next whole turn at least half a turn ahead, its spring stretched to fit, so
// it lands facing the front. `turn` is spinJump's own, 0 to a full turn.
export function spinFrom(from: number, turn: number): number {
  const whole = Math.PI * 2;
  const to = whole * Math.ceil((from + Math.PI) / whole);
  return from + (to - from) * (turn / whole);
}
