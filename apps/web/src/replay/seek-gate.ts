export type SeekMode = "exact" | "preview";

// One preview at a time goes to the worker, and only the newest one waits behind it, so a finger
// sweeping the timeline never queues work. An exact seek goes at once and drops the one waiting.
export class SeekGate {
  readonly #send: (tMs: number, mode: SeekMode) => void;
  #busy = false;
  #waiting: number | null = null;

  constructor(send: (tMs: number, mode: SeekMode) => void) {
    this.#send = send;
  }

  seek(tMs: number, mode: SeekMode): void {
    if (mode === "preview" && this.#busy) {
      this.#waiting = tMs;
      return;
    }
    if (mode === "exact") this.#waiting = null;
    this.#busy = true;
    this.#send(tMs, mode);
  }

  settled(): void {
    this.#busy = false;
    const waiting = this.#waiting;
    this.#waiting = null;
    if (waiting !== null) this.seek(waiting, "preview");
  }

  reset(): void {
    this.#busy = false;
    this.#waiting = null;
  }
}
