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

export function swayAt(tMs: number, seed: number): { x: number; y: number } {
  const random = mulberry32(seed);
  const f1 = 0.11 + random() * 0.05;
  const f2 = 0.07 + random() * 0.04;
  const phases = [random(), random(), random(), random()].map((r) => r * 2 * Math.PI);
  const t = tMs / 1000;
  const tau = 2 * Math.PI;
  return {
    x:
      0.025 * Math.sin(tau * f1 * t + (phases[0] as number)) +
      0.015 * Math.sin(tau * f2 * t + (phases[1] as number)),
    y:
      0.015 * Math.sin(tau * f2 * 1.3 * t + (phases[2] as number)) +
      0.01 * Math.sin(tau * f1 * 0.7 * t + (phases[3] as number)),
  };
}
