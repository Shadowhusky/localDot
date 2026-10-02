# Job: write the Part 5c plan: the Codex harness for ChatGPT plans (moved from M8 to M4)

- **Output branch:** made from `origin/planning`, named `claude/plan-part5c`. Commit:
  - `docs/superpowers/plans/2026-10-01-localdot-core-part5c-codex-harness.md`;
  - `reports/plan-part5c-report.md` (task list, decisions, what you verified and what you couldn't, assumptions on unbuilt code).
  Push it. Follow `jobs/PLAN-WRITING.md` and `jobs/PROCESS.md`.

## Why
The user wants to use their ChatGPT plan instead of paid API calls (2026-10-02). The spec now puts the Codex harness in M4, as Part 5c.
- Claude subscription sign-in stays out: Anthropic doesn't allow third-party products to offer it (spec, "Subscription sign-in").

## Scope
Everything the spec says about the Codex harness:
- trust rule 7;
- the components table row;
- "Subscription sign-in" → "ChatGPT plan", every bullet: the process under srt, TLS, its own `CODEX_HOME` and sign-in (`account/login/start`), the scrubbed environment, files, network, approvals, limits, events and tests;
- the repository layout (`harness/codex/`);
- the threat-model lines.

Also:
- Codex runs the agent loop and calls only localDot's MCP tools. Those are the same v1 tools Part 5a gives the brain, so read Part 5a's plan (`git show origin/claude/plan-part5a:docs/superpowers/plans/2026-10-01-localdot-core-part5a-agent-core.md`), especially its tool API on port 4751 and "Interfaces Part 5b builds on".
- Map Codex's thread, turn and item events onto the event log so the timeline, approvals and replay work the same.
- The provider picker gets a "ChatGPT plan" entry, with its sign-in flow, status and sign-out. Plan the daemon API and events; Part 5b draws the UI.
- Verify a separate home, its sign-in and its token refresh (the spec's open M8 item, now this part's).

## Inputs
- **S7's findings:** `git show origin/main:spikes/s7-codex/FINDINGS.md` (find the exact path under `spikes/`), with `docs/spikes/SUMMARY.md` and its tight srt profile.
- **The spec:** on planning.
- **Part 5a's plan:** above.
- **Code:** `origin/main` and `origin/feat/core-part2`.

## Rules
- Part 5c runs after Part 5a, on `feat/core-part5c` from 5a's tip.
- Format (PLAN-WRITING, by milestone):
  - the sandbox profile, the env scrub, the approval filter and the MCP endpoint's auth are the security boundary: complete code, review tier `full`;
  - the rest: interfaces and tests, review tier `light`.
- Pin the Codex version, and check `codex app-server generate-json-schema` output against it (in a scratch dir, if the npm package can be installed; never sign in, never call OpenAI).
- **Review Focus must include, each with a pinning test:**
  - Codex running a command or editing a file itself;
  - reading the user's `~/.codex` or `~`;
  - the daemon's provider keys leaking into Codex's environment;
  - approvals from anything but localDot's MCP server;
  - a token refresh failure mid-task.
- Where the spec is silent, decide, and record it as `P5c-R…`.
