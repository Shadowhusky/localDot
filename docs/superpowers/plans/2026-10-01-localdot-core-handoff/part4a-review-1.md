# Part 4a plan review 1: keyd core (M3, first half)

Line numbers are in `plans/2026-10-01-localdot-core-part4a-keyd-core.md` (11,534 lines) unless marked otherwise.
Inputs read: the whole plan; the spec's Trust rules, Key layer, Providers and sign-in, Safety and control, Testing and
M3; research §3; `docs/spikes/SUMMARY.md` (D4–D7, A21–A27) and `spikes/s4-keyd/FINDINGS.md` from `main`; Part 2's
`cells/gate/relay.sh` on `feat/core-part2`; goproxy v1.9.2 `https.go` and iron-proxy v0.52.0 `snipeek.go` from the
module cache.

What I ran:
- The hygiene patterns of `scripts/check-hygiene.mjs` over the verified tree: no hits.
- A read-only `security -i` probe (`find-certificate` with a long name; no keychain writes), and a Go resolver probe.
- Probe tests in my own copy of the verified tree, `scratchpad/review-probe/keyd` (`review_probe*_test.go`). The
  planner's `part4a-verify` tree is unchanged.
- Not run: a fresh full-suite run of the planner's tree, and the aborted-stream metering probe in I3. The shell
  permission check failed repeatedly at the end, so that I3 point comes from reading the code.

## 1. Spec coverage

| # | Spec requirement (source) | Planned in | Status |
|---|---|---|---|
| 1 | Vault: Keychain items owned by keyd (Key layer) | T2, P4a-R3 | Covered, via `/usr/bin/security`. C1 breaks it for long values. See M7 for R3's effect. |
| 2 | Surrogate `ld_<kind>_<≥128-bit>_<checksum>` | T1 | Covered (131 bits, CRC32) |
| 3 | Minted per cell; bound to the listener, exact hosts, one header and a policy; die with the cell | T9, T14 | Covered. The policy part can be bypassed (C2). |
| 4 | Per-cell explicit proxy on its own port; `Proxy-Authorization` token (Key layer, trust rule 1) | T10, T14 | Covered (Basic, 32-byte token, constant-time compare, 407 audited at most once a second) |
| 5 | Per-host interception with a per-cell in-memory name-constrained CA; others pass through with SNI = CONNECT host | T6, T10, T11 | Covered |
| 6 | Policy follows the inner request; everything else gets 403 | T10, T11 | Covered (inner Host and absolute URL must match the tunnel; otherwise 421) |
| 7 | Authorize, then swap; https/443/exact host; never over plain HTTP; only after verified TLS and a connected-IP check; every method | T9–T11 | Covered |
| 8 | Header-only; exact header match | T9 | Covered |
| 9 | Unknown or misplaced surrogate blocked and alerted, never passed through | T9–T11 | Partial: request line and headers only. Not bodies (R8), passthrough tunnels (R9) or host names (M2). Needs a spec amendment. |
| 10 | Real value scrubbed from responses: plain, base64, URL-encoded, hex | T7, T10, T11 | Partial: I1, M3 |
| 11 | SSRF guard: keyd resolves, checks, dials the checked IP, re-checks the peer; full deny set incl. `0.0.0.0/8`, `::/128`, 192.168.65/24, every own address (live) and connected prefixes; no upstream proxy; each redirect hop again | T4, T10 | Covered |
| 12 | LLM gateway at `http://llm.ldot/<provider>`; per-provider auth style (bearer, `x-api-key`, `x-goog-api-key`, `api-key`) | T9, T13 | Covered |
| 13 | Model allowlist | T12, T13 | Covered (M9) |
| 14 | Budgets: $5 per task, $20 per day, editable | T12, T13, T15 | Partial: I3 |
| 15 | Fronts LM Studio and Ollama; no cell reaches them directly | T9, T13 | Covered (pinned dialer). See M12. |
| 16 | 502 on an upstream failure; a mid-stream error ends the stream; a client disconnect aborts upstream | T10, T13 | Covered |
| 17 | Audit: one hash-chained line per decision with the listed fields; aborted handshakes and SNI/Host mismatches are decisions | T5, T10, T11 | Covered (M2, M4) |
| 18 | `key.use` for the timeline | T5, T10 | keyd side covered; event-log wiring is 4b |
| 19 | Kill switch: drop the cell's surrogates, close its upstream connections | T14 | Partial: I2 and R20 |
| 20 | Default egress by role | T8 | Covered (M11) |
| 21 | v1 secret classes: LLM keys and generic HTTP keys | T2, T9 | Covered |
| 22 | Data plane on goproxy; srt substitution cases; S4 probes; iron-proxy adaptations with the Apache notice | T9, T10, T16 | Covered. The license and the adapted `snipeek.go` match the module; iron-proxy has no NOTICE file. |
| 23 | What a cell holds (Key layer last paragraph, A27) | T14 (`Opened`) | Covered |
| 24 | Admin API on a 0600 Unix socket (trust rule 6) | T15 | Covered (M5) |
| 25 | State in `~/.localdot/keyd` (0700); secrets only in the Keychain | T2, T15 | Covered, except that C1 sends secret bytes out in an error |
| 26 | The daemon never sees a plaintext secret; the key form posts to keyd (trust rule 3) | T3 (R2); form is 4b | Covered by a changed mechanism that needs a spec amendment. C1 breaks it. |
| 27 | Go unit tests: every swap rule with srt's cases, the SSRF guard, the audit chain (Testing) | T4, T5, T9, T16 | Covered |
| 28 | Security tests: misuse blocked and alerted; listeners refuse requests without the token | T10, T11, T16 | Covered on keyd's side |
| — | Deferred to 4b by design: the daemon's admin client, cell proxy env and CA install, `desktopd` self-test and readiness gate, key form UI, `key.use` into the event log, Stop wiring, canary test, S4 `run.sh`/`chromium.sh` from a real cell, "Key layer offline" | "Part 4b obligations" (11359–11371) | Listed |
| — | Not M3: Bedrock SigV4 and Vertex (M8), LaunchAgent and signed binary (M9), approvals (M5) | — | Correctly left out |

