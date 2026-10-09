import { inflateRawSync } from "node:zlib";

export class ZipRefused extends Error {
  constructor(readonly reason: "failed" | "too_large") {
    super(reason);
  }
}
interface Entry {
  method: number;
  flags: number;
  compressed: number;
  size: number;
  offset: number;
}
const MAX_ENTRIES = 10_000;

// The entries of a whole zip archive in memory, by name. ZIP64 and encrypted entries are refused;
// an entry is inflated only on request and never past the caller's cap, whatever it declares.
export class Zip {
  readonly #bytes: Buffer;
  readonly #entries = new Map<string, Entry>();

  constructor(bytes: Buffer) {
    this.#bytes = bytes;
    const end = endOfDirectory(bytes);
    const count = bytes.readUInt16LE(end + 10);
    let at = bytes.readUInt32LE(end + 16);
    if (count > MAX_ENTRIES || at === 0xffffffff) throw new ZipRefused("failed");
    for (let i = 0; i < count; i++) {
      if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50)
        throw new ZipRefused("failed");
      const nameLength = bytes.readUInt16LE(at + 28);
      const skip = nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
      if (at + 46 + skip > bytes.length) throw new ZipRefused("failed");
      this.#entries.set(bytes.toString("utf8", at + 46, at + 46 + nameLength), {
        flags: bytes.readUInt16LE(at + 8),
        method: bytes.readUInt16LE(at + 10),
        compressed: bytes.readUInt32LE(at + 20),
        size: bytes.readUInt32LE(at + 24),
        offset: bytes.readUInt32LE(at + 42),
      });
      at += 46 + skip;
    }
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  // One entry's bytes, or undefined when the archive has no such entry.
  read(name: string, max: number): Buffer | undefined {
    const entry = this.#entries.get(name);
    if (!entry) return undefined;
    const b = this.#bytes;
    if (
      entry.flags & 1 ||
      entry.offset + 30 > b.length ||
      b.readUInt32LE(entry.offset) !== 0x04034b50
    )
      throw new ZipRefused("failed");
    const start =
      entry.offset + 30 + b.readUInt16LE(entry.offset + 26) + b.readUInt16LE(entry.offset + 28);
    if (start + entry.compressed > b.length) throw new ZipRefused("failed");
    if (entry.size > max) throw new ZipRefused("too_large");
    const data = b.subarray(start, start + entry.compressed);
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw new ZipRefused("failed");
    try {
      return inflateRawSync(data, { maxOutputLength: max });
    } catch (error) {
      throw new ZipRefused(
        (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "too_large" : "failed",
      );
    }
  }
}

function endOfDirectory(b: Buffer): number {
  for (let at = b.length - 22; at >= Math.max(0, b.length - 22 - 0xffff); at--)
    if (b.readUInt32LE(at) === 0x06054b50) return at;
  throw new ZipRefused("failed");
}
