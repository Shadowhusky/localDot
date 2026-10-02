# Job: Part 4b (keyd integration) plan, fix pass 2

- **Output branch:** made from `origin/planning`, named `claude/plan-part4b-fix2`. Commit:
  - the edited `docs/superpowers/plans/2026-10-01-localdot-core-part4b-keyd-integration.md`;
  - `docs/superpowers/plans/2026-10-01-localdot-core-handoff/part4b-revision-log-2.md` (per finding: what changed, where, and the pinning test; then the verification runs).
  Push it.

## Inputs (planning)
- The plan: `docs/superpowers/plans/2026-10-01-localdot-core-part4b-keyd-integration.md` (12,766 lines; fix pass 1 already applied).
- The re-review to apply: `docs/superpowers/plans/2026-10-01-localdot-core-handoff/part4b-review-2.md` (0 Critical, 2 Important, 9 Minor).
- The binding rulings: `…handoff/part4b-rulings.md`, especially **P4b-C4**.
- The previous log: `…handoff/part4b-revision-log-1.md`. The spec: `docs/superpowers/specs/…`.

## Apply (P4b-C4)
1. **I-1:** when the freeze fails, Stop falls back to stopping the computer (`cells.stop`) after the keyd close. Add two tests: a queued crash restart, and a keyd or daemon restart, must not reopen a user-stopped computer.
2. **I-2:** rebase 4b's web edits onto Part 2 as built at `origin/feat/core-part2` (`b02765f`).
   - Task 13 built `Mascot`'s props and `useCell`/`api`.
   - Task 14 added the stage, a CSP on the Theatre's `index.html` (`default-src 'self'; connect-src 'self'`, with no inline script or style) and a Permissions-Policy.
   - Part 2's `App.test.tsx` must pass with `useKeys` fetching `/api/keyd`, or change it explicitly and say so.
   - Part 2's coming web fix round will add `frame-ancestors 'none'` on `/`, a persistent HUD button and a whoami probe. Note in the plan that 4b's execution-time pre-flight re-verifies its UI edits against Part 2's final tip.
3. Apply the 9 Minors' smallest fixes.
4. **CA trust:**
   - keyd's cell CA already carries `ExtKeyUsage: serverAuth` plus critical permitted DNS names and excluded subdomains (`git show origin/feat/core-part4a:keyd/internal/cellca/cellca.go`, lines 78–86).
   - The cell installs it as a PLAIN anchor: in the system bundle (`update-ca-certificates`) and in NSS with `C,,`. Drop the per-store purpose flags that would lock out Go, rustls and Java tools.
   - Add a pin: inside the image, OpenSSL and Go verify a keyd leaf for a bound host and refuse one for an unbound host.
   - Update the I5/C3 decision text.
5. **Rebase-check every Part 4a reference** against `origin/feat/core-part4a` (`70a534e`):
   - policy hardening: bare reserved names denied, non-ASCII refused, canonical port digits, brackets → `ip-literal`/`host-invalid`;
   - the scrubber refuses an empty replacement;
   - keys Task 9's final API: lenient Basic detection, scanning of userinfo, opaque targets and fragments, refusal of `..`-like path segments, all-or-nothing `ApplySwaps`, and the Q1 Basic pair.

## Verify
Do what you can in a scratch copy (Go, tsc, Biome, Vitest), with no Docker and no third-party network calls. List what you couldn't verify.
