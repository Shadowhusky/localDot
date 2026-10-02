# LLM gateway verification

Part 4a Task 14 was implemented and checked on the local Mac on 2026-10-02 with Go 1.27.1.
All upstreams in these checks are local fake HTTP/TLS providers; no paid API was called.

## Implemented

The brain's `http://llm.ldot/<route>/<operation>` proxy route now enforces the route's operation,
surrogate, running task, model allowlist, prices and reserved budget. It writes the admitted output
cap in the provider's own field, strips the cell's credentials, swaps the bound real key, and scrubs
and meters the response. Free token-counting operations do not wait for a paid reservation.
Budget refusals return 402 and publish `budget.exceeded`; unusable bookkeeping returns 503.

The five added bearer presets (xAI, Mistral, DeepSeek, Groq and OpenRouter) have fixed hosts,
operation lists, auth styles and usage/image handling from the provider amendment. Unpriced models
are refused on paid routes. Local model routes use a separate transport pinned to their configured
loopback addresses. Public transport retains absolute DNS names and verified TLS.

Stop and client disconnect cancel in-flight provider work. A slow, unfinished gateway upload is
also interrupted by Stop. Requests are inspected again after waiting for budget, so a revoked
surrogate cannot be swapped for a replacement secret. Successful replies without usage, including
204 responses, consume their reservation. If headers were already sent upstream and no response
status is known, cancellation or disconnect also consumes that reservation: the provider may have
billed the work. A known failed response charges only usage it actually reported.

## Review and corrections

The initial integration exposed the registry's stricter destination contract: gateway inspection
must name `llm.ldot` as the destination host. That is now explicit, and gateway authority matching
accepts ASCII case and port 80 only. The earlier TLS, auth-close, connection-limit and DNS fixes
were retained while extending the transports and relay.

Behavioral red/green checks reproduced and corrected refunds after Stop or an upstream disconnect
before headers, refunds for empty or unreadable successful responses, misleading ledger-error
responses, blocked uploads after Stop, and a panic when bookkeeping was missing. Scoped re-review
checked the new accounting paths, callback lifetime, failed-response behavior and unchanged
refusal before a provider connection has sent headers.

## Evidence

- `go test -race ./... -timeout=120s`: all 11 packages passed; egress completed in 31.302 s.
- The 22 gateway tests, eight added integrity tests and one preset test cover the new behavior.
  The added integrity tests also passed ten consecutive race-enabled runs (6.346 s).
- All 21 deliberate gateway mutations were caught by behavioral assertions, with no survivors or
  build failures. They cover role, surrogate and model gates; cap rewriting and concurrent
  reservations; credentials and replacement keys; local transport isolation; streamed usage;
  interrupted/empty/unreadable response charges; virtual authority; and Stop during upload.
- Darwin and Linux/arm64 vet passed. `go mod tidy -diff`, scoped `gofmt -l` and hygiene passed.

Execution records: `/tmp/localdot-keyd-task14-full.log`,
`/tmp/localdot-keyd-task14-integrity-repeat.log`, and
`/tmp/localdot-keyd-task14-mutation-run.log`.

The manager, admin command, daemon integration and product UI remain subsequent work. Model/price
changes in the admin integration must invalidate affected pending work before new policy becomes
usable; the existing generation cancellation and post-wait inspection provide the enforcement seam.
