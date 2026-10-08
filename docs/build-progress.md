## October 8 — durable native recovery and signed Keychain upgrade regression

The native supervisor now records exact resource ownership before spawning a task and holds a
kernel lease on the permanent profiles directory. Only confirmed process-group retirement can
atomically publish the durable retired receipt. Recovery acquires the same lease under the
existing installer/stopped-service leases; a surviving daemon or helper excludes cleanup.
Actual parent SIGKILL tests recover the recorded profile/work/bridge after task closure and
preserve an unrelated credential fixture. Resource replacement and supervisor death retain
resources for inspection. The task inherits none of the control/lease descriptors: an actual
descriptor test caught the previous helper leaking its original fd3/fd4, now marked CLOEXEC
along with their duplicates. Bypassing the recovery lease makes the live-owner test fail.

All 159 focused Node cases across seven files and 52 Go cases across three packages pass.
CLI/harness types, ten-file lint, Go vet and CGO-disabled refusal checks pass. Runtime v78 has
87 verified files / 8,555,076 bytes and passes four isolated help/version probes without writing
to the isolated home. This is controlled local acceptance, not an installed release walkthrough.

Keychain was observed unlocked at 00:23 UTC. Current v78 helper/test executables were signed
with Developer ID team 87FD3FSZBG. The strict requirement check passes, a tampered copy is rejected,
and live fake-item short/max-size/update/delete tests pass. A new test across different signed
executable paths then exposed a real upgrade failure: the stored-policy check compared descriptive
paths, not code-signing requirements. The two synthetic items from that failure were removed;
metadata-only follow-up confirms both absent. No personal credentials were read or changed.

The v79 author correction inspects the actual stored signing requirement using the public CSSM
ACL representation, accepting only the pinned identifier, Apple certificate policy and Team ID.
It rejects wildcard/unknown grants and treats empty authorization sets as ANY. Descriptive paths
and legacy hashes may change only when the modern requirement exactly matches. Twenty native
policy scenarios include a Security.framework round-trip without Keychain item access. Both a
missing requirement check and an incorrect one-sided byte comparison are detected by mutations.
The full Go race suite passes 691 cases across 19 packages (four live opt-ins skipped); vet passes.
An AddressSanitizer attempt stalled in sanitizer initialization before main and was terminated;
the ordinary native fixture passes, but sanitizer validation is not claimed.

The v79 signing attempt hit its 45-second limit; fresh host status at 00:32 UTC confirms login
Keychain locked again. The corrected helper remains unsigned, and its live signed upgrade/
rollback test is still pending. The signed v78 helper predates the upgrade correction and is
historical test evidence, not a shipping candidate. Independent FULL review, legacy ACL migration,
installed app acceptance, release provenance/notarization, M6 playback and M8 remain. No new agent,
accepted integration, usage check, publication, or installed service was performed.

## October 8 — packaged native tasks now have an independent supervisor

The packaged Codex launcher now uses the installed release's fixed keyd helper through a private
`native-run` protocol. It passes the verified sandbox request on a bounded control stream and
keeps that stream open as the daemon lifetime. Task stdio and lifecycle events remain separate.
The helper survives daemon death, owns the task's process group, escalates TERM to KILL, and
retains the unreaped leader until kernel observations confirm no live group members. The Node
adapter requires the retirement event, clean helper exit and closed pipes before authorizing
cleanup. Missing packaged helpers refuse launch; development fixtures retain their existing
backend. No PID recovered from a file is used to signal a process.

The actual Node transport exposed a separate diagnostic bug: libuv supplies anonymous Unix
socketpairs, while the credential canary accepted only FIFO pipes. Both paths now validate
anonymous local streams and reject regular files, named sockets, named FIFOs and network sockets.
A final-exit regression was also corrected: macOS can return EPERM for a group containing only
unreaped zombies. That result is accepted only after an exited/quiet observation, with another
observation required before reaping; permission errors on a live group still report failure.

All102 focused Node checks across five files and41 Go cases across three packages pass on the
host. Actual process tests cover natural exit, ignored termination, an exited leader with a live
grandchild, uncertainty, actual Node socketpairs, and daemon SIGKILL. The new packaged launcher
route and existing bridge/retirement cases pass. Sandbox-only runs could not bind fixture Unix
sockets; host runs use temporary homes and an in-memory vault. Harness types, six-file lint and
Go vet pass. Removing parent-EOF containment makes the real crash test fail; restoring the old
FIFO-only canary restriction also fails its actual Node transport test.

Runtime v77 contains87 verified files /8,553,018 bytes with verified pinned sandbox contents;
four isolated CLI/sandbox help/version probes pass with an unchanged home. The current helper
build is unsigned. The older signed helper is stale and cannot be paired with this runtime.
This establishes process containment, not complete post-crash recovery: the supervisor still
needs durable resource ownership/retirement records and a recovery lifetime lease. Independent
FULL review, corrected signing/live Keychain, installed acceptance, release provenance/notarization,
M6 playback and M8 remain. No installed service, credentials, new signing, usage checks, agents,
accepted integration or publication were performed.

## October 8 — pre-lock bootstrap recovery has a kernel lifetime

Bootstrap acquisition now holds a separate kernel flock before downloading payload bytes. Fixed
code in the protected macOS system Perl acquires it through an inherited descriptor; the parent
retains that lock after interpreter exit. This adds an explicit OS-tool prerequisite, documented
in the release guide. The command uses a clean environment and runs no downloaded package code.
The global installation lock still uses the freshly authenticated release helper.

Per-run ownership receipts and lock files live outside the temporary payload. They record exact
parent, record-area, record-directory, lock-file and payload identities before acquisition writes.
After fresh helper authentication and acquisition of the global install mutex, recovery attempts
each recorded lease through keyd. It skips live bootstraps and removes only retired, matching
payloads, synchronizing their removal before retiring the receipt. Interrupted partial removal
can be retried. Changed identities, corrupt records and unknown allocations grant no deletion
authority. A crash before ownership persistence can leave an unrecorded empty allocation, which
is deliberately retained for inspection rather than inferred from its name or age.

All 71 focused checks across seven files pass: 38 bootstrap/lock, 31 related assembly/preparation,
and two native-child lifetime cases. Real concurrent child processes prove the OS-interpreter and
keyd locks interoperate and survive interpreter exit; SIGKILL permits only the dead writer's
recorded payload to be recovered. An isolated mutant bypassing recovery's lease acquisition fails
by deleting a live writer's payload. Five-file lint and CLI types pass. Initial bootstrap checks
needed expected-layout updates for the retained empty bootstrap-leases directory.

Runtime v76 contains 87 verified files / 8,547,401 bytes and verified upstream sandbox contents.
Four isolated CLI/sandbox help/version checks pass with an unchanged home. The earlier v75 app
archive uses runtime v74; it is historical packaging evidence, not the current candidate archive.
Independent FULL review, corrected signing/live Keychain, active native-task orphan recovery,
installed acceptance, release provenance/notarization, M6 native playback and M8 remain. No usage
checks, new agents, user services, credentials, signing, accepted integration or publication.

## October 8 — repeatable app archive command

`pnpm build:app-package <input.json> <new-output-directory>` now builds and audits the app archive
without a one-off script. It uses the production helper signature check, bounded build inputs,
offline npm with isolated configuration and disabled hooks, and compares every actual archive
member's path/size/hash to the builder inventory. It verifies archive integrity before writing
the final receipt outside the payload. Existing destinations are preserved; failures have no
success receipt. The release packaging guide documents exact inputs and remaining release gates.

All 32 package/command checks and 38 existing inventory/archive checks pass; four-file lint and
CLI types pass. The broader suite exposed an old archive fixture missing the now-required canary
files; only that fixture was updated. The actual command, with production Developer ID verification
outside the sandbox, produces a 91-file, 2,358,362-byte archive from runtime v74. All extracted file
hashes match and four CLI/sandbox help/version checks pass outside the checkout with an unchanged
isolated home. No runtime production code changed, so the existing v74 runtime remains current.

This is a packaging rehearsal: helper v3 predates the Keychain correction, and commit/image pins
are synthetic. The command does not establish source or publication provenance, image availability,
notarization or installed readiness. Corrected signing/live Keychain, independent review, remaining
recovery, installed acceptance, M6 playback and M8 remain. No credentials, new signing operation,
installed service, usage check, agent, accepted integration or publication was performed.

## October 8 — interrupted assembly recovery is connected

Installation now records the exact assembly parent/directory identity, including birth time,
before writing payload bytes. Downloads, extraction, trust-worker caches and native preparation
stay inside this recorded tree; durable trust floors stay in state. The next preparation recovers
that tree under the live installation lock before creating a new candidate. Native children keep
the same lock until exit. Cleanup synchronizes removal before clearing the record and refuses
changed identities, links, malformed records, expired scope or a different installation scope.
It never adopts unrecorded folders or removes installed releases, bootstrap helpers or user data.

All149 checks in11 files pass, including20 filesystem recovery cases and an actual installer-
crash/native-child/recovery sequence. Removing the directory-identity check causes six targeted
failures. Sixteen-file lint and CLI types pass. Runtime v74 contains87 verified files/8,542,613
bytes with verified sandbox upstream; four isolated CLI/sandbox help/version probes pass.
Bootstrap's own trust cache also stays under its owned bootstrap tree, but recovery of pre-lock
bootstrap leftovers and active agent native-process orphans remains separate work. No installed
services, Keychain/signing retry, new agents, usage checks, accepted integration or publication.
Independent FULL review, corrected signed/live Keychain acceptance, installed walkthrough, M6
native playback and M8 remain. The optional dot preview remains the existing standalone preview.

## October 7 — native preparation survives installer crashes safely

The bootstrap lock callback now supplies a scoped inheritance capability. Production native
dependency preparation passes it to its health-check child, retaining the same kernel mutex after
installer death. The capability expires before the parent's descriptor closes. The child arms
an independent15-second watchdog thread before loading native code; it can terminate a blocked
main thread even if the installer is gone. Ordinary completion terminates the watchdog.

All53 focused checks pass, including two actual parent-crash cases: a live child excludes another
installer, and a synchronously stuck child self-terminates before the lock becomes reusable. The
same crash test catches a mutant with descriptor inheritance removed (a competing install enters).
Final PID-guard fixture cleanup passes both crash checks again; nine-file lint and CLI types pass.
The real Sharp0.35.5/libvips8.18.7 probe also passes under the inherited kernel lock, with all125
native files unchanged before/after. Test helpers use only install-lock, no service or vault.

Refreshed runtime v73b verifies87 files/8,539,895 bytes and the pinned sandbox archive. Four CLI/
sandbox help/version probes pass outside checkout with an unchanged isolated home. This closes a
preparation overlap/lifetime gap, not automatic assembly/bootstrap scratch or active-task orphan
recovery. Independent FULL review, corrected live signing/Keychain and installed acceptance remain.
The last observed login Keychain status was locked; no signing retry, credentials, usage checks,
accepted checkout edits, agents, publication or new visual milestone occurred.

## October 7 — complete app package rehearsal and confirmed locked Keychain

The app package builder now joins the verified runtime payload to installer metadata. It checks
the complete runtime inventory and native lock, verifies the signed helper using the compiled
Apple identity, adds release.json and legal/use documentation, and runs package hygiene plus the
staged installer verifier. It requires fresh output and supplies no publication or install trust.
Twenty app-package cases and eight helper-package cases pass; the two new files pass lint.

The actual v71 runtime produces a91-file offline npm archive (2,357,281 bytes). Every archive file
hash matches the build inventory, and help/version run outside the checkout with an unchanged
isolated home. Real Developer ID verification passed. This rehearsal deliberately uses synthetic
commit/image publication metadata and the previously signed helper that predates the Keychain
correction: it is NOT a release or an installed acceptance pass. The first packing attempt failed
because npm disallows one path for both user/global config; separate empty config paths fix it.

Read-only SecKeychainGetStatus returned2: login Keychain locked, readable, not writable. No item
values or private keys were read/exported. User unlock requested before retrying corrected signing.
The Tron temporary app found locally is ad-hoc signed with no team and supplies no signing fix.
The reviewed standalone volume-dot preview is restored at127.0.0.1:4882 (HTTP200); still optional
and not integrated. Independent review, corrected live Keychain/signing, recovery, installed
onboarding/task/Stop/restart, actual release provenance/images/notarization, M6 and M8 remain.

## October 7 — browser fault acceptance and Keychain diagnosis

M7 real desktop/browser fixture v24 passes31 native checks and four UI checks, with no UI
console/network/external errors. Upload cases prove partial-file cleanup, lost committed-reply
uncertainty without resend, retained bytes for an already-started page reader after cancellation,
and Stop/Resume cleanup. The fixture now wires the production safety controller: a third identical
picker click pauses before dispatch and requires explicit synthetic-user Resume. Production repeat
protection is unchanged. V22 failed on missing fixture wiring; v23 hit a manual-click timeout;
its unchanged retry v24 passes. All20 owned resources and the image were removed. This is M7
source with synthetic local keyd/provider policy, not installed M9 acceptance. The Watch screenshot
reached approved Telegram8062952227 as12145.

Runtime v71 verifies the actual lock-pinned sandbox archive and47 upstream files after the
seven-file/27-hunk patch. Its87 payload files,42 notices and four isolated help/version smokes pass.
The previous upstream download approval failure no longer blocks this evidence.

Pre-correction credential helper v3 passed Developer ID signing, production signature verification,
modified-binary rejection and packaging. Signed trace-v2 reproduced the Keychain failure: creation
and stored ACL checks succeed, but reapplying that ACL on read stalls. The author correction first
verifies stored restricted access, migrating only nonmatching policy and rechecking before values.
All17 Go packages pass races (516 top-level tests; three live opt-ins skipped). Full vet passes
after two test-only keyed-literal fixes. Live correction acceptance is NOT proven: corrected
diagnostic signing stalled in macOS SecurityServer getAcl over25minutes; that exact signer was
stopped. Both fake items were removed and metadata-only checks confirm absence. User Keychain
authorization remains pending. Signed helper v3 predates the correction and needs rebuilding.

Independent FULL review, ACL migration/update and corrected live/signing acceptance, installed
onboarding/task/Stop/restart, orphan/preparation recovery, release provenance/notarization, M6 and
M8 remain. No usage checks, accepted checkout edits, user install, new agents or publication.

