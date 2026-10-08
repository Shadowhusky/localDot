import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { TufVersions } from "../../../../packages/protocol/src/install-update.ts";
import { KEYD_PACKAGE, RELEASE_VERSION } from "../../../../packages/protocol/src/release.ts";
import { privateDirectory } from "./copy-inventory.ts";
import { privateRecordStore } from "./private-record.ts";
import type { ProvenanceArtifact } from "./provenance-policy.ts";
import { runVerificationWorker } from "./verification-worker-host.ts";

declare const __LOCALDOT_PACKAGED__: boolean;

export function assertTrustFloors(versionsInput: TufVersions, previousInput: TufVersions | null) {
  const versions = TufVersions.parse(versionsInput),
    previous = TufVersions.nullable().parse(previousInput);
  for (const role of ["root", "timestamp", "snapshot", "targets"] as const) {
    const old = previous?.[role],
      current = versions[role];
    if (
      old &&
      (current.version < old.version ||
        (current.version === old.version && current.sha256 !== old.sha256))
    )
      throw new Error("Signing trust metadata went backwards.");
  }
}

/** Authenticate against fresh trust without modifying durable version floors. Only this owned
 * worker scratch is changed. Bootstrap uses this before a verified helper can acquire the lock.
 */
export async function previewReleaseTrust(
  parent: string,
  previousInput: TufVersions | null,
  docJSON: string,
  artifactInput: ProvenanceArtifact,
  signal: AbortSignal,
): Promise<TufVersions> {
  signal.throwIfAborted();
  const previous = TufVersions.nullable().parse(previousInput);
  const artifact = { ...artifactInput };
  if (
    typeof docJSON !== "string" ||
    Buffer.byteLength(docJSON) > 2 * 1024 * 1024 ||
    !["localdot", KEYD_PACKAGE].includes(artifact.name) ||
    typeof artifact.version !== "string" ||
    artifact.version.length > 64 ||
    !RELEASE_VERSION.test(artifact.version) ||
    typeof artifact.sha512 !== "string" ||
    !/^[0-9a-f]{128}$/.test(artifact.sha512) ||
    typeof artifact.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(artifact.commit)
  )
    throw new Error("Invalid release verification request.");
  await privateDirectory(parent);
  signal.throwIfAborted();
  const directory = await realpath(await mkdtemp(join(parent, ".verify-")));
  try {
    const packaged = typeof __LOCALDOT_PACKAGED__ !== "undefined" && __LOCALDOT_PACKAGED__;
    const entry = new URL(
      packaged ? "./release-verification-worker.mjs" : "./release-verification-worker.ts",
      import.meta.url,
    );
    const versions = await runVerificationWorker(
      entry,
      { directory, previous, docJSON, artifact },
      signal,
    );
    signal.throwIfAborted();
    assertTrustFloors(versions, previous);
    return TufVersions.parse(versions);
  } finally {
    // runVerificationWorker does not settle until the worker is terminal.
    await rm(directory, { recursive: true, force: true });
  }
}

/** Caller holds the installer lock. Only fresh successful verification advances durable floors.
 * Reread the actual record before save; a worker's starting snapshot is not the current floor.
 * A separate scratchParent confines worker files without relocating or resetting those floors.
 */
export async function verifyReleaseWithFreshTrust(
  installDirectory: string,
  docJSON: string,
  artifactInput: ProvenanceArtifact,
  signal: AbortSignal,
  scratchParent = installDirectory,
): Promise<void> {
  signal.throwIfAborted();
  const artifact = { ...artifactInput };
  const store = privateRecordStore(installDirectory, "trust-versions.json", TufVersions);
  const previous = await store.read();
  const versions = await previewReleaseTrust(scratchParent, previous, docJSON, artifact, signal);
  signal.throwIfAborted();
  const current = await store.read();
  if (previous && !current) throw new Error("Signing trust metadata disappeared.");
  assertTrustFloors(versions, current);
  signal.throwIfAborted();
  await store.save(versions);
  signal.throwIfAborted();
}
