import { abortable } from "./session.ts";
export interface TransferLease {
  signal: AbortSignal;
  check(): void;
  release(): void;
}
// User transfers remain admitted until the underlying transport settles, not merely until abort.
export class Transfers {
  readonly #active = new Map<string, Set<{ abort: AbortController; settled: Promise<void> }>>();
  #closed = false;
  acquire(cellId: string, signals: AbortSignal[], check: () => void): TransferLease {
    if (this.#closed) throw new Error("file transfers are closed");
    check();
    for (const signal of signals) signal.throwIfAborted();
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, ...signals]);
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry = { abort, settled };
    const current = this.#active.get(cellId) ?? new Set();
    current.add(entry);
    this.#active.set(cellId, current);
    let released = false;
    return {
      signal,
      check: () => {
        signal.throwIfAborted();
        check();
      },
      release: () => {
        if (released) return;
        released = true;
        current.delete(entry);
        if (!current.size) this.#active.delete(cellId);
        finish();
      },
    };
  }
  abortCell(cellId: string): void {
    for (const entry of this.#active.get(cellId) ?? [])
      entry.abort.abort(new Error("the computer changed"));
  }
  async wait(cellId: string, signal?: AbortSignal): Promise<void> {
    while (this.#active.get(cellId)?.size) {
      const pending = Promise.all(
        [...(this.#active.get(cellId) ?? [])].map((entry) => entry.settled),
      );
      if (signal) await abortable(pending, signal);
      else await pending;
    }
    signal?.throwIfAborted();
  }
  async settled(): Promise<void> {
    while (this.#active.size)
      await Promise.all([...this.#active.keys()].map((id) => this.wait(id)));
  }
  close(): void {
    this.#closed = true;
    for (const cell of this.#active.keys()) this.abortCell(cell);
  }
}
