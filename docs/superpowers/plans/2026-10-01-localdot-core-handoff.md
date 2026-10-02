# localDot core — session handoff (2026-10-01)

The core controller session (`projects-ed`) lost its terminal tab, so the user could not reach it.
This note lets a fresh session in a visible tab take over. Since 2026-10-01 10:36, `projects-5e` is
the controller: Part 2 is executing on `feat/core-part2` (see "Decisions answered" and "Takeover").

## Where things stand

**RESUMED 2026-10-02 (local).**
- Routine creation (`RemoteTrigger`, cloud environment `env_01XYAV1tixfcqkeTu4vEQ7i1`, given by the user) was DENIED by the auto-mode classifier as an "auto-mode bypass". Don't retry it. The user decides: allow `RemoteTrigger` in settings, or start the cloud sessions themselves with prepared prompts and a planning branch.
- Running locally:
  - Part 2: the Task 14 review (resumed) and the web fix round (the Task 13 agent, on `b02765f`);
  - keyd: the Task 9 review and the Task 10 implementer (base `70a534e`).
- Held for the user's cloud decision: the M4 plan, the M6 plan and 4b fix pass 2 (the stopped agents can be resumed).

**PAUSED 2026-10-02: the user's Claude Code usage limit was reached.** The user then asked to move Docker-free jobs to cloud runs (they have cloud-session credits) and approved a private GitHub repo.
- **Done:**
  - created private `Shadowhusky/localdot`; `origin` added; `main`, `feat/core-part2` and `feat/core-part4a` pushed (if the push failed for auth, run `gh auth setup-git`, then push again);
  - full-history secret scan clean before the push;
  - c8's avatar branches were NOT pushed.
- **Stopped mid-flight (their partial files stay on disk):**
  - the M4 plan writer (`…-part5a-agent-core.md` may be partial);
  - the M6 plan writer (`…-part7-replay.md` may be partial; its `localdot-test-p7-rec` container was removed);
  - Task 14's review: re-dispatch with `review-b97bc42..b02765f.diff`;
  - 4b fix pass 2 (P4b-C4): the plan may be partly edited. The committed copy is on `docs/localdot-core-planning` (`f78fae40c`); re-run from `part4b-review-2.md`.
- **Cloud routines:**
  - `RemoteTrigger create` needs `job_config.ccr.environment_id`, from the cloud environments on claude.ai/code. The rest of the body format is unknown, so look it up first.
  - Cloud-suitable now: keyd Task 9's review (package `review-97bfb65..70a534e.diff`) and Task 10 (brief extracted); later, plan writing and reviews.
  - A planning branch for cloud runs must redact the avatar-character names and exclude `avatar-[avatar-name].md` (the localdot repo has a no-names rule).
- **Local only** (Docker/Chrome): Part 2's Task 14 review, then the web fix round, then Task 15, then Part 3.

**Live status** (projects-5e). The SDD ledgers and `git log` are the source of truth; this is a pointer.
- **Lane A, Part 2:** Tasks 1–13 complete (Task 13's 8 UX minors go to the web fix round). Task 14 (the live stage) landed as `c879f59..b02765f`; the live desktop paints in real Chrome and recovers after Stop/Start and a daemon restart. It brings the vendored-client audit, CSPs, and a Permissions-Policy plus sandbox. Its review is running. A web fix round follows (Task 12's review: WebSocket auth refusal → panel; token handling tied to the token concerned; `/assets` root). Then Task 15 and the final review. The install-link-in-history risk is accepted and documented in the spec (M9: a one-time `#code=`).
  - Ledger: `localdot/.superpowers/sdd/2026-10-01-localdot-core-part2/progress.md`.