No M3 keyd-core requirement is missing a task. Rows 3, 9, 10, 14, 19 and 26 are partial because of the findings below.

## 2. Verdicts on the six decisions

- **R2 (UI seals to keyd's per-boot key; the daemon relays): ACCEPT.**
  - The guarantee holds as well as the spec's "posts straight to keyd" would. The daemon serves the UI's code, so neither mechanism protects against an actively compromised daemon. Both keep plaintext out of the daemon's process, logs and stored requests, and sealing does that without opening a loopback port that every container on the Mac could reach.
  - The crypto is sound: ECDH P-256 with an on-curve check, HKDF-SHA256 salted with both public keys, AES-256-GCM, a fresh ephemeral key and nonce, and the secret id in the AAD. The Node vector is pinned.
  - Conditions: C1 must be fixed, or the daemon does receive secret bytes. Amend trust rule 3's wording. Optionally put the binding in the AAD (M6).
- **R1 (goproxy only dispatches CONNECT; inspection on net/http and ReverseProxy): ACCEPT.**
  - It avoids goproxy's second request parser, its unverified upstream TLS, `HTTPS_PROXY` use and silent truncation.
  - I checked goproxy v1.9.2: `ConnectHijack` hands over the raw connection and `RejectConnect` writes `ctx.Resp`, as the plan assumes. It drops the hijacked bufio buffer, which only matters for clients that send before the 200; Chromium, curl and Node wait.
  - Optional: net/http can serve CONNECT and `Hijack` on its own.
- **R8/R9 (bodies not scanned; a surrogate in a passthrough tunnel goes unseen; a bound host is browsable without a surrogate): ACCEPT, with a spec amendment.**
  - No real secret leaks. Swaps happen only in headers over verified TLS. A surrogate in a body or a passthrough tunnel is worthless off the Mac.
  - `scrubberFor` covers every secret bound to the host, swapped or not (forward.go, `scrubberFor`), so a response to a request without a surrogate is still scrubbed.
  - Refusing body surrogates would break sessions whose prompts quote surrogates. Refusing surrogate-less requests broke Chromium in S4.
  - But the spec says misplaced surrogates are "blocked and alerted, never passed through". Amend it to cover the request line and headers of traffic keyd terminates.
  - Record a residual risk: responses on passthrough names are never scrubbed. If a service stores a header that keyd sent to a bound host and shows it under another, unbound name, keyd cannot help.
- **R5 (no IP literals; CONNECT only to 443, plain HTTP only to 80): ACCEPT, with M1.**
  - It does not break success criterion 2: web research, package registries, apt over 80, git over https and wss to passthrough hosts all work. Only odd ports, IP-literal URLs and `ws://` (CONNECT to 80) fail.
  - It strengthens the SNI and name rules, and the guard still checks every resolved address.
  - Tighten the last-label rule (M1), and record the narrowing as a spec amendment.
- **R15 (LLM calls need a running task; a spent budget answers 402): CHANGE.**
  - Requiring a task and answering 402 is right: per-task budgets need a task, and the AI SDK does not retry 402.
  - The stated bound, "overshoot of one request", is false. Concurrent requests all pass `Check` before any is charged (I3).
  - Smallest change: cap a cell's in-flight gateway requests, counted under the budget lock (or reserve each request's maximum cost). Charge a cut stream at least the byte estimate.
