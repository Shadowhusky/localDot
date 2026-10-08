export interface LiveHooks {
  beforeRun?(cellId: string, sessionId: string): Promise<void>;
  afterRun?(cellId: string, sessionId: string): Promise<void>;
}
// Keep the settlement promise so Stop can drain work before freezing desktopd.
export class LiveSessions {
  readonly #hooks = new Set<LiveHooks>();
  addHooks(hooks: LiveHooks): () => void {
    this.#hooks.add(hooks);
    return () => {
      this.#hooks.delete(hooks);
    };
  }
  async #callHook(hook: (() => Promise<void>) | undefined): Promise<void> {
    try {
      await hook?.();
    } catch {
      console.error("a recording lifecycle hook failed");
    }
  }

  readonly #aliases = new Map<string, string>();
  readonly #idleOperations = new Map<string, object>();

  // Hold idle native mutation admission through its actual completion. Cancelling a caller
  // cannot release it: the desktop operation must finish before any new task can own the cell.
  admitIdleOperation(cellId: string): { release(): void } | undefined {
    if (this.get(cellId) || this.#idleOperations.has(cellId)) return undefined;
    const owner = {};
    this.#idleOperations.set(cellId, owner);
    return {
      release: () => {
        if (this.#idleOperations.get(cellId) === owner) this.#idleOperations.delete(cellId);
      },
    };
  }

  idleOperationPending(cellId: string): boolean {
    return this.#idleOperations.has(cellId);
  }
  readonly #byCell = new Map<
    string,
    { sessionId: string; controller: AbortController; done: Promise<void> }
  >();

  start(
    cellId: string,
    sessionId: string,
    run: (signal: AbortSignal) => Promise<unknown>,
    prepare?: (signal: AbortSignal) => Promise<void>,
  ): void {
    if (this.#idleOperations.has(cellId)) throw new Error("computer operation is still settling");
    if (this.#byCell.has(cellId) || this.#aliases.has(cellId))
      throw new Error(`cell ${cellId} already has a live session`);
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
    const hooks = [...this.#hooks];
    let pending: Promise<unknown>;
    if (hooks.length || prepare) {
      pending = (async () => {
        // Preparation owns the cell before recording starts. A prepared caller must also
        // receive an aborted run so it can finalize its session if preparation/Stop fails.
        if (prepare) {
          try {
            await prepare(controller.signal);
          } catch (error) {
            controller.abort(error);
          }
        }
        let hooksStarted = false;
        try {
          if (!controller.signal.aborted) {
            hooksStarted = true;
            for (const hook of hooks)
              await this.#callHook(
                hook.beforeRun
                  ? () => hook.beforeRun?.(cellId, sessionId) ?? Promise.resolve()
                  : undefined,
              );
          }
          if (!controller.signal.aborted || prepare) await run(controller.signal);
        } finally {
          if (hooksStarted)
            for (const hook of hooks)
              await this.#callHook(
                hook.afterRun
                  ? () => hook.afterRun?.(cellId, sessionId) ?? Promise.resolve()
                  : undefined,
              );
        }
      })();
    } else {
      // Preserve synchronous callback admission when no lifecycle hook is installed.
      try {
        pending = Promise.resolve(run(controller.signal));
      } catch (err) {
        pending = Promise.reject(err);
      }
    }
    void pending
      .catch(() => {
        // Exceptions may quote tool input or credentials. Abort is expected.
        if (!controller.signal.aborted) console.error("a live session failed");
      })
      .finally(() => {
        if (this.#byCell.get(cellId) === entry) this.#byCell.delete(cellId);
        for (const [alias, id] of this.#aliases) if (id === sessionId) this.#aliases.delete(alias);
        settle();
      });
  }

  get(cellId: string): string | undefined {
    return this.#byCell.get(cellId)?.sessionId ?? this.#aliases.get(cellId);
  }

  alias(cellId: string, sessionId: string): void {
    if (!this.cellOf(sessionId)) throw new Error("session is not live");
    if (this.#idleOperations.has(cellId)) throw new Error("computer operation is still settling");
    if (this.#byCell.has(cellId) || this.#aliases.has(cellId))
      throw new Error("cell identity is already assigned");
    this.#aliases.set(cellId, sessionId);
  }

  unalias(cellId: string, sessionId: string): void {
    if (this.#aliases.get(cellId) === sessionId) this.#aliases.delete(cellId);
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