## October 7 — connected launcher retirement and verified compiled CLI

The launcher now captures native resource identities before spawn, publishes a retirement receipt
only after startup and actual process-group/pipes closure, and preserves it across profile/work
cleanup. Task launches bind the original endpoint close method and await bridge cleanup before
clearing the receipt. A bridge already removed by its own owner is accepted only against the
pre-spawn capture; replacements remain errors. Normal completion syncs all resource removals,
then removes and syncs the receipt. Failed publication/cleanup keeps shutdown unconfirmed.

195 focused cases pass against this candidate's workspace sources, including actual temporary
Unix socket fixtures for early, delayed and failed bridge cleanup. Native processes are mocked.
CLI, harness and daemon types pass with the runtime builder's workspace mappings. The isolated
draft shares node_modules links with its older base; its ordinary daemon typecheck initially
read the old LaunchInput. Explicit candidate validation configs avoid changing those shared links.

Automatic approval succeeded for the local socket and HTTP fixtures. All 15 compiled CLI cases
now pass, including the four previously blocked sign-in/Stop cases. Those fixtures needed their
temporary home canonicalized and a valid-length fake credential; malformed stored authority is
also explicitly tested to produce no request. Seven-file lint passes.

The refreshed runtime v70 contains 87 verified files (8,538,979 bytes), 42 dependency notices and
692 web modules. Build inputs contain the connected launcher/writer and recovery reader. CLI and
sandbox help/version commands pass outside the checkout in an isolated unchanged home. No real
Codex process, provider, Keychain operation, user service or installation was exercised. Active
orphans without retirement proof and preparation-child recovery remain unresolved. Independent
FULL review, signed/native/Docker/upstream acceptance, M6/M7 and M8 remain; no new UI milestone.

## October 7 — recovery of recorded retired native resources

The installed service shutdown path and stopped-service lease wrapper now recover exact native
resources described by a valid retirement receipt before asserting that activity is empty. Both
service leases and the installation mutex remain required. Container containment runs first on
shutdown; service absence is rechecked before native recovery. Other lease rechecks stay read-only.

Recovery bounds directory inventories and receipt bytes, uses nofollow file reads, validates all
parents/resources and duplicate claims before deleting anything, and rejects incomplete records,
unknown leftovers, links and replacements. Resource namespace changes are synced before the
receipt is removed; interrupted cleanup can retry already-absent resources. Credentials and the
user's Codex home are not read. Active or unrecorded orphans remain unproved.

104 tests in five files pass, with 37 new recovery cases and two new service-ordering cases. A fresh
Node process recovers a persisted fixture; the service lifecycle test also recovers a partially
cleaned fixture while holding real installation and service locks. Launchd/Docker effects in that
test are mocked. CLI types and five-file lint pass. No actual Codex, provider, Keychain, user service
or installed trial ran. The launcher's writer is still disconnected pending pre-spawn identity
capture and MCP lifetime coordination, so this is not end-to-end automatic recovery. Runtime v67
remains the latest assembled payload; independent FULL review and installed acceptance remain.

## October 7 — protected native retirement record primitive

Added an internal writer for a bounded, private retirement receipt outside native work and bridge
directories. It awaits the supplied retirement promise, checks opaque directory ownership before
and after asynchronous identity reads, records parent/resource device, inode and birth time, and
persists an exclusive file before publishing and syncing its namespace. Failed retirement writes
nothing; uncertain persistence keeps resources and evidence. No PID lookup, signalling or cleanup
is introduced.

98 related tests across four files pass, including 20 new writer cases: pending/rejected retirement,
forged or replaced resources, replacement during identity capture/publication, interrupted writes,
file/parent sync failures, strict record parsing and handle closure. Harness types and two-file
lint pass. These checks use private temporary directories and injected filesystem failures.

This primitive is not wired into the launcher or recovery. Integration must coordinate the
separately owned MCP bridge, whose cleanup can start before native retirement completes, and add
a bounded reader plus exact-resource recovery under stopped-service leases. Active orphans remain
unproved. The existing read-only retirement guard stays intact. Runtime payload v67 remains the
latest assembled artifact; this unused module is not in it. No installed trial or visual milestone.

## October 7 — refreshed complete runtime build

Rebuilt the CLI, daemon, verification worker, sandbox wrapper, web UI and packaged diagnostic
assets together from AUTHOR-v66. The new local payload has 87 files (8,528,703 bytes), 42 dependency
notices and 692 web modules. Every listed file's size/hash matches, no unlisted files are present,
and the build metadata includes the latest host-command, promotion and native durability sources.
Vite still warns about chunks exceeding 500KiB; no build error occurred.

Ten compiled offline CLI tests pass; four previously blocked HTTP cases remain skipped. Both CLI
and sandbox wrapper help/version commands pass from an isolated directory outside the checkout
without creating installation files. No daemon, installed service, sandbox task, Docker, provider
or Keychain service was started. This refreshes the assembled runtime evidence formerly recorded
at v12; it does not authenticate upstream archives, perform a clean dependency install, sign the
current helper, notarize or publish a release. Independent review, native/preparation recovery and
installed first-task/Stop/restart acceptance remain open. No visual milestone changed.

## October 7 — prerequisite subprocess retirement

The installer now owns the fixed macOS-version and Docker-context helper processes until actual
child close. Cancellation, the 2.5-second deadline, output overflow and stream errors terminate
only the current child and wait for close before returning. Exit/EOF alone cannot release the
probe. Combined output is bounded, stdout decoding is strict UTF-8, and failures omit subprocess
details. Conventional Docker socket fallback remains limited to a genuine missing Docker CLI;
remote/invalid contexts and cancellation cannot silently select another engine.

78 focused cases across five files pass; the 20 subprocess cases pass again after a lint-driven
equivalent control-character check change. CLI types and four-file lint pass. Legacy Docker probe
fixtures now use readable response streams and actual request-close events. Process and HTTP
effects are mocked; filesystem preflight fixtures use temporary directories. No live command,
listener, Docker, provider, Keychain or installed acceptance ran. Native orphan retirement still
requires evidence beyond directory presence or remembered PIDs; its guard remains unchanged.

## October 7 — native namespace durability

Managed native cleanup now fsyncs its activity root, Codex root and installation home before
reporting completion, including retries after a missing-path acknowledgement. It rejects replaced
parents and unexpected reappearing paths. This keeps normal confirmed retirement's directory
removals durable without interpreting or deleting unknown orphan resources.

Native binary installation syncs final executable permissions and staging directory entries before
rename, then flushes the managed parent hierarchy. A failed post-rename flush retains the installed
inode and reports storage failure. A later explicit installation attempt rehashes the existing
binaries, flushes them and their namespace, and reports readiness only after that succeeds; it does
not redownload or replace them. Cancellation before rename publishes nothing; after rename it
finishes persistence and preserves the published directory.

106 real-filesystem/offline installer/retirement cases and five selected launcher cases pass.
Harness/CLI types and four-file lint pass. Installer bytes and transports are inert fixtures;
launcher processes are mocked. No network, listener, Docker, native sandbox, Keychain or provider
ran. Actual crash/power-loss acceptance, orphan process recovery and independent FULL review remain
open. This is an author checkpoint, not a playable installed app.

## October 7 — interrupted release-copy recovery

Release promotion now journals its temporary copy's exact parent and directory identities before
copying payload bytes. The next locked promotion recovers only that recorded copy. Partial or
completed removals are repeatable; if the copy was already renamed into a release, recovery
clears its record without touching the published destination. Replaced directories, links, unsafe
permissions or corrupt ownership records refuse cleanup. Old unrecorded directories are retained.
A crash before journal publication can leave an empty directory, but no unrecorded payload copy.

67 focused tests across four files pass, including real filesystem recovery after a separate
process exits without disposal, interrupted journal publication, interrupted anchor publication,
selection and preparation orchestration. CLI types and four-file lint pass. Release signatures
remain mocked in these fixtures; no network, Docker, provider, Keychain or installation ran.
Independent FULL review and live installed acceptance remain pending. Assembly, bootstrap and
native-task orphan recovery require separate lifetime handling; this does not claim those complete.

## October 7 — development doctor network ownership

The development doctor's age/prefix sweep and deletion by network name are removed. Each new
empty probe carries a random per-invocation label. Cleanup requires the same engine, exact name,
full immutable ID, matching label, bridge driver and zero endpoints, then deletes only that ID
and verifies both ID/name absence. A lost create response can only recover the exact labeled
probe; a lost delete response needs fresh absence. Foreign/replaced/attached networks are kept.
The bounded fixed Docker transport drains actual request close before subsequent effects, and
independent cleanup remains awaited after caller cancellation. Both development entry points
now pass cancellation into the probe and skip later checks after its retirement.

This ephemeral development probe never adopts old runs; a crash or uncertain late server-side
creation can leave an empty labeled network for explicit diagnosis. Installed doctor retains its
separate durable recovery journal. No broader Docker or public network access is introduced.

78 mocked-transport/wiring/installed-doctor cases and ten permitted compiled CLI cases pass.
Daemon/CLI types and eight-file lint pass. The initial test run exposed a duplicate abort emission
in the HTTP mock; the corrected run is clean. Legacy real-HTTP doctor fixtures now expose full
IDs/engine/endpoint metadata and one-shot response loss, with ownership-based expectations, but
those listener-based suites were not rerun. Four previously blocked compiled HTTP cases stay
skipped. Independent FULL review, live cleanup semantics and installed acceptance remain open.

## October 7 — prerequisite drainage and stopped-port diagnostics

Prerequisite Docker version/info requests now use fixed bounded JSON reads and await both actual
request closures, including a cancelled sibling after one fails. Redirects, invalid framing or
UTF-8, compressed/non-JSON/oversized bodies and cancellation after EOF refuse success. Only after
both requests drain can socket discovery report a usable endpoint to installation.

For a durably stopped installation, doctor verifies both launchd jobs are absent before and after
a bounded recorded-loopback bind/close probe. It reports free, occupied or unavailable distinctly,
then repeats absence and port checks after the canary before publishing results. Existing service
jobs or state changes invalidate the observation. No other listener is contacted or terminated;
ordinary services remain stopped, so computer self-tests and overall app readiness remain failed.

134 distinct cases across seven files pass (133 together, then the 41 doctor cases including a new
late port-conflict regression). CLI types and seven-file lint pass. HTTP/listener/launchd effects
are mocked; filesystem prerequisite fixtures use real temporary directories. No live socket,
Docker, service, Keychain, provider or installed acceptance was attempted. Independent FULL review
and live checks remain open, along with the development doctor's legacy network-probe cleanup.

## October 7 — installed credential diagnostic composed

Installed doctor now calls the complete synthetic-credential exercise instead of its placeholder
failure. It authenticates packaged scanner bytes, recovers only the recorded diagnostic operation,
holds the directory lease through helper lifetime and cleanup, provisions the owned topology,
waits for fresh desktop self-tests, runs the controlled scan and collects stopped-container logs.
The bounded boot wait rechecks the full topology and exact loopback ports before/after each probe;
only service startup failures retry. Image/engine drift or installed-service restart invalidates
the doctor's earlier observations. Ordinary installed services are not started or stopped.

After actual helper exit, final scanning covers all remaining private artifacts, helper stderr
and all four container log streams in ten raw/encoded forms. Fixed non-secret helper startup/close
markers and an exclusive ten-form file control establish positive capture evidence. The final
audit chain must contain matching successful swapped requests, counted against the closed echo
receipt. Unsafe links, permissions, changing files, missing controls, incomplete evidence or
cleanup uncertainty prevent success. The helper's normally removed CA is not required to remain.

422 distinct focused tests across 13 files pass (421 together, then 96 affected cases including
one new image-drift case after corrections). Ten compiled CLI checks pass; four previously blocked
HTTP cases remain skipped. CLI types, ten-file lint and focused Go canary pipe/lease tests with
the race detector pass. Filesystem/pipe fixtures are real; Docker, exec, helper-child orchestration
and services are mocked. No real container, host process scan, listener, Keychain/provider access
or installed trial occurred. This remains an unreviewed author build. Independent FULL review,
live installed acceptance, stopped-port diagnostics and legacy probe cleanup remain outstanding.

## October 7 — complete stopped-container log collection

The diagnostic can now bracket the desktop scan with independent start/end markers in stdout
and stderr of both owned containers. Fixed privileged root execs write only those marker arguments
to PID 1's log descriptors; exec identity, command and actual exit are verified. Both containers
are stopped and freshly inspected before collecting complete non-following logs. Streams stay
separate and bounded; missing, reordered or duplicated markers cannot prove coverage. Collection
allows a bounded visibility delay, and state is checked again after reads. Errors drain work and
attempt both owned retirements, including if one stop fails. Ownership uncertainty reports recovery.

The existing execution transport/framing was shared with this collector, retaining actual request
closure on cancellation. 157 focused cases in five files pass; the 23 collector cases were rerun
after correcting a test-fixture type. CLI types and four-file lint pass. All Docker/exec/log
effects are mocked. No live container, host process scan, listener, clipboard, Keychain or provider
ran, and installed doctor is not wired to this yet. The returned log bytes still require a secret
scan together with the closed helper's stderr and private artifacts. FULL review and live installed
acceptance remain pending; this is not a playable release or a visual milestone.

## October 7 — bounded diagnostic desktop execution

Added the concrete Docker adapter for the owned desktop scan. It uploads the verified scripts,
runs the fixed surrogate-only exercise, validates its challenge/file receipt, collects tmpfs and
Docker-changed paths, and runs the scanner with the generated fake secret only in that scanner's
arguments. Python uses isolated mode; controls run as the desktop user, while only the scanner's
exec is privileged to inspect container process memory. No host command or process scan occurs.

Engine, full container ID, labels, pinned image and running state are checked around commands.
Each exec ID is unique within the run and its inspected container, command, user, privilege and
TTY state must match. Attached output is bounded and strictly framed; stdout EOF is followed by
inspection of actual process exit and zero status. Cancellation drains the actual HTTP request
before independently stopping and verifying the exact desktop. Lost stop replies are accepted
only with fresh retirement evidence; ownership uncertainty requires durable outer recovery.

