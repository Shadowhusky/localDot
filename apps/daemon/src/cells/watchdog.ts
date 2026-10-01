export type WatchdogState = "live" | "stalled";

export interface WatchdogOptions {
  pingEveryMs: number;
  stallAfterMs: number;
  ping(): void;
  onChange(state: WatchdogState, lastAt: number): void;
  now?: () => number;
}

export class StallWatchdog {
  #timer: NodeJS.Timeout | undefined;
  #lastAt = 0;
  #state: WatchdogState = "live";
  readonly #opts: WatchdogOptions;
  readonly #now: () => number;

  constructor(opts: WatchdogOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  get lastAt(): number {
    return this.#lastAt;
  }

  start(): void {
    this.#lastAt = this.#now();
    this.#state = "live";
    this.#timer = setInterval(() => this.#tick(), this.#opts.pingEveryMs);
  }

  touch(): void {
    this.#lastAt = this.#now();
    if (this.#state === "stalled") {
      this.#state = "live";
      this.#opts.onChange("live", this.#lastAt);
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #tick(): void {
    this.#opts.ping();
    if (this.#state === "live" && this.#now() - this.#lastAt > this.#opts.stallAfterMs) {
      this.#state = "stalled";
      this.#opts.onChange("stalled", this.#lastAt);
    }
  }
}
