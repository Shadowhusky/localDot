import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SigstoreIdentityPolicy } from "./provenance-policy.ts";
import { createReleaseProvenanceVerifier } from "./release-provenance.ts";
import { createSigstoreVerifier } from "./sigstore-verifier.ts";

const read = (name: string) =>
  readFileSync(new URL(`./testing/sigstore/${name}`, import.meta.url), "utf8");
const root = read("trusted-root.json");
const raw = read("bundle.json");
const bundle = () => JSON.parse(raw);
const signal = () => new AbortController().signal;
const policy: SigstoreIdentityPolicy = {
  certificateIdentityURI:
    "^https://github\\.com/sigstore/sigstore-js/\\.github/workflows/release\\.yml@refs/heads/main$",
  certificateIssuer: "https://token.actions.githubusercontent.com",
  ctLogThreshold: 1,
  tlogThreshold: 1,
};
const verify = createSigstoreVerifier(root);
const corrupt = (base64: string) => {
  const bytes = Buffer.from(base64, "base64");
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  return bytes.toString("base64");
};

it("verifies a retained public npm DSSE attestation with real cryptography, offline", async () => {
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    "cc3504da26c938805487bbe2b58a3ba71fa4fdab09ce5a1ed14df59b10072a06",
  );
  expect(createHash("sha256").update(root).digest("hex")).toBe(
    "6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66",
  );
  await expect(verify(bundle(), policy, signal())).resolves.toBeUndefined();
});

describe("cryptographic rejection", () => {
  for (const attack of [
    "payload",
    "signature",
    "certificate",
    "log body",
    "log proof",
    "log timestamp",
    "log checkpoint",
    "no logs",
    "duplicate logs",
    "extra signatures",
    "public key",
  ]) {
    it(`rejects ${attack}`, async () => {
      const b = bundle();
      const material = b.verificationMaterial;
      const log = material.tlogEntries[0];
      switch (attack) {
        case "payload":
          b.dsseEnvelope.payload = corrupt(b.dsseEnvelope.payload);
          break;
        case "signature":
          b.dsseEnvelope.signatures[0].sig = corrupt(b.dsseEnvelope.signatures[0].sig);
          break;
        case "certificate":
          material.certificate.rawBytes = corrupt(material.certificate.rawBytes);
          break;
        case "log body":
          log.canonicalizedBody = corrupt(log.canonicalizedBody);
          break;
        case "log proof":
          log.inclusionProof.hashes[0] = corrupt(log.inclusionProof.hashes[0]);
          break;
        case "log timestamp":
          log.integratedTime = "1";
          break;
        case "log checkpoint":
          log.inclusionProof.checkpoint.envelope = log.inclusionProof.checkpoint.envelope.replace(
            /[A-Za-z0-9+/]+={0,2}\n$/,
            (signature: string) => `${corrupt(signature.trim())}\n`,
          );
          break;
        case "no logs":
          material.tlogEntries = [];
          break;
        case "duplicate logs":
          material.tlogEntries.push(log);
          break;
        case "extra signatures":
          b.dsseEnvelope.signatures.push(b.dsseEnvelope.signatures[0]);
          break;
        case "public key":
          delete material.certificate;
          material.publicKey = { hint: "attacker" };
      }
      await expect(verify(b, policy, signal())).rejects.toThrow(
        "Release signature verification failed.",
      );
    });
  }
});

it("requires the exact signer and issuer and refuses disabled transparency checks", async () => {
  for (const changed of [
    { certificateIdentityURI: policy.certificateIdentityURI.replace("sigstore-js", "different") },
    {
      certificateIdentityURI: policy.certificateIdentityURI.replace(
        "heads/main",
        "tags/v5\\.0\\.0",
      ),
    },
    { certificateIdentityURI: ".*" },
    { certificateIssuer: "https://issuer.invalid" },
    { ctLogThreshold: 0 },
    { tlogThreshold: 0 },
  ]) {
    await expect(
      verify(bundle(), { ...policy, ...changed } as SigstoreIdentityPolicy, signal()),
    ).rejects.toThrow("Release signature verification failed.");
  }
});

it("does not accept valid foreign provenance as a localDot release", async () => {
  const b = bundle();
  const statement = JSON.parse(Buffer.from(b.dsseEnvelope.payload, "base64").toString());
  const doc = JSON.stringify({
    attestations: [{ predicateType: statement.predicateType, bundle: b }],
  });
  await expect(
    createReleaseProvenanceVerifier(root)(
      doc,
      {
        name: "localdot",
        version: "5.0.0",
        sha512: statement.subject[0].digest.sha512,
        commit: statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit,
      },
      signal(),
    ),
  ).rejects.toThrow("Release provenance did not verify");
});

it("requires independently supplied trust anchors, never bundle-provided roots", async () => {
  for (const key of ["certificateAuthorities", "ctlogs", "tlogs"]) {
    const changed = JSON.parse(root);
    changed[key] = [];
    expect(() => createSigstoreVerifier(JSON.stringify(changed))).toThrow(
      "Release signature verification failed.",
    );
  }
  expect(() => createSigstoreVerifier("{}")).toThrow("Release signature verification failed.");
  expect(() => createSigstoreVerifier("secret invalid input")).toThrow(
    "Release signature verification failed.",
  );
});

it("bounds parsing and work, redacts library failures, and preserves cancellation", async () => {
  const oversized = { ...bundle(), padding: "a".repeat(2 * 1024 * 1024) };
  const manyLogs = bundle();
  manyLogs.verificationMaterial.tlogEntries = Array(9).fill(
    manyLogs.verificationMaterial.tlogEntries[0],
  );
  const manyHashes = bundle();
  manyHashes.verificationMaterial.tlogEntries[0].inclusionProof.hashes = Array(65).fill("AA==");
  for (const value of [oversized, manyLogs, manyHashes, null, { secret: "must not escape" }]) {
    await expect(verify(value, policy, signal())).rejects.toThrow(
      /^Release signature verification failed\.$/,
    );
  }
  const controller = new AbortController();
  const reason = new Error("user stopped verification");
  controller.abort(reason);
  await expect(verify(bundle(), policy, controller.signal)).rejects.toBe(reason);
});
