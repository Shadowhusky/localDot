import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { PRIVATE_CREATE_FLAGS, PRIVATE_READ_FLAGS } from "./roots.ts";
import { type CodexReleaseManifest, MAX_ARCHIVE_ENTRIES, MAX_EXPANDED_BYTES } from "./version.ts";

export class UnsafeCodexArchiveError extends Error {
  constructor() {
    super("The Codex archive is unsafe or incomplete.");
    this.name = "UnsafeCodexArchiveError";
  }
}
export class CodexMemberIntegrityError extends Error {
  constructor() {
    super("The Codex executable integrity check failed.");
    this.name = "CodexMemberIntegrityError";
  }
}
const unsafe = (): never => {
  throw new UnsafeCodexArchiveError();
};
function field(header: Buffer, from: number, length: number): string {
  const raw = header.subarray(from, from + length);
  const zero = raw.indexOf(0);
  if (zero >= 0 && raw.subarray(zero).some((byte) => byte !== 0)) unsafe();
  const value = raw.subarray(0, zero < 0 ? raw.length : zero);
  if (value.some((byte) => byte < 32 || byte > 126)) unsafe();
  return value.toString("ascii");
}
function octal(header: Buffer, from: number, length: number, emptyIsZero = false): number {
  const raw = header.subarray(from, from + length).toString("latin1");
  if (emptyIsZero && /^[ \0]*$/.test(raw)) return 0;
  if (!/^[ ]*[0-7]+[ \0]*$/.test(raw)) unsafe();
  const value = Number.parseInt(raw.trim().replace(/\0+$/, "").trim(), 8);
  if (!Number.isSafeInteger(value) || value < 0) unsafe();
  return value;
}
function readHeader(header: Buffer): { path: string; size: number; type: "file" | "directory" } {
  if (header.subarray(257, 265).toString("latin1") !== `ustar${String.fromCharCode(0)}00`) unsafe();
  const checksum = octal(header, 148, 8);
  let sum = 0;
  for (const [index, byte] of header.entries()) sum += index >= 148 && index < 156 ? 32 : byte;
  if (sum !== checksum || header.subarray(500).some((byte) => byte !== 0)) unsafe();
  const prefix = field(header, 345, 155),
    name = field(header, 0, 100);
  const path = prefix ? `${prefix}/${name}` : name;
  if (
    !path ||
    !/^[A-Za-z0-9._/-]+$/.test(path) ||
    path.startsWith("/") ||
    path
      .split("/")
      .some(
        (part, index, parts) =>
          part === "." || part === ".." || (!part && index !== parts.length - 1),
      )
  )
    unsafe();
  if (field(header, 157, 100)) unsafe();
  const size = octal(header, 124, 12);
  for (const [from, length] of [
    [100, 8],
    [108, 8],
    [116, 8],
    [136, 12],
  ] as const)
    octal(header, from, length, from === 108 || from === 116);
  const type = header[156];
  if (type !== 0 && type !== 48 && type !== 53) unsafe(); // No PAX/GNU extensions, links, devices or sparse records.
  if (
    size > MAX_EXPANDED_BYTES ||
    (type === 53 && size !== 0) ||
    (type !== 53 && path.endsWith("/"))
  )
    unsafe();
  return { path: path.replace(/\/$/, ""), size, type: type === 53 ? "directory" : "file" };
}
export async function writeFully(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten <= 0) throw new Error("Codex storage write did not advance");
    offset += result.bytesWritten;
  }
}

// Bounded streaming ustar reader for the measured npm artifacts. Only the two named regular
// members ever reach disk; metadata and unselected executable content are discarded.
export async function extractCodexArchive(
  archive: string,
  staging: string,
  release: CodexReleaseManifest,
  signal: AbortSignal,
): Promise<void> {
  const file = await open(archive, PRIVATE_READ_FLAGS);
  const source = file.createReadStream({ autoClose: false, signal, highWaterMark: 64 * 1024 });
  const gzip = createGunzip({ chunkSize: 64 * 1024 });
  const pumping = pipeline(source, gzip, { signal });
  void pumping.catch(() => {}); // Joined below; avoid an early pump rejection before reader catch.
  const header = Buffer.alloc(512);
  let headerBytes = 0,
    bodyBytes = 0,
    padding = 0,
    expanded = 0,
    entries = 0,
    zeroBlocks = 0;
  const seen = new Set<string>();
  const completed = new Set<string>();
  let selected:
    | {
        file: FileHandle;
        hash: ReturnType<typeof createHash>;
        expected: CodexReleaseManifest["binaries"][number];
      }
    | undefined;
  try {
    for await (const raw of gzip) {
      signal.throwIfAborted();
      const chunk = raw as Buffer;
      expanded += chunk.length;
      if (expanded > MAX_EXPANDED_BYTES) unsafe();
      let offset = 0;
      while (offset < chunk.length) {
        signal.throwIfAborted();
        if (bodyBytes > 0) {
          const count = Math.min(bodyBytes, chunk.length - offset);
          const bytes = chunk.subarray(offset, offset + count);
          if (selected) {
            selected.hash.update(bytes);
            await writeFully(selected.file, bytes);
          }
          offset += count;
          bodyBytes -= count;
          if (bodyBytes === 0 && selected) {
            const owned = selected;
            selected = undefined;
            try {
              if (owned.hash.digest("hex") !== owned.expected.sha256)
                throw new CodexMemberIntegrityError();
              await owned.file.sync();
              completed.add(owned.expected.member);
            } finally {
              await owned.file.close();
            }
          }
        } else if (padding > 0) {
          const count = Math.min(padding, chunk.length - offset);
          if (chunk.subarray(offset, offset + count).some((byte) => byte !== 0)) unsafe();
          offset += count;
          padding -= count;
        } else {
          if (zeroBlocks >= 2) {
            const rest = chunk.subarray(offset);
            if (rest.some((byte) => byte !== 0)) unsafe();
            const count = headerBytes + rest.length;
            zeroBlocks += Math.floor(count / 512);
            headerBytes = count % 512;
            offset = chunk.length;
            continue;
          }
          const count = Math.min(512 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + count);
          offset += count;
          headerBytes += count;
          if (headerBytes !== 512) continue;
          headerBytes = 0;
          if (header.every((byte) => byte === 0)) {
            zeroBlocks++;
            continue;
          }
          if (zeroBlocks || ++entries > MAX_ARCHIVE_ENTRIES) unsafe();
          const member = readHeader(header);
          if (seen.has(member.path)) unsafe();
          seen.add(member.path);
          bodyBytes = member.size;
          padding = (512 - (member.size % 512)) % 512;
          const expected = release.binaries.find((binary) => binary.member === member.path);
          if (expected) {
            if (member.type !== "file" || member.size !== expected.bytes) unsafe();
            selected = {
              file: await open(join(staging, expected.installedName), PRIVATE_CREATE_FLAGS, 0o600),
              hash: createHash("sha256"),
              expected,
            };
          }
        }
      }
    }
    await pumping;
    if (
      headerBytes ||
      bodyBytes ||
      padding ||
      zeroBlocks < 2 ||
      completed.size !== release.binaries.length
    )
      unsafe();
  } catch (error) {
    if (signal.aborted) throw error;
    if (
      error instanceof UnsafeCodexArchiveError ||
      (error as NodeJS.ErrnoException).code?.startsWith("Z_")
    )
      throw new UnsafeCodexArchiveError();
    throw error;
  } finally {
    source.destroy();
    gzip.destroy();
    await pumping.catch(() => {});
    await selected?.file.close();
    await file.close();
  }
}
