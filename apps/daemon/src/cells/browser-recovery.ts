import type { KeydHealth } from "../keyd/monitor.ts";

type Health = Pick<KeydHealth, "online" | "audit" | "bootId">;

// A recovery that fails while keyd is healthy (Docker slow or away, a browser that would not stop)
// is tried again after these waits, the last one repeating.
const RETRY_MS = [5000, 15_000, 30_000, 60_000] as const;

// A keyd health change that bears on the browser's credentials: keyd went away, came back as a new
// process, or its audit log stopped or started working. The rest of its health, such as the
// hairpin probe whose error text changes every discovery round, must not restart browsers.
export function credentialsChanged(now: KeydHealth, before: KeydHealth): boolean {
  return (
    now.online !== before.online ||
    now.bootId !== before.bootId ||
    (now.audit?.ok === true) !== (before.audit?.ok === true)
  );
}

export interface BrowserRecoveryOptions {
  retryMs?: readonly number[];
  // Browsers may start again: keyd is healthy and every earlier browser is confirmed gone.
  recovered?(): void;
  report?(message: string): void;
}

// Browser admission stays closed until retirement for the latest keyd state is
// confirmed. A late healthy reply cannot undo a newer failure or daemon shutdown.
export class BrowserRecovery {
  #epoch = 0;
  #available = false;
  #recoveredBootId: string | undefined;
  // The latest keyd health heard, which a recovery started without one goes by.
  #health: Health = { online: false };
  #closed = false;
  #closing: Promise<void> | undefined;
  #failure: string | undefined;
  #failures = 0;
  #retry: { timer: ReturnType<typeof setTimeout>; at: number } | undefined;

  constructor(
    private readonly browser: { reconcile(): Promise<void> },
    private readonly options: BrowserRecoveryOptions = {},
  ) {}

  get available(): boolean {
    return this.#available && !this.#closed;
  }

  availableFor(bootId: string): boolean {
    return this.available && this.#recoveredBootId === bootId;
  }

  // While browsers may not start: what the last recovery could not confirm, and when it is tried
  // again by itself.
  get pending(): { failure?: string; retryAt?: Date } {
    return {
      ...(this.#failure ? { failure: this.#failure } : {}),
      ...(this.#retry ? { retryAt: new Date(this.#retry.at) } : {}),
    };
  }

  recover(health?: Health): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (health)
      this.#health = { ...health, ...(health.audit ? { audit: { ...health.audit } } : {}) };
    return this.#recover(this.#health);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#cancelRetry();
    this.#closing = this.#recover({ online: false });
    return this.#closing;
  }

  async #recover(health: Health): Promise<void> {
    const epoch = ++this.#epoch;
    this.#cancelRetry();
    this.#available = false;
    this.#recoveredBootId = undefined;
    // Capture the decision before awaiting any external work.
    const healthy = health.online && health.audit?.ok === true;
    const bootId = health.bootId;
    try {
      await this.browser.reconcile();
    } catch (error) {
      if (epoch === this.#epoch && !this.#closed) {
        this.#failure = error instanceof Error ? error.message : "unknown";
        // keyd coming back recovers an unhealthy one.
        if (healthy) this.#schedule(epoch);
      }
      throw error;
    }
    if (epoch === this.#epoch && !this.#closed) {
      if (this.#failure && healthy)
        this.options.report?.("browser recovery completed; the web browser may start again");
      this.#failure = undefined;
      this.#failures = 0;
      this.#available = healthy;
      this.#recoveredBootId = healthy ? bootId : undefined;
      if (healthy) this.options.recovered?.();
    }
  }

  #schedule(epoch: number): void {
    const delays = this.options.retryMs ?? RETRY_MS;
    const delay = delays[Math.min(this.#failures, delays.length - 1)] ?? 60_000;
    if (this.#failures === 0)
      this.options.report?.(
        `browser recovery could not complete (${this.#failure}); trying again by itself`,
      );
    this.#failures++;
    const timer = setTimeout(() => {
      this.#retry = undefined;
      if (epoch === this.#epoch && !this.#closed) void this.#recover(this.#health).catch(() => {});
    }, delay);
    timer.unref?.();
    this.#retry = { timer, at: Date.now() + delay };
  }

  #cancelRetry(): void {
    if (this.#retry) clearTimeout(this.#retry.timer);
    this.#retry = undefined;
  }
}
