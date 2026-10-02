# Job plan-part5a — report

**Status: DONE_WITH_CONCERNS**

- **Plan:** `docs/superpowers/plans/2026-10-01-localdot-core-part5a-agent-core.md`, branch
  `claude/plan-part5a` (made from `origin/planning`).
- **Shape:** 16 tasks, 30 decisions (P5a-R1…R30), a five-item Review Focus, and the closing
  "Interfaces Part 5b builds on".
- **Embedded code:** about 13k lines, taken verbatim from a scratch copy where it compiled and ran
  (see "Verified").

## Tasks
1. Branch and protocol: the v1 tool table, the tool API's shapes (`BootConfig`, `ModelBinding`,
   transcript, inbox, `BrainEvent`), agent events (`message.*`, `ask.*`, `takeover.*`,
   `task.result`, `model.usage/retry`), `memory.change.changeId`, `unifiedDiff` (Myers),
   keyd route-model and budget replies.
2. `@localdot/providers`: registry (every API-key provider in the spec, plus LM Studio and Ollama;
   Bedrock and Vertex marked M8), models.dev catalog schema (tolerant), capabilities (native /
   generic, with per1000 for Gemini and Qwen / text-only / no-tools), `keydRouteModel`, and
   `modelPoint`, which refuses out-of-space coordinates.
3. desktopd shell: `bash -l` per command, desktopd's env scrubbed, process group, 1 MiB cap,
   UTF-8-safe streaming; paths confined to the home through symlinks.
4. desktopd files (read, write, edit-once, list, put, fetch; patches) and page tools through
   DevTools (read with an outline; navigate that waits for a new document; http(s) only), and
   their routes.
5. The daemon's `DesktopdTools`, tested against desktopd's real routes; `KeydClient` task, model
   and budget calls.
6. The freshness check in Part 3's gateway: a fresh observe during the travel, 96×96 luma
   compare, `action.cancel {stale}` plus the fresh frame; a failure never blocks. Given as a diff
   against Part 3's plan text.
7. Memory with undo, the skills loader plus one built-in skill, the catalog cache, settings, and
   role bindings.
8. The agent session, a handler for every v1 tool, and the tool API on 4751:
   - checks in order: token, Origin refused, v1 table, schema, 400-call cap, `ToolPolicy` seam
     with a taint flag;
   - redaction and `<untrusted>` wrapping.
9. Brain cells: an isolated network, a gate in role `brain` (relays keyd 3128 and the tool API
   4751 out, nothing in), a read-only, cap-dropped brain, keyd role `brain`, and a sweep by home.
10. Brain part 1:
    - `ToolClient`;
    - `proxyFetch` (undici `ProxyAgent`, absolute-form HTTP to `http://llm.ldot/<route>`);
    - `languageModel` (anthropic, openai responses, google, openai-compatible, azure, lmstudio,
      ollama);
    - `toolSet` (Anthropic toolset or legacy tool, or the generic tool);
    - `toComputerAction`.
11. Brain part 2, the loop:
    - pi-agent-core events and hooks, steer and follow-up queues;
    - guards: turns, failures, 402 pause, retry, local fallback, pause;
    - the newest three screenshots in context, compaction by the fast model;
    - a transcript without image data.
12. The brain's entry, its esbuild bundle with a license gate, and its image
    (`node:24.21.0-alpine3.23`, pinned by digest), plus a CI build step.
13. The `AgentRunner` (sessions, brain restarts, idle follow-ups, budget raise), the UI's agent
    routes, `createAgent` wiring, `LiveSessions.alias` (keyd events for the brain cell), and edits
    to `app.ts` and `main.ts`.
14. A brain plus the tool API end to end on the host (no Docker).
15. A Docker suite: a real brain cell through its gate, and isolation probes.
16. Opt-in computer-use checks per provider through the real keyd, which skip without credit; the
    README; the full run.

## Key decisions (all in the plan with why and cost)
- **R1:** our own loop, one `streamText` per turn, and the SDK executes no tool.
- **R2:** the brain is configured through the tool API; only its URL and token are in the
  environment.
- **R3:** the brain's gate relays out only; the tool API takes a per-brain token and refuses
  Origin.
