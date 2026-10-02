# Part 4b plan — revision 2 change log (review-2 fixes under P4b-C4; line numbers refer to the revised plan, 13,355 lines, was 12,766)

Inputs:
- `part4b-review-2.md` (0 Critical, 2 Important, 9 Minor) and `part4b-rulings.md` (P4b-C4);
- Part 2 as built, `feat/core-part2` at `b02765f` (Tasks 13 and 14);
- Part 4a as built, `feat/core-part4a` at `70a534e` (policy hardening `fb12271`, the scrubber's
  empty-replacement refusal `fa07db9`, and `keys` through Task 9's fixes);
- `part4b-revision-log-1.md` and the spec, as context.

All work was done in `/tmp/job-plan-part4b-fix2/` (a cloud container, not the Mac):
- `repo/`: `git archive` of `feat/core-part2` at `b02765f`, with this plan's code for Tasks 2, 3,
  5, 8 (desktopd's self-test and the daemon's types), 9, 10, 11's refresh, 12a, 12b and Task 13's
  `useCell`, `hud-state` and `types` edits;
- `keyd-scratch/`: `git archive` of `feat/core-part4a` at `70a534e` plus Task 1's `netguard` files;
- `ca2/`, `canary/`: the trust and scanner checks;
- `tools/`: the extractor and patch scripts.

Every code block this pass changed was copied back into the plan from the verified scratch file,
byte for byte. No git ref but `claude/plan-part4b-fix2` was touched, no Docker command ran, and no
subagent was used. The only network use was the npm registry (`pnpm install --prefer-offline`)
and Go's module proxy for the cached toolchain.

## Where each task changed

| Task | Change |
|---|---|
| 1 | The hairpin guard's freshness (Minor 4): `Keep` asks at once when the default gateway changes, backs off to the long interval after four failed rounds, and a known guard survives one failed round. Three new tests. User-facing "asks again every 30 s" texts become "keeps asking" (Tasks 2, 4, 12b). |
| 7 | The CA is a plain anchor (P4b-C4): the oneshot drops `-addtrust serverAuth`; the Docker test mints a CA with keyd's `cellca` profile and pins OpenSSL and Go (a verifier built for the engine's platform and copied in) accepting the bound host's leaf and refusing another host's and a subdomain's. |
| 8 | `ca-system` requires the CA as a plain `CERTIFICATE` in the system bundle; the OpenSSL-only `TRUSTED CERTIFICATE` form alone fails. |
| 9 | `SkippedCellsError`'s wording (Minor 7), pinned exactly. |
| 10 | I-1 (a failed freeze closes the cell in keyd, then stops the computer; `StopOutcome.stopped`), Minor 1 (Start boots a desktop Docker still holds frozen afresh), Minor 2 (a frozen cell stays `paused` through its gate's restart; Resume only from ready, 409 otherwise). Four new tests in `kill-switch.test.ts` (19), one in `kill-switch-routes.test.ts` (5). |
| 11 | Minor 3: `CellOrchestrator.refreshKeys(id)` refreshes in the cell's queue; `refreshRunningCells(cells, secretId)` uses it. New queue test in `orchestrator-keyd.test.ts` (17). |
| 12a | Minor 8: `KeyStatus.spoken` (`Keys, hairpin guard unknown`/`off`). |
| 12b | I-2: `<Mascot />`, the Part 2 `b02765f` rebase note and the pre-flight note, the two `App.test.tsx` changes; Minor 8's `aria-label` and its test (11 tests). |
| 13 | I-2: `useCell`'s `resume` posts through `api` and joins Part 2's built return object. |
| 15 | Minor 9: the scanner's base64 and base64url forms cover all three offsets; two new planted controls. The Stop expectation gains `stopped: false`. |
| 16 | The README says a computer that cannot be frozen is stopped. |

Outside the tasks: Architecture (25–30), Review Focus 2 and 4, the Interfaces (12878–12985:
`StopOutcome`, the doctor's warning level for M9, the plain anchor, the guard's cadence, the
GnuTLS note removed, the failed-freeze note), the Decisions intro and R6, R16, R20, R22, R30, and
Verification (13219–13355: a fix-pass-2 block and updated "could not be run" items 1, 3, 4, 5).

## Important

**I-1 — a failed freeze stops the computer** (Task 10, 7892–8834; R6 at 13029, R22 at 13155;
"Not in Part 4b" at 12980; Review Focus 4; Task 16's README).
- **What changed:**
  - `KillSwitch.stopSession`: when the pause fails, `keyd.close` at once (unqueued, as before),
    then `cells.stop(id)` (queued). `StopOutcome` gains `stopped`; `KillSwitchDeps.cells` adds
    `stop` (8572).
  - A queued crash restart finds the cell `stopping`/`stopped` and does nothing; `rewireIfLost`
    and the reconcile see a stopped cell. The HUD says `Stopped`.
  - The routes test, the canary's Stop expectation and every `{ revoked, paused, closed, errors }`
    text gain `stopped`.
- **Pinning tests** (`kill-switch.test.ts`):
  - "stops a computer Stop caught in a crash restart's backoff, so the queued restart never reopens
    it" (8124): real 300 ms backoff; afterwards `stopped`, both containers stopped with 1 start each,
    keyd has no cell;
  - "keeps a computer it could not freeze stopped through a keyd and a daemon restart" (8142):
    pause refused, `keyd.restart()`, `rewireIfLost`, then a fresh orchestrator's reconcile: desktop
    1 start, not running, keyd has no cell, state `stopped`;
  - "closes the cell in keyd and stops the computer when the desktop cannot be frozen" (8112,
    extended).

  All three are RED on fix pass 1's kill switch (the queued restart rebooted the desktop; the
  outcome had no `stopped`).

**I-2 — Tasks 12b and 13 rebased onto Part 2 `b02765f`** (Task 12b at 10157, notes at 10189;
`App.test.tsx` changes at 10413; Task 13's `useCell` at 11766; Verification item 3).
- **What changed:**
  - `TopBar` renders `<Mascot />` (the built `Mascot()` takes no props).
  - Task 13's `resume` uses `api.post` with `[api, cellId, run]`, and the return object keeps
    Part 2's `busy: busy || !listed` and `reconnects`.
  - `App.test.tsx`, changed explicitly in Step 1:
    - "forgets a rejected token…": the stub takes the URL, and the requested paths are exactly
      `/api/cells` and `/api/keyd`, once each;
    - "stops and restarts the computer…": the call list leaves out `GET /api/keyd`.

    The other six pass unchanged: `useKeys` polls with `setInterval`, which those tests' fake
    timers (`setTimeout`/`clearTimeout` only) neither fake nor count.
  - Task 14's CSP (`default-src 'self'; connect-src 'self'`, no inline script or style,
    `form-action 'none'`) and the vendored client's Permissions-Policy are noted. Nothing in 4b
    has an inline style or script or a cross-origin request.
  - Part 2's coming web fix round (`frame-ancestors 'none'` on `/`, a persistent HUD button, a
    whoami probe) is recorded. 4b's execution-time pre-flight re-verifies every UI edit and both
    `App.test.tsx` changes against Part 2's final tip.