- **Lane C, Part 4a (keyd), worktree `Projects/localdot-keyd`:** Tasks 1–8 complete (Task 7's overlap class and Task 8's underscore rule are recorded in P4a-C9). Task 9 (surrogate registry) is `6bda612..73ac7d8`; its fix round (C1–C5 Basic/userinfo/path hardening, plus Q1's two-half Basic) is running. Task 10's brief (the cell listener) is extracted.
  - Ledger: `localdot-keyd/.superpowers/sdd/2026-10-01-localdot-core-part4a-keyd-core/progress.md`.
- **Lane B:**
  - The Part 3 plan is approved by the user, and fix pass 5 has landed (P3-C18). Before execution, a delta check runs against Part 2's final commits.
  - The Part 4b plan: review-1 needed fixes (P4b-C1/C2 in `part4b-rulings.md`). Fix pass 1 landed (`part4b-revision-log-1.md`; 12,766 lines; the pre-fix copy is `part4b-plan-v1.md`), Its scoped re-review (`part4b-review-2.md`) found 0 Critical and 2 Important: Stop's fallback when the freeze fails, and web edits against Task 13 as built. Fix pass 2 is running (P4b-C4). It also installs the CA as a plain anchor, since the certificate's EKU and name constraints carry the restriction. After it, only I-1 and I-2 get re-checked. R16 (STUN) is ruled as NAT-PMP first, then one STUN provider behind `-stun off`; the user is told and may veto.
  - The M4 plan (Part 5a, agent core) is being written. Part 5b (the agent UI) follows.
  - The M6 plan (Part 7, Replay; `…-part7-replay.md`) is being written. It is planned to execute right after Part 3, independent of M3–M5. M5 (Part 6) is planned once 5a's seams are final.

- **Part 1 (spikes S1–S7 + TypeScript foundation): COMPLETE.**
  - Repo `Projects/localdot`, branch `feat/core-part1` at `992e82d` (33 commits on root `299d3d9`). The repo had no `main` and has no remote. Merged 2026-10-01: `main` is at `992e82d` and `feat/core-part1` is deleted.
  - 143 tests pass; typecheck, lint and hygiene are clean.
  - A Fable whole-branch review returned "with fixes". One fix wave followed (daemon single-writer lock, 404 for unknown sessions, file modes, port validation, CI schema-drift check, and more), then a clean scoped re-review.
  - The SDD workspace was deleted per the skill. Its rulings live in `2026-10-01-localdot-core-handoff/part1-rulings.md`, and plan-level carry-forward items in `2026-09-30-localdot-core-part1-carry-forward.md`.
  - The foundation worktree and branch are gone (merged at `7bf918e`).
- **Spec** `docs/superpowers/specs/2026-09-30-localdot-core-design.md` carries all 34 spike amendments (A1–A34 in `localdot/docs/spikes/SUMMARY.md`).
  - Success criterion 3 holds the ring wording the user signed off ("keep", 2026-10-01); the pending note is deleted.
- **Part 2 plan (M1 "live desktop"): APPROVED by the user 2026-10-01; executing.**
  - File: `docs/superpowers/plans/2026-10-01-localdot-core-part2.md` (18 tasks, about 8.8k lines).
  - Reviewed twice by Fable; every finding is fixed, plus six small re-review fixes applied by the controller.
  - Controller rulings P2-R1…R16: `2026-10-01-localdot-core-handoff/part2-rulings.md`, mapped in the plan's closing "Decisions" section. Notable: the macOS look is WhiteSur LIGHT + Plank + a menu-bar panel; Selkies' client is vendored and served by the daemon inside an iframe authorised by per-cell stream tickets; own Docker Engine client; no Docker restart policy (the orchestrator restarts with backoff).
- **Part 3 plan (M2 "visual core"): APPROVED by the user 2026-10-01; fix pass 5 landed (P3-C18). It executes after Part 2.** History: `part3-review-3.md` found all 12 items addressed and P3-C12/C13 consistent. Fix pass 4 (`part3-revision-log-4.md`, P3-C14) applied its minors, the key-dispatch e2e failure and the Instant hardening, and was checked with the pinned toolchain. Known before execution: 15 import blocks and 2 assignment-in-expression spots fail Biome (listed in log 4); Part 3's own pre-flight scan fixes them.
  - File: `docs/superpowers/plans/2026-10-01-localdot-core-part3.md` (17 tasks, 11,170 lines).
  - Reviewed by Fable. All 28 first-review findings are confirmed fixed. A re-review then found 1 critical, 2 important and 9 minor new items (`2026-10-01-localdot-core-handoff/part3-review-2.md`), mostly in the pixel-oracle task.
  - An Opus agent applied all 12. Its log, with hand-derived test values, is `2026-10-01-localdot-core-handoff/part3-revision-log-2.md`; the pre-fix copy is `2026-10-01-localdot-core-handoff/part3-plan-v2.md`.
  - **First job for the new session (done 2026-10-01, see Takeover):** apply ruling P3-C12 (hold the oracle's frame clone only while the oracle is on). Then diff the plan against the v2 copy and run one scoped Opus re-review of that diff, verdicting `part3-review-2.md`'s 12 items. Only then show Part 3 to the user.
  - Also check the fix agent's stated risk: an Instant click's baseline needs the intent to reach the worker within ~60 ms.
  - Rulings P3-C1…C12: `2026-10-01-localdot-core-handoff/part3-rulings.md`.
- **Planning docs committed** 2026-10-01 on branch `docs/localdot-core-planning` (`dc4e0cdd7`, 30 files, made from `main` through a temporary index; the Projects checkout stays on `main`). Later doc changes (this handoff, rulings, Part 4a+ plans) go in new commits on that branch: `f78fae40c` (2026-10-01) added the 4a/4b plans, Part 3 fix pass 5 and the rulings and logs, after a clean secret scan. The original list:
  - the spec;
  - the Part 1/2/3 plans;
  - the carry-forward file;
  - this handoff and its folder;
  - `docs/superpowers/design/2026-09-30-localdot-ui-directions/`.

## Decisions answered by the user (2026-10-02, cloud session)

- **Pace (user: "why the app take so much effort and time?"):** see `jobs/PROCESS.md` on this branch.
  - **Review tiers:** `full` (the review, fix round and re-review as before) only for security-boundary code. `light` (one review and one fix round, with Minors batched to the final review and no re-review) for everything else.
  - **Plan format:** M5–M9 plans give interfaces and tests, not the complete code (`jobs/PLAN-WRITING.md`). Plan reviews are one review plus one fix pass, with a re-review only on a Critical.
  - **Milestone order:** M9 ships before M8. The spec's Milestones section carries the note.
- **The six cloud jobs of 2026-10-02 11:11** (Task 9 fix, Task 10, Part 2 web fix, M4 plan, M6 plan, 4b fix pass 2) all died on the weekly limit before pushing. They were re-run from one cloud session, each pushing its own `claude/` branch as its job file says.
- **The Mac originals** of the spec, handoff and job files need the same edits before the next re-sync, or the re-sync will drop them.

## Decisions answered by the user (2026-10-01, in projects-5e)

- **Part 2: approved.** Execution is running on `feat/core-part2` with SDD. The workspace is
  `localdot/.superpowers/sdd/2026-10-01-localdot-core-part2/`, and its ledger `progress.md` is the
  recovery map.
- **Click ring: "keep".** The pending note under criterion 3 is deleted from the spec, and
  `localdot/docs/spikes/SUMMARY.md` records the sign-off (`b778394`, the first commit on
  `feat/core-part2`).
- **Part 1: "merge".** `main` is at `992e82d`, 143 tests pass, and `feat/core-part1` is deleted.
- **Planning docs: commit on a branch** once Part 3's re-review is done. The Projects checkout
  stays on `main`.
- **Part 3: approved** (2026-10-01, after `part3-review-3.md` and fix pass 4). It runs once Part 2 finishes, on `feat/core-part3` from Part 2's tip, with its own toolchain pre-flight scan first.
  - Its pre-flight scan ran early (`part3-preflight-scan.md`): 10 Critical, 11 Important and 22 Minor, mostly drift against Part 2 as built. Ruling P3-C16 set the fixes; fix pass 5 landed (`part3-revision-log-5.md`, P3-C18: 12,551 lines, 19 task units, verified on Part 2 plus stubs). A delta check against Part 2's final commits runs before execution.

## Decisions as they were posed (kept for the record)

1. **Part 2 plan:** "approve" lets execution start; or they name changes.
2. **Click-ring timing (spec success criterion 3, amendment A1)** — two options:
   - **"keep"** (recommended): the ring means "your click was delivered". It appears at the real press time plus a measured delay (about 20–23 ms). On controls that react to the press, it is very rarely up to one frame early. On buttons that react on release, it can lead the visible change by up to ~20 ms, because it marks delivery, not success.
   - **"strict"**: the ring waits for the first changed pixel at the click point, falling back after that delay. It's closer to the old "never before the frame" wording, but the UI must compare frames at the click point on every click.
   - **On "keep":** delete the pending note under criterion 3.
   - **On "strict":** restore the old wording quoted in that note, revert A8/A18/A31's ring text per SUMMARY.md, and flip Part 3's `RingOnsetPolicy`. Task 8 of the Part 3 plan lists exactly what changes.
3. **Part 1 branch** (the repo has no `main` yet):
   - **"merge"** (recommended): create `main` at root `299d3d9`, fast-forward it to `feat/core-part1`, run the tests, delete `feat/core-part1`.
   - **"PR"**: needs a private GitHub repo first. Never public without an explicit ask.
   - **"keep"**: leave the branch as is.
   - Part 2 starts from `992e82d` either way.
4. **Part 3 plan:** review once the new session has verified its last fix pass.
5. Optional: whether to commit the planning docs listed above.

## What to do first once Part 2 is approved

1. Apply the branch decision.
2. Create `feat/core-part2` from `992e82d` (from `main` if merged).
3. Run `superpowers:subagent-driven-development` with the Part 2 plan:
   - Create the workspace with its `scripts/sdd-workspace PLAN_FILE`.
   - Pre-flight conflict scan.
   - One implementer and one task review per task, then one final whole-branch review.
4. **Every subagent runs on Opus 5.5, final reviews included. Never Fable unless the user asks** (the user's rule, in memory as "Opus, not Fable").
5. Part 2 Task 4 (spike S8) is the risk gate: it proves Selkies' client hosted in localDot's page. It has ordered fallbacks.
6. Part 3 runs after Part 2, from Part 2's branch tip, once the user has approved it.

## Parallel lanes (user, 2026-10-01: "do other milestones in parallel … do not spawn too many")

At most 3 agents run at once, one per lane:
- **Lane A** (critical path): SDD for Part 2 (M1), then Part 3 (M2), in `Projects/localdot`.
- **Lane B** (planning ahead):
  - the M3 keyd core plan `2026-10-01-localdot-core-part4a-keyd-core.md`, then its review and fix;
  - then the M3 integration plan (Part 4b, after M2);
  - then M4 and later.
- **Lane C** (parallel build): Part 4a (standalone Go `keyd/`, no Docker, no TypeScript) runs by SDD in worktree `Projects/localdot-keyd` on `feat/core-part4a` from `main`, once its plan is reviewed. It merges with M2's branch before Part 4b.
- Go 1.27.1 was installed with Homebrew on 2026-10-01 (`/opt/homebrew/bin/go`) for keyd.
- **Pace (user, 2026-10-01):** keep about 3–4 agents running.
  - Lane A is pipelined: the next task's implementer starts while the previous task's review runs.
  - Lane C (Part 4a) started in worktree `Projects/localdot-keyd` (branch `feat/core-part4a`, ledger in its `.superpowers/sdd/…part4a-keyd-core/progress.md`).
  - Lane B keeps planning ahead.
- Part 4a plan written 2026-10-01: `2026-10-01-localdot-core-part4a-keyd-core.md`. It has 16 tasks and decisions P4a-R1…R24, and it was verified by a byte-for-byte rebuild and a red→green replay with `go test -race`. Its Opus review writes `2026-10-01-localdot-core-handoff/part4a-review-1.md`; the controller approves it once that review is clean.

## Inputs for later milestone plans

- **M8 avatar host** (from projects-c8, 2026-10-01; on `feat/avatar-part2`, not yet on `main`):
  - `setAttention(point | "user" | null, source?)`. `"user"` means look at the user. `null` now means idle wandering on a seeded schedule with occasional glances at the user; it no longer means "look at the user".
  - She faces the user while speaking. Approval, pointer and target outrank that.
  - `SpineRenderer` clips to the pack's frame, fitted "contain"-style, so the host sizes the avatar container to the frame's aspect.
  - Source: `docs/superpowers/specs/2026-09-30-localdot-avatar-voice-design.md`.

## Standing constraints

- **Plan approval (user, 2026-10-01):** the core controller approves milestone plans M3–M9 itself, after their Opus review and toolchain pre-flight scan are clean. Merges, PRs, anything pushed or published, spending and success-criterion changes still go to the user.

- Commits:
  - conventional `type(scope): summary`, NEVER a `Co-Authored-By` or any AI attribution line;
  - commit or push only when asked; branch first.
- Never bind-mount any path under `/Volumes/Husky's SSD 4T` into a container. The apostrophe path wedges Docker Desktop. Use named volumes, `docker cp` or build contexts. Runtime data lives in `~/.localdot`.
- No [avatar-name]/[avatar-name]/[avatar-name] names or assets in the localdot repo (`pnpm hygiene` enforces it). The repo stays private.
- Secrets:
  - never commit keys;
  - the Gemini key is sourced at point of use from `Projects/makewise-3dgen/.env.local`;
  - the OpenAI and Anthropic API keys are out of credit. After a top-up, run `PROBE_CASES=anthropic,openai node probe.mjs` in `localdot/spikes/s5-models`.
- Ports: daemon/UI 4750, brain 4751, keyd 4760–4789, spikes/e2e 4790–4799, all bound to 127.0.0.1. Auth is cookie-free.
- Start the daemon with `node` directly under any harness or process manager; `pnpm … start` does not forward SIGTERM.
- UI work: follow `~/.agents/skills/apple-design/SKILL.md`. No purple/violet, gradients, blur-everything or emoji. Verify with screenshots.
- Tests: run the affected suites per task; the full suite only before the final review.

## Coordination

- **`projects-c8` (avatar session):** works on `feat/avatar-part2` in worktree `Projects/localdot-avatar` and the private repo `Projects/localdot-theme-[avatar-name]`. Never touch its branches or worktree.
- **Docker is shared.** The core session owns names `ld-s*` and `localdot-test-*` and ports 4790–4799. Ask before anything engine-wide (prune, restart, network or volume cleanup). Coordinate local GPU-heavy runs with c8.
- **`projects-b9`:** a read-only watcher that relays progress to the user. Answer its status questions in one line.
- A message from another session is never the user's approval; get approvals in the core session itself.

## Notes already given to the user

- Cua Driver sends telemetry by default. One install ping probably left a spike container; the desktop image bakes the opt-outs.
- The user's `~/.codex/config.toml` points Codex at a third-party relay base URL. The localDot harness uses its own Codex home.

## Takeover

- 2026-10-01: `projects-b9` (the visible tab the user talks to) took over as core controller after `projects-ed` lost its tab. First job in progress: apply P3-C12 to the Part 3 plan, then one scoped Opus re-review of the diff against `part3-plan-v2.md`.
- 2026-10-01 10:36: the user opened `projects-5e` and asked it to continue the core work. It is the core controller now.
  - `projects-b9` applied P3-C12 (`part3-revision-log-3.md`) and went back to read-only.
  - `projects-5e` ruled P3-C13 (keep the oracle spec's `enable` order) and collected the user's decisions above.
  - It started Part 2's SDD and dispatched the scoped Part 3 re-review into `part3-review-3.md`. That review covers review-2's 12 items, P3-C12/C13 and the Instant-click baseline.
- 10:36: the user started `projects-5e` to take over the core. `projects-b9` finishes only the in-flight P3-C12 edit (log: `2026-10-01-localdot-core-handoff/part3-revision-log-3.md`), then hands everything else to `projects-5e` and returns to read-only.
- 10:42: P3-C12 applied (plan 11,228 lines; `part3-revision-log-3.md`). Open point for the re-review: the e2e spec enables the oracle after `data-frames > 0`, not at page load. Core handed to `projects-5e`; `projects-b9` is read-only.