134 focused tests in four files, CLI types and two-file lint pass. All Docker, exec and cleanup
effects are simulated; no real container, request, listener, clipboard, Keychain or provider ran.
This adapter is not yet called by installed doctor. Final stopped-container log collection, closed
helper/artifact scanning, doctor composition, FULL review and live installed acceptance remain.
The app is not yet a verified playable release.

## October 7 — diagnostic exercise programs and installed assets

Added the fixed in-desktop exercise program. It connects only through the desktop's normal
loopback HTTPS forwarder and trust store, requires exact scrubbed header/JSON reflection of the
per-run challenge, writes ten positive file encodings, and retains bounded-lifetime process and
clipboard controls for the separate scanner. Read-back verifies clipboard bytes; only the later
scanner can establish clipboard memory coverage. The worker never receives the upstream secret.
It rejects host invocation and has an overall deadline, bounded network/clipboard output and
fixed child commands. Failed control setup reaps known children; outer container retirement is
still required after an interrupted exec. A second mode enumerates tmpfs/config scan roots.

CLI and runtime assembly now share the canonical scanner/worker asset map, and the package audit
requires both files. The installed reader loads bounded regular private files using the selected
release's authenticated hashes, checks directory identity, and returns bytes for container upload.
It executes neither program on the host. 104 TypeScript/build tests and 27 Python tests pass,
with CLI types and eight-file lint clean. Tests use temporary files/pipes, mocked network/clipboard
effects and compiled CLI subprocesses; the four previously excluded HTTP cases remain excluded.
No real Docker, clipboard, gateway listener, Keychain or provider ran. The full runtime build was
not rerun. Actual Docker exec/deployment, final drained log/artifact evidence, doctor composition,
independent FULL review and installed-app acceptance remain incomplete. No playable release yet.

## October 7 — owned diagnostic desktop creation

The diagnostic runner can now provision the normal desktop/gate topology from verified image
pins: isolated private networks, a labeled home volume, stopped containers, credential-file upload,
then ordered startup. Every created ID is captured in the recovery journal before dependent work.
Final checks verify exact network attachments and loopback ports. Unexpected host mounts, elevated
privileges, altered image commands, overlapping networks and public bindings are rejected.

The concrete mutation client is bound to one run/helper receipt, sends only fixed local Docker
requests, and waits for request closure on cancellation. The uploaded files contain only the
proxy token, public CA and surrogate; the generated upstream secret stays out of container setup.
129 focused tests, CLI types and five-file lint pass. These use simulated Docker/HTTP state and
temporary filesystem fixtures; no actual diagnostic container has run. Scanner deployment,
positive controls, final artifact/log evidence, doctor wiring, independent review and installed
app acceptance remain incomplete. This is still implementation progress, not a playable release.

## October 7 — durable diagnostic recovery and cleanup

Diagnostic runs now have a private durable journal recording their owner, engine, random run/cell
identity, image pins, directory identity and created resource IDs. It records intent before effects
and confirms cleanup before removing artifacts. Interrupted runs retain enough state for bounded
recovery; missing active directories, mismatched ownership or a still-held helper lease refuse
recovery. Resource captures are serialized and cannot reopen the journal after retirement.

The cleanup adapter verifies exact container identities and images, stops/removes owned containers,
requires empty networks and an unused local volume, then confirms all resources are absent. Its
restricted Docker transport waits for request closure even on cancellation or a lost response.
149 focused tests, CLI types and eight-file lint pass, using temporary filesystem state and mocked
Docker/HTTP/child effects. No actual Docker request or diagnostic container run occurred. Topology
creation, scanner controls, final artifact/log verdict, doctor wiring, independent FULL review
and installed-app acceptance remain incomplete. This is not a completed diagnostic or playable build.

## October 7 — diagnostic lifetime lease

Diagnostic helpers now inherit a lock on their private operation directory. The lock survives
closure of the parent's descriptor and remains held until the last shared descriptor closes.
Recovery opens a separate descriptor and refuses while the original helper still holds the lock;
it does not infer retirement from a remembered PID. Directory identity, ownership, permissions
and canonical path are checked, and acquisition leaves a fresh directory empty for startup.

The CLI retains the descriptor through draining work and passes it as fd3 to canary-run. Missing
child pipes fail only after child closure is drained. 76 focused TypeScript tests, CLI types and
six-file lint pass. Eleven top-level Go tests with subcases pass under the race detector; these
include real directory locks, duplicated descriptors and pipes with simulated sessions. No actual
child, gateway listener, Docker or Keychain was used. The durable diagnostic journal, real cell/
scanner, artifact cleanup, doctor integration and installed-app trial remain incomplete.

## October 7 — parent canary process transport

Added the parent transport for the verified keyd canary-run helper. It uses fixed arguments,
private pipes and a clean environment, validates ordered run/cell-bound receipts, caps output,
and exposes only fixed errors. Unexpected child retirement aborts the scanner callback; caller
cancellation retains ownership until both callback work and actual child close settle. Normal
shutdown uses stdin EOF, escalating only the owned child if it does not retire within five seconds.

38 simulated-child tests, CLI types and three-file lint pass. Cases cover malformed/mismatched
receipts, overflow, stalled startup, full lifetime timeout, early shutdown, delayed pipe closure,
callback failure and retained cancellation ownership. A schema dependency error was fixed by
placing validation in the existing protocol package. No executable, listener, Docker or Keychain
was used. This is not yet invoked by installed doctor: durable ownership/recovery, diagnostic
container/scanner, final artifact scans and cleanup remain required before a complete canary run.

## October 7 — isolated canary session and command

The keyd binary now has a separate canary-run subcommand. It requires a caller-owned empty,
canonical private directory and operation/cell identities; it creates a fresh gateway directory,
an in-memory vault holding only the generated fake secret, and an ephemeral loopback gateway
whose only upstream dialer is the in-process echo. The fake binding permits only GET to this
run's exact challenge path. Normal service configuration and the user's vault are unchanged.

Ready and closed receipts use pipes with deadlines; regular-file output is refused. Parent EOF
retires the session, unexpected input fails, and a ten-minute limit or termination signal closes
the input wait. Session cleanup closes gateway admission, echo workers and audit output, retaining
artifacts for later scanning. The parent must await actual child exit before scanning them; a
closed receipt alone does not prove process drainage or a successful canary exercise.

Six top-level tests with directory/startup/protocol subcases pass under the race detector. They
use real private fixture directories and OS pipes with simulated gateway/session operations.
No listener, subprocess, Docker or Keychain was started. Five Go files are formatted. The parent
ownership journal, real diagnostic cell, scanner/artifact collection, recovery and doctor wiring
remain incomplete, along with independent FULL review and installed acceptance.

## October 7 — isolated canary upstream and audit retirement fix

Added an isolated synthetic TLS echo dialer for the forthcoming canary runner. It generates its
own fake secret/challenge, accepts only one fixed diagnostic authority and uses in-process pipes
without DNS or socket listeners. Connections, headers and lifetime are bounded; Close retires and
drains every worker. Authenticated requests reflect raw/encoded fake values for keyd to scrub.
The ordinary service does not import or enable this diagnostic dialer.

A direct integration test exercises the existing keyd forwarder, memory vault, registry, scrubber
and audit writer against the echo. It confirms actual substitution, scrubbed header/body and no
raw/base64/hex fake key in returned output or audit. It exposed a bug: audit Close left Err clear,
allowing a subsequent credential admission before the next write detected closure. Close now
marks the audit unavailable under its mutex; revoked and closed-audit requests never reach echo.

The full audit suite passes with the race detector. Ten selected top-level tests across audit,
canary and egress also pass with the race detector, including bounded connections, TLS identity,
oversized headers, cancellation and the forwarder integration. All five Go files are formatted.
No Docker, OS listener, Keychain, account or external network was used. This is not the completed
installed canary runner: owned cell execution, scan/artifact coverage, cleanup and CLI composition
remain. Independent FULL review and all installed acceptance/polish requirements still apply.

## October 7 — shared canary scan verdict

Added a strict canary scan evaluator and connected the existing Docker canary acceptance test
to it. The evaluator requires all ten raw/encoded file controls in the same scan, environment
and command-line controls, live surrogate memory, and a clipboard hit attributed to an actually
read xclip process. Process/byte totals must agree with unique per-process reads. Persistent read
errors, missing controls, malformed evidence or insufficient coverage refuse a pass. Results
expose only a fixed reason and coverage counts, never scanner paths, process names or needles.

49 evaluator tests, 15 existing Python scanner fixture tests, daemon types and three-file lint
pass. Python tests use temporary files and synthetic process trees, never host process memory.
The changed Docker acceptance test was not executed. This evaluator is a shared component for
the forthcoming installed runner, not a completed canary diagnostic: upstream substitution,
owned execution, drained artifact scans, cleanup and CLI wiring still remain. Independent FULL
review and the full installed-app acceptance/polish requirements remain unchanged.

## October 7 — fresh installed computer diagnostics

Installed doctor now requests fresh self-tests through an authenticated daemon route. The
orchestrator holds idle-task admission and its lifecycle queue, verifies exact runtime/container
ownership and loopback endpoints before and after probing, and lets Stop preempt diagnostics.
A failed verdict closes computer admission and attempts keyd/browser/container containment.
Requests and replies are bounded and tied to the daemon identity, boot and request identifier.

The CLI independently reads all private computer records before and after the request, rejects
invalid or changing inventory and omitted/unexpected desktop results, and rechecks service
readiness and process identity. Empty, busy, stopped and unavailable computers cannot yield a
successful self-test row. Canary execution remains unimplemented; doctor still cannot pass overall.

108 focused tests across five files pass with simulated transports/Docker and in-process routes.
CLI and daemon types and eleven-file lint pass. Initial test typing and formatting issues were
corrected. This is an unreviewed author draft, not installed acceptance. Independent FULL review,
live installation/task/Stop/restart, signing, native acceptance and remaining polish still apply.

## October 7 — cancellable self-test reader

Added a bounded diagnostic reader for a freshly owned desktop's loopback self-test endpoint.
It validates credentials, response size/encoding/schema and required check IDs/kinds, returns no
raw cell descriptions, and drains the HTTP request on cancellation. A completed body cannot be
reported as success if cancellation arrives before transport retirement. 28 mocked-transport
tests, daemon types and two-file lint pass; no real endpoint or computer was touched.

Lifecycle ownership, authenticated diagnostic routing and CLI integration are still required.
The existing readiness reader is unchanged. Doctor's fresh self-test and canary rows therefore
remain explicitly unfinished. This is an author checkpoint, not a completed diagnostic feature
or installed trial. Independent review and all earlier shipping/polish requirements remain.

## October 7 — installed diagnostic foundations

Managed `localdot doctor` checks recorded installation authority, host/disk/Docker resources and
all four release image pins. Its gateway probe now uses the installer's durable ownership and
cleanup checks under the install lock. The exact installed daemon on its own port is recognized
through authenticated readiness and launchd PID observations. Service/configuration changes
invalidate results, and cancellation waits for probe cleanup.

147 related tests/eight files, ten offline compiled CLI checks, CLI types and six-file lint pass.
All native/Docker/service effects are simulated. Four blocked HTTP cases remain excluded.
Doctor is not complete: fresh cell self-tests and the installed canary exercise remain explicit
failed checks, so this author build cannot report overall diagnostic success. Stopped-port detail,
development-probe cleanup, independent review and installed acceptance remain, along with the
earlier full-app requirements. No installed trial or accepted integration occurred.

## October 7 — public update command

`localdot update` now recovers interrupted work offline, discovers the latest stable exact version,
authenticates its release and calls installed activation/rollback. `--to <version>` selects an
exact stable or release-candidate version. Downgrades are refused; an equal version checks normal
startup/readiness. Preparation rechecks settings, selected identity and journal after obtaining
its lock. Cancellation waits for recovery/rollback, and the sign-in link uses the saved port.

161 related tests across seven files and ten offline compiled CLI cases pass, along with CLI
types and nine-file lint. The new compiled fixture needed a canonical macOS temporary path.
Four blocked HTTP cases remain excluded. Unit dependencies are simulated; there was no live
update, Docker/service/Keychain effect, accepted integration or user-ready installed trial.
Full doctor, independent security review, installed acceptance and the earlier shipping/polish
obligations remain. The update command is implemented in this author draft only.

## October 7 — installed runtime preparation and rollback composition

Update activation, rollback and stopped `localdot up` now call prepareInstalledRuntimes before
service bootstrap. It retains both service leases, freshly contains all known executors, checks
native retirement, uses authenticated release images and persists changed cell records atomically.
It finishes an interrupted target while stopped before preparing rollback images. Unrelated cell
records, journals, permanent retirement bindings and engine identity are rechecked during effects.
Already matching desktops are verified and reused. Permanently retired computers remain held.

The new local Docker transport permits only inspection, container creation and non-forced deletion
by full ID. It bounds request/response sizes, uses fatal UTF8, follows no redirects, and drains the
actual request before releasing cancellation ownership. Runtime preparation awaits durable cell
saves. Browser startup already retires old executable resources while retaining the profile; this
composition relies on that existing startup gate rather than creating another profile migration.

170 cases/seven files pass, including 37 new transport/composition/integration cases. The final
12-case host rerun, nine compiled offline cases, CLI/daemon types and nine-file lint also pass.
Tests exercise real private records/journals and simulated Docker, leases, release authentication
and service commands. Multi-computer partial rollback, lost create replies, preserved simulated
home/profile sentinels, uncertainty and cancellation are covered. No real volume, installed app,
native process or Keychain was exercised. Four blocked compiled HTTP cases remain excluded.

Author checkpoint only: independent FULL review, mutation/bypass work, live volume preservation,
public update CLI, full doctor and installed first-task acceptance remain, along with the previously
listed signing/native/M6/M8 work. Nothing here establishes a user-ready installed trial.

## October 7 — managed native retirement across service shutdown

The harness now fsyncs its protected profile directory and managed parents before returning the
profile to the launcher. A failed persistence step cannot reach spawn. The launcher already retains
that profile until process-group/pipes retirement is confirmed; uncertainty keeps the evidence.

