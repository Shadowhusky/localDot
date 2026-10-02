# Handoff: localDot cloud jobs → Codex agents (2026-10-02, ~15:05 UTC)

The Claude cloud session that ran these jobs hit the weekly limit. Every job was stopped mid-flight, and all partial work is pushed. This file is the single entry point for whoever runs the jobs next (the avatar voice work, which runs only on the Mac, is in §8), whether that is a Codex agent or a person dispatching Codex tasks.

## 1. How a job runs
Each job is **one agent session**. It does exactly what its job file says. Give each Codex task the prompt in §5, nothing else.
- **The rules (all on `origin/planning`):**
  - `jobs/COMMON.md` (hard rules);
  - `jobs/PROCESS.md` (review tiers and pace);
  - `jobs/PLAN-WRITING.md` (plan jobs);
  - the job's own `jobs/<job>.md`.
- **Repo:** `Shadowhusky/localdot` (private). Code is on `main` (Part 1), `feat/core-part2` (M1) and `feat/core-part4a` (keyd). Planning material is on the orphan branch `planning`; read it with `git show origin/planning:<path>`.
- **Output:** one `claude/<job>` branch per job. The job's report goes in the LAST commit, touching only `reports/` (or `reviews/` / the handoff file for reviews). The controller merges code without the report commit.
- **Commits:**
  - Conventional (`type(scope): summary`).
  - Authored as `shadowhusky <a983974247@gmail.com>`.
  - **No AI attribution of any kind:** no `Co-authored-by`, no "Generated with", no agent or session links. Codex users: check that your git config or Codex settings don't add a trailer, and amend it away if they do.
- **Branch names:** push only the job's own `claude/<job>` branch. Never push to `main`, `feat/*` or `planning` (the controller owns `planning`). Force-pushing your OWN job branch is allowed when the job file asks you to rebuild it. If your Codex environment can only push a branch it names itself, push there and write the mapping (`claude/<job>` → actual branch) at the top of your report.
- **Parallel jobs on one machine:**
  - never run broad kills (`pkill -f vitest`, `pkill go`); kill only PIDs you started;
  - pins assert counts or sizes, not wall time;
  - rerun a timing flake once before judging it.

