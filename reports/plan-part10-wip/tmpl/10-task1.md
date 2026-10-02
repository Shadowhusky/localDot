
---

### Task 1: The release manifest, the pins, and the installer's integrity checks

A release is the `localdot` npm package, the `@localdot/keyd-darwin-arm64` package and four images.
`release.json`, written by the release workflow (Task 15) into the package, lists every file of the
package with its SHA-256, keyd's SHA-256 and signing identity, and each image's digest. The CLI
verifies a staged install against it before anything in it runs, and checks that both tarballs
were built by this repository's release workflow at the version's tag. The trust pins live in the
CLI that does the verifying, never in the release it verifies.

**Review tier:** **full**. It is the installer's integrity check: whatever passes it runs as the
user, and keyd from it holds every key.

**Files:**
- Create: `packages/protocol/src/release.ts`, `packages/protocol/src/release.test.ts`,
  `packages/protocol/src/testing/sample-release.ts`, `packages/protocol/src/testing/index.ts`
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`
- Create: `apps/cli/src/verify/{errors.ts,files.ts,trust.ts,provenance.ts,release.ts}`,
  `apps/cli/src/verify/release.test.ts`, `apps/cli/src/verify/provenance.net.test.ts`,
  `apps/cli/src/testing/staged-release.ts`
- Modify: `packages/protocol/src/index.ts` (`export * from "./release.ts";`),
  `packages/protocol/package.json` (`"./testing": "./src/testing/index.ts"` in `exports`),
  `pnpm-lock.yaml`

**Interfaces:**
- Consumes: zod 4.6.5 (protocol), Node's `crypto`, `fs`, `module`.
- Produces (`@localdot/protocol`): `ReleaseManifest`, `ImagePin`, `PackagePath`, `imageRef(pin)`,
  `RELEASE_VERSION`, `SHA256_HEX`, `IMAGE_DIGEST`, `IMAGE_ROLES`, `KEYD_PACKAGE`,
  `KEYD_IDENTIFIER`; `@localdot/protocol/testing`: `sampleManifest()`, `SampleManifest`.
- Produces (`apps/cli/src/verify/`): `verifyStagedRelease(root, version, deps): Promise<VerifiedRelease>`,
  `VerifyDeps { pins; codesign(path, requirement); provenance }`,
  `VerifiedRelease { version; root; packageDir; keydPath; manifest }`,
  `ReleaseVerificationError { check: "package" | "manifest" | "files" | "keyd" | "provenance" | "images" }`,
  `TrustPins`, `RELEASE_PINS`, `keydRequirement(teamId)`, `provenanceChecker(pins, fetchAttestations,
  verifyBundle): ProvenanceCheck`, `npmAttestationUrl(name, version)`, `purl(name, version)`,
  `SLSA_V1`, `GITHUB_WORKFLOW_BUILD`, `sha256File(path)`, `listFiles(root, check)`; test helpers
  `stageRelease(version?, root?, { nested? })`, `fakeAttestations(...)`, `fakeSigstore`,
  `TEST_PINS`.
- The production wiring of the two injected checks (Task 10's `steps.ts`):
  - `codesign`: `execFile("/usr/bin/codesign", ["--verify", "--strict", "--verbose=0", `-R=${requirement}`, path])`,
    true exactly on exit 0;
  - `provenance`: `provenanceChecker(RELEASE_PINS, fetchJson(npmAttestationUrl(...)), (bundle, policy) => sigstore.verify(bundle, policy).then(() => {}))`
    with `sigstore` 5.0.0's `verify(bundle, { certificateIdentityURI, certificateIssuer })`.

**The manifest, complete** (protocol type; verified):

`packages/protocol/src/release.ts`:
@@INCLUDE p2/packages/protocol/src/release.ts ts@@

`packages/protocol/src/testing/sample-release.ts`:
@@INCLUDE p2/packages/protocol/src/testing/sample-release.ts ts@@

`packages/protocol/src/testing/index.ts`:
```ts
export * from "./sample-release.ts";
```

**The verification, complete** (security boundary; verified):

`apps/cli/package.json`:
```json
{
  "name": "@localdot/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "@localdot/protocol": "workspace:*",
    "sigstore": "5.0.0"
  }
}
```
`apps/cli/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src"] }`.
`apps/cli/package.json`'s `version` is the release version from Task 12 on (Task 12 sets it and
the release workflow checks it against the tag); it stays `private`: the published package is the
generated one in `apps/cli/pkg/`.

`apps/cli/src/verify/errors.ts`:
@@INCLUDE p2/apps/cli/src/verify/errors.ts ts@@

`apps/cli/src/verify/files.ts`:
@@INCLUDE p2/apps/cli/src/verify/files.ts ts@@

`apps/cli/src/verify/trust.ts`:
@@INCLUDE p2/apps/cli/src/verify/trust.ts ts@@

