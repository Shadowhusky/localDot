import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { safeFileName } from "../protocol/file-name.ts";
import { ULID_PATTERN } from "../protocol/ids.ts";
import { MAX_DOWNLOAD_BYTES } from "../protocol/browserd.ts";
import {
  QUARANTINE_MAX_TOTAL_BYTES,
  QUARANTINE_TTL_MS,
  QuarantineItem,
} from "../protocol/quarantine.ts";
import { downloadKind } from "./download-kind.ts";

export class QuarantineError extends Error {
  constructor(
    readonly status: 404 | 409 | 410 | 413 | 507,
    message: string,
  ) {
    super(message);
    this.name = "QuarantineError";
  }
}

export interface AddMeta {
  cellId: string;
  sessionId?: string;
  name: string; // as browserd reported it; cleaned again here
  source: string; // host
}

// The quarantine (P8-R16): <home>/quarantine/<id>/{blob,item.json}, folders 0700 and files 0600,
// on the Mac, where no cell can reach. A file arrives whole or not at all (temp file, then
// rename); the folder is the unit of discard.
export class QuarantineStore {
  readonly #dir: string;
  readonly #items = new Map<string, QuarantineItem>();

  constructor(
    home: string,
    private readonly ulid: () => string,
    private readonly now: () => number = Date.now,
    private readonly limits = { file: MAX_DOWNLOAD_BYTES, total: QUARANTINE_MAX_TOTAL_BYTES },
  ) {
    this.#dir = join(home, "quarantine");
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    for (const id of readdirSync(this.#dir)) {
      if (!ULID_PATTERN.test(id)) continue;
      try {
        const item = QuarantineItem.parse(JSON.parse(readFileSync(join(this.#dir, id, "item.json"), "utf8")));
        if (item.id === id && existsSync(this.blobPath(id))) this.#items.set(id, item);
        else rmSync(join(this.#dir, id), { recursive: true, force: true });
      } catch {
        // A crash between the blob and its record: the folder is incomplete.
        rmSync(join(this.#dir, id), { recursive: true, force: true });
      }
    }
  }

  list(cellId?: string): QuarantineItem[] {
    return [...this.#items.values()]
      .filter((i) => !cellId || i.cellId === cellId)
      .sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  get(id: string): QuarantineItem | undefined {
    return ULID_PATTERN.test(id) ? this.#items.get(id) : undefined;
  }

  blobPath(id: string): string {
    if (!ULID_PATTERN.test(id)) throw new QuarantineError(404, "no such download");
    return join(this.#dir, id, "blob");
  }

  heldBytes(): number {
    let sum = 0;
    for (const i of this.#items.values()) if (i.state !== "discarded") sum += i.bytes;
    return sum;
  }

  // Streams a download in, hashing as it goes; the caps hold while it streams, not after.
  async add(chunks: AsyncIterable<Uint8Array>, meta: AddMeta): Promise<QuarantineItem> {
    const id = this.ulid();
    const folder = join(this.#dir, id);
    mkdirSync(folder, { mode: 0o700 });
    const temp = join(folder, "blob.part");
    const fd = openSync(temp, "wx", 0o600);
    const hash = createHash("sha256");
    const head: Buffer[] = [];
    let headBytes = 0;
    let bytes = 0;
    try {
      const room = this.limits.total - this.heldBytes();
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > this.limits.file) throw new QuarantineError(413, "the download is larger than 1 GiB");
        if (bytes > room) throw new QuarantineError(507, "the quarantine is full");
        hash.update(chunk);
        if (headBytes < 64) {
          head.push(Buffer.from(chunk.subarray(0, 64 - headBytes)));
          headBytes += Math.min(chunk.length, 64 - headBytes);
        }
        writeSync(fd, chunk);
      }
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      rmSync(folder, { recursive: true, force: true });
      throw err;
    }
    closeSync(fd);
    const name = safeFileName(meta.name);
    const item: QuarantineItem = QuarantineItem.parse({
      id,
      cellId: meta.cellId,
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
      name,
      bytes,
      sha256: hash.digest("hex"),
      kind: downloadKind(name, Buffer.concat(head)),
      source: meta.source.slice(0, 253),
      createdAt: new Date(this.now()).toISOString(),
      state: "held",
    });
    renameSync(temp, join(folder, "blob"));
    this.#write(item);
    return item;
  }

  mark(id: string, change: Pick<QuarantineItem, "state"> & Partial<Pick<QuarantineItem, "releasedTo" | "releasedPath">>): QuarantineItem {
    const item = this.get(id);
    if (!item) throw new QuarantineError(404, "no such download");
    if (item.state === "discarded") throw new QuarantineError(410, "the download was discarded");
    const next = QuarantineItem.parse({ ...item, ...change });
    if (next.state === "discarded") rmSync(this.blobPath(id), { force: true });
    this.#write(next);
    return next;
  }

  // After the TTL a held download is discarded (returned, for its event), and a released or
  // discarded one is forgotten with its folder.
  expire(): QuarantineItem[] {
    const cutoff = this.now() - QUARANTINE_TTL_MS;
    const discarded: QuarantineItem[] = [];
    for (const item of [...this.#items.values()]) {
      if (Date.parse(item.createdAt) >= cutoff) continue;
      if (item.state === "held") discarded.push(this.mark(item.id, { state: "discarded" }));
      else {
        rmSync(join(this.#dir, item.id), { recursive: true, force: true });
        this.#items.delete(item.id);
      }
    }
    return discarded;
  }

  #write(item: QuarantineItem): void {
    const file = join(this.#dir, item.id, "item.json");
    const temp = `${file}.part`;
    const fd = openSync(temp, "w", 0o600);
    writeSync(fd, JSON.stringify(item));
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temp, file);
    this.#items.set(item.id, item);
  }
}