- **R20 (the kill switch keeps the listener, CA and task): CHANGE, small.**
  - Keeping the listener and CA is fine. The CA key never leaves keyd, and it avoids reinstalling a CA in a running cell.
  - Three changes:
    1. Fix the gateway race (I2). Today a request inspected before Stop can reach the provider after it.
    2. End the cell's task in `Revoke`. Otherwise the keyless `lmstudio`/`ollama` routes keep working after Stop. A user Stop is not the raise-the-budget path, and the next task begins a new one anyway.
    3. In the 4b obligations, say that Stop must also pause or stop the cells' processes, as the research's kill switch does (§3.10). With the listener open, a desktop process the agent left running keeps its web egress after Stop.

## 3. Findings

Checked and holding:
- **SNI and Host.** The SNI must equal the CONNECT host, both for passthrough and for interception (`GetCertificate`).
- **Inner requests.** Inside a tunnel, the Host and any absolute URL must name the tunnel's host and port 443.
- **HTTP/2.** keyd offers only `http/1.1` to cells, and upstream HTTP/2 pools are per host, so no request can ride another host's connection.
- **Redirects.** keyd returns them without following, scrubs `Location`, and checks the next hop as a new request.
- **SSRF forms.** The guard refuses IPv4-mapped, IPv4-compatible, NAT64, 6to4 and Teredo forms, zoned link-local addresses, `0.0.0.0` and `::`, 192.168.65/24, own addresses read live, and connected prefixes. It denies a name if any of its answers is denied.
- **Resolved names.** `localhost` variants, `*.internal` and DNS names that resolve to loopback are refused by name or at dial.
- **Token and socket.** The token is constant-time compared. The socket is 0600 inside a 0700 folder whose owner is checked.
- **CA.** It is name-constrained, excludes every IP range, has path length 0, and its key is never written.
- **Keychain argv.** Values go on stdin, never on the command line.
- **Upstream TLS.** Verified against the system roots, with no environment proxy. Upgrades are refused on intercepted hosts. Trailers and 1xx headers are scrubbed.
- **Constraints and inputs.** The Global Constraints match the repo: `check` exists in `ci.yml`, the `.gitignore` line is new, README has "Development", there are no hygiene hits, ports follow D17, and commits carry no attribution. Part 2's gate relays `TCP4:host.docker.internal:<port>`, as the listener model assumes.

