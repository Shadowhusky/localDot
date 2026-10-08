# Building the app archive

The shipping tools are an author candidate pending independent review and installed acceptance.
This command creates and audits the `localdot` npm archive locally. It does not install, sign,
notarize or publish a release.

Prerequisites: Node 24+, the repository's pnpm dependencies, npm, Python 3, a runtime built by
`apps/cli/scripts/build-runtime.mjs`, its JSON receipt, and an already-signed credential helper.
The runtime build must include verification of the pinned upstream sandbox archive. The helper
must satisfy the production Developer ID requirement compiled into the source. There is no
command option to change that identity or skip signature verification.

The macOS installer also requires the protected system `/usr/bin/perl` for a fixed bootstrap
`flock` operation before it can trust a downloaded helper. It passes only an inherited lock
descriptor and a random nonce, using a clean environment. It does not run Perl code from a
package or install a Perl distribution. Missing or writable system tooling stops bootstrap
before payload downloads. Subsequent recovery uses the freshly authenticated helper.

Create a JSON input file with exactly these five fields:

- `runtimeDirectory`: the runtime payload directory.
- `runtimeReceipt`: the runtime builder's JSON receipt file, outside that payload.
- `keydBinary`: the signed `keyd` executable used by the separate helper package.
- `commit`: the release source revision, as a full 40-character lowercase Git SHA.
- `images`: the four immutable image pins described below.

Paths may be absolute or relative to the input JSON file. Each image role (`desktop`, `gate`,
`brain`, `browser`) needs an object containing `repository`, `digest` and `platforms`.
The repository must be `ghcr.io/<owner>/localdot-<role>`, the digest must be an actual
`sha256:` digest, and platforms must include `linux/arm64`. Tags and local Docker image IDs
are not published manifest digests. Obtain these inputs from the image publication results.
Input validation checks their structure; this command does not contact GHCR to verify availability.

From the repository root:

```sh
pnpm build:app-package /absolute/path/to/input.json /absolute/path/to/new-build
```

The destination's parent must exist and the destination itself must be new. A successful build
contains:

```text
new-build/
  app/                            # Package tree, including release.json
  artifacts/localdot-<version>.tgz # Actual npm archive
  receipt.json                    # Build and archive evidence, never included in the package
```

The command verifies every runtime input, constructs the package metadata, checks the helper
signature, packs offline with lifecycle hooks disabled, and audits the resulting archive.
Every archived file's path, size and SHA-256 must match the builder inventory. The archive's
SHA-512 integrity must also agree with npm's result. npm receives an isolated home, cache and
empty configuration files. Temporary packing files are removed before the receipt is written.

A failure exits nonzero, prints a short diagnostic and leaves any partial output without a
success receipt. Inspect that output if needed, then choose a fresh destination for another run.
The command never overwrites or resumes an existing build.

The receipt records input hashes, file hashes, metadata digests, archive digest and signature
verification. It deliberately leaves `sourceCommitVerified`, `releaseProvenanceVerified`,
`imageAvailabilityVerified`, `cleanInstallVerified`, `completeRelease` and `published` false.
A supplied commit is not proof that a dirty working copy matches it. Independent review, source
and publication provenance, the matching signed helper package, notarization, published images,
and installed acceptance remain separate release gates. A local receipt does not authorize the
installer to trust this archive.

## Native macOS validation

The signed helper has a separate package-tree command:

```sh
pnpm build:keyd-package /absolute/path/to/signed-keyd 0.0.0-rc.1 /absolute/path/to/new-helper-package /absolute/path/to/helper-receipt.json
```

It requires the repository's pinned Go toolchain and cached modules/licenses. It checks the
Developer ID signature before and after copying, Darwin/arm64 and native Security.framework build
settings, and the dependency graph against `go.sum`; it collects the corresponding licenses.
The output directory must be new. The receipt must be outside the package and must not exist.
A receipt is written only after the package builder succeeds. This produces a package tree, not
an npm archive, and does not sign, run the helper, access credential items, notarize or publish.
The receipt explicitly leaves source/provenance verification and complete-release status false.

Run `pnpm test:native-macos` on an Apple Silicon Mac with Node 24+, the workspace dependencies,
the Go toolchain pinned in `keyd/go.mod`, and Xcode Command Line Tools. The same command runs in
the `native-macos` GitHub Actions workflow. It rejects other architectures and disabled CGO,
runs Go vet and the full Go race suite, builds a fresh helper, and runs the native transport,
retirement, lease and crash-recovery Node suites against that helper. Missing helpers and skipped
Node tests fail the command. Temporary executables and test reports are removed after the run.

The fixtures include actual subprocess crashes and descriptor checks. Go's in-memory native ACL
fixture exercises Security.framework, but live login-Keychain, signing and cleanup opt-ins are
removed from the child environment. This command neither signs nor publishes a build, and does
not replace signed credential migration tests or installed application acceptance.

## Browser setup validation

Run `pnpm --filter @localdot/web e2e:setup` to build the current web sources and exercise setup
in desktop and phone Chromium viewports. Chrome is used by default; `LOCALDOT_TEST_CHROMIUM`
can name an existing Chromium executable. `LOCALDOT_SETUP_OUT` optionally selects the directory
for screenshots and test results. No browser or package download is performed by this command.

The suite uses real loopback HTTP listeners, the production progress page and CSP, one-use code
exchange and first-run settings routes. It checks navigation, code replay refusal, persistent
appearance, settings focus, usable setup height, the footer, and failure/cancellation guidance.
Computer, catalog and key inventory are isolated fixture data. macOS browser auto-launch, signed
Keychain access, installed services and an actual agent task remain separate acceptance checks.
