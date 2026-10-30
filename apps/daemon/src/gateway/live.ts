import { ComputerLease } from "./computer-lease.ts";

export interface LiveHooks {
  beforeRun?(cellId: string, sessionId: string): Promise<void>;
  afterRun?(cellId: string, sessionId: string): Promise<void>;
}
// Keep the settlement promise so Stop can drain work before freezing desktopd. A computer runs
// several tasks at once; its lease admits one action at a time.
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
    if (this.busy(cellId) || this.#idleOperations.has(cellId)) return undefined;
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
  readonly #bySession = new Map<
    string,
    { cellId: string; controller: AbortController; done: Promise<void>; since: number }
  >();
  readonly #leases = new Map<string, ComputerLease>();
  // The task each computer's web browser works for: it has one signed-in profile and one holder.
  readonly #browsers = new Map<string, string>();
  #starts = 0;

  claimBrowser(cellId: string, sessionId: string): boolean {
    const holder = this.browserHolder(cellId);
    if (holder && holder !== sessionId) return false;
    this.#browsers.set(cellId, sessionId);
    return true;
  }
  browserHolder(cellId: string): string | undefined {
    const holder = this.#browsers.get(cellId);
    return holder && this.#bySession.get(holder)?.cellId === cellId ? holder : undefined;
  }
  releaseBrowser(cellId: string, sessionId: string): void {
    if (this.#browsers.get(cellId) === sessionId) this.#browsers.delete(cellId);
  }

  lease(cellId: string): ComputerLease {
    const existing = this.#leases.get(cellId);
    if (existing) return existing;
    const created = new ComputerLease();
    this.#leases.set(cellId, created);
    return created;
  }

  start(
    cellId: string,
    sessionId: string,
    run: (signal: AbortSignal) => Promise<unknown>,
    prepare?: (signal: AbortSignal) => Promise<void>,
  ): void {
    if (this.#idleOperations.has(cellId)) throw new Error("computer operation is still settling");
    if (this.#aliases.has(cellId)) throw new Error("this computer already has a live task");
    if (this.cellOf(sessionId)) throw new Error("session is already live");
    const controller = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry = { cellId, controller, done, since: ++this.#starts };
    // Register before invoking the callback, even if it throws or calls Stop
    // synchronously. The callback can subscribe to abort before start returns.
    this.#bySession.set(sessionId, entry);
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
        if (this.#bySession.get(sessionId) === entry) this.#bySession.delete(sessionId);
        for (const [alias, id] of this.#aliases) if (id === sessionId) this.#aliases.delete(alias);
        this.#leases.get(cellId)?.revoke(sessionId);
        this.releaseBrowser(cellId, sessionId);
        settle();
      });
  }

  // The task a computer's doings are put down to: the one acting on it, else the one that acted
  // last, else its newest. A brain's own computer is its task's.
  get(cellId: string): string | undefined {
    const alias = this.#aliases.get(cellId);
    if (alias) return alias;
    const on = this.sessionsOn(cellId);
    const lease = this.#leases.get(cellId);
    const last = lease?.last;
    if (last && on.includes(last)) return last;
    return on.at(-1);
  }

  // The computer's live tasks, oldest first.
  sessionsOn(cellId: string): string[] {
    return [...this.#bySession]
      .filter(([, live]) => live.cellId === cellId)
      .sort(([, a], [, b]) => a.since - b.since)
      .map(([sessionId]) => sessionId);
  }

  busy(cellId: string): boolean {
    return this.sessionsOn(cellId).length > 0 || this.#aliases.has(cellId);
  }

  alias(cellId: string, sessionId: string): void {
    if (!this.cellOf(sessionId)) throw new Error("session is not live");
    if (this.#idleOperations.has(cellId)) throw new Error("computer operation is still settling");
    if (this.busy(cellId)) throw new Error("this computer is already assigned");
    this.#aliases.set(cellId, sessionId);
  }

  unalias(cellId: string, sessionId: string): void {
    if (this.#aliases.get(cellId) === sessionId) this.#aliases.delete(cellId);
  }

  cellOf(sessionId: string): string | undefined {
    return this.#bySession.get(sessionId)?.cellId;
  }

  stop(sessionId: string): boolean {
    const live = this.#bySession.get(sessionId);
    if (!live) return false;
    live.controller.abort();
    return true;
  }

  settled(sessionId: string): Promise<void> {
    return this.#bySession.get(sessionId)?.done ?? Promise.resolve();
  }
}