Installer shutdown checks the managed profiles/work/bridge directories while holding both service
lifetime leases. Any leftover, unsafe/missing activity directory, changed identity or cancellation
refuses retirement. The check creates, repairs, deletes and signals nothing, and does not read the
account home. Container containment runs first so native uncertainty does not prevent best-effort
Docker shutdown. Stopped-service work rechecks native evidence before, during and after its scope.
This assumes the caller's install mutex and managed service exclusion; it is not an orphan-process
recovery mechanism or permission to delete leftover folders. Existing user Codex files are untouched.

154 tests in six files, five selected in-memory launch cases, nine compiled offline CLI cases,
CLI/harness types and nine-file lint pass (27 new cases). The launch cases exercise the actual
launcher/profile creation with a simulated process, including Stop returning before closed pipes,
failed durability and uncertain retirement. Four previously blocked compiled HTTP cases and 25
unselected launch cases were not run. No actual native/Docker/launchd/Keychain action was performed.
Independent FULL review, live acceptance, runtime-preparation host/rollback, update CLI and the
first installed whole-app trial remain outstanding. These changes are an author draft only.

## October 7 — interrupted update containment and stopped-service leases

Installer containment now recognizes update containers through their private durable journal, exact
name/operation/configuration and recorded candidate ID when available. This covers a lost create reply
and the interval before the new cell record is saved. It rechecks that proof before stopping the full
container ID. Foreign or changed candidates are refused while other known owners are contained.
Stale journals from reset are harmless only when their objects are absent; surviving orphaned objects
are contained without certifying successful recovery. Journal changes also invalidate the receipt.

The service-retirement adapter now shares a two-process-lease wrapper. Its stopped-only form retains
both locks throughout work, rechecks durable stopped jobs and physical job absence, and waits for
in-flight work to settle on cancellation. This proves managed service absence, not native executor
retirement. The runtime preparation host still needs to compose those separate obligations.

188 tests across six files, nine compiled offline CLI checks, CLI/daemon types and nine-file lint
pass. Four previously blocked compiled HTTP checks remain excluded. New coverage includes 33 cases
for update containment, private read-only inventory and stopped leases. Native effects and Docker
are simulated; no running app, user data or Keychain was changed. Physical recreation/rollback
invocation, update CLI, independent FULL review and live synthetic-home acceptance remain open.

## October 7 — runtime update admission and managed image checks

Daemon startup now restores runtime-update holds before ordinary browser/agent/computer recovery.
Prepared journals reopen only after matching the saved cell record and selected image pins; unfinished
or changed journals stay held. Permanently fenced/reset old identities remain held without blocking
unrelated computer creation. Ordinary replacement publication cannot release these update holds.

Managed computer reconciliation, Start, Resume, readiness publication, replacement inspection and
background watch now check exact container ownership and actual image IDs against locally inspected
linux/arm64 release pins. A matching Config.Image string alone is insufficient. The first Start
check occurs before key wiring or any cleanup by container name. This prevents a healthy new daemon
from silently accepting old-image desktops, but does not yet invoke the physical update routine.

109 tests across five files pass, including 29 new admission/image cases and existing update/reset/
readiness regressions, plus daemon types and five-file lint. These use private temporary files,
actual CellOrchestrator controls and simulated Docker/key services. Main-process launch, installed
image authority, live Docker preservation and independent FULL review remain unverified. Installer
invocation of recreation, update CLI and rollback composition still remain before a usable update.

## October 7 — recoverable desktop runtime preparation

Updates now have a staged routine that replaces the stopped gate and desktop with pinned images
while retaining the computer ID, tokens, home volume and networks. A private, fsynced journal records
intent before retirement and container identities before updating the cell record. Lost create
replies recover only the persisted operation's matching container. Lost writes/deletes, cancellation,
foreign ownership, live containers and incomplete prior targets keep preparation unconfirmed.
The routine never starts containers or creates/deletes volumes; rollback can prepare the previous
images after finishing an interrupted target while everything remains stopped.

52 tests in three files pass (32 runtime-update cases and 20 related reset-store/hold regressions),
with daemon types and four-file lint (three existing informational style suggestions). Docker and
quiescence are simulated; real private journals are exercised. Installer/startup composition,
durable admission across process restart, independent FULL review and live synthetic-home acceptance
remain. This is author implementation, not an installed update or a trial-ready app. The preceding
status-only turn made no implementation progress; this turn adds the missing recreation primitive.

## October 7 — confirmed reset CLI

`localdot reset-computer --cell <id>` explains erasure without reading configuration or authority.
Only `--erase-computer` submits the confirmed reset; `--request <id> --status` is read-only. The
client prints the request ID before dispatch and preserves it in exact status/retry instructions.
It uses the installed port/private token, sends one request, rejects redirects and mismatched or
oversized receipts, and cancels bounded transport/body reads. Lost replies never trigger a retry.

42 tests across four files, nine compiled offline CLI cases, CLI types and seven-file lint pass.
Four previously blocked compiled HTTP cases remain excluded. Client transport is simulated; the
compiled reset checks cover explanation and missing-install refusal. No real reset or provider call
occurred. Reset implementation is connected from CLI to daemon; independent FULL review, mutation/
bypass checks and live synthetic-volume acceptance remain before accepted integration.

## October 7 — reset daemon controller and API

The reset owner is now composed into daemon startup and authenticated cell routes. It preflights
the whole ownership graph before task Stop, drains task/native execution, closes desktop/browser
key listeners and verifies their absence before physical retirement. Computer and browser records
are removed only after cleanup; a failed final record removal can retry the same transaction.
The replacement keeps its hold until durable Ready and fresh physical readiness. Shutdown prevents
new candidate creation/publication; startup only restores already completed candidates.

119 tests across eight files, daemon/protocol types and eight-file lint pass. Composition tests
exercise actual CellOrchestrator and BrowserOrchestrator retirement and Hono's authenticated request
path using simulated Docker/key services and candidate creation/readiness. No HTTP listener or real
reset was used. Explicitly confirmed CLI/client recovery, independent FULL review and live-volume
acceptance remain. This checkpoint is unreviewed author work, not an installed trial.

## October 7 — reset executor drain and exact resource retirement

Reset now has a task-runner drain method that requires the old fence, rejects pending preflight or
idle operations, stops the selected session, waits for actual settlement, and retains native/brain
uncertainty. Its ten-second deadline returns unconfirmed without forgetting a still-live owner.

The source mapper captures public desktop/browser ownership without tokens. Stopped or partially
created browser resources have explicit null IDs; these require absence and cannot be adopted by
name. Browser owner identity is retained even when only the profile remains. The physical retirement
adapter validates the complete graph and mounts before mutation, deletes exact IDs with both gates
first, and removes only the two explicit volumes after detachment. Lost replies require observed
absence. Changed ownership or a new foreign mount preserves remaining volumes.

94 tests in six files, daemon/protocol types and seven-file lint pass. Docker and native effects are
simulated. These are production components, not yet connected to the reset controller/API/CLI; key
grant closure, browser ledger finalization, startup Ready verification, FULL review and live volume
acceptance remain required. No live reset, accepted integration or installed trial occurred.

## October 7 — persistent reset admission

The daemon now restores independent reset holds before browser/agent recovery and ordinary computer
reconciliation. Old identities remain fenced; candidate Start and public availability stay blocked
until the reset owner validates Ready. Ordinary replacement publication cannot clear this separate
hold. The durable binding rejects conflicts, cycles, changed/missing records and unsafe file state;
candidate release is deliberately in-memory and must be re-earned after restart.

65 tests in five existing files pass, including real CellOrchestrator admission with Docker calls
mocked, plus daemon types and six-file lint (three existing informational style suggestions).
The unmatched replacement-controller.test.ts filter selected no file and is not claimed as coverage.
No actual Docker, service, provider, Keychain, reset or installed application was exercised. This is
unreviewed author work. Production reset retirement/readiness, HTTP/CLI, independent FULL review and
end-to-end local trial remain required. The previous status-only turn made no implementation progress;
this turn adds the independent candidate gate and executable integration coverage.

## October 7 — reset transaction core

The staged reset coordinator records the selected computer, exact public resource identities and
fresh candidate before destructive work, preserving them across lost replies. It verifies retirement
before creation and persists Ready before publication; startup restores holds without repeating
deletion. Private journals reject identity changes and phase rollback. 67 related tests, daemon/
protocol types and lint pass. Production retirement, durable holds, API/startup wiring and the
confirmed reset CLI are still unfinished. No real computer or volume was reset, and this is not
runtime reset acceptance. Independent FULL review remains required.

## October 7 — installed command routing

open, stop and doctor now use the managed installation's saved port and Docker socket. They reject
corrupt/missing managed records instead of falling back to environment defaults. Development mode
still accepts explicit settings when no managed state exists. Doctor uses the installed manifest's
desktop/gate image pins; complete resource/readiness/self-test/canary diagnostics remain unfinished.
56 related tests, eight compiled offline checks, CLI types and lint pass. All verification used
synthetic files or clients; live installed acceptance and independent review remain pending.

## October 7 — managed service logs

The staged CLI now provides logs and logs --follow for the four private daemon/keyd stdout/stderr
files. Reads are bounded, incomplete lines stay buffered during follow, and rotation/truncation is
handled. Terminal controls are escaped and recognizable credential forms masked without reading
Keychain or token files. 45 related tests and eight compiled offline cases pass, including SIGINT
ending a real CLI follow process against synthetic logs. CLI types/lint pass. No installed logs or
services were accessed; independent review/live acceptance and remaining CLI work are still open.

## October 7 — installer browser progress

The staged default installer opens a local progress page after prerequisite checks. It reports
release preparation, image downloads/unpacking and startup checks, then opens the authenticated
setup screen through the existing one-use link. Established installations open their fresh link
directly. Browser failures retain terminal progress/link output. The temporary read-only listener
uses a per-run capability, exact local origin checks and bounded cleanup; it exposes no reusable
daemon token or raw errors. Focused tests, CLI types/lint and seven compiled offline cases pass.
Four archive tests timed out in the broad parallel run and passed on isolated rerun. Actual
browser/native startup and independent FULL review remain unverified. No installed app changed.

## October 7 — first-run setup UI

The staged empty workspace now guides model/key setup, browser appearance, autonomy defaults and
starting a computer. It reuses existing Settings and guarded start behavior without submitting
keys, policies or tasks on display. Graphite and Midnight are available in setup and Settings;
changes update the canvas worker and handle unavailable preference storage. Setup remains scrollable
on narrow screens. 166 related tests plus focused contrast and App navigation checks pass, as do
web types, lint and production build (with a chunk-size warning). The static desktop preview was
delivered to Telegram, message 12142. This is not live installed-app acceptance. Browser install
progress, automatic launch, native Keychain resolution, independent review and first-task acceptance
remain before a local trial; other milestone scope is unchanged.

## October 7 — default install command

The author candidate now routes an empty command line to setup. Established installations reuse
the offline up path and recorded settings. First setup checks host/disk/Docker before creating
private directories, authenticates and prepares this CLI build's exact release version, prepares
pinned images, activates under the helper mutex and issues a one-use sign-in link for the actual
recorded port. Interrupted first installs enter the existing recovery/activation path. No mutable
registry tag, ambient port or alternate Docker engine overrides an established installation.

Directory initialization creates missing descendants under a safe user-owned ancestor with mode
0700 and parent-directory fsync. It neither changes existing permissions nor removes user data.
Unsafe paths and corrupt/missing existing service authority fail without guessing a new owner.
991 tests across 57 files pass, alongside CLI types and 11-file lint. Seven bundled offline CLI
cases pass, including no-argument missing-prerequisite guidance with no installation writes; four
previously blocked HTTP cases remain excluded. New setup tests simulate acquisition/activation;
they are not live signature, download, Keychain or installed-service acceptance.

Remaining setup scope includes browser progress/automatic browser opening and onboarding (provider
selection/keys, theme, autonomy defaults, first task). The current command prints the one-use link.
The Keychain issue, independent FULL review and a live first-run task still prevent a trial-ready
claim. No accepted integration, actual installation or preview update occurred.

## October 7 — installed update activation and recovery

The author candidate now connects the update transaction to release selection, durable service
configuration, service retirement/startup and exact-release readiness. Up invokes update recovery
under its verified-helper mutex before ordinary startup and uses the restored configuration's port.
An interrupted activation rolls back to the recorded previous release; failed containment stays
pending. A first-install rollback can clear selection without deleting files or user data.

activateInstalledRelease composes recovery, immutable service preparation, pinned-image preparation
and activation. Existing installations retain their recorded engine/runtime/port. This is the
locked activation entry point for the default installer; the no-argument CLI is still unfinished.
Update-time computer recreation, onboarding, logs and reset also remain.

940 tests across 54 files passed. After formatting and a small equivalent guard cleanup, 56 tests
across four files passed, including the real-filesystem update/service coordinator integration and
the daemon lease tests. An additional release-identity snapshot regression passes (eight activation
tests); six compiled offline CLI cases pass, with the four blocked HTTP cases excluded. CLI types
and six-file lint pass. Effects in the new transaction integration tests use simulated native
services/signatures/Docker; no actual installation, live launch or accepted integration occurred.
Independent FULL review and live acceptance remain, along with the Keychain issue.

## October 7 — CLI up and installed startup checks

The author candidate now implements localdot up for an existing managed installation: recorded
configuration, offline verified helper, install mutex, selected/terminal-update consistency,
service recovery, release/image/isolation verification, exact readiness and fresh sign-in link.
It reuses healthy services and refuses unfinished updates. It does not implement first install.

The isolated gateway probe records intent before creation, binds random ownership to the selected
engine, removes only freshly verified empty probe IDs and confirms cleanup before clearing state.
Startup checks all four image pins around the probe. A helper PID-admission race after kickstart
was corrected, with exact-PID regression coverage. Per-cell self-tests remain mandatory.

937 tests/53 files, six compiled CLI offline cases, 39 Go race cases, types and lint pass. An actual
private Unix HTTP fixture passed expected success/failure/cleanup for four scenarios; no real
Docker network, Keychain, provider or service was used. Independent FULL review and live installed
acceptance remain. Keychain resolution and first-run installation/onboarding still block the local
alpha; no user-ready or accepted integration is claimed and the preview is unchanged.

## October 7 — CLI down is wired in the author candidate

localdot down now uses recorded managed settings, offline anchored/signature-checked helper
verification, the install mutex, durable shutdown and physical service/container retirement.
It keeps computer data and pending update records, requires fresh checks even for an old stopped
receipt, and cannot start services. App/native payload damage does not prevent checking the
independently anchored helper; helper damage or uncertain shutdown prevents a success message.

