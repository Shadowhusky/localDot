
## What a user's Mac trusts, and why (summary of P10-R1 to P10-R6)

| What runs | Where it comes from | What vouches for it | Checked by |
|---|---|---|---|
| The first `npx localdot` | the npm registry, over TLS | npm's integrity for the tarball (the user's trust in `npx`) | npm |
| Every installed version (the first one too) | `npm install --prefix <staging> localdot@<v>` | SLSA provenance signed by sigstore for `https://github.com/Shadowhusky/localdot/.github/workflows/release.yml@refs/tags/v<v>`, whose subject is the installed tarball's sha512 | `verifyStagedRelease` (Task 1), with pins compiled into the CLI doing the install |
| Every file of the `localdot` package | the verified tarball | `release.json`'s SHA-256 per file; no file outside the list | Task 1 |
| Its dependencies (sigstore, sharp, mediabunny, Codex, srt, …) | the same install | `npm-shrinkwrap.json` in the verified package: exact versions and sha512 integrity | npm |
| keyd | `@localdot/keyd-darwin-arm64@<v>`, a separate tarball | its own provenance, `release.json`'s SHA-256, and Apple's code signature against the designated requirement for localDot's team (`keydRequirement`) | Task 1; the Keychain checks the same requirement on every read (Task 2) |
| The cell images | `ghcr.io/shadowhusky/localdot-<role>@sha256:…` | the digest in the verified `release.json` (content-addressed) and the engine's platform | Docker on pull; `verifyImage` (Task 5) before use and in `doctor` |
| A release at all | a tag `v<version>` | an SSH signature by a key in `.github/allowed_signers`, and the user's approval of the `release` environment | `verify-tag.sh` and GitHub (Task 15) |

On disk after an install:
```
~/.localdot/                      0700, as before (config, sessions, memory, skills, keyd/ …)
  app/
    versions/1.0.0/               an npm prefix: node_modules/localdot, node_modules/@localdot/keyd-darwin-arm64, …
    current -> versions/1.0.0     one rename(2) switches it
    update.json                   only while an update is in flight
  install.json                    { v: 1, version, port, node, keydPorts, installedAt }
  logs/daemon.log, logs/keyd.log  launchd's stdout and stderr; never a token (Task 4)
  daemon-token                    0600, as before
  daemon.lock, daemon.lock.db     the pid line, and the SQLite lock the kernel releases (Task 3)
~/Library/LaunchAgents/dev.localdot.keyd.plist, dev.localdot.daemon.plist
```

## File map

