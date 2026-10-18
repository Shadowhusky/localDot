// Incremental mono resampling. Each input sample contributes its duration to a 16 kHz
// output sample, so 44.1/48 kHz microphones keep the same pitch and recording length.
export class SpeechSamples {
  #weight = 0;
  #sum = 0;
  #block = new Float32Array(2048);
  #used = 0;

  constructor(
    private readonly rate: number,
    private readonly emit: (samples: Float32Array) => void,
  ) {}

  push(input: Float32Array) {
    for (const value of input) {
      let remaining = 16_000;
      while (remaining > 0) {
        const weight = Math.min(this.rate - this.#weight, remaining);
        this.#sum += value * weight;
        this.#weight += weight;
        remaining -= weight;
        if (this.#weight >= this.rate) {
          this.#block[this.#used++] = this.#sum / this.rate;
          this.#sum = this.#weight = 0;
          if (this.#used === this.#block.length) this.flush();
        }
      }
    }
  }

  flush() {
    if (!this.#used) return;
    this.emit(this.#block.slice(0, this.#used));
    this.#used = 0;
  }
}