878 broad tests passed; after the final regression/cleanup, 41 focused tests passed. CLI/daemon
types, ten-file lint and five compiled offline CLI cases pass. Four previously blocked HTTP cases
remain excluded/unverified. No live installed shutdown is claimed; independent FULL review and
live acceptance remain. Startup/default installer, update/reset/logs/onboarding and Keychain
resolution are still unfinished. Source is staged only, and the local alpha is not ready yet.

## October 7 — managed service shutdown adapter

The staged installer now verifies its launchd context and owned job absence, then confirms process
exit with the lifetime lease. Lost command replies require fresh observation. Container shutdown
holds both service locks and rechecks durable stopping intent before completing. The authenticated
bootstrap helper is retained through preparation and cleanup rather than trusting damaged payloads.

857 tests in 47 files pass, including a real private-record/kernel-lock lifecycle fixture with
simulated launchd/Docker effects. CLI/daemon types and eleven-file lint pass; read-only observation
of this Mac's launchd passed without changing jobs. Live service acceptance and independent FULL
review remain. Startup/isolation and default CLI integration still need completion for the local
alpha; Keychain diagnosis remains open. Nothing here claims an installed or user-ready app.

## October 7 — local trial and service lifetime identity

The author installer candidate now gives each managed process a permanent kernel lifetime lease,
with exact journal admission, exec-preserved PID, cleared environment and child non-inheritance.
Installer lock acquisition waits for helper closure and can distinguish a still-running service.
132 focused TypeScript tests, 36 Go race cases, CLI/daemon types and lint pass. Physical launchd
retirement and production lifecycle composition still remain, as do independent FULL review and
live acceptance. This is staged implementation, not installed/accepted code.

The next user-facing goal is a usable local alpha: startup/shutdown, resolved Keychain access,
and one complete end-to-end task. Distribution packaging and visual polish can follow the trial.
Port 4882 was freshly checked and is offline; it hosted an avatar playground, not the full app.
No release date is claimed. Previous signing success does not establish current native Keychain
storage acceptance; the live timeout and macOS authorization refusal remain open.

## October 7 — signed native Keychain implementation

The shipping author candidate now uses Security.framework from a bounded child of the signed
keyd executable. It verifies both signed process identities, assigns/checks an explicit keyd-only
ACL, clears inherited child environment and distinguishes pre-effect refusals from uncertain
writes. Startup and packaging reject builds lacking the signed native backend.

68 command/vault race test cases pass with three live fixtures skipped; go vet, eight packaging
tests and lint pass. Actual signed parent/child identity acceptance and unrelated-parent refusal
passed. Live fake-item storage did not pass: a Put timed out, and subsequent macOS authorization
refused signing the diagnostic fixture. The storage failure still requires diagnosis. The two
test-only items left by that run were deleted and verified absent, without reading personal keys.

AUTHOR-v26 records this unreviewed source. Native ACL/storage acceptance, update compatibility,
independent FULL review and a freshly signed production helper remain open. Prior signed helper
artifacts predate these changes. Launchd/process retirement, installer/CLI/update/onboarding,
isolation/notarization and full release acceptance also remain; M7 integration, M6 playback and
M8 providers/polish/dot follow. Accepted source/preview4882 are unchanged; no visual milestone.

## October 7 — installer container shutdown

The shipping author candidate now contains owned desktop/browser/gate/brain containers using the
recorded local Docker engine, bounded private cell records and exact container identities. Gates
stop first, every target is re-inspected, and changed ownership, new containers, automatic restart
or uncertain observations leave shutdown pending. Volumes and profiles are preserved. Confirmed
launchd/process retirement must precede this adapter and remains unfinished.

44 focused tests pass. Broader validation passed 815/816 tests; one archive test timed out under
parallel load, then its complete 60-test file passed alone. CLI/daemon types and scoped lint pass.
A temporary Unix HTTP server exercised the combined production path: three synthetic owned
containers stopped, foreign container untouched, delayed exit observed and fixture data retained.
No real Docker/launchd/volume acceptance is claimed. AUTHOR-v25 is unreviewed; FULL review remains.

Apple signing is verified with Richard's Keychain identity for team 87FD3FSZBG. Notarization and
signed-keyd-only vault access are still open, as are CLI/update/onboarding wiring, isolation and
full release acceptance. M7 integration, M6 playback and M8 providers/polish/dot remain. Accepted
source and preview4882 are unchanged. No new visual milestone, usage check, agent, commit or push.

## October 7 — installer service recovery

The shipping author candidate now records exact service configuration and action intents before
launchd operations, retains rollback configuration, retires uncertain starts without replaying them,
and rechecks historical running receipts. Cleanup continues across partial errors and requires real
job/process and container confirmation before a stopped receipt. Its production host connects file
authority, fixed launch commands and readiness; physical retirement/isolation adapters remain open.
Startup tolerates bounded temporary recovery delays but refuses authentication/identity failures.

767 broad tests pass; final changes pass 140 focused tests, then 17 journal tests. CLI/protocol types
and scoped lint pass. Effects are mocked and private filesystem records/plists are real; no installed
service, Docker container, vault or provider was used. AUTHOR-v24 freezes unreviewed source. FULL
review and live acceptance remain. Core-spec inspection also reconfirmed signed-keyd-only Keychain
access lists as unfinished: signing the helper does not yet restrict the existing security CLI vault.

Remaining: physical retirement, default CLI/update/logs/onboarding, update cell recreation preserving
volumes, Keychain ACL hardening, notarization and complete release acceptance; M7 integration, M6
playback and M8 providers/polish/optional vivid dot. Accepted checkout and preview4882 are unchanged.
No new visual milestone, usage check, agent, branch, commit or push. App goal remains incomplete.

## October 7 — authenticated readiness and Apple signing verified

The shipping author candidate now requires authenticated exact-release/PID readiness from daemon
and keyd, completed startup and current-keyd browser admission recovery, writable audit and active
hairpin protection. Managed startup refuses incomplete recovery observations; development retains
its existing per-cell diagnostics. The bounded installer probe validates the reply and drains HTTP
closure on cancellation. Managed launch logs do not persist initial sign-in links.

725 tests pass in 42 files, CLI/daemon/protocol types and thirteen-file lint pass. Keyd command/admin
race tests passed separately with local fixtures. A fresh offline helper build is actually signed
with Richard Liao's Developer ID (87FD3FSZBG), hardened runtime and secure timestamp. The production
verifier accepts it and rejects a tampered copy even with a matching declared hash. Key material
stayed in Keychain. Tron's hardened runtime/notarization configuration was inspected as requested.

AUTHOR-v23 freezes this unreviewed work. Readiness is not an isolation proof or complete installer.
Durable service operation/recovery, full containment, default CLI/update/onboarding, notarization
and live release acceptance remain. FULL independent review, M7 final integration, M6 playback and
M8 providers/polish/optional vivid dot are also outstanding. Accepted checkout and preview4882 stay
unchanged; no new visual milestone. No usage checks, agents, commits, branches or pushes.

## October 7 — durable service ownership and publication

The author installer now persists a private random ownership ID for its launchd labels and publishes
both service definitions atomically into an immutable configuration directory. Reopening derives
the expected files from the verified release, refuses corruption/links/unsafe permissions, preserves
logs, and rechecks authority before fixed launchctl operations. Apple documents print output as
unstable, so ownership does not depend on parsing it. No live service was started or stopped.

617 installer tests pass across 36 files; 64 focused service tests pass after adding two more
corruption/generation cases. CLI/protocol types and seven-file lint pass. Failure tests cover missing
ownership, conflicting definitions, unsafe logs, failed directory sync, interrupted publication and
replacement of scratch during cleanup. FULL review and actual startup/containment acceptance remain.
AUTHOR-v22 binds this unreviewed candidate. The accepted checkout and preview4882 are unchanged.

Next: persistent service operation/configuration state, confirmed shutdown of jobs and all owned
containers, authenticated exact-release readiness, CLI/update/logs/onboarding. Notarization/release
acceptance, M7 integration, M6 playback and M8 providers/polish/dot remain. No usage check, agent,
branch, commit or push. The app goal remains active/incomplete; this is backend progress with no
new visual milestone to send.

## October 7 — release-bound service definitions and Docker selection

The author installer now builds per-home keyd/daemon LaunchAgent definitions from a reverified
installed release. Both launch through env -i with a bounded explicit environment; the daemon
receives all four authenticated digest references and the selected local Docker socket. keyd
keeps the Keychain vault and production NAT-PMP/STUN defaults. Definitions use private state,
explicit bootstrap/kickstart and no automatic login/KeepAlive path that could bypass recovery.
The fixed launchctl transport bounds output/deadline and drains its child on cancellation.

The daemon previously replaced a missing explicit Docker socket with another engine. It now
preserves the selected socket and rejects malformed/remote DOCKER_HOST values. This aligns
startup with installer image/preflight checks. Implicit development discovery is unchanged.

595 installer tests pass (35 files), including real plutil parsing and mocked service-process
failures. A separately authorized fake-server regression passes 54 Docker/doctor tests (3 files).
CLI/daemon types and eight-file lint pass. The first broader attempt failed on sandbox-denied
socket listeners; its log is retained. No live Docker or service-start acceptance is claimed.
AUTHOR-v21 binds this unreviewed candidate. FULL independent review remains pending.

Next: durable plist ownership/publication, loaded-job verification, physical containment of all
owned containers, authenticated exact-release readiness and CLI/update/logs/onboarding wiring.
Daemon disposal alone does not stop all computers; HTTP health alone does not prove readiness.
Notarization/release acceptance, M7 final integration, M6 playback and M8 providers/polish/dot
remain. Accepted source and preview4882 are unchanged; no new visual milestone. No usage check,
agent, branch, commit or push. The full app goal remains active and incomplete.

## October 7 — pinned image preparation

The author installer now has a bounded local Unix-socket Docker image client, streaming progress parser,
and four-role preparation orchestrator. It snapshots authenticated manifest pins, reuses only exact
repository-digest/Linux-arm64 matches, pulls missing or incompatible images sequentially, reinspects each
pull and all four images before completion, and checks stable Docker Desktop engine identity/platform.
Configuration image IDs cannot substitute for repository digests. No containers/services are started.

HTTP requests are fixed pull/inspect/engine operations, with no registry credentials, credential helpers,
CLI spawning, redirects or TCP fallback. Pull output is bounded by total bytes, per-line bytes and record
count; errors inside HTTP200 fail the pull. Progress exposes typed phases and bounded layer/counters.
Cancellation/errors wait for actual request closure. prepareInstalledReleaseImages reopens through the
installer-owned trust anchor before constructing the Docker client.

images-v2 passed 565 tests in thirty-four files. After lint-only cleanup, images-v3 repeated the 71 focused
tests in four files; final CLI/protocol types and eight-file lint pass. Initial test-header typing and
lint findings were corrected; failure logs are retained. All Docker transport is mocked here. No live
Docker pull, registry image availability, runtime isolation or earlier denied acceptance is claimed.
AUTHOR-v20 binds this unreviewed candidate; independent FULL review remains pending.

Next: production service adapter and default CLI/update/logs/onboarding integration, abandoned scratch
recovery, live release/Docker/TUF acceptance and notarization. M7 integration, M6 playback and M8
providers/polish/optional dot remain. Accepted source and preview4882 are unchanged; no new visual
milestone. No usage check, agent, branch, commit or push. The full app goal remains active/incomplete.

## October 7 — authenticated bootstrap and one locked preparation path

The installer author candidate can now bootstrap its first kernel lock without trusting an installed
helper. It acquires the exact helper archive in owned scratch, previews fresh provenance against a
snapshot of durable TUF floors without advancing them, validates package metadata and the compiled
Apple identity, copies/reverifies the helper, and checks the latest floor before its fixed install-lock
command runs. Under the retained lock it repeats fresh provenance verification, commits floors and
rechecks the helper before calling installation work. Acquisition deadlines end before that work.

The committing trust verifier now rereads the durable floor before save and refuses a concurrent
advance, equivocation or disappearance. withPreparedRelease joins bootstrap, verified app/helper
assembly, native preparation and durable promotion, disposes the source candidate, and keeps the same
lock through the remaining installer callback. Cleanup/cancellation and failure ordering are pinned.

bootstrap-v2 passes 447 tests in twenty-seven files, CLI/protocol types and seven-file lint. Bootstrap
tests use explicit publisher/signature/transport seams with actual extraction, copying, durable records
and the real Go kernel lock. Existing real crypto fixture tests also pass. A separate rehearsal used the
actual Apple-signed helper's install-lock command, refused contention and successfully reacquired after
release. No vault or service opened. No live TUF or published release bootstrap is claimed.
AUTHOR-v19 binds the unreviewed candidate. Independent FULL review remains pending.

Next: pinned images, service adapter, default CLI/update/logs/onboarding, abandoned scratch recovery,
notarization and complete release acceptance. M7 integration, M6 playback and M8 providers/polish/dot
remain. Accepted source and preview4882 are unchanged; no new visual milestone. No usage check,
agent, branch, commit or push. The full app goal remains active and incomplete.

## October 7 — verified release promotion and reopening

The author installer now binds the assembly/native receipt hashes to an installer-owned release record.
Reopening reads bounded nofollow receipts against that separate anchor, checks the exact app/helper/native
inventories, validates helper metadata/version and native lock consistency, and invokes the compiled Apple
signature verifier. Rewriting payload-local inventories cannot authorize changed files.

Promotion copies into a private temporary release tree, verifies the copied contents, fsyncs files and
directories, renames to the digest-derived destination, then publishes its trusted record. Selection is
separate. A crash before anchor publication leaves the payload unselectable; fresh authenticated
preparation can recover an identical complete payload. Conflicting or corrupt destinations remain
untouched. Candidate disposal and user data are preserved. Crash-abandoned temporary copy cleanup
still needs an explicit policy; these directories are never eligible for selection.

promotion-v3 passes 376 tests in twenty files; CLI/protocol types and eight-file lint pass. The actual
disposable rehearsal promoted/reopened the signed eight-file helper package and 125 native files,
then selected only within its scratch state. The app manifest/provenance fixture is synthetic; this
is not a user installation, full release provenance check, notarization or service startup.
AUTHOR-v18 binds this unreviewed candidate and evidence. Independent FULL review remains pending.

