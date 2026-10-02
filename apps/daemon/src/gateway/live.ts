// Keep the settlement promise so Stop can drain work before freezing desktopd.
export class LiveSessions {
  readonly #byCell = new Map<
    string,
    { sessionId: string; controller: AbortController; done: Promise<void> }
  >();

  start(cellId: string, sessionId: string, run: (signal: AbortSignal) => Promise<unknown>): void {
    if (this.#byCell.has(cellId)) throw new Error(`cell ${cellId} already has a live session`);
    if (this.cellOf(sessionId)) throw new Error("session is already live");
    const controller = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry = { sessionId, controller, done };
    // Register before invoking the callback, even if it throws or calls Stop
    // synchronously. The callback can subscribe to abort before start returns.
    this.#byCell.set(cellId, entry);
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(run(controller.signal));
    } catch (err) {
      pending = Promise.reject(err);
    }
    void pending
      .catch(() => {
        // Exceptions may quote tool input or credentials. Abort is expected.
        if (!controller.signal.aborted) console.error("a live session failed");
      })
      .finally(() => {
        if (this.#byCell.get(cellId) === entry) this.#byCell.delete(cellId);
        settle();
      });
  }

  get(cellId: string): string | undefined {
    return this.#byCell.get(cellId)?.sessionId;
  }

  cellOf(sessionId: string): string | undefined {
    for (const [cellId, live] of this.#byCell) if (live.sessionId === sessionId) return cellId;
    return undefined;
  }

  stop(sessionId: string): boolean {
    const cellId = this.cellOf(sessionId);
    if (!cellId) return false;
    this.#byCell.get(cellId)?.controller.abort();
    return true;
  }

  settled(sessionId: string): Promise<void> {
    const cellId = this.cellOf(sessionId);
    return (cellId && this.#byCell.get(cellId)?.done) || Promise.resolve();
  }
}
