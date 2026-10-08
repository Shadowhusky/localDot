import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { PackagePath } from "../../../../packages/protocol/src/release.ts";
import type { ExtractedFile } from "./extract-release.ts";

const fail = () => new Error("Release changed while preparing installation.");
function same(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.uid === b.uid &&
    b.nlink === 1n &&
    b.isFile()
  );
}
export async function privateDirectory(path: string) {
  const st = await lstat(path, { bigint: true });
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path === "/" ||
    (await realpath(path)) !== path ||
    !st.isDirectory() ||
    st.uid !== BigInt(process.getuid?.() ?? -1) ||
    (st.mode & 0o7777n) !== 0o700n
  )
    throw fail();
  return st;
}

/** Copy an exact authenticated inventory into a fresh owned destination. No links, metadata or
 * unrelated source entries are traversed. Caller holds the install lock and owns both trees.
 */
async function copyWithProfile(
  source: string,
  destination: string,
  files: Readonly<Record<string, ExtractedFile>>,
  signal: AbortSignal,
  maxFileBytes: number,
): Promise<void> {
  signal.throwIfAborted();
  // Snapshot validated entries before awaiting, so later mutation cannot change copy authority.
  const entries = Object.entries(files).map(([path, file]) => ({
    path,
    sha256: file.sha256,
    bytes: file.bytes,
    mode: file.mode,
  }));
  if (!entries.length || entries.length > 4098) throw fail();
  const seen = new Set<string>();
  let total = 0;
  for (const item of entries) {
    if (
      !PackagePath.safeParse(item.path).success ||
      seen.has(item.path.toLowerCase()) ||
      !/^[0-9a-f]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > maxFileBytes ||
      ![0o600, 0o700].includes(item.mode)
    )
      throw fail();
    total += item.bytes;
    if (total > 256 * 1024 * 1024) throw fail();
    seen.add(item.path.toLowerCase());
  }
  await privateDirectory(source);
  await privateDirectory(dirname(destination));
  if (!isAbsolute(destination) || normalize(destination) !== destination) throw fail();
  await mkdir(destination, { mode: 0o700 });
  await privateDirectory(destination);
  for (const item of entries) {
    signal.throwIfAborted();
    const from = join(source, item.path),
      to = join(destination, item.path);
    if ((await realpath(from)) !== from) throw fail();
    const before = await lstat(from, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      before.size !== BigInt(item.bytes) ||
      (before.mode & 0o7777n) !== BigInt(item.mode)
    )
      throw fail();
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    const input = await open(
      from,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!same(before, await input.stat({ bigint: true }))) throw fail();
      const output = await open(
        to,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const buffer = Buffer.alloc(65536),
          hash = createHash("sha256");
        let position = 0;
        while (position < item.bytes) {
          signal.throwIfAborted();
          const { bytesRead } = await input.read(
            buffer,
            0,
            Math.min(buffer.length, item.bytes - position),
            position,
          );
          if (!bytesRead) throw fail();
          hash.update(buffer.subarray(0, bytesRead));
          let offset = 0;
          while (offset < bytesRead) {
            signal.throwIfAborted();
            const { bytesWritten } = await output.write(
              buffer,
              offset,
              bytesRead - offset,
              position + offset,
            );
            if (!bytesWritten) throw fail();
            offset += bytesWritten;
          }
          position += bytesRead;
        }
        if (
          hash.digest("hex") !== item.sha256 ||
          !same(before, await input.stat({ bigint: true })) ||
          !same(before, await lstat(from, { bigint: true }))
        )
          throw fail();
        await output.chmod(item.mode);
        await output.sync();
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
  }
  signal.throwIfAborted();
}

export function copyInventory(
  source: string,
  destination: string,
  files: Readonly<Record<string, ExtractedFile>>,
  signal: AbortSignal,
): Promise<void> {
  return copyWithProfile(source, destination, files, signal, 16 * 1024 * 1024);
}
export function copyDependencyInventory(
  source: string,
  destination: string,
  files: Readonly<Record<string, ExtractedFile>>,
  signal: AbortSignal,
): Promise<void> {
  return copyWithProfile(source, destination, files, signal, 64 * 1024 * 1024);
}
