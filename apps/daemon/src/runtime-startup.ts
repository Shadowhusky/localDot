import { setTimeout as sleep } from "node:timers/promises";

export type RuntimeState = "waiting" | "recovering" | "ready" | "failed";
/** Wait outside recovery: missing Docker must not mutate persistent computer/fence records.
 * Recovery executes once, so key/agent subscriptions cannot be duplicated by a retry loop. */
export class RuntimeStartup {
  state: RuntimeState = "waiting";
  constructor(private readonly check: () => Promise<void>) {}
  async run(
    recover: () => Promise<void>,
    options: {
      signal: AbortSignal;
      launch?: () => Promise<unknown>;
      pause?: () => Promise<void>;
    },
  ): Promise<void> {
    let attemptedLaunch = false;
    for (;;) {
      options.signal.throwIfAborted();
      try {
        await this.check();
        break;
      } catch {
        /* Engine not ready yet. */
      }
      options.signal.throwIfAborted();
      if (!attemptedLaunch) {
        attemptedLaunch = true;
        await options.launch?.();
      }
      await (options.pause?.() ?? sleep(5000, undefined, { signal: options.signal }));
    }
    options.signal.throwIfAborted();
    this.state = "recovering";
    try {
      await recover();
      this.state = "ready";
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }
  async snapshot(): Promise<{ docker: "ready" | "unavailable"; startup: RuntimeState }> {
    try {
      await this.check();
      return { docker: "ready", startup: this.state };
    } catch {
      return { docker: "unavailable", startup: this.state };
    }
  }
}
