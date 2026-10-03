import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  type FileChangeResult,
  type FileEntry,
  type FileListResult,
  type FileReadResult,
  unifiedDiff,
} from "@localdot/protocol";
import { PathError, resolveInHome } from "./home.ts";

export class FileToolError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
    this.name = "FileToolError";
  }
}

const MAX_LIST = 500;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;

function limit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRANSFER_BYTES) {
    throw new FileToolError(400, "invalid byte limit");
  }
}

function inHome(home: string, path: string): string {
  try {
    return resolveInHome(home, path);
  } catch (error) {
    if (error instanceof PathError) throw new FileToolError(400, error.message);
    throw error;
  }
}

function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function checked(home: string, path: string, expected: string): void {
  if (inHome(home, path) !== expected) throw new FileToolError(409, "the path changed; try again");
}

export function displayPath(home: string, real: string): string {
  const rel = relative(realpathSync(home), real);
  return rel === "" ? "~" : `~/${rel}`;
}

function openFile(home: string, path: string): { real: string; fd: number; stat: Stats } {
  // O_NOFOLLOW, inode checks and re-resolution defend final-component changes. This is not
  // openat-style confinement: a concurrently replaced ancestor remains a documented TOCTOU limit.
  const real = inHome(home, path);
  const before = lstatSync(real, { throwIfNoEntry: false });
  if (!before) throw new FileToolError(404, `${path} does not exist`);
  if (!before.isFile()) throw new FileToolError(409, `${path} is not a regular file`);
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new FileToolError(409, `${path} could not be opened safely`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !same(stat, before))
      throw new FileToolError(409, "the file changed; try again");
    checked(home, path, real);
    return { real, fd, stat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// Whole-file write/edit validation scans at most 4 MiB before replacing existing text.
// Prefix reads below have a separate bound and do not inspect an unseen suffix.
function textBytes(fd: number): Buffer {
  const parts: Buffer[] = [];
  let count = 0;
  while (true) {
    const block = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, MAX_TEXT_BYTES + 1 - count));
    const n = readSync(fd, block, 0, block.length, null);
    if (n === 0) break;
    count += n;
    if (count > MAX_TEXT_BYTES) throw new FileToolError(413, "file exceeds the 4 MiB text limit");
    parts.push(block.subarray(0, n));
  }
  return Buffer.concat(parts, count);
}

function decode(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function readFile(home: string, path: string, maxBytes: number): FileReadResult {
  limit(maxBytes);
  const file = openFile(home, path);
  try {
    const parts: Buffer[] = [];
    let sampledBytes = 0;
    while (sampledBytes < maxBytes) {
      const block = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, maxBytes - sampledBytes));
      const n = readSync(file.fd, block, 0, block.length, null);
      if (n === 0) break;
      sampledBytes += n;
      parts.push(block.subarray(0, n));
    }
    const prefix = Buffer.concat(parts, sampledBytes);
    let content = "";
    let binary = prefix.includes(0);
    if (!binary) {
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        content = decoder.decode(prefix, { stream: true });
        // The decoder withholds an incomplete final code point. Read only its remaining 1–3
        // continuation bytes to distinguish valid truncation from invalid UTF-8 or premature EOF.
        // Its completed character is intentionally excluded from the maxBytes-bounded output.
        const consumed = Buffer.byteLength(content);
        if (consumed < prefix.length) {
          const lead = prefix[consumed] as number;
          const width = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
          const tail = Buffer.allocUnsafe(width - (prefix.length - consumed));
          let read = 0;
          while (read < tail.length) {
            const n = readSync(file.fd, tail, read, tail.length - read, null);
            if (n === 0) break;
            read += n;
          }
          decoder.decode(tail.subarray(0, read));
        } else decoder.decode();
      } catch {
        binary = true;
        content = "";
      }
    }
    // Size is sampled after the bounded read, so growth does not escape the I/O cap and the
    // result reports the current full file size rather than the size of the returned prefix.
    const size = fstatSync(file.fd).size;
    return {
      path: displayPath(home, file.real),
      content,
      bytes: size,
      truncated: size > sampledBytes,
      binary,
    };
  } finally {
    closeSync(file.fd);
  }
}

