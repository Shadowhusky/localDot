// One live session per cell; Stop aborts it. M5 extends this into the kill switch.
export class LiveSessions {
  readonly #byCell = new Map<string, { sessionId: string; controller: AbortController }>();

  start(cellId: string, sessionId: string, run: (signal: AbortSignal) => Promise<unknown>): void {
    if (this.#byCell.has(cellId)) throw new Error(`cell ${cellId} already has a live session`);
    const controller = new AbortController();
    this.#byCell.set(cellId, { sessionId, controller });
    Promise.resolve()
      .then(() => run(controller.signal))
      .catch((err) => console.error(`session ${sessionId}: ${String(err)}`))
      .finally(() => {
        if (this.#byCell.get(cellId)?.sessionId === sessionId) this.#byCell.delete(cellId);
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
}
