import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { addAbortSignal, type Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  type BrowserUploadFile,
  BrowserUploadFiles,
} from "../../../../packages/protocol/src/browser-uploads.ts";
import { UPLOAD_BYTES } from "../../../../packages/protocol/src/quarantine.ts";
import { BROWSER_UPLOAD_DIR } from "./runtime-config.ts";

// Assigned files may be read after DOM.setFileInputFiles returns, including by
// File objects retained in another page. Reclaim them only after Chromium exits.
export const BROWSER_UPLOAD_RETAINED_BYTES = 2 * UPLOAD_BYTES;
export const BROWSER_UPLOAD_RETAINED_FILES = 64;
const CHUNK_BYTES = 64 * 1024;

export class BrowserUploadStagingError extends Error {
  constructor(readonly reason: "closed" | "capacity" | "request" | "identity" | "bytes" | "stale") {
    super(`Browser upload staging refused: ${reason}`);
  }
}

export interface UploadScope {
  readonly signal: AbortSignal;
  check(): void;
}

// Only this instance's WeakMap grants access; no path is returned to callers.
export interface StagedBrowserUpload {
  readonly files: readonly Readonly<BrowserUploadFile>[];
}

interface FileEntry {
  readonly id: string;
  readonly info: Readonly<BrowserUploadFile>;
  readonly hash: ReturnType<typeof createHash>;
  directory?: FileHandle;
  directoryCreated?: boolean;
  directoryStat?: BigIntStats;
  handle?: FileHandle;
  stat?: BigIntStats;
  written: number;
}
interface Batch {
  readonly files: FileEntry[];
  readonly bytes: number;
  state: "receiving" | "staged" | "verifying" | "retained" | "discarding";
}

