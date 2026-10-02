
## Global Constraints

- Repo root: `/Volumes/Husky's SSD 4T/Projects/localdot`. Work on branch `feat/core-part10`, created
  from the tip of `feat/core-part8` (`git switch -c feat/core-part10 feat/core-part8`). Never commit
  on `main`. Quote the path in every shell command (it has a space and an apostrophe).
- Commit messages are conventional `type(scope): summary`. **Never add `Co-Authored-By`, "Generated
  with", a session link or any AI attribution line.** This is a user rule and overrides any harness
  default.
- **Never bind-mount any path under `/Volumes/Husky's SSD 4T` into a container.** Containers get
  named volumes, `docker cp`, Docker's archive API or build contexts only. Runtime data lives in
  `~/.localdot` (`LOCALDOT_HOME` overrides); the installed app lives in `~/.localdot/app/`.
- Build paths from `fileURLToPath(import.meta.url)`, never `new URL(...).pathname`.
- Ports, all bound to `127.0.0.1`: the daemon and UI on `4750` (`LOCALDOT_PORT` overrides, and the
  installer records it), the brain's tool API on `4751`, keyd listeners on `4760–4789`, spikes and
  e2e harnesses on `4790–4799` (the e2e daemon on `4790`, test keyd listeners on `4791–4797`, the
  driver opt-out proxy on `4798`, **this plan's rehearsal registry on `4799`**).
- Auth is cookie-free. HTTP accepts the install token only as `Authorization: Bearer <token>`.
  WebSocket clients offer `localdot.v1` and `localdot.token.<token>` together, and the server selects
  only `localdot.v1`. The one route that answers without the token is `POST /auth/exchange`, which
  spends a one-time code (Task 4). **Nothing the product runs prints, logs or puts in a URL or an
  argument the install token** (the dev daemon started by hand keeps P2-R7's `#token=` line).
- Secrets never enter a cell, and every LLM call goes through keyd (the Codex harness is trust rule
  7's documented exception). This plan's one secret-handling change is keyd's Keychain store
  (Task 2). Test values are obviously fake (`acl-fake-…`, `migrate-fake-…`, `canary-…`) and match
  none of `pnpm hygiene`'s patterns; tests that need a key-shaped string build it at run time.
- Docker-backed suites are `*.docker.test.ts`, run with `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker
  <file>`, **with no `--` before the file** (with `--` Vitest ignores the filter). They name every
  container, network, volume and image tag they create `localdot-test-*` and remove them with
  `docker rm -fv` / `docker rmi` in `afterAll`, even on failure. Every probe whose output a test
  checks also asserts its exit status. No server runs on a Docker test's own thread (the Docker CLI
  helpers block it). **Docker is not available in the cloud runners that wrote this plan**: every
  Docker suite and the Mac acceptance are listed under "Verification" as not run.
- keyd-backed suites are `*.keyd.test.ts` (`LOCALDOT_KEYD_TESTS=1 pnpm test:keyd <file>`). Mac-only
  Go tests are `//go:build darwin && cgo` and run on the Mac and on CI's `macos-15` job.
- Network in tests: package registries and toolchain downloads only. No test calls STUN, NAT-PMP, an
  LLM API, GitHub's API or sigstore's servers, except the opt-in `LOCALDOT_NET_TESTS=1` provenance
  check in Task 1, which reads one public attestation from `registry.npmjs.org` and sigstore's TUF
  repository.
- Hygiene:
  - no [avatar-name] names or assets anywhere (`pnpm hygiene` enforces it); tests of the name rule
    inject their own pattern and never spell a name;
  - no binary fixtures committed;
  - nothing logs a token, a code, a key, a surrogate, a request path or a path under `$HOME`
    beyond `~/.localdot`'s own folders;
  - named exports only (default exports only in tool config files), small focused files, comments
    only for non-obvious rules;
  - relative imports with explicit `.ts`, workspace imports by package name;
  - run `pnpm format` before `pnpm lint`; fix `organizeImports` with
    `pnpm exec biome check --write <files>`. Go: `gofmt -l .` prints nothing and `go vet ./...` is
    clean before every commit.
- Pinned toolchain: Node 24+, pnpm 10.29.3, TypeScript 7.0.2, Biome 2.5.15, Vitest 5.0.3,
  Playwright 1.63.0 on system Chrome, Go 1.27.1 (`keyd/go.mod`'s `toolchain`), sigstore exactly
  `5.0.0`, esbuild exactly `0.28.2`. Every runtime dependency of the published package is pinned
  exactly, and the package ships an `npm-shrinkwrap.json` that pins every transitive one (P10-R10).
- The daemon is started with `node` directly by anything that must stop it: launchd runs
  `<node> <app>/current/node_modules/localdot/dist/daemon.mjs`; development keeps
  `node --import tsx src/main.ts` from `apps/daemon`. `pnpm … start` is a terminal convenience only.
- UI (onboarding, Task 7), under the Theatre direction:
  - follow `~/.agents/skills/apple-design/SKILL.md`: respond on pointer-down, interruptible
    transitions that start from the current value, critically damped springs, and honour
    `prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast: more`;
  - near-black `--color-void`, and every colour is a token in `apps/web/src/theme.css`;
  - **no purple or violet, no gradients, no emoji**; warnings and errors are told by text, weight
    and a hollow dot, never by a new hue;
  - xenon `#3FB5DE` appears **only while the agent has control**: onboarding never shows it until
    the first task's agent holds control in the stage;
  - contrast ≥ 4.5:1 for text; the Theatre's CSPs stay as they are (onboarding adds no origin);
  - every UI task ends with a screenshot check of the rendered page.
- Publishing: the GitHub repository stays private and **nothing in this plan publishes**: no
  `npm publish`, no `docker push`, no GitHub release, no public repository. The release workflow is
  written and its gates are tested; its first real run is the user's decision (P10-R17).
- Tests: run only the suites a task touches (`pnpm exec vitest run <paths>`, `go test
  ./internal/<pkg>/`). Before the final review, run the full `pnpm test`, `pnpm typecheck`,
  `pnpm lint`, `pnpm hygiene`, `node scripts/history-scan.mjs` and `go test -race ./...`.

## Review Focus

The five inputs or failure modes most likely to bite a user that no ordinary task test exercises.
Each has a pinning test, printed in full in the task that owns it.

1. **A first run on a clean Mac without Docker Desktop.** `npx localdot` must still install, start
   keyd and the daemon, and open the onboarding page, which says Docker Desktop is missing and how
   to get it (with the 8 GB memory setting), pulls nothing, creates no cell, and moves on by itself
   once Docker answers. `doctor` names the missing socket with the same advice. Nothing crashes and
   nothing is left half-installed.
   - Pins: Task 5, "a clean Mac without Docker Desktop (Review Focus 1)" (`setup/status.test.ts`);
     Task 7, "shows how to get Docker Desktop and starts nothing (Review Focus 1)"
     (`Onboarding.test.tsx`); Task 11, "installs and opens onboarding with no Docker
     (Review Focus 1)" (`install.test.ts`).
2. **`update` interrupted mid-way.** A kill during any step of an update (staging, verifying,
   pulling, stopping, switching, starting) must leave `current` naming a whole, verified version
   (the old one before the switch, the new one after), the services running that version after
   the next command, no staging folder or half-made link behind, and the update re-runnable to
   completion. A release that fails verification is never switched to. The computers' home volumes
   are never touched.
   - Pins: Task 10, "recovers from a kill during <step>" for each step, "refuses to switch to a
     release that fails verification", "removes a half-made link and staging folders"
     (`update/run.test.ts`); Task 6, "recreates a computer on a new image and keeps its home"
     (`orchestrator-release.test.ts`).
3. **An install link replayed or leaked.** A `#code=` link works once, within 60 s, and only from
   the daemon's own origin; a replay, an expired code from browser history and an unknown code get
   the same 401; refusals before the redeem spend nothing; the token never appears in the URL, in
   the daemon's launchd log or in the CLI's output.
   - Pins: Task 4, "one-time install links (Review Focus 3)" (`auth/routes.test.ts`), "redeems a
     code once: a replay is refused" (`install-codes.test.ts`), "never print the token when launchd
     runs the daemon" (`startup-lines.test.ts`), and the Chrome spec `install-link.spec.ts`
     (history holds only the dead code; reopening the link from history is refused and keeps the
     stored token).
4. **The published tarball containing anything outside the allowlist.** `npm pack --dry-run` of the
   built package must list only allowlisted paths (no sources, source maps, tests, dotfiles or
   nested `node_modules`), with no key-shaped string, private name, developer path or unset build
   constant in any packed file, and with `release.json` and `npm-shrinkwrap.json` present; and the
   installer refuses a staged package holding any file the release did not list.
   - Pins: Task 12, "the published tarball (Review Focus 4)" (`scripts/check-pack.test.mjs`);
     Task 1, "refuses a changed file, an extra file and a missing file" (`verify/release.test.ts`).
5. **`doctor` on arm64 versus amd64 images.** An image Docker holds for another platform than the
   engine's (an amd64 desktop on Apple silicon, from `DOCKER_DEFAULT_PLATFORM` or a single-arch
   pull) runs under emulation, where XTest timing and the stream's CPU budget no longer hold.
   `doctor` and the installer must refuse it by name with the fix, accept Docker's `aarch64`
   spelling, and refuse an image held under another digest.
   - Pins: Task 5, "verifyImage (Review Focus 5)" (`cells/image-check.test.ts`); Task 8, "fails an
     amd64 image on Apple silicon (Review Focus 5)" (`doctor.test.ts`).
