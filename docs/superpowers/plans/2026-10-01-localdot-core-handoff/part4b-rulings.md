# Controller rulings on the Part 4b (keyd integration) plan (2026-10-01, projects-5e; plan approval delegated by the user for M3–M9)

- P4b-C1 (after part4b-review-1.md: 1 Critical, 8 Important, 14 Minor):
  - Apply C1: Stop's pause survives a keyd restart; `#rewireIfLost` skips paused cells, with a test.
  - Apply I1–I7 as the review proposes:
    - I1: the orphan sweep is scoped to `inventory().skipped`, so it never touches cells outside this daemon's home;
    - I2: a failed pause closes the cell in keyd, and Resume revokes before it mints;
    - I3: the readiness gate requires all ten self-test ids;
    - I4: the self-test gains a `gateway` check;
    - I5: C3 is handled: the CA is trusted for TLS server auth only, in the system store and NSS;
    - I6: Task 11 uses `findDockerSocket()`;
    - I7: rebase every Part 2 assumption onto `feat/core-part2` as now built (`4384f20` or later). That covers the readiness body cap, `SkippedCellsError`, the raw-IP probes, the detail clamp, `endpoints()` returning undefined unless ready, and the cached records.
  - Apply the Minors' smallest fixes unless they conflict with the spec or a ruling.
  - Decisions: accept R1, R2, R17 and R18; accept R15 once R14 is scoped; change R6, R7 and R14 as the review proposes.
  — cost if wrong: one more review round.
- P4b-C2 (R16, I8; the user is told and may veto): public-address discovery for the hairpin guard runs in this order:
  1. NAT-PMP/PCP to the local router (no third party);
  2. only if that fails, ONE STUN provider (Cloudflare), with a setting to turn STUN off;
  3. retry while the address is unknown;
  4. expose the state ("hairpin guard: active/unknown") in `doctor` and the UI, never failing open silently.
  — cost if wrong: an outbound call the user didn't want, or a guard that stays unknown on routers without NAT-PMP.
- P4b-C3 (after part4b-revision-log-1.md): fix pass 1 is accepted pending one scoped Opus re-review of the diff against the pre-fix copy (`part4b-plan-v1.md`, 10,784 lines → 12,766). It verdicts C1, I1–I8 and P4b-C2, and checks the new fixes N1–N4 and the decisions R28–R31.
  - Applied as ruled:
    - C1, I1–I8, M1–M14 and P4b-C2;
    - both of the controller's orchestrator fixes (cached keyd ports; `#remove` marks the cell before its first await).
  - Applied differently, and accepted:
    - PCP's MAP request is never sent, because it would create a mapping on the router (PCP-only routers fall back to STUN);
    - the self-test has eleven checks (`gateway` added);
    - M3's press feedback comes from Part 2's global style;
    - M4's browser password prompt can't be observed by Playwright.
  - Verified on Part 2 `1ba1659` + Part 4a `56990a5`: Go 13 packages / 253 tests (-race); tsc clean in 6 packages; Vitest 64 files / 542; Playwright `keys.spec` 2/2. Not verified: Part 3 (unbuilt), Part 4a's unbuilt packages, a NAT-PMP-answering router, Docker suites.
  - Note for the user: during verification the fix agent sent one NAT-PMP request to the router (refused) and one STUN request to Cloudflare from this Mac. This was the call P4b-C2 lets the user veto (`-stun off` disables it).
  — cost if wrong: one more fix pass.
- P4b-C4 (after part4b-review-2.md: 0 Critical, 2 Important, 9 Minor; every review-1 finding is addressed and pinned, and P4b-C2 is met; never sending PCP MAP is confirmed sound):
  - Apply I-1. When the freeze fails, Stop falls back to stopping the computer (`cells.stop`) after closing the cell in keyd, so nothing (a queued crash restart, a keyd or daemon restart, a gate crash) can reopen a computer the user stopped. Two tests.
  - Apply I-2. Rebase 4b's web edits onto Part 2 as built at `b02765f`: Task 13's `Mascot` props and `useCell`/`api` shape; Task 14's stage, CSP (`connect-src 'self'`, no inline script or style) and Permissions-Policy. Make Part 2's `App.test.tsx` tests pass with `useKeys` fetching `/api/keyd`, or change them explicitly and say so. Part 2's web fix round will still change `App`/`useCell`/`Hud`/`socket` after this, so 4b's execution-time pre-flight re-verifies its UI edits against Part 2's final tip.
  - Apply the 9 Minors' smallest fixes.
  - Ruling on the CA-trust minor (supersedes the "server auth only via trust-store purpose" reading of I5/C3). keyd's cell CA certificate already carries `ExtKeyUsage: serverAuth`, critical permitted DNS names and excluded subdomains (`cellca.go:78-86` at 4a `97bfb65`), so the restriction lives in the certificate. The cell installs the CA as a plain trust anchor: in the system bundle (`update-ca-certificates`, read by OpenSSL, GnuTLS, Go, rustls and Java) and in NSS with `C,,`. It does not use per-store purpose flags that lock out Go, rustls and Java tools.
    - A pin checks that the installed CA verifies a keyd leaf for a bound host and refuses a leaf for an unbound host, from at least OpenSSL and Go inside the image.
  — cost if wrong: a verifier that ignores EKU on a CA would trust a name-constrained anchor for non-server purposes. Its key never leaves keyd, and keyd only ever mints server leaves.
