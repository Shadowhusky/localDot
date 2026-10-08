import type { KeydHealth } from "../keyd/monitor.ts";

type Health = Pick<KeydHealth, "online" | "audit" | "bootId">;

// Browser admission stays closed until retirement for the latest keyd state is
// confirmed. A late healthy reply cannot undo a newer failure or daemon shutdown.
export class BrowserRecovery {
  #epoch = 0;
  #available = false;
  #recoveredBootId: string | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(private readonly browser: { reconcile(): Promise<void> }) {}

  get available(): boolean {
    return this.#available && !this.#closed;
  }

  availableFor(bootId: string): boolean {
    return this.available && this.#recoveredBootId === bootId;
  }

  recover(health: Health = { online: false }): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return this.#recover(health);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#recover({ online: false });
    return this.#closing;
  }

  async #recover(health: Health): Promise<void> {
    const epoch = ++this.#epoch;
    this.#available = false;
    this.#recoveredBootId = undefined;
    // Capture the decision before awaiting any external work.
    const healthy = health.online && health.audit?.ok === true;
    const bootId = health.bootId;
    await this.browser.reconcile();
    if (epoch === this.#epoch && !this.#closed) {
      this.#available = healthy;
      this.#recoveredBootId = healthy ? bootId : undefined;
    }
  }
}
