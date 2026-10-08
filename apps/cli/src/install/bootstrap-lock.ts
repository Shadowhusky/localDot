import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TufVersions } from "../../../../packages/protocol/src/install-update.ts";
import {
  KEYD_IDENTIFIER,
  KEYD_PACKAGE,
  type ReleaseManifest,
} from "../../../../packages/protocol/src/release.ts";
import { withAcquiredRelease } from "./acquire-release.ts";
import { recoverBootstrapScratch, withBootstrapScratch } from "./bootstrap-scratch.ts";
import { copyInventory, privateDirectory } from "./copy-inventory.ts";
import { withExtractedRelease } from "./extract-release.ts";
import { type InstallLockLifetime, keydLockAcquirer, withInstallLock } from "./install-lock.ts";
import { verifyReleaseKeyd } from "./keyd-verification.ts";
import { privateRecordStore } from "./private-record.ts";
import { registryResourceURL } from "./registry-download.ts";
import { KEYD_RELEASE_TEAM_ID } from "./release-trust.ts";
import { claimedReleaseCommit } from "./verified-download.ts";
import {
  assertTrustFloors,
  previewReleaseTrust,
  verifyReleaseWithFreshTrust,
} from "./verify-release.ts";

const fail = () => new Error("The installation lock helper could not be authenticated.");
const required = ["package.json", "bin/keyd", "LICENSE", "THIRD-PARTY.md"];

/** Valid only inside the awaited lock callback. Runtime cleanup must use this authenticated
 * bootstrap helper, not an executable from a possibly damaged installed release. */
export type LockedInstallHelper = Readonly<{
  keydPath: string;
  installLifetime: InstallLockLifetime;
}>;

/** Acquire the first lock without trusting an installed executable. Only a fresh provenance-
 * authenticated, Apple-signed helper may execute the fixed install-lock command. The callback
 * begins after locked fresh revalidation/commit, and must drain all work before returning.
 * Helper files remain owned until the lock is released. No services or vault are started here.
 */
export async function withBootstrapInstallLock<T>(
  state: string,
  version: string,
  signal: AbortSignal,
  work: (helper: LockedInstallHelper) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const pkg = Object.freeze({ name: KEYD_PACKAGE, version });
  registryResourceURL({ ...pkg, kind: "archive" });
  await privateDirectory(state);
  const floors = privateRecordStore(state, "trust-versions.json", TufVersions);
  const previous = await floors.read();
  signal.throwIfAborted();
  return withBootstrapScratch(state, signal, async (directory) => {
    const helper = await withAcquiredRelease(directory, pkg, signal, async (release, active) => {
      if (release.name !== pkg.name || release.version !== pkg.version) throw fail();
      const commit = claimedReleaseCommit(release.attestationJSON, pkg);
      const artifact = Object.freeze({
        name: release.name,
        version: release.version,
        sha512: release.sha512,
        commit,
      });
      const docJSON = release.attestationJSON;
      const versions = await previewReleaseTrust(directory, previous, docJSON, artifact, active);
      return withExtractedRelease(directory, release, active, async (extracted) => {
        const names = Object.keys(extracted.files);
        if (
          names.length > 64 ||
          required.some((name) => !extracted.files[name]?.bytes) ||
          names.some(
            (name) => !required.includes(name) && !/^licenses\/[A-Za-z0-9_-]+\.txt$/.test(name),
          )
        )
          throw fail();
        for (const [name, file] of Object.entries(extracted.files))
          if (name !== "bin/keyd" && (file.bytes > 1024 * 1024 || file.mode !== 0o600))
            throw fail();
        const raw = await readFile(join(extracted.root, "package.json"));
        const metadata: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        if (
          !metadata ||
          typeof metadata !== "object" ||
          Array.isArray(metadata) ||
          !("name" in metadata) ||
          metadata.name !== pkg.name ||
          !("version" in metadata) ||
          metadata.version !== pkg.version ||
          !("os" in metadata) ||
          JSON.stringify(metadata.os) !== '["darwin"]' ||
          !("cpu" in metadata) ||
          JSON.stringify(metadata.cpu) !== '["arm64"]' ||
          [
            "scripts",
            "dependencies",
            "optionalDependencies",
            "devDependencies",
            "peerDependencies",
            "bundledDependencies",
            "bundleDependencies",
            "bin",
            "gypfile",
          ].some((field) => field in metadata)
        )
          throw fail();
        const binary = extracted.files["bin/keyd"];
        if (!binary) throw fail();
        const expected: ReleaseManifest["keyd"] = Object.freeze({
          package: KEYD_PACKAGE,
          path: "bin/keyd",
          sha256: binary.sha256,
          identifier: KEYD_IDENTIFIER,
          teamId: KEYD_RELEASE_TEAM_ID,
        });
        await verifyReleaseKeyd(join(extracted.root, "bin/keyd"), expected, active);
        const copied = join(directory, "helper");
        await copyInventory(extracted.root, copied, extracted.files, active);
        const path = join(copied, "bin/keyd");
        await verifyReleaseKeyd(path, expected, active);
        active.throwIfAborted();
        return Object.freeze({ path, expected, versions, artifact, docJSON });
      });
    });
    // The acquisition deadline is over before lock-protected installation starts.
    signal.throwIfAborted();
    const current = await floors.read();
    if (previous && !current) throw fail();
    assertTrustFloors(helper.versions, current);
    await verifyReleaseKeyd(helper.path, helper.expected, signal);
    return withInstallLock(
      state,
      signal,
      keydLockAcquirer(helper.path),
      async (installLifetime) => {
        await verifyReleaseWithFreshTrust(
          state,
          helper.docJSON,
          helper.artifact,
          signal,
          directory,
        );
        await verifyReleaseKeyd(helper.path, helper.expected, signal);
        signal.throwIfAborted();
        await recoverBootstrapScratch(state, helper.path, signal, installLifetime);
        return work(Object.freeze({ keydPath: helper.path, installLifetime }));
      },
    );
  });
}
