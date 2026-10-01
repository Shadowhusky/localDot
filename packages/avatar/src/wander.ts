import { mulberry32 } from "@localdot/stage";
import type { Point } from "./gaze.ts";

// x and y are a gaze direction (1 is the edge of the reach); the origin looks out at the user.
export interface Look extends Point {
  at: number;
}

const RANGE = { x: 0.6, y: 0.3 };
const MIN_SHIFT = 0.25;
// Never right after a glance, so one look in four overall.
const GLANCE_CHANCE = 1 / 3;
// Its own stream, so looks don't fall in step with the blinks drawn from the same seed.
const STREAM = 0x9e3779b9;

const isGlance = (look: Point) => look.x === 0 && look.y === 0;

export class GazeWander {
  readonly #random: () => number;
  readonly #looks: Look[] = [];
  #horizon = 0;

  constructor(seed: number) {
    this.#random = mulberry32(seed ^ STREAM);
  }

  at(tMs: number): Point {
    this.#extendTo(tMs);
    const look = this.#looks.findLast((l) => l.at <= tMs);
    return look ? { x: look.x, y: look.y } : { x: 0, y: 0 };
  }

  looksUntil(tMs: number): Look[] {
    this.#extendTo(tMs);
    return this.#looks.filter((look) => look.at <= tMs);
  }

  #extendTo(tMs: number): void {
    while (this.#horizon <= tMs) {
      const previous = this.#looks.at(-1);
      const away =
        previous !== undefined && (isGlance(previous) || this.#random() >= GLANCE_CHANCE);
      this.#looks.push({ at: this.#horizon, ...(away ? this.#away(previous) : { x: 0, y: 0 }) });
      this.#horizon += away ? 2000 + this.#random() * 3000 : 1000 + this.#random() * 1000;
    }
  }

  #away(previous: Point): Point {
    const side = this.#random() < 0.5 ? -1 : 1;
    let x = side * (MIN_SHIFT + this.#random() * (RANGE.x - MIN_SHIFT));
    if (Math.abs(x - previous.x) < MIN_SHIFT) x = -x;
    return { x, y: (this.#random() * 2 - 1) * RANGE.y };
  }
}
