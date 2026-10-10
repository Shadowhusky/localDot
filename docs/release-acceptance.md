# Release acceptance

The public installer still builds from source. Prebuilt distribution must not become the default
until the package transport, native helpers and clean-machine checks below are complete.
Passing the simulated installer suite is not evidence that a fresh installation works.

## Build and inspect image candidates

Run **release-image-candidate** from Actions on `main`. Its default is build/test only. It builds
all four real images on native AMD64 and ARM64 runners and exercises the gate and desktop images.
Every selected test must run and pass. Image IDs and sizes are recorded separately from published
registry digests; a local Docker image ID must never be used as a registry manifest digest.

Publishing requires both the workflow's explicit `publish` input and a required reviewer on the
`release-candidate` GitHub environment. Set each GHCR package public before advertising anonymous
downloads. Candidate publication does not promote the public installer or a stable release.
Do not attach untrusted pull-request jobs to machines containing signing credentials or user data.

## Catalog and package requirements

`packages/protocol/src/distribution.ts` defines the v2 outer catalog. Existing package-level v1
`release.json` verification is unchanged. A v2 catalog describes exact per-platform app/helper
archives, hashes, sizes, runtime versions, measured peak additional storage, and all four image pins.
The catalog itself must be authenticated before download metadata becomes executable authority.
Schema validation alone is not authentication.

The candidate must include matching platform packages and both Linux image architectures.
Required payloads are the built app, native modules, runtime assets, and authenticated helpers;
the end-user path must not call Git, pnpm, Go, apt inside image builds, or Docker BuildKit.
Never fall back to compilation when a release download is unavailable. Retain the separate source
installer for developers and for the current public path until the release gate is satisfied.

## Real-machine test procedure

Use dedicated or disposable machines with no development tools, localDot installation, cached
localDot images, or saved personal credentials. Do not reset someone's active computer to test this.
Test every advertised architecture on its real host; native Linux does not substitute for WSL.
Use the same candidate bytes and image digests throughout. Keep the exact OS, Docker and hardware
versions, timestamps, redacted logs, screenshots and disk measurements with each result.

1. Run the documented one-line installer. Complete prerequisite prompts. On Windows, exercise a
   required reboot and confirm setup resumes in PowerShell, without landing in an unattended shell.
2. Open the resulting single-use sign-in link. Confirm the app and key service are healthy, create
   a computer, see its live stream, run a simple command, create a file, and read it back.
3. Restart the app and host. Confirm sign-in recovery and that the same computer's file remains.
4. Upgrade from the preceding accepted version. Verify computer data, sessions, keys and settings
   persist. Force candidate startup to fail and verify the previous version is restored.
5. Interrupt a download and installation. Rerun and verify completed work is reused safely.
   Exercise concurrent installers and cancellation. Neither may damage the active installation.
6. On a disposable Docker store, exercise full/read-only storage before and during setup, missing
   images, bad signatures, a blocked port, stopped Docker and a disconnected network. Confirm a
   specific diagnosis, a nonzero result, no success link and no automatic reset/prune.
7. Measure peak additional host and Docker storage during clean install and upgrade, including
   retained rollback files. Populate catalog requirements from these measurements with headroom;
   repeat acceptance against the final catalog hash. A virtual disk's nominal maximum is not the
   host's available physical space.

Write one receipt per platform/host using `DistributionAcceptance`. Each check is `true` only after
the corresponding test was performed successfully. Hash the retained redacted evidence bundle in
`evidenceSha256`, and retain it as `evidence/<sha256>.tgz`. The gate requires the actual
bundle and checks its bytes against the receipt. Do not put credentials, reusable access tokens or sign-in URLs in that bundle.

```sh
node scripts/release/acceptance.mjs distribution.json evidence acceptance-*.json
```

This checks complete coverage, test results, exact catalog/source/image identities and Windows
reboot continuation. The release reviewer must separately inspect and authenticate the evidence;
a self-authored JSON receipt is not proof of a test. No test host or receipt exists yet merely
because the gate code is present.

## Remaining shipping gates

- Complete platform-specific package/helper verification and bootstrap/activation on Linux/WSL
  and Intel macOS. Existing production helper trust and native sandbox packaging are Apple Silicon
  specific; do not disable those checks to make another platform install.
- Configure protected app/helper publishing and signing/notarization. The repository currently
  has no release signing secrets or protected publishing environments configured. Never export a
  developer's private signing key into CI without an explicitly configured credential workflow.
- Publish immutable packages and multi-platform image manifests, verify anonymous image pulls,
  and authenticate all artifacts through the installer before testing installation.
- Run and review the real-machine matrix above. Only then promote a stable version and update
  the bootstrap default. Missing hardware or a failed test blocks the affected platform.

For recovery references, see [Docker troubleshooting](https://docs.docker.com/desktop/troubleshoot-and-support/troubleshoot/)
and [WSL disk storage](https://learn.microsoft.com/en-us/windows/wsl/disk-space).
