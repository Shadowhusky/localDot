import { describeBrowserFailure } from "../cells/browser-health.ts";
import { BrowserStartCancelled } from "../cells/browser-ledger.ts";
import type { BrowserOrchestrator } from "../cells/browser-orchestrator.ts";
import type { CellApi } from "../cells/orchestrator.ts";

// After each failed start, the wait before the next; one failure more and it is given up.
export const RETRY_MS = [2000, 5000, 15_000, 30_000, 60_000] as const;
export const WARM_SWEEP_MS = 5000;

// A running browser that doesn't answer this many sweeps in a row is started again.
export const SILENT_SWEEPS = 2;
// browserd restarting its Chromium in place is waited for this many sweeps before the whole
// browser is started again.
export const RESTARTING_SWEEPS = 12;

export interface BrowserWarmerDeps {
  cells: Pick<CellApi, "list" | "get" | "subscribe">;
  browser: Pick<
    BrowserOrchestrator,
    "start" | "stop" | "endpoints" | "get" | "subscribe" | "profileHolder" | "health"
  > &
    Partial<
      Pick<
        BrowserOrchestrator,
        "failure" | "noteProblem" | "noteRetry" | "noteOutage" | "supervisor"
      >
    >;
  // The same admission the browser's own start checks, read before trying.
  available(parentCellId: string): boolean;
  // Why a start failed, for the daemon's log.
  report?(message: string): void;
  // A word to the task running on this computer.
  notify?(parentCellId: string, text: string): void;
}

// Keeps the web browser running whenever its computer is, so dot and the user find it ready
// with their sign-ins. A failed start is retried with backoff, a bounded number of times; then it
// is given up and the task told, until the computer, keyd or a restart gives it a fresh chance. A
// running browser that stops answering is started again; a computer whose browser lost the saved
// sign-ins to another computer's browser is left alone until they are free again.
export class BrowserWarmer {
  readonly #failures = new Map<string, number>();
  readonly #firstFailure = new Map<string, number>();
  readonly #silent = new Map<string, number>();
  readonly #restarting = new Map<string, number>();
  // The last failure each running browser recovered from by itself, as already logged.
  readonly #recovered = new Map<string, string>();
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

  // What kept the browsers from starting has changed (keyd is back): each gets a fresh round of
  // attempts, beginning now.
  reset(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#failures.clear();
    this.#firstFailure.clear();
    this.#considerAll();
  }

  #considerAll(): void {
    for (const cell of this.deps.cells.list()) {
      this.#consider(cell.id);
      this.#check(cell.id);
    }
  }

  #check(parent: string): void {
    const probed = this.deps.browser.endpoints(parent);
    if (this.#disposed || this.#checking.has(parent) || !probed) {
      if (!this.#checking.has(parent)) {
        this.#silent.delete(parent);
        this.#restarting.delete(parent);
      }
      return;
    }
    this.#checking.add(parent);
    void this.deps.browser
      .health(parent)
      .then(async (answer) => {
        if (answer !== "restarting") this.#restarting.delete(parent);
        if (this.#disposed || answer === undefined || answer === "ready") {
          this.#silent.delete(parent);
          if (answer === "ready") await this.#recoveredBy(parent, probed.instance);
          return;
        }
        if (answer === "restarting") {
          const waited = (this.#restarting.get(parent) ?? 0) + 1;
          this.#restarting.set(parent, waited);
          if (waited < RESTARTING_SWEEPS) return;
          this.#restarting.delete(parent);
        }
        const silent = (this.#silent.get(parent) ?? 0) + 1;
        this.#silent.set(parent, silent);
        if (answer === "silent" && silent < SILENT_SWEEPS) return;
        this.#silent.delete(parent);
        // Only the browser that was asked is stopped, never one started since.
        if (this.deps.browser.endpoints(parent)?.instance !== probed.instance) return;
        const why = await this.deps.browser.failure?.(parent).catch(() => undefined);
        const what =
          answer === "silent"
            ? "stopped answering"
            : answer === "restarting"
              ? "did not finish restarting"
              : "can no longer be controlled";
        this.deps.browser.noteProblem?.(
          parent,
          `The web browser ${what}${why ? ` (${why})` : ""}; localDot started it again.`,
        );
        this.deps.report?.(`the web browser ${what}; starting it again${why ? `: ${why}` : ""}`);
        this.deps.browser.noteOutage?.(parent);
        await this.deps.browser.stop(parent);
      })
      .catch(() => {})
      .finally(() => {
        this.#checking.delete(parent);
        this.#consider(parent);
      });
  }

  // browserd reloads crashed tabs and restarts its Chromium in place; say so in the daemon's log.
  async #recoveredBy(parent: string, instance: string): Promise<void> {
    const failure = (await this.deps.browser.supervisor?.(parent))?.lastFailure;
    const seen = `${instance} ${failure?.at}`;
    if (!failure || this.#recovered.get(parent) === seen) return;
    this.#recovered.set(parent, seen);
    const what = describeBrowserFailure(failure);
    this.deps.browser.noteProblem?.(parent, `${what}.`);
    this.deps.report?.(`the web browser recovered by itself: ${what}`);
  }

  #consider(parent: string): void {
    if (this.#disposed || this.#starting.has(parent) || this.#timers.has(parent)) return;
    const cell = this.deps.cells.get(parent);
    if (
      cell?.state !== "ready" ||
      cell.paused ||
      cell.fenced ||
      cell.replacementPending ||
      this.deps.browser.endpoints(parent)
    ) {
      this.#failures.delete(parent);
      this.#firstFailure.delete(parent);
      return;
    }
    if ((this.#failures.get(parent) ?? 0) > RETRY_MS.length) return;
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
        this.#firstFailure.delete(parent);
      },
      (error: unknown) => {
        this.#starting.delete(parent);
        if (this.#disposed) return;
        // Whatever took the browser over says so itself, and the next change is considered.
        if (error instanceof BrowserStartCancelled) return;
        this.#failed(parent, error instanceof Error ? error.message : "unknown");
      },
    );
  }

  #failed(parent: string, why: string): void {
    this.deps.browser.noteProblem?.(parent, `The web browser couldn't start: ${why}.`);
    const failures = (this.#failures.get(parent) ?? 0) + 1;
    this.#failures.set(parent, failures);
    const first = this.#firstFailure.get(parent) ?? Date.now();
    this.#firstFailure.set(parent, first);
    const delay = RETRY_MS[failures - 1];
    if (delay === undefined) {
      const minutes = Math.max(1, Math.round((Date.now() - first) / 60_000));
      this.deps.browser.noteRetry?.(parent, undefined);
      this.deps.report?.(
        `the web browser couldn't start: ${why}; gave up after ${failures} attempts`,
      );
      this.deps.notify?.(
        parent,
        `localDot: the web browser could not be started after ${failures} attempts over about ${minutes} minute${minutes === 1 ? "" : "s"} (${why}), and localDot has stopped trying by itself. Its saved sign-ins are kept. Tell the user what you couldn't do in it; they can restart it in Settings → Accounts, or you can try switch_screen with restart: true once.`,
      );
      return;
    }
    this.deps.report?.(`the web browser couldn't start: ${why}`);
    this.deps.browser.noteRetry?.(parent, new Date(Date.now() + delay));
    const timer = setTimeout(() => {
      this.#timers.delete(parent);
      this.#consider(parent);
    }, delay);
    timer.unref?.();
    this.#timers.set(parent, timer);
  }
}
