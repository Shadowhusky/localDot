export interface RecordingUsage {
  commit(bytes: number): boolean;
  exhausted(): boolean;
}

// Both tracks spend one session allowance. A stopped track retains its committed usage;
// opening the other track or querying the same owner cannot reset that allowance.
export class RecordingBudget {
  readonly #bytes = new Map<string, number>();
  #exhausted = false;
  constructor(readonly limit = 8 * 1024 ** 3) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid recording limit");
  }
  get bytes(): number {
    return [...this.#bytes.values()].reduce((total, count) => total + count, 0);
  }
  owner(name: "desktop" | "browser"): RecordingUsage {
    return {
      commit: (bytes) => {
        const previous = this.#bytes.get(name) ?? 0;
        if (!Number.isSafeInteger(bytes) || bytes < previous)
          throw new RangeError("Invalid recording usage");
        this.#bytes.set(name, bytes);
        this.#exhausted ||= this.bytes >= this.limit;
        return this.#exhausted;
      },
      exhausted: () => this.#exhausted,
    };
  }
}