Next: first-install authenticated helper lock bootstrap, pinned images, service/default CLI/update
and onboarding integration, notarization and full release acceptance. M7 integration, M6 playback
and M8 providers/polish/optional dot remain. Accepted source and preview4882 are unchanged.
No new visual milestone, usage check, agent, branch, commit or push. Goal remains active/incomplete.

## October 7 — native download and installation connected

The author installer now connects authenticated app metadata to bounded native archive acquisition
and native installation. Archive URLs are constructed from exact locked names/versions; the shared
HTTPS transport refuses redirects and uses no registry credentials or ambient proxy. Acquisition
snapshots the pins, verifies SHA-512, seals files read-only and removes temporary archives after the
consumer drains. Limits are 64 MiB per compressed archive, 512 MiB total and five minutes overall.

native-download-v2 passes 292 tests in fifteen files, CLI types and eight-file lint. Composition tests
reject changed locks before native code runs and verify cancellation cleanup. A separate real local
rehearsal streamed the six previously pinned archives through the new acquisition/installation path:
125 files, 19,698,667 bytes, Sharp 0.35.5 / libvips 8.18.7, successful native image roundtrip and final
inventory verification. That rehearsal used a local archive stream, not live HTTPS, and a synthetic
app manifest. It does not prove published release provenance or a complete user installation.

AUTHOR-v17 binds the unreviewed source and evidence. Native archive acquisition wiring is implemented;
persistent caching remains an optional optimization. Next required work is candidate promotion/recovery,
authenticated first-install helper lock bootstrap, pinned images, service/default CLI/update/onboarding
integration, notarization and complete release acceptance. Independent FULL review remains pending.
The app goal stays active and incomplete. Accepted source, preview4882 and runtime-payload-v12 stay
unchanged; there is no new visual milestone. No usage checks, agents, commits, branches or pushes.

## October 7 — verified native dependency installation

The installer author candidate now selects the exact Darwin arm64 dependency graph from authenticated
app metadata and installs pinned archives without npm lifecycle hooks. Separate extraction/copy limits
allow the 18,231,688-byte libvips dylib while keeping the ordinary app/helper limit at 16 MiB.
Every installed file is checked before and after a bounded Sharp pixel-roundtrip health check.
Failure, cancellation, mutation and existing candidate state are covered; no selected release changes.

The real local rehearsal installed six locked packages: 125 files, 19,698,667 bytes. Sharp 0.35.5
and libvips 8.18.7 passed the synthetic image roundtrip and all files passed a subsequent hash check.
Its app manifest is synthetic and the author lock has not passed published release provenance.
This verifies local native installation, not a complete user installation or clean-Mac release.

native-install-v3 passes 265 tests in fourteen files and CLI types; twelve-file lint passes.
AUTHOR-v16 binds the source and separate native evidence. FULL independent review remains pending.
Download/cache wiring, candidate promotion/recovery, first-install verified-helper lock bootstrap,
pinned images, services/default CLI/update/onboarding, notarization and release acceptance remain.
M7 final integration, M6 playback and M8 providers/polish/optional dot are still unfinished.
Accepted source, preview4882 and runtime-payload-v12 remain unchanged; no new visual milestone.

## October 7 — signed helper packaging and app assembly

The installer author candidate now stages the separate helper at the app's exact version/commit,
checks its package contents and platform, binds its executable hash to the app manifest, and calls
the compiled Apple identity verifier. App/helper assembly copies only verified inventories, checks
source bytes/identity during copying, re-verifies copied contents, and records an owned preparation
receipt. It changes no selected release or service; native dependencies and promotion remain next.

A real helper package was built from the signed keyd rehearsal binary and cached Go/dependency
licenses. Its eight-file offline npm archive is 7,415,540 bytes. Actual extraction preserves the
binary hash and passes the production Developer ID check. No service executed, no key exported,
and no artifact was published. Release provenance and notarization are still unverified.

assembly-v3 passes 233 tests in eleven files, CLI types and nine-file lint. The earlier large-Buffer
assertion timeout and the offline unused-module-metadata probe are recorded in RELEASE-ASSEMBLY-PLAN.md;
neither represents a successful live release check. AUTHOR-v15 binds this unreviewed candidate.
Runtime-payload-v12 remains unchanged because the default CLI/service installation is still unwired.

Next: verify/install native dependencies, promote prepared candidates with crash recovery, prepare
pinned images, wire services/default CLI/update/onboarding, and complete independent FULL review
and clean-machine acceptance. M7 integration, M6 playback and M8 providers/polish/optional dot remain.
Both the previous and current turns made concrete implementation/test/artifact progress. The app
goal remains active and incomplete; accepted source and preview4882 are unchanged. No new visual
milestone, usage check, agent, branch, commit, push or earlier denied operation was retried.

## October 7 — authenticated archive staging

The M9 author candidate now joins registry acquisition, fresh provenance verification, bounded
native Node extraction and exact staged manifest inventory. The untrusted attestation commit is
only a verifier input; compiled publisher/workflow/tag pins and real archive hashes still gate
access. Manifest version/commit must match authenticated provenance before the consumer runs.
No package code, lifecycle hook, service or dependency is executed by this path.

The extractor verifies a single gzip member, expanded size, CRC/ISIZE and compressed hash, then
validates the complete tar inventory before writing member files. It refuses unsafe paths, links,
case aliases, duplicate/conflicting entries, malformed extensions and excessive file/directory
counts. Cancellation is tested after real decompression starts, with cleanup after stream drain.

staging-v5 passes 181 tests in seven files, including an actual offline npm pack with a long path;
v6 CLI types and seven-file lint pass. The initial file-count test exposed excessive fsyncs before
rejection; inventory-first validation corrected it. Logs preserve the failure and the final suite
completes in 1.76 seconds. ARCHIVE-STAGING-PLAN.md records scope and the injected crypto test seam.
AUTHOR-v14 binds this unreviewed candidate. The actual runtime-payload-v12 is unchanged because
default CLI/service installation remains unwired.

Next: assemble immutable installed payloads and acquire/verify the separate signed keyd package,
then native dependencies, pinned images, services, update/default CLI and onboarding. Notarization,
clean-machine/interruption acceptance, FULL review, M7 integration, M6 playback and M8 polish/
providers/optional dot remain. The previous turn made signing/download progress and this turn
made staging implementation/test progress. The goal stays active; accepted source and preview4882
are unchanged. No new visual milestone, usage check, agent, branch, commit, push or denied retry.

## October 7 — registry acquisition and Developer ID signing rehearsal

The author candidate now downloads exact release packages into owned private storage, validates
SHA-512 integrity over actual bytes, fetches attestations independently and cleans up only after
requests and consumers drain. Acquisition is not publisher authentication: fresh TUF/Sigstore
verification and bounded archive staging must still be connected before any execution.

acquisition-v4 passes 52 offline tests in two files, CLI types and four-file lint. HTTPS is mocked;
file writes, identity checks and cleanup are real. Earlier formatter/type issues are corrected and
retained in logs. REGISTRY-ACQUISITION-PLAN.md describes bounds, cancellation and remaining wiring.
The existing runtime-payload-v12 remains unchanged because this helper is not CLI-wired yet.

Richard's authorized Keychain identity was re-confirmed, and a fresh offline arm64 keyd build was
signed with Developer ID Application: Richard Liao (87FD3FSZBG), hardened runtime and Apple's secure
timestamp. The real compiled-team verifier accepts it and rejects a byte-modified copy even when
that copy's declared SHA-256 matches. signing-rehearsal-v1/verify.json records the positive and
negative results. No key was exported, no service executed/installed, and nothing published.
Notarization, complete release provenance/installation and independent FULL review remain open.

AUTHOR-v13 binds this unreviewed candidate. M7 final integration, M6 playback and M8 provider/polish/
optional dot scope remain. Accepted source and preview4882 are unchanged; no visual milestone
changed. No usage check, new agent, commit, branch, push or earlier denied operation was retried.
The app goal remains active and incomplete.

## October 7 — authenticated roots and cancellable release verification

The installer candidate now refreshes Sigstore trust through pinned TUF metadata, checks persisted
role-version/hash floors, and verifies provenance inside a terminable worker. The parent waits for
worker exit before scratch cleanup and saves trust state only after successful verification.
Both CLI and runtime builds include the worker; its dependency inventory permits only builtin
external imports and resolves the optional debug-colour probe to an owned plain-output shim.

tuf-worker-v3 passes 267 tests in 20 files, four offline CLI checks, CLI types and 51-file lint.
Signed synthetic TUF repositories and actual worker lifecycle are tested; HTTPS transport is mocked
and live production TUF acquisition remains unverified. The new runtime-payload-v12 has 85 files
and 42 dependency notices; hashes and CLI/sandbox help/version probes pass. It is not a complete
release or user installation. TUF-WORKER-PLAN.md records scope; AUTHOR-v12 binds the candidate.

Next: registry/archive acquisition, native dependency installation, signed keyd/notarization,
service/default installer/update/onboarding wiring, clean-machine acceptance and independent FULL
review. M7 integration, M6 playback and M8 polish/providers/optional dot also remain. No screenshot
changed: preview4882 and accepted source are untouched. No agents, commits, branches, pushes,
usage checks or earlier denied native/HTTP/archive retries. The previous and current goal turns
made source/test/build progress; the full app goal stays active and incomplete.

## October 7 — real Sigstore verification

The author candidate now uses pinned Sigstore libraries for certificate, signature, timestamp and
transparency verification, joined to compiled localDot repository/workflow/tag/artifact policy.
A retained public npm attestation verifies offline; signed-content, certificate and transparency
mutations are refused, and the valid foreign publisher cannot pass localDot release policy.
A standalone compiled bundle runs with an empty environment outside the project and includes all
five dependency notices. One upstream package omitted its license, now retained from its verified
source commit with a pinned blob hash.

sigstore-verifier-v3 passes 198 tests in 13 files; v2 CLI types and 31-file lint pass. The earlier
failed mutation/notice assertions are retained and explained in SIGSTORE-VERIFIER-PLAN.md.
AUTHOR-v11 binds this unreviewed candidate. Fresh authenticated TUF roots, strict operation deadline,
release acquisition, real installation/service wiring and independent FULL review still remain.
The previous goal turn made source/test progress, and this turn also made implementation and actual
cryptographic/build-verification progress. The full app goal remains active and incomplete.
Preview 4882 and accepted source remain unchanged; no visual milestone or screenshot changed.
No new agents, commits, branches, pushes, usage checks, signing, installation or public release.

## October 7 — keyd verification and provenance policy

Added the staged-keyd hash/format/permission/Developer-ID check and a strict npm provenance policy
that binds archive hash, package, tag, workflow and commit. Native csreq parsing and codesign integrity
control/rejection pass; positive Developer-ID and Sigstore cryptographic acceptance remain unverified.
The Sigstore adapter is still required. Native test helpers now build from this checkout and clean up
instead of requiring a manually retained binary. release-verification-v3 passes 176 tests in ten files
and CLI types; v4 passes 23-file lint after a formatting-only correction. RELEASE-VERIFICATION-PLAN.md records scope and the literal requirement
argument correction. AUTHOR-v10 is the checkpoint for review, not accepted production integration.

Richard supplied Team ID 87FD3FSZBG, now pinned in the production verifier. His authorized Keychain
identity lookup found the matching valid Developer ID Application identity. Tron's configuration
enables hardened runtime and notarization; its temporary app is only ad-hoc signed. No private key
was exported, and actual localDot release signing/notarization is still unverified.
No new agent, branch, commit, push, usage
check, user installation, signing, publication or previous denied native/HTTP/download retry occurred.
No visual milestone changed. All test processes are terminal. This turn made source/test progress;
the full app goal remains active/incomplete and preview 4882 remains unchanged.

## October 7 — installer mutex and release selection

The shipping candidate now holds an actual kernel lock through an inherited descriptor and selects
releases by strict digest identities in atomic JSON records. A combined test uses the real compiled
keyd lock helper, filesystem journal and release pointer with simulated service effects. The Go lock
suite passes with race detection; install-layout-v1 passes 129 tests in eight files, CLI types and
17-file lint. Existing keyd argument/audit regression tests pass in a separately approved temporary
in-memory server run after an initial sandbox Unix-socket refusal. No user installation or service,
Keychain secrets, Docker, external traffic, or prior denied native/CLI HTTP/download retry occurred.

INSTALL-LOCK-LAYOUT-PLAN.md records the boundary: release provenance/signature verification and real
service adapters remain required before CLI wiring or accepted use. AUTHOR-v9 binds this candidate;
preview 4882 and accepted source remain unchanged. No new agent, branch, commit, push, usage check or
visual milestone occurred. All checks are terminal. This continuation made source/test progress;
the full app goal remains active and incomplete.

## October 7 — staging verification and update recovery author work

Added exact staged-package verification, an activation/recovery coordinator, and an atomic disk-backed
recovery journal. The targeted suite passes 108 tests across six files, including real temporary file
inventories and reopening an interrupted journal; service actions remain injected fixtures. This is
not a completed installer or real interrupted-update acceptance. INSTALL-TRANSACTION-PLAN.md records
interfaces and remaining verification. AUTHOR-v8 will bind the seven new source files after final
lint/type checks. The default CLI, production service adapter, release trust/signing, fresh installation
and independent FULL review still remain. Preview 4882 and accepted source remain unchanged.

Previous goal continuation made source/test/checkpoint progress. No new agent, branch, commit, push,
usage check or denied native/HTTP/download retry occurred. No visual milestone changed; no duplicate
screenshot was sent. All current checks are terminal, and the app goal remains active/incomplete.

# App completion progress

## Current shipping continuation — frozen dependency lock and first-run checks

The runtime build now writes a private npm manifest and shrinkwrap from the existing32-package sharp
lock graph. Six packages are mandatory for the supported Apple Silicon host, including the native
addon and libvips. Real offline fixture installations verify exact versions, root and packed-dependency
paths, platform filtering, missing-binary failure and suppressed lifecycle hooks. No registry traffic
or user installation occurred. Actual upstream archive validation and real sharp loading remain pending.

