import type { BrowserOrchestrator } from "../cells/browser-orchestrator.ts";
import type { CellApi } from "../cells/orchestrator.ts";

const RETRY_MS = [2000, 5000, 15_000, 30_000, 60_000] as const;
export const WARM_SWEEP_MS = 15_000;

// A running browser that doesn't answer this many sweeps in a row is started again.
export const SILENT_SWEEPS = 2;

export interface BrowserWarmerDeps {
  cells: Pick<CellApi, "list" | "get" | "subscribe">;
  browser: Pick<
    BrowserOrchestrator,
    "start" | "stop" | "endpoints" | "get" | "subscribe" | "profileHolder" | "health"
  >;
  // The same admission the browser's own start checks, read before trying.
  available(parentCellId: string): boolean;
  // Why a start failed, for the daemon's log.
  report?(message: string): void;
}

// Keeps the web browser running whenever its computer is, so dot and the user find it ready
// with their sign-ins. A failed start is retried with backoff; a running browser that stops
// answering is started again; a computer whose browser lost the saved sign-ins to another
// computer's browser is left alone until they are free again.
export class BrowserWarmer {
  readonly #failures = new Map<string, number>();
  readonly #silent = new Map<string, number>();
  readonly #checking = new Set<string>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #starting = new Set<string>();
  readonly #unsubscribe: (() => void)[];
  readonly #sweep: ReturnType<typeof setInterval>;
  #disposed = false;

  constructor(private readonly deps: BrowserWarmerDeps) {
    this.#unsubscribe = [
      deps.cells.subscribe((cell) => this.#consider(cell.id)),
      deps.browser.subscribe((parent) => this.#consider(parent)),
    ];
    this.#sweep = setInterval(() => this.#considerAll(), WARM_SWEEP_MS);
    this.#sweep.unref?.();
    this.#considerAll();
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#sweep);
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
  }

  #considerAll(): void {
    for (const cell of this.deps.cells.list()) {
      this.#consider(cell.id);
      this.#check(cell.id);
    }
  }

  #check(parent: string): void {
    if (this.#disposed || this.#checking.has(parent) || !this.deps.browser.endpoints(parent)) {
      if (!this.#checking.has(parent)) this.#silent.delete(parent);
      return;
    }
    this.#checking.add(parent);
    void this.deps.browser
      .health(parent)
      .then(async (answer) => {
        if (this.#disposed || answer === undefined || answer === "ready") {
          this.#silent.delete(parent);
          return;
        }
        const silent = (this.#silent.get(parent) ?? 0) + 1;
        this.#silent.set(parent, silent);
        if (answer === "silent" && silent < SILENT_SWEEPS) return;
        this.#silent.delete(parent);
        this.deps.report?.(
          answer === "silent"
            ? "the web browser stopped answering; starting it again"
            : "the web browser can no longer be controlled; starting it again",
        );
        await this.deps.browser.stop(parent);
      })
      .catch(() => {})
      .finally(() => {
        this.#checking.delete(parent);
        this.#consider(parent);
      });
  }

  #consider(parent: string): void {
    if (this.#disposed || this.#starting.has(parent) || this.#timers.has(parent)) return;
    const cell = this.deps.cells.get(parent);
    if (cell?.state !== "ready" || cell.paused || cell.fenced || cell.replacementPending) {
      this.#failures.delete(parent);
      return;
    }
    if (this.deps.browser.endpoints(parent)) {
      this.#failures.delete(parent);
      return;
    }
    // A computer may restart its own browser only after a stop it could not confirm; while a
    // stop is queued the holder is the computer itself and starting would jump ahead of it.
    const holder = this.deps.browser.profileHolder();
    const ownFailedStop = holder === parent && this.deps.browser.get(parent)?.state === "failed";
    if ((holder !== undefined && !ownFailedStop) || !this.deps.available(parent)) return;
    this.#starting.add(parent);
    void this.deps.browser.start(parent).then(
      () => {
        this.#starting.delete(parent);
        this.#failures.delete(parent);
      },
      (error: unknown) => {
        this.#starting.delete(parent);
        if (this.#disposed) return;
        this.deps.report?.(
          `the web browser couldn't start: ${error instanceof Error ? error.message : "unknown"}`,
        );
        const failures = (this.#failures.get(parent) ?? 0) + 1;
        this.#failures.set(parent, failures);
        const delay = RETRY_MS[Math.min(failures, RETRY_MS.length) - 1] ?? 60_000;
        const timer = setTimeout(() => {
          this.#timers.delete(parent);
          this.#consider(parent);
        }, delay);
        timer.unref?.();
        this.#timers.set(parent, timer);
      },
    );
  }
}
