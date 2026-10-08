import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, unlink } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { DOWNLOAD_BYTES } from "../../../../packages/protocol/src/quarantine.ts";
import { BROWSER_DOWNLOAD_DIR } from "./runtime-config.ts";

// One reserved 1GiB file fits in the separate bounded ephemeral download mount.
// The reservation survives completion until the host acknowledges quarantine ingestion.
export const BROWSER_DOWNLOAD_SLOTS = 1;
export const BROWSER_DOWNLOAD_EVENTS = 16;
const CHUNK_BYTES = 64 * 1024;
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class BrowserSpoolError extends Error {
  constructor(readonly reason: "closed" | "busy" | "identity" | "bytes" | "cancelled") {
    super(`Browser download refused: ${reason}`);
  }
}

export interface DownloadScope {
  readonly signal: AbortSignal;
  check(): void;
}

export interface BrowserSpoolFile {
  readonly guid: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface Entry {
  accepted: boolean;
  terminal: boolean;
  retiring: boolean;
  abort: AbortController;
  task?: Promise<void>;
  retirement?: Promise<void>;
  file?: BrowserSpoolFile;
  handle?: FileHandle;
  stat?: BigIntStats;
}

function same(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function unchanged(first: BigIntStats, second: BigIntStats): boolean {
  return (
    same(first, second) &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs &&
    first.nlink === second.nlink &&
    first.mode === second.mode &&
    first.uid === second.uid
  );
}

/** Linux-only descriptor-relative reader. Only the CDP download owner calls terminal methods. */
export class BrowserDownloadSpool {
  readonly #entries = new Map<string, Entry>();
  #closed = false;
  #closing?: Promise<void>;

  private constructor(
    private readonly directory: string,
    private readonly folder: FileHandle,
    private readonly identity: BigIntStats,
  ) {}

  static async open(directory = BROWSER_DOWNLOAD_DIR): Promise<BrowserDownloadSpool> {
    if (
      process.platform !== "linux" ||
      !isAbsolute(directory) ||
      normalize(directory) !== directory ||
      directory === "/" ||
      directory.endsWith("/") ||
      /[\p{Cc}\p{Cf}]/u.test(directory)
    )
      throw new BrowserSpoolError("identity");
    let folder: FileHandle | undefined;
    try {
      folder = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const stat = await folder.stat({ bigint: true });
      if (
        !stat.isDirectory() ||
        stat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (stat.mode & 0o7777n) !== 0o700n ||
        !same(stat, await lstat(directory, { bigint: true }))
      )
        throw new BrowserSpoolError("identity");
      return new BrowserDownloadSpool(directory, folder, stat);
    } catch {
      await folder?.close();
      throw new BrowserSpoolError("identity");
    }
  }

  reserve(guid: string): void {
    this.#check();
    if (!guidPattern.test(guid)) throw new BrowserSpoolError("identity");
    if (
      this.#entries.has(guid) ||
      this.#entries.size >= BROWSER_DOWNLOAD_EVENTS ||
      [...this.#entries.values()].filter((entry) => entry.accepted).length >= BROWSER_DOWNLOAD_SLOTS
    )
      throw new BrowserSpoolError("busy");
    this.#entries.set(guid, {
      accepted: true,
      terminal: false,
      retiring: false,
      abort: new AbortController(),
    });
  }

  // A refused concurrent download still owns its GUID until Chromium stops writing it.
  rejected(guid: string): void {
    this.#check();
    if (!guidPattern.test(guid)) throw new BrowserSpoolError("identity");
    if (this.#entries.has(guid) || this.#entries.size >= BROWSER_DOWNLOAD_EVENTS)
      throw new BrowserSpoolError("busy");
    this.#entries.set(guid, {
      accepted: false,
      terminal: false,
      retiring: false,
      abort: new AbortController(),
    });
  }

