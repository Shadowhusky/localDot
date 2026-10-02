# Rules for every localDot cloud job

You are one job in the localDot core build, a localhost AI assistant. The controller runs on the maintainer's Mac and reads only what you push. Follow your job file exactly.

## Setup
- The repo is `Shadowhusky/localdot` (private). Code branches: `main` (Part 1), `feat/core-part2` (Part 2, M1), `feat/core-part4a` (keyd, Go).
- Planning material is on branch `planning`; run `git fetch origin planning` and read it with `git show origin/planning:<path>`.
  - Its `README.md` maps the original Mac paths (`/Volumes/Husky's SSD 4T/Projects/...`) to branch paths: `docs/superpowers/...` and `sdd/<plan>/...`. Translate every such path you meet.
  - Avatar-character names in the planning copies read `[avatar-name]`.
- **Toolchain:**
  - Node 24 or later, with `corepack enable` and pnpm 10.29.3 (the repo pins it), then `pnpm install --frozen-lockfile`.
  - Go 1.27.1: if `go version` differs, download the linux tarball from https://go.dev/dl/ into `$HOME/sdk` and put it on PATH.
  - The repo pins TypeScript 7.0.2, Biome 2.5.15 and Vitest 5.0.3; use the repo's scripts.

## Hard rules
1. Commits are conventional (`type(scope): summary`), with **no `Co-Authored-By`, no "Generated with", no session link and no AI attribution of any kind**. If your git tooling adds one, amend it away before pushing.
2. Push ONLY your own `claude/...` branches, named in your job file. Never push to `main`, `feat/*` or `planning`. Never force-push anyone else's branch.
3. Never commit secrets. No real keys exist in this project, and tests use fake ones.
4. No avatar-character names or assets anywhere.
5. **Docker is not available here.** Don't install or run it, and skip Docker suites (`LOCALDOT_DOCKER_TESTS`). List everything you couldn't verify for that reason.
6. Network: use it only for package registries and toolchain downloads. Make no calls to third-party services (no STUN, no NAT-PMP, no LLM APIs).
7. Don't dispatch subagents. Do the job yourself.
8. If you're blocked, still push your report saying BLOCKED, with the specifics.

## Output
- Your job file names your branches and your report path. The report is concise and written for the controller: status (DONE | DONE_WITH_CONCERNS | BLOCKED), commits, test results, concerns, and anything unverified.
- Your final message, under 10 lines: the status, the branches pushed, and the top concerns.