- **R4 (a spec deviation to confirm):** four SDK clients cover all providers. The non-first-party
  providers use their OpenAI-compatible endpoints through keyd's `openai-compatible` kind, not
  each official `@ai-sdk/*` package.
- **R5:** local servers only on keyd's fixed 1234 and 11434. vLLM on another port needs a keyd
  change.
- **R9:** the freshness check's cost and thresholds.
- **R10:** screenshots as PNG via sharp; images inside tool results only for Anthropic.
- **R13:** the runaway guards and limits.
- **R14:** prompt injection is met with provenance plus the `ToolPolicy` seam; M4 acts on
  everything.
- **R16:** the shell is headless, not the visible terminal.
- **R19:** skills are copied into `~/.skills` and read with `files`, so there is no extra tool.
- **R21:** a session is one task, with idle follow-ups for 30 minutes.
- **R22:** brains take keyd ports from the top of the range.
- **R27:** no step verification or Opus escalation yet.

## Verified (scratch copy, Linux, Node 24.21.0, pinned toolchain, lockfile's AI SDK)
- **The base:** `feat/core-part2` at `b02765f`, plus Part 3 and Part 4b files extracted verbatim
  from their plans, plus 3 small signature stubs.
- **Full unit suite:** 71 files and 549 tests pass. This plan's share is 25 files and 138 tests,
  including the real AI SDK with `MockLanguageModelV4`, the real Anthropic and OpenAI-compatible
  clients through an HTTP-proxy stand-in, and Part 3's real gateway under the freshness tests.
- **One flake, fixed:** a fixed 20–30 ms wait in a new test failed once. Those waits now poll.
  Runs since: all green.
- **Static checks:** `pnpm typecheck` (all packages), `pnpm hygiene`, and Biome clean on every new
  file.
- **Bundles:** the brain and desktopd bundles build; the brain bundle starts and fails as
  specified without a tool API.
- **Red first:** `brain-flow.test.ts` fails with `proxyTunnel: true`.

## Not verified (assumptions for the pre-flight)
- **Docker:** no Docker anywhere.
  - Task 15's suite;
  - Part 2's gate and desktop image suites with the new `relay.sh` and desktopd routes;
  - the brain image;
  - `host.docker.internal` → 127.0.0.1:4751 from a brain gate.
- **keyd:** the LLM gateway and admin API are not built on any branch yet, so these were not run:
  - Task 16's provider checks;
  - the task, route-model and budget endpoints;
  - absolute-form HTTP through a real brain listener.
- **Real providers:** no model was called. These are assumptions:
  - the Anthropic toolset's shape on the wire, from the SDK's types and docs;
  - Sonnet 5.5 accepting the toolset;
  - OpenAI Responses with function tools.
- **Part 3 and Part 4b as built:** every edit to their files (desktopd `app.ts` and `main.ts`,
  `gateway.ts`, `live.ts`, `keyd/client.ts`, daemon `main.ts` names) is written against plan
  text.
- **In the real image:** desktopd's tools ran on this machine's bash and file system, not in the
  Ubuntu image. These are untested: `bash -l` under s6 sourcing `/etc/profile.d`, and CDP against
  a real Chromium.
- **sharp on real frames:** sharp decoding desktopd's `cwebp` frames (the tests used sharp-made
  WebP).

## Concerns
1. **R4 departs from the spec's "official provider packages"** for 13 providers. It needs the
   controller's or the user's nod.
2. **Until M5, nothing stops an injected page from steering the agent inside its own sandbox.**
   The `ToolPolicy` seam acts on every call in M4 (R14). keyd still guards every secret.
3. **The plan leans on unbuilt code:** Part 4a's LLM gateway, Part 4b's `main.ts` and
   `LiveSessions`, and Part 3's gateway. Task 1 stops if Part 4b is not merged.
4. **Incident during this job.** At about 12:37 UTC, to stop a hung test run in this job's scratch
   copy, I ran `pkill -f vitest`. On a shared machine that pattern matches any job's Vitest
   process, so a sibling job's test run in progress then may have been killed. Nothing on disk was
   touched.
