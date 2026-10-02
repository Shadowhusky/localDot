# localDot Core — Part 10: Ship (M9) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish milestone M9 "Ship" (`npx localdot`, onboarding, `doctor`, `update`, docs, arm64 CI,
publishing hygiene) and success criterion 1: on an Apple-silicon Mac, `npx localdot` installs a
verified release into `~/.localdot/app/`, starts keyd and the daemon as LaunchAgents, opens the
Theatre with a one-time `#code=` link, and the onboarding page pulls the pinned images with
progress, takes the user's provider keys and autonomy defaults, and runs a first task within 10
minutes, most of it image download. `localdot update` moves to a newer verified release and
survives being interrupted at any point. `doctor` explains every prerequisite, including an image
built for the wrong architecture. Nothing is published by this plan: the release workflow is built
and rehearsed, and the first real publish waits for the user.

**Architecture:** One pipeline installs and updates (P10-R1). The CLI runs
`npm install --prefix <home>/app/staging-<v>-<hex> --ignore-scripts localdot@<v>`, then verifies the
staged copy before anything in it runs: every file against the release's `release.json`, keyd's
binary against its SHA-256 and against an Apple code-signing requirement naming localDot's
Developer ID team (compiled into the CLI), both npm tarballs against their SLSA provenance
(verified with sigstore, for this repository's release workflow at this version's tag), and every
image as a digest in localDot's GHCR namespace. The verified folder is renamed into
`app/versions/<v>/`; the images are pulled by digest and checked (digest held, platform equal to the
engine's); the services stop; one `rename(2)` points `app/current` at the new version; the services
start. A journal (`app/update.json`) lets the next command finish or undo an update killed at any
step, and `current` always names a whole, verified version. keyd now keeps each key in a login
Keychain item whose access list trusts only keyd's own designated requirement, so a compromised
daemon or any other process of the user can no longer read keys silently (closing P4a-R3's
residual), and existing items migrate on first start. The daemon no longer prints the install
token: the CLI mints a single-use, 60-second code with the token file and opens
`http://127.0.0.1:4750/#code=<c>`, which the page exchanges once for the token, so browser history
keeps only a dead code (closing the spec's install-link risk). A release is a signed tag; the
release workflow verifies the signature, builds the multi-arch images with Docker Bake on arm64
runners, signs and notarizes keyd on a macOS arm64 runner, writes `release.json`, checks the
tarball against an allowlist, and publishes with npm provenance, but only after the user approves
the `release` environment and only while the repository is public.

**Tech Stack:** Everything Parts 2–8 pinned: Node 24+ (host 25.6 on the Mac; the CI and this plan's
scratch verification used 24.21.0), pnpm 10.29.3, TypeScript 7.0.2, Biome 2.5.15, Vitest 5.0.3,
Hono 4.13.12, zod 4.6.5, React 19.3.0, Vite 8.3.1, Playwright 1.63.0 on system Chrome, Go 1.27.1,
mediabunny 1.61.0 (MPL-2.0), `@openai/codex` 0.154.0 and `@anthropic-ai/sandbox-runtime` 0.0.78
(Part 5c). New: **sigstore 5.0.0** (Apache-2.0) in the CLI, for provenance; **esbuild 0.28.2**
(already in the lockfile through tsx) for the bundles; **verdaccio 6** (MIT, test-only, run with
`npx`, never a dependency) for the release rehearsal; Apple's `codesign`, `notarytool` and
`security`; Docker Buildx Bake; GitHub-hosted runners `ubuntu-24.04-arm` and `macos-15` (arm64).

**Spec:** `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/specs/2026-09-30-localdot-core-design.md`
(here `docs/superpowers/specs/2026-09-30-localdot-core-design.md`). The relevant sections are
"Success criteria" 1, "Components" (keyd as a LaunchAgent), "Trust rules" 3 and 6, "Setup and
operations" (all of it), "Repository" (Docker Bake, arm64 runners, licences, publishing hygiene),
"Testing", "Milestones" (M9, and the order note: M9 ships before M8) and "Risks and open questions"
(the install link in history, M9's signed keyd owning the Keychain items, Docker's isolated gateway
mode on other engines).

**Binding interfaces** (each plan's closing section):
- Part 2 as built (`origin/feat/core-part2` and `origin/claude/part2-web-fix`): `doctor.ts`
  (`runDoctor`, `DoctorDeps`, `DoctorCheck`), `doctor-socket.ts`, `cells/docker.ts`
  (`DockerClient`, `DockerError`), `cells/images.ts`, `lock.ts`, `token.ts`, `guard.ts`, `app.ts`,
  `main.ts`, `static-ui.ts` (`webDir`), `apps/web/src/lib/token.ts` and `App.tsx`; the Part 2 ledger's
  M9 carries (auto-start lock, launchd log, `#code=`, macOS-homage assets).
- Part 3 (`docs/superpowers/plans/2026-10-01-localdot-core-part3.md`): `LiveSessions` and
  `GET /api/cells/:id/live`.
- Part 4a (`origin/claude/plan-part5a-providers`'s copy, with the providers amendment): `cmd/keyd`
  flags and readiness line, `vault.Store`, `vault.Keychain` (P4a-R3), `/v1/status`.
- Part 4b (`origin/claude/plan-part4b-fix2`): `KeydClient`, `KeydMonitor`, `KeydHealth`,
  `DoctorDeps.keyd` with the checks `keyd` and `hairpin-guard`, `sealSecret` and `bindingJson` in
  `@localdot/protocol`, `surrogateEnvName`, the key routes, `canary-scan.py`, `SELFTEST_CHECKS`,
  and "Not in Part 4b" (LaunchAgent, signed keyd, `audit-rotated`, the doctor's warning level).
- Part 5a (`origin/claude/plan-part5a-providers`): the brain image (`cells/brain/build.sh`),
  `GET /api/agent/providers`, `PUT /api/agent/settings`, `POST /api/cells/:id/agent`.
- Part 5c (`origin/claude/plan-part5c`): `@openai/codex` 0.154.0 and srt as product dependencies,
  `installCodex`, `GET /api/agent/chatgpt` and the "ChatGPT plan" picker entry.
- Part 7 (`origin/claude/plan-part7`): "M9 (ship)": `MIN_FREE_START_BYTES`, `retentionFromEnv`, and
  `dist/assets/licenses/mediabunny-1.61.0.txt` in the bundle.
- Parts 5b, 6 and 8: their branches did not exist when this plan was written. Their seams are
  defined here and listed under "Assumptions on code not yet built".

**Plan format:** M9 is an interface-and-test plan (`jobs/PLAN-WRITING.md`, "Plan format by
milestone"). Each task gives its files, exact interfaces, every test by name with its input and
expected result, implementation notes and acceptance commands. Production code appears in full
only where the exact code is the point (the job's rule): the installer's integrity checks (Task 1,
Task 5's image check), the Keychain access list (Task 2), everything that handles the install
token (Task 4), `update`'s verification and switch (Task 10), the canary (Task 9), the tarball
allowlist (Task 12) and the signed-tag check (Task 15). Every Review Focus pin is printed in full.
Code marked "verified" below ran green in a scratch copy (see "Verification").

**This is Part 10 of the core plan.** It runs after Parts 6 (M5), 7 (M6) and 8 (M7), on branch
`feat/core-part10` created from the tip of `feat/core-part8`. M9 ships before M8 (user, 2026-10-02):
nothing here depends on M8, and M8's theme packs, avatar host and extra providers join the release
pipeline unchanged later (see "Interfaces later parts build on").
