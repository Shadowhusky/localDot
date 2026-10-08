import { bundleFromJSON, isBundleWithDsseEnvelope } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import type { VerifySigstoreBundle } from "./provenance-policy.ts";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const failure = () => new Error("Release signature verification failed.");

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
  return value as Record<string, unknown>;
}

/** Offline cryptographic adapter. trustedRootJSON must be independently authenticated by TUF
 * before calling this factory, never taken from an artifact or its attestation. This factory
 * neither authenticates/freshens a trust root nor fetches anything. No ambient cache, network,
 * signing key, environment configuration or public-key selector participates in verification.
 */
export function createSigstoreVerifier(trustedRootJSON: string): VerifySigstoreBundle {
  let verifier: Verifier;
  try {
    if (typeof trustedRootJSON !== "string" || Buffer.byteLength(trustedRootJSON) > MAX_JSON_BYTES)
      throw failure();
    const root = TrustedRoot.fromJSON(JSON.parse(trustedRootJSON));
    if (
      root.mediaType !== "application/vnd.dev.sigstore.trustedroot+json;version=0.1" ||
      !root.certificateAuthorities.length ||
      !root.ctlogs.length ||
      !root.tlogs.length
    )
      throw failure();
    verifier = new Verifier(toTrustMaterial(root), {
      ctlogThreshold: 1,
      tlogThreshold: 1,
      timestampThreshold: 1,
    });
  } catch {
    throw failure();
  }

  return async (input, policy, signal) => {
    signal.throwIfAborted();
    try {
      // The policy is independently constructed by verifyNpmProvenance. Never spread candidate
      // options into the verifier: the log and timestamp thresholds cannot be disabled.
      if (
        policy.ctLogThreshold !== 1 ||
        policy.tlogThreshold !== 1 ||
        policy.certificateIssuer !== "https://token.actions.githubusercontent.com" ||
        typeof policy.certificateIdentityURI !== "string" ||
        policy.certificateIdentityURI.length > 2048 ||
        !policy.certificateIdentityURI.startsWith("^") ||
        !policy.certificateIdentityURI.endsWith("$")
      )
        throw failure();
      const json = JSON.stringify(input);
      if (!json || Buffer.byteLength(json) > MAX_JSON_BYTES) throw failure();
      const value = record(JSON.parse(json));
      const material = record(value.verificationMaterial);
      const envelope = record(value.dsseEnvelope);
      // Bound attacker-controlled repeated structures before ASN.1/crypto work. The npm release
      // profile uses a single DSSE signature and a Fulcio certificate, not arbitrary public keys.
      if (
        envelope.payloadType !== "application/vnd.in-toto+json" ||
        !Array.isArray(envelope.signatures) ||
        envelope.signatures.length !== 1 ||
        material.publicKey !== undefined ||
        !Array.isArray(material.tlogEntries) ||
        material.tlogEntries.length < 1 ||
        material.tlogEntries.length > 8
      )
        throw failure();
      const chain = material.x509CertificateChain;
      if (chain !== undefined) {
        const certificates = record(chain).certificates;
        if (!Array.isArray(certificates) || certificates.length < 1 || certificates.length > 8)
          throw failure();
      }
      const timestamps = material.timestampVerificationData;
      if (timestamps !== undefined) {
        const entries = record(timestamps).rfc3161Timestamps;
        if (!Array.isArray(entries) || entries.length > 4) throw failure();
      }
      for (const entry of material.tlogEntries) {
        const proof = record(entry).inclusionProof;
        if (proof !== undefined) {
          const hashes = record(proof).hashes;
          if (!Array.isArray(hashes) || hashes.length > 64) throw failure();
        }
      }
      const bundle = bundleFromJSON(value);
      if (!isBundleWithDsseEnvelope(bundle)) throw failure();
      const entity = toSignedEntity(bundle);
      if (entity.key.$case !== "certificate") throw failure();
      signal.throwIfAborted();
      verifier.verify(entity, {
        subjectAlternativeName: policy.certificateIdentityURI,
        extensions: { issuer: policy.certificateIssuer },
      });
      signal.throwIfAborted();
    } catch {
      signal.throwIfAborted();
      // Library failures may include candidate-controlled contents; never surface them to UI/logs.
      throw failure();
    }
  };
}
