import { CATALOG_SOURCE, Catalog, normalizeCatalog } from "@localdot/providers";
import { immutable, PrivateFiles } from "./private-files.ts";

const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
export interface CatalogStoreOptions {
  fetchImpl?: typeof fetch;
  source?: string;
  now?: () => Date;
  timeoutMs?: number;
  maxBytes?: number;
  enrich?: (
    catalog: Catalog,
    previous: Catalog | undefined,
    signal: AbortSignal,
  ) => Promise<Catalog>;
}
export class CatalogStore {
  readonly #files: PrivateFiles;
  readonly #opts: Required<CatalogStoreOptions>;
  #cached: Catalog | undefined;
  #refreshing: Promise<Catalog> | undefined;
  #retryAfter = 0;
  #lastAttempt = -Infinity;
  #refreshFailed = false;
  #checked = false;
  #closing = new AbortController();
  close(): void {
    this.#closing.abort();
  }

  freshness() {
    const at = Date.parse(this.get()?.fetchedAt ?? "");
    const age = this.#opts.now().getTime() - at;
    return {
      stale: !this.#checked || !Number.isFinite(age) || age < 0 || age >= 300_000,
      refreshing: !!this.#refreshing,
      refreshFailed: this.#refreshFailed,
    };
  }

  // Serve a usable cache immediately. All tabs share one refresh, and an outage
  // retries at most once a minute. No credentials or model calls are involved.
  async fresh(checkNow = false): Promise<Catalog | undefined> {
    const cached = this.get();
    const now = this.#opts.now().getTime();
    if (
      now < this.#retryAfter ||
      (!this.freshness().stale && !(checkNow && now - this.#lastAttempt >= 60_000))
    )
      return cached;
    const refreshed = this.refresh().catch(() => cached);
    return cached ?? (await refreshed);
  }
  constructor(home: string, opts: CatalogStoreOptions = {}) {
    this.#files = new PrivateFiles(home, "catalog");
    this.#opts = {
      fetchImpl: opts.fetchImpl ?? fetch,
      source: opts.source ?? CATALOG_SOURCE,
      now: opts.now ?? (() => new Date()),
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxBytes: opts.maxBytes ?? MAX_CATALOG_BYTES,
      enrich: opts.enrich ?? (async (catalog) => catalog),
    };
    const url = new URL(this.#opts.source);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error("invalid public catalog source");
    if (
      !Number.isInteger(this.#opts.maxBytes) ||
      this.#opts.maxBytes < 1 ||
      this.#opts.maxBytes > MAX_CATALOG_BYTES ||
      !Number.isFinite(this.#opts.timeoutMs) ||
      this.#opts.timeoutMs < 1 ||
      this.#opts.timeoutMs > 120_000
    )
      throw new Error("invalid catalog limits");
  }
  get(): Catalog | undefined {
    if (this.#cached) return this.#cached;
    try {
      const text = this.#files.text("models.json", this.#opts.maxBytes);
      if (text !== undefined) this.#cached = immutable(Catalog.parse(JSON.parse(text)));
    } catch {
      return undefined;
    }
    return this.#cached;
  }
  refresh(): Promise<Catalog> {
    this.#refreshing ??= this.#fetch()
      .then((catalog) => {
        this.#refreshFailed = false;
        this.#checked = true;
        this.#retryAfter = 0;
        return catalog;
      })
      .catch((error) => {
        this.#refreshFailed = true;
        this.#retryAfter = this.#opts.now().getTime() + 60_000;
        throw error;
      })
      .finally(() => {
        this.#refreshing = undefined;
      });
    return this.#refreshing;
  }
  async #fetch(): Promise<Catalog> {
    this.#lastAttempt = this.#opts.now().getTime();
    const abort = new AbortController();
    const closing = () => abort.abort();
    this.#closing.signal.addEventListener("abort", closing, { once: true });
    if (this.#closing.signal.aborted) abort.abort();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | null | undefined;
    let rejectDeadline!: (reason: Error) => void;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      const error = new Error("catalog refresh timed out");
      abort.abort(error);
      void reader?.cancel(error).catch(() => undefined);
      rejectDeadline(error);
    }, this.#opts.timeoutMs);
    const run = async () => {
      try {
        let sourceError: unknown;
        let normalized: Catalog;
        try {
          const response = await this.#opts.fetchImpl(this.#opts.source, {
            headers: { accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
          });
          body = response.body;
          abort.signal.throwIfAborted();
          if (!response.ok) throw new Error(`catalog: source answered ${response.status}`);
          const declared = response.headers.get("content-length");
          if (declared && Number(declared) > this.#opts.maxBytes)
            throw new Error("catalog: the reply is too large");
          if (!response.body) throw new Error("catalog: empty reply");
          reader = response.body.getReader();
          const parts: Uint8Array[] = [];
          let bytes = 0;
          while (true) {
            const next = await reader.read();
            abort.signal.throwIfAborted();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > this.#opts.maxBytes) throw new Error("catalog: the reply is too large");
            parts.push(next.value);
          }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(parts, bytes),
          );
          normalized = normalizeCatalog(
            JSON.parse(text),
            this.#opts.now().toISOString(),
            this.#opts.source,
          );
        } catch (error) {
          const cached = this.get();
          if (!cached || abort.signal.aborted) throw error;
          // A public-catalog outage must not prevent checking the configured providers.
          // Preserve fetchedAt and report the outage even when capability reads succeed.
          normalized = structuredClone(cached);
          sourceError = error;
        }
        const catalog = Catalog.parse(
          await this.#opts.enrich(normalized, this.get(), abort.signal),
        );
        if (
          !Object.values(catalog.providers).some((provider) => Object.keys(provider.models).length)
        )
          throw new Error("catalog: no usable models in the reply");
        const saved = `${JSON.stringify(catalog)}\n`;
        if (Buffer.byteLength(saved) > this.#opts.maxBytes)
          throw new Error("catalog: normalized cache is too large");
        abort.signal.throwIfAborted();
        if (sourceError && saved === `${JSON.stringify(this.get())}\n`) throw sourceError;
        this.#files.write("models.json", saved);
        this.#cached = immutable(catalog);
        if (sourceError) throw sourceError;
        return this.#cached;
      } finally {
        if (reader) {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        } else void body?.cancel().catch(() => undefined);
      }
    };
    try {
      return await Promise.race([run(), deadline]);
    } finally {
      clearTimeout(timer);
      this.#closing.signal.removeEventListener("abort", closing);
    }
  }
}
