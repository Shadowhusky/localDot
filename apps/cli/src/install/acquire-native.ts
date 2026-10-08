import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "./copy-inventory.ts";
import { type NativePackage, nativeArchiveURL } from "./native-plan.ts";
import {
  downloadNativeArchive,
  MAX_NATIVE_ARCHIVE_BYTES,
  type NativeArchiveDownload,
} from "./registry-download.ts";

const fail = () => new Error("Native dependency download failed verification.");
const MAX_TOTAL = 512 * 1024 * 1024;

/** Caller supplies an authenticated lock plan and holds the install lock. This is an ephemeral
 * archive set, never an ambient npm cache. The callback must finish using it before returning.
 * Hashes are checked here and again by the native extractor. No package code runs here.
 */
export async function withAcquiredNativeArchives<T>(
  parent: string,
  input: ReadonlyArray<NativePackage>,
  signal: AbortSignal,
  work: (archives: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<T>,
  download: NativeArchiveDownload = downloadNativeArchive,
): Promise<T> {
  signal.throwIfAborted();
  if (!Array.isArray(input) || !input.length || input.length > 128) throw fail();
  // Only the fields used below are retained, before any filesystem/network await.
  const plan = input.map(({ name, version, resolved, integrity, sha512 }) =>
    Object.freeze({ name, version, resolved, integrity, sha512 }),
  );
  const names = new Set<string>();
  for (const pkg of plan) {
    if (
      pkg.resolved !== nativeArchiveURL(pkg.name, pkg.version).href ||
      typeof pkg.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity) ||
      typeof pkg.sha512 !== "string" ||
      !/^[0-9a-f]{128}$/.test(pkg.sha512) ||
      names.has(pkg.name)
    )
      throw fail();
    const bytes = Buffer.from(pkg.integrity.slice(7), "base64");
    if (
      `sha512-${bytes.toString("base64")}` !== pkg.integrity ||
      bytes.toString("hex") !== pkg.sha512
    )
      throw fail();
    names.add(pkg.name);
  }
  await privateDirectory(parent);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(fail()), 300_000);
  let directory: string | undefined;
  try {
    controller.signal.throwIfAborted();
    directory = await realpath(await mkdtemp(join(parent, ".native-download-")));
    const archives: Record<string, string> = Object.create(null);
    let total = 0;
    for (const [index, pkg] of plan.entries()) {
      controller.signal.throwIfAborted();
      const path = join(directory, `${index}.tgz`);
      const file = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        let size = 0;
        const hash = createHash("sha512");
        for await (const chunk of download(pkg, controller.signal)) {
          controller.signal.throwIfAborted();
          if (
            !Buffer.isBuffer(chunk) ||
            size + chunk.length > MAX_NATIVE_ARCHIVE_BYTES ||
            total + chunk.length > MAX_TOTAL
          )
            throw fail();
          let offset = 0;
          while (offset < chunk.length) {
            controller.signal.throwIfAborted();
            const { bytesWritten } = await file.write(
              chunk,
              offset,
              chunk.length - offset,
              size + offset,
            );
            if (!bytesWritten) throw fail();
            offset += bytesWritten;
          }
          hash.update(chunk);
          size += chunk.length;
          total += chunk.length;
        }
        controller.signal.throwIfAborted();
        if (!size || hash.digest("hex") !== pkg.sha512) throw fail();
        await file.sync();
        await file.chmod(0o400);
        const fd = await file.stat({ bigint: true }),
          named = await lstat(path, { bigint: true });
        if (
          !fd.isFile() ||
          fd.nlink !== 1n ||
          fd.uid !== BigInt(process.getuid?.() ?? -1) ||
          fd.size !== BigInt(size) ||
          (fd.mode & 0o7777n) !== 0o400n ||
          fd.dev !== named.dev ||
          fd.ino !== named.ino ||
          fd.size !== named.size ||
          fd.mode !== named.mode ||
          fd.mtimeNs !== named.mtimeNs ||
          fd.ctimeNs !== named.ctimeNs
        )
          throw fail();
      } finally {
        await file.close();
      }
      archives[pkg.name] = path;
    }
    controller.signal.throwIfAborted();
    const result = await work(Object.freeze(archives), controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch {
    signal.throwIfAborted();
    throw fail();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
