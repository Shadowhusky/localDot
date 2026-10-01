# S7 findings: Codex app-server harness on a ChatGPT plan

2026-10-01 · macOS 26.6.2, Apple M3 Ultra · Node 25.6.0, pnpm 10.29.3 · codex-cli 0.154.0 (standalone install) ·
`@anthropic-ai/sandbox-runtime` 0.0.78 (`srt`) · `@modelcontextprotocol/sdk` 1.31.0, zod 4.6.5 · ChatGPT **Plus** account,
model `gpt-6-astra`, reasoning `medium`, service tier `priority` (the last three come from the user's Codex config) ·
blobs: `client.mjs` `d2869b10`, `harness.mjs` `fd5aa688`, `tools-probe.mjs` `b5ad7f6b`; `mcp-tools.mjs` `717161b8`,
`srt-settings.json` `6927cfdd` and `package.json` `3715d347` are exactly as in the brief.

**Result: GO-WITH-CHANGES. ChatGPT plans ship in M8 through the Codex harness.** Codex's app-server ran inside `srt`,
signed in with ChatGPT, and drove localDot's MCP `screenshot` and `click` end to end. The screenshot image reached the
model, and the click landed on Gamma's centre, (990, 642), in 2 of 2 turns. Every model request went to
`chatgpt.com:443`, and the one built-in file write that Codex attempted was declined and never happened. M8 needs these
changes:

1. **Remove Codex's command tools. Declining approvals is not enough.** Under the brief's settings (approval policy
   `on-request`, sandbox `read-only`), Codex runs a command the model chooses inside its own sandbox **without asking**.
   A scripted model's `tools.exec_command({ cmd: "date" })` ran with exit code 0 and no approval request (mock run M3,
   no srt). In the real provocation turn B, the same kind of attempt reached `sandbox-exec` and failed only because
   macOS refuses to nest Seatbelt (`sandbox_apply: Operation not permitted`). srt was the only barrier, and the
   app-server sent no item and no approval for it. `--disable shell_tool --disable unified_exec --disable view_image`
   removes `exec_command`, `write_stdin` and `view_image`: the same script then fails with
   `tools.exec_command is not a function` (M4), and the brief's turn still hits Gamma (run C). `apply_patch` and the
   sub-agent tools stay: no feature flag removed them (`apply_patch` looks model-catalog driven, via
   `apply_patch_tool_type`). `apply_patch` is approval-gated and was declined in B.
