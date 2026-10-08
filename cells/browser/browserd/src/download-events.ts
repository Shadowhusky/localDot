import { z } from "zod";
import {
  DOWNLOAD_BYTES,
  QuarantineOrigin,
  safeDownloadName,
} from "../../../../packages/protocol/src/quarantine.ts";
import {
  BROWSER_DOWNLOAD_EVENTS,
  type BrowserDownloadSpool,
  type BrowserSpoolFile,
  type DownloadScope,
} from "./download-spool.ts";

export const DOWNLOAD_RETIRE_MS = 3000;
export const DOWNLOAD_LIFETIME_MS = 10 * 60 * 1000;
const guid = z.uuid().refine((value) => value === value.toLowerCase());
const beginEvent = z.object({
  guid,
  frameId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  url: z.string().min(1).max(32768),
  suggestedFilename: z.string().max(4096),
});
const progressEvent = z.object({
  guid,
  state: z.enum(["inProgress", "completed", "canceled"]),
  receivedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export interface DownloadAdmission extends DownloadScope {
  readonly origin: Omit<QuarantineOrigin, "source" | "name">;
  finish(): void;
}

export interface DownloadOffer extends BrowserSpoolFile {
  readonly origin: QuarantineOrigin;
}

export interface BrowserDownloadEventsDeps {
  readonly spool: Pick<
    BrowserDownloadSpool,
    "reserve" | "rejected" | "completed" | "cancelled" | "read" | "remove" | "close"
  >;
  // Acquires a current browser action lease and pins its daemon-supplied session binding.
  admit(): DownloadAdmission;
  cancel(guid: string): Promise<void>;
  // Starts containment. Call writersExited only after verified Chromium group exit.
  fence(): void;
}

interface DownloadRecord {
  guid: string;
  abort: AbortController;
  terminal: ReturnType<typeof Promise.withResolvers<void>>;
  finished: boolean;
  admitted: boolean;
  captured: boolean;
  admission?: DownloadAdmission;
  origin?: QuarantineOrigin;
  file?: BrowserSpoolFile;
  reader?: AsyncGenerator<Uint8Array>;
  capture?: Promise<void>;
  retirement?: Promise<void>;
  lifetime?: ReturnType<typeof setTimeout>;
  cancelled?: () => void;
  received: number;
}

export class BrowserDownloadError extends Error {
  constructor(readonly reason: "event" | "closed" | "stale" | "busy") {
    super(`Browser download refused: ${reason}`);
  }
}

// Only this owner admits CDP GUIDs. Cancel replies are never proof that a writer has stopped.
export class BrowserDownloadEvents {
  readonly #records = new Map<string, DownloadRecord>();
  readonly #retired = new Set<string>();
  readonly #exited = Promise.withResolvers<void>();
  #closed = false;
  #writersGone = false;
  #fenced = false;

  constructor(private readonly deps: BrowserDownloadEventsDeps) {}

  owns(guid: string): boolean {
    return this.#records.has(guid);
  }

  begin(raw: Readonly<Record<string, unknown>>): void {
    const parsed = beginEvent.safeParse(raw);
    if (
      !parsed.success ||
      this.#closed ||
      this.#records.size >= BROWSER_DOWNLOAD_EVENTS ||
      this.#records.has(parsed.data.guid) ||
      this.#retired.has(parsed.data.guid)
    ) {
      this.#fence();
      return;
    }
    const event = parsed.data;
    const record: DownloadRecord = {
      guid: event.guid,
      abort: new AbortController(),
      terminal: Promise.withResolvers<void>(),
      finished: false,
      admitted: false,
      captured: false,
      received: 0,
    };
    this.#records.set(record.guid, record);
    try {
      record.admission = this.deps.admit();
      record.admission.check();
      record.admission.signal.throwIfAborted();
      // Retain only a hostname. Raw URLs, credentials, query strings and CDP filePath never escape.
      const source = new URL(event.url.startsWith("blob:") ? event.url.slice(5) : event.url);
      if (!["http:", "https:"].includes(source.protocol) || source.username || source.password)
        throw new BrowserDownloadError("event");
      record.origin = Object.freeze(
        QuarantineOrigin.parse({
          ...record.admission.origin,
          name: safeDownloadName(event.suggestedFilename),
          source: source.hostname.toLowerCase().replace(/\.$/u, ""),
        }),
      );
      this.deps.spool.reserve(record.guid);
      record.admitted = true;
    } catch {
      try {
        this.deps.spool.rejected(record.guid);
      } catch {
        this.#fence();
      }
    }
    if (record.retirement) return;
    record.cancelled = () => {
      void this.#retire(record);
    };
    record.admission?.signal.addEventListener("abort", record.cancelled, { once: true });
    record.lifetime = setTimeout(record.cancelled, DOWNLOAD_LIFETIME_MS);
    record.lifetime.unref();
    if (!record.admitted || record.admission?.signal.aborted) void this.#retire(record);
  }

  progress(raw: Readonly<Record<string, unknown>>): void {
    const parsed = progressEvent.safeParse(raw);
    if (!parsed.success) {
      this.#fence();
      return;
    }
    const event = parsed.data;
    const record = this.#records.get(event.guid);
    if (!record) {
      if (!this.#retired.has(event.guid)) this.#fence();
      return;
    }
    if (record.finished) return;
    if (event.receivedBytes < record.received) {
      this.#fence();
      return;
    }
    record.received = event.receivedBytes;
    if (event.state !== "inProgress") {
      record.finished = true;
      record.terminal.resolve();
    }
    if (
      event.receivedBytes > DOWNLOAD_BYTES ||
      (event.totalBytes ?? 0) > DOWNLOAD_BYTES ||
      event.state === "canceled"
    ) {
      void this.#retire(record);
      return;
    }
    if (event.state === "completed" && !record.retirement && record.admitted) {
      record.captured = true;
      record.capture = this.#capture(record, event.receivedBytes);
    }
  }

  list(): readonly DownloadOffer[] {
    if (this.#closed) throw new BrowserDownloadError("closed");
    const offers: DownloadOffer[] = [];
    for (const record of this.#records.values()) {
      if (!record.file || !record.origin || record.retirement) continue;
      try {
        this.#check(record);
      } catch {
        void this.#retire(record);
        continue;
      }
      offers.push(Object.freeze({ ...record.file, origin: record.origin }));
    }
    return Object.freeze(offers);
  }

  read(guid: string, scope: DownloadScope): AsyncGenerator<Uint8Array> {
    const record = this.#ready(guid);
    if (record.reader) throw new BrowserDownloadError("busy");
    const reader = this.deps.spool.read(record.file as BrowserSpoolFile, {
      signal: AbortSignal.any([record.abort.signal, scope.signal]),
      check: () => {
        this.#check(record);
        scope.signal.throwIfAborted();
        scope.check();
      },
    });
    record.reader = reader;
    const observe = async (pending: Promise<IteratorResult<Uint8Array>>) => {
      try {
        const result = await pending;
        if (result.done && record.reader === reader) record.reader = undefined;
        return result;
      } catch (error) {
        if (record.reader === reader) record.reader = undefined;
        throw error;
      }
    };
    const next = reader.next.bind(reader);
    const finish = reader.return.bind(reader);
    const fail = reader.throw.bind(reader);
    reader.next = (...args) => observe(next(...args));
    reader.return = (value) => observe(finish(value));
    reader.throw = (reason) => observe(fail(reason));
    return reader;
  }

  async acknowledge(
    guid: string,
    receipt: { bytes: number; sha256: string },
    scope: DownloadScope,
  ): Promise<void> {
    const record = this.#ready(guid);
    scope.signal.throwIfAborted();
    scope.check();
    if (record.file?.bytes !== receipt.bytes || record.file?.sha256 !== receipt.sha256)
      throw new BrowserDownloadError("stale");
    await this.#retire(record);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#records.values()].map((record) => this.#retire(record)),
    );
    await this.deps.spool.close();
    if (results.some((result) => result.status === "rejected"))
      throw new BrowserDownloadError("closed");
  }

  // A disconnected CDP pipe alone is insufficient. Runtime calls this after physical process drain.
  writersExited(): void {
    this.#closed = true;
    this.#writersGone = true;
    this.#exited.resolve();
    for (const record of this.#records.values()) {
      record.finished = true;
      record.terminal.resolve();
      void this.#retire(record);
    }
  }

  async #capture(record: DownloadRecord, bytes: number): Promise<void> {
    try {
      record.file = await this.deps.spool.completed(record.guid, bytes, {
        signal: record.abort.signal,
        check: () => this.#check(record),
      });
      this.#check(record);
    } catch {
      void this.#retire(record);
    }
  }

  #ready(guid: string): DownloadRecord {
    const record = this.#records.get(guid);
    if (!record?.file || !record.origin) throw new BrowserDownloadError("stale");
    this.#check(record);
    return record;
  }

  #check(record: DownloadRecord): void {
    if (
      this.#closed ||
      record.retirement ||
      !record.admission ||
      !record.admitted ||
      record.abort.signal.aborted
    )
      throw new BrowserDownloadError("stale");
    record.admission.signal.throwIfAborted();
    record.admission.check();
  }

  #retire(record: DownloadRecord): Promise<void> {
    if (record.retirement) return record.retirement;
    const result = Promise.withResolvers<void>();
    record.retirement = result.promise;
    record.abort.abort();
    clearTimeout(record.lifetime);
    if (record.cancelled) record.admission?.signal.removeEventListener("abort", record.cancelled);
    void (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!record.finished && !this.#writersGone) {
          deadline = setTimeout(() => this.#fence(), DOWNLOAD_RETIRE_MS);
          deadline.unref();
          try {
            await this.deps.cancel(record.guid);
          } catch {
            this.#fence();
          }
        }
        await record.terminal.promise;
        clearTimeout(deadline);
        await record.reader?.return(undefined);
        await record.capture;
        if (!record.captured) this.deps.spool.cancelled(record.guid);
        await this.deps.spool.remove(record.guid);
      } catch {
        this.#fence();
        await this.#exited.promise;
      } finally {
        clearTimeout(deadline);
      }
      record.admission?.finish();
      this.#records.delete(record.guid);
      this.#retired.add(record.guid);
      if (this.#retired.size > 256) {
        const oldest = this.#retired.values().next().value;
        if (oldest !== undefined) this.#retired.delete(oldest);
      }
    })().then(result.resolve, (error: unknown) => {
      this.#fence();
      result.reject(error);
    });
    void result.promise.catch(() => {});
    return result.promise;
  }

  #fence(): void {
    if (this.#fenced) return;
    this.#fenced = true;
    this.#closed = true;
    this.deps.fence();
  }
}
