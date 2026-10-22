# Packaged tester downloads

This channel installs prebuilt localDot packages from the public repository.
It is separate from the production native installer and its signing/notarization acceptance gates.
Do not advertise a tester command until its channel and all referenced packages are public and verified.

## Delivery

- `downloads.localdot.dev` serves the small shell/PowerShell installers, immutable bootstrap files,
  and signed `channels/releases.json` metadata through an assets-only Cloudflare Worker.
- `Shadowhusky/localdot` contains the source, documentation and packaged releases.
  Release assets contain compiled app files; never upload credentials or private build receipts.
- GHCR contains the four prebuilt computer images, with an immutable digest for each architecture.
  Check anonymous access to each image before publishing.
- The app archive includes bundled JavaScript, native dependencies, the compiled key service,
  assets and license notices. JavaScript and runtime scripts remain readable, as in any shipped
  web/Node application; this packaging does not claim to prevent reverse engineering.

The installer authenticates an Ed25519 signature using its embedded public key before accepting
any package URL, inventory or image pin. It verifies the archive hash, every extracted file and
file mode, then downloads all computer images before changing services. It never falls back to
Git or local compilation. A startup failure restores the previous app, helper and service files.
Computer data directories and Docker volumes are not removed by the package installer.

## Build and verify

Keep the release signing key outside the checkout in an owner-only file. Never add it to Git,
a release, the Worker directory or an image. Preserve it for future updates; changing the key
without a migration would make older installations reject the new catalog.

Create a build-input JSON file outside the repository with `output`, `version` (an `-rc.N` version),
`commit` (the actual source commit), `publicKey`, `sandboxArchive` (the pinned upstream sandbox
archive), `keydBinary`, and optional `target`. The target is `darwin-arm64`, `darwin-x64`,
`linux-arm64` or `linux-x64`; Windows uses the matching Linux package through WSL 2.
Build Go helpers with `-trimpath -buildvcs=false -ldflags='-s -w'` for the target OS and architecture.

```sh
node scripts/distribution/build.mjs /path/to/build-input.json
node --experimental-transform-types scripts/distribution/verify.ts /path/to/candidate
```

Mac packages require the matching Mac host for the notification helper. Linux packages can be
assembled elsewhere, but must pass verification in Linux on their target architecture. The
verifier checks the exact archive inventory, runs the CLI, native image module and key helper,
boots the bundled daemon with a fresh temporary home and an unavailable Docker socket, and
fetches its actual web assets. It does not start a computer or touch the developer's services.

The resulting `verification.json` records this runtime smoke test only. It is not clean-machine
installation acceptance. Record separately whether Windows reboot continuation, native Apple
silicon/Intel hardware, prerequisites and live computer startup have been exercised.

## Assemble and publish

1. Build and test all four computer images for each advertised architecture. Publish only clean
   image builds from the reviewed Dockerfiles, never commits of a user's computer. Record registry
   manifest digests, not local image IDs. Verify anonymous access after making packages public.
2. Upload only `localdot-<version>-<target>.tgz` to a prerelease in `Shadowhusky/localdot`,
   with `docs/releases/<version>.md` as its text (`gh release create … --notes-file`). Under it,
   say which actual platforms were tested and any remaining limitations.
3. Create an input JSON with `packages` (candidate directories), `images` (architecture → role →
   GHCR digest), `key` (private signing key path), `output` (new static site directory),
   and `legacyCatalog` (the previously published, signed `channels/testing.json`).
4. Run `node --experimental-transform-types scripts/distribution/assemble.ts /path/to/input.json`.
   Assembly requires matching verification receipts, unchanged archives and bootstrap hashes,
   matching release identities, the correct compiled-in public key and the release's notes in its
   packages, which it signs into the catalog. It signs only a testing prerelease. Keep older
   `bootstrap/<sha256>.mjs` assets when deploying later releases.
5. Deploy the assembled site with the downloads Worker's config and Wrangler's `--assets` option.
   Inspect the deployment file list: it must contain only installers, bootstrap files, metadata
   and `_headers`, never the input JSON or private key. The existing remote-access relay is separate.
6. Test both installer URLs anonymously, verify the signed catalog and every referenced app/image
   download, and run installation acceptance. Then update the README's quick-install commands.

## Updates and recovery

The same six-hour update scheduler checks the signed testing channel. Verified download readiness
survives a daemon restart, and Settings still shows a dismissed update. Installing waits for active
agent work to finish and uses the exact selected version. Linux uses a separate systemd user service
so stopping the daemon cannot kill its installer. Failures appear in Settings; installer output is
retained in `logs/package-update.log` in localDot's data directory.

A temporary channel outage or failed signature leaves the current installation in place. Retrying
reuses Docker's completed image layers. A package installation lock prevents concurrent upgrades.
No update or recovery path should reset Docker or delete computer volumes to make a check pass.

See [release acceptance](release-acceptance.md) for the larger clean-machine and stable-release gates.

## Repository migration

Older installed verifiers only accept `localdot-downloads` release URLs. Version 0.1.0-rc.12
is the final bridge release, published with identical packages in both repositories. Its signed
`channels/testing.json` remains available unchanged. Build the bridge with `migrationBridge: true`
instead of `legacyCatalog`; later releases must preserve that catalog.

New installers use `channels/releases.json` and download from `Shadowhusky/localdot`. The bridge
includes the current verifier in its signed app inventory. After installing it, both Settings and
`localdot update` use the new channel, even if their previous installation recorded the old one.
Keep the archived downloads repository and immutable bootstrap URLs available for older installs.
The Cloudflare Worker keeps its existing name; it is separate from the GitHub repository.
