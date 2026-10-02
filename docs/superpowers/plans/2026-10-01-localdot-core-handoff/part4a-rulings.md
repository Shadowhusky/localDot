# Controller rulings on the Part 4a (keyd core) plan (2026-10-01, projects-5e; plan approval delegated by the user for M3–M9)

- P4a-C1 (review-1 C1, C2, I1, I2, I3): fix all five before execution, each pinned by a test that fails on the current plan code and passes after:
  - C1: values up to the plan's 8 KB limit store intact in the Keychain, with no secret bytes in any error.
  - C2: path and method limits hold under `..`, `%2e%2e`, encoded slashes and other normalisation tricks; the request is matched on its normalised path and refused on ambiguity.
  - I1: the scrubber catches JSON (Go, .NET), HTML and other common escapes, with a test that can fail.
  - I2: no request inspected before Stop reaches the provider after it.
  - I3: budgets can't be overshot by concurrency.
  — cost if wrong: one more review round.
- P4a-C2 (decisions): accept R1 as written.
  - R2: accept; amend trust rule 3's wording, and bind the secret's binding into the AAD (review M6).
  - R8/R9: accept with a spec amendment. "Never passed through" covers the request line and headers of the traffic keyd terminates, and the passthrough-response residual risk is recorded.
  - R5: accept with review M1's tighter last-label rule and a spec amendment recording the port/IP-literal narrowing.
  - R15: change; cap or reserve in-flight gateway requests under the budget lock, and charge a cut stream at least the byte estimate.
  - R20: change.
    - Fix the I2 race.
    - Revoke ends the cell's task.
    - Part 4b's obligations say Stop also pauses or stops the cell's processes (research §3.10).
  — cost if wrong: the user vetoes R8/R9's narrowing, and request-body and passthrough surrogate blocking becomes a Part 4b task.
- P4a-C3: apply every Minor's smallest fix unless it conflicts with the spec or another finding; list any not applied, with reasons — cost if wrong: none.
- P4a-C4: the user is told of the R8/R9 narrowing of "never passed through" in one line and may veto it. No real secret is at stake, because surrogates are worthless off the Mac.
- P4a-C5 (after part4a-review-2.md: I3/R15 and N1 open, M3 not applied, 7 new Minors). The gateway enforces each request's ceiling itself and never trusts the request:
  - (a) refuse choice counts above 1 (`n`, `best_of`, `candidateCount` and the like) with a 400 that names the field — the agent never needs them;
  - (b) a missing or oversize output cap is set by the gateway to the largest value the remaining room allows, bounded by the model's maximum output, written in the provider's own cap field, so every request has a known ceiling;
  - (c) price inputs at what the provider bills: images by the provider's image-token rule (dimensions read from the image header, or a documented per-image ceiling when they can't be read), never by base64 length;
  - (d) a refusal publishes the same `budget.exceeded` event a crossing does, so Part 4b's raise-the-budget offer fires;
  - (e) after completion, charge the provider's reported usage and release the rest of the hold; with no usage, charge the hold.
  M3 (stacked encodings): fix it if it stays bounded (at most two layers of the encodings the scrubber already knows); otherwise record the residual risk as a decision with its reason. Apply the 7 new Minors. Sync R3 with the spec's M7 risk line, which the controller added. — cost if wrong: one more review round.
- P4a-C6 (after revision log 2, controller projects-5e under the user's delegated plan approval): Part 4a is APPROVED for execution. Lane C builds it in worktree `localdot-keyd`; Tasks 1–4 started before this pass, and Tasks 1–6 and 8 are byte-identical across it.
  Revision 2 changed code in Tasks 9, 10, 12, 13, 14 and 16, so a scoped re-review 3 of that pass runs in parallel and must finish before Lane C reaches Task 9. Its findings get fixed in the plan before those tasks run.
  Residual budget gaps recorded in R15 are accepted for M3: documents, media by URL, server-side tools, pricier service tiers and other servers' image rules. The agent sends text and screenshots.
  — cost if wrong: a later task's brief changes after review 3.
- P4a-C7 (after part4a-review-3.md: P4a-C5 (a)–(e) ADDRESSED; every re-run budget attack held; Tasks 1–6 and 8 byte-identical). A small fix pass 3:
  - N-A (new): floor the input estimate at 0 and clamp the image-byte count to the body's length, so a malformed image can't drive a hold negative.
  - N-B (pre-existing): when a request was relayed upstream and the client leaves before the response headers, charge the full hold, as with no usage.
  - N-C: refuse a `completions` prompt array of more than one element (400 naming the field), like choice counts.
  - N-D: add provider-stored conversation state (`previous_response_id`, cached content) to R15's residuals. M4 refines it once the brain's call pattern is known.
  - No separate re-review: the reviewer's own probes (they fail on the fix-2 tree) are the acceptance test and must pass. Tasks 13–14 get a normal task review when Lane C builds them.
  — cost if wrong: a budget bug surfaces in Task 13/14's task review instead of here.
- P4a-C8 (after revision log 3): P4a-C7 applied.
  - N-A clamps and floors the image and input terms (Task 13 `request.go`).
  - N-C refuses a `prompt` list with `400 choice-count: prompt` (Task 13). A single prompt sent as a flat token-id list is refused too; it can be sent as `[[...]]`. Accepted, because the brain doesn't use completions.
  - N-B charges the full hold once keyd has written the request's headers upstream (Task 14 `gateway.go`/`forward.go`). The reviewer's probe now stops at round 3 on a spent budget, and with raised limits it charges $90 (fix2 charged $0).
  - N-D is documented in R15.
  - The plan is 14,751 lines. It rebuilds byte for byte (61 files); race tests pass with 176 + 1 skip, ×10, plus -count=20 at -cpu 1,4. Tasks 1–12 are byte-identical.
  - The Part 4a plan is FINAL for execution. Lane C extracts Task 13/14 briefs from this version.
- P4a-C9 (Task 8 review, 2026-10-01): the egress policy refuses underscores in every label (the brief's `bad_host.example` row). That fails closed, but browsers accept such hosts, so a Desktop or Browser cell gets `host-invalid` for them. It is recorded as part of P4a-R5's "names only" rule.
  - Also from Task 8's hardening (C1–C4):
    - bare reserved names are denied (`home.arpa`, …);
    - non-ASCII hosts are refused;
    - port text must be canonical digits;
    - a bracketed host is only an IP literal.
  - From Task 7: an overlap class of the scrubber is a recorded residual next to P4a-R18. A match's tail can swallow the start of an adjacent occurrence, and the output is not re-scanned. It needs unusual secret shapes or an all-but-one-byte echo, adjacent with no separator.
  — cost if wrong: an underscore host is unreachable from cells until relaxed.
