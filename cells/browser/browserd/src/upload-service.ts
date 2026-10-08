import { addAbortSignal, type Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  BrowserUploadAccess,
  type BrowserUploadOffer,
  type BrowserUploadReceipt,
  BrowserUploadRequest,
} from "../../../../packages/protocol/src/browser-uploads.ts";
import type { BrowserActionLease, BrowserControl } from "./control.ts";
import type { BrowserRuntimeConfig } from "./runtime-config.ts";
import type { BrowserFileChooser, BrowserTargets } from "./targets.ts";
import { BrowserUploadStaging, type UploadScope } from "./upload-staging.ts";

export const BROWSER_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
type Storage = Pick<
  BrowserUploadStaging,
  "stage" | "assign" | "discard" | "readersExited" | "close"
>;
export interface BrowserUploadServiceDeps {
  readonly config: BrowserRuntimeConfig;
  readonly instance: string;
  readonly control: Pick<BrowserControl, "admit">;
  readonly targets: Pick<
    BrowserTargets,
    | "fileChooserOffer"
    | "claimedFileChooserOffer"
    | "claimFileChooser"
    | "checkFileChooser"
    | "clearFileChooser"
    | "fillFileChooser"
  >;
  openStaging?(): Promise<Storage>;
}

export class BrowserUploadService {
  readonly #pending = new Set<Promise<unknown>>();
  readonly #lifetime = new AbortController();
  #store?: Storage;
  #opening?: Promise<Storage>;
  #closing?: Promise<void>;
  #closed = false;
  #readersGone = false;

  constructor(private readonly deps: BrowserUploadServiceDeps) {}

  chooser(raw: unknown, signal: AbortSignal): Promise<BrowserUploadOffer | undefined> {
    return this.#track(this.#chooser(raw, signal));
  }

  async #chooser(raw: unknown, signal: AbortSignal): Promise<BrowserUploadOffer | undefined> {
    const access = BrowserUploadAccess.parse(raw);
    const lease = this.#admit(access.permit);
    const current = AbortSignal.any([signal, lease.signal, this.#lifetime.signal]);
    try {
      current.throwIfAborted();
      lease.check();
      const offer = await this.deps.targets.fileChooserOffer(access.tabId, current);
      current.throwIfAborted();
      lease.check();
      return offer;
    } finally {
      lease.finish();
    }
  }

  upload(raw: unknown, source: Readable, signal: AbortSignal): Promise<BrowserUploadReceipt> {
    return this.#track(this.#upload(raw, source, signal));
  }

  #track<T>(task: Promise<T>): Promise<T> {
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => this.#pending.delete(task),
    );
    return task;
  }

  async #upload(
    raw: unknown,
    source: Readable,
    signal: AbortSignal,
  ): Promise<BrowserUploadReceipt> {
    const sourceClosed = finished(source, { cleanup: true }).catch(() => {});
    let lease: BrowserActionLease | undefined;
    let chooser: BrowserFileChooser | undefined;
    let staged: Awaited<ReturnType<Storage["stage"]>> | undefined;
    let assigned = false;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), BROWSER_UPLOAD_TIMEOUT_MS);
    timer.unref();
    try {
      const request = BrowserUploadRequest.parse(raw);
      signal.throwIfAborted();
      lease = this.#admit(request.permit);
      const admitted = lease;
      chooser = this.deps.targets.claimFileChooser(request.tabId, request.chooserId);
      if (chooser.mode === "single" && request.files.length !== 1)
        throw new Error("upload cardinality");
      const current = AbortSignal.any([
        signal,
        lease.signal,
        chooser.signal,
        this.#lifetime.signal,
        timeout.signal,
      ]);
      const scope: UploadScope = {
        signal: current,
        check: () => {
          current.throwIfAborted();
          admitted.check();
          if (this.#closed) throw new Error("upload closed");
        },
      };
      addAbortSignal(current, source);
      scope.check();
      const claimed = chooser;
      const checkDestination = async () => {
        scope.check();
        const offer = await this.deps.targets.claimedFileChooserOffer(claimed, current);
        scope.check();
        if (
          offer.origin !== request.destination.origin ||
          offer.embedded !== request.destination.embedded
        )
          throw new Error("upload destination changed");
      };
      await checkDestination();
      const store = await this.#storage();
      scope.check();
      staged = await store.stage(request.files, source, scope);
      scope.check();
      await store.assign(staged, scope, async (paths, assignmentScope) => {
        await checkDestination();
        assigned = true;
        return this.deps.targets.fillFileChooser(claimed, paths, assignmentScope);
      });
      scope.check();
      return {
        chooserId: request.chooserId,
        destination: request.destination,
        files: request.files,
      };
    } finally {
      clearTimeout(timer);
      source.destroy();
      await sourceClosed;
      try {
        if (staged && !assigned) await this.#store?.discard(staged).catch(() => {});
        if (chooser) {
          // Never clear a new chooser which replaced this request's claim.
          try {
            this.deps.targets.checkFileChooser(chooser);
            this.deps.targets.clearFileChooser();
          } catch {
            /* already retired */
          }
        }
      } finally {
        lease?.finish();
      }
    }
  }

  readersExited(): void {
    this.#closed = true;
    this.#lifetime.abort();
    this.#readersGone = true;
    this.#store?.readersExited();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#lifetime.abort();
    this.#closing = (async () => {
      await Promise.allSettled([...this.#pending]);
      await this.#opening?.catch(() => {});
      await this.#store?.close();
    })();
    void this.#closing.catch(() => {});
    return this.#closing;
  }

  #storage(): Promise<Storage> {
    if (!this.#opening)
      this.#opening = (this.deps.openStaging ?? BrowserUploadStaging.open)().then((store) => {
        this.#store = store;
        if (this.#readersGone) store.readersExited();
        return store;
      });
    return this.#opening;
  }

  #admit(permit: {
    browserCellId: string;
    parentCellId: string;
    instance: string;
  }): BrowserActionLease {
    if (
      this.#closed ||
      permit.browserCellId !== this.deps.config.browserCellId ||
      permit.parentCellId !== this.deps.config.parentCellId ||
      permit.instance !== this.deps.instance
    )
      throw new Error("upload owner refused");
    return this.deps.control.admit(permit);
  }
}
