import { msToMicros } from "@localdot/protocol";

export interface ClockSample {
  offsetMicros: number;
  rttMicros: number;
  at: number;
}

// desktopd's CLOCK_MONOTONIC (ms) against the daemon's event clock (µs): the lowest-RTT ping of a
// burst gives the offset within about half its RTT; S6 saw the two drift up to 1 ms in 20–45 s, so
// the burst repeats every 20 s (spec "Clock").
export class ClockMap {
  #sample: ClockSample | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ping: () => Promise<number>,
    private readonly now: () => number,
  ) {}

  get sample(): ClockSample | undefined {
    return this.#sample;
  }

  async sync(samples = 10): Promise<ClockSample> {
    let best: ClockSample | undefined;
    for (let i = 0; i < samples; i++) {
      const sent = this.now();
      const mono = await this.ping();
      const got = this.now();
      const rttMicros = got - sent;
      const candidate = { offsetMicros: msToMicros(mono) - (sent + got) / 2, rttMicros, at: got };
      if (!best || candidate.rttMicros < best.rttMicros) best = candidate;
    }
    this.#sample = best as ClockSample;
    return this.#sample;
  }

  toDaemonMicros(mono: number): number {
    if (!this.#sample) throw new Error("clock map not synced");
    return Math.round(msToMicros(mono) - this.#sample.offsetMicros);
  }

  // A failed burst keeps the last sample (the clocks drift about 1 ms in 20–45 s) and says so.
  start(everyMs = 20_000): void {
    this.stop();
    this.#timer = setInterval(() => {
      this.sync().catch((err) => {
        console.error(
          `desktopd clock sync failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, everyMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
