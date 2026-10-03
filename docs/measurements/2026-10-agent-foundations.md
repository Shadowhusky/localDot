# M4 agent foundations — 2026-10-03

## Tasks 1–3

- Protocol defines the tool table, desktop tool wire, events, model binding,
  unified diffs and crash-safe inbox identities. Runtime persistence and generation
  enforcement belong to later agent tasks. Diff output preserves final-newline
  changes and bounds the Myers trace before falling back to a replacement hunk.
- Provider registry/catalog preserves existing first-class and compatible providers.
  Missing one price makes the pair unpriced; no silent billing clamp is allowed.
  Own-only lookup survives saved-catalog round trips, and explicitly non-text
  models are excluded. Model-point conversion rejects out-of-range coordinates.
- Shell runs a login shell with stripped inbound desktop credentials, shared
  byte caps, streamed UTF-8, deadline and active-call cancellation. Successful
  foreground completion drains inherited pipes for at most 250ms and preserves
  background applications. Failed group cleanup produces a typed error for the
  later daemon/runner Stop path, never ordinary success.
- Process-group termination has the desktop user's authority. Elevated or detached
  descendants require global Stop's whole-cell freeze; real-container acceptance
  of that integration remains required. Home resolution is a current path check,
  not race-free descriptor confinement or a shell sandbox.
- Integrated acceptance: 142/142 tests in 16 files, workspace types, lint/hygiene
  pass under Node 24.19.0. Shell's five seeded regressions and provider's price,
  clamp and saved-catalog lookup regressions are caught. Independent shell review
  plus scoped finalization checks are complete.
- Commits: `8cc5c81` protocol; `bee337e` providers; `631ff8a` shell and the combined
  lockfile importers. Evidence: `/tmp/localdot-m4-tasks1-3-{tests,types,lint,hygiene}.log`.

## Task 6: screenshot freshness

Known changed targets cancel before desktop input and return the newest full
frame. A small peripheral animation may be tolerated only after a second frame
100ms later: center 24×24 and complete accessibility target bounds agree pairwise;
only exact dynamic pixels are masked; static change is ≤2% and union ≤20% of the
96×96 region at 24-luma tolerance. No blanket animated-target exception exists.
Both device scales map bounds back to model pixels.

The existing optional best-effort basis contract is retained for unknown basis
or failed initial observation/decoding. Once change is known, a missing second
frame fails closed. Stop is checked around asynchronous boundaries. Comparisons
run after cursor travel/stream readiness, adding an observation's latency for
model actions. If the stream stalls during comparison, the gateway holds input,
then compares again against the original model frame after recovery.

- 38 gateway/freshness tests pass. Seven seeded regressions are caught by their
  intended pixel/dispatch assertions, including four tests that fail when the
  final stream-hold check is omitted. Full independent review found that race;
  its fix passed independent scoped review with no remaining Important finding.
- Integrated daemon typecheck, lint and hygiene pass; the pinned sharp 0.35.5
  dependency is declared explicitly. Existing calls without a model basis keep
  their normal path. Task 8/runner will own generation and takeover enforcement.
- Evidence: `/tmp/localdot-m4-task6-draft/fix-tests.log`,
  `mutations/evidence.json`, `stream-mutation-evidence.json`, and
  `/tmp/localdot-m4-task6-scoped-review/evidence.json`.

## Task 4: desktop file and browser routes

The desktop now exposes authenticated text read/write/edit/list, raw file transfer
and Chromium read/navigation routes. Text reads inspect only the requested prefix
and any necessary UTF-8 continuation bytes, so a large log remains readable without
loading the complete file. Writes and exact single-match edits publish atomically;
raw transfers enforce actual byte counts, cancellation and partial-file cleanup.
Browser calls have explicit deadlines and preserve same-URL reload behavior.

- The 282-test, 33-file baseline passed. Independent full review found a large-file
  prefix regression; its fix passed 41 affected checks under independent scoped
  review with no remaining Critical or Important finding. Nine baseline and two
  prefix-fix seeded regressions were caught by their intended assertions.
- Protocol/desktop types and the actual desktop bundle pass. Integrated workspace
  types, lint and hygiene pass after installing the final 14 reviewed source files.
- Shell cleanup uncertainty crosses NDJSON as a strict typed failure, never normal
  completion. The later runner must invoke whole-cell Stop before retrying an
  interrupted or ambiguous command. Descriptor-level ancestor confinement is not
  claimed; home-path resolution retains its documented race limitation.
- Evidence: `/tmp/localdot-m4-task4-draft/manifest.json`, `checks/`,
  `integration-{types,lint,hygiene}.log`, and
  `/tmp/localdot-m4-task4-review/scoped-rereview.md`.

