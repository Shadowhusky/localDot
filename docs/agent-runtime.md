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

### Repeated native input recovery

The 16 October Figma task exposed a separate native-input guard: two post-scroll captures failed,
so the guard treated their effects as unknown and then paused on the next identical scroll. Later
screenshots showed different canvas contents, but never reached that guard. The daemon itself
generated the vague “What should I change?” question alongside a separate Resume control.

The native guard now compares private, daemon-owned screen fingerprints at dispatch, including
successful later observations. A new frame ID with identical pixels is not progress. Missing
capture evidence alone never authorizes another possible side effect. The third unchanged input
is still blocked before dispatch, but returns a typed recovery result to API, Codex and Claude
Code, with the latest available screenshot and instructions to inspect and change approach.
It creates no question or takeover. Other authorized tools and changed inputs remain available.

If the model ignores two such recovery results without verified visual progress, the existing
atomic Pause machinery contains it and publishes a concrete explanation. It does not manufacture
a user decision. Explicit Resume, Stop, spending limits and permission checks remain authoritative.
The bounded counter is not semantic task-progress detection: animation can change screen pixels,
and broader task budgets and failure tracking still matter.

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


## Fixing a blocker in the conversation

When something stops dot that the user can fix inside localDot, the fix is a card in the thread, not
directions. A blocker has a typed kind (`packages/protocol/src/blockers.ts`), a `blocker.raise` event,
a card in `apps/web/src/agent/FixCards.tsx` and a `blocker.clear` event.

| Kind | Noticed from | The card | Clears on |
| --- | --- | --- | --- |
| `keys_locked` | keyd's denial or 423 while the vault is locked, a saved login or connected app failing while it is, the model's own key | Passphrase, sealed to keyd | The vault opening |
| `key` | keyd naming a key to re-enter or changed outside localDot, a service's or the model's 401 | The Keys form for that one key | The key saved and usable |
| `app` | A connected app's sign-in ending | Connect | The sign-in finishing |
| `model` | The provider refusing, not answering or out of quota | Try again, or another model | The model answering, or moving to another |
| `computer` | The computer going off or pausing under a task at work | Turn on, or Resume | The computer ready |
| `runtime` | Docker gone, with the computer or the brain | Start Docker | Docker answering |

The daemon raises a card from the failure itself. Otherwise dot calls `request_fix`, which takes a kind
and an id and no words, and the daemon checks the blocker first: the vault locked, keyd's flag on the
key or a 401 for it in this task, a sign-in seen to end, the computer off, Docker down. Anything else is
an error, so a page can't summon a card by telling dot to ask for one. A stall the brain reports is
checked the same way, against `keyd.secrets()` and the vault's health, since its word comes from a model
call's reply; keyd also removes `X-Keyd-*` from upstream replies. One thing has one card
(`blockerSubject`). A card that ended with nothing fixed may come back once, then only after a wait that
grows each time. The user's Not now holds until the owner's own message, not a guest's or a routine's.

Secrets typed into a card go from the card to keyd, sealed in the page as in Keys: they never enter the
task's log, transcript, the model's context or the daemon's log. Only the owner may answer:
`/blockers/*` and `/api/runtime/start` refuse a shared link, as `/api/keyd/unlock` does. A guest reading
the log (`/events`, `/history`, `/stream`) sees `unknown` for the key in `blocker.raise` and `key.use`.

A card's sentences are localDot's, chosen by kind. Three things on it are not, and are set apart: a key's
id, in a code style after "Saved as", which dot may have chosen when it asked for the key; a provider's
refusal, quoted and marked as the provider's; and an app's name and host, from its saved configuration.
A key's label stays off the card, since dot can write that. A card dot asked for says so beside the
localDot mark.