  // Called only after Browser.downloadProgress completed, never merely after cancelDownload's reply.
  async completed(
    guid: string,
    reportedBytes: number,
    scope: DownloadScope,
  ): Promise<BrowserSpoolFile> {
    const entry = this.#entry(guid);
    if (entry.terminal || entry.task) throw new BrowserSpoolError("busy");
    entry.terminal = true;
    if (!entry.accepted) throw new BrowserSpoolError("busy");
    const settled = Promise.withResolvers<void>();
    entry.task = settled.promise;
    const check = () => this.#scope(entry, scope);
    try {
      check();
      if (
        !Number.isSafeInteger(reportedBytes) ||
        reportedBytes < 0 ||
        reportedBytes > DOWNLOAD_BYTES
      )
        throw new BrowserSpoolError("bytes");
      await this.#folder();
      check();
      const file = await open(
        this.#path(guid),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      entry.handle = file;
      const stat = await file.stat({ bigint: true });
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.uid !== this.identity.uid ||
        (stat.mode & 0o7133n) !== 0n ||
        stat.size !== BigInt(reportedBytes)
      )
        throw new BrowserSpoolError("identity");
      entry.stat = stat;
      const hash = createHash("sha256");
      let position = 0;
      while (position < reportedBytes) {
        check();
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, reportedBytes - position));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        check();
        if (bytesRead === 0) throw new BrowserSpoolError("bytes");
        position += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
      }
      await this.#current(guid, entry);
      check();
      const result = Object.freeze({ guid, bytes: reportedBytes, sha256: hash.digest("hex") });
      entry.file = result;
      return result;
    } catch (error) {
      await entry.handle?.close();
      entry.handle = undefined;
      entry.stat = undefined;
      if (error instanceof BrowserSpoolError) throw error;
      throw new BrowserSpoolError("identity");
    } finally {
      entry.task = undefined;
      settled.resolve();
    }
  }

  // Only a terminal CDP cancelled event (or verified Chromium exit) establishes this fact.
  cancelled(guid: string): void {
    const entry = this.#entry(guid);
    if (entry.terminal) throw new BrowserSpoolError("identity");
    entry.terminal = true;
  }

  async *read(file: BrowserSpoolFile, scope: DownloadScope): AsyncGenerator<Uint8Array> {
    const entry = this.#entry(file.guid);
    if (entry.file !== file || !entry.handle || !entry.stat)
      throw new BrowserSpoolError("identity");
    if (entry.task) throw new BrowserSpoolError("busy");
    const settled = Promise.withResolvers<void>();
    entry.task = settled.promise;
    const hash = createHash("sha256");
    let position = 0;
    try {
      this.#scope(entry, scope);
      await this.#current(file.guid, entry);
      while (position < file.bytes) {
        this.#scope(entry, scope);
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, file.bytes - position));
        const { bytesRead } = await entry.handle.read(buffer, 0, buffer.length, position);
        this.#scope(entry, scope);
        if (bytesRead === 0) throw new BrowserSpoolError("bytes");
        position += bytesRead;
        const bytes = buffer.subarray(0, bytesRead);
        hash.update(bytes);
        yield bytes;
      }
      await this.#current(file.guid, entry);
      this.#scope(entry, scope);
      if (hash.digest("hex") !== file.sha256) throw new BrowserSpoolError("bytes");
    } catch (error) {
      if (error instanceof BrowserSpoolError) throw error;
      throw new BrowserSpoolError("identity");
    } finally {
      entry.task = undefined;
      settled.resolve();
    }
  }

  // The caller must retire/return its reader; this waits for that physical drain.
  // No active Chromium writer is ever unlinked by this method.
  async remove(guid: string): Promise<void> {
    const entry = this.#entry(guid);
    if (!entry.terminal) throw new BrowserSpoolError("busy");
    entry.retiring = true;
    entry.abort.abort();
    const settled = Promise.withResolvers<void>();
    entry.retirement = settled.promise;
    try {
      await entry.task;
      await this.#folder();
      await entry.handle?.close();
      entry.handle = undefined;
      for (const suffix of ["", ".crdownload"]) {
        try {
          await unlink(this.#path(`${guid}${suffix}`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw new BrowserSpoolError("identity");
        }
      }
      await this.#folder();
      this.#entries.delete(guid);
    } catch (error) {
      if (error instanceof BrowserSpoolError) throw error;
      throw new BrowserSpoolError("identity");
    } finally {
      settled.resolve();
    }
  }

  // Closing does not delete an active writer's paths. Runtime shutdown must contain Chromium.
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const entries = [...this.#entries.values()];
    for (const entry of entries) entry.abort.abort();
    this.#closing = (async () => {
      try {
        const results = await Promise.allSettled(
          entries.map(async (entry) => {
            await entry.retirement;
            await entry.task;
            await entry.handle?.close();
            entry.handle = undefined;
          }),
        );
        if (results.some((result) => result.status === "rejected"))
          throw new BrowserSpoolError("identity");
      } finally {
        await this.folder.close();
      }
    })();
    return this.#closing;
  }

  #check(): void {
    if (this.#closed) throw new BrowserSpoolError("closed");
  }

  #entry(guid: string): Entry {
    this.#check();
    if (!guidPattern.test(guid)) throw new BrowserSpoolError("identity");
    const entry = this.#entries.get(guid);
    if (!entry || entry.retiring) throw new BrowserSpoolError("identity");
    return entry;
  }

  #scope(entry: Entry, scope: DownloadScope): void {
    this.#check();
    if (entry.abort.signal.aborted || scope.signal.aborted)
      throw new BrowserSpoolError("cancelled");
    scope.check();
  }

  #path(name: string): string {
    return `/proc/self/fd/${this.folder.fd}/${name}`;
  }

  async #folder(): Promise<void> {
    this.#check();
    const current = await lstat(this.directory, { bigint: true });
    if (
      !current.isDirectory() ||
      !same(current, this.identity) ||
      current.uid !== this.identity.uid ||
      (current.mode & 0o7777n) !== 0o700n
    )
      throw new BrowserSpoolError("identity");
  }

  async #current(guid: string, entry: Entry): Promise<void> {
    await this.#folder();
    if (!entry.handle || !entry.stat) throw new BrowserSpoolError("identity");
    const [opened, named] = await Promise.all([
      entry.handle.stat({ bigint: true }),
      lstat(this.#path(guid), { bigint: true }),
    ]);
    if (!unchanged(entry.stat, opened) || !unchanged(entry.stat, named))
      throw new BrowserSpoolError("identity");
  }
}
