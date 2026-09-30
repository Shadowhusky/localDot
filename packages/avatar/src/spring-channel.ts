import { type SpringParams, springValue } from "@localdot/stage";

// Small enough that retargeting every frame carries no measurable velocity bias.
const DERIVATIVE_STEP_MS = 0.001;

export class SpringChannel {
  #from: number;
  #to: number;
  #velocity = 0;
  #startMs: number;
  readonly #params: SpringParams;

  constructor(initial: number, params: SpringParams, startMs = 0) {
    this.#from = initial;
    this.#to = initial;
    this.#startMs = startMs;
    this.#params = params;
  }

  get target(): number {
    return this.#to;
  }

  value(tMs: number): number {
    const tSeconds = Math.max(0, tMs - this.#startMs) / 1000;
    return springValue(this.#from, this.#to, this.#velocity, tSeconds, this.#params);
  }

  // Units per second (forward difference).
  velocity(tMs: number): number {
    return ((this.value(tMs + DERIVATIVE_STEP_MS) - this.value(tMs)) * 1000) / DERIVATIVE_STEP_MS;
  }

  retarget(to: number, tMs: number): void {
    if (!Number.isFinite(to) || to === this.#to) return;
    const value = this.value(tMs);
    const velocity = this.velocity(tMs);
    this.#from = value;
    this.#velocity = velocity;
    this.#to = to;
    this.#startMs = tMs;
  }
}