A read-only installer preflight checks macOS14+, native arm64 Node24+,12GiB disk and Docker Desktop's
engine/API/architecture/8GiB memory. Forty cases cover missing Docker on a clean Mac, low resources,
unsafe paths and bounded/cancellable mocked requests. It creates no installation directories and is
not wired into the default CLI until the verified installer and services are ready.

runtime-lock-preflight-final-v1 passes105tests/10files,10-file lint and CLI types. runtime-payload-v11
contains71 files (7,426,603bytes),29 notices and32 pinned runtime packages; every file hash plus retained
CLI/sandbox help/version checks pass. AUTHOR-v7 records the unreviewed candidate. Trusted release
metadata/signing, actual dependency verification/install, installer transaction, services, updater,
onboarding and independent acceptance remain. Preview4882 and accepted/frozen sources are unchanged.

## Current shipping author continuation — self-contained patched sandbox

The runtime now includes its patched sandbox CLI, version manifest, Java proxy agent, license and
modification notice. Packaged execution resolves that local CLI and refuses missing/linked artifacts;
development dependency resolution is unchanged. The build checks all27 patch hunks across7 files.
An optional supplied-archive verifier checks pinned SHA-512, applies the exact source patch in memory,
and compares all runtime source/asset bytes. Actual upstream verification remains blocked and false.

runtime-payload-v10 contains69 files (7,408,883bytes) and29 bundled-dependency notices. Its file hashes,
imports and CLI/sandbox help/version checks pass outside the checkout. Build-time import checks reject
undeclared dependencies; WebSocket optional native-addon lookup is disabled, with multilingual masked
frames and invalid UTF-8 tested in memory. sandbox-package-v4 passes86 checks/8files plus4 offline CLI
checks (the4 blocked HTTP cases stay skipped),12-file lint and the daemon/harness type checks pass.
AUTHOR-v6 records this checkpoint. This is local author evidence, not independent review or a release.

The pinned upstream download request failed automatic approval review503 before execution and was
not retried or bypassed. Image-processing dependency lock/verification, clean frozen build, trusted
release metadata/signing, installer/services, updater and onboarding remain. Existing native/HTTP
acceptance and independent review gates also remain. Four app areas remain overall; preview4882,
accepted source, frozen review inputs and the last Telegram visual update are unchanged.

## Current shipping author continuation — assembled runtime payload

The shipping draft builds the real daemon, CLI and UI with installed paths for the browser security
policy, built-in office skill and UI/viewer assets. The payload includes24 dependency notices and
passes its file allowlist and hygiene scan. Actual build output exposed and corrected the notice-path
fixture mismatch and CommonJS checkout-path leakage. Relocated compiled probes serve UI/notices
in-process and use the exact unchanged policy bytes; a missing policy prevents specification loading.

runtime-payload-v7 contains58files/6,704,191bytes, verified against its hash inventory; its real CLI
prints help/version outside the checkout. Current scoped tests:84checks/10files, daemon/CLI types,
24-file lint and4 compiled CLI offline cases pass. Existing four HTTP cases/native/review gates remain
unverified; no retry or bypass. AUTHOR-v5 records the candidate. Full trusted package/dependencies,
installer/services, updates and onboarding are still unfinished. Preview4882 and Telegram12139 remain
unchanged because this step changes packaging, not the visible UI. Four overall app areas remain.

## Current shipping author continuation — archive and CLI build

Actual npm-produced archives now pass a bounded content/metadata audit with integrity matching npm's
receipt, executable-launcher enforcement and unsafe-file refusal. The operational CLI now builds as
a standalone bundle exposing help/version/open/stop/doctor through existing daemon clients. A real
build caught developer paths in dependency comments; the build removes those comments and retains
legal notices. These are isolated author changes, not a published package or installed app.

Current evidence:36 package/dispatch cases,23 archive-parser cases,4 compiled offline process cases,
CLI types and owned lint pass. Four additional HTTP process cases are UNVERIFIED: the sandbox refused
loopback binding, then automatic approval review returned402 before the requested run executed.
AUTHOR-v4 records the candidate. Full assembly, installer/services, update/onboarding, provenance and
signing are still unfinished. Independent FULL review and M7 native-v22 remain blocked as recorded;
there was no retry, bypass, new agent/commit/push, usage check, preview change or redundant screenshot.
Four app areas still remain: M7 acceptance/integration, M9 shipping, M6 QuickTime, M8 providers/polish/dot.

Core branch: `feat/codex-complete`; credential integration: `codex/keyd-integration`. Source handoff: `origin/planning:jobs/HANDOFF-CODEX.md`. The controller is building locally with Docker; cloud-only environment restrictions do not describe this Mac. No remote branches have been pushed by this continuation.

## Shipping author continuation — package inventory contract

The isolated shipping draft now restores the WIP release schema and adds a bounded package audit:
exact publishable paths, actual file sizes, regular/no-link files, binary metadata hygiene and
required licenses. Two regressions reproduce original prototype omissions. The full protocol
suite plus package checks pass210 cases in24files, with protocol types and owned lint passing.
The protocol tool-table expectation now includes the existing approved-upload tool. This changes
no runtime tool authority. `check:pack` is wired for the future generated package tree; no npm pack,
archive verification or publication ran. AUTHOR-v3.json binds the added source and receipts.
Installer, services, updater, onboarding, provenance/signing, actual package/clean-Mac acceptance
and independent FULL review remain open. Preview4882 and accepted integration remain unchanged.

## Previous shipping author continuation — one-use sign-in links

In the isolated M9 shipping draft, daemon startup prints a one-minute single-use #code URL.
Same-origin browser exchange returns authority once; fragment removal precedes requests, uncertain
exchanges are not repeated, and delayed/invalid links cannot replace an existing authenticated
tab's newer token. The development `pnpm --filter @localdot/daemon open` command prints fresh links
without creating, rotating or exposing reusable tokens. The store, routes, mounted App, bounded
transport, private token read and existing UI/doctor paths have focused offline tests. Build and
test receipts live under /private/tmp/localdot-m9-ship-draft/logs; AUTHOR-v2.json binds the source.
The final focused suite passes152 checks in10files; daemon/web/e2e types, owned lint and production
UI build/license-notice generation pass. These tests are offline/in-process/jsdom, not native acceptance.
This remains unreviewed author work. Real browser/runtime/CLI-process acceptance, FULL review,
installer/updater/onboarding/release rehearsal and integration are open. Preview4882 is unchanged.
M7's pending native-v22 command was not retried after approval review returned402; usage checks
remain stopped. The four remaining app areas are still M7 acceptance/integration, M9 shipping,
M6 final QuickTime verification and M8 polish/provider integration/optional vivid3D dot.

## Previous M7 author draft — October 6, 2026

The transfers draft now includes shared desktop-browser preparation for both agent and scripted
tasks. Preparation precedes recording and keeps ownership through Stop or uncertain helper exit.
The complete daemon regression passes 2011 cases in 188 files. The built runtime image's actual
Chromium profile checks pass six cases, including launcher aliases, task isolation and recovery.

The last complete native two-cell probe passes 26 checks with real desktop/browser containers: download
quarantine, bound release with exact bytes, approved upload into a real file chooser, manual
sign-in, two separate unattended recordings, Stop/Resume and persistent signed-in-browser cookies.
It uses synthetic local pages and a local proxy fixture; it does not establish real-provider or
real-keyd policy acceptance. The added lost-reply check confirms that a committed download is
reconciled with the same transfer ID, zero retransmitted bytes and no duplicate file.
Generation replacement and Stop now interrupt an actual desktop write, drain the transfer and
leave no destination file. Resume cannot complete the cancelled write. Generation retirement
uses the physical user browser grant without requiring a separate manual-takeover request;
old download scopes remain revoked. Screen cleanup awaits the central Stop's confirmed receipt
instead of racing its freeze with another physical stop. Unconfirmed containment still falls
back to stopping the computer. Native upload cancellation and lost-reply checks remain open.
Ordinary successful completion now has a separate, fully drained path: it retires the browser and
recorders while preserving the running desktop. Stop can still upgrade cleanup to containment;
uncertain cleanup contains immediately while retaining every physical drain. A regression first
reproduced the unintended desktop shutdown. The native check now also verifies that a completed
task leaves the desktop executable and its browser profile reusable.
The private preference migration fixes Chromium's automatic download popup obscuring
the page, while preserving cookies and unrelated settings. Linux filesystem checks pass 17 cases;
browser regressions pass 1100 cases in 63 files, with browser types and owned lint passing.
The full-app check reads the released file from the real quarantine store and verifies the
390px manual-control layout. Local display-name metadata now fixes the embedded-viewer manifest
requests and is preserved on extraction. The latest native run has zero console errors, failed
network requests or external requests; all 23 viewer route checks also pass.

The [browser workspace guide](browser-workspace.md) describes the implemented controls. These
changes remain in the isolated author draft. Independent FULL review stopped on a helper credit
error and remains unfinished; there is no accepted-source integration or preview4882 update.
Four app areas remain: M7 final acceptance/review/integration, M9 packaging and fresh setup,
M6 final QuickTime acceptance, and M8 polish including the optional 3D dot. The character avatar stays an
optional local customization. No release-ready claim or reliable release ETA is established.

## Earlier author snapshot — October 6, 2026

Two-screen Replay and export are now implemented in the isolated draft. Recording routes validate
the chosen screen and serve its own bytes; session cards/indexes track both recordings. The screen
selector preserves playback time and preferences, fences retired media messages and isolates
overlays, thumbnails and comparisons. Export freezes the selected track and its privacy gaps.
All three real Chrome acceptance checks pass through the production daemon: decoded track
selection at a shared time, playable browser MP4 export with private intervals omitted, and a
missing browser recording that never falls back to desktop. This uses local synthetic recordings,
not a native signed-in-browser/full-provider acceptance. The accepted checkout remains unchanged.

The browser session draft now has a live browser viewer, separate status feed, selected-screen
stage/manual-input binding, screen-aware overlays and the agent switch_screen tool. Native Ctrl+L,
local bilingual login and both recording tracks pass in the actual Retina Linux browser. Final
regressions pass: 1815 daemon, 1006 browser and 748 web cases, workspace types, lint and production
web build. The actual native probe passes16 checks and its temporary resources were removed.

This work remains in the isolated author draft, not the accepted integration. Full-app native browser
visual acceptance and the cohesive independent review are next. Download
quarantine, desktop ephemeral cookies, M7 final acceptance, M9 shipping and M8 polish remain. The
separate Dot preview is preserved and not integrated. See the draft's IMPLEMENTATION-NOTES.md for
source-bound receipts and exact continuation instructions. Historical entries below describe their
own earlier checkpoints, not the present state of this draft.

## Verified

### Latest acceptance snapshot — October 5, 2026

Owned browser navigation has passed its independent FULL implementation review and single
interface/test-plan review with no findings. All41 author cases,9 retained independent cases
and62 unchanged initialization/reload cases pass. Four compiling semantic mutants are caught
with positive controls. Two source-bound scale2 Chromium witnesses each pass43 checks,
including navigation and cancellation during a committed document whose load never finishes.
The completion helper correlates the owned session, root frame and acknowledged loader,
checks the final frame, and retires ambiguous operations. Production runtime assembly,
the admitted control-lease adapter and authenticated HTTP navigation route remain open.

M5 safety/control is accepted and integrated. The approval card uses a viewport-fixed body
portal, scrolling contents, and a footer that retains its action buttons. The real Chrome
acceptance checks confirmed unchanged workspace geometry and visible actions at ordinary and
400px viewport heights. The earlier layout complaint is repaired in the accepted integration.

M6 Replay has 15 of 16 implementation tasks accepted. Task15 export passes all five Chrome
checks, including privacy, cancellation, deterministic rendering, and a two-hour export;
its LIGHT review passed with no findings, and QuickTime playback remains open. The reviewed
export is integrated without a new commit. Task16 now passes all four real-cell
checks: unattended recording, screenshot-matched playback, Jump to live, and decoded MP4 export.
The full host suite passes 3,232 checks in 338 files with four workers. Workspace types and lint
pass. The full Docker retry passes 78 checks in 12 suites, with 14 explicitly gated checks skipped.
Task16's single LIGHT review and correction round are complete; all 30 scoped checks pass.
The broader browser failures are resolved by scoped runs: the active-composer fixture, both
pixel-oracle scales, the live multi-app sequence, and both viewer-isolation scenarios pass.
The added recorder scenario advances its fragments during every frozen-viewer window and
finalizes without gaps. QuickTime playback is the only remaining M6 acceptance item.
See `docs/replay.md` and `docs/measurements/2026-10-replay.md` for user instructions and measured
results. This snapshot supersedes the older implementation notes below.

M7's first security component is accepted: strict screen/control schemas and the browser's
process-bound, revisioned control lease. It fences takeover synchronously, drains outstanding
work, refuses stale hand-backs, and keeps timed-out or stopped instances closed. Independent FULL
review found no Critical, Important or Minor issues; 51 cases pass, and six compiling security
mutants are caught with positive controls. This is a foundation component. Complete browser startup,
authenticated handlers, cell isolation, two-screen integration and
quarantined transfers still require implementation and end-to-end acceptance. The main app does
not yet expose a signed-in browser. The private CDP connection, target registry and bounded
runtime primitives are integrated as described below; complete runtime assembly remains open.

The browser's private native-input adapter is now accepted after FULL review and one scoped
correction. Its strict command allowlist, inert argument capture, finite deadlines and terminal
failure fencing pass457 distinct TypeScript cases including every retained reviewer assertion.
Four Python cases validate the browser-only window-discovery fallback. The real Linux browser
passes12 checks for the full2560×1600 window, stream authentication, actual Unicode/key/mouse
input and complete process drain after cancellation. The production image and service still need
assembly. The default app avatar remains
optional. The reviewed fluid-orb package is staged separately for M8, after M9 shipping work.

The real handback cleanup component is now accepted after FULL review and one scoped correction.
It clears X selections and cut buffers, privately detects filled password/OTP fields across
frames and shadow trees, reloads affected owned tabs, and refuses agent control if secrets
persist. Irrelevant INPUT-only attributes cannot hide a protected textarea. Repeated root
navigation refuses the handback, and the three-second reload deadline also covers a missing
acknowledgement. All509 TypeScript cases and7 Python cases pass with reviewer fixtures retained.
The real Linux fixture passes18 checks, including the unusual textarea, actual selection
clearing, persistent-secret refusal and process drain. Scoped FULL review has no remaining
findings and catches all four compiling correction mutants.

