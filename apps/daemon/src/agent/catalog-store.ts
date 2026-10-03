import { CATALOG_SOURCE, Catalog, normalizeCatalog } from "@localdot/providers";
import { immutable, PrivateFiles } from "./private-files.ts";

const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
export interface CatalogStoreOptions {
  fetchImpl?: typeof fetch;
  source?: string;
  now?: () => Date;
  timeoutMs?: number;
  maxBytes?: number;
}
export class CatalogStore {
  readonly #files: PrivateFiles;
  readonly #opts: Required<CatalogStoreOptions>;
  #cached: Catalog | undefined;
  #refreshing: Promise<Catalog> | undefined;
  constructor(home: string, opts: CatalogStoreOptions = {}) {
    this.#files = new PrivateFiles(home, "catalog");
    this.#opts = {
      fetchImpl: opts.fetchImpl ?? fetch,
      source: opts.source ?? CATALOG_SOURCE,
      now: opts.now ?? (() => new Date()),
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxBytes: opts.maxBytes ?? MAX_CATALOG_BYTES,
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
    this.#refreshing ??= this.#fetch().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }
  async #fetch(): Promise<Catalog> {
    const abort = new AbortController();
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
        const response = await this.#opts.fetchImpl(this.#opts.source, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: abort.signal,
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
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes));
        const catalog = normalizeCatalog(
          JSON.parse(text),
          this.#opts.now().toISOString(),
          this.#opts.source,
        );
        const saved = `${JSON.stringify(catalog)}\n`;
        if (Buffer.byteLength(saved) > this.#opts.maxBytes)
          throw new Error("catalog: normalized cache is too large");
        abort.signal.throwIfAborted();
        this.#files.write("models.json", saved);
        this.#cached = immutable(catalog);
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
    }
  }
}