Keeping a form of dot's from passing for a card is a mitigation, not a guarantee.
`apps/daemon/src/agent/tools/card-words.ts` normalises `ask_user`'s strings, `request_takeover`'s note
and what `credentials` `request` would show (NFKC, format characters, marks on Latin letters, dashes,
digits written for letters, and common Cyrillic, Greek, Armenian and Latin look-alikes) and reads them
for words about unlocking localDot's keys or a secret named beside a vault, in English, Chinese,
Spanish and French. Those get the real card while the vault is locked and a refusal otherwise, and a
key request named like localDot or its key service is refused. A paraphrase ("the phrase you chose
when you set up this app"), another language or a picture of the words gets past this. What holds
regardless: the passphrase field is only ever on localDot's card; a form of dot's where the user can
type, including a request for a service key and a choice with its own-words row, says in fixed words
that localDot never asks for its passphrase there; and a plain answer that names a secret is refused,
in a field's id, label or hint, in a choice, or in a question with no field or plain options, with or
without a verb ("Password for example.com?"). That is a word list too, so a form that gets past it
does land its answer in the log and in dot's context. A key request in a task that has ever read
outside words, whatever the user has said since, loses dot's description and needs an OK before a key
can go to a place no saved key goes to; that OK covers the one request and offers no "For this task".
A lone confirm while a card is up is refused, except the brain's own guard, told by its call and its
fixed words.

A task carries on by itself only when the fix came through its own card, on any device: the card tells
the daemon (`/blockers/:id/use`, owner only, holding nothing typed) as the user starts the fix. That
counts for five minutes, and the card takes it back (`DELETE` on the same path) when the unlock or the
key's save fails or the app's sign-in is given up. It holds for tasks that have read web pages too. Fixed any other way, such as from
Keys or from another conversation's card, the card still closes and leaves its line, but nothing restarts:
dot hears with the next message, a stalled task or a `request_fix` call waits with `fixed elsewhere`, and
Continue or a message moves it on. This binds what a task does when it is stopped. A task still running
can retry on its own and find the keys open. A task that ended blocked or gave up gets its ordinary idle
time and no more; one that ended its turn on a card waits up to four hours for it. A call that goes through
closes a card as `worked`, which doesn't claim the user did anything. A message moves on from a card as
from any other wait (see "Messages while dot waits on the user"). A card still open when its task ends
reads as history. `keys.lock` from before all this still loads, as the same history.

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

## Messages during a command

Comparable agents hand a message over at the next tool boundary and let a long command go to the
background. In localDot a message sent while dot works is a steer (the default: Enter or Send, or
Steer now on a queued one) or a follow-up queued for after the task (Alt+Enter, or Send after this
task). Voice messages are still queued. The model hears a steer at its next inbox fetch, which a
running tool holds back.

- A pure wait ends as soon as a steer arrives, and the model is told: `done` waiting, a `computer`
  wait, a command's opening `sleep`. A queued follow-up also ends a wait of 5 seconds or more,
  and reaches the model as a steer, told to finish what it was waiting for first unless the message
  says otherwise. A shorter wait or a command leaves it queued, as does a wait when the message is
  for another model.
- Any other `shell` command is not stopped. If it is still running 3 seconds after a steer, its call
  answers with the output so far and says the command goes on. It keeps its own tool lease, so Stop,
  a takeover and a retired brain end it as they end any command, and cleanup waits for it. When it
  ends, the model hears the result the call would have given through its inbox, with the middle of
  long output cut.
- The receipts are unchanged. `DesktopdTools.shell` still decides how a command ended from its
  terminal line or a strict receipt, an unproved end still holds the computer, and `tool.end` and
  `step.end` are written only then. Until then the step shows as running and `done` refuses to
  finish the task. A command's own timeout (600 seconds at most) bounds all of this.
- A message says what happened to it: "dot stopped waiting to read this" or "dot left its command
  running to read this".
- A message for another model than the one at work doesn't steer. Moving dot retires its brain, and
  a retired brain ends what it has running, so the composer queues the message and says "Runs on
  <model> after this task", and the daemon queues a steer that asks for another model all the same.
  Switch now on such a message is the one way to move dot at once. It ends a running command, so it
  takes a second press that says so. A message another task must take over offers neither.
- Stop gives back a steer as it does any message: while dot has said nothing and started no call
  since it arrived, whatever was already running. Words or a call in flight as it lands count as
  acting on it, since nothing says when each model path read it, so it then stays in the thread.

Delegated agents don't hear the user, so their commands and waits run their course. A batch of
commands answers only once each has ended or gone to the background.

## Messages while dot waits on the user

The message box works during any wait of dot's. It sends straight away, except while a field for a
secret is up (a card that takes one, a question with a password, code or key): then Enter and Send only
bring up a step that says "Send as a message — dot will read this", since the words may be that secret.
This holds whatever else dot is waiting on beside it: a plain question or an approval next to the Unlock
card still holds the box. While a field for a secret is up, long text isn't moved into a file (which
would upload it at once), and an attached file is held like words. A card or form takes the keys from
an empty box, unless a key was pressed in the last three seconds; a key's field never takes them by
itself, since what is typed there is saved over the key. Over a saved key, a model key or bearer token
with spaces, a value that reads as a sentence, or a model key that doesn't look like its provider's is
refused. No draft is kept during such a wait, one kept from before it is cleared, and whatever is typed
during it is cleared when it ends. A message the owner sends
moves on from the wait, on the daemon, whichever client sent it and whichever harness runs the
task: the tool call blocked on the wait returns, and the message reaches dot as a steer, through the
same inbox as any other. It is never taken for the wait's answer, and it isn't queued behind it.

- A question (`ask.answer` with `by: "message"`) closes with no fields, however private: nothing is
  typed or stored. dot hears that the question is closed and to ask again only if it still needs the
  answer. A saved login's tap and a key's or an app's card close the same way.