function same(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}
function unchanged(first: BigIntStats, second: BigIntStats): boolean {
  return (
    same(first, second) &&
    first.size === second.size &&
    first.mode === second.mode &&
    first.uid === second.uid &&
    first.nlink === second.nlink &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}
function privateFolder(stat: BigIntStats): boolean {
  return (
    stat.isDirectory() &&
    stat.uid === BigInt(process.getuid?.() ?? -1) &&
    (stat.mode & 0o7777n) === 0o700n
  );
}

/** Linux-only, descriptor-relative, bounded ephemeral upload storage. */
export class BrowserUploadStaging {
  readonly #batches = new Set<Batch>();
  readonly #handles = new WeakMap<StagedBrowserUpload, Batch>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #lifetime = new AbortController();
  readonly #readersGone = Promise.withResolvers<void>();
  #closed = false;
  #failed = false;
  #closing?: Promise<void>;

  private constructor(
    private readonly directory: string,
    private readonly folder: FileHandle,
    private readonly identity: BigIntStats,
  ) {}

  static async open(directory = BROWSER_UPLOAD_DIR): Promise<BrowserUploadStaging> {
    if (
      process.platform !== "linux" ||
      !isAbsolute(directory) ||
      normalize(directory) !== directory ||
      directory === "/" ||
      directory.endsWith("/") ||
      /[\p{Cc}\p{Cf}]/u.test(directory)
    )
      throw new BrowserUploadStagingError("identity");
    let folder: FileHandle | undefined;
    try {
      folder = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const stat = await folder.stat({ bigint: true });
      if (!privateFolder(stat) || !same(stat, await lstat(directory, { bigint: true })))
        throw new BrowserUploadStagingError("identity");
      return new BrowserUploadStaging(directory, folder, stat);
    } catch {
      await folder?.close();
      throw new BrowserUploadStagingError("identity");
    }
  }

  stage(raw: unknown, source: Readable, scope: UploadScope): Promise<StagedBrowserUpload> {
    return this.#track(this.#stage(raw, source, scope));
  }

  async #stage(raw: unknown, source: Readable, scope: UploadScope): Promise<StagedBrowserUpload> {
    const sourceClosed = finished(source, { cleanup: true }).catch(() => {});
    let batch: Batch | undefined;
    let complete = false;
    try {
      this.#check(scope);
      const parsed = BrowserUploadFiles.safeParse(raw);
      if (!parsed.success) throw new BrowserUploadStagingError("request");
      const bytes = parsed.data.reduce((total, info) => total + info.bytes, 0);
      if (
        [...this.#batches].reduce((total, entry) => total + entry.bytes, bytes) >
          BROWSER_UPLOAD_RETAINED_BYTES ||
        [...this.#batches].reduce(
          (total, entry) => total + entry.files.length,
          parsed.data.length,
        ) > BROWSER_UPLOAD_RETAINED_FILES
      )
        throw new BrowserUploadStagingError("capacity");
      batch = {
        files: parsed.data.map((info) => ({
          id: randomUUID(),
          info: Object.freeze(info),
          hash: createHash("sha256"),
          written: 0,
        })),
        bytes,
        state: "receiving",
      };
      // Reserve before reading or allocating. Pending and retained batches both count.
      this.#batches.add(batch);
      const current = AbortSignal.any([scope.signal, this.#lifetime.signal]);
      addAbortSignal(current, source);
      for (const file of batch.files) {
        this.#check(scope);
        await this.#root();
        this.#check(scope);
        const path = this.#child(file);
        await mkdir(path, { mode: 0o700 });
        file.directoryCreated = true;
        file.directory = await open(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        file.directoryStat = await file.directory.stat({ bigint: true });
        if (
          !privateFolder(file.directoryStat) ||
          !same(file.directoryStat, await lstat(path, { bigint: true }))
        )
          throw new BrowserUploadStagingError("identity");
        this.#check(scope);
        file.handle = await open(
          this.#file(file),
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        file.stat = await file.handle.stat({ bigint: true });
        if (!this.#regular(file.stat, 0o600n)) throw new BrowserUploadStagingError("identity");
      }
      let index = 0,
        received = 0;
      for await (const chunk of source) {
        this.#check(scope);
        if (!(chunk instanceof Uint8Array) || received + chunk.byteLength > bytes)
          throw new BrowserUploadStagingError("bytes");
        received += chunk.byteLength;
        let offset = 0;
        while (offset < chunk.byteLength) {
          let file = batch.files[index];
          while (file && file.written === file.info.bytes) file = batch.files[++index];
          if (!file?.handle) throw new BrowserUploadStagingError("bytes");
          const length = Math.min(
            CHUNK_BYTES,
            chunk.byteLength - offset,
            file.info.bytes - file.written,
          );
          // A stream producer cannot mutate a buffer while a native write is pending.
          const bytes = Buffer.from(chunk.subarray(offset, offset + length));
          let written = 0;
          while (written < bytes.length) {
            this.#check(scope);
            const result = await file.handle.write(
              bytes,
              written,
              bytes.length - written,
              file.written,
            );
            if (result.bytesWritten <= 0) throw new BrowserUploadStagingError("bytes");
            written += result.bytesWritten;
            file.written += result.bytesWritten;
          }
          file.hash.update(bytes);
          offset += length;
        }
      }
      this.#check(scope);
      if (received !== bytes) throw new BrowserUploadStagingError("bytes");
      for (const file of batch.files) {
        if (!file.handle || file.hash.digest("hex") !== file.info.sha256)
          throw new BrowserUploadStagingError("bytes");
        await file.handle.sync();
        await file.handle.chmod(0o400);
        file.stat = await file.handle.stat({ bigint: true });
        if (!this.#regular(file.stat, 0o400n) || file.stat.size !== BigInt(file.info.bytes))
          throw new BrowserUploadStagingError("identity");
        await file.handle.close();
        file.handle = await open(this.#file(file), constants.O_RDONLY | constants.O_NOFOLLOW);
        await this.#identity(file);
        this.#check(scope);
      }
      source.destroy();
      await sourceClosed;
      this.#check(scope);
      const handle = Object.freeze({ files: Object.freeze(batch.files.map((file) => file.info)) });
      this.#handles.set(handle, batch);
      batch.state = "staged";
      complete = true;
      return handle;
    } finally {
      source.destroy();
      await sourceClosed;
      if (batch && !complete) await this.#remove(batch);
    }
  }

  assign(
    handle: StagedBrowserUpload,
    scope: UploadScope,
    effect: (files: readonly string[], scope: UploadScope) => Promise<void>,
  ): Promise<void> {
    return this.#track(this.#assign(handle, scope, effect));
  }

  async #assign(
    handle: StagedBrowserUpload,
    scope: UploadScope,
    effect: (files: readonly string[], scope: UploadScope) => Promise<void>,
  ): Promise<void> {
    this.#check(scope);
    const batch = this.#staged(handle);
    batch.state = "verifying";
    try {
      const current: UploadScope = {
        signal: AbortSignal.any([scope.signal, this.#lifetime.signal]),
        check: () => this.#check(scope),
      };
      for (const file of batch.files) {
        await this.#identity(file);
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(CHUNK_BYTES);
        let offset = 0;
        while (offset < file.info.bytes) {
          current.check();
          const result = await file.handle?.read(
            buffer,
            0,
            Math.min(buffer.length, file.info.bytes - offset),
            offset,
          );
          if (!result?.bytesRead) throw new BrowserUploadStagingError("bytes");
          hash.update(buffer.subarray(0, result.bytesRead));
          offset += result.bytesRead;
        }
        if (hash.digest("hex") !== file.info.sha256) throw new BrowserUploadStagingError("bytes");
        await this.#identity(file);
      }
      await this.#root();
      current.check();
      const paths = Object.freeze(
        batch.files.map((file) => `${this.directory}/${file.id}/${file.info.name}`),
      );
      // A thrown/aborted effect can already have reached Chromium. Never reclaim
      // those files on an uncertain acknowledgement, or automatically replay it.
      batch.state = "retained";
      await effect(paths, current);
      current.check();
    } catch (error) {
      if (batch.state !== "retained") await this.#remove(batch);
      throw error;
    }
  }

  discard(handle: StagedBrowserUpload): Promise<void> {
    if (this.#closed || this.#failed)
      return Promise.reject(new BrowserUploadStagingError("closed"));
    let batch: Batch;
    try {
      batch = this.#staged(handle);
    } catch (error) {
      return Promise.reject(error);
    }
    batch.state = "discarding";
    return this.#track(this.#remove(batch));
  }

  // The runtime invokes this only after physical process-group retirement.
  readersExited(): void {
    this.#closed = true;
    this.#lifetime.abort();
    this.#readersGone.resolve();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#lifetime.abort();
    this.#closing = (async () => {
      await Promise.allSettled([...this.#pending]);
      if ([...this.#batches].some((batch) => batch.state === "retained"))
        await this.#readersGone.promise;
      try {
        const results = await Promise.allSettled(
          [...this.#batches].map((batch) => this.#remove(batch)),
        );
        if (this.#failed || results.some((result) => result.status === "rejected"))
          throw new BrowserUploadStagingError("identity");
      } finally {
        await this.folder.close();
      }
    })();
    void this.#closing.catch(() => {});
    return this.#closing;
  }

  #track<Value>(task: Promise<Value>): Promise<Value> {
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => this.#pending.delete(task),
    );
    return task;
  }
  #staged(handle: StagedBrowserUpload): Batch {
    const batch = this.#handles.get(handle);
    if (!batch || !this.#batches.has(batch) || batch.state !== "staged")
      throw new BrowserUploadStagingError("stale");
    return batch;
  }
  #check(scope: UploadScope): void {
    scope.signal.throwIfAborted();
    scope.check();
    if (this.#closed || this.#failed) throw new BrowserUploadStagingError("closed");
  }
  #child(file: FileEntry): string {
    return `/proc/self/fd/${this.folder.fd}/${file.id}`;
  }
  #file(file: FileEntry): string {
    if (!file.directory) throw new BrowserUploadStagingError("identity");
    return `/proc/self/fd/${file.directory.fd}/${file.info.name}`;
  }
  #regular(stat: BigIntStats, mode: bigint): boolean {
    return (
      stat.isFile() &&
      stat.nlink === 1n &&
      stat.uid === this.identity.uid &&
      (stat.mode & 0o7777n) === mode
    );
  }
  async #root(): Promise<void> {
    const current = await this.folder.stat({ bigint: true });
    if (
      !privateFolder(current) ||
      !same(current, this.identity) ||
      !same(current, await lstat(this.directory, { bigint: true }))
    )
      throw new BrowserUploadStagingError("identity");
  }
  async #identity(file: FileEntry): Promise<void> {
    await this.#root();
    if (!file.handle || !file.stat || !file.directory || !file.directoryStat)
      throw new BrowserUploadStagingError("identity");
    const folder = await file.directory.stat({ bigint: true });
    const current = await file.handle.stat({ bigint: true });
    if (
      !privateFolder(folder) ||
      !same(folder, file.directoryStat) ||
      !same(folder, await lstat(this.#child(file), { bigint: true })) ||
      !this.#regular(current, 0o400n) ||
      !unchanged(current, file.stat) ||
      !unchanged(current, await lstat(this.#file(file), { bigint: true }))
    )
      throw new BrowserUploadStagingError("identity");
  }

  async #remove(batch: Batch): Promise<void> {
    let failed = false;
    for (const file of batch.files) {
      try {
        if (file.directoryCreated && !file.directory)
          throw new BrowserUploadStagingError("identity");
        if (file.directory) {
          const folder = await file.directory.stat({ bigint: true });
          if (
            !file.directoryStat ||
            !privateFolder(folder) ||
            !same(folder, file.directoryStat) ||
            !same(folder, await lstat(this.#child(file), { bigint: true }))
          )
            throw new BrowserUploadStagingError("identity");
          if (file.stat) {
            const current = await lstat(this.#file(file), { bigint: true });
            if (!current.isFile() || current.nlink !== 1n || !same(current, file.stat))
              throw new BrowserUploadStagingError("identity");
            await unlink(this.#file(file));
          }
          await rmdir(this.#child(file));
        }
      } catch {
        failed = true;
      } finally {
        try {
          await file.handle?.close();
        } catch {
          failed = true;
        }
        try {
          await file.directory?.close();
        } catch {
          failed = true;
        }
      }
    }
    if (failed) {
      this.#failed = true;
      this.#lifetime.abort();
      throw new BrowserUploadStagingError("identity");
    }
    this.#batches.delete(batch);
  }
}
