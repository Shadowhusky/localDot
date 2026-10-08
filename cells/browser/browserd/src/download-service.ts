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
  fence(): void;
}

export class BrowserDownloadService {
  #binding?: BrowserDownloadBinding;
  #owner?: BrowserDownloadEvents;
  #arming?: Promise<void>;
  #closing?: Promise<void>;
  #closed = false;
  #writersGone = false;

  constructor(private readonly deps: BrowserDownloadServiceDeps) {}

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
      this.#arming = settled.promise;
      this.#binding = undefined;
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
        admit: () => {
          if (!this.#same(binding) || this.#owner !== owner)
            throw new BrowserDownloadError("stale");
          const admitted = this.#admit(binding);
          return {
            signal: admitted.signal,
            check: admitted.check,
            finish: admitted.finish,
            origin: {
              browserCellId: binding.permit.browserCellId,
              parentCellId: binding.permit.parentCellId,
              browserInstance: binding.permit.instance,
              sessionId: binding.sessionId,
            },
          };
        },
        cancel: (guid) => this.deps.targets.cancelDownload(guid),
        fence: () => this.deps.fence(),
      });
      this.#owner = owner;
      spool = undefined;
      this.#binding = binding;
      await this.deps.targets.downloadBehavior(true, current);
      check();
    } catch (error) {
      if (this.#arming === settled.promise) {
        this.#binding = undefined;
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
    const { lease, owner } = this.#access(raw, signal);
    try {
      return owner.list();
    } finally {
      lease.finish();
    }
  }

  async *read(raw: unknown, guid: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const { lease, owner } = this.#access(raw, signal);
    try {
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
    const { lease, owner } = this.#access(raw, signal);
    try {
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
    this.#binding = undefined;
    this.#writersGone = true;
    this.#owner?.writersExited();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#binding = undefined;
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
      this.#binding !== undefined &&
      JSON.stringify(this.#binding) === JSON.stringify(binding)
    );
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
  ): { lease: BrowserActionLease; owner: BrowserDownloadEvents } {
    const binding = BrowserDownloadBinding.parse(raw);
    signal.throwIfAborted();
    if (!this.#owner || !this.#same(binding)) throw new BrowserDownloadError("stale");
    const lease = this.#admit(binding);
    return { lease, owner: this.#owner };
  }
}
