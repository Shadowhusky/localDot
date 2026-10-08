import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";
import { PackagePath } from "../../../../packages/protocol/src/release.ts";
import { MAX_RELEASE_ARCHIVE_BYTES } from "./registry-download.ts";

const MAX_FILES = 4098,
  MAX_HEADERS = MAX_FILES * 3;
const MAX_FILE = 16 * 1024 * 1024,
  MAX_TOTAL = 256 * 1024 * 1024;
const MAX_META = 8 * 1024 * 1024,
  MAX_EXPANDED = MAX_TOTAL + MAX_HEADERS * 512 + MAX_META + 65536;
const fail = () => new Error("Release archive could not be safely extracted.");
export interface ExtractedFile {
  sha256: string;
  bytes: number;
  mode: number;
}
export interface ExtractedRelease {
  root: string;
  files: Readonly<Record<string, ExtractedFile>>;
}

function same(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.mode === b.mode &&
    b.nlink === 1n &&
    b.isFile()
  );
}
async function readAt(file: FileHandle, size: number, position: number, signal: AbortSignal) {
  const body = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    signal.throwIfAborted();
    const { bytesRead } = await file.read(body, offset, size - offset, position + offset);
    if (!bytesRead) throw fail();
    offset += bytesRead;
  }
  return body;
}
function text(field: Buffer): string {
  const zero = field.indexOf(0);
  if (zero >= 0 && field.subarray(zero).some((b) => b !== 0)) throw fail();
  return new TextDecoder("utf-8", { fatal: true }).decode(
    zero >= 0 ? field.subarray(0, zero) : field,
  );
}
function octal(field: Buffer): number {
  const value = text(field).trim();
  if (!/^[0-7]*$/.test(value)) throw fail();
  const result = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(result)) throw fail();
  return result;
}
function pax(payload: Buffer): string | undefined {
  const seen = new Set<string>();
  let offset = 0,
    path: string | undefined;
  while (offset < payload.length) {
    const space = payload.indexOf(32, offset);
    if (space <= offset || space - offset > 10) throw fail();
    const digits = payload.subarray(offset, space).toString("utf8");
    if (!/^[1-9][0-9]*$/.test(digits)) throw fail();
    const end = offset + Number(digits);
    if (end > payload.length || end <= space + 3 || payload[end - 1] !== 10) throw fail();
    const entry = new TextDecoder("utf-8", { fatal: true }).decode(
      payload.subarray(space + 1, end - 1),
    );
    const equal = entry.indexOf("="),
      key = entry.slice(0, equal),
      value = entry.slice(equal + 1);
    if (
      equal <= 0 ||
      ![
        "path",
        "mtime",
        "atime",
        "ctime",
        "uid",
        "gid",
        "uname",
        "gname",
        "charset",
        "comment",
      ].includes(key) ||
      seen.has(key) ||
      value.includes("\0")
    )
      throw fail();
    seen.add(key);
    if (key === "path") path = value;
    offset = end;
  }
  return path;
}

async function inflateArchive(
  archive: string,
  expectedSHA512: string,
  raw: string,
  signal: AbortSignal,
): Promise<number> {
  if (
    !isAbsolute(archive) ||
    normalize(archive) !== archive ||
    (await realpath(archive)) !== archive ||
    !/^[0-9a-f]{128}$/.test(expectedSHA512)
  )
    throw fail();
  const named = await lstat(archive, { bigint: true });
  if (
    !named.isFile() ||
    named.nlink !== 1n ||
    named.uid !== BigInt(process.getuid?.() ?? -1) ||
    (named.mode & 0o7777n) !== 0o400n ||
    named.size < 18n ||
    named.size > BigInt(MAX_RELEASE_ARCHIVE_BYTES)
  )
    throw fail();
  const source = await open(
    archive,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!same(named, await source.stat({ bigint: true }))) throw fail();
    const size = Number(named.size),
      hash = createHash("sha512");
    for (let offset = 0; offset < size; offset += 65536)
      hash.update(await readAt(source, Math.min(65536, size - offset), offset, signal));
    if (hash.digest("hex") !== expectedSHA512) throw fail();
    const header = await readAt(source, 10, 0, signal),
      trailer = await readAt(source, 8, size - 8, signal);
    // npm emits a single gzip member with no optional name/comment/extra fields.
    if (!header.subarray(0, 4).equals(Buffer.from([31, 139, 8, 0]))) throw fail();
    const inflate = createInflateRaw(),
      output = await open(
        raw,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    let bytes = 0,
      checksum = 0;
    try {
      await pipeline(
        source.createReadStream({ start: 10, end: size - 9, autoClose: false }),
        inflate,
        async (stream) => {
          for await (const chunk of stream) {
            signal.throwIfAborted();
            if (!Buffer.isBuffer(chunk) || bytes + chunk.length > MAX_EXPANDED) throw fail();
            checksum = crc32(chunk, checksum);
            let offset = 0;
            while (offset < chunk.length) {
              signal.throwIfAborted();
              const result = await output.write(
                chunk,
                offset,
                chunk.length - offset,
                bytes + offset,
              );
              if (!result.bytesWritten) throw fail();
              offset += result.bytesWritten;
            }
            bytes += chunk.length;
          }
        },
        { signal },
      );
      if (
        inflate.bytesWritten !== size - 18 ||
        trailer.readUInt32LE(0) !== checksum ||
        trailer.readUInt32LE(4) !== bytes ||
        bytes % 512 !== 0
      )
        throw fail();
      await output.sync();
    } finally {
      await output.close();
    }
    if (
      !same(named, await source.stat({ bigint: true })) ||
      !same(named, await lstat(archive, { bigint: true }))
    )
      throw fail();
    return bytes;
  } finally {
    await source.close();
  }
}

