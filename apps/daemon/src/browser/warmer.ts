import type { BrowserOrchestrator } from "../cells/browser-orchestrator.ts";
import type { CellApi } from "../cells/orchestrator.ts";

const RETRY_MS = [2000, 5000, 15_000, 30_000, 60_000] as const;
export const WARM_SWEEP_MS = 15_000;

export interface BrowserWarmerDeps {
  cells: Pick<CellApi, "list" | "get" | "subscribe">;
  browser: Pick<BrowserOrchestrator, "start" | "endpoints" | "get" | "subscribe" | "profileHolder">;
  // The same admission the browser's own start checks, read before trying.
  available(parentCellId: string): boolean;
}

// Keeps the web browser running whenever its computer is, so dot and the user find it ready
// with their sign-ins. A failed start is retried with backoff; a computer whose browser lost the
// saved sign-ins to another computer's browser is left alone until they are free again.
export class BrowserWarmer {
  readonly #failures = new Map<string, number>();
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
    for (const cell of this.deps.cells.list()) this.#consider(cell.id);
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
    const holder = this.deps.browser.profileHolder();
    if (holder !== undefined || !this.deps.available(parent)) return;
    this.#starting.add(parent);
    void this.deps.browser.start(parent).then(
      () => {
        this.#starting.delete(parent);
        this.#failures.delete(parent);
      },
      () => {
        this.#starting.delete(parent);
        if (this.#disposed) return;
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