### Critical

**C1. A secret over about 2 KB is split by `security -i`, and its tail goes to the daemon in an error.**
- Where:
  - `Keychain.Put` sends `add-generic-password -U … -w <hex>` as one stdin line (909–918).
  - Values may be 8,192 bytes (995–998; R23, 11476–11479).
  - `Put` puts the tool's output into its error (915), and `putSecret` returns `err.Error()` to the daemon in the 500 reply (10370–10372).
- Evidence: `security -i` reads 4,095 characters per command. In a read-only probe, a 6,020-character `find-certificate -c` line ran with its first 4,095 characters, then `security` ran the rest as a command and printed `security: unknown command "aaaa…"`, exit 1. 4,090 characters passed; 4,100 left 5 over.
- Effect for keyd: the line is 61 + 2·len(id) + 2·len(value) characters, so any value over 2,008 bytes splits (id `anthropic`; 1,953 for a 64-character id).
  - `add-generic-password -U` first stores the truncated hex, which is a corrupt key. On an update it also diverges from the cached value until restart.
  - The rest of the hex runs as a "command", and `security` echoes it back: up to about 6 KB of the secret's tail, hex-encoded, reaches the daemon (and anything that logs or shows the error). That breaks trust rule 3 and "secrets live only in the Keychain".
- Why the tests miss it: the fake `security` (708–736) reads whole lines with `read -r`, and the opt-in test stores 26 bytes.
- Smallest fix:
  1. Refuse values whose line would exceed 4,094 characters, or split them across items.
  2. Never let `security`'s output leave keyd: return a fixed message and the exit status.
  3. Read the item back after `Put` and compare.
  4. Make the fake emulate the 4,095-character split, and test a 3,000-byte value.
  5. Correct R23 and the admin docs to the real limit.

**C2. Path and method limits on HTTP bindings are bypassed with dot segments and encoded slashes.**
- Where: `Binding.Permits` prefix-matches the decoded `u.Path` (4352–4361). `Inspect` relies on it (4672–4674). The MITM target keeps the cell's path bytes (7221). Nothing rejects `.`/`..` segments, `%2e`, `%2f`, `\` or `;`.
- Probe (Task 11 harness; binding `Paths: ["/v1/"]`, bearer): `GET /v1/../admin`, `/v1/%2e%2e/admin` and `/v1%2f..%2fadmin` each returned 200. The upstream got `Authorization: Bearer real-secret-value-for-test` on that path, and real servers normalise all three to `/admin`.
- Related gaps:
  - A prefix without a trailing slash (`/v1`) also matches `/v1-admin`.
  - `X-HTTP-Method-Override` (Google APIs) or Rails' `_method` defeats a `methods` limit that allows POST.
- Impact: desktop cells run model-written code, so a prompt injection can use the real key on any path of a path-limited host. The guard is a user setting with no effect.
- Smallest fix:
  - In `Inspect`, refuse with `surrogate-policy` when a swap's binding has `Paths` or `Methods` and any of these holds: the decoded path is not clean (`path.Clean`, one trailing slash allowed); it contains `\` or `;`; the raw path holds `%2e`, `%2f` or `%5c` in any case.
  - Match prefixes on a segment boundary.
  - Refuse method-override headers when `Methods` is set.
  - Add the three probes to `TestInspect` and Task 11.

### Important

**I1. The scrubber misses common escapings, and `jsonGo` is a no-op.**
- `jsonGo` (3518) is `"<", "<"`, `">", ">"`, `"&", "&"`: three no-op pairs, so it is `jsonBasic` again.
  - The plan contains no backslash-u-plus-four-hex sequence anywhere. The escapes were lost in authoring; my own file writes did the same to my probe.
  - The verification's byte-for-byte rebuild cannot catch this, because the tree was built from the same text.
  - The "json" case (3136) uses a secret that `json.Marshal` does not escape, so it passes whatever `jsonGo` holds.
