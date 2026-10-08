import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ download: vi.fn(), verify: vi.fn() }));
vi.mock("./registry-download.ts", async (original) => ({
  ...(await original<object>()),
  downloadRegistryResource: mocks.download,
}));
vi.mock("./verify-release.ts", () => ({ verifyReleaseWithFreshTrust: mocks.verify }));

import { verifyNpmProvenance } from "./provenance-policy.ts";
import { type RegistryResource, registryResourceURL } from "./registry-download.ts";
import { RELEASE_PROVENANCE_PINS } from "./release-trust.ts";
import { claimedReleaseCommit, withVerifiedDownload } from "./verified-download.ts";

const pkg = { name: "localdot" as const, version: "1.2.3" },
  commit = "b".repeat(40),
  body = Buffer.from("synthetic archive");
const digest = createHash("sha512").update(body).digest();
const signal = () => new AbortController().signal;
const roots: string[] = [];
function document() {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "pkg:npm/localdot@1.2.3", digest: { sha512: digest.toString("hex") } }],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            repository: RELEASE_PROVENANCE_PINS.repository,
            path: RELEASE_PROVENANCE_PINS.workflow,
            ref: "refs/tags/v1.2.3",
          },
        },
        resolvedDependencies: [
          {
            uri: `git+${RELEASE_PROVENANCE_PINS.repository}@refs/tags/v1.2.3`,
            digest: { gitCommit: commit },
          },
        ],
      },
    },
  };
  const json = () =>
    JSON.stringify({
      attestations: [
        {
          predicateType: statement.predicateType,
          bundle: {
            dsseEnvelope: {
              payloadType: "application/vnd.in-toto+json",
              payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
            },
          },
        },
      ],
    });
  return { statement, json };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-verified-download-")));
  roots.push(root);
  const doc = document();
  mocks.download.mockImplementation(async function* (resource: RegistryResource) {
    yield resource.kind === "archive"
      ? body
      : resource.kind === "attestation"
        ? Buffer.from(doc.json())
        : Buffer.from(
            JSON.stringify({
              ...pkg,
              dist: {
                integrity: `sha512-${digest.toString("base64")}`,
                tarball: registryResourceURL({ ...pkg, kind: "archive" }).href,
                attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
              },
            }),
          );
  });
  return { root, ...doc };
}
afterEach(async () => {
  mocks.download.mockReset();
  mocks.verify.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("parses only a bounded untrusted claim; it never represents a verified signature", () => {
  expect(claimedReleaseCommit(document().json(), pkg)).toBe(commit);
  expect(mocks.verify).not.toHaveBeenCalled();
});
it.each([
  "bad-json",
  "oversized",
  "wrong-repo",
  "wrong-tag",
  "duplicate-source",
  "bad-commit",
  "duplicate-attestation",
  "bad-base64",
  "wrong-type",
])("refuses an invalid claim %s", (kind) => {
  const doc = document();
  const source = doc.statement.predicate.buildDefinition.resolvedDependencies[0];
  if (!source) throw new Error("missing fixture source");
  let raw: string;
  if (kind === "wrong-repo") source.uri = "git+https://github.com/other/app@refs/tags/v1.2.3";
  if (kind === "wrong-tag")
    source.uri = `git+${RELEASE_PROVENANCE_PINS.repository}@refs/tags/v9.9.9`;
  if (kind === "duplicate-source")
    doc.statement.predicate.buildDefinition.resolvedDependencies.push(source);
  if (kind === "bad-commit") source.digest.gitCommit = "not-a-commit";
  raw = doc.json();
  if (kind === "bad-json") raw = "{";
  if (kind === "oversized") raw = "x".repeat(2 * 1024 * 1024 + 1);
  if (["duplicate-attestation", "bad-base64", "wrong-type"].includes(kind)) {
    const value = JSON.parse(raw);
    if (kind === "duplicate-attestation") value.attestations.push(value.attestations[0]);
    if (kind === "bad-base64") value.attestations[0].bundle.dsseEnvelope.payload += "!";
    if (kind === "wrong-type") value.attestations[0].bundle.dsseEnvelope.payloadType = "text/plain";
    raw = JSON.stringify(value);
  }
  expect(() => claimedReleaseCommit(raw, pkg)).toThrow();
});
it("waits for authentication of actual bytes and the compiled release policy before exposing the archive", async () => {
  const f = await fixture();
  let authenticated = false;
  mocks.verify.mockImplementation(async (parent, doc, artifact, abort) => {
    expect(parent).toBe(f.root);
    expect(artifact).toEqual({ ...pkg, sha512: digest.toString("hex"), commit });
    // Policy-only composition seam. Cryptographic acceptance is covered by the separate real
    // Sigstore suite, not by this unsigned synthetic attestation.
    await verifyNpmProvenance(doc, artifact, RELEASE_PROVENANCE_PINS, async () => {}, abort);
    authenticated = true;
  });
  const result = await withVerifiedDownload(f.root, pkg, signal(), async (release) => {
    expect(authenticated).toBe(true);
    expect(Object.isFrozen(release)).toBe(true);
    expect(release.commit).toBe(commit);
    expect(await readFile(release.archive)).toEqual(body);
    return "ok";
  });
  expect(result).toBe("ok");
  expect(mocks.verify).toHaveBeenCalledTimes(1);
  expect(await readdir(f.root)).toEqual([]);
});
it("contains downloads and trust scratch while retaining the independent durable trust-state path", async () => {
  const f = await fixture(),
    scratch = join(f.root, "assembly");
  await mkdir(scratch, { mode: 0o700 });
  mocks.verify.mockImplementation(async (state, _doc, _artifact, _abort, cacheParent) => {
    expect(state).toBe(f.root);
    expect(cacheParent).toBe(scratch);
  });
  await withVerifiedDownload(
    f.root,
    pkg,
    signal(),
    async (release) => {
      expect(release.archive.startsWith(`${scratch}/.download-`)).toBe(true);
      expect(await readFile(release.archive)).toEqual(body);
    },
    scratch,
  );
  expect(await readdir(scratch)).toEqual([]);
  expect(await readdir(f.root)).toEqual(["assembly"]);
});
it.each(["failed-signature", "cancelled", "wrong-workflow", "wrong-digest"])(
  "never exposes files after %s",
  async (kind) => {
    const f = await fixture(),
      work = vi.fn(),
      controller = new AbortController(),
      reason = new Error("cancelled");
    if (kind === "wrong-workflow")
      Object.assign(f.statement.predicate.buildDefinition.externalParameters.workflow, {
        path: ".github/workflows/other.yml",
      });
    const subject = f.statement.subject[0];
    if (!subject) throw new Error("missing fixture subject");
    if (kind === "wrong-digest") subject.digest.sha512 = "c".repeat(128);
    mocks.verify.mockImplementation(async (_parent, doc, artifact, abort) => {
      if (kind === "cancelled") {
        controller.abort(reason);
        return;
      }
      await verifyNpmProvenance(
        doc,
        artifact,
        RELEASE_PROVENANCE_PINS,
        async () => {
          if (kind === "failed-signature") throw new Error("untrusted");
        },
        abort,
      );
    });
    await expect(withVerifiedDownload(f.root, pkg, controller.signal, work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  },
);
