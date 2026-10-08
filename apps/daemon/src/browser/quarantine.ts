import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { addAbortSignal, type Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { ULID_PATTERN, ulid } from "@localdot/protocol";
import { BrowserDownloadOffer } from "../../../../packages/protocol/src/browser-downloads.ts";
import {
  DOWNLOAD_BYTES,
  type PlacementRequest,
  PlacementResult,
  QUARANTINE_BYTES,
  QUARANTINE_INGESTS,
  QUARANTINE_ITEMS,
  QUARANTINE_TTL_MS,
  QuarantineItem,
  QuarantineOrigin,
  QuarantineRelease,
  safeDownloadName,
} from "../../../../packages/protocol/src/quarantine.ts";
import type { TransferLease } from "../agent/transfers.ts";
import { downloadKind } from "./download-kind.ts";

type Scope = Pick<TransferLease, "signal" | "check">;
type Limits = { file: number; total: number; ingests: number; items: number; ttl: number };
export interface QuarantineOptions {
  now?: () => number;
  id?: () => string;
  limits?: Partial<Limits>;
}
export type PlaceDownload = (
  request: PlacementRequest,
  chunks: AsyncIterable<Uint8Array>,
  scope: Scope,
  // A persisted pending attempt may already have placed the file. Missing destination
  // evidence must not silently authorize a new placement after restart or a lost reply.
  options: Readonly<{ reconcileOnly: boolean }>,
) => Promise<PlacementResult>;
export class QuarantineError extends Error {
  constructor(
    readonly code:
      | "request"
      | "missing"
      | "stale"
      | "busy"
      | "capacity"
      | "too-large"
      | "corrupt"
      | "aborted"
      | "unavailable",
  ) {
    super(`Download quarantine refused: ${code}`);
  }
}
const BLOCK_BYTES = 64 * 1024;
const METADATA_BYTES = 16 * 1024;
const defaults: Limits = {
  file: DOWNLOAD_BYTES,
  total: QUARANTINE_BYTES,
  ingests: QUARANTINE_INGESTS,
  items: QUARANTINE_ITEMS,
  ttl: QUARANTINE_TTL_MS,
};
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats) =>
  same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const absent = (error: unknown) =>
  !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
