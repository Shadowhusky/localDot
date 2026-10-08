import { type ExtractedRelease, withExtractedRelease } from "./extract-release.ts";
import { type StagedReleaseInventory, verifyStagedRelease } from "./staged-release.ts";
import { withVerifiedDownload } from "./verified-download.ts";

export interface StagedDownload {
  root: string;
  packageSha256: string;
  inventory: StagedReleaseInventory;
  files: ExtractedRelease["files"];
}

/** Production root-package staging path. Acquisition, fresh provenance, extraction of those
 * same bytes, full file inventory and manifest source/version checks all precede work.
 * Caller holds the install lock. Work must finish using the tree before returning.
 * This still does not install dependencies, acquire keyd, pull images or activate services.
 */
export function withStagedDownload<T>(
  parent: string,
  version: string,
  signal: AbortSignal,
  work: (release: StagedDownload, signal: AbortSignal) => Promise<T>,
  scratchParent = parent,
): Promise<T> {
  return withVerifiedDownload(
    parent,
    { name: "localdot", version },
    signal,
    (release, abort) =>
      withExtractedRelease(scratchParent, release, abort, async (extracted) => {
        const packageJson = extracted.files["package.json"]?.sha256;
        const releaseJson = extracted.files["release.json"]?.sha256;
        if (!packageJson || !releaseJson) throw new Error("Release metadata is missing.");
        const inventory = await verifyStagedRelease(
          extracted.root,
          { packageJson, releaseJson },
          abort,
        );
        if (
          inventory.manifest.version !== release.version ||
          inventory.manifest.commit !== release.commit
        )
          throw new Error("Release metadata does not match authenticated provenance.");
        abort.throwIfAborted();
        return work(
          Object.freeze({
            root: extracted.root,
            packageSha256: release.sha256,
            inventory,
            files: extracted.files,
          }),
          abort,
        );
      }),
    scratchParent,
  );
}