M4 is not complete. Brain loop, chat and optional ChatGPT remain.

## Immutable task pricing prerequisite

The existing keyd task account now owns a frozen route/model/price/output-cap
snapshot. Reopening the same task preserves its spend and any later explicit
budget increase. Settings changes cannot replace that policy through shared model
tables. Requests capture their task attachment before reading a body and retain
that identity through budget waits and final admission. Retargeted key bindings
are rejected; changing only the secret value can recover with fresh credentials.
Ledger v2 retains snapshot metadata and reads valid legacy v0/v1 accounts.

Independent full review passed with no Critical or Important finding. Its 103
llm/keys tests and nine gateway/admin tests pass, and five targeted mutations are
caught. Integrated `go test -race ./... -count=1 -timeout=150s` passes all 13 Go
packages. Shared TypeScript integration checks also pass. Persistence retains the
existing process-restart guarantee; parent-directory fsync/power-loss durability
is not claimed. No real model/provider calls were needed.

Evidence: `/tmp/localdot-m4-task-price-snapshot-draft/integration-race.log`,
`/tmp/localdot-m4-task-price-snapshot-review/review.md` and its `mutations/` reports.

## Task 5: daemon desktop-tool client

The daemon owns a dedicated transport with explicit operation deadlines through
body completion. Shell output has strict bounded NDJSON and exactly one terminal
result. Lost/interrupted responses and consumer failures preserve execution
uncertainty; confirmed cleanup failure has a separate typed error. The runner
must perform Stop containment before any automatic retry or replacement.

Raw transfers stream within actual-byte caps, retain cancellation/deadlines after
headers and require complete source EOF plus an exact upload acknowledgement.
Keyd adapters preserve omitted/zero budgets, stable task identity and distinct
immutable initialization versus explicit ceiling updates. Client-owned dispatchers
close with their lifecycle.

Full review found output-consumer error misclassification and premature upload
success. Both fixes and the strict-record/late-body corrections pass final scoped
review, including the undefined-rejection edge and retained independent repros.
Seven targeted regression mutations fail at their intended assertions. Integrated
acceptance passes 61 tests in four client/protocol files, frozen offline install,
workspace types, lint and hygiene. This includes actual owned TCP and Unix-socket
fixtures; no paid models or production credentials are used.

Evidence: `/tmp/localdot-m4-task5-draft/integration-{tests,types,lint,hygiene}.log`,
`fix-mutations/evidence.json`, and
`/tmp/localdot-m4-task5-review/final-scoped-review.md`.

## Task 7: memory, skills and model settings

Private host stores now provide bounded memory/history with undo, validated skill
folders, explicit bounded catalog refresh and strict model settings. Task roles
resolve to immutable bindings and pricing snapshots. Custom compatible endpoints
require explicit manual prices; public catalog namespaces cannot supply a price
for an unrelated endpoint. Memory replacement validates Unicode and the complete
journal before publishing any change.

The 73-test baseline passed. Independent full review found two Important issues
in malformed memory replacement and custom-endpoint pricing; both are fixed.
Independent scoped review passes 35 affected cases with no remaining finding.
Eight original and two corrective mutations fail at their intended assertions.
Integrated daemon types, workspace lint and hygiene pass. The application owns
these private directories; ancestor checks are not a same-UID hostile-process
sandbox or a claimed power-loss transaction guarantee.

Evidence: `/tmp/localdot-m4-task7-draft/manifest.json`, `review-notes.md`,
`integration-{types,lint,hygiene}.log`, and
`/tmp/localdot-m4-task7-review/scoped-review.md`.


## Task 9: brain-container lifecycle

Five files integrate the isolated brain/gate network and lifecycle, with immutable task pricing and the captured original budget on every setup attempt. Cancellation fences publication; active Docker operations use captured object IDs. Cleanup revokes keyd first and retains owned labels and listener reservations when cleanup is uncertain. The internal tool relay stays on 4751 even with a different host backend port.

Independent full review found two Important issues (a final continuation cancellation gap and name-based active object targeting). Both are fixed and scoped re-review passes, including both retained counterexamples and two correction mutations. Integrated acceptance: 23 tests in two files, all workspace type checks, lint and hygiene pass. Evidence: `/tmp/localdot-m4-task9-draft/integration-{tests,types,lint,hygiene}.log` and `/tmp/localdot-m4-task9-review/scoped-review.md`. No real-container acceptance is implied by these local fixtures. Reciprocal desktop/brain listener reservations, runner Stop/recovery wiring and real bridge/relay/containment acceptance remain Tasks 13 and 15.