| Task | Tier | Create | Modify |
|---|---|---|---|
| 1 | full | `packages/protocol/src/release.ts`, `release.test.ts`, `testing/{sample-release.ts,index.ts}`; `apps/cli/{package.json,tsconfig.json}`; `apps/cli/src/verify/{errors.ts,files.ts,trust.ts,provenance.ts,release.ts,release.test.ts,provenance.net.test.ts}`; `apps/cli/src/testing/staged-release.ts` | `packages/protocol/src/index.ts`, `packages/protocol/package.json`, `pnpm-lock.yaml` |
| 2 | full | `keyd/internal/vault/{migrate.go,migrate_test.go,keychain_acl_darwin.go,keychain_acl_other.go,keychain_acl_darwin_test.go,testdata/aclreader/main.go}` | `keyd/cmd/keyd/{main.go,daemon.go,main_test.go}`, `keyd/internal/admin/server.go` (status), `packages/protocol/src/keyd.ts`, `package.json` (`keyd` script) |
| 3 | light | — | `apps/daemon/src/lock.ts`, `lock.test.ts` |
| 4 | full | `apps/daemon/src/auth/{install-codes.ts,routes.ts,install-codes.test.ts,routes.test.ts}`, `apps/daemon/src/startup-lines.ts`, `startup-lines.test.ts`, `apps/web/src/lib/install-link.ts`, `install-link.test.ts`, `apps/web/e2e/install-link.spec.ts` | `apps/daemon/src/app.ts`, `main.ts`, `apps/web/src/App.tsx`, `App.test.tsx` |
| 5 | full | `apps/daemon/src/release/{layout.ts,layout.test.ts}`, `apps/daemon/src/cells/{image-check.ts,image-check.test.ts,pull.ts,pull.test.ts}`, `apps/daemon/src/setup/{status.ts,status.test.ts,routes.ts,routes.test.ts}` | `apps/daemon/src/cells/{images.ts,docker.ts,docker.test.ts}`, `static-ui.ts`, `app.ts`, `main.ts` |
| 6 | light | `apps/daemon/src/cells/orchestrator-release.test.ts` | `apps/daemon/src/cells/{types.ts,store.ts,orchestrator.ts}` |
| 7 | light | `apps/daemon/src/onboarding/{store.ts,routes.ts,*.test.ts}`, `apps/web/src/onboarding/{Onboarding.tsx,useSetup.ts,steps/{DockerStep,ImagesStep,ModelsStep,AutonomyStep,FirstTaskStep}.tsx,onboarding.css,Onboarding.test.tsx,setup-view.ts,setup-view.test.ts}`, `apps/web/e2e/onboarding.spec.ts` | `apps/web/src/App.tsx`, `apps/daemon/src/app.ts`, `main.ts` |
| 8 | light | `apps/daemon/src/doctor/{checks-host.ts,checks-images.ts,checks-keyd.ts,checks-cells.ts,checks-disk.ts,print.ts,*.test.ts}`, `apps/daemon/src/cells/selftest-route.ts`, `selftest-route.test.ts` | `apps/daemon/src/doctor.ts`, `doctor.test.ts`, `doctor-main.ts`, `app.ts` |
| 9 | full | `apps/cli/src/doctor/{canary.ts,canary.test.ts,canary-deps.ts}`, `apps/cli/src/doctor/canary.docker.test.ts` | `apps/daemon/src/keyd/canary-scan.py` (moved from `keyd/testing/`), `apps/daemon/src/keyd/canary.docker.test.ts` (import path) |
| 10 | full | `apps/cli/src/update/{layout.ts,run.ts,run.test.ts,npm.ts,npm.test.ts,steps.ts,steps.test.ts}` | — |
| 11 | light | `apps/cli/src/{main.ts,args.ts,platform.ts,launchd.ts,install-record.ts,daemon-api.ts,open-link.ts,logs.ts}`, `apps/cli/src/commands/{install,up,down,open,stop,reset,logs,doctor,update,uninstall}.ts`, tests beside each, `apps/cli/bin/localdot.mjs` | — |
| 12 | full | `apps/cli/scripts/{build-package.mjs,build-package.test.mjs,licenses.mjs,licenses.test.mjs}`, `apps/cli/pkg-template/{package.json,README.md}`, `scripts/check-pack.mjs`, `scripts/check-pack.test.mjs`, `THIRD-PARTY.md` (completed) | `vitest.config.ts`, `.gitignore`, `package.json` |
| 13 | light | `docker-bake.hcl`, `cells/brain/THIRD-PARTY.md`, `cells/gate/THIRD-PARTY.md`, `scripts/release/image-labels.test.mjs` | `cells/{desktop,gate,brain,browser}/Dockerfile` (OCI labels, `ARG` pins), `cells/*/build.sh` (call bake) |
| 14 | light | — | `.github/workflows/ci.yml` |
| 15 | full | `.github/workflows/release.yml`, `.github/allowed_signers`, `scripts/release/{verify-tag.sh,verify-tag.test.mjs,write-release-json.mjs,write-release-json.test.mjs,guard.test.mjs}`, `keyd/npm/{package.json,README.md}`, `keyd/entitlements.plist` | — |
| 16 | light | `scripts/history-scan.mjs`, `history-scan.test.mjs`, `SECURITY.md`, `docs/release-checklist.md` | `scripts/check-hygiene.mjs` (export `RULES` unchanged; `findViolations` reused) |
| 17 | light | `docs/{install.md,troubleshooting.md,security.md,releasing.md,uninstall.md}`, `scripts/docs.test.mjs` | `README.md` |
| 18 | light | `apps/cli/e2e/{rehearsal.ts,rehearsal.test.ts}`, `docs/measurements/2026-10-first-run.md` | — |
