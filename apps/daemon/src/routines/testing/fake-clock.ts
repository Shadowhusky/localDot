interface Timer {
  at: number;
  fn: () => void;
  every?: number;
}

/** A wall clock and a monotonic clock that tests move by hand. `sleep` moves only the wall clock,
 * the way a Mac asleep does; `advance` moves both and fires due timers in order.
 */
export class FakeClock {
  wall: number;
  monoNow = 0;
  readonly #timers = new Map<number, Timer>();
  #seq = 0;
  constructor(startIso: string) {
    this.wall = Date.parse(startIso);
  }
  now = (): number => this.wall;
  mono = (): number => this.monoNow;
  setTimeout = (fn: () => void, ms: number): (() => void) => {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.monoNow + Math.max(0, ms), fn });
    return () => {
      this.#timers.delete(id);
    };
  };
  setInterval = (fn: () => void, ms: number): (() => void) => {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.monoNow + ms, fn, every: ms });
    return () => {
      this.#timers.delete(id);
    };
  };
  advance(ms: number): void {
    const end = this.monoNow + ms;
    for (;;) {
      let nextId: number | undefined;
      let next: Timer | undefined;
      for (const [id, timer] of this.#timers)
        if (timer.at <= end && (!next || timer.at < next.at)) {
          nextId = id;
          next = timer;
        }
      if (!next || nextId === undefined) break;
      this.wall += next.at - this.monoNow;
      this.monoNow = next.at;
      if (next.every) next.at += next.every;
      else this.#timers.delete(nextId);
      next.fn();
    }
    this.wall += end - this.monoNow;
    this.monoNow = end;
  }
  sleep(ms: number): void {
    this.wall += ms;
  }
  // The user or the OS moved the clock: only the wall clock jumps.
  setWall(iso: string): void {
    this.wall = Date.parse(iso);
  }
  async flush(): Promise<void> {
    for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