- A step's approval (`approval.resolve` with `decision: "deny"`, `by: "message"`) counts as not
  given. The step doesn't run, no Always allow is saved, and dot hears that a new approval is needed
  if it still wants the step. A late answer to either is refused with a 409, as for any closed card.
- dot's hand-over keeps the older rule that a message hands the computer back, and says so
  (`takeover.end` with `movedOn`). dot hears that the step may not be done. The computer the user
  took themselves stays theirs: a phone's toolbar has no message field while they hold it, and a
  message from elsewhere hands it back, as it always has.
- A card that fixes a blocker closes as not done (`blocker.clear` with `moved_on`), keeping nothing
  that was typed into it: `AgentSession.moveOn` is the one thing that ends dot's wait on it. A fix
  that comes later clears nothing and resumes nothing. A stalled model takes the message as its way
  on, and a new card comes up if it stalls again.
- A connection's card isn't a wait of dot's, so it stays up. A shared link's guest moves on from
  nothing: what the owner was asked stays theirs to decide.
- A message for another model reaches dot at once when moving dot ends nothing. Otherwise (a model
  this task can't run, or commands or delegated agents still running) it waits for the task as
  usual, the wait still ends, and dot hears to finish.

Each harness gets the same reply and the same inbox item: the built-in brain reads the message on its
next request, Claude Code takes it from its input stream, and Codex from `turn/steer`.

## Carrying on after a restart

| What restarted | What the model keeps |
| --- | --- |
| A page refresh | Nothing restarts. A run belongs to the daemon, not to the page watching it. |
| The API brain's process | Everything: it reads its whole stored transcript back, and is told so. |
| A Claude Code or Codex run | Their conversations live in memory (`persistSession: false`, `ephemeral: true`), so every new run starts from a record: task, plan, the user's messages, its own messages and its newest steps with the end of their output. A new run starts after any follow-up to a finished turn, a hand-back, Resume or a retried model call, none of which is a daemon restart. |
| The daemon | The task ends, and Continue starts the conversation's next task. It gets what was said and a short checkpoint, not the old transcript. |

A new run's prompt says the record is routine and nothing was lost. It used to open "localDot
restarted you, so the earlier conversation is gone", which models repeated to users as "my earlier
notes were lost when I restarted". Resuming native threads for real would need persisted threads
and new Codex acceptance, and has not been done.

### Task state and plan synchronization

The plan is a checklist, not an independent task lifecycle. Activity and expanded chat
steps derive its live, waiting, paused, finished or interrupted presentation from the
same task model. Unfinished checklist entries stop animating when a task finishes;
their recorded statuses remain intact rather than inventing completed work. Replay
uses the state at the selected time.

Daemon-owned questions, approvals, safety pauses and control holds take precedence
over buffered model progress notifications. Final text alone does not release a task.
A conversation change after a recorded result can wait up to ten seconds for normal
caller retirement; it never stops active work. Missing stream events trigger replay
from the last accepted sequence with backoff, and terminal snapshot reconciliation
continues after a failed request instead of freezing the last running status.

### Cleanup of task-created files

The ordinary Auto and Full modes no longer ask for destructive-action approval when
removing an unchanged regular file whose creation localDot observed in the current task.
A daemon-owned, in-memory ledger records absence before a successful file write or a
recognized shell writer, then the resulting inode, timestamps, size and content digest.
Overwriting a pre-existing file never makes it task-owned. A user edit, replaced file,
unavailable probe or restarted daemon leaves cleanup under the normal approval rules.

The initial shell coverage includes leading heredoc redirects and ImageMagick/ffmpeg
outputs, including the screenshot and temporary HTML-page cleanup reported on 13 October.
The exception accepts a literal leading `rm` (optionally after `cd ... &&`), with no
recursion, globs, substitutions, traversal, symlinks or special files. Remaining commands
still pass through normal safety classification; custom policies remain unchanged.

Execution rechecks the files and moves them into the computer's
`~/.local/share/localdot/recovered-files/<task>/<operation>/`, with a manifest mapping
original names to saved files. The tool output reports recovery paths. Recovery files
are not automatically purged. Cross-filesystem moves fail without deleting the source.
Files larger than 16 MiB and unrecognized writers retain normal confirmation behavior.
The ledger is bounded to 256 files per task and cleanup to 32 files per command.

Validation: 1,209 safety/tool tests passed, including real filesystem and dispatcher
regressions for owned creation, edits, pre-existing data, changed targets, cross-session
ownership, symlinks, compound destructive commands and byte-preserving recovery. A
separate disposable-file check passed inside the installed Linux desktop.

## Side questions

`/btw` and the palette's **Ask a side question** run a read-only side agent beside the task
(`apps/daemon/src/agent/side/`). The route is `POST /api/agent/sessions/<id>/side-question`, which
answers refusals with their own status and otherwise streams NDJSON: `{"progress"}` lines, a
`{"handover","partial"}` line when another model takes over, then the answer, or `{"problem"}` if it
failed after starting. Shared links can't reach it.

**What it can read** is one allowlist, `SIDE_TOOL_NAMES`: `search_log` and `read_log` (the task's
log with its tool output, thinking and steps, but no typed text, key use, approval values, or
messages the user took back), `look_at_screen`, `list_files` and `read_file` (`DesktopdTools`'s read
paths, bounded, never a shell), `task_files` (what dot handed over), `recall`, `web_search`,
`web_fetch`, and `finish`. Any other name is refused without reaching anything. Each read asks the
same question as dot's (`runsUnasked`), and is refused if the user's settings would have dot ask,
since a side question has nobody to ask. Everything read is redacted, then wrapped as untrusted.

**It never disturbs the task.** It holds no lease or turn on the computer and no step of the task's
queue, writes nothing to the task's log, transcript or taint, and dot never hears of it. Its cost is
on a keyd listener of its own (`QuickModel.sideListener`), which counts against the day's limit and
never the task's budget. What it spent is in `sessions/<id>/side-spend.jsonl`: amounts and models,
no question or answer.

**The screen** is the frames dot already looked at, read from the frame store: other tasks' windows
and masked fields are covered in them exactly as dot saw them. One thing goes beyond that:
when a live task's screen is the desktop, dot's newest frame is over 15 seconds old, nobody is acting
on the computer and the user doesn't hold it, `freshDesktopLook` takes a new look, covering other
tasks' windows and windows too new to tell whose they are. It isn't saved. The cost is that desktopd
keeps only its newest capture for zooming, so a zoom dot makes on an older frame enlarges the stored
frame instead, as it does whenever another look has come since. The web browser gets no new look:
its observation needs a permit from dot's turn and refuses a second one at once, which could fail
dot's own, so there the answer is the frame dot last took and says how old it is.

**Models.** The fast model goes first, then the main one. A model that fails, is refused or can't use
tools leaves the question to the next, and a model without images isn't offered the screen. `finish`
reports `found`, `partial` or `not_found`, and that field alone decides what happens next, never the
words of the answer. Anything short of `found` goes to the main model by itself, with what the first
model found and what it checked. If there's no main model to go to, or no room left, the question
ends with what it found and says so.

Only the models the user chose for the task answer: its main model and, where the task uses them, its
fast and local models, as its next message would run on them. The user already showed the task to
each, so going from one to another takes nothing anywhere new. No other model, even one set up in
Settings, is asked: that would take the task's record to a provider, or from a local model to the
cloud, without the user choosing it. A task none of whose models can answer says why instead.

- **Claude Code:** a process of its own with no built-in tools, whose MCP server serves only the side
  tools (`claude-code/side.ts`). A tool outside them is refused, and using one ends that model's go.
- **ChatGPT plan:** never asked. Every Codex turn is a fresh process that holds the account's
  credentials, so one here could keep dot's next turn waiting. A ChatGPT task has no other model of
  its own, so it says it can't take a side question.

**Limits**, for both models together (`SIDE_LIMITS`): 120 seconds, 75 of them for any one model, 8
reads per model, and $0.25, or 300,000 tokens on a plan, where no money is counted. keyd holds the
money limit too: each model's listener gets only what is left, and when it closes, what keyd counted
on it replaces the replies' own count if that is more, which covers a reply that gave no usage and a
call cut short. Near a limit a model is offered only `finish`, so it ends by saying what it found.

**Web.** Nothing the side agent reads leaves it, since nobody can be asked here, as dot's purpose check
can ask:

- `web_fetch` opens only an address in the user's question or in this question's own search results,
  never one a page named or the model composed.
- A `web_search` is refused when it carries what the question was given or read: the record and every
  tool result are kept as `TaskTaint` fingerprints, never as text, and a query is checked against them
  once the words of the user's own question are taken out. So a user can have something searched by
  writing it in their question. A query the redactor changes isn't sent either.
- A search's `!bang` and `\` commands are taken out, and every search, dot's too, stays on its engine's
  site (`WebGet.within`): a redirect elsewhere isn't followed, and a page from elsewhere gives no
  results, nor addresses `web_fetch` may open.
- In the answer, only those same addresses are links. Any other shows as text with its site, as its
  address may carry what was read.

Both tools go through the same keyd web cell as dot's, so the same egress rules hold.

**The record** it opens with is what was said in the task and its plan, without messages the user
took back, inside `<untrusted>` blocks: a line in it can't end the block or ask a question of its own.
