import { type ProvenanceArtifact, verifyNpmProvenance } from "./provenance-policy.ts";
import { RELEASE_PROVENANCE_PINS } from "./release-trust.ts";
import { createSigstoreVerifier } from "./sigstore-verifier.ts";

/** Connect the real cryptographic verifier and compiled release policy. The caller must obtain
 * trustedRootJSON from authenticated TUF metadata; it is not a field of the candidate release.
 * Default installer wiring and authenticated root acquisition are separate required steps.
 */
export function createReleaseProvenanceVerifier(trustedRootJSON: string) {
  const verifyBundle = createSigstoreVerifier(trustedRootJSON);
  return (docJSON: string, artifact: ProvenanceArtifact, signal: AbortSignal) =>
    verifyNpmProvenance(docJSON, artifact, RELEASE_PROVENANCE_PINS, verifyBundle, signal);
}
