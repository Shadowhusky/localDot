# Agent capability discovery and recovery

Research and implementation: 13 October 2026.

localDot should select tools from observed capabilities, preserve working sessions, distinguish access failures from execution failures, and verify outcomes before retrying. These contracts belong to the runtime shared by every model provider. Provider-specific prompt recipes alone cannot supply missing evidence.

## Evidence from comparable systems

This comparison covers documented behavior and public source. It does not establish benchmark leadership or reveal proprietary planning internals.

| System | Verified design | Application to localDot |
| --- | --- | --- |
| [OpenAI dots](https://learn.chatgpt.com/docs/dots/computers-and-apps) | A persistent computer/browser, separate connections to apps and other computers, private sign-in entry, and reusable browser sessions. Saved credentials and an active browser session are different things. | Keep the existing isolated visible browser and private-input channel. Expose which access surface is being used; never infer CLI authorization from a connector or cookies. |
| [Grok Bot](https://docs.x.ai/grok-bot/computer-and-apps) and [its security documentation](https://docs.x.ai/grok-bot/security) | Browser, terminal, files and connectors coexist. Browser sessions and CLI state persist. Connector credentials stay in the backend. Screens within a shared computer are not security boundaries. | Prefer a connector for supported app operations, the shell for repository/build work, and the visible browser for websites. Preserve localDot's stronger separation between the browser profile and the desktop. |
| [Claude Cowork computer use](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork) | Connectors, browser interaction and screen interaction serve different operations; precise available tools are preferred over screen control. | Route by operation and current availability, rather than treating one interface as universally best. |
| [Browser Use sessions and profiles](https://github.com/browser-use/browser-use/blob/main/skills/cloud/references/sessions.md) | A session has a live view; profiles preserve browser state across sessions. Profile reuse and credential injection are separate mechanisms. | Continue using the existing persistent browser profile and visible screen. Recovery must not reset a profile or start a hidden browser just because one action failed. |
| [OpenHands stuck detector](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py) | Runtime detection covers repeated actions/results, repeated errors and alternating patterns. | Track bounded failed-attempt evidence outside the model. This implementation detects exact repeated failed attempts, including when reads intervene. It does not yet implement semantic or alternating-loop detection. |
| [MCP authorization, version 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) | HTTP authorization is tied to the protected resource; credentials are not a universal sign-in. HTTP 401 participates in authorization discovery. | Classify transport authentication separately from permission denial, invalid arguments, timeouts and application errors. Do not infer authentication from arbitrary text returned by a tool. |

[Anthropic's agent-evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) distinguishes deterministic outcome checks from model behavior measurements and recommends deriving cases from real failures. That distinction matters here: proving that the runtime returns accurate evidence does not prove that every model will always choose the best next action.

## Existing foundations retained

The screen coordinator already owns browser/desktop selection, control grants, cancellation, recording and profile-preserving recovery. The tool dispatcher already applies policy, approval, purpose, generation and stop checks. Connectors already keep credentials outside model output. Computer lifecycle and replacement have their own orchestrators.

The new layer composes these owners. It does not introduce another browser, alternate credential store, autonomous retry loop or bypass around the action policy.

## Runtime contract

`work_context` is available to the API brain (including text-only models), Codex and Claude Code through one schema and description. It returns:

- Desktop reachability and a bounded inventory of common command-line programs.
- Browser availability, current selected surface and whether a browser owner is attached. Attachment is explicitly not a health check or proof of website authentication.
- The connector operations exposed to this task, filtered through the user's current enabled/access settings, with the latest locally observed connection status and tool-list timestamp.
- Recent tool success/failure summaries and recovery categories.
- Route preferences for app, code, web or desktop work. They are advice, not authority to perform an operation.

The tool runs through normal admission and read authorization. It does not invoke connectors, open browsers, switch screens, inspect credentials or run a command. The authenticated desktop `/capabilities` endpoint checks file metadata against a fixed list of names on the service PATH. It never executes those programs or sources shell profiles. Missing/relative/truncated search paths produce `unknown` when absence cannot be established. `not_on_path` is not a claim that software cannot exist elsewhere.

Older desktop versions return an unsupported inventory with unknown program states. They remain usable; there is no silent shell fallback. An unavailable endpoint is distinct from missing software. Cancellation discards late results.

Connector status records local observations, not permanent authorization. A ready connection may still deny a particular resource. CLI and website authentication remain `not_checked` until checked on their own surface. The agent must use existing connected tools for supported operations, inspect the requested website's existing session, or check the required CLI's auth status before asking the user to sign in.

## Failure and recovery contract

`ToolResult.recovery` is a typed protocol field. Trusted adapters and the dispatcher produce it; model-written or external error text cannot manufacture it. The dispatcher appends the same concise advice to textual results, so native MCP and API models both receive it.

| Evidence | Recovery behavior |
| --- | --- |
| Invalid tool arguments | Correct the schema/input; do not request a login. |
| Stale browser observation | Read the current page before acting on fresh targets. |
| Browser unavailable | Preserve the profile; use the existing recovery owner before one retry. |
| Connector transport 401 | Authentication is required for that connection, not automatically for other surfaces. |
| Connector transport 403 / insufficient scope | Permission failure; do not turn it into a repeated sign-in request or route around the restriction. |
| MCP application error | Inspect the result; arbitrary text such as “401” does not change saved connection state. |
| Timeout / uncertain completion | Verify the external effect before retrying a possible write. Existing uncertain-shell containment remains authoritative. |
| Browser download started | Keep browser control; wait for the existing review/release flow. Starting a download does not mean the file reached the desktop. |
| Same failed attempt repeated | Provide an explicit repetition count and require a changed approach with new evidence. Preserve stronger permission/no-retry guidance. |

`WorkProgress` stores hashes of arguments and bounded result summaries, not commands, URLs, returned data or credentials. Display-only top-level intent/frame-basis changes do not hide an identical failed attempt. Success clears that attempt's count; unrelated successful reads do not. New user requests and brain generations reset this diagnostic window. Stop, pauses and final containment keep their existing semantics.

Repeated-failure detection is advisory. It does not grant a retry, automatically execute one, override an approval, or impose a new global hard stop. The existing action limit, stop fences and per-operation ownership remain responsible for execution control.

## Validation and maintenance

Regression coverage exercises actual dispatch, connector and desktop-client routes, not just prompt strings:

- Identical tool contracts across API, Codex and Claude Code.
- Executable discovery without running the executable or a shell profile.
- Old desktop compatibility, invalid inventory and cancellation of a pending check.
- Successful connector access alongside unknown browser/CLI authorization.
- Connector disablement during an existing task.
- HTTP 401 versus 403, application error text and timeouts.
- Repeated failures with intervening reads, successful polling, generation resets and bounded/redacted history.
- Browser availability discovery without starting a browser or granting control.

For a new integration, add capability evidence and classify failures at the adapter boundary. For a new model backend, reuse the protocol/tool dispatcher. Reproduce new user-visible failures in an integration scenario before adding provider-specific instructions.

The existing private code-input and download-navigation regressions remain part of browser acceptance. Runtime unit/integration results and actual pinned-Codex acceptance are reported separately from any live-model smoke test; a smoke test is not a broad reliability score.

## Verified in the local installation

On 13 October 2026:

- 3,218 tests passed across 217 affected test files, with concurrency bounded to six workers.
- Protocol, daemon, API brain and desktop service typechecks passed. Scoped Biome checks passed (one existing non-null assertion warning in a screen test).
- All 15 actual pinned Codex 0.154.0 offline probes and all 9 native confinement probes passed. The acceptance records verify against the current source. No new real-account sign-in test was run.
- Brain and desktop images built successfully. The existing desktop received the updated service bundle with a rollback copy retained; it was not replaced. The daemon was restarted and the computer resumed normally.
- The live desktop returned HTTP 200 for health and capability discovery, reporting both git and gh available.
- A single read-only smoke task through the configured OpenAI Responses-compatible model (gpt-6-luna) selected work_context and finished with accurate installed-tool facts, listed connector operations and explicit unknown CLI authentication. It made no sign-in request, connected-app call, shell command or browser navigation. This is one smoke test, not a provider-wide behavioral reliability benchmark.

The implementation is active in this development installation. This work did not publish a release or merge the surrounding uncommitted changes.

## CLI device authorization

A connector connection, a website session, and CLI authentication are independent. When a task calls for CLI access, check that CLI's status and keep its single device-login process alive while completing authorization in the visible browser. Do not ask the user to transcribe a pairing code already produced by that process. User-held authenticator, SMS and email codes still use private user input.

`browser_act` exposes `device_code` across the API, Codex and Claude Code tool adapters. It takes the currently observed protected-field reference, the exact HTTPS origin and the CLI pairing code. The shared policy classifies it as account settings and checks purpose/authorization. Before delivery, the runtime revalidates the field, origin, screen lease and backend node. Browserd independently requires device/user-code metadata; passwords and authenticator fields cannot use this path. Codes pass through the existing private input and recording fence and are not repeated in the tool result.

The GitHub regression has two native-input details: the readonly hyphen between its boxes must not count as a filled secret or a ninth editable segment, and Ctrl+A can advance focus before the first character is typed. Segmented entry starts only with empty protected fields, binds every segment before typing, omits select-all, and revalidates the same-origin POST form's sole submit control before clicking it. The last box may move focus to that bound button. A changed form, redirecting submit override, replaced node or unexpected focus stops delivery. The agent must inspect the consent result and verify CLI auth status; entering a code alone is not proof of authorization.

Non-renderable `input type="hidden"` fields carry internal form state, including pairing codes, authentication flags and tokens. All such nodes remain redacted regardless of their names, but they do not block observation of consent or reauthentication pages. Merely adding a hidden attribute, CSS or ARIA hiding to a text/password field does not qualify. Filled renderable passwords and user-held OTPs still block observation. The real Chromium fixture now follows code entry, consent, a second-factor page with retained hidden state, and private verification through to sign-in.

Browser errors now distinguish a filled protected field from an unavailable connection and from a stale/refused action, so a private-input guard does not instruct the agent to restart a healthy browser.

### Device authorization regression results

On 13 October 2026, the final browser implementation passed 1,514 tests across 81 files, plus the real Chromium segmented-code/consent integration. The broader affected suite passed 4,454 of 4,455 tests on the first run; its terminal-history timing test exceeded the five-second limit under parallel load, then the complete six-test file passed alone. Protocol, daemon, browserd and API brain typechecks passed. The 15 pinned-Codex offline probes and 9 native probes passed, and the saved acceptance evidence verifies against the final source. Those Codex probes do not exercise a real OpenAI-account login.

The live localDot run `01M4TRJB3NZRW13K2TY5DKN7T0` used its configured API model to enter a fresh GitHub CLI code through `browser_act device_code`. GitHub accepted it and the agent successfully read the real “Authorize GitHub CLI” page. After the user explicitly approved the listed OAuth scopes, run `01M4TRVZV8K0JTKGDTDD2VRP2Y` clicked consent and GitHub required a separate passkey/authenticator identity check. That exposed a second false observation block: the original hidden-state exemption covered only device-code names. The generalized non-renderable-field handling passed all 1,255 browser tests and the expanded real-Chromium flow; browserd and daemon typechecks passed. The updated browser image is installed locally. Live run `01M4TSCJYW8MGT4CFJQATFYVQD` entered a fresh CLI code, clicked the approved consent and successfully captured GitHub's real Confirm access page (`01M4TSJFAM8TZC6EWSJHFB4KB7`), where the previous runtime had blocked. Final CLI authorization still requires the user's passkey/authenticator/email identity check; OAuth consent alone is not proof of a completed login. The 15 offline and 9 native Codex probes were rerun and their saved evidence verifies against this final source.

## Manual browser control recovery

User input whose delivery receipt was lost stays fenced until the browser confirms a fresh user control grant. That grant drains previous browser actions; recovery does not replay clicks or private text, read protected page contents, reload the page, or resume the agent. The production browser adapter supplies this confirmation just like the desktop adapter, so transient transport failures cannot leave a takeover permanently unconfirmed. Confirmation is bound to the same browser instance, screen and control epoch, and cannot clear a fence after Stop or replacement. Cancelled hand-back re-establishes user ownership before allowing input again.

Regression coverage includes delayed and failed confirmations, private-text non-replay, browser replacement, Stop during recovery, and cancelled/retried hand-back.

## Blank-browser diagnosis and visible-screen verification

The 13 October 2026 run `01M4V0GXESAZTQSPNCJHT2AR54` successfully selected the web browser
and read `about:blank`, but never called `browser_navigate` before declaring the visible
browser a blocker. The browser had answered normally; the intended page had not been opened.

The shared tool guidance, switch response and capability inventory now separate browser
availability, selected screen, page inspection and target navigation. A successful blank-page
read carries a trusted navigation hint outside the untrusted page text. Only browser-owned
URLs classify startup and error pages. Navigation no longer turns unavailable, protected-input,
stale-owner or aborted reads into a loaded-page success; a settling read produces an explicitly
unverified result and a fresh-observation recovery, without replaying navigation. Confirmed
download receipts survive optional screenshot failures while cancellation remains authoritative.

Desktop Chromium binds its CDP page to the visible native window instead of selecting the
first enumerated tab. It revalidates target and window identity around operations, accommodates
bounded native-title propagation, and refuses ambiguous or changed ownership. The app's HUD
uses the selected screen's stream health while preserving parent lifecycle and containment.

Validation for these changes: 243 affected runtime tests, 169 web tests and all 16 isolated
real-Chromium integration tests passed. Protocol, daemon, desktop, brain, web and web-e2e
typechecks passed. All 15 pinned Codex offline probes and 9 native probes passed, and their
saved evidence matches the source. The real Chromium regression covers a healthy startup
blank page followed by navigation, native form input, a button click, result text and screenshot
pixels. These tests establish runtime behavior, not a guarantee that every model always makes
the right planning choice.

The rebuilt brain and desktop service, daemon and web bundle were installed locally. Live
smoke run `01M4V2633XQGVW046RWZ2J42F2`, using the configured Responses-compatible gpt-6-luna,
opened a public page, navigated to the desktop's localhost fixture, typed `screen-ready`, clicked
Apply and read `Verified: screen-ready`. The same result was independently visible in the live
computer stream. No real-account application flows were tested or claimed as verified.

## Required-input completion handoff

Run `01M4V3B3TD2AFXTCVMNYTD25TX` diagnosed a missing WorkOS Client ID in its local preview,
but skipped the requested real-data UI verification and called `done` without `ask_user`.
The result accurately described a blocker, but the runtime had no structured distinction
between finishing and needing a user-supplied configuration value.

All current model tool schemas now require an explicit `done.input_request` assessment:
null when no answer is needed, or the same validated question/form accepted by `ask_user`.
Prefer asking as soon as required input is found. A final-call form is normalized to `ask_user`
before policy, admission, timers, privacy handling and execution. It displays **Needs you**,
waits on the existing answer channel, and returns the answer without publishing `task.result`,
collecting proposed output files, or saving proposed experience. The model must continue the
remaining work and verify it before completing. Stop, pause, decline, timeout, generation
ownership and the existing private-input checks are unchanged. API coordinate conversion and
question deadlines include the nested form; Codex and Claude adapters require `final: true`
before concluding a successful completion call.

Public client identifiers and base addresses use text/url fields. For example, the
[WorkOS React SDK](https://workos.com/docs/sdks/authkit-react) requires a browser-side Client ID.
API keys and client secrets must not be collected as text or exposed from environment files.
Existing private secret delivery only supports a verified browser input; it does not write
configuration files. If secure direct configuration is unavailable, the agent explains the
manual configuration step and asks for confirmation that it is configured, then rechecks.

This is shared across providers and does not infer a form from arbitrary page or summary
text. Legacy clients may still omit the field; a model that incorrectly declares null can
still misjudge completeness. The schema, guidance and regressions address the observed failure
without claiming deterministic detection of every undeclared requirement. User-declined,
waived or timed-out work must remain explicitly unverified; it is not silently counted as a pass.

Regressions cover the visible waiting state, answer/resumption, policy refusals, malformed forms,
private-field guards, decline, timeout, Stop, coordinate conversion, long question deadlines,
and non-final completion results across API, Codex and Claude runtimes.

Local validation on 2026-10-13 passed 275 runtime/protocol tests, 165 adapter/brain tests,
and 46 shared-guidance tests, plus protocol/daemon/brain typechecks. The rebuilt brain image
and restarted daemon were exercised in recovery run `01M4V4F44Q232BTN82RB4AE0R0` for the
original unfinished audit. Its configuration recheck found the Client ID available; the
visible preview reached sign-in. The agent requested an account-email form and a private
password form, both answered through the user channel, then paused at human verification
with `waiting_user` and the visible **Your turn** handoff. It did not publish `task.result`.
The run later resumed from the handoff and ended with `reason: stopped`, without a
`task.result`. The real-data audit remains unfinished; reaching sign-in is not a passed audit.
This live run validates ordinary question/resumption and takeover behavior;
the structured `done.input_request` fallback is covered by the runtime/adapter regressions.
Pinned Codex 0.154.0 acceptance also passed all 15 offline probes and 9 native confinement
probes against the final sources; `check:codex-release` verified the resulting records.
The real-account acceptance suite was not run.


## External waiting and premature completion

The game runs `01M4V5BRM1DTGEVJXNERKTBPMF` and `01M4V5KACPNE0PJE3XMH55TA51`
called `done` while explicitly reporting that the match was unfinished and another player
needed to act. The runtime accepted the call as final. This was a model completion decision,
not an active-run idle timeout: the follow-up idle timer starts after DONE/GAVE_UP.

All current provider schemas now require `done.completion` with observed evidence for the
original requested outcome. `complete` is terminal; `waiting` is a bounded interruptible wait
followed by a nonterminal tool result; `blocked` records unfinished work. Missing user input
still takes precedence through the existing `input_request`/`ask_user` pipeline. Ordinary
opponent turns, builds, processing and timers are waiting, not completion or a permanent
blocker. Whole-game requests retain their terminal-result requirement through compaction.

Waiting normally takes 10–30 seconds (15 by default), then the agent inspects fresh state.
It requires no screenshot, file collection or file-write approval and emits no task result,
successful verification or learned experience. Stop, takeover and generation replacement
cancel it immediately; Pause and new instructions end it at the next one-second boundary.
User action and spending limits remain authoritative. The guidance avoids tight screenshot
polling. The native Codex and Claude drivers also reset their consecutive no-tool nudge count
after successful nonterminal work, while failed/refused tools do not reset it.

The runner preserves blocked/gave-up/action-limit outcomes as unfinished through idle expiry
or release. Explicit blocked results display “Couldn’t finish” in live status and replay;
a successful follow-up clears the current outcome without deleting earlier result history.
Legacy host calls that omit completion retain their old behavior. These checks do not prove
arbitrary prose: a model can still incorrectly declare `complete`, so this is not a guarantee
that every model will finish every game.

Validation: 28 completion/input-tool regressions, 141 API/Codex/Claude driver regressions,
244 runner/UI lifecycle regressions, and 55 protocol/guidance tests passed. Protocol, brain,
daemon and web typechecks passed, as did UI guard and scoped formatting checks. The brain
image and web bundle were rebuilt. All 15 pinned Codex offline and 9 native probes passed.
After every game run ended and no live/manual-control session remained, the approved restart
activated the source daemon, rebuilt brain and browser fix. Live smoke run
`01M4V735FX5M1GMQ328PGN68XV` opened the game homepage, read the visible page, used a nonterminal
completion wait, read again, and completed without joining or playing. Its first long evidence
string exposed a step-intent limit mismatch; the subsequent shorter retry passed. The handler
now clips redacted evidence to the event's 120-code-point limit, covered by 500-character
English and Chinese regressions. The refreshed 15 offline and 9 native probes passed and the source-bound records verified.
The corrected daemon was then activated while idle, followed by the supported resume route.
Final live run `01M4V7FKQJJ6WT274Z1740HFQQ` filled the ordinary room-code field with synthetic
`ABC123` without submitting, successfully read/captured it, cleared the field, completed a
long-evidence nonterminal wait, read again, and emitted one `task.result` with outcome
`complete`. The task had no failed tool calls. This validates the bounded continuation path,
not a complete real multiplayer game. The temporary activation heartbeat remains disabled;
no further automatic restart is needed.
