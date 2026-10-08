import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import {
  PackagePath,
  ReleaseManifest,
  SHA256_HEX,
} from "../../../../packages/protocol/src/release.ts";

export interface ReleaseMetadataDigests {
  packageJson: string;
  releaseJson: string;
}
export interface StagedReleaseInventory {
  manifest: ReleaseManifest;
  metadataDigests: ReleaseMetadataDigests;
  files: number;
  bytes: number;
}

const MAX_FILES = 4098;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const invalid = () => new Error("Staged release contents failed verification.");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function safeStat(stat: BigIntStats, directory: boolean): void {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) ||
    stat.uid !== BigInt(process.getuid?.() ?? -1) ||
    (stat.mode & 0o7022n) !== 0n
  )
    throw invalid();
}
function unchanged(before: BigIntStats, after: BigIntStats): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.mode !== after.mode ||
    before.uid !== after.uid ||
    before.nlink !== after.nlink
  )
    throw invalid();
}

/**
 * Check an exclusively owned, already extracted package before dependency installation.
 * The caller must authenticate both metadata digests through release provenance first.
 * This inventory is not a trust token or a guarantee against subsequent filesystem writes.
 * Activation must keep exclusive staging ownership and reverify after copying. No code runs here.
 */
export async function verifyStagedRelease(
  root: string,
  expected: ReleaseMetadataDigests,
  signal: AbortSignal,
): Promise<StagedReleaseInventory> {
  signal.throwIfAborted();
  expected = { ...expected };
  if (
    !isAbsolute(root) ||
    normalize(root) !== root ||
    root === "/" ||
    !SHA256_HEX.test(expected.packageJson) ||
    !SHA256_HEX.test(expected.releaseJson) ||
    (await realpath(root)) !== root
  )
    throw invalid();
  const files = new Map<string, string>();
  const metadata = new Map<string, Buffer>();
  const paths = new Set<string>();
  let bytes = 0;
  let entries = 0;
  async function walk(directory: string, prefix: string): Promise<void> {
    signal.throwIfAborted();
    const before = await lstat(directory, { bigint: true });
    safeStat(before, true);
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      signal.throwIfAborted();
      const relative = prefix + name;
      if (++entries > MAX_FILES * 2 || !PackagePath.safeParse(relative).success) throw invalid();
      const folded = relative.toLowerCase();
      if (paths.has(folded)) throw invalid();
      paths.add(folded);
      const path = join(directory, name);
      const stat = await lstat(path, { bigint: true });
      if (stat.isDirectory()) {
        // Every directory must contain a declared payload file; empty/foreign trees are refused.
        const count = files.size;
        await walk(path, `${relative}/`);
        if (files.size === count) throw invalid();
        continue;
      }
      safeStat(stat, false);
      if (stat.size > BigInt(MAX_FILE_BYTES) || files.size >= MAX_FILES) throw invalid();
      const isMetadata = relative === "package.json" || relative === "release.json";
      if (isMetadata && stat.size > BigInt(MAX_METADATA_BYTES)) throw invalid();
      bytes += Number(stat.size);
      if (bytes > MAX_TOTAL_BYTES) throw invalid();
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = await handle.stat({ bigint: true });
        safeStat(opened, false);
        unchanged(stat, opened);
        // Read exactly the observed size with a fixed allocation; concurrent growth cannot
        // turn readFile into an unbounded allocation. Any observed mutation rejects the tree.
        const body = Buffer.alloc(Number(stat.size));
        let offset = 0;
        while (offset < body.length) {
          signal.throwIfAborted();
          const read = await handle.read(body, offset, body.length - offset, offset);
          if (!read.bytesRead) throw invalid();
          offset += read.bytesRead;
        }
        unchanged(opened, await handle.stat({ bigint: true }));
        unchanged(opened, await lstat(path, { bigint: true }));
        files.set(relative, digest(body));
        if (isMetadata) metadata.set(relative, body);
      } finally {
        await handle.close();
      }
    }
    if (JSON.stringify(names) !== JSON.stringify((await readdir(directory)).sort()))
      throw invalid();
    unchanged(before, await lstat(directory, { bigint: true }));
  }
  await walk(root, "");
  signal.throwIfAborted();
  if (
    files.get("package.json") !== expected.packageJson ||
    files.get("release.json") !== expected.releaseJson
  )
    throw invalid();
  let manifest: ReleaseManifest;
  let pkg: unknown;
  try {
    manifest = ReleaseManifest.parse(
      JSON.parse(metadata.get("release.json")?.toString("utf8") ?? ""),
    );
    pkg = JSON.parse(metadata.get("package.json")?.toString("utf8") ?? "");
  } catch {
    throw invalid();
  }
  if (
    !pkg ||
    typeof pkg !== "object" ||
    Array.isArray(pkg) ||
    !("name" in pkg) ||
    pkg.name !== "localdot" ||
    !("version" in pkg) ||
    pkg.version !== manifest.version ||
    // The published root has no lifecycle hooks. Dependency execution is a later gate.
    "scripts" in pkg ||
    files.size !== Object.keys(manifest.files).length + 2
  )
    throw invalid();
  for (const [path, hash] of Object.entries(manifest.files))
    if (files.get(path) !== hash) throw invalid();
  return { manifest, metadataDigests: { ...expected }, files: files.size, bytes };
}