- **Pinning:**
  - On `b02765f` with fix pass 1's web edits, the web typecheck fails (`<Mascot size>`) and
    `App.test.tsx` fails 2 of 8 (RED);
  - with this pass's edits, 12 files and 65 tests pass and the typecheck is clean (66 with Task 13's
    `hud-state` test).

## Minor

1. **Start on a desktop Docker still holds frozen** (Task 10's `#startContainers` keyd block). A
   paused desktop is stopped and boots afresh. Pin: "boots a desktop Docker still holds frozen
   afresh when the user starts the computer" (8271). RED: Docker's 409 "cannot start a paused
   container".
2. **Resume during a frozen gate's restart.**
   - The frozen `starting` entry carries `paused`.
   - `#pause` leaves an already frozen cell alone, and `#unpause` acts only from ready.
   - `KillSwitch.resume` waits for ready, and the route answers 409 "the computer is restarting:
     resume it once it is ready".

   Pins:
   - "leaves a frozen computer frozen while its gate restarts, and resumes it once it is back"
     (8227: every summary keeps `paused`, Resume during the backoff does nothing, Resume once
     ready thaws). RED: the cell was stranded in `starting`, desktop thawed.
   - Routes: "waits to resume a frozen computer until its gate is back" (8435).
3. **The refresh in the cell's queue** (Task 11). `CellOrchestrator.refreshKeys(id)` (9259), and
   `refreshRunningCells(cells, secretId)`; `main.ts` passes `orchestrator`. Pin: "refreshes a
   computer's surrogates in its queue, after a start that is still wiring it" (9082). No mint
   reaches keyd while the start is held, and the file's surrogate is valid in keyd afterwards. RED
   with fix pass 1's `refreshRunningCells(cells, keyd, id)`: keyd was asked to mint during the
   hold.
4. **The guard's freshness** (Task 1's `public.go`, `Keep` at 1012; R16 at 13113).
   - **Network changes:** a gateway check every `retry` (30 s) re-learns at once when the default
     gateway changes. That needs the router as a source; with `-natpmp off` the cost is recorded
     in R16.
   - **Lost rounds:** a known guard stays `active` through one failed round, with the error shown.
   - **Back-off:** after four failed rounds in a row keyd asks at the 5-minute cadence (so STUN
     is not asked every 30 s for as long as the guard is unknown).

   Pins: `TestLearnKeepsAKnownGuardActiveForOneFailedRound`,
   `TestKeepAsksLessOftenAfterAFewFailedRounds` and `TestKeepAsksAtOnceWhenTheGatewayChanges`
   (592–660). All three are RED on fix pass 1's `public.go` (unknown after one round, 32 asks in
   0.5 s, no re-ask after a gateway change).
