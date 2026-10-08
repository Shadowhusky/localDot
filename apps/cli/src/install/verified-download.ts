import { type AcquiredRelease, withAcquiredRelease } from "./acquire-release.ts";
import { type RegistryPackage, registryResourceURL } from "./registry-download.ts";
import { RELEASE_PROVENANCE_PINS } from "./release-trust.ts";
import { verifyReleaseWithFreshTrust } from "./verify-release.ts";

const fail = () => new Error("Release source could not be authenticated.");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
}

/** A bounded UNAUTHENTICATED claim, used only as input to the real verifier. No authority is
 * granted by this parser. The compiled repository/workflow/tag and actual archive hash must pass
 * fresh TUF/Sigstore before the caller may treat this source commit as verified.
 */
export function claimedReleaseCommit(docJSON: string, pkg: RegistryPackage): string {
  try {
    registryResourceURL({ ...pkg, kind: "attestation" });
    if (typeof docJSON !== "string" || Buffer.byteLength(docJSON) > 2 * 1024 * 1024) throw fail();
    const doc = record(JSON.parse(docJSON));
    if (!Array.isArray(doc.attestations) || doc.attestations.length > 16) throw fail();
    const matches = doc.attestations
      .map(record)
      .filter((a) => a.predicateType === "https://slsa.dev/provenance/v1");
    if (matches.length !== 1) throw fail();
    const envelope = record(record(matches[0]?.bundle).dsseEnvelope),
      payload = envelope.payload;
    if (
      envelope.payloadType !== "application/vnd.in-toto+json" ||
      typeof payload !== "string" ||
      payload.length > 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)
    )
      throw fail();
    const bytes = Buffer.from(payload, "base64");
    if (bytes.toString("base64") !== payload) throw fail();
    const statement = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const build = record(record(statement.predicate).buildDefinition);
    if (!Array.isArray(build.resolvedDependencies) || build.resolvedDependencies.length > 64)
      throw fail();
    const source = build.resolvedDependencies
      .map(record)
      .filter(
        (d) => d.uri === `git+${RELEASE_PROVENANCE_PINS.repository}@refs/tags/v${pkg.version}`,
      );
    if (source.length !== 1) throw fail();
    const commit = record(source[0]?.digest).gitCommit;
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw fail();
    return commit;
  } catch {
    throw fail();
  }
}

export interface VerifiedDownload extends AcquiredRelease {
  commit: string;
}

/** Holds the download's lifetime through authentication and consumer drain. Caller holds the
 * install lock. Success authenticates archive bytes, not their safety: extraction, manifest,
 * signature, dependency and image verification remain required before installation/execution.
 * scratchParent may be the recorded assembly; parent always owns the durable trust floors.
 */
export function withVerifiedDownload<T>(
  parent: string,
  pkg: RegistryPackage,
  signal: AbortSignal,
  work: (release: Readonly<VerifiedDownload>, signal: AbortSignal) => Promise<T>,
  scratchParent = parent,
): Promise<T> {
  return withAcquiredRelease(scratchParent, pkg, signal, async (release, abort) => {
    const commit = claimedReleaseCommit(release.attestationJSON, release);
    await verifyReleaseWithFreshTrust(
      parent,
      release.attestationJSON,
      { name: release.name, version: release.version, sha512: release.sha512, commit },
      abort,
      scratchParent,
    );
    abort.throwIfAborted();
    return work(Object.freeze({ ...release, commit }), abort);
  });
}
