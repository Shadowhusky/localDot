import { mulberry32 } from "@localdot/stage";

export const BREATH_PERIOD_MS = 4000;

export function breathAt(tMs: number, periodMs = BREATH_PERIOD_MS): number {
  return (1 - Math.cos((2 * Math.PI * tMs) / periodMs)) / 2;
}

const CLOSE_MS = 60;
const HOLD_MS = 40;
const OPEN_MS = 100;
export const BLINK_MS = CLOSE_MS + HOLD_MS + OPEN_MS;
export const DOUBLE_BLINK_GAP_MS = BLINK_MS + 60;
const DOUBLE_BLINK_CHANCE = 0.2;

export class BlinkSchedule {
  readonly #random: () => number;
  readonly #starts: number[] = [];
  #horizon = 0;

  constructor(seed: number) {
    this.#random = mulberry32(seed);
  }

  closure(tMs: number): number {
    if (!(tMs >= 0)) return 0;
    this.#extendTo(tMs);
    const start = this.#latestAtOrBefore(tMs);
    if (start === undefined) return 0;
    const dt = tMs - start;
    if (dt < CLOSE_MS) return dt / CLOSE_MS;
    if (dt < CLOSE_MS + HOLD_MS) return 1;
    if (dt < BLINK_MS) return 1 - (dt - CLOSE_MS - HOLD_MS) / OPEN_MS;
    return 0;
  }

  startsUntil(tMs: number): number[] {
    this.#extendTo(tMs);
    return this.#starts.filter((start) => start <= tMs);
  }

  #extendTo(tMs: number): void {
    while (this.#horizon <= tMs) {
      const next = this.#horizon + 2000 + this.#random() * 4000;
      this.#starts.push(next);
      if (this.#random() < DOUBLE_BLINK_CHANCE) this.#starts.push(next + DOUBLE_BLINK_GAP_MS);
      this.#horizon = this.#starts[this.#starts.length - 1] as number;
    }
  }

  #latestAtOrBefore(tMs: number): number | undefined {
    let lo = 0;
    let hi = this.#starts.length - 1;
    let found: number | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = this.#starts[mid] as number;
      if (start <= tMs) {
        found = start;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }
}

// Head drift (x across, y up) and a body lean. Each is a 6–8 s sine plus a 10–14 s one, far enough
// apart in frequency that the two never cancel for long.
export function swayAt(tMs: number, seed: number): { x: number; y: number; body: number } {
  const random = mulberry32(seed);
  const t = tMs / 1000;
  const wave = (amplitude: number, hz: number) =>
    amplitude * Math.sin(2 * Math.PI * (hz * t + random()));
  const fast = (amplitude: number) => wave(amplitude, 0.13 + random() * 0.04);
  const slow = (amplitude: number) => wave(amplitude, 0.07 + random() * 0.025);
  return {
    x: fast(0.075) + slow(0.045),
    y: slow(0.05) + fast(0.03),
    body: slow(0.075) + fast(0.045),
  };
}
