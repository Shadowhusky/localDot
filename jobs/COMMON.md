# Rules for every localDot cloud job

You are one job in the localDot core build, a localhost AI assistant. The controller runs on the maintainer's Mac and reads only what you push. Follow your job file exactly.

## Setup
- The repo is `Shadowhusky/localdot` (private). Code branches: `main` (Part 1), `feat/core-part2` (Part 2, M1), `feat/core-part4a` (keyd, Go).
- Planning material is on branch `planning`; run `git fetch origin planning` and read it with `git show origin/planning:<path>`.
  - Its `README.md` maps the original Mac paths (`/Volumes/Husky's SSD 4T/Projects/...`) to branch paths: `docs/superpowers/...` and `sdd/<plan>/...`. Translate every such path you meet.
  - Avatar-character names in the planning copies read `[avatar-name]`.
- **Toolchain:**
  - **Node:** the repo wants Node 24+ (`.nvmrc`). If the installed Node is older, run `nvm install 24`, or report it if that's unavailable. Then `npm i -g pnpm@10.29.3` and `pnpm install --frozen-lockfile`.
  - **Go:** `keyd/go.mod` names `toolchain go1.27.1`, so any Go ≥ 1.21 auto-fetches it through `proxy.golang.org` (`GOTOOLCHAIN=auto`; go.dev itself is not reachable here). Check that `go version` inside `keyd/` reports go1.27.1.
  - The repo pins TypeScript 7.0.2, Biome 2.5.15 and Vitest 5.0.3; use the repo's scripts.

## Process
- `jobs/PROCESS.md` sets each task's review tier (`full` or `light`) and the milestone order. Your job file still overrides it for your own job.

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
- **Cloud sessions can push only their current working branch, so each job pushes exactly ONE branch.** Your report (and any screenshots) go in the LAST commit on that branch, touching only `reports/…` paths. The controller keeps that commit out when it merges the code.
- Your job file names your branch and your report path. The report is concise and written for the controller: status (DONE | DONE_WITH_CONCERNS | BLOCKED), commits, test results, concerns, and anything unverified.
- Your final message, under 10 lines: the status, the branches pushed, and the top concerns.