5. **`doctor` for a user who opted out.** Recorded under Interfaces (12902): M9's doctor needs a
   warning level for `hairpin-guard` `off`/`unknown`. No code change.
6. **R30's cost: superseded by P4b-C4** (below).
7. **`SkippedCellsError`'s wording** (Task 9). The new message: "cell records this daemon can't use
   (unreadable, or outside its keyd ports) may still hold keyd ports. Fix <folder> to start those
   computers again, or remove a folder and then its containers (<names>), before creating another
   computer". The reconcile's log line says "can't be used" too. Pin: "names the folder to fix and
   the containers to remove…" now asserts the whole message.
8. **The guard state for assistive technology.** `keyStatus` gives `spoken`, and the Keys button's
   accessible name is "Keys, hairpin guard unknown" (or "off"). Its text stays "Keys", so
   `keys.spec.ts`'s `toHaveText("Keys")` holds. Pins: "names the hairpin guard's state on the Keys
   button…" (10375, RED without `aria-label`); `keyStatus`'s test asserts `spoken` for unknown and
   off.
9. **The canary's base64 offsets** (Task 15; scanner at 12426, controls at 12575).
   - `b64_runs` encodes the needle at offsets 0, 1 and 2, keeping only the characters that stand
     for its own bytes. Offset 0 now drops the last partial group too, which fix pass 1's form kept
     (a trailing-edge blind spot inside longer blobs).
   - Labels: `base64`, `base64+1`, `base64+2`, and the same for `base64url`.
   - Two new planted controls: the marker inside a base64 blob at offset 1 and a base64url blob at
     offset 2. The canary's own scan must find them.
   - Checked locally: the new forms find the marker in 48 of 48 synthetic blobs (offsets 0–5, tails
     0–3, both alphabets), against 8 of 48 for fix pass 1's.

## CA trust (P4b-C4; supersedes I5's "server auth only through a trust-store purpose")

