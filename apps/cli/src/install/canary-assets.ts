import { join } from "node:path";
import { ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { privateDirectory } from "./copy-inventory.ts";
import { hashedFile } from "./installed-release.ts";

const paths = { scanner: "dist/canary-scan.py", worker: "dist/canary-worker.py" } as const;
export type CanaryAssets = { scanner: Buffer; worker: Buffer };

/** Caller holds the install lock and supplies the authenticated manifest from
 * readInstalledRelease. Read verified bytes for container upload, never execute
 * these programs on the host or resolve them from the development checkout. */
export async function readCanaryAssets(
  releaseDirectory: string,
  authenticated: ReleaseManifest,
  signal: AbortSignal,
): Promise<CanaryAssets> {
  try {
    signal.throwIfAborted();
    const manifest = ReleaseManifest.parse(authenticated);
    const directories = [
      releaseDirectory,
      join(releaseDirectory, "app"),
      join(releaseDirectory, "app/dist"),
    ];
    const before = [];
    for (const directory of directories) before.push(await privateDirectory(directory));
    const assets = {} as CanaryAssets;
    for (const role of ["scanner", "worker"] as const) {
      signal.throwIfAborted();
      const digest = manifest.files[paths[role]];
      if (!digest) throw new Error();
      const bytes = await hashedFile(
        join(releaseDirectory, "app", paths[role]),
        digest,
        128 * 1024,
        signal,
      );
      if (!bytes.length || new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0"))
        throw new Error();
      assets[role] = bytes;
    }
    for (const [index, directory] of directories.entries()) {
      const after = await privateDirectory(directory);
      if (after.dev !== before[index]?.dev || after.ino !== before[index]?.ino) throw new Error();
    }
    signal.throwIfAborted();
    return assets;
  } catch {
    throw new Error("The installed diagnostic programs failed verification.");
  }
}
