import { expect, it, vi } from "vitest";
import {
  type ProvenanceArtifact,
  type VerifySigstoreBundle,
  verifyNpmProvenance,
} from "./provenance-policy.ts";

const signal = () => new AbortController().signal;
function fixture(name: ProvenanceArtifact["name"] = "localdot") {
  const pins = {
    repository: "https://github.com/Shadowhusky/localdot",
    workflow: ".github/workflows/release.yml",
    issuer: "https://token.actions.githubusercontent.com",
  };
  const artifact: ProvenanceArtifact = {
    name,
    version: "1.2.3",
    sha512: "a".repeat(128),
    commit: "b".repeat(40),
  };
  const ref = `refs/tags/v${artifact.version}`;
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: `pkg:npm/${name.replace(/^@/, "%40")}@${artifact.version}`,
        digest: { sha512: artifact.sha512 },
      },
    ],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { repository: pins.repository, path: pins.workflow, ref } },
        resolvedDependencies: [
          { uri: `git+${pins.repository}@${ref}`, digest: { gitCommit: artifact.commit } },
        ],
      },
    },
  };
  const document = () => ({
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          },
          // No signatures in policy fixtures. A real Sigstore adapter must reject these bundles.
        },
      },
    ],
  });
  const json = () => JSON.stringify(document());
  return { pins, artifact, statement, document, json };
}
function change(object: unknown, path: string, value: unknown) {
  const parts = path.split(".");
  let current = object as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) current = current[part] as Record<string, unknown>;
  current[parts.at(-1) ?? ""] = value;
}
it.each(["localdot", "@localdot/keyd-darwin-arm64"] as const)(
  "binds the %s archive and commit after invoking the required cryptographic verifier",
  async (name) => {
    const f = fixture(name),
      verify = vi.fn<VerifySigstoreBundle>(async () => {});
    expect(
      (await verifyNpmProvenance(f.json(), f.artifact, f.pins, verify, signal())).artifact,
    ).toEqual(f.artifact);
    expect(verify).toHaveBeenCalledTimes(1);
    const policy = verify.mock.calls[0]?.[1];
    expect(policy).toBeDefined();
    expect(policy?.certificateIssuer).toBe(f.pins.issuer);
    expect(policy?.tlogThreshold).toBe(1);
    expect(policy?.ctLogThreshold).toBe(1);
    const pattern = new RegExp(policy?.certificateIdentityURI ?? "never");
    const identity = `${f.pins.repository}/${f.pins.workflow}@refs/tags/v1.2.3`;
    expect(pattern.test(identity)).toBe(true);
    for (const hostile of [
      `prefix${identity}`,
      `${identity}/extra`,
      identity.replace("github.com", "githubXcom"),
      identity.replace("release.yml", "releaseXyml"),
      identity.replace("v1.2.3", "v1X2X3"),
      identity.replace("refs/tags", "refs/heads"),
    ])
      expect(pattern.test(hostile)).toBe(false);
  },
);
it.each([
  ["_type", "https://in-toto.io/Statement/v0.1"],
  ["predicateType", "other"],
  ["subject.0.name", "pkg:npm/another@1.2.3"],
  ["subject.0.digest.sha512", "c".repeat(128)],
  ["predicate.buildDefinition.buildType", "another-builder"],
  [
    "predicate.buildDefinition.externalParameters.workflow.repository",
    "https://github.com/other/localdot",
  ],
  ["predicate.buildDefinition.externalParameters.workflow.path", ".github/workflows/other.yml"],
  ["predicate.buildDefinition.externalParameters.workflow.ref", "refs/heads/main"],
  [
    "predicate.buildDefinition.resolvedDependencies.0.uri",
    "git+https://github.com/other/localdot@refs/tags/v1.2.3",
  ],
  ["predicate.buildDefinition.resolvedDependencies.0.digest.gitCommit", "c".repeat(40)],
])("rejects mismatched %s even with a successful signature callback", async (path, value) => {
  const f = fixture();
  change(f.statement, path, value);
  await expect(
    verifyNpmProvenance(f.json(), f.artifact, f.pins, async () => {}, signal()),
  ).rejects.toThrow("provenance did not verify");
});
it.each(["subject", "source", "attestation"])("rejects ambiguous duplicate %s", async (kind) => {
  const f = fixture();
  if (kind === "subject")
    f.statement.subject.push(
      structuredClone(f.statement.subject[0] as (typeof f.statement.subject)[number]),
    );
  if (kind === "source")
    f.statement.predicate.buildDefinition.resolvedDependencies.push(
      structuredClone(
        f.statement.predicate.buildDefinition
          .resolvedDependencies[0] as (typeof f.statement.predicate.buildDefinition.resolvedDependencies)[number],
      ),
    );
  const doc = f.document();
  if (kind === "attestation")
    doc.attestations.push(
      structuredClone(doc.attestations[0] as (typeof doc.attestations)[number]),
    );
  await expect(
    verifyNpmProvenance(JSON.stringify(doc), f.artifact, f.pins, async () => {}, signal()),
  ).rejects.toThrow();
});
it.each(["bad-json", "huge", "bad-base64", "payload-type", "bad-issuer"])(
  "rejects %s before invoking Sigstore",
  async (kind) => {
    const f = fixture(),
      verify = vi.fn<VerifySigstoreBundle>(async () => {});
    const doc = f.document();
    if (kind === "bad-base64")
      change(doc, "attestations.0.bundle.dsseEnvelope.payload", "not base64!");
    if (kind === "payload-type")
      change(doc, "attestations.0.bundle.dsseEnvelope.payloadType", "text/plain");
    if (kind === "bad-issuer") f.pins.issuer = "https://attacker.invalid";
    const json =
      kind === "bad-json"
        ? "{"
        : kind === "huge"
          ? " ".repeat(2 * 1024 * 1024 + 1)
          : JSON.stringify(doc);
    await expect(verifyNpmProvenance(json, f.artifact, f.pins, verify, signal())).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
  },
);
it("never converts a signature failure into success or echoes the verifier diagnostic", async () => {
  const f = fixture();
  await expect(
    verifyNpmProvenance(
      f.json(),
      f.artifact,
      f.pins,
      async () => {
        throw new Error("private diagnostic");
      },
      signal(),
    ),
  ).rejects.toThrow(/^Release provenance did not verify for the requested artifact\.$/);
});
it("rejects bundle mutation during async cryptographic verification", async () => {
  const f = fixture();
  await expect(
    verifyNpmProvenance(
      f.json(),
      f.artifact,
      f.pins,
      async (bundle) => {
        change(bundle, "dsseEnvelope.payload", "e30=");
      },
      signal(),
    ),
  ).rejects.toThrow();
});
it("snapshots expected pins/artifact and preserves cancellation", async () => {
  const f = fixture(),
    expected = { ...f.artifact };
  const result = await verifyNpmProvenance(
    f.json(),
    f.artifact,
    f.pins,
    async () => {
      f.artifact.version = "9.9.9";
      f.pins.repository = "https://github.com/other/repo";
    },
    signal(),
  );
  expect(result.artifact).toEqual(expected);
  const fresh = fixture(),
    controller = new AbortController(),
    reason = new Error("cancelled");
  await expect(
    verifyNpmProvenance(
      fresh.json(),
      fresh.artifact,
      fresh.pins,
      async () => {
        controller.abort(reason);
      },
      controller.signal,
    ),
  ).rejects.toBe(reason);
});