## 2. Environment each job needs
- **Network:** the npm registry, `proxy.golang.org` (Go toolchain auto-download) and `nodejs.org` (Node tarball). No calls to LLM providers, OpenAI or ChatGPT, STUN or NAT-PMP, or any other third party (COMMON rule 6). If the Codex environment has internet off by default, allow these hosts.
- **Node 24** (the repo's `.nvmrc`). If the image has an older Node:

  ```sh
  curl -fsSLO https://nodejs.org/dist/latest-v24.x/node-v24.21.0-linux-x64.tar.xz   # verify against SHASUMS256.txt
  mkdir -p /opt/node24 && tar -xJf node-v24.21.0-linux-x64.tar.xz -C /opt/node24 --strip-components=1
  export PATH=/opt/node24/bin:$PATH && npm i -g pnpm@10.29.3 && pnpm install --frozen-lockfile
  ```
- **Go:** any Go ≥ 1.21. `keyd/go.mod` pins `toolchain go1.27.1`, and `GOTOOLCHAIN=auto` fetches it. Check that `cd keyd && go version` prints go1.27.1.
- **Pinned tools:** TypeScript 7.0.2, Biome 2.5.15 and Vitest 5.0.3, all through the repo's scripts.
- **Playwright Chromium** for UI screenshots and browser pins. Don't download a different build if one is preinstalled; pass `executablePath`.
- **No Docker:** skip `LOCALDOT_DOCKER_TESTS` suites and list them as unverified.

## 3. State of every job
Heads are pushed branch tips. A "WIP" commit means unfinished.

### Done (the controller merges or rules)
| Job | Branch @ head | Result |
|---|---|---|
| keyd Task 9 fix round 1 | `claude/part4a-task9-fix` @ `f552498` | DONE_WITH_CONCERNS; superseded by `part4a-task10-fix`, which contains it |
| keyd Task 10 | `claude/part4a-task10` @ `d3978cd` | DONE_WITH_CONCERNS; superseded by `part4a-task10-fix` |
| keyd Task 10 fix round 1 | `claude/part4a-task10-fix` @ `89507c6` | DONE_WITH_CONCERNS; holds Task 9's fix, Task 10 and their merge. Code tip `18e2a47` |
| Re-review of the above | `claude/review-part4a-fixes` @ `0abd0ca` | FIXES_NEEDED: 0 Critical, 2 Important, 4 Minor. The Importants are in fix round 2 below; the Minors are batched to the final review |
| Part 2 web fix round | `claude/part2-web-fix` @ `c0a2e9e` | DONE_WITH_CONCERNS; needs 3 UI rulings (§6) |
| Part 4b plan, fix pass 2 | `claude/plan-part4b-fix2` @ `5d23651` | DONE_WITH_CONCERNS |
| Part 5a plan (M4 core) | `claude/plan-part5a` @ `a70fd8c` | superseded by the providers branch |
| Part 5a first-class providers | `claude/plan-part5a-providers` @ `54221ad` | DONE_WITH_CONCERNS (P5a-R31–R33) |
| Part 5a plan review | `claude/review-plan-part5a` @ `8b0612e` | FIXES_NEEDED: 1 Critical, 9 Important, 18 Minor |
| Part 5c plan (Codex harness) | `claude/plan-part5c` @ `97e4797` | DONE_WITH_CONCERNS |
| Part 7 plan (Replay) | `claude/plan-part7` @ `af14d3d` | DONE_WITH_CONCERNS |
| Part 7 plan review | `claude/review-plan-part7` @ `7dd4909` | FIXES_NEEDED: 0 Critical, 7 Important, 14 Minor |

### Interrupted: resume these (§5 has the prompts)
| Job | Branch @ head | Where it stopped | What's left |
|---|---|---|---|
| `part4a-task11` | `claude/part4a-task11` @ `c32e31c` | Code done: `c350f00` feat CONNECT, then `0ff1b35`, `91068fd` and `daf7277` fixes; WIP integrity pins committed; the mutation run was half done (`reports/part4a-task11-wip/mut-full.txt`, where `sni-no-ctx` SURVIVED) | Finish the mutation run and kill the survivors with pins. Bypass hunt as in the job file. The `c.intercepted` read/write must be race-free, with a `-race` pin of concurrent CONNECT and plain requests on one cell. Full verify. Then delete `reports/part4a-task11-wip/` and commit the final report LAST |
| `part4a-fixes-round2` | `claude/part4a-fixes-round2` @ `5577152` | Item 1 done: `8c7d2e6` linear inspect (RED: 1,565,582 comparisons against a bound of 5,166), `d8989bf` 64 KiB header cap; WIP pins for item 2 committed | Item 2: `Connection: close` on every 407, plus a per-cell connection cap (refuse at accept, rate-limited audit). The IPv6 message, if it's a one-liner. Verify, mutation-test, before/after numbers, then the report LAST |
| `plan-part7-fix1` | `claude/plan-part7-fix1` @ `427ecda` | The plan is edited for Tasks 1–11 (I1, I2, I4, I5, I6, the GOP bound, m1, m2, m9–m11, m14); WIP committed | Tasks 12–16 (I3 play-mode re-seek, I7 jump-to-live, the rest of I4's M5 seam note, the remaining Minors), `part7-revision-log-1.md`, re-run the Node pins, then the report LAST |
| `plan-part5a-fix1` | `claude/plan-part5a-fix1` @ `b4a6af7` | Only the merge of `origin/planning`; no plan edits pushed | The whole job file |
| `review-plan-part5c` | (nothing pushed) | Assembly only | The whole job: make `claude/review-plan-part5c` from `origin/planning` |
| `plan-part5b` | `claude/plan-part5b` @ `99af475` | Prototype code only, in `reports/plan-part5b-wip/` (a patch on Part 2 plus Part 5a's code: the key detector, model additions, `useLiveSession`) | Write the plan. Use the prototype patch as a head start, re-verify, and delete the wip folder in the final report commit. Note: build on `plan-part5a-fix1`'s interfaces if they have landed; otherwise record assumptions |
| `plan-part6` | `claude/plan-part6` @ `4d58cfa` | Prototype protocol and safety code in `reports/plan-part6-wip/` | Write the plan. Also write against Part 5a's fixed behaviours (screenshots taint, `remember` refused under taint, budgets per task, no acting during takeover, explicit per-tool deadlines) and record them as assumptions |
| `plan-part8` | `claude/plan-part8` @ `395e0d8` | Prototypes in `reports/plan-part8-wip/` (`verify/`: download quarantine, the input gate, the screen switcher, the CDP guard, a cookie canary; `proto/`: CDP probes) | Write the plan |
| `plan-part10` | `claude/plan-part10` @ `12efa05` | Prototype patch (install codes and exchange routes, the release manifest schema), plus plan fragments in `reports/plan-part10-wip/tmpl/` | Write the plan |

**Resuming a job:** the branch already exists. Check it out from origin; don't re-create it from the job file's base. Continue from "What's left". Then delete any `reports/<job>-wip/` folder and put the final report in the LAST commit (rebuild your own branch if needed).

## 4. What comes next (the controller writes these job files when their inputs land)
Dependencies run top to bottom inside each lane, and the lanes run in parallel.
- **keyd lane** (tier `full`, strictly sequential):
  1. Merge `part4a-task11` and `part4a-fixes-round2`. Both start from `18e2a47`, so make a merge branch and run `go test -race ./...`.
  2. Review Task 11 (full tier).
  3. A scoped re-review of fix round 2's two items.
  4. Fixes as needed.
  5. Tasks 12 → 17 of `docs/superpowers/plans/2026-10-01-localdot-core-part4a-keyd-core.md`, each with: implement, review, fix, scoped re-review.
  - Tasks 13 and 14 use the amended text on `claude/plan-part5a-providers` (`…handoff/part4a-providers-amendment.md`), as changed again by `plan-part5a-fix1` if it touches budgets.
  - The 4 Minors from `review-part4a-fixes` go to the final keyd review.
  - The binding-change → revoke item (Task 10 fix, concern 1) goes to Task 16.
- **Part 5a:** a scoped re-review of the sections `plan-part5a-fix1` changed (there was a Critical).
- **Part 5c:** one fix pass after `review-plan-part5c`.
- **Parts 5b, 6, 8, 10:** one review each, then one fix pass. Re-review only on a Critical.
- **Part 7:** done once `plan-part7-fix1` lands (no Critical, so no re-review).
- **Mac-only (Docker):**
  1. Part 2 Task 15 (acceptance, 2× measurements, docs);
  2. then Part 3 (M2, from Part 2's final tip, with its pre-flight scan);
  3. then Part 4b's execution;
  4. then the Docker suites the cloud jobs listed as unverified.

## 5. Prompts to give each agent
Replace `<job>`. For a resumed job, also paste its row from §3.

```
Run localDot job `<job>`. First `git fetch origin`, then read and follow, in order:
`git show origin/planning:jobs/HANDOFF-CODEX.md` (sections 1-3), `git show origin/planning:jobs/COMMON.md`,
`git show origin/planning:jobs/PROCESS.md`, `git show origin/planning:jobs/PLAN-WRITING.md` (plan jobs only),
and `git show origin/planning:jobs/<job>.md`. If HANDOFF-CODEX.md lists this job under "Interrupted", resume
the existing `claude/<job>` branch from where it stopped instead of starting over. Do exactly what they say,
push only the `claude/<job>` branch, and end with a status under 10 lines: DONE | DONE_WITH_CONCERNS |
BLOCKED, the branch and its head sha, and the top concerns.
```

Run now, all in parallel: `part4a-task11`, `part4a-fixes-round2`, `plan-part7-fix1`, `plan-part5a-fix1`, `review-plan-part5c`, `plan-part5b`, `plan-part6`, `plan-part8`, `plan-part10`. On the Mac, also run the local avatar lane in §8.

## 6. Decisions waiting on the user
- **Part 2 web fix, three UI calls:**
  1. the HUD button is `aria-disabled`, not `disabled`;
  2. `--color-text-3` changes to `#7c7f87` for 4.5:1 contrast;
  3. both rails hide below 1180 px, using the Lightning CSS transformer.
- **Part 4b behaviour changes** (fix pass 2):
  - a failed freeze makes Stop stop the computer, so running programs are lost;
  - Start on a frozen computer reboots it;
  - Task 7's Docker test needs `go` on the Mac.
- **Part 5a:** OpenRouter `:free` models and every model in the "Other" group need a price typed by the user (P5a-R32).
- **Part 5c:** whether to install `@openai/codex` (~117 MB) on demand rather than with every install (`review-plan-part5c` assesses it).

## 7. Rulings already made by the user on 2026-10-02 (binding)
- Review tiers and lighter M5–M9 plans (`jobs/PROCESS.md`, `jobs/PLAN-WRITING.md`). M9 ships before M8.
- First-class providers: Anthropic, OpenAI, Google, Azure, xAI, Mistral, DeepSeek, Groq and OpenRouter (official packages and their own keyd routes). The rest go through OpenAI-compatible.
- The ChatGPT plan via the Codex harness moves into M4, as Part 5c.
- Claude subscription sign-in stays out: Anthropic doesn't allow third-party products to use it.
- `store: false` by default for OpenAI, Azure and xAI. Unpriced and router models are refused unless the user gives a price.
- The keyd Task 10 fix round: plain-HTTP upgrades to a host with a bound secret are refused until Tasks 11 and 12 can intercept them.

The Mac originals of `planning` must take these commits before the controller's next re-sync.

## 8. Avatar Part 3 (V4 Voice): a local lane on the Mac, not a cloud job
This lane is separate from the jobs above, and it has to run on the developer's Mac:
- the voice service runs MLX models, which need Apple Silicon;
- the character's private voice pack never leaves the Mac.

Run it as a local agent in the worktree below.

### Where things are
- **Worktree:** `/Volumes/Husky's SSD 4T/Projects/localdot-avatar`, on branch `wip/avatar-part3` (pushed). `feat/avatar-part3` @ `c812a79` is the last green tip; `wip/avatar-part3` adds the in-progress commits.
- **Start here:** `docs/handoff/avatar-part3.md` in that worktree. It is also on `origin/wip/avatar-part3`.
- **Full context on the Mac:**
  - Plan: `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/plans/2026-10-01-localdot-avatar-part3.md`.
  - Spec: `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/specs/2026-09-30-localdot-avatar-voice-design.md`.
  - Execution ledger with every ruling: `.superpowers/sdd/2026-10-01-localdot-avatar-part3/progress.md` in the worktree. Its rulings amend the briefs.
  - The same folder holds the task briefs (`task-N-brief.md`), `global-constraints.md` (including the private pack's path), the reports and `preflight.md`.

### State (2026-10-02, about 16:45 UK time; `wip/avatar-part3` @ `ceb00b6`)
The user handed this whole lane to the local agent. The Claude agents are stopped, their leftover servers are shut down, and ports 4752 and 4753 are free.
- **Done:** Tasks 1–6 and 8.
- **Task 7 review fix round:** items 1, 3, 4 and 6 are done, and `pnpm test:voiced` is green (104 passed). Items 2, 5 and 7 remain.
- **Task 9:** partly built. The language fix is committed; the mic, listener and STT relay are work in progress.
- **Task 10:** not started. It is live runs on the Mac: latency acceptance, the demo clip with the private voice, and a check of how far the mouth lags the voice.
- **Last:** one final review of the whole branch.

**Before you start:** run `git status` and `git log` in the worktree. If another agent's uncommitted changes or fresh commits are there, it may still be running. Never work alongside it on the same files.

### Order
1. Finish the Task 7 items.
2. Finish Task 9, then its review.
3. Task 10.
4. The final review.

Task 7 (`apps/voiced`) and Task 9 (`packages/voice`, harness) touch different files, so they can run in parallel.

### Rules beyond COMMON.md
- **Commits:**
  - commit on `wip/avatar-part3` only, then push that branch;
  - stage exact paths;
  - no AI attribution;
  - run `pnpm hygiene` before every commit: no character or franchise names in this repo, no key-shaped strings.
- **Defaults:** voice input stays OFF by default. No live paid cloud calls in tests.
- **Ports:** voiced on 4752, the harness on 4753, capture Chrome on 9334. Never 9222 or 4790–4799.
- **Shared GPU:** before heavy local model runs, message the localDot core controller session if one is active.
- **Private pack repo:** never push it. It has no remote and must stay on the Mac.

### Prompt for a local agent
```
Resume localDot avatar Part 3 on this Mac. cd "/Volumes/Husky's SSD 4T/Projects/localdot-avatar", run
`git status` and `git log --oneline -8`, then read docs/handoff/avatar-part3.md, then the ledger
.superpowers/sdd/2026-10-01-localdot-avatar-part3/progress.md (its rulings amend the briefs) and the brief
of the task you take. If another agent's uncommitted work is present, stop and ask. Continue from where the
ledger stops, append your progress to the ledger, commit on wip/avatar-part3 and push it. End with a status
under 10 lines.
```