async function extractTar(
  raw: string,
  size: number,
  tree: string,
  signal: AbortSignal,
  maxFileBytes = MAX_FILE,
): Promise<ExtractedRelease> {
  const file = await open(raw, constants.O_RDONLY | constants.O_NOFOLLOW);
  const files: Record<string, ExtractedFile> = Object.create(null);
  const seen = new Set<string>(),
    nodes = new Map<string, { path: string; directory: boolean }>();
  const directories: string[] = [];
  const members: { relative: string; offset: number; length: number; mode: number }[] = [];
  let offset = 0,
    headers = 0,
    meta = 0,
    total = 0,
    count = 0;
  let pending: string | undefined,
    extended = false,
    ended = false;
  function directory(path: string) {
    let prefix = "";
    for (const component of path.split("/")) {
      if (!component) continue;
      prefix = prefix ? `${prefix}/${component}` : component;
      const folded = prefix.toLowerCase(),
        old = nodes.get(folded);
      if (old && (old.path !== prefix || !old.directory)) throw fail();
      if (!old) {
        if (nodes.size >= MAX_FILES * 2) throw fail();
        nodes.set(folded, { path: prefix, directory: true });
      }
    }
  }
  try {
    while (offset < size) {
      const header = await readAt(file, 512, offset, signal);
      offset += 512;
      if (header.every((b) => b === 0)) {
        if (extended || size - offset < 512 || size - offset > 65536 - 512) throw fail();
        const tail = await readAt(file, size - offset, offset, signal);
        if (tail.some((b) => b !== 0)) throw fail();
        ended = true;
        break;
      }
      headers++;
      meta += 512;
      if (headers > MAX_HEADERS || meta > MAX_META) throw fail();
      // Checksum's final space is permitted by POSIX, unlike other numeric fields.
      const checksumField = header
        .subarray(148, 156)
        .toString("utf8")
        .replace(/[\0 ]+$/, " ")
        .trim();
      if (!/^[0-7]+$/.test(checksumField)) throw fail();
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
      if (Number.parseInt(checksumField, 8) !== checksum) throw fail();
      const magic = header.subarray(257, 263).toString("utf8");
      if (magic !== "ustar\0" && magic !== "ustar ") throw fail();
      const type = header[156] ?? 0,
        length = octal(header.subarray(124, 136)),
        mode = octal(header.subarray(100, 108));
      if (
        ![0, 48, 53, 120, 76].includes(type) ||
        length > maxFileBytes ||
        (mode & 0o7022) !== 0 ||
        text(header.subarray(157, 257)) !== ""
      )
        throw fail();
      const padded = Math.ceil(length / 512) * 512;
      if (offset + padded > size) throw fail();
      if (
        padded > length &&
        (await readAt(file, padded - length, offset + length, signal)).some((b) => b !== 0)
      )
        throw fail();
      if (type === 120 || type === 76) {
        meta += length;
        if (extended || length > 32768 || meta > MAX_META) throw fail();
        const payload = await readAt(file, length, offset, signal);
        pending = type === 120 ? pax(payload) : text(payload);
        if (type === 76 && !pending) throw fail();
        extended = true;
        offset += padded;
        continue;
      }
      let name = pending ?? text(header.subarray(0, 100));
      if (pending === undefined) {
        const prefix = text(header.subarray(345, 500));
        if (prefix) name = `${prefix}/${name}`;
      }
      pending = undefined;
      extended = false;
      const isDirectory = type === 53;
      if (isDirectory && name.endsWith("/")) name = name.slice(0, -1);
      if (name === "package/" || (name !== "package" && !name.startsWith("package/"))) throw fail();
      const relative = name === "package" ? "" : name.slice(8),
        key = name.toLowerCase();
      if (
        seen.has(key) ||
        (!relative && !isDirectory) ||
        (relative && !PackagePath.safeParse(relative).success)
      )
        throw fail();
      seen.add(key);
      if (isDirectory) {
        if (length !== 0) throw fail();
        if (relative) {
          directory(relative);
          directories.push(relative);
        }
      } else {
        count++;
        total += length;
        if (count > MAX_FILES || total > MAX_TOTAL) throw fail();
        const folded = relative.toLowerCase();
        if (nodes.has(folded)) throw fail();
        directory(dirname(relative) === "." ? "" : dirname(relative));
        if (nodes.size >= MAX_FILES * 2) throw fail();
        nodes.set(folded, { path: relative, directory: false });
        members.push({ relative, offset, length, mode });
      }
      offset += padded;
    }
    if (
      !ended ||
      !count ||
      directories.some((dir) => !members.some(({ relative }) => relative.startsWith(`${dir}/`)))
    )
      throw fail();
    // Validate the complete inventory before creating any archive member. Malformed late headers
    // and over-count archives cannot consume thousands of file creations/fsyncs before refusal.
    for (const node of nodes.values()) {
      signal.throwIfAborted();
      if (node.directory) await mkdir(join(tree, node.path), { mode: 0o700 });
    }
    for (const { relative, offset: start, length, mode } of members) {
      signal.throwIfAborted();
      const target = await open(
        join(tree, relative),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const hash = createHash("sha256");
      let copied = 0;
      try {
        while (copied < length) {
          const chunk = await readAt(
            file,
            Math.min(65536, length - copied),
            start + copied,
            signal,
          );
          hash.update(chunk);
          let written = 0;
          while (written < chunk.length) {
            signal.throwIfAborted();
            const result = await target.write(
              chunk,
              written,
              chunk.length - written,
              copied + written,
            );
            if (!result.bytesWritten) throw fail();
            written += result.bytesWritten;
          }
          copied += chunk.length;
        }
        // No archive ownership, ACLs, times or special permissions are restored.
        await target.chmod((mode & 0o111) !== 0 ? 0o700 : 0o600);
        await target.sync();
      } finally {
        await target.close();
      }
      files[relative] = Object.freeze({
        sha256: hash.digest("hex"),
        bytes: length,
        mode: (mode & 0o111) !== 0 ? 0o700 : 0o600,
      });
    }
    return Object.freeze({ root: tree, files: Object.freeze(files) });
  } finally {
    await file.close();
  }
}

/** Archive hash must already be authenticated. Caller owns the installer lock and must finish
 * consuming the tree before returning. No code executes and only the fresh owned tree is removed.
 * Native dependency installation and activation are separate gates after manifest verification.
 */
async function extractWithProfile<T>(
  parent: string,
  input: Readonly<{ archive: string; sha512: string }>,
  signal: AbortSignal,
  work: (release: ExtractedRelease, signal: AbortSignal) => Promise<T>,
  maxFileBytes: number,
): Promise<T> {
  signal.throwIfAborted();
  const archive = input.archive,
    sha512 = input.sha512;
  const st = await lstat(parent);
  if (
    !isAbsolute(parent) ||
    normalize(parent) !== parent ||
    parent === "/" ||
    (await realpath(parent)) !== parent ||
    !st.isDirectory() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o7777) !== 0o700
  )
    throw fail();
  let directory: string | undefined;
  try {
    directory = await realpath(await mkdtemp(join(parent, ".extract-")));
    const raw = join(directory, "archive.tar"),
      tree = join(directory, "tree");
    await mkdir(tree, { mode: 0o700 });
    const size = await inflateArchive(archive, sha512, raw, signal);
    const extracted = await extractTar(raw, size, tree, signal, maxFileBytes);
    signal.throwIfAborted();
    const result = await work(extracted, signal);
    signal.throwIfAborted();
    return result;
  } catch {
    signal.throwIfAborted();
    throw fail();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export function withExtractedRelease<T>(
  parent: string,
  input: Readonly<{ archive: string; sha512: string }>,
  signal: AbortSignal,
  work: (release: ExtractedRelease, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return extractWithProfile(parent, input, signal, work, MAX_FILE);
}

/** Native dylibs have a separate compiled 64 MiB member cap. All other extraction restrictions
 * remain identical; callers cannot provide an arbitrary limit or relax path/type checks.
 */
export function withExtractedDependency<T>(
  parent: string,
  input: Readonly<{ archive: string; sha512: string }>,
  signal: AbortSignal,
  work: (release: ExtractedRelease, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return extractWithProfile(parent, input, signal, work, 64 * 1024 * 1024);
}
