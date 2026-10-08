import { randomBytes } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { KernelLockAcquirer } from "./install-lock.ts";

const unsafe = () => new Error("The diagnostic directory lease is unavailable or unsafe.");
function safe(stat: BigIntStats) {
  return (
    stat.isDirectory() &&
    stat.uid === BigInt(process.getuid?.() ?? -1) &&
    (stat.mode & 0o7777n) === 0o700n
  );
}
function same(a: BigIntStats, b: BigIntStats) {
  return safe(a) && safe(b) && a.dev === b.dev && a.ino === b.ino;
}

/** Caller holds the installation mutex and has durably recorded this private directory.
 * Acquire using the verified keyd helper. This adds no files, so a fresh directory stays empty.
 * Work must drain its effects (including any child sharing fd3) before settling. On recovery,
 * an independently opened descriptor cannot acquire while an orphan still holds the lease.
 * Never unlock explicitly: closing this descriptor must not unlock a surviving child's copy.
 */
export async function withCanaryDirectoryLease<T>(
  directory: string,
  signal: AbortSignal,
  acquire: KernelLockAcquirer,
  work: (descriptor: number) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  if (
    !isAbsolute(directory) ||
    normalize(directory) !== directory ||
    directory === "/" ||
    (await realpath(directory)) !== directory
  )
    throw unsafe();
  const named = await lstat(directory, { bigint: true });
  if (!safe(named)) throw unsafe();
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!same(named, opened)) throw unsafe();
    await acquire(handle.fd, directory, randomBytes(32).toString("hex"), signal);
    signal.throwIfAborted();
    if (
      (await realpath(directory)) !== directory ||
      !same(opened, await lstat(directory, { bigint: true })) ||
      !same(opened, await handle.stat({ bigint: true }))
    )
      throw unsafe();
    return await work(handle.fd);
  } finally {
    await handle.close();
  }
}