- **What changed:**
  - **The oneshot** (Task 7, 5676) installs `ca.pem` with `openssl x509 -in … -out …`, a plain
    `CERTIFICATE`, through `update-ca-certificates`. NSS stays `C,,`, and no per-store purpose flag
    is used. Task 7's text cites `cellca.go`'s template (lines 78–86 at `70a534e`): `ExtKeyUsage:
    serverAuth`, critical permitted DNS names, excluded subdomains, every IP excluded.
  - **desktopd's `ca-system`** (6509) passes on the CA's DER as a plain `CERTIFICATE`. The
    `TRUSTED CERTIFICATE` form alone fails: Go, rustls, GnuTLS and Java skip it.
  - **The Docker test** (`desktop-keyd-files.docker.test.ts`, test at 5573):
    - the bundle holds one plain copy and no trusted one;
    - `MINT_SH` mints a CA with `cellca`'s profile and leaves for `bound.localdot.test`,
      `other.localdot.test` and `api.bound.localdot.test`;
    - `openssl verify -purpose sslserver` accepts the bound leaf and refuses the others (exit 2,
      permitted and excluded subtree violation);
    - a Go verifier (`VERIFY_GO`, built `CGO_ENABLED=0 GOOS=linux GOARCH=<engine arch>` with the
      keyd toolchain, `docker cp`'d in) answers `ok`, "not permitted by any constraint" and
      "excluded by constraint";
    - curl and Python trust the bound leaf over `openssl s_server`, with an `/etc/hosts` line for
      the name.
  - **Text:** R30 is rewritten (13198) with the ruling's cost; R20, the Interfaces and the
    Architecture follow; the "GnuTLS clients do not trust the cell's CA" note is removed.
- **Pinning:**
  - desktopd's `selftest.test.ts`, "fails unless the system store holds the cell's CA as a plain
    anchor, which every client reads" (6046). 7 of its 11 tests are RED on fix pass 1's check,
    which failed every plain bundle.
  - The Docker pin above, which did not run (no Docker). Its shell and Go sources were evaluated
    from the test file and run on Linux (Verification below).

## Part 4a rebase check (`70a534e`)

- **Policy** (`fb12271`): a throwaway Go test against `internal/policy` confirmed every refusal
  Task 14 expects, at both the plain-HTTP and CONNECT steps:
  - `ip-literal` for IPv4 literals and `[::1]`;
  - `port-not-allowed`;
  - `host-denied` for `printer.local`;
  - `host-invalid` for `localhost`.

  It also confirmed the binding hosts: `xn--bcher-kva.example` and `postman-echo.com` accepted;
  `bücher.example`, `localhost`, `printer.local`, `[::1]` and `1.1.1.1` refused. The web form
  only sends ASCII hosts and `new URL(x).href` base URLs, and 4b sends no non-canonical port. No
  change needed.
- **The scrubber's empty-replacement refusal:** 4b builds no replacement. No change.
- **`keys` as built** (Task 9's final API: lenient Basic, user information, opaque targets and
  fragments scanned, `..`-like segments refused for limited paths, all-or-nothing `ApplySwaps`, the
  Q1 Basic pair). Read against `inspect.go` and `binding.go`:
  - Task 3's misplaced surrogate (`x-leak` to `example.com`) is still `misplaced-surrogate`;
  - Task 14's unknown, wrong-header, plain-HTTP and in-path surrogates still give
    `unknown-surrogate`/`misplaced-surrogate`;
  - Task 15's bearer swap is unaffected;
  - 4b sends no method or path limits (R9);
  - the form's Basic formats require `Authorization`, as `httpBinding` does.

  No change needed.
- **`netguard` and `cellca`** are unchanged since `56990a5`, so Task 1's anchors hold.
- **Still plan text:** `admin`, `egress`, `llm` and `cmd/keyd` (4a's Task 10 is in progress), so
  Task 1's edits to `cmd/keyd` and `admin` need a re-sync at 4b's pre-flight. Recorded in
  Verification item 4.

## Verification runs

- **Setup:** Node 24.21.0 and pnpm 10.29.3 at `/opt/node24/bin`, TypeScript 7.0.2, Biome 2.5.15,
  Vitest 5.0.3, Go 1.27.1, OpenSSL 3.0.13 (Ubuntu 24.04).
- **TypeScript:**
  - `pnpm -r typecheck`: clean in every package of the scratch tree (Part 2 + 4b);
  - `biome check apps packages cells`: clean;
  - `pnpm hygiene`: clean (in a throwaway `git init` of the scratch tree).
- **Vitest:** 59 files, 524 passed, 3 skipped (Docker-only).
  - `kill-switch.test.ts` 19, five runs in a row;
  - `kill-switch-routes.test.ts` 5, against a stand-in `gatewayRoutes` with the plan's Stop, Resume
    and `withReadyCell` text;
  - `orchestrator-keyd.test.ts` 17, `cell-wiring.test.ts` 5;
  - desktopd `selftest.test.ts` 11;
  - web 12 files, 66 tests (`App.test.tsx` 8, `KeysSheet.test.tsx` 11).
- **Go** (`keyd-scratch`): `gofmt -l .` empty, `go vet ./...` clean, `go test -race ./...` 9
  packages ok, `netguard` `-race -count=5` ok.
- **Red first:** as listed per finding above.
- **The trust chain on Linux:**
  - the Docker test's `MINT_SH` and `VERIFY_GO`, evaluated from the test file, were run with the CA
    installed plain into a temporary `update-ca-certificates` store: 1 plain anchor, 0 trusted;
  - OpenSSL: bound OK, other error 47, subdomain error 48;
  - Go: ok, not permitted, excluded;
  - curl through `openssl s_server`: verify result 0;
  - Go against the `TRUSTED CERTIFICATE` form alone: "certificate signed by unknown authority".
- **Not verified:**
  - **Docker:** every Docker suite, including this pass's changes to `desktop-keyd-files` and
    `canary`; the oneshot and `update-ca-certificates` in the Ubuntu 26.04 image; NSS in
    Chromium.
  - **Unavailable clients:** GnuTLS, rustls and Java against the plain anchor.
  - **Part 3, unbuilt:** the real `gatewayRoutes`, `main.ts`, `Hud`, and Task 13's `App`, `Hud`,
    `StageColumn` and `PlanRail` edits.
  - **Part 2's Task 15 harness:** `keys.spec.ts` and `stop-and-keys.spec.ts`.
  - **Part 4a's unbuilt packages,** and Task 1's `cmd/keyd` and `admin` edits.
  - **Not exercised here:** a NAT-PMP router; `TestKeepAsksAtOnceWhenTheGatewayChanges` on
    macOS.
  - **Part 2's web fix round:** it has not landed (pre-flight).

## Concerns for the controller

- **I-1's cost:** a computer whose freeze failed now loses its running programs, as Stop computer
  would. That is the review's fix; R6 records it.
- **Minor 1:** Start on a computer Docker still holds frozen reboots it, through the API too. The
  HUD never offers Start for a paused cell, only Resume and Stop.
- **The Go verifier in Task 7's Docker test** needs the Go toolchain on the Mac (the keyd tests'
  `go`, or `GO`), and `docker version`'s server architecture.