function existingText(home: string, path: string): { content: string; stat: Stats } | undefined {
  const real = inHome(home, path);
  if (!lstatSync(real, { throwIfNoEntry: false })) return undefined;
  const file = openFile(home, path);
  try {
    const content = decode(textBytes(file.fd));
    if (content === undefined) throw new FileToolError(409, `${basename(real)} is a binary file`);
    return { content, stat: file.stat };
  } finally {
    closeSync(file.fd);
  }
}

function temporary(home: string, path: string, mode?: number, createOnly = false) {
  const real = inHome(home, path);
  mkdirSync(dirname(real), { recursive: true });
  checked(home, path, real);
  const before = lstatSync(real, { throwIfNoEntry: false });
  if (before && createOnly) throw new FileToolError(409, "a file with this name already exists");
  if (before && !before.isFile()) throw new FileToolError(409, `${path} is not a regular file`);
  const parent = lstatSync(dirname(real));
  if (!parent.isDirectory()) throw new FileToolError(409, "the parent is not a directory");
  const temp = join(dirname(real), `.localdot-${randomBytes(12).toString("hex")}.tmp`);
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      closeSync(fd);
    }
  };
  return {
    real,
    fd,
    before,
    commit() {
      // Preserve existing modes independent of umask. Explicit upload modes never include set-id.
      fchmodSync(fd, mode ?? (before ? before.mode & 0o7777 : 0o644));
      close();
      checked(home, path, real);
      const nowParent = lstatSync(dirname(real));
      const now = lstatSync(real, { throwIfNoEntry: false });
      if (!same(parent, nowParent) || (before ? !now || !same(before, now) : now !== undefined)) {
        throw new FileToolError(409, "the destination changed; try again");
      }
      if (createOnly) {
        // Atomic no-replace publication: even a destination created after the check cannot be overwritten.
        try {
          linkSync(temp, real);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
            throw new FileToolError(409, "a file with this name already exists");
          throw error;
        }
      } else renameSync(temp, real);
    },
    dispose() {
      try {
        close();
      } finally {
        rmSync(temp, { force: true });
      }
    },
  };
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(fd, bytes, offset, bytes.length - offset);
    if (n === 0) throw new Error("file write made no progress");
    offset += n;
  }
}