`apps/cli/src/verify/provenance.ts`:
@@INCLUDE p2/apps/cli/src/verify/provenance.ts ts@@

`apps/cli/src/verify/release.ts`:
@@INCLUDE p2/apps/cli/src/verify/release.ts ts@@

**Tests, complete** (verified):

`packages/protocol/src/release.test.ts`:
@@INCLUDE p2/packages/protocol/src/release.test.ts ts@@

`apps/cli/src/testing/staged-release.ts`:
@@INCLUDE p2/apps/cli/src/testing/staged-release.ts ts@@

`apps/cli/src/verify/release.test.ts`:
@@INCLUDE p2/apps/cli/src/verify/release.test.ts ts@@

`apps/cli/src/verify/provenance.net.test.ts` (opt-in, `LOCALDOT_NET_TESTS=1`; it reads one public
attestation and sigstore's TUF root, so it is the only test here that leaves the machine):
- `"verifies a real npm provenance attestation with sigstore, for its real workflow"`: the
  attestation document of `@sigstore/core@3.2.1` from `npmAttestationUrl`, its lockfile integrity
  `sha512-qRsxPnCrbC/puegGxKuynfnxgLiHqWStrSjxkoB4YKqq3Z3s4cyZyj42ZdWFAEblNP65C+rBH8EuREHIXoi83g==`
  (from the registry's metadata, read 2026-10-02), pins `{ repository: "https://github.com/sigstore/sigstore-js",
  workflow: ".github/workflows/release.yml", issuer: "https://token.actions.githubusercontent.com" }`,
  and the real `sigstore.verify`. That attestation was built from `refs/heads/main`, not a tag, so
  the expected outcome is a `ReleaseVerificationError` whose message matches
  `/does not verify for https:\/\/github.com\/sigstore\/sigstore-js/`: sigstore refused the
  identity `…/release.yml@refs/tags/v3.2.1`. That is the positive proof that the identity pin
  bites.
- `"accepts the same attestation when the identity names its real ref"`: the same, with a checker
  whose identity is built from `refs/heads/main` (a test-only `provenanceChecker` variant taking
  `ref`), resolving without error. This proves the real verifier, the real bundle shape and the
  digest comparison agree.

**Implementation notes:**
- Order matters: the package's own `package.json` (name, version, no install hook, keyd at exactly
  this version) is checked before anything else is read, and the provenance last but one, so a
  refusal names the earliest, most specific failure.
- `listFiles` skips the package's top-level `node_modules`: with `npm-shrinkwrap.json`, npm puts
  the package's dependencies under it (keyd included), and npm itself has checked those against
  the shrinkwrap's integrity. keyd is found through Node's resolution from the package
  (`createRequire(...).resolve`), nested or hoisted, and its lockfile key is its path relative to
  the prefix.
- `release.json` and `package.json` are the two files `files` does not hash: the manifest cannot
  hash itself, and `package.json` is checked field by field.
- The team ID is a build constant (`__LOCALDOT_TEAM_ID__`, esbuild `define`, Task 12). A CLI built
  without it trusts no keyd at all, and Task 12's pack check refuses a bundle in which the constant
  was left unset.
- Traps: comparing the provenance's repository case-insensitively (GitHub's identity is exact, so
  the pin is the canonical `Shadowhusky/localdot`); taking the first attestation instead of
  requiring exactly one SLSA statement; trusting the payload before `verifyBundle` has accepted the
  signature over it; hashing the lockfile's base64 integrity against the provenance's hex digest
  without decoding (the tests compare real `sha512` values).

- [ ] **Step 1:** Write the protocol test and helper, and `apps/cli` with its two test files. Run
  `pnpm install && pnpm exec vitest run packages/protocol/src/release.test.ts apps/cli/src/verify`.
  Expected: FAIL (no `release.ts`, no `verify/*.ts`).
- [ ] **Step 2:** Add `release.ts`, the export, and the five `verify` modules. Run the same command.
  Expected: PASS, 22 + 20 tests. Then `pnpm --filter @localdot/cli typecheck && pnpm --filter
  @localdot/protocol typecheck`.
- [ ] **Step 3:** On a machine with the internet: `LOCALDOT_NET_TESTS=1 pnpm exec vitest run
  apps/cli/src/verify/provenance.net.test.ts`. Expected: 2 passed.
- [ ] **Step 4: Commit**

```bash
pnpm format && pnpm lint
git add packages/protocol apps/cli pnpm-lock.yaml
git commit -m "feat(cli): verify a staged release against its manifest, keyd's signature and provenance"
```

**Acceptance:** both suites pass; `pnpm hygiene` is clean; `grep -c "__LOCALDOT_TEAM_ID__"
apps/cli/src/verify/trust.ts` prints 2 (the declaration and its one use).