The private screenshot adapter is now accepted after FULL review and one scoped correction.
Its ninth supervised worker captures the X display into bounded1280x800 WebP frames through a
private binary pipe. Capture has a single pending request, finite deadlines and terminal failure
fencing. Cleanup exceptions cannot bypass authority fencing, promise settlement or independent
pipe-retirement attempts; reentrant closure cannot publish a completed frame. All553 TypeScript
cases and15 Python cases pass with the original and scoped reviewer fixtures retained. Both real
Linux display-scale probes independently decode two frames and verify cancellation followed by
whole-runtime drain. The scoped review passes98 independent TypeScript cases,8 Python cases and
catches three compiling correction mutants, with no remaining findings.

The native page geometry component is now accepted after FULL review and one scoped correction.
It binds an owned root document to native Chromium page bounds and focus, then maps points through
zoom, scroll and display scale. Rounded native points stay inside the measured page; rounded CDP
hit coordinates stay inside the translated document viewport. All595 TypeScript and24 Python
cases pass, including unchanged original and scoped reviewer fixtures, along with browserd and
protocol types and lint. Scoped review passes38 cases and catches all three compiling correction
mutants with eight intended assertions. Real Linux probes pass27 checks at each display scale,
including actual clicks at125% zoom, resize and12,000px scroll, boundary refusal, decoded captures
and full process drain. A separate admitted-action witness verifies Stop releases the pending
action lease before whole-runtime drain, avoiding a shutdown dependency cycle. Passive geometry
does not grant input authority.

The guarded browser input owner is now accepted after FULL review with no findings. Click, move,
scroll, allowed keys and paced Unicode typing require a current control lease, owned document,
fresh page geometry and protected-field checks. Typing rechecks focus and secrets for every
character; raw native events confirm delivery. Cancellation also releases a stalled progress
consumer. All664 TypeScript cases pass with the unchanged22-case independent fixture, browserd
and protocol types and lint; the existing24 Python cases pass. The review catches three compiling
semantic mutants with passing positive controls. Real Linux probes pass30 checks at each display
scale, including Chinese/English text, secret-focus changes, chrome refusal and Stop during an
admitted native character followed by complete process drain. Sequential page observations do
not guarantee atomicity against page mutation. HTTP/service authorization, output masking,
production-image assembly, cell lifecycle, quarantined transfer and two-screen application/Replay
acceptance remain open; the signed-in browser is not yet exposed by the main app.

Browser observation and output masking are accepted after FULL review and a scoped correction.
Editable fields, embedded content and browser chrome are masked before image encoding. Names
derived from editable descendants or aria-labelledby references are suppressed, including
duplicate IDs and cycles, while unrelated public labels remain visible. Filled protected
fields and stale geometry refuse observation. The original reviewer regression fixtures and
six additional scoped cases are retained unchanged. Final integration passes748 TypeScript
cases in44 files,36 Python cases, browserd/protocol types and lint. Independent scoped review
passes84 TypeScript and12 Python cases; three compiling semantic mutants fail their intended
assertions with passing positive controls. Real Chromium probes pass39 checks at each display
scale, including decoded masked frames, zoom, resize, scrolling, editable-derived names and
Stop during capture followed by complete child-process drain. Observations remain sequential;
this is not a guarantee against arbitrary page mutation or a universal secret classifier.
HTTP authorization, production runtime assembly, cell lifecycle, download quarantine and
two-screen application/Replay acceptance remain open. No browser route is enabled in the app.

The authenticated browser HTTP component is accepted after FULL and single-plan review with
no findings. Exact bearer authentication, bounded bodies, opaque tab replies, shared input/
observation admission, cancellation and physical-Stop acknowledgements have executable checks.
The11 independent reviewer cases are retained unchanged; final integration passes794 TypeScript
cases in46 files,36 Python cases, both type checks and lint. Independent HTTP review passes46
cases and kills three compiling semantic mutants with passing controls. This establishes the
service boundary only: production startup/image/gate assembly, navigation routes and main-app
browser integration remain open. No browser route is enabled by importing this component.

- M1 live desktop, restart/recovery, authentication and narrow layout. Real browser acceptance passes. Both chroma modes maintain 61–62 delivered frames per second on the development Mac; see `measurements/2026-10-stream-2x.md`.
- M2 protocol timing and deterministic pointer math (commit `368c61f`).
- M2 compositing at both scales: zero torn frames; see `measurements/2026-10-compositor.md`.
- M2 XTest input, raw XI2 timestamps, window activation, Unicode typing, DAMAGE settle detection and Chromium launcher: eight real Docker checks pass.
- Input cancellation, activation refusal, body limits and encoded launcher-path refusal were pinned against failing implementations before fixes. The desktop service stops paced typing on response cancellation.
- M2 perception: real terminal and Calc geometry/actions pass; Chromium elements match their pixels within 1 px maximized and restored. Password focus reached by Tab is identified even with the pointer over a non-secret button.
- M2 action gateway, clock mapping, event/frame storage and multi-app puppet are implemented. Regressions pin secret labels, unknown focus, Stop during target lookup, viewer backpressure, bounded Docker calls and startup while Docker is unresponsive.
- The two-viewer desktop check passes: the second viewer continues at 14.6–16.4 fps while the first is suspended, and the first recovers after resuming. Shared viewers do not replace the controller.
- Part 4a's credential service is implemented through Task 17, including final rotation and inspection corrections. All 13 Go packages pass the race detector. See `measurements/2026-10-keyd-final.md` and the preceding keyd measurements.
- The integrated desktop and keyd checkout passes 622 host checks in 83 files, all 13 Go packages, workspace type checks, lint and hygiene. This establishes the integration base, before Part 4b wiring.

## Earlier implementation notes

M2 is complete: worker overlays, live timeline, pixel oracle and production-path calibration pass real-browser acceptance. All six 500-trial compositor-on groups have zero misses, all six compositor-off reference groups pass their unchanged gates, the separate 200-trial release control passes, and both screen-scale pixel-oracle projects pass. Earlier failed measurements remain recorded. See `measurements/2026-10-ring-onset.md` for timing, limits and raw evidence.

M3: Part 4b Tasks 1–16 are complete, including production daemon wiring, credential-use event logging, the Stop/resume backend, the Theatre key sheet, Paused/Resume controls and inline key-use history. The completed M3 acceptance baseline passed 943 host tests in 110 files. Six real-service client/route tests, two real Docker API tests, five certificate/proxy image checks, nineteen desktop image checks and five orchestrator checks against real Docker/keyd have passed. A real desktop passes all eleven boot checks, crash recovery, concurrent Stop/Start, session freeze/resume with fresh surrogates and removal. The production daemon also passes sealed key save/list/delete, offline-state and restart smoke checks; the real browser passes desktop creation, Stop/Start, daemon restart, narrow layout and removal with keyd connected. The form's real WebCrypto client recovers from a credential-service restart between sealing and saving, sending only ciphertext and binding metadata. The proxy and boot-probe bundles pass smoke checks under Node 24.21.0 in the actual desktop image. The key sheet passes three real Chrome acceptance checks: ciphertext-only save/list/delete, a 375px layout with long names and reduced motion, and offline state. Secrets clear before submission and on closing/hiding the page; shared mutation locking prevents save/delete races. The real Chrome/Docker flow now verifies key-use rows, Stop freezing, Resume restoring fresh live frames, repeated Stop and offline Resume refusal. Frozen desktop images remain visible, and phone-width controls fit. Sixteen real-cell egress checks now pass: direct and private-network bypasses are blocked; proxy tokens are cell-bound; upstream authentication independently proves key substitution; bound and unbound TLS, runtime trust, audit attribution and deliberate missing-CA failure/recovery are verified. All 943 host tests and workspace types pass under Node 24.19.0. The five real-cell canary/Stop checks also pass, including clipboard process memory, raw and encoded writable files, final drained logs, immediate revocation before Resume, frozen traffic and fresh credentials on Resume. Final combined acceptance passes: six real-keyd checks, 31 Docker checks and seven Chrome checks, including the multi-app Theatre demo. CI now runs real-keyd and scanner fixtures on Ubuntu; README documents startup, key scopes, Stop/Resume and recovery. The opt-in compositor measurement was skipped in this combined run; its earlier measured results and pending M2 calibration are tracked separately. Detailed evidence is in `measurements/2026-10-keyd-integration.md`.

M4 agent backend Tasks 1–12 are implemented and reviewed: protocol/events, durable inbox and transcript, provider capabilities/pricing, bounded desktop tools, screenshot freshness, memory/settings, daemon-owned sessions, isolated brain containers, brain transport/model adapters, the conversation loop, and the production brain entrypoint/build. The integrated brain passes 120 tests, workspace types, production bundle build, lint and repository hygiene. Task 10's large-history recovery and Task 11's event-send cancellation corrections both passed independent scoped review. The daemon runner/routes and real-container acceptance remain active; Task 14 host end-to-end acceptance is now integrated and passes all four real-wire cases. Tasks 13, 15 and 16 remain in the backend. Theatre chat and ChatGPT integration are still required. See `measurements/2026-10-agent-foundations.md`.

The Keychain/Stop-lock carry is verified: operations share a five-second deadline, stalled storage does not hold revocation, queued credential/task requests cannot restore access after Stop, and publication cannot reopen a closed cell. All 13 Go packages pass with the race detector and the real macOS Keychain fake-key round trip enabled. Fourteen storage and twenty-five daemon kill-switch mutations are caught. The real Docker session Stop test completes within its five-second bound; Task 15 now also verifies the broader canary and Stop path.

The independent avatar harness is available on the user's private Tailscale network. The user's requested size, state/reaction and multilingual voice repairs are committed on the avatar branch as `d523024`: larger portrait/close-up framing, visible state/reaction feedback, stable repeated English/Chinese voice, bounded output and replacement/Stop behavior. The repair task reports all 19 live language samples accurate under local recognition, repeated English/Chinese byte-identical, no looping observed, 424 TypeScript tests and 112 Python tests passing. Desktop/phone controls and actual Spine states/reactions were checked live; the milestone screenshot reached private Telegram as 12067. The separate avatar task has since refined gesture transitions in commit `78edae7` and reports 431 TypeScript checks passing. GPU calibration has finished. It now reports hands-free fake-microphone transcription, reconnect and microphone-denial fallback passing; recorded audio/video skew is still being checked. Microphone mode remains experimental and off by default; agent conversation and final app integration are still required. The user's preview stays live.

## Remaining scope

M7's private browser connection component is accepted and integrated: the strict command guard,
bounded UTF-8 pipe and request broker, including callback admission, mandatory failure cleanup
and finite listener delivery. Initial FULL review findings were corrected; scoped FULL review
passes with zero findings and 198 distinct passing cases. Browserd is registered in the workspace,
and its tests are included in the normal host suite. This remains preparatory service code;
the signed-in browser runtime, tools, quarantine and two-screen integration are still in progress.

The private browser target registry is also accepted: it owns opaque tab/document identities,
recursively protects attached frames before resuming them, revokes stale document and node
permissions, and bounds initialization work during tab churn. Three Important initial FULL
findings were corrected and scoped FULL review passes with zero findings. All 256 distinct
component cases pass; the separate sandboxed Chromium probe passes seven checks including
cross-site frame attachment, DOM/accessibility access, navigation and tab closure. These checks
do not complete the browser runtime or the full M7 acceptance.

The bounded runtime primitives are accepted: fixed child commands with explicit secret-free
environments, a stream front that authenticates HTTP and WebSocket requests, and owned process
groups with synchronous failure fencing, bounded retirement and an independent control/input
drain. The initial FULL review's Important pipe-lifetime finding was corrected. Scoped FULL
review passes with zero findings; all325 distinct cases pass, and four compiling correction
mutants are caught with eight positive executions. Fourteen real Linux process checks pass,
including normal stdio/CDP EOF while the child is alive and subsequent group retirement.
Combined readiness, HTTP/native-control integration and the production browser image remain
open. This is not whole-runtime or M7 acceptance.

Private runtime preparation is also accepted and integrated. It validates non-root directory and
profile ownership, preserves persistent profile data, passes the stream token only on utility
stdin, creates a private password hash and fresh NSS trust, and bounds utility output/lifetime.
FULL implementation and single plan reviews pass with zero findings;363 distinct cases pass,
including12 independent boundary cases. Four compiling semantic mutants are caught with eight
positive executions. Nine real Linux preparation checks pass, including exact CA trust and invalid
CA refusal. Combined startup and application-level browser control still require implementation.

Richard rejected the first staged 3D orb's visual quality after its technical checks passed.
Its immutable package remains historical; it must not be integrated as the final visual design.
The avatar subagent is reworking it toward the requested Grok/ChatGPT voice-orb references, using
soft cloudy depth and a smooth outline. The new light/dark checkpoint was inspected and its dark
screenshot delivered to Richard's confirmed private Telegram as12124. Final motion/state checks
and the new LIGHT review remain pending. Production placement, preference/state mapping,
dependency notices, whole-app Off verification and an explicit local-development custom character
adapter remain for M8. The avatar stays optional and independent of core controls; no character
pack is bundled by default. Earlier screenshots12122/12123 show the superseded first3D iteration.

Finish M6 replay acceptance and reviews; M7 signed-in browser and download quarantine; M9
shipping/onboarding/update/doctor; M8 premium polish, avatar/voice integration and additional
providers. M9 precedes M8. The independent avatar preview is not final app integration.

Representative screenshots are delivered to Richard’s private Telegram through OpenClaw. M1 was delivered as Telegram message 12057, M2 previews as 12058/12059, the playable avatar preview as 12062 and its private Tailscale URL as 12063 (2026-10-02). The key sheet and Paused/Resume screenshots were delivered as private Telegram messages 12064 and 12066 (2026-10-03); the avatar repair task delivered its first verified preview as 12065. Test artifacts remain local and ignored. The final credential-milestone screenshot was delivered to the explicitly confirmed private chat as Telegram message 12068; the completed desktop interaction milestone was delivered as 12070. Completion of the entire app is not yet claimed.
