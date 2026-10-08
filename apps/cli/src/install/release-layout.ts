import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { ReleaseIdentity } from "../../../../packages/protocol/src/install-update.ts";
import { privateRecordStore } from "./private-record.ts";

export type InstalledReleaseVerifier = (
  path: string,
  identity: ReleaseIdentity,
  signal: AbortSignal,
) => Promise<void>;

/** Stable installed identity, not a version string or user-supplied filesystem path. */
export function releaseDirectoryName(input: ReleaseIdentity): string {
  const identity = ReleaseIdentity.parse(input);
  return `${identity.packageSha256}-${identity.manifestSha256}`;
}

async function privateDirectory(path: string) {
  const info = await lstat(path, { bigint: true });
  if (
    !info.isDirectory() ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    (info.mode & 0o7777n) !== 0o700n ||
    (await realpath(path)) !== path
  )
    throw new Error("Installed release directory is unavailable or unsafe.");
  return info;
}

/** directory is an existing private install-state root, held under withInstallLock.
 * Payloads live in releases/<package-hash>-<manifest-hash>. A pointer is an atomic strict JSON
 * identity, never a symlink, executable path or request to delete user data. verify must check
 * authenticated metadata, installed contents/dependencies and keyd signature before selecting.
 */
export function releaseLayout(directory: string, verify: InstalledReleaseVerifier) {
  if (!isAbsolute(directory) || normalize(directory) !== directory || directory === "/")
    throw new Error("Invalid installation directory.");
  const selected = privateRecordStore(directory, "selected.json", ReleaseIdentity.nullable());
  async function path(input: ReleaseIdentity): Promise<string> {
    const identity = ReleaseIdentity.parse(input);
    await privateDirectory(directory);
    const releases = join(directory, "releases");
    await privateDirectory(releases);
    const result = join(releases, releaseDirectoryName(identity));
    await privateDirectory(result);
    return result;
  }
  async function current(): Promise<ReleaseIdentity | null> {
    const identity = await selected.read();
    if (identity !== null) await path(identity);
    return identity;
  }
  async function select(input: ReleaseIdentity | null, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const identity = ReleaseIdentity.nullable().parse(input);
    if (identity) {
      const root = await path(identity);
      const before = await privateDirectory(root);
      await verify(root, identity, signal);
      signal.throwIfAborted();
      // Recheck the pathname after the verifier; the install lock covers cooperating writers.
      await path(identity);
      const after = await privateDirectory(root);
      if (after.dev !== before.dev || after.ino !== before.ino)
        throw new Error("Installed release changed.");
    }
    signal.throwIfAborted();
    await selected.save(identity);
  }
  return { path, current, select };
}