- Probes against `scrub.New`. Each of these reflections passed the scrubber and decoded to the real value:
  - a secret with `&<>` echoed by Go's `json.Marshal` (HTML escaping is on by default);
  - a secret with `+` written as backslash-u002B (.NET System.Text.Json's default);
  - a secret with `&` in an HTML page (`&amp;`).
- Also uncovered: percent-encodings other than Go's two. JS `encodeURIComponent` and Python `quote` leave some reserved characters raw.
- Scope: this needs a bound host that echoes the credential and a secret with punctuation. The research accepts "encodings the scrubber misses" as residual, but the plan claims Go's JSON escapes (3058–3062; R18, 11457–11461) and the fix is small.
- Smallest fix:
  - Spell each escape so no backslash-u sequence appears literally in the source, for example `` `\` + "u003c" ``.
  - Add upper- and lower-case backslash-u forms for `< > & ' + " = /`, and an HTML-entity form.
  - Match percent forms per byte: a byte outside A–Z a–z 0–9 `-._~` may arrive raw or as `%XX` in either case.
  - Test a secret containing `<>&+'"` against `json.Marshal`, the .NET form and `html.EscapeString`.

**I2. A gateway request inspected before the kill switch can reach the provider after it.**
- Where: `serveGateway` inspects (8901), checks the budget (8912), then reads the whole body with no deadline (8916). Only after that does it take the generation for the relay (`gen: c.current()`, 8968). `Manager.Revoke` drops surrogates first, then replaces the generation (9554–9563).
- Probe: a gateway POST held its body open. I then ran `Registry.RevokeCell` and `cell.Revoke()`, as `Manager.Revoke` does, and finished the body. The provider received `X-Api-Key: real-secret-value-for-test` after the kill switch.
- `servePlain` and `innerHandler` take the generation before `Inspect`, so only the gateway is affected.
- Severity: Important, not Critical, because deliberate use needs code running in the brain cell; a prompt injection cannot time the brain's body uploads.
- Fix: take `g := c.current()` first in `serveGateway`, pass it to `relay`, and check `g.ctx.Err()` just before relaying. Add the probe to the gateway or kill-switch tests.

**I3. Budgets can be overshot without bound.**
- Where: `Budget.Check` (7919–7933) compares what was spent with the limit and reserves nothing. Charges happen when a response ends (9020–9043). The comment (7860–7861) and R15 (11443–11448) promise an overshoot of one request.
- Probe: 20 concurrent gateway requests, each $4.50 at the test prices. All 20 got 200; the task spent $90 against $5, and the day $90 against $20.
- From the code (probe written, not run): a stream the client cuts before `message_delta` is charged what `message_start` reported (output_tokens 1), because `Reported` is already true (9024–9027). The provider bills what it generated.
- Severity: as in I2, deliberate abuse needs code in the brain cell; the agent loop's natural concurrency is two or three calls.
- Fix:
  - Count in-flight gateway requests per cell under the budget lock and refuse beyond a small cap (for example 4). Or reserve `price × (input estimate + max_tokens)` in `Check` and settle the difference.
  - When a stream ends without a clean EOF, charge at least the byte estimate for output.
  - Correct the comment and R15.

### Minor

- **M1. Hex labels pass the name rule.**
  - `validName` (3858–3878) accepts `0x7f.0x1` and `0x7f.0x0.0x0.0x1`, because the last label contains `x`. macOS's resolver returns 127.0.0.1 for both (probe).
  - The guard still refuses the address. But 3545–3547 and Review Focus 4 (122–126) claim the name rule closes this, and `ValidBindingHost` accepts such names.
  - Fix: the last label must be all letters, or `xn--…`.
- **M2. Surrogate text reaches the audit log and `key.use`.**
  - Audit lines record the raw host and path (6165, 6316, 7216). In a probe, `GET http://ports.example.test/keys/<surrogate>` was refused, but `audit.jsonl` held the surrogate. The Global Constraint (79–81) forbids that, and 4b stores `key.use.path` in the session log.
  - A surrogate in a host name is refused as `host-invalid` with no alert (research swap rule 5).
  - Fix: write surrogate-shaped text in Host, Path, SNI and Detail as its ID, and scan `u.Host`.
- **M3. Stacked encodings.** The `Content-Encoding` check reads only the first value (6396). In a probe, `identity` followed by `gzip` passed, and the cell un-gzipped the real value. Honest servers rarely do this. Fix: check every value of every `Content-Encoding` line.
- **M4. Audit failures do not fail closed.** If a line cannot be written, the swap still goes out (5992–5994), and a partial write corrupts the chain for every later line (2506–2529). Fix: keep the last write error in `Log`, refuse new swaps while it is set, and show it in `/v1/status`.
- **M5. No peer check on the admin socket** (10297–10311). Access rests on the 0600 socket inside its 0700 folder. Either check that the peer's uid is keyd's (`LOCAL_PEERCRED`) or record the choice.
- **M6. The seal's AAD names only the secret id** (1428–1430). Within one boot, a captured blob can be replayed with other `hosts`, `header` or `baseURL` values, rebinding the real key. R3 makes this moot today; add the canonical binding to the AAD so the property survives M9.
- **M7. Record what R3 costs.** Keychain items trust `/usr/bin/security`, so any process of the user, the daemon included, can read every key with `security find-generic-password -w`. Trust rule 3 then holds against accidental exposure, not against a compromised daemon. Put the M9 replacement in the spec's risks.
- **M8. The cell CA has no EKU limit** (2937–2953). A stolen key could sign client-auth, email or code-signing leaves for the permitted names. Give the CA `ExtKeyUsage: ServerAuth`.
- **M9. Case-variant model keys.** `ModelFromJSON` matches the key case-sensitively (8147–8148). `{"model":"cheap","Model":"expensive"}` passes as "cheap", but Go-based OpenAI-compatible servers such as Ollama read the last case-insensitive match. Fix: treat any case variant of `model` as the model, and refuse unless there is exactly one, in lower case.
- **M10. One bad escape hides an encoded surrogate.** If the raw query holds any invalid escape, `url.QueryUnescape` fails on the whole query (4725), so `?a=%zz&k=ld%5Fkey…` goes unseen. The surrogate goes upstream unswapped, so only detection is lost. Fix: unescape pair by pair.
- **M11. Brain cells can hold HTTP secrets.** `Connect` intercepts bound hosts for any role (3783–3785), which widens the spec's default "brain → the LLM gateway only". Refuse HTTP secrets for `brain` in `Manager.bindings`, or record the widening.
- **M12. Local model servers are fixed** to 127.0.0.1:1234 and :11434 (R14, 11436–11441). The guard refuses vLLM or a self-hosted gateway on the Mac or the LAN, though the spec's Providers section names them. Note it for M4.
- **M13. Plan quality.**
  - Task 10 is about 1,800 lines (4821–6623). Split the listener, auth and plain HTTP from CONNECT and passthrough.
  - Tests that cannot catch the defects above:
    - the JSON case (3136);
    - the fake `security` (708–736);
    - budget tests that run sequentially only;
    - a kill-switch test with no request inspected before the revoke;
    - S4's "audit never holds a surrogate" (11110–11117), which checks only its own probes.
  - Add the probes from C1, C2, I1–I3, M2 and M3.
- **M14. The interfaces for 4b** (11157–11371) need:
  - Stop: revoke leaves the listener open, so Stop must also pause or stop the cells' processes, and end the task (R20).
  - The real value-length limit (C1).
  - The budget's concurrency semantics (I3).
  - A note that `key.use.path` is text the cell controls.

## 4. Verdict

**Fixes needed.** Fix C1, C2 and I1–I3, and amend the spec for R2, R5 and R8/R9. All are small; none changes the plan's architecture, which is sound.