function checkedId(id: string): void {
  if (!ULID_PATTERN.test(id)) throw new QuarantineError("request");
}
function check(scope: Scope): void {
  if (scope.signal.aborted) throw new QuarantineError("aborted");
  scope.check();
}
function directory(stat: Stats, uid: number): void {
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700)
    throw new QuarantineError("corrupt");
}
function file(stat: Stats, uid: number): void {
  if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
    throw new QuarantineError("corrupt");
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function browserKey(origin: QuarantineOrigin, guid: string): string {
  return `${origin.browserCellId}:${origin.browserInstance}:${guid}`;
}

// Host-only storage. No filesystem path is returned to a browser, model, or caller.
// The desktop placement owner must verify the stream's digest before committing it.
export class QuarantineStore {
  readonly #items = new Map<string, QuarantineItem>();
  readonly #folders = new Map<string, Stats>();
  readonly #busy = new Set<string>();
  readonly #browserIncoming = new Set<string>();
  readonly #limits: Limits;
  readonly #now: () => number;
  readonly #id: () => string;
  #reserved = 0;
  #incoming = 0;
  #verifying = 0;
  #failed = false;

  private constructor(
    private readonly root: string,
    private readonly rootStat: Stats,
    private readonly uid: number,
    options: QuarantineOptions,
  ) {
    this.#limits = { ...defaults, ...options.limits };
    for (const key of Object.keys(defaults) as (keyof Limits)[]) {
      const value = this.#limits[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key])
        throw new QuarantineError("request");
    }
    if (this.#limits.total < this.#limits.file) throw new QuarantineError("request");
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? ulid;
  }

  static async open(home: string, options: QuarantineOptions = {}): Promise<QuarantineStore> {
    const uid = process.getuid?.();
    if (uid === undefined) throw new QuarantineError("unavailable");
    const root = join(await realpath(home), "quarantine");
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
        throw error;
    }
    const stat = await lstat(root);
    directory(stat, uid);
    const store = new QuarantineStore(root, stat, uid, options);
    await store.#recover();
    return store;
  }

  list(parentCellId: string): QuarantineItem[] {
    this.#available();
    checkedId(parentCellId);
    return [...this.#items.values()]
      .filter((item) => item.parentCellId === parentCellId)
      .sort((a, b) => b.id.localeCompare(a.id))
      .map((item) => structuredClone(item));
  }

  get(parentCellId: string, id: string): QuarantineItem | undefined {
    this.#available();
    checkedId(parentCellId);
    checkedId(id);
    const item = this.#items.get(id);
    return item?.parentCellId === parentCellId ? structuredClone(item) : undefined;
  }

  async ingest(raw: unknown, source: Readable, scope: Scope): Promise<QuarantineItem> {
    // A caller-supplied stream is owned even when preflight rejects the request.
    const sourceClosed = finished(source, { cleanup: true }).catch(() => {});
    try {
      const parsed = QuarantineOrigin.safeParse(raw);
      if (!parsed.success) throw new QuarantineError("request");
      return await this.#ingest(parsed.data, async () => source, scope);
    } finally {
      source.destroy();
      await sourceClosed;
    }
  }

  async ingestBrowser(
    raw: unknown,
    openSource: () => Promise<Readable>,
    scope: Scope,
  ): Promise<QuarantineItem> {
    this.#available();
    check(scope);
    const parsed = BrowserDownloadOffer.safeParse(raw);
    if (!parsed.success || safeDownloadName(parsed.data.origin.name) !== parsed.data.origin.name)
      throw new QuarantineError("request");
    const offer = parsed.data;
    if (offer.bytes > this.#limits.file) throw new QuarantineError("too-large");
    const key = browserKey(offer.origin, offer.guid);
    if (this.#browserIncoming.has(key)) throw new QuarantineError("busy");
    this.#browserIncoming.add(key);
    try {
      const item = [...this.#items.values()].find(
        (candidate) =>
          candidate.browserDownloadGuid !== undefined &&
          browserKey(candidate, candidate.browserDownloadGuid) === key,
      );
      if (item) return await this.#existingBrowser(item, offer, scope);
      return await this.#ingest(offer.origin, openSource, scope, offer);
    } finally {
      this.#browserIncoming.delete(key);
    }
  }

  async #existingBrowser(
    item: QuarantineItem,
    offer: BrowserDownloadOffer,
    scope: Scope,
  ): Promise<QuarantineItem> {
    if (
      item.bytes !== offer.bytes ||
      item.sha256 !== offer.sha256 ||
      Object.entries(offer.origin).some(([key, value]) => Reflect.get(item, key) !== value)
    )
      throw new QuarantineError("corrupt");
    if (this.#busy.has(item.id)) throw new QuarantineError("busy");
    if (this.#incoming + this.#verifying >= this.#limits.ingests)
      throw new QuarantineError("capacity");
    this.#busy.add(item.id);
    this.#verifying++;
    let handle: FileHandle | undefined;
    try {
      await this.#current(item);
      check(scope);
      if (item.state === "failed") throw new QuarantineError("corrupt");
      if (item.state === "held" || item.state === "releasing") {
        // A durable metadata record alone must not authorize deleting the browser's
        // copy: verify that the host still owns the complete expected payload.
        const payload = await this.#payload(item);
        handle = payload.handle;
        const hash = createHash("sha256");
        for await (const chunk of this.#readPayload(item, handle, payload.stat, scope))
          hash.update(chunk);
        if (hash.digest("hex") !== item.sha256) throw new QuarantineError("corrupt");
        await this.#current(item);
        check(scope);
      }
      // Terminal release/discard decisions are retained; retries cannot resurrect them.
      return structuredClone(item);
    } finally {
      try {
        await handle?.close();
      } finally {
        this.#busy.delete(item.id);
        this.#verifying--;
      }
    }
  }

  async #ingest(
    origin: QuarantineOrigin,
    openSource: () => Promise<Readable>,
    scope: Scope,
    offer?: BrowserDownloadOffer,
  ): Promise<QuarantineItem> {
    this.#available();
    check(scope);
    if (
      this.#incoming + this.#verifying >= this.#limits.ingests ||
      this.#items.size + this.#incoming >= this.#limits.items ||
      this.#bytes() + this.#reserved + this.#limits.file > this.#limits.total
    )
      throw new QuarantineError("capacity");
    const id = this.#id();
    checkedId(id);
    if (this.#items.has(id) || this.#folders.has(id)) throw new QuarantineError("stale");
    this.#reserved += this.#limits.file;
    this.#incoming++;
    let handle: FileHandle | undefined;
    let created = false;
    let committed = false;
    let source: Readable | undefined;
    let sourceClosed: Promise<void> | undefined;
    try {
      // Reserve before opening the browser transport. A duplicate never opens it.
      source = await openSource();
      sourceClosed = finished(source, { cleanup: true }).catch(() => {});
      const chunks = addAbortSignal(scope.signal, source);
      await this.#directories();
      check(scope);
      const folder = join(this.root, id);
      await mkdir(folder, { mode: 0o700 });
      created = true;
      const stat = await lstat(folder);
      directory(stat, this.uid);
      this.#folders.set(id, stat);
      await this.#syncDirectory(this.root);
      await this.#directories(id);
      check(scope);
      handle = await open(
        join(folder, "payload.part"),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      file(await handle.stat(), this.uid);
      const hash = createHash("sha256");
      const prefix: Buffer[] = [];
      let prefixBytes = 0;
      let bytes = 0;
      for await (const rawChunk of chunks) {
        check(scope);
        if (!(rawChunk instanceof Uint8Array)) throw new QuarantineError("request");
        if (bytes + rawChunk.length > this.#limits.file) throw new QuarantineError("too-large");
        if (offer && bytes + rawChunk.length > offer.bytes) throw new QuarantineError("corrupt");
        const chunk = Buffer.from(rawChunk);
        bytes += chunk.length;
        hash.update(chunk);
        if (prefixBytes < 64) {
          const head = Buffer.from(chunk.subarray(0, 64 - prefixBytes));
          prefix.push(head);
          prefixBytes += head.length;
        }
        for (let offset = 0; offset < chunk.length; ) {
          check(scope);
          const written = await handle.write(chunk, offset, chunk.length - offset);
          if (written.bytesWritten <= 0) throw new QuarantineError("unavailable");
          offset += written.bytesWritten;
        }
      }
      check(scope);
      const sha256 = hash.digest("hex");
      if (offer && (offer.bytes !== bytes || offer.sha256 !== sha256))
        throw new QuarantineError("corrupt");
      await handle.sync();
      const written = await handle.stat();
      file(written, this.uid);
      if (written.size !== bytes) throw new QuarantineError("corrupt");
      await handle.close();
      handle = undefined;
      await this.#directories(id);
      check(scope);
      await rename(join(folder, "payload.part"), join(folder, "payload"));
      await this.#syncDirectory(folder);
      check(scope);
      const name = safeDownloadName(origin.name);
      const item = QuarantineItem.parse({
        ...origin,
        ...(offer ? { browserDownloadGuid: offer.guid } : {}),
        name,
        id,
        version: 1,
        bytes,
        sha256,
        kind: downloadKind(name, Buffer.concat(prefix)),
        createdAt: this.#now(),
        revision: 1,
        state: "held",
      });
      await this.#write(item);
      committed = true;
      check(scope);
      return structuredClone(item);
    } finally {
      try {
        source?.destroy();
        await sourceClosed;
        await handle?.close();
        if (created && !committed && !this.#items.has(id) && !this.#failed) await this.#orphan(id);
      } finally {
        this.#reserved -= this.#limits.file;
        this.#incoming--;
      }
    }
  }

  async release(
    parentCellId: string,
    id: string,
    raw: unknown,
    scope: Scope,
    place: PlaceDownload,
  ): Promise<QuarantineItem> {
    const initial = this.#item(parentCellId, id);
    check(scope);
    const parsed = QuarantineRelease.safeParse(raw);
    if (!parsed.success) throw new QuarantineError("request");
    this.#match(initial, parsed.data);
    if (this.#busy.has(id)) throw new QuarantineError("busy");
    this.#busy.add(id);
    let handle: FileHandle | undefined;
    try {
      await this.#current(initial);
      check(scope);
      if (initial.state === "released") return structuredClone(initial);
      if (initial.state !== "held" && initial.state !== "releasing")
        throw new QuarantineError("stale");
      if (initial.state === "held" && this.#now() - initial.createdAt >= this.#limits.ttl)
        throw new QuarantineError("stale");
      const payload = await this.#payload(initial);
      handle = payload.handle;
      const hash = createHash("sha256");
      for await (const chunk of this.#readPayload(initial, handle, payload.stat, scope))
        hash.update(chunk);
      if (hash.digest("hex") !== initial.sha256) throw new QuarantineError("corrupt");
      await this.#current(initial);
      check(scope);
      let releasing: QuarantineItem = initial;
      if (initial.state === "held") {
        const attempt = {
          ...initial,
          state: "releasing",
          revision: initial.revision + 1,
          release: { transferId: this.#id(), approvedRevision: initial.revision },
        };
        Reflect.deleteProperty(attempt, "recovery");
        releasing = QuarantineItem.parse(attempt);
      }
      if (releasing.state !== "releasing") throw new QuarantineError("corrupt");
      if (initial.state !== "releasing") releasing = await this.#write(releasing);
      if (releasing.state !== "releasing") throw new QuarantineError("corrupt");
      check(scope);
      const request: PlacementRequest = frozen({
        transferId: releasing.release.transferId,
        parentCellId,
        name: initial.name,
        bytes: initial.bytes,
        sha256: initial.sha256,
      });
      const receipt = PlacementResult.parse(
        await place(
          request,
          this.#readPayload(releasing, handle, payload.stat, scope),
          scope,
          Object.freeze({ reconcileOnly: initial.state === "releasing" }),
        ),
      );
      check(scope);
      await this.#current(releasing);
      for (const key of Object.keys(request) as (keyof PlacementRequest)[]) {
        if (receipt[key] !== request[key]) throw new QuarantineError("corrupt");
      }
      if ("status" in receipt) {
        // The desktop tombstoned this identity while holding its exclusive placement lock.
        // Return to held with a new revision: the old approval cannot admit a new attempt.
        const retry = {
          ...releasing,
          state: "held",
          revision: releasing.revision + 1,
          recovery: { approvedRevision: releasing.release.approvedRevision, result: receipt },
        };
        Reflect.deleteProperty(retry, "release");
        check(scope);
        return structuredClone(await this.#write(QuarantineItem.parse(retry)));
      }
      const released = QuarantineItem.parse({
        ...releasing,
        state: "released",
        revision: releasing.revision + 1,
        receipt,
      });
      check(scope);
      await this.#write(released);
      await handle.close();
      handle = undefined;
      await this.#removePayload(released.id);
      return structuredClone(released);
    } finally {
      await handle?.close();
      this.#busy.delete(id);
    }
  }

  async discard(
    parentCellId: string,
    id: string,
    revision: number,
    scope: Scope,
  ): Promise<QuarantineItem> {
    const item = this.#item(parentCellId, id);
    check(scope);
    if (this.#busy.has(id)) throw new QuarantineError("busy");
    if (item.revision !== revision || (item.state !== "held" && item.state !== "failed"))
      throw new QuarantineError("stale");
    this.#busy.add(id);
    try {
      await this.#current(item);
      check(scope);
      const raw = { ...item, state: "discarded", revision: item.revision + 1 };
      Reflect.deleteProperty(raw, "reason");
      Reflect.deleteProperty(raw, "recovery");
      const next = QuarantineItem.parse(raw);
      check(scope);
      await this.#write(next);
      await this.#removePayload(id);
      return structuredClone(next);
    } finally {
      this.#busy.delete(id);
    }
  }

  async expire(scope: Scope): Promise<number> {
    this.#available();
    check(scope);
    let count = 0;
    for (const item of [...this.#items.values()]) {
      check(scope);
      if (
        item.state !== "held" ||
        this.#busy.has(item.id) ||
        this.#now() - item.createdAt < this.#limits.ttl
      )
        continue;
      await this.discard(item.parentCellId, item.id, item.revision, scope);
      count++;
    }
    return count;
  }

  #available(): void {
    if (this.#failed) throw new QuarantineError("unavailable");
  }
  #item(parent: string, id: string): QuarantineItem {
    this.#available();
    checkedId(parent);
    checkedId(id);
    const item = this.#items.get(id);
    if (!item || item.parentCellId !== parent) throw new QuarantineError("missing");
    return item;
  }
  #bytes(): number {
    return [...this.#items.values()].reduce(
      (sum, item) => sum + (["held", "releasing", "failed"].includes(item.state) ? item.bytes : 0),
      0,
    );
  }
  #match(item: QuarantineItem, request: QuarantineRelease): void {
    const revision =
      item.state === "releasing" || item.state === "released"
        ? item.release.approvedRevision
        : item.revision;
    if (
      request.revision !== revision ||
      request.bytes !== item.bytes ||
      request.sha256 !== item.sha256 ||
      request.name !== item.name ||
      !["held", "releasing", "released"].includes(item.state)
    )
      throw new QuarantineError("stale");
  }
  async #directories(id?: string): Promise<void> {
    this.#available();
    const root = await lstat(this.root);
    directory(root, this.uid);
    if (!same(root, this.rootStat)) throw new QuarantineError("corrupt");
    if (id !== undefined) {
      checkedId(id);
      const stat = await lstat(join(this.root, id));
      directory(stat, this.uid);
      const expected = this.#folders.get(id);
      if (!expected || !same(stat, expected)) throw new QuarantineError("corrupt");
    }
  }
  async #syncDirectory(path: string): Promise<void> {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      directory(await handle.stat(), this.uid);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async #current(expected: QuarantineItem): Promise<void> {
    const current = await this.#metadata(expected.id);
    if (
      JSON.stringify(current) !== JSON.stringify(expected) ||
      this.#items.get(expected.id) !== expected
    )
      throw new QuarantineError("stale");
  }
  async #metadata(id: string): Promise<QuarantineItem> {
    await this.#directories(id);
    const handle = await open(
      join(this.root, id, "item.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      file(before, this.uid);
      if (before.size > METADATA_BYTES) throw new QuarantineError("corrupt");
      const value = await handle.readFile("utf8");
      if (!unchanged(before, await handle.stat())) throw new QuarantineError("corrupt");
      await this.#directories(id);
      const item = QuarantineItem.parse(JSON.parse(value));
      if (item.id !== id) throw new QuarantineError("corrupt");
      return item;
    } finally {
      await handle.close();
    }
  }
  async #write(raw: QuarantineItem): Promise<QuarantineItem> {
    const item = frozen(QuarantineItem.parse(raw));
    await this.#directories(item.id);
    const folder = join(this.root, item.id);
    const temp = join(folder, `item.${randomUUID()}.part`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let renamed = false;
    try {
      await handle.writeFile(`${JSON.stringify(item)}\n`, "utf8");
      await handle.sync();
      file(await handle.stat(), this.uid);
      await this.#directories(item.id);
      await rename(temp, join(folder, "item.json"));
      renamed = true;
      await this.#syncDirectory(folder);
      this.#items.set(item.id, item);
      return item;
    } catch (error) {
      if (renamed) this.#failed = true;
      throw error;
    } finally {
      await handle.close();
      if (!renamed)
        await unlink(temp).catch((error) => {
          if (!absent(error)) throw error;
        });
    }
  }
  async #payload(item: QuarantineItem): Promise<{ handle: FileHandle; stat: Stats }> {
    await this.#directories(item.id);
    const path = join(this.root, item.id, "payload");
    const before = await lstat(path);
    file(before, this.uid);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      file(stat, this.uid);
      if (!same(before, stat) || stat.size !== item.bytes) throw new QuarantineError("corrupt");
      await this.#directories(item.id);
      return { handle, stat };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async *#readPayload(
    item: QuarantineItem,
    handle: FileHandle,
    stat: Stats,
    scope: Scope,
  ): AsyncGenerator<Uint8Array> {
    let position = 0;
    while (position < item.bytes) {
      check(scope);
      const buffer = Buffer.alloc(Math.min(BLOCK_BYTES, item.bytes - position));
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (!result.bytesRead) throw new QuarantineError("corrupt");
      position += result.bytesRead;
      check(scope);
      yield buffer.subarray(0, result.bytesRead);
    }
    check(scope);
    if (!unchanged(stat, await handle.stat())) throw new QuarantineError("corrupt");
    const current = await lstat(join(this.root, item.id, "payload"));
    if (!same(stat, current)) throw new QuarantineError("corrupt");
    file(current, this.uid);
    await this.#directories(item.id);
    check(scope);
  }
  async #removePayload(id: string): Promise<void> {
    await this.#directories(id);
    const path = join(this.root, id, "payload");
    try {
      file(await lstat(path), this.uid);
      await unlink(path);
      await this.#syncDirectory(join(this.root, id));
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  async #orphan(id: string): Promise<void> {
    await this.#directories(id);
    const folder = join(this.root, id);
    const names = await readdir(folder);
    if (
      names.some(
        (name) =>
          !["payload", "payload.part"].includes(name) && !/^item\.[0-9a-f-]{36}\.part$/u.test(name),
      )
    )
      throw new QuarantineError("corrupt");
    for (const name of names) file(await lstat(join(folder, name)), this.uid);
    for (const name of names) await unlink(join(folder, name));
    await rmdir(folder);
    this.#folders.delete(id);
    await this.#syncDirectory(this.root);
  }
  async #recover(): Promise<void> {
    await this.#directories();
    const ids = await readdir(this.root);
    if (ids.length > this.#limits.items) throw new QuarantineError("capacity");
    const browserKeys = new Set<string>();
    for (const id of ids) {
      checkedId(id);
      const folder = await lstat(join(this.root, id));
      directory(folder, this.uid);
      this.#folders.set(id, folder);
      let item: QuarantineItem;
      try {
        item = await this.#metadata(id);
      } catch (error) {
        if (!absent(error)) throw error;
        await this.#orphan(id);
        continue;
      }
      if (item.browserDownloadGuid !== undefined) {
        const key = browserKey(item, item.browserDownloadGuid);
        if (browserKeys.has(key)) throw new QuarantineError("corrupt");
        browserKeys.add(key);
      }
      this.#items.set(id, frozen(item));
      if (item.state === "held" || item.state === "releasing" || item.state === "failed") {
        const payload = await this.#payload(item);
        await payload.handle.close();
      } else await this.#removePayload(id);
      if (this.#bytes() > this.#limits.total) throw new QuarantineError("capacity");
    }
    await this.expire({ signal: new AbortController().signal, check: () => {} });
  }
}
