import { createHash, timingSafeEqual } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import {
  downloadRegistryResource,
  MAX_RELEASE_ARCHIVE_BYTES,
  type RegistryDownload,
  type RegistryPackage,
  registryFailure,
  registryResourceURL,
} from "./registry-download.ts";

export interface AcquiredRelease extends RegistryPackage {
  archive: string;
  bytes: number;
  sha256: string;
  sha512: string;
  integrity: string;
  attestationJSON: string;
}
const MAX_JSON_BYTES = 2 * 1024 * 1024;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw registryFailure();
  return value as Record<string, unknown>;
}
function parseIntegrity(value: unknown): Buffer {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value))
    throw registryFailure();
  const decoded = Buffer.from(value.slice(7), "base64");
  if (decoded.length !== 64 || `sha512-${decoded.toString("base64")}` !== value)
    throw registryFailure();
  return decoded;
}
async function readJSONBody(body: AsyncIterable<Buffer>, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    if (!Buffer.isBuffer(chunk)) throw registryFailure();
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) throw registryFailure();
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
}
function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    after.nlink === 1n &&
    after.uid === BigInt(process.getuid?.() ?? -1) &&
    after.isFile() &&
    (after.mode & 0o7777n) === 0o400n
  );
}

/** Download-only acquisition. Registry integrity is not publisher authentication; the consumer
 * must verify provenance before extraction and verify the extracted manifest/keyd before use.
 * The caller holds the install lock or exclusively owns this private bootstrap parent. Only the new owned download
 * directory is removed; work must finish using the archive before its callback resolves.
 */
export async function withAcquiredRelease<T>(
  parent: string,
  requested: RegistryPackage,
  signal: AbortSignal,
  work: (release: Readonly<AcquiredRelease>, signal: AbortSignal) => Promise<T>,
  download: RegistryDownload = downloadRegistryResource,
): Promise<T> {
  signal.throwIfAborted();
  const pkg = Object.freeze({ name: requested.name, version: requested.version });
  const metadata = Object.freeze({ ...pkg, kind: "metadata" as const });
  registryResourceURL(metadata);
  const st = await lstat(parent);
  if (
    !isAbsolute(parent) ||
    normalize(parent) !== parent ||
    parent === "/" ||
    (await realpath(parent)) !== parent ||
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o7777) !== 0o700
  )
    throw registryFailure();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // Acquisition is finite as a whole, including the trusted callback's verification phase.
  const timer = setTimeout(() => controller.abort(registryFailure()), 120_000);
  let directory: string | undefined;
  try {
    controller.signal.throwIfAborted();
    directory = await realpath(await mkdtemp(join(parent, ".download-")));
    const raw = await readJSONBody(download(metadata, controller.signal), controller.signal);
    const doc = record(JSON.parse(raw));
    const dist = record(doc.dist);
    const expected = parseIntegrity(dist.integrity);
    const archiveResource = Object.freeze({ ...pkg, kind: "archive" as const });
    if (
      doc.name !== pkg.name ||
      doc.version !== pkg.version ||
      dist.tarball !== registryResourceURL(archiveResource).href ||
      record(record(dist.attestations).provenance).predicateType !==
        "https://slsa.dev/provenance/v1"
    )
      throw registryFailure();
    const archive = join(directory, "release.tgz");
    const file = await open(
      archive,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    let bytes = 0;
    const sha256 = createHash("sha256"),
      sha512 = createHash("sha512");
    let identity: BigIntStats;
    try {
      for await (const chunk of download(archiveResource, controller.signal)) {
        controller.signal.throwIfAborted();
        if (!Buffer.isBuffer(chunk) || bytes + chunk.length > MAX_RELEASE_ARCHIVE_BYTES)
          throw registryFailure();
        let offset = 0;
        while (offset < chunk.length) {
          controller.signal.throwIfAborted();
          const result = await file.write(chunk, offset, chunk.length - offset, bytes + offset);
          if (!result.bytesWritten) throw registryFailure();
          offset += result.bytesWritten;
        }
        bytes += chunk.length;
        sha256.update(chunk);
        sha512.update(chunk);
      }
      if (!bytes) throw registryFailure();
      await file.sync();
      await file.chmod(0o400);
      identity = await file.stat({ bigint: true });
      if (
        identity.size !== BigInt(bytes) ||
        !sameFile(identity, await lstat(archive, { bigint: true }))
      )
        throw registryFailure();
    } finally {
      await file.close();
    }
    const actual = sha512.digest();
    if (!timingSafeEqual(actual, expected)) throw registryFailure();
    const attestationJSON = await readJSONBody(
      download(Object.freeze({ ...pkg, kind: "attestation" }), controller.signal),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (!sameFile(identity, await lstat(archive, { bigint: true }))) throw registryFailure();
    const result = await work(
      Object.freeze({
        ...pkg,
        archive,
        bytes,
        sha256: sha256.digest("hex"),
        sha512: actual.toString("hex"),
        integrity: `sha512-${actual.toString("base64")}`,
        attestationJSON,
      }),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    return result;
  } catch {
    signal.throwIfAborted();
    throw registryFailure();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
