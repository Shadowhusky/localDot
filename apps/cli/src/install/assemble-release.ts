import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { ReleaseIdentity } from "../../../../packages/protocol/src/install-update.ts";
import type { ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { createAssemblyScratch } from "./assembly-scratch.ts";
import { copyInventory } from "./copy-inventory.ts";
import type { InstallLockLifetime } from "./install-lock.ts";
import { verifyReleaseKeyd } from "./keyd-verification.ts";
import { withStagedDownload } from "./stage-download.ts";
import { withStagedKeyd } from "./stage-keyd.ts";
import { type ReleaseMetadataDigests, verifyStagedRelease } from "./staged-release.ts";

export interface AssembledRelease {
  directory: string;
  app: string;
  keyd: string;
  identity: ReleaseIdentity;
  manifest: ReleaseManifest;
  metadataDigests: ReleaseMetadataDigests;
  assemblySha256: string;
  dispose(): Promise<void>;
}

/** Produce an owned, verified preparation directory. The caller keeps the install lock and
 * must either finish dependency verification/promotion or dispose it. This changes no selected
 * release or service. Download lifetimes end before returning, so image/dependency operations
 * do not accidentally inherit registry deadlines. The receipt alone grants no activation right.
 */
export async function assembleRelease(
  parent: string,
  version: string,
  signal: AbortSignal,
  lifetime: InstallLockLifetime,
): Promise<AssembledRelease> {
  signal.throwIfAborted();
  const scratch = await createAssemblyScratch(parent, signal, lifetime);
  const { directory, dispose } = scratch;
  try {
    const app = join(directory, "app"),
      keydRoot = join(directory, "keyd");
    const result = await withStagedDownload(
      parent,
      version,
      signal,
      async (staged, abort) => {
        const manifest = staged.inventory.manifest;
        const identity = ReleaseIdentity.parse({
          version: manifest.version,
          packageSha256: staged.packageSha256,
          manifestSha256: staged.inventory.metadataDigests.releaseJson,
        });
        await scratch.assertOwned();
        await copyInventory(staged.root, app, staged.files, abort);
        const helper = await withStagedKeyd(
          parent,
          manifest,
          abort,
          async (helper, helperAbort) => {
            await copyInventory(helper.root, keydRoot, helper.files, helperAbort);
            return { archiveSha256: helper.packageSha256, files: helper.files };
          },
          directory,
        );
        await scratch.assertOwned();
        const copied = await verifyStagedRelease(app, staged.inventory.metadataDigests, abort);
        if (
          copied.manifest.version !== manifest.version ||
          copied.manifest.commit !== manifest.commit
        )
          throw new Error("Prepared app source changed.");
        const keyd = join(keydRoot, manifest.keyd.path);
        await verifyReleaseKeyd(keyd, manifest.keyd, abort);
        abort.throwIfAborted();
        const receipt = Buffer.from(
          `${JSON.stringify({ v: 1, phase: "assembled", identity, commit: manifest.commit, metadataDigests: staged.inventory.metadataDigests, appFiles: staged.files, keydPackageSha256: helper.archiveSha256, keydFiles: helper.files })}\n`,
        );
        if (receipt.length > 4 * 1024 * 1024)
          throw new Error("Prepared release inventory is too large.");
        const handle = await open(
          join(directory, "assembly.json"),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(receipt);
          await handle.sync();
        } finally {
          await handle.close();
        }
        const dirHandle = await open(
          directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
        abort.throwIfAborted();
        return Object.freeze({
          directory,
          app,
          keyd,
          identity: Object.freeze(identity),
          manifest: copied.manifest,
          metadataDigests: Object.freeze({ ...copied.metadataDigests }),
          assemblySha256: createHash("sha256").update(receipt).digest("hex"),
          dispose,
        });
      },
      directory,
    );
    signal.throwIfAborted();
    return result;
  } catch (error) {
    await dispose();
    signal.throwIfAborted();
    throw error;
  }
}
