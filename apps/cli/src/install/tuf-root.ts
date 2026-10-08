import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { type Fetcher, Updater } from "tuf-js";
import { TufVersions } from "../../../../packages/protocol/src/install-update.ts";
import seed from "./sigstore-tuf-root.json" with { type: "json" };
import { MAX_TUF_BYTES, SIGSTORE_TUF_MIRROR, tufFetcher } from "./tuf-fetcher.ts";

const fail = () => new Error("Signing trust metadata did not verify.");
const roles = ["root", "timestamp", "snapshot", "targets"] as const;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Run only in the terminable verification worker. Empty private storage prevents ambient cache
 * trust; persisted version/hash floors prevent rollback across installer runs. TUF handles signed
 * root rotation, role thresholds, expiry, metadata binding and the target's actual hash/length.
 * Test seams supply a signed synthetic seed/fetcher; production always uses the compiled seed.
 */
export async function refreshSigstoreRoot(
  directory: string,
  previousInput: TufVersions | null,
  signal: AbortSignal,
  fetcher: Fetcher = tufFetcher(directory, signal),
  seedJSON = JSON.stringify(seed),
): Promise<{ rootJSON: string; versions: TufVersions }> {
  signal.throwIfAborted();
  try {
    const previous = previousInput === null ? null : TufVersions.parse(previousInput);
    const stat = await lstat(directory);
    if (
      !isAbsolute(directory) ||
      normalize(directory) !== directory ||
      directory === "/" ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o700 ||
      (await realpath(directory)) !== directory ||
      (await readdir(directory)).length !== 0
    )
      throw fail();
    const metadataDir = join(directory, "metadata"),
      targetDir = join(directory, "targets");
    await mkdir(metadataDir, { mode: 0o700 });
    await mkdir(targetDir, { mode: 0o700 });
    await writeFile(join(metadataDir, "root.json"), seedJSON, { flag: "wx", mode: 0o600 });
    const updater = new Updater({
      metadataDir,
      targetDir,
      metadataBaseUrl: SIGSTORE_TUF_MIRROR,
      targetBaseUrl: `${SIGSTORE_TUF_MIRROR}/targets`,
      fetcher,
      forceCache: false,
      config: {
        maxRootRotations: 64,
        maxDelegations: 0,
        rootMaxLength: 512000,
        timestampMaxLength: 16384,
        snapshotMaxLength: MAX_TUF_BYTES,
        targetsMaxLength: MAX_TUF_BYTES,
      },
    });
    await updater.refresh();
    signal.throwIfAborted();
    const current: Record<string, { version: number; sha256: string }> = {};
    for (const role of roles) {
      const bytes = await readFile(join(metadataDir, `${role}.json`));
      current[role] = {
        version: JSON.parse(bytes.toString()).signed.version,
        sha256: sha256(bytes),
      };
    }
    const versions = TufVersions.parse(current);
    for (const role of roles) {
      const old = previous?.[role],
        now = versions[role];
      if (
        old &&
        (now.version < old.version || (now.version === old.version && now.sha256 !== old.sha256))
      )
        throw fail();
    }
    const target = await updater.getTargetInfo("trusted_root.json");
    if (!target || target.length < 1 || target.length > MAX_TUF_BYTES) throw fail();
    const path = await updater.downloadTarget(target);
    signal.throwIfAborted();
    const bytes = await readFile(path);
    if (bytes.length > MAX_TUF_BYTES) throw fail();
    return { rootJSON: new TextDecoder("utf-8", { fatal: true }).decode(bytes), versions };
  } catch {
    signal.throwIfAborted();
    throw fail();
  }
}
