import {
  BrowserDownloadBinding,
  BrowserDownloadOffer,
} from "../../../../packages/protocol/src/browser-downloads.ts";
import type { QuarantineItem } from "../../../../packages/protocol/src/quarantine.ts";
import type { Transfers } from "../agent/transfers.ts";
import type { BrowserClient, BrowserScope } from "./client.ts";
import type { QuarantineStore } from "./quarantine.ts";

type Client = Pick<BrowserClient, "downloads" | "readDownload" | "acknowledgeDownload">;

// The session owner supplies the current permit and scope. Collection only places
// bytes in host quarantine; it never grants a desktop release or opens a file.
export class BrowserDownloadCollector {
  readonly #active = new Set<string>();

  constructor(
    private readonly deps: {
      store: Pick<QuarantineStore, "ingestBrowser">;
      transfers: Pick<Transfers, "acquire">;
    },
  ) {}

  async collect(
    client: Client,
    raw: BrowserDownloadBinding,
    scope: BrowserScope,
  ): Promise<QuarantineItem[]> {
    const binding = BrowserDownloadBinding.parse(raw);
    const parent = binding.permit.parentCellId;
    scope.signal.throwIfAborted();
    scope.check();
    if (this.#active.has(parent))
      throw new Error("A browser download collection is already active.");
    const lease = this.deps.transfers.acquire(parent, [scope.signal], () => scope.check());
    this.#active.add(parent);
    try {
      const offers = BrowserDownloadOffer.array()
        .max(1)
        .parse(await client.downloads(binding, lease));
      lease.check();
      const items: QuarantineItem[] = [];
      for (const offer of offers) {
        const origin = offer.origin;
        if (
          origin.parentCellId !== parent ||
          origin.browserCellId !== binding.permit.browserCellId ||
          origin.browserInstance !== binding.permit.instance ||
          origin.sessionId !== binding.sessionId
        )
          throw new Error("The browser download owner changed.");
        lease.check();
        const item = await this.deps.store.ingestBrowser(
          offer,
          async () => client.readDownload(binding, offer, lease),
          lease,
        );
        lease.check();
        // Storage is durable before this request can remove the browser copy. If
        // the reply is lost, the next collection reuses the persisted GUID item.
        await client.acknowledgeDownload(binding, offer, lease);
        lease.check();
        items.push(item);
      }
      return items;
    } finally {
      this.#active.delete(parent);
      // Client/store operations retain their source and HTTP owners until closed.
      lease.release();
    }
  }
}
