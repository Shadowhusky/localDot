import { types } from "node:util";
import { navigable } from "./cdp-guard.ts";
import type { BrowserActionLease, BrowserControl } from "./control.ts";
import type { BrowserTargets } from "./targets.ts";

export class BrowserNavigationError extends Error {
  constructor(readonly reason: "request" | "closed" | "busy" | "refused") {
    super(`Browser navigation refused: ${reason}`);
  }
}

function permitData(raw: unknown, depth = 0): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || depth > 1)
    throw new BrowserNavigationError("request");
  const prototype = Object.getPrototypeOf(raw);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(raw).length
  )
    throw new BrowserNavigationError("request");
  const names = Object.getOwnPropertyNames(raw);
  if (names.length > 6) throw new BrowserNavigationError("request");
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    if (
      name.length > 32 ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      throw new BrowserNavigationError("request");
    const value: unknown = descriptor.value;
    if (
      (typeof value === "string" && value.length <= 128) ||
      (typeof value === "number" && Number.isSafeInteger(value))
    )
      result[name] = value;
    else result[name] = permitData(value, depth + 1);
  }
  return result;
}

// One navigation at a time in each tab; tabs of different tasks load side by side, on no one's turn.
export class BrowserNavigation {
  readonly #control: Pick<BrowserControl, "admit">;
  readonly #targets: Pick<BrowserTargets, "navigate" | "openTab">;
  // A tab of the task's own window, where its new tabs open.
  readonly #anchor: (sessionId: string) => string | undefined;
  readonly #lifetime = new AbortController();
  readonly #active = new Map<string, Promise<void>>();

  constructor(
    control: Pick<BrowserControl, "admit">,
    targets: Pick<BrowserTargets, "navigate" | "openTab">,
    anchor: (sessionId: string) => string | undefined = () => undefined,
  ) {
    this.#control = control;
    this.#targets = targets;
    this.#anchor = anchor;
  }

  async close(): Promise<void> {
    this.#lifetime.abort();
    await Promise.all(this.#active.values());
  }

  async navigate(
    permit: unknown,
    tabId: string,
    url: string,
    signal: AbortSignal,
  ): Promise<{ done: true; download?: true }> {
    if (this.#lifetime.signal.aborted) throw new BrowserNavigationError("closed");
    if (this.#active.has(tabId)) throw new BrowserNavigationError("busy");
    if (typeof tabId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(tabId) || !navigable(url))
      throw new BrowserNavigationError("request");
    const outcome = await this.#admitted(tabId, permit, signal, tabId, (combined) =>
      this.#targets.navigate(tabId, url, combined),
    );
    return { done: true, ...(outcome === "download" ? { download: true as const } : {}) };
  }

  async openTab(permit: unknown, signal: AbortSignal): Promise<{ tabId: string }> {
    if (this.#lifetime.signal.aborted) throw new BrowserNavigationError("closed");
    const slot = "new tab";
    if (this.#active.has(slot)) throw new BrowserNavigationError("busy");
    return {
      tabId: await this.#admitted(slot, permit, signal, undefined, (combined, sessionId) =>
        this.#targets.openTab(combined, this.#anchor(sessionId)),
      ),
    };
  }

  async #admitted<T>(
    slot: string,
    permit: unknown,
    signal: AbortSignal,
    tabId: string | undefined,
    work: (signal: AbortSignal, sessionId: string) => Promise<T>,
  ): Promise<T> {
    const completion = Promise.withResolvers<void>();
    this.#active.set(slot, completion.promise);
    let lease: BrowserActionLease | undefined;
    try {
      signal.throwIfAborted();
      const data = permitData(permit);
      lease = this.#control.admit(data, tabId);
      const combined = AbortSignal.any([signal, lease.signal, this.#lifetime.signal]);
      combined.throwIfAborted();
      lease.check();
      const owner = data.owner as { sessionId: string };
      const result = await work(combined, owner.sessionId);
      combined.throwIfAborted();
      lease.check();
      return result;
    } catch {
      throw new BrowserNavigationError("refused");
    } finally {
      try {
        lease?.finish();
      } finally {
        this.#active.delete(slot);
        completion.resolve();
      }
    }
  }
}