function patchFor(home: string, real: string, before: string, after: string): string {
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > MAX_DIFF_BYTES) {
    return `--- a/${displayPath(home, real)}\n+++ b/${displayPath(home, real)}\n(too large to show: ${Buffer.byteLength(after)} bytes)\n`;
  }
  return unifiedDiff(before, after, { path: displayPath(home, real).replace(/^~\//, "") });
}

export function writeFile(home: string, path: string, content: string): FileChangeResult {
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES)
    throw new FileToolError(413, "text is too large");
  const before = existingText(home, path);
  const temp = temporary(home, path);
  try {
    if (before && (!temp.before || !same(before.stat, temp.before)))
      throw new FileToolError(409, "file changed");
    writeAll(temp.fd, Buffer.from(content));
    temp.commit();
    return {
      path: displayPath(home, temp.real),
      op: before ? "modify" : "create",
      patch: patchFor(home, temp.real, before?.content ?? "", content),
      bytes: Buffer.byteLength(content),
    };
  } finally {
    temp.dispose();
  }
}

export function editFile(
  home: string,
  path: string,
  oldText: string,
  newText: string,
): FileChangeResult {
  if (!oldText) throw new FileToolError(400, "old_text must not be empty");
  const before = existingText(home, path);
  if (!before) throw new FileToolError(404, `${path} does not exist`);
  const at = before.content.indexOf(oldText);
  if (at < 0) throw new FileToolError(409, "old_text does not occur in the file");
  if (before.content.indexOf(oldText, at + 1) >= 0)
    throw new FileToolError(409, "old_text occurs more than once; include more context");
  const after = before.content.slice(0, at) + newText + before.content.slice(at + oldText.length);
  if (Buffer.byteLength(after) > MAX_TEXT_BYTES) throw new FileToolError(413, "text is too large");
  const temp = temporary(home, path);
  try {
    if (!temp.before || !same(before.stat, temp.before))
      throw new FileToolError(409, "file changed");
    writeAll(temp.fd, Buffer.from(after));
    temp.commit();
    return {
      path: displayPath(home, temp.real),
      op: "modify",
      patch: patchFor(home, temp.real, before.content, after),
      bytes: Buffer.byteLength(after),
    };
  } finally {
    temp.dispose();
  }
}

export function listDir(home: string, path: string): FileListResult {
  const real = inHome(home, path);
  const stat = lstatSync(real, { throwIfNoEntry: false });
  if (!stat) throw new FileToolError(404, `${path} does not exist`);
  if (!stat.isDirectory()) throw new FileToolError(400, `${path} is not a folder`);
  const names = readdirSync(real).sort((a, b) => a.localeCompare(b));
  const entries: FileEntry[] = names.slice(0, MAX_LIST).map((name) => {
    const entry = lstatSync(join(real, name), { throwIfNoEntry: false });
    const type = !entry
      ? "other"
      : entry.isSymbolicLink()
        ? "link"
        : entry.isDirectory()
          ? "dir"
          : entry.isFile()
            ? "file"
            : "other";
    return { name, type, bytes: entry?.isFile() ? entry.size : 0 };
  });
  checked(home, path, real);
  return { path: displayPath(home, real), entries, truncated: names.length > MAX_LIST };
}

export function fetchFile(
  home: string,
  path: string,
  maxBytes = MAX_TRANSFER_BYTES,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  limit(maxBytes);
  signal?.throwIfAborted();
  const file = openFile(home, path);
  if (file.stat.size > maxBytes) {
    closeSync(file.fd);
    throw new FileToolError(413, `file is larger than ${maxBytes} bytes`);
  }
  let bytes = 0;
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      closeSync(file.fd);
      signal?.removeEventListener("abort", abort);
    }
  };
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const abort = () => {
    close();
    controller.error(signal?.reason);
  };
  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      },
      pull(c) {
        if (closed) return;
        try {
          signal?.throwIfAborted();
          const chunk = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, maxBytes + 1 - bytes));
          const n = readSync(file.fd, chunk, 0, chunk.length, null);
          bytes += n;
          if (bytes > maxBytes) throw new FileToolError(413, `file grew beyond ${maxBytes} bytes`);
          if (n === 0) {
            close();
            c.close();
          } else c.enqueue(chunk.subarray(0, n));
        } catch (error) {
          close();
          c.error(error);
        }
      },
      cancel() {
        close();
      },
    },
    { highWaterMark: 0 },
  );
}

export async function putFile(
  home: string,
  path: string,
  source: ReadableStream<Uint8Array>,
  mode?: number,
  maxBytes = MAX_TRANSFER_BYTES,
  signal?: AbortSignal,
  createOnly = false,
): Promise<{ path: string; bytes: number }> {
  limit(maxBytes);
  signal?.throwIfAborted();
  if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o777))
    throw new FileToolError(400, "invalid mode");
  const reader = source.getReader();
  let temp: ReturnType<typeof temporary>;
  try {
    temp = temporary(home, path, mode, createOnly);
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    reader.releaseLock();
    throw error;
  }
  let bytes = 0;
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new FileToolError(413, "file too large");
      writeAll(temp.fd, chunk.value);
    }
    signal?.throwIfAborted();
    temp.commit();
    return { path: displayPath(home, temp.real), bytes };
  } finally {
    signal?.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
    temp.dispose();
  }
}
