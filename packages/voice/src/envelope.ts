import type { Viseme } from "@localdot/avatar";

export const ENVELOPE_RATE_HZ = 100;
export const ENVELOPE_STEP_MS = 1000 / ENVELOPE_RATE_HZ;
// Speech RMS at which the mouth is fully open (TTS speech measures p50 ≈ 0.15, p90 ≈ 0.2).
export const FULL_SCALE_RMS = 0.2;
export const OPEN_LEVEL = 0.12;
export const CLOSE_LEVEL = 0.06;

export class EnvelopeMeter {
  readonly #hop: number;
  #sum = 0;
  #count = 0;

  constructor(sampleRate: number) {
    this.#hop = Math.round(sampleRate / ENVELOPE_RATE_HZ);
  }

  // Levels for every complete 10 ms hop; a partial hop carries into the next chunk.
  push(samples: Float32Array): number[] {
    const levels: number[] = [];
    for (const s of samples) {
      this.#sum += s * s;
      this.#count++;
      if (this.#count === this.#hop) {
        levels.push(Math.min(1, Math.sqrt(this.#sum / this.#hop) / FULL_SCALE_RMS));
        this.#sum = 0;
        this.#count = 0;
      }
    }
    return levels;
  }
}

// Open on loud hops and close on quiet ones, with a gap between the two so syllables don't flicker.
export function envelopeVisemes(levels: ArrayLike<number>): Viseme[] {
  const out: Viseme[] = [];
  let open = false;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i] ?? 0;
    if (!open && level >= OPEN_LEVEL) {
      open = true;
      out.push({ t: i * ENVELOPE_STEP_MS, shape: "A" });
    } else if (open && level < CLOSE_LEVEL) {
      open = false;
      out.push({ t: i * ENVELOPE_STEP_MS, shape: "rest" });
    }
  }
  return out;
}
