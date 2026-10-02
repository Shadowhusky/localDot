# Key gateway bookkeeping and durable task budgets

Verified on the local Mac on 2026-10-02 with Go 1.27.1. This covers Part 4a Task 13,
including the first-class provider amendment and the session-budget requirement carried into M4.
The HTTP gateway and admin wiring are subsequent tasks; this report does not claim they are complete.

## Behavior

- Usage is read from provider response fields, including Groq's final stream chunk, and ignores
  usage-shaped tool arguments. JSON and SSE buffering have fixed size bounds.
- Requests admit one model and one answer, reject fallback model lists and duplicate model/config
  fields, and replace competing output caps with the cap the reservation can pay for. Input
  estimates follow the plan's text and provider image rules; they are not exact tokenization.
- Defaults are $5 per task and $20 per day. Concurrent requests hold their prospective cost before
  going upstream, and wait or refuse when that room is unavailable.
- A task account is keyed by session task ID. Follow-ups, replacement cells, End, midnight and
  keyd restarts preserve its spend and explicitly selected limit. Begin now returns an error that
  the manager/admin integration must propagate.
- Admitted ceilings are saved before Reserve succeeds. After a process crash, unresolved holds
  are charged in full. A release or settlement saves the revised charge; pending ceilings cross
  midnight conservatively. A backward clock correction cannot reset daily spend.
- Ledger files are private (0600), written through a synced temporary file and atomic rename.
  Persistence errors block further spending. Invalid loaded state, invalid monetary inputs,
  negative settlements and arithmetic overflow cannot create spending credit.
- Settings validate loaded and new prices/limits and publish changes only after a successful save.

## Review and corrections

The local review covered hold admission, settlement, cancellation, worker replacement, restart,
midnight, clock rollback, failed writes, model selection, cap rewriting and image arithmetic.
Corrections include durable session accounts and pending ceilings, a ceiling that covers a dearer
cache-read price, validation of loaded settings, and refusal of trailing JSON/data. The trailing-data
test first failed on all three readers, then passed after the shared reader required EOF.
The scoped re-review checked the corrected paths and their refusal behavior.

## Verification

- `go test -race ./...`: all 11 packages passed, including 41 top-level bookkeeping tests.
- `go vet ./...` and Linux/arm64 vet passed; `go mod tidy -diff` and scoped `gofmt -l` were empty.
- `pnpm hygiene` passed. No provider or paid API was called.
- Twenty deliberate production mutations were each rejected by the targeted behavioral test;
  none survived and none was counted as a build failure. They covered lost task/pending spend,
  midnight/clock resets, skipped reservation/refund persistence, canceled admission, negative or
  overflowing charges, unsaved/invalid settings, cache pricing, missing provider usage, multiple
  models/answers/caps, trailing JSON, and a negative malformed-image estimate.

Local execution records: `/tmp/localdot-keyd-task13-final-full.log`,
`/tmp/localdot-keyd-task13-integrity-green.log`, and
`/tmp/localdot-keyd-task13-mutation-run.log`. The mutation runner operates on temporary copies;
the production sources remain unmutated.
