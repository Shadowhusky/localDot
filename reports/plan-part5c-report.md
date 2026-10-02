# Report: plan-part5c (the Codex harness for ChatGPT plans, M4)

**Status: DONE_WITH_CONCERNS.** The plan is written and pushed. Its boundary code and every
Review Focus pin except the macOS ones ran in a scratch copy, and the real Codex 0.154.0 ran against
a loopback stand-in for OpenAI. Seatbelt, macOS's netcat and a real ChatGPT sign-in could not run
here (Linux, no account); Task 14 is the Mac suite that covers them.

- **Branch:** `claude/plan-part5c` (from `origin/planning` at `5102d29`).
- **Commits:**
  - `6d58005` `docs(planning): Part 5c Codex harness plan (M4, ChatGPT plans)`:
    `docs/superpowers/plans/2026-10-01-localdot-core-part5c-codex-harness.md`.
  - This report, as the last commit.

## Tasks (14)

| # | Tier | Task |
|---|---|---|
| 1 | light | Branch `feat/core-part5c` from 5a; the `@localdot/codex-harness` package; the `subscription.usage` event; `pnpm test:codex` |
| 2 | full | Pin Codex 0.154.0 by SHA-256 (darwin-arm64, linux-x64) and copy it into `~/.localdot/codex/bin/0.154.0` |
| 3 | full | The srt profile per purpose (task, account, browser sign-in) and localDot's own Codex home |
| 4 | full | The scrubbed environment, the fixed command line (20 features off), Stop by process group |
| 5 | full | The approval filter (only `localdot`'s `mcp_tool_call` form prompt on the task's thread) |
| 6 | full | The protocol subset, the RPC client with a 12-method allowlist, the 0.154 schema contract |
| 7 | full | localDot's MCP endpoint: a private Unix socket per task, through `dispatchTool` |
| 8 | light | Codex's events as localDot's events; `subscription.usage` |
| 9 | full | `launchCodex`: srt and Codex put together; `harnessAvailability` (macOS arm64 only) |
| 10 | light | The driver: turns, steers, follow-ups, pauses for sign-in and plan limits, retries, recap, violations |
| 11 | light | The account service and routes: sign-in (browser or code), status, usage, refresh, sign-out |
| 12 | light | The runner picks Codex for `main: {provider: "chatgpt"}`; settings, providers route, wiring |
| 13 | light | Opt-in probes of the real Codex against a loopback OpenAI (8 tests, complete code) |
| 14 | full | The macOS sandbox suite under Seatbelt, a manual real sign-in with refresh and a usage turn, README |

## Key decisions (P5c-R1–R28 in the plan)

- **R1, the pin:** Codex 0.154.0, S7's build. 0.160.0 changes 14 of the 35 schema files localDot
  relies on and drops `thread/rollback`.
- **R2, the MCP endpoint is a Unix socket bridged by `/usr/bin/nc -U`.** srt's Seatbelt profile
  reaches loopback only through `allowLocalBinding`, which opens every loopback port (keyd, the
  daemon, LM Studio).
- **R3, the endpoint's access control is its path:** 128 random bits, 0700 folders, a 0600
  socket, at most 4 connections, one session.
- **R4, the approval filter is stricter than the spec's wording:** mode exactly `form`, kind exactly
  `mcp_tool_call`, the main thread only, legacy replies `"denied"`.
- **R5, sub-agents are forbidden.** 0.154 cannot switch them off (measured). Their calls are
  declined and the turn is interrupted.
- **R8, ChatGPT connectors, plugins and analytics are switched off by flag.** Measured: without the
  flags, Codex calls `/ps/mcp` and `/ps/plugins/*` on the allowed `chatgpt.com`.
- **R9, sign-in runs in separate short-lived processes.** Only the browser flow gets
  `allowLocalBinding`. Sign-in and sign-out are refused while a ChatGPT task is active.
- **R10, a refresh failure pauses the task with no fallback.** Resume relaunches Codex, because a
  running app-server does not re-read `auth.json` (measured).
- **R24, macOS on Apple silicon only in M4.**

## Verified (scratch copy of `feat/core-part2` + 5a's `tools.ts` and `session.ts`)

- Unit: 60 files and 466 tests pass, 3 skipped. That includes this plan's 14 files and 55 tests.
  The five complete driver tests ran against a scratch-only driver, which the plan does not
  include. `pnpm typecheck`, Biome and `pnpm hygiene` are clean.
- Probes: 8 of 8, twice, with Codex 0.154.0 (linux-x64) in a no-network namespace against a
  loopback mock. They covered:
  - no `exec_command`;
  - a patch declined and never written;
  - a sub-agent's call declined;
  - a refresh failure giving `unauthorized` and `account: null`;
  - a refresh rewriting only localDot's `auth.json`;
  - only five backend paths contacted;
  - an environment of exactly 11+1 variables;
  - the browser sign-in URL and `localhost:1455`;
  - API-key login refused;
  - logout deleting `auth.json`;
  - the schema contract.
- srt 0.0.78's own schema accepts each profile whole.

## Not verified

- **macOS:** Seatbelt enforcement (Task 14's suite), `/usr/bin/nc -U` on macOS, the firmlink deny
  rule, `/etc/ssl/cert.pem`, running the darwin binary (only its hashes from npm), and WebSocket
  through srt's proxy.
- **OpenAI:** the real sign-in (browser and device code), a real refresh under srt, real turns with
  `ComputerAction` as the computer schema, and the usage re-measurement. All are in Task 14's manual
  suite.
- **Light tasks:** their production code (mapper, driver, account, routes, runner changes) and the
  named tests are left to the build.
- **Part 5a as built:** `AgentSession`, `dispatchTool`, `createToolApi`'s options, `AgentRunner`,
  `AgentSettings` and `createAgent` are taken from its plan text.

## Concerns

1. **The bridge depends on macOS's `nc -U`.** If it misbehaves under Seatbelt, the fix is a
   different stdio bridge. Task 14 checks it first.
2. **The sandbox has two known gaps:**
   - srt always lets its child write `/tmp/claude`;
   - the browser sign-in process can reach every loopback port while it lives.
   Both are recorded as residual risks.
3. **The concurrent `plan-part5a-providers` job may change `PROVIDERS` and `AgentSettings`.** Task
   12 adds only `codexDenyRead` and a `chatgpt` branch, but the pre-flight should re-read the
   merged 5a plan.
4. **`@openai/codex` becomes a dependency of every install** (about 117 MB on the Mac). M9 may
   switch to downloading it on first use.
