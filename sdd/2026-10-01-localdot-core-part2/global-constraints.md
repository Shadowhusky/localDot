# Global constraints for every Part 2 task (verbatim from the plan's Global Constraints, lines 46–109)

Controller note (2026-10-01): `feat/core-part1` was merged into a new `main` at `992e82d` and deleted. `feat/core-part2` already exists and is checked out in the repo root (created from `main`, plus one docs commit `b778394`). Do not create or switch branches. Never commit on `main`.

## Global Constraints

- Repo root: `/Volumes/Husky's SSD 4T/Projects/localdot`. Work on branch `feat/core-part2`, created
  from `feat/core-part1` (`git switch -c feat/core-part2 feat/core-part1`); never commit on `main`.
  Quote the path in every shell command (space and apostrophe).
- Commit messages: conventional `type(scope): summary`. **Never add `Co-Authored-By` or any AI
  attribution line** (user rule; overrides any harness default).
- **Never bind-mount any path under `/Volumes/Husky's SSD 4T` into a container** (the apostrophe path
  wedges Docker Desktop's file sharing). Containers get named volumes, `docker cp`, or build contexts
  only. Runtime data lives in `~/.localdot` (`LOCALDOT_HOME` overrides); the optional shared folder is
  `~/localDot/Shared` (not mounted in Part 2).
- Build paths from `fileURLToPath(import.meta.url)`, never `new URL(...).pathname`.
- Ports, all bound to `127.0.0.1` only: daemon and UI `4750` (`LOCALDOT_PORT` overrides), brain tool
  API `4751`, keyd listeners `4760–4789`, spikes and e2e harnesses `4790–4799`. Cell ports are
  published by Docker on `127.0.0.1` with Docker-chosen host ports.
- Auth is cookie-free: HTTP accepts the install token only as `Authorization: Bearer <token>`;
  WebSocket clients always offer the subprotocols `localdot.v1` and `localdot.token.<token>` together
  and the server selects only `localdot.v1`; the UI takes the token from a `#token=` fragment into
  origin-scoped storage and removes it from the address bar with `history.replaceState`. Every inbound
  cell port requires a per-cell token (`desktopd` bearer, Selkies basic auth): 127.0.0.1 is not
  access control on Docker Desktop.
- Every cell network is created with `--internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated`
  (API: `Internal: true`, `Options: {"com.docker.network.bridge.gateway_mode_ipv4": "isolated"}`).
  Desktop: default seccomp, `NET_RAW` dropped, no added capabilities, pids/memory/CPU limits, no
  `docker.sock`, no `no-new-privileges` (passwordless sudo). Gate: read-only, `no-new-privileges`,
  all capabilities dropped, user `nobody`.
- Secrets never enter a container. Per-cell tokens (desktopd bearer, Selkies password, stream
  tickets) are not secrets: minted per cell, worthless off the Mac, dropped with the cell.
- Stream tickets (P2-R2): minted only through the authenticated API, 128 random bits, one live
  ticket per cell, compared in constant time, never logged, scoped to one cell's stream path, and
  revoked whenever the cell leaves `ready`, when it is removed, and on daemon restart (memory only).
- No Docker restart policy on any cell container (P2-R14): the orchestrator restarts an exited
  container itself with backoff and re-reads the published host ports after every start.
- The daemon is started with `node` directly (`node --import tsx src/main.ts` from `apps/daemon`;
  the test harness and any process manager do the same). `pnpm … start` is a convenience for a
  terminal only: pnpm does not forward `SIGTERM`, so a daemon started through it is not stoppable
  by a supervisor and leaves its lock behind.
- The desktop looks like macOS (spec "Look", P2-R5/R12): the WhiteSur LIGHT GTK theme with its
  xfwm4 `-hdpi`/`-xhdpi` builds, WhiteSur icons, a Plank dock with WhiteSur's light dock theme and
  the top panel styled as a menu bar; theme sources pinned by commit and verified after the clone;
  every asset's license recorded in the image (`/usr/share/doc/localdot-themes/`) and in
  `cells/desktop/THIRD-PARTY.md` (P2-R13). No Apple fonts or artwork.
- `apps/web/src/theme.css` names every token in Tailwind 4's `@theme` namespaces
  (`--color-*`, `--font-*`, `--spacing-*`, `--radius-*`, `--shadow-*`, `--ease-*`, `--duration-*`)
  so Tailwind can consume the file unchanged when it arrives in M4 (P2-R4).
- Images are pinned by digest (base images now; our own image digests per localdot version in M9).
  Every downloaded binary is verified against a sha256 written in the Dockerfile.
- No [avatar-name]/[avatar-name]/[avatar-name] names or assets anywhere in the repo (`pnpm hygiene` enforces it).
- Code style: named exports only (default exports only in tool config files), small focused files,
  comments only for non-obvious rules or workarounds, relative imports with explicit `.ts`,
  workspace imports by package name. Run `pnpm format` before `pnpm lint` in every task.
- Tests: run only the suites a task touches (`pnpm exec vitest run <paths>`); the full `pnpm test`,
  `pnpm typecheck`, `pnpm lint`, `pnpm hygiene` before the final review. Tests that need Docker live in
  `*.docker.test.ts` files, are excluded from `pnpm test`, and run only with
  `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker`. They name every container, network and volume they
  create `localdot-test-*` and remove them in `afterAll`, even on failure.
- Every UI task follows `~/.agents/skills/apple-design/SKILL.md` (read it before UI work): respond on
  pointer-down, interruptible animations that start from the current value, critically damped
  springs by default, `prefers-reduced-motion` and `prefers-reduced-transparency` honoured, every
  colour a CSS token. Every UI task ends with a screenshot check of the rendered page.
- The Theatre direction is decided: near-black `--color-void` `#0A0B0D`, one accent xenon `#3FB5DE` used
  only while the agent has control (never in Part 2, where nobody holds control), status HUD on the
  picture with a solid fallback under reduced transparency, caption under the stage, quiet side
  rails that stay comfortable for long reading, mascot slot bottom-left outside the stage.
