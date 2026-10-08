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

export class BrowserNavigation {
  readonly #control: Pick<BrowserControl, "admit">;
  readonly #targets: Pick<BrowserTargets, "navigate">;
  readonly #lifetime = new AbortController();
  #active?: Promise<void>;

  constructor(control: Pick<BrowserControl, "admit">, targets: Pick<BrowserTargets, "navigate">) {
    this.#control = control;
    this.#targets = targets;
  }

  close(): Promise<void> {
    this.#lifetime.abort();
    return this.#active ?? Promise.resolve();
  }

  async navigate(
    permit: unknown,
    tabId: string,
    url: string,
    signal: AbortSignal,
  ): Promise<{ done: true }> {
    if (this.#lifetime.signal.aborted) throw new BrowserNavigationError("closed");
    if (this.#active) throw new BrowserNavigationError("busy");
    if (typeof tabId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(tabId) || !navigable(url))
      throw new BrowserNavigationError("request");
    const completion = Promise.withResolvers<void>();
    this.#active = completion.promise;
    let lease: BrowserActionLease | undefined;
    try {
      signal.throwIfAborted();
      lease = this.#control.admit(permitData(permit));
      const combined = AbortSignal.any([signal, lease.signal, this.#lifetime.signal]);
      combined.throwIfAborted();
      lease.check();
      await this.#targets.navigate(tabId, url, combined);
      combined.throwIfAborted();
      lease.check();
      return { done: true };
    } catch {
      throw new BrowserNavigationError("refused");
    } finally {
      try {
        lease?.finish();
      } finally {
        this.#active = undefined;
        completion.resolve();
      }
    }
  }
}
