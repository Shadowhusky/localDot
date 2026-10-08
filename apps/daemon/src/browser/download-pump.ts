import { setTimeout as sleep } from "node:timers/promises";
import { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import type { BrowserClient, BrowserScope } from "./client.ts";
import type { BrowserDownloadCollector } from "./download-collector.ts";

export interface DownloadCollection {
  readonly ready: Promise<void>;
  readonly settled: Promise<void>;
  stop(): void;
}

// One current browser grant owns one polling task. A transfer has its own lease;
// the idle delay does not hold a transfer lease or block a session control change.
export class BrowserDownloadPump implements DownloadCollection {
  readonly ready: Promise<void>;
  readonly settled: Promise<void>;
  readonly #abort = new AbortController();

  constructor(deps: {
    client: Pick<
      BrowserClient,
      "armDownloads" | "downloads" | "readDownload" | "acknowledgeDownload" | "close"
    >;
    collector: Pick<BrowserDownloadCollector, "collect">;
    binding: BrowserDownloadBinding;
    scope: BrowserScope;
    pollMs?: number;
  }) {
    const admitted = Promise.withResolvers<void>();
    this.ready = admitted.promise;
    void this.ready.catch(() => {});
    const signal = AbortSignal.any([deps.scope.signal, this.#abort.signal]);
    const check = () => {
      signal.throwIfAborted();
      deps.scope.check();
      signal.throwIfAborted();
    };
    this.settled = (async () => {
      try {
        const interval = deps.pollMs ?? 1000;
        if (!Number.isSafeInteger(interval) || interval < 1 || interval > 30000)
          throw new Error("Invalid download collection interval.");
        const binding = BrowserDownloadBinding.parse(deps.binding);
        const scope = { signal, check };
        check();
        await deps.client.armDownloads(binding, scope);
        check();
        admitted.resolve();
        let failures = 0;
        while (true) {
          check();
          try {
            await deps.collector.collect(deps.client, binding, scope);
            failures = 0;
          } catch {
            check();
            // Lost replies and full quarantine retain browser bytes. Retry under
            // this same grant with capped backoff; never manufacture a new grant.
            failures = Math.min(failures + 1, 5);
          }
          check();
          await sleep(Math.min(interval * 2 ** failures, 30000), undefined, { signal, ref: false });
        }
      } catch (error) {
        admitted.reject(error);
      } finally {
        deps.client.close();
      }
    })();
  }

  stop(): void {
    this.#abort.abort();
  }
}
