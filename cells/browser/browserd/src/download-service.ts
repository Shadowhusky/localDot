import { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import type { BrowserActionLease, BrowserControl } from "./control.ts";
import {
  BrowserDownloadError,
  BrowserDownloadEvents,
  type DownloadOffer,
} from "./download-events.ts";
import { BrowserDownloadSpool } from "./download-spool.ts";
import type { BrowserRuntimeConfig } from "./runtime-config.ts";
import type { BrowserTargets } from "./targets.ts";

type Spool = ConstructorParameters<typeof BrowserDownloadEvents>[0]["spool"];
export interface BrowserDownloadServiceDeps {
  readonly config: BrowserRuntimeConfig;
  readonly instance: string;
  readonly control: Pick<BrowserControl, "admit" | "admitManual">;
  readonly targets: Pick<BrowserTargets, "downloadBehavior" | "cancelDownload">;
  openSpool?(): Promise<Spool>;
  // The task whose window the frame is in.
  attribute?(frameId: string): string | undefined;
  fence(): void;
}

// One collector for the browser, which Chromium's one download directory requires; each download
// goes to the task whose page started it, by that task's own binding.
export class BrowserDownloadService {
  readonly #bindings = new Map<string, BrowserDownloadBinding>();
  #owner?: BrowserDownloadEvents;
  #arming?: Promise<void>;
  #closing?: Promise<void>;
  #closed = false;
  #writersGone = false;

  constructor(private readonly deps: BrowserDownloadServiceDeps) {}

  // The grants downloads are armed for, which a browser restarted in place arms again.
  get bindings(): readonly BrowserDownloadBinding[] {
    return [...this.#bindings.values()];
  }

  owns(guid: string): boolean {
    return this.#owner?.owns(guid) ?? false;
  }
  begin(params: Readonly<Record<string, unknown>>): void {
    if (!this.#owner) {
      this.deps.fence();
      return;
    }
    this.#owner.begin(params);
  }
  progress(params: Readonly<Record<string, unknown>>): void {
    if (!this.#owner) {
      this.deps.fence();
      return;
    }
    this.#owner.progress(params);
  }

  async arm(raw: unknown, signal: AbortSignal): Promise<void> {
    const binding = BrowserDownloadBinding.parse(raw);
    const lease = this.#admit(binding);
    const check = () => {
      signal.throwIfAborted();
      lease.check();
      if (this.#closed) throw new BrowserDownloadError("closed");
    };
    let spool: Spool | undefined;
    const settled = Promise.withResolvers<void>();
    try {
      check();
      if (this.#arming) throw new BrowserDownloadError("busy");
      if (this.#owner && this.#same(binding)) return;
      // Another task's downloads go on: this one joins the running collection.
      if (
        this.#owner &&
        binding.holder === "agent" &&
        [...this.#bindings.values()].every((other) => other.holder === "agent") &&
        this.#bindings.size > 0
      ) {
        this.#bindings.set(binding.sessionId, binding);
        return;
      }
      this.#arming = settled.promise;
      this.#bindings.clear();
      const current = AbortSignal.any([signal, lease.signal]);
      await this.deps.targets.downloadBehavior(false, current);
      check();
      await this.#owner?.close();
      this.#owner = undefined;
      check();
      spool = await (this.deps.openSpool ?? BrowserDownloadSpool.open)();
      check();
      const owner = new BrowserDownloadEvents({
        spool,
        admit: (frameId) => {
          const chosen = this.#bindingFor(frameId);
          if (!chosen || this.#owner !== owner) throw new BrowserDownloadError("stale");
          const admitted = this.#admit(chosen);
          return {
            signal: admitted.signal,
            check: admitted.check,
            finish: admitted.finish,
            origin: {
              browserCellId: chosen.permit.browserCellId,
              parentCellId: chosen.permit.parentCellId,
              browserInstance: chosen.permit.instance,
              sessionId: chosen.sessionId,
            },
          };
        },
        cancel: (guid) => this.deps.targets.cancelDownload(guid),
        fence: () => this.deps.fence(),
      });
      this.#owner = owner;
      spool = undefined;
      this.#bindings.set(binding.sessionId, binding);
      await this.deps.targets.downloadBehavior(true, current);
      check();
    } catch (error) {
      if (this.#arming === settled.promise) {
        this.#bindings.clear();
        // A partly delivered enable command is uncertain. Contain the browser; do not just clear state.
        this.deps.fence();
      }
      throw error;
    } finally {
      try {
        await spool?.close();
      } finally {
        if (this.#arming === settled.promise) this.#arming = undefined;
        lease.finish();
        settled.resolve();
      }
    }
  }

  list(raw: unknown, signal: AbortSignal): readonly DownloadOffer[] {
    const { lease, owner, binding } = this.#access(raw, signal);
    try {
      return owner.list().filter((offer) => offer.origin.sessionId === binding.sessionId);
    } finally {
      lease.finish();
    }
  }

  async *read(raw: unknown, guid: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const { lease, owner, binding } = this.#access(raw, signal);
    try {
      this.#ownFile(owner, binding, guid);
      yield* owner.read(guid, {
        signal: AbortSignal.any([signal, lease.signal]),
        check: () => {
          signal.throwIfAborted();
          lease.check();
        },
      });
    } finally {
      lease.finish();
    }
  }

  async acknowledge(
    raw: unknown,
    guid: string,
    receipt: { bytes: number; sha256: string },
    signal: AbortSignal,
  ): Promise<void> {
    const { lease, owner, binding } = this.#access(raw, signal);
    try {
      this.#ownFile(owner, binding, guid);
      await owner.acknowledge(guid, receipt, {
        signal: AbortSignal.any([signal, lease.signal]),
        check: () => {
          signal.throwIfAborted();
          lease.check();
        },
      });
    } finally {
      lease.finish();
    }
  }

  writersExited(): void {
    this.#closed = true;
    this.#bindings.clear();
    this.#writersGone = true;
    this.#owner?.writersExited();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#bindings.clear();
    const retirement = this.#owner?.close();
    void retirement?.catch(() => {});
    this.#closing = (async () => {
      await this.#arming;
      if (this.#writersGone) this.#owner?.writersExited();
      const results = await Promise.allSettled([retirement, this.#owner?.close()]);
      if (results.some((result) => result.status === "rejected"))
        throw new BrowserDownloadError("closed");
    })();
    void this.#closing.catch(() => {});
    return this.#closing;
  }

  #same(binding: BrowserDownloadBinding): boolean {
    return (
      !this.#closed &&
      JSON.stringify(this.#bindings.get(binding.sessionId)) === JSON.stringify(binding)
    );
  }

  // The user holds the whole browser: what they download is theirs. Otherwise a download goes to
  // the task whose window started it, never to whichever task happens to be armed.
  #bindingFor(frameId: string): BrowserDownloadBinding | undefined {
    const bindings = [...this.#bindings.values()];
    const only = bindings.length === 1 ? bindings[0] : undefined;
    if (only?.holder === "user" || !this.deps.attribute) return only;
    const sessionId = this.deps.attribute(frameId);
    return sessionId ? this.#bindings.get(sessionId) : undefined;
  }

  #ownFile(owner: BrowserDownloadEvents, binding: BrowserDownloadBinding, guid: string): void {
    const offer = owner.list().find((candidate) => candidate.guid === guid);
    if (offer && offer.origin.sessionId !== binding.sessionId)
      throw new BrowserDownloadError("stale");
  }

  #admit(binding: BrowserDownloadBinding): BrowserActionLease {
    if (
      this.#closed ||
      binding.permit.browserCellId !== this.deps.config.browserCellId ||
      binding.permit.parentCellId !== this.deps.config.parentCellId ||
      binding.permit.instance !== this.deps.instance
    )
      throw new BrowserDownloadError("stale");
    return binding.holder === "agent"
      ? this.deps.control.admit(binding.permit)
      : this.deps.control.admitManual(binding.permit);
  }

  #access(
    raw: unknown,
    signal: AbortSignal,
  ): {
    lease: BrowserActionLease;
    owner: BrowserDownloadEvents;
    binding: BrowserDownloadBinding;
  } {
    const binding = BrowserDownloadBinding.parse(raw);
    signal.throwIfAborted();
    if (!this.#owner || !this.#same(binding)) throw new BrowserDownloadError("stale");
    const lease = this.#admit(binding);
    return { lease, owner: this.#owner, binding };
  }
}
