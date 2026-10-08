import { KEYD_PACKAGE, RELEASE_VERSION } from "../../../../packages/protocol/src/release.ts";

export interface ProvenanceArtifact {
  name: "localdot" | typeof KEYD_PACKAGE;
  version: string;
  // Hash the actual compressed archive bytes; never trust a registry assertion alone.
  sha512: string;
  commit: string;
}
export interface ProvenancePins {
  repository: string;
  workflow: string;
  issuer: string;
}
export interface SigstoreIdentityPolicy {
  certificateIdentityURI: string;
  certificateIssuer: string;
  ctLogThreshold: 1;
  tlogThreshold: 1;
}
export type VerifySigstoreBundle = (
  bundle: unknown,
  policy: SigstoreIdentityPolicy,
  signal: AbortSignal,
) => Promise<void>;
const SLSA = "https://slsa.dev/provenance/v1";
const BUILD = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const failure = () => new Error("Release provenance did not verify for the requested artifact.");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
  return value as Record<string, unknown>;
}
function exactRegex(value: string): string {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** Policy checks supplement, never replace, a real Sigstore verifier's certificate-chain,
 * signature and transparency-log checks. The required verifier adapter is not implemented here.
 * docJSON comes from the bounded npm attestation response; pins come from the installed CLI,
 * not that response or the candidate. The immutable input snapshot prevents async input mutation.
 */
export async function verifyNpmProvenance(
  docJSON: string,
  artifactInput: ProvenanceArtifact,
  pinsInput: ProvenancePins,
  verifyBundle: VerifySigstoreBundle,
  signal: AbortSignal,
): Promise<{ certificateIdentity: string; artifact: ProvenanceArtifact }> {
  signal.throwIfAborted();
  const artifact = { ...artifactInput },
    pins = { ...pinsInput };
  try {
    if (
      typeof docJSON !== "string" ||
      Buffer.byteLength(docJSON) > 2 * 1024 * 1024 ||
      !["localdot", KEYD_PACKAGE].includes(artifact.name) ||
      artifact.version.length > 64 ||
      !RELEASE_VERSION.test(artifact.version) ||
      !/^[0-9a-f]{128}$/.test(artifact.sha512) ||
      !/^[0-9a-f]{40}$/.test(artifact.commit) ||
      !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(pins.repository) ||
      !/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(pins.workflow) ||
      pins.issuer !== "https://token.actions.githubusercontent.com"
    )
      throw failure();
    const ref = `refs/tags/v${artifact.version}`;
    const certificateIdentity = `${pins.repository}/${pins.workflow}@${ref}`;
    const document = record(JSON.parse(docJSON));
    if (!Array.isArray(document.attestations) || document.attestations.length > 16) throw failure();
    const matching = document.attestations.map(record).filter((a) => a.predicateType === SLSA);
    if (matching.length !== 1) throw failure();
    const bundle = record(matching[0]?.bundle);
    const envelope = record(bundle.dsseEnvelope);
    const payload = envelope.payload;
    if (
      envelope.payloadType !== "application/vnd.in-toto+json" ||
      typeof payload !== "string" ||
      payload.length > 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)
    )
      throw failure();
    const bytes = Buffer.from(payload, "base64");
    if (bytes.toString("base64") !== payload) throw failure();
    const bundleSnapshot = JSON.stringify(bundle);
    signal.throwIfAborted();
    await verifyBundle(
      bundle,
      {
        certificateIdentityURI: exactRegex(certificateIdentity),
        certificateIssuer: pins.issuer,
        ctLogThreshold: 1,
        tlogThreshold: 1,
      },
      signal,
    );
    signal.throwIfAborted();
    if (JSON.stringify(bundle) !== bundleSnapshot) throw failure();
    const statement = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (
      statement._type !== "https://in-toto.io/Statement/v1" ||
      statement.predicateType !== SLSA ||
      !Array.isArray(statement.subject) ||
      statement.subject.length !== 1
    )
      throw failure();
    const subject = record(statement.subject[0]);
    if (
      subject.name !== `pkg:npm/${artifact.name.replace(/^@/, "%40")}@${artifact.version}` ||
      record(subject.digest).sha512 !== artifact.sha512
    )
      throw failure();
    const build = record(record(statement.predicate).buildDefinition);
    const workflow = record(record(build.externalParameters).workflow);
    if (
      build.buildType !== BUILD ||
      workflow.repository !== pins.repository ||
      workflow.path !== pins.workflow ||
      workflow.ref !== ref ||
      !Array.isArray(build.resolvedDependencies) ||
      build.resolvedDependencies.length > 64
    )
      throw failure();
    const source = build.resolvedDependencies
      .map(record)
      .filter((d) => d.uri === `git+${pins.repository}@${ref}`);
    if (source.length !== 1 || record(source[0]?.digest).gitCommit !== artifact.commit)
      throw failure();
    return { certificateIdentity, artifact };
  } catch {
    signal.throwIfAborted();
    throw failure();
  }
}
