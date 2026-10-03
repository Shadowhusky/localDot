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
  foreground completion drains inherited pipes for at most250ms and preserves
  background applications. Failed group cleanup produces a typed error for the
  later daemon/runner Stop path, never ordinary success.
- Process-group termination has the desktop user's authority. Elevated or detached
  descendants require global Stop's whole-cell freeze; real-container acceptance
  of that integration remains required. Home resolution is a current path check,
  not race-free descriptor confinement or a shell sandbox.
- Integrated acceptance: 142/142 tests in16files, workspace types, lint/hygiene
  pass under Node24.19.0. Shell's five seeded regressions and provider's price,
  clamp and saved-catalog lookup regressions are caught. Independent shell review
  plus scoped finalization checks are complete.
- Commits: `8cc5c81` protocol; `bee337e` providers; `631ff8a` shell and the combined
  lockfile importers. Evidence: `/tmp/localdot-m4-tasks1-3-{tests,types,lint,hygiene}.log`.

## Task 6: screenshot freshness

Known changed targets cancel before desktop input and return the newest full
frame. A small peripheral animation may be tolerated only after a second frame
100ms later: center24×24 and complete accessibility target bounds agree pairwise;
only exact dynamic pixels are masked; static change is≤2% and union≤20% of the
96×96 region at24-luma tolerance. No blanket animated-target exception exists.
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
- Integrated daemon typecheck, lint and hygiene pass; the pinned sharp0.35.5
  dependency is declared explicitly. Existing calls without a model basis keep
  their normal path. Task8/runner will own generation and takeover enforcement.
- Evidence: `/tmp/localdot-m4-task6-draft/fix-tests.log`,
  `mutations/evidence.json`, `stream-mutation-evidence.json`, and
  `/tmp/localdot-m4-task6-scoped-review/evidence.json`.

M4 is not complete. File/browser routes, client transport, memory/settings,
immutable per-task keyd pricing, brain loop, chat and optional ChatGPT remain.