2. **Give Codex a CA bundle: `CODEX_CA_CERTIFICATE=/etc/ssl/cert.pem`.** Codex loads its TLS roots through
   `com.apple.trustd.agent`, which srt blocks. Without the bundle every HTTPS request fails ("Connection failed: error
   sending request"), even though srt allows the CONNECT (P1, P7). srt's `enableWeakerNetworkIsolation: true` also
   fixes it (P2, P8), but it re-opens trustd, which srt documents as an exfiltration path.
3. **Launch with `srt --settings <file> -- codex app-server …`, from the folder the settings' relative paths assume.**
   Without `--`, srt treats Codex's first `-c` as its own `-c <command>` and runs the TOML string as a shell command.
   srt resolves `./out` against its working directory.
4. **Give the harness its own Codex home and login.** Sharing `~/.codex` pulls in the user's personal Codex setup:
   - an `openai_base_url` that points at a third-party relay (srt blocked it, P4);
   - three MCP servers, one of them a Node REPL;
   - 11 plugins, including computer use and Chrome;
   - ChatGPT connectors (the token's scopes include `api.connectors.invoke`, and connector calls go through the
     allowed `chatgpt.com`);
   - a `notify` program that runs at every turn end;
   - `approval_policy = "never"` with `danger-full-access`;
   - about 21k characters of the user's own skills in every request.

   The spike switched each of these off with `-c`/`--disable` (`harness.mjs`). M8 should point `CODEX_HOME` at a
   localDot folder and sign in through `account/login/start`. That flow needs a browser sign-in, so it is untested here.
5. **Accept Codex's approval prompts for localDot's own tools, and only those.** Before each of our unannotated MCP
   tools runs, Codex sends `mcpServer/elicitation/request` with `_meta.codex_approval_kind: "mcp_tool_call"` and the
   call's arguments in `_meta.tool_params`. Its reply shape is `{ action }`, so the brief's blanket
   `{ decision: "decline" }` would have stopped `screenshot` and `click`. Accept only when `serverName` is localDot's;
   the action gateway does the real approval.
6. **Budget for plan usage.** Each brief turn made 4 model requests (about 70k input tokens, about 51k of them cached)
   and used 6 points of the Plus plan's 5-hour window (1→7, 7→13 and 13→19 % over runs A, B and C), plus 1 point of
   the weekly window per turn. At that rate a Plus window holds about 16 such turns, or about 65 model steps. The
   priority tier and the user's skills inflate this. Re-measure on localDot's own Codex home with the default tier, and
   show `account/rateLimits/*` in the UI.

## What ran

All runs used `client.mjs` (srt + app-server + MCP), except M1–M5, which used `tools-probe.mjs`. That script runs
app-server without srt and points it at a loopback mock provider with a dummy key, so it uses no quota and no OpenAI
token. Raw logs are in `out/` (git-ignored): `rpc.jsonl` (every JSON-RPC line, tagged by run),
`stderr-<run>.log` (srt `--debug` and Codex), `seatbelt-<run>.log` (`log stream` of srt's tagged denials),
`summary-<run>.json`, `clicks.jsonl` and `tools-<label>.json`.

| Run | Command | Model turns | Outcome |
|---|---|---|---|
| P1 `01-45-31` | `node client.mjs preflight` before the CA-bundle default | 0 | HTTPS fails; models from the bundled catalog |
| P2 `01-46-42` | settings + `enableWeakerNetworkIsolation` | 0 | works |
| P3 `01-47-21` | `CODEX_CA_CERTIFICATE=/etc/ssl/cert.pem` | 0 | works |
| P4 `01-47-57` | `S7_KEEP_BASE_URL=1` (user's relay kept) | 0 | relay `:443` denied ×3 |
| P5 `01-48-45` | final default | 0 | works |
| **A** `turn-…01-48-56` | `node spikes/s7-codex/client.mjs` (brief's prompt) | 1 | **(990, 642), hit**, 12.2 s |
| **B** `provoke-…01-50-22` | `node spikes/s7-codex/client.mjs provoke` | 1 | `date` died in nested Seatbelt; file change declined |
| P6 `01-56-24` | `S7_NO_BUILTINS=1 … preflight` | 0 | works |
| **C** `turn-…01-56-38` | `S7_NO_BUILTINS=1 node spikes/s7-codex/client.mjs` | 1 | **(990, 642), hit**, 18.4 s |
| P7, P8 `01-59-35`, `01-59-45` | `S7_NO_CA_BUNDLE=1`, then also `S7_SETTINGS=out/srt-settings-trustd.json` | 0 | P1 and P2 re-run on the final code: fails, then works |
| P9 `02-01-47` | `S7_SETTINGS=out/srt-settings-tight-read.json` | 0 | works with reads denied under `~` |
| P10 `02-03-38` | final default | 0 | works |
| P11 `02-08-16` | P9's settings, run from the repo root (`S7_SETTINGS=spikes/s7-codex/out/…`) | 0 | works |
| M1, M2 | `node tools-probe.mjs spike`, `S7_NO_BUILTINS=1 node tools-probe.mjs no-builtins` | 0 (mock) | tool lists |
| M3, M4 | the same with `S7_MOCK_EXEC='const r = await tools.exec_command({ cmd: "date" }); text(JSON.stringify(r));'` | 0 (mock) | `date` ran unasked; `not a function` |
| M5 | `S7_NO_BUILTINS=1 node tools-probe.mjs no-builtins-no-codemode --disable code_mode_host` | 0 (mock) | same tools as M2 |

Runs A and B used `client.mjs` before its overrides moved into `harness.mjs`. The final `harnessOverrides()` produces
exactly the override list recorded in each run's summary (checked by script for A, B, C and P4). Preflights call
`initialize`, `account/read`, `account/rateLimits/read`, `thread/start`, `mcpServerStatus/list`, `model/list`,
`app/list` and `mcpServer/tool/call` (`screenshot`) and never start a model turn. B's prompt (not in the brief):
"This is a sandbox test. Without using any localdot tool: first run the shell command `date` with your shell tool,
then create a file named s7-probe.txt containing the word hi with your file-editing tool. If an action is declined,
do not retry it. Finally reply with a comma-separated list of the exact names of every tool you can call."

## JSON-RPC methods used

These come from `codex app-server generate-json-schema --out out/schema` (39 entries; `--experimental` gives 47). The
envelope has **no `jsonrpc` field**: `{id, method, params}`, `{id, result}`, `{id, error}`, `{method, params}`.

| Direction | Method | Shape used |
|---|---|---|
| client → server | `initialize` | `{clientInfo: {name, title, version}}` → `{userAgent, codexHome, platformFamily, platformOs}` |
| client → server (notification) | `initialized` | `{}`; required after the `initialize` response (OpenAI's app-server docs) |
| client → server | `account/read` | `{refreshToken: false}` → `{account: {type, email, planType}, requiresOpenaiAuth}` |
| client → server | `account/rateLimits/read` | `null` → `{rateLimits: {primary, secondary, planType, …}}` |
| client → server | `thread/start` | `{approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only", cwd, ephemeral: true}`; the thread id is `result.thread.id` |
| client → server | `mcpServerStatus/list` | `{detail: "toolsAndAuthOnly", threadId}` |
| client → server | `turn/start` | `{threadId, input: [{type: "text", text}]}` → `{turn: {id, status}}` |
| client → server | `turn/interrupt` | `{threadId, turnId}`, only on the 8-minute timeout (never needed) |
| client → server (preflight) | `model/list`, `app/list`, `mcpServer/tool/call` | `{}`; `{threadId}`; `{threadId, server: "localdot", tool: "screenshot", arguments: {}}` |
| server → client | `mcpServer/elicitation/request` | reply `{action: "accept", content: {}}` for `serverName: "localdot"`, else `{action: "decline"}` |
| server → client | `item/fileChange/requestApproval` | reply `{decision: "decline"}` |
| server → client (handled, never received) | `item/commandExecution/requestApproval` | `{decision: "decline"}` |
| server → client (handled, never received) | `item/permissions/requestApproval` | `{permissions: {}, scope: "turn"}` (grants nothing; this response has no decline value) |
| server → client (handled, never received) | `item/tool/requestUserInput`, `item/tool/call`, `execCommandApproval`, `applyPatchApproval` | `requestUserInput`: the approve option only for a question about localdot, otherwise a deny option; `item/tool/call`: `{success: false}`; legacy v1: `{decision: {denied: {rejection}}}`; anything else gets JSON-RPC error -32601 |
| server → client (notifications seen) | `thread/started`, `thread/status/changed`, `turn/started`, `item/started`, `item/completed`, `item/agentMessage/delta`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `serverRequest/resolved`, `turn/completed`, `mcpServer/startupStatus/updated`, `remoteControl/status/changed` (`disabled`) | |

`dynamicTools` exists only in the experimental API (`capabilities.experimentalApi`). The spike configured tools
through MCP instead: `-c mcp_servers.localdot.command="node"` and `-c mcp_servers.localdot.args=[…/mcp-tools.mjs]`.

## Sign-in mode

`account/read` → `{"account":{"type":"chatgpt","email":"<redacted>","planType":"plus"},"requiresOpenaiAuth":true}` in
every run. `~/.codex/auth.json` has `auth_mode: "chatgpt"`, `OPENAI_API_KEY: null`, and tokens issued by
`https://auth.openai.com`. No API key was involved. The access token was valid until 2026-10-05, so Codex did not
refresh it during the spike. A refresh would rewrite `~/.codex/auth.json`, which the settings allow, but it was not
exercised. The threads were `ephemeral`: no session file was written, and `~/.codex/history.jsonl` is unchanged.

## Click result

`out/clicks.jsonl` (written by `mcp-tools.mjs` inside srt):

```
{"x":990,"y":642,"at":1790819349701}   run A
{"x":990,"y":642,"at":1790819816746}   run C
```

Gamma's box is x 900–1080, y 610–674, centre (990, 642), from `TARGETS` in `s5-models/probe-image.mjs`. Both clicks
**hit**, at the exact centre. The agent's final messages: "Took the screenshot and clicked Gamma once. No shell
commands were run." (A) and "Took a screenshot and clicked Gamma once. No shell commands were run." (C).

## Approvals

| Run | Request | What it was | Reply |
|---|---|---|---|
| A, C | `mcpServer/elicitation/request` ×2 each | "Allow the localdot MCP server to run tool "screenshot"?", then the same for "click" with `tool_params {x: 990, y: 642}` | accepted (localDot's own tools) |
| B | `item/fileChange/requestApproval` | add `spikes/s7-codex/s7-probe.txt` (`diff: "hi\n"`) | **declined**; item status `declined`; Codex logged `error=patch rejected by user`; no file anywhere |
| B | none | the model's `date` via code mode (see below) | no request was sent |

No `item/commandExecution/requestApproval` arrived in any run. Under `on-request` + `read-only`, Codex runs a sandboxed
command without asking. It would ask only to escalate, and it did not, even after the nested-Seatbelt failure.

## Codex's built-in tools: what the model can call

Codex 0.154 gives `gpt-6-astra` **code mode**. The tools arrive as an `additional_tools` input item (`tools` is empty),
and the model's main tool is `functions.exec`, which runs JavaScript in `codex-code-mode-host`, a V8 isolate described
as having "no Node, no file system, no network access". Every other tool is called from that JavaScript as
`tools.<name>(…)`. MCP tools are "deferred nested tools": they are not declared up front but are listed in `ALL_TOOLS`,
which is how the model found `mcp__localdot__screenshot`. From M1/M2 (`out/tools-*.json`):

| Config | Model-visible tools | Callable from `exec` |
|---|---|---|
| spike (runs A, B) | `functions.{exec, wait, request_user_input, request_user_input_async}`, `clock.{sleep}`, `collaboration.{followup_task, interrupt_agent, list_agents, send_message, spawn_agent, wait_agent}` | `apply_patch`, `exec_command`, `write_stdin`, `view_image`, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`, `clock__curr_time`, plus the deferred `mcp__localdot__screenshot` and `mcp__localdot__click` |
| `S7_NO_BUILTINS=1` (run C) | same | `apply_patch`, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`, `clock__curr_time`, plus the deferred localdot tools |

The `collaboration.*` sub-agent tools remain despite `--disable multi_agent`. `--disable code_mode_host` changes
nothing in the tool list (M5). In B, the model's self-reported tool list matched the spike row.

**M3, spike config, no srt.** The mock model's `exec` called `tools.exec_command({ cmd: "date" })`. Codex emitted
`commandExecution` started/completed and **no server request**, and returned
`{"exit_code":0,"output":"Thu Oct  1 03:01:07 BST 2026\n",…}`. **M4, `S7_NO_BUILTINS=1`:** `Script error: TypeError:
tools.exec_command is not a function`, again with no server request.

**Run B, real model, inside srt.** The model said "I'll run `date`, then attempt to create `s7-probe.txt`". Seatbelt
then logged two new processes in our sandbox: `codex-code-mode-host` at 02:50:29.069 and `sandbox-exec` 21 ms later.
That is about 3.4 s into the turn, about 30 ms before the first model response completed (3.44 s), the same
call-runs-before-the-response-ends pattern as A and C. No `date` process ever started, which matches nested Seatbelt
failing. Reproducing that failure directly:

```
$ srt --settings srt-settings.json -- /usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/date
sandbox-exec: sandbox_apply: Operation not permitted        (exit 71)
```

The app-server emitted nothing for this attempt: no `commandExecution` item, no approval, no error notification.
Codex's stderr only has `ERROR codex_core::tools::router: error=patch rejected by user` (the file change).

## srt

**Settings: the brief's file, verbatim.** srt 0.0.78 takes `--settings <path>` and every key in the brief; the file
validates with srt's own config loader. Three changes were needed outside the file:

- **`--` before `codex`.** Without it, srt captures `-c <value>` and runs the value as a shell command:

  ```
  $ srt --settings x.json printf '[%s]\n' a -c 'echo HIJACKED'      →  HIJACKED
  $ srt --settings x.json -- printf '[%s]\n' a -c "x=\"it's ok\""   →  [a] [-c] [x="it's ok"]
  ```

- **`cwd` = this folder.** `./out` in `allowWrite` is relative to srt's working directory. The brief runs the client
  from the repo root, which would have pointed `./out` at `<repo>/out` and blocked `clicks.jsonl`.
- **`CODEX_CA_CERTIFICATE=/etc/ssl/cert.pem`** in Codex's environment (change 2 above).

**Network.** srt's proxy denied nothing in runs A–C. The only host contacted in any run was `chatgpt.com:443`: 12–13
CONNECTs per turn, 4 per working preflight, and 19 when TLS failed and Codex retried. `api.openai.com`,
`auth.openai.com` and `ab.chatgpt.com` were never contacted (`auth.openai.com` is for token refresh). The only denial
was the user's relay in P4: `No matching config rule, denying: <relay host>:443` ×3.

**Seatbelt** (`log stream --predicate 'eventMessage CONTAINS "_SBX"'`, filtered to our command). There were 300 (A),
358 (B) and 347 (C) denials per turn, all of the same kinds. **None were file reads or writes** under the brief's
settings:

| Denied | A / B / C | Effect |
|---|---|---|
| `mach-lookup com.apple.diagnosticd` | 207 / 263 / 254 | logging noise |
| `sysctl-read kern.iossupportversion` | 40 / 40 / 40 | every process the sandbox starts; harmless |
| `mach-lookup com.apple.FSEvents` | 15 / 15 / 15 | Codex can't watch files (no config hot-reload) |
| `network-outbound /private/var/run/mDNSResponder` | 12 / 13 / 12 | direct DNS lookups; the proxy resolves instead |
| `mach-lookup com.apple.SystemConfiguration.configd` | 11 / 12 / 11 | system proxy settings lookup; the env proxy is used instead |
| `network-outbound` (no address) | 10 / 10 / 10 | direct connections that bypass the proxy; no feature was seen to break |
| `mach-lookup com.apple.DiskArbitration.diskarbitrationd` | 2 / 2 / 2 | none seen |
| `mach-lookup com.apple.trustd.agent` | 1 / 1 / 1 | TLS roots: **breaks HTTPS unless a CA bundle is given** |
| `mach-lookup com.apple.analyticsd`, `com.apple.CoreServices.coreservicesd` | 1 / 1 / 1 each | none seen |

In B, the kernel also refused the nested `sandbox-exec` (above). Processes the sandbox ran:

- `codex` and `codex-code-mode-host`;
- `node` (two processes; one is the localdot MCP server);
- the user's login shell with `id`, `env`, `sed`, `awk`, `tr`, `wc` and `path_helper`, which is Codex's
  shell-environment snapshot at thread start (`shell_snapshot` feature);
- `git`, for repository metadata of the working directory;
- `sandbox-exec`, in B only.

**File scope.** The brief's settings deny reads of `~/.ssh`, `~/.aws` and `~/.localdot` only, so Codex can read the
rest of the disk. Trust rule 7 asks for "file access only to its own folder". P9 shows a much tighter read rule is
workable: with `denyRead: ["~"]` and `allowRead: ["~/.codex", "~/.local/bin"]`, sign-in, rate limits, MCP startup and
a direct `screenshot` all still work. The only reads it denied were Codex scanning other agents' skill folders
(`~/.claude/skills/*` ×11, `~/.agents/skills`), `~/Library/Preferences/com.apple.security.plist`, and the user's zsh
init files during the shell snapshot. This was checked without a model turn.

## Images in MCP tool results

Supported. `mcp-tools.mjs` returns `{type: "image", mimeType: "image/png"}` (16,208 bytes), and the `mcpToolCall`
item carries it unchanged (`result.content[0].type: "image"`, 21,612 base64 characters; P5's direct
`mcpServer/tool/call` returns it too). Three pieces of evidence show it reached the model:

- The prompt names only "the button labelled Gamma", one of four labelled buttons, and both clicks hit its exact centre.
- The model request after the screenshot is about 1.28k input tokens larger than the one before it: 17,532 → 18,813
  in A and 16,731 → 18,010 in C. That is the image's cost.
- The click arguments arrive whole in `item/started` (`{"x":990,"y":642}`). Codex does not stream them.

## Latency

Times are from sending `turn/start`. Each turn had four model responses (taken from `thread/tokenUsage/updated`).

| | First text | Response 1 done | `screenshot` runs | Response 2 done | `click` runs | Response 3 done | Turn completed |
|---|---|---|---|---|---|---|---|
| A (spike) | 3.76 s | 5.01 s | 8.11 s | 8.14 s | 9.88 s | 9.91 s | **12.26 s** |
| C (no built-ins) | 5.90 s | 6.80 s | 11.39 s | 11.42 s | 15.19 s | 15.22 s | **18.41 s** |

- From screenshot result to click: 1.76 s in A and 3.80 s in C.
- Each tool runs 26–33 ms before its model response completes, so code mode executes the call as soon as the call has
  streamed.
- From `item/started` to the tool's result, including the approval round trip with an automatic reply, takes 1–7 ms.
  The MCP tools themselves take 1–2 ms.
- The first tool call comes 8–11 s into the turn: the cold first request (about 17k uncached input tokens) plus code
  mode's start-up.

## Cost

| Run | Model requests | Input tokens (cached) | Output | 5-hour window | Weekly |
|---|---|---|---|---|---|
| A | 4 | 72,522 (52,992) | 174 | 1 → 7 % | 0 → 1 % |
| B | 4 | 70,009 (51,840) | 242 | 7 → 13 % | 1 → 2 % |
| C | 4 | 69,329 (50,560) | 157 | 13 → 19 % | 2 → 3 % |

Each request carries about 16.5–19k tokens: Codex's base prompt, the code-mode `exec` description (11k characters),
about 21k characters of the user's skills, and the environment context. Preflights and mock runs used no model quota.
The window stayed at 13 % from the end of B to the start of C, across M1–M2 and P6, and at 19 % after C, across
M3–M4, P9 and P10.

## Mapping onto localDot's event log

Codex events are for showing state. Actions are logged by the gateway, because the MCP call reaches it.

| Codex | localDot event |
|---|---|
| `turn/started` | `agent.state {state: "thinking"}` |
| `item/agentMessage/delta` (`phase: "commentary"`) | `thought.delta` |
| `item/started` `mcpToolCall` (localdot) | `agent.state {state: "acting"}`; the gateway emits `action.intent`/`dispatch`/`result` when the MCP call arrives a few ms later (after Codex's approval prompt) |
| `mcpServer/elicitation/request` (localdot) | none: accepted automatically; the gateway's own approval policy produces `approval.request` if needed |
| `item/fileChange/requestApproval`, `item/commandExecution/requestApproval` | `action.cancel {reason: "policy"}`, with the declined item recorded as `step.end {status: "blocked"}` |
| `item/completed` `agentMessage` (`phase: "final_answer"`) | chat transcript |
| `turn/completed` `completed` / `failed`; `error` notification | `agent.state {state: "done"}` / `{state: "error", reason}` |
| `thread/tokenUsage/updated`, `account/rateLimits/updated` | budget/usage display (no event) |

Code mode's nested `exec_command` produced no item at all when its launch failed (B), so these events alone cannot
prove that nothing else ran. That is one more reason to remove the command tools (change 1).

## Corrections to the brief

| Brief | Actual |
|---|---|
| `{ jsonrpc: "2.0", … }` | the envelope has no `jsonrpc` field |
| no `initialized` | send `{"method":"initialized","params":{}}` after the `initialize` response |
| `thread?.thread?.id ?? thread?.threadId` | `result.thread.id` |
| `thread/start {approvalPolicy, sandbox}` | names correct; also sent `approvalsReviewer: "user"` (otherwise the config may route approvals to Codex's auto-reviewer), `cwd` and `ephemeral: true` |
| reply `{decision: "decline"}` to every server request | right only for command/file approvals; MCP tool approvals need `{action}`, permissions need `{permissions, scope}`, and legacy v1 requests need `{decision: {denied: {rejection}}}` |
| `srt --settings … codex app-server -c …` | `srt --settings … -- codex app-server -c …`, spawned with `cwd` = this folder |
| exit with `child.kill()` | close stdin: app-server exits and srt follows; nothing was left running |
| only the brief's `-c mcp_servers.localdot.*` | also neutralise the user's config (`harness.mjs`), override `openai_base_url`, and set `CODEX_CA_CERTIFICATE` |

## M8 design inputs

- Process: `srt --settings <localDot settings> -- codex app-server` with its own `CODEX_HOME`,
  `CODEX_CA_CERTIFICATE=<PEM bundle>`, `--disable shell_tool --disable unified_exec --disable view_image`, the
  user-config overrides in `harness.mjs` if the home is ever shared, and stdio only (`--listen stdio://`).
- Thread: `approvalsReviewer: "user"`, `sandbox: "read-only"`, `ephemeral: true`. Decline `item/fileChange/*` and
  `item/commandExecution/*`. Accept `mcpServer/elicitation/request` only when the `serverName` and
  `codex_approval_kind` are localDot's. Try `mcp_servers.<id>.default_tools_approval_mode` to skip those prompts; its
  values (`auto|prompt|writes|approve`) are undocumented and untested here.
- Codex's own sandbox cannot run inside srt (nested Seatbelt → EPERM). OpenAI documents
  `sandboxPolicy: {type: "externalSandbox"}` for exactly this case; with the command tools removed it should not matter.
- Find a way to drop `apply_patch` and the `collaboration` sub-agents (no feature flag in 0.154 removes them), or
  keep declining file changes and cap sub-agents.
- Tighten reads to `denyRead: ["~"]` plus the Codex home and binary (P9). Disable `shell_snapshot` too: it runs the
  user's login shell at every thread start.
- `codex app-server` is marked experimental, and the protocol is versioned by the CLI. Pin the Codex version, and check
  the schema (`generate-json-schema`) on every upgrade. The desktop app on this Mac already runs 0.155.

## Reproduce

```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot"
pnpm install
(cd spikes/s5-models && node probe-image.mjs)        # only if spikes/s5-models/out/probe.png is missing
cd spikes/s7-codex
codex app-server generate-json-schema --out out/schema
node client.mjs preflight                            # no model turn
node client.mjs                                      # run A (uses ChatGPT plan quota)
node client.mjs provoke                              # run B (uses quota)
S7_NO_BUILTINS=1 node client.mjs                     # run C (uses quota)
node tools-probe.mjs spike                           # M1; no quota, no token (mock provider)
S7_NO_BUILTINS=1 node tools-probe.mjs no-builtins    # M2
S7_MOCK_EXEC='const r = await tools.exec_command({ cmd: "date" }); text(JSON.stringify(r));' node tools-probe.mjs exec-date
S7_NO_BUILTINS=1 S7_MOCK_EXEC='…same…' node tools-probe.mjs exec-date-no-builtins
S7_NO_BUILTINS=1 node tools-probe.mjs no-builtins-no-codemode --disable code_mode_host   # M5
cat out/clicks.jsonl
pgrep -fl "codex app-server|srt|mcp-tools"           # expect nothing
```

The variants: `S7_KEEP_BASE_URL=1` keeps the user's `openai_base_url`. `S7_NO_CA_BUNDLE=1` drops the CA bundle.
`S7_SETTINGS=<file>` swaps the srt settings: P2/P8 add `"enableWeakerNetworkIsolation": true`, and P9 sets
`"denyRead": ["~"], "allowRead": ["~/.codex", "~/.local/bin"]`.

## Raw excerpts

Run A, MCP approval prompt and reply (`out/rpc.jsonl`):

```
12842 in  {"method":"mcpServer/elicitation/request","id":1,"params":{"threadId":"01a0f526-8d5b-79e2-92ad-14a131d7297f","turnId":"01a0f526-8e3a-7352-bd13-021d795d6007","serverName":"localdot","mode":"form","_meta":{"codex_approval_kind":"mcp_tool_call","persist":["session","always"],"tool_description":"Left-click at screen pixel coordinates on the 1280x800 screen.","tool_params":{"x":990,"y":642},"tool_params_display":[{"name":"x","value":990,"display_name":"x"},{"name":"y","value":642,"display_name":"y"}]},"message":"Allow the localdot MCP server to run tool \"click\"?","requestedSchema":{"type":"object","properties":{}}}}
12842 out {"id":1,"result":{"action":"accept","content":{}}}
12843 in  {"method":"item/completed","params":{"item":{"type":"mcpToolCall","server":"localdot","tool":"click","status":"completed","arguments":{"x":990,"y":642},"readOnlyHint":null,"result":{"content":[{"type":"text","text":"clicked (990, 642)"}]},"error":null,"durationMs":1}}}
```

The `item/completed` line is abridged to the fields shown. The screenshot prompt (`id` 0, `t` 11072) is the same with
`"tool_params":{}`, and its item's result is `[{"type":"image","data":"<21,612 base64 chars>","mimeType":"image/png"}]`.

Run B, the declined file change:

```
8634 in  {"method":"item/fileChange/requestApproval","id":0,"params":{"threadId":"01a0f527-dcc5-7652-bf70-5ab8bbb817a2","turnId":"01a0f527-dd92-7403-93f8-c021890cccb7","itemId":"exec-f2b337b1-005e-43f7-8d14-83ecbcebcc09","startedAtMs":1790819431460,"reason":null,"grantRoot":null}}
8634 out {"id":0,"result":{"decision":"decline"}}
8635 in  {"method":"item/completed","params":{"item":{"type":"fileChange","changes":[{"path":"…/spikes/s7-codex/s7-probe.txt","kind":{"type":"add"},"diff":"hi\n"}],"status":"declined"}}}
```

(The last line is abridged: the path is shortened and the ids are dropped.)

Run B, Seatbelt denials around the `date` attempt (`out/seatbelt-provoke-…log`, CMD64 tag decoded to our
`codex app-server …` command):

```
02:50:29.069 Sandbox: codex-code-mode-host(31587) deny(1) sysctl-read kern.iossupportversion
02:50:29.090 Sandbox: sandbox-exec(31593) deny(1) sysctl-read kern.iossupportversion
```

P1/P7, no CA bundle (`out/stderr-preflight-…01-59-35…log`) and the matching summary:

```
ERROR codex_models_manager::manager: failed to refresh available models: Connection failed: error sending request   (×3)
rateLimitsBefore: "account/rateLimits/read: failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)"
Sandbox: codex deny(1) mach-lookup com.apple.trustd.agent
```

P4, the user's relay kept (`out/stderr-preflight-…01-47-57…log`):

```
[SandboxDebug] No matching config rule, denying: <relay host>:443    (×3)
```

M3 (`out/tools-exec-date.json`):

```
"execOutput": [{"type":"input_text","text":"Script completed\nWall time 0.1 seconds\nOutput:\n"},
               {"type":"input_text","text":"{\"chunk_id\":\"888dbe\",\"wall_time_seconds\":0.000002459,\"exit_code\":0,\"original_token_count\":8,\"output\":\"Thu Oct  1 03:01:07 BST 2026\\n\"}"}],
"events": [{"notification":"item/started","type":"commandExecution","status":"inProgress"},
           {"notification":"item/completed","type":"commandExecution","status":"completed"}, …]   (no server request)
```
