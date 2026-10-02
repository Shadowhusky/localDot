# Part 4b plan — revision 1 change log (review-1 fixes under P4b-C1 and P4b-C2; line numbers refer to the revised plan, 12,766 lines, was 10,784)

Inputs:
- `part4b-review-1.md` and `part4b-rulings.md` (P4b-C1, P4b-C2);
- the controller's two orchestrator fixes, logged under I7;
- Part 2: read only, with `git show` and `git archive` from `feat/core-part2`. The rebase started at `4384f20` and was re-synced at the end to `1ba1659`;
- Part 4a: read only, from `feat/core-part4a` at `56990a5`;
- Part 3: through its plan's "Interfaces Part 4 builds on" and `part3-rulings.md`. Revision 6 (P3-C16 to P3-C18), which landed during this pass, was re-checked at the end.

All work was done in `scratchpad/part4b-fix`:
- `plan/`: the templates and `build.py`. The plan is that script's output byte for byte, with every code block embedded from the verified trees.
- `repo/`: the TypeScript tree (Part 2 as built, Part 2's Tasks 13–15 and Part 3 from their plan text, and 4b).
- `keyd/`: 4a's built packages, 4a's plan for the rest, and 4b's changes.
- `trees/`: read-only copies.
- `plan-orchestrator-on-p2head.ts`: the first draft merged onto Part 2, for the RED runs.
- `orchestrator.task9.ts`: Task 9's intermediate state.
- `i5/`: the trust-setting checks.
- `red-green.txt`, and `plan-original-backup.md`.

No git working tree or ref was touched, no Docker command ran, and no subagent was used. Nothing outside the scratch folder was edited but the plan and this log. The only exception is temp folders in `$TMPDIR` that this pass's own test runs created, which were removed.

## Where each task changed

| Task | Change |
|---|---|
| 1 | P4b-C2: NAT-PMP to the router first, then one STUN server (Cloudflare), with `-natpmp on\|off` and `-stun host:port\|off`. keyd retries every 30 s while the address is unknown and every 5 min once known, and `/v1/status` reports `hairpin`. |
| 2 | `SELFTEST_CHECKS` / `SELFTEST_CHECK_IDS` (eleven), and `selfTestPassed` requires each check exactly once (I3). Also `HairpinGuard` and `surrogateEnvClash` (M2). |
| 3 | keyd is built once per run in a Vitest global setup, with a teardown (M6). The harness runs keyd with `-natpmp off -stun off`. |
| 4 | `KeydHealth.hairpin`. A keyd without the field reads as `unknown`. The doctor gains `keyd` and `hairpin-guard` checks, and the routes answer `409 name-taken` (M2) and use `bodyLimit` (I7). |
| 5 | The fake Docker behaves like Docker: a paused container stops, and starting one answers 409 (this exposes C1). It keeps Part 2's `failRequests`, API refusal, 409s and 403s (I7), and `DockerRequest` keeps Part 3's `timeoutMs` (N4). |
| 6 | The Step 4 text (M13). |
| 7 | The CA goes into the system store as a `TRUSTED CERTIFICATE` for serverAuth only, and into NSS as `C,,` (I5). |
| 8 | New self-test checks: `gateway` (I4), and `ca-system` and `ca-nss` (I5). Readiness keeps Part 2's capped reader and boolean `ok` (I7). |
| 9 | I1, the I4 refusal, the clamp, the controller's fixes 1 and 2, and N2. The edits are rebased onto Part 2's queued orchestrator, `#records` and `inventory()`, and every direct Docker-test probe gets `--noproxy '*'`. |
| 10 | C1, I2, M8, M9 and N1, plus `StopOutcome.closed`. |
| 11 | `findDockerSocket()` (I6). `refreshRunningCells` takes `starting` cells (M14), and the e2e keyd is cleaned up (M6). A note covers Part 3's background reconcile. |
| 12a / 12b | Split (M10). The sheet's banner and the top bar show the hairpin guard's state (C2). Also the focus trap (M3), a text field drawn as dots (M4), and the select overflow fix (N3). |
| 13 | `os: "linux"` (M7). |
| 14 | The runtimes test is renamed (M5). |
| 15 | Canary scan controls (M1). |
| 16 | The README covers Stop's close-on-failed-freeze, Resume's revoke and the hairpin guard, and the leftover check covers keyd build folders. |

Outside the tasks, these sections changed:
- the goal, architecture and Global Constraints;
- Review Focus 1–9 (141–204), with a new bullet under 8;
- the File map (205–228, rows 12a and 12b);
- "Interfaces later parts build on" (12363–12466), including "Not in Part 4b";
- the Decisions (12467–12679);
- Verification (12680–12766), rewritten.

## Critical

**C1 — a keyd restart no longer undoes Stop's freeze** (Task 10, 7685–8469; R7 at 12527).
- **What changed:**
  - `#rewireIfLost` returns at once for a paused cell (8369–8375), and Resume rewires it.
  - Task 5's fake now stops a paused container as Docker does, and refuses to start one with 409. The reboot the review describes is therefore visible in unit tests.
- **Pinning test:** `kill-switch.test.ts` "keeps a frozen computer frozen when keyd restarts". It is RED against the first draft (one of the 8 of 15 below).

## Important

**I1 — the sweep is scoped to this home's unreadable records** (Task 9, 6576–7684; R14 at 12571; Review Focus 9).
- **What changed:**
  - `reconcile()` reads `inventory()` once.
  - `#stopSkipped(skipped)` closes each skipped cell in keyd and stops its two containers by exact name. It removes nothing.
  - The label-based orphan sweep is gone, and so is its container listing.
  - R15's cost line is updated.
- **Pinning tests:** "stops the containers of a cell whose record can't be read, closes it in keyd, removes nothing", and "never touches a cell of another home, whatever its prefix" (two orchestrators, two homes, one prefix). Both are RED on the first draft.

**I2 — Stop fails closed, and Resume revokes before it mints** (Task 10; R6 at 12508, R22; Task 16's README).
- **What changed:**
  - When the pause fails, `stopSession` closes the cell in keyd, and `StopOutcome.closed` says so.
  - `resume` revokes first, then thaws and refreshes, or restarts the desktop if keyd lost the cell.
- **Pinning tests:** "closes the cell in keyd when the desktop cannot be frozen, so nothing in it reaches the web" and "revokes again before it mints, so a revoke Stop could not make still holds". Both are RED.

**I3 — readiness requires every check, each exactly once** (Tasks 2, 8 and 9; R28 at 12651).
- **What changed:**
  - `SELFTEST_CHECKS` in `@localdot/protocol` is the list, now eleven checks, `gateway` included.
  - `selfTestPassed` requires each id once and every check `ok`.
  - desktopd builds its report from that list.
  - Task 9 names a missing check as `<id>: missing`.
  - The fixtures are full reports.
- **Pinning tests:**
  - protocol `selftest.test.ts`: "fails a report that leaves a check out, whatever the rest says" and "fails a report that names a check twice, or fails any check, even one it added". 2 of 3 are RED against the old `selfTestPassed`.
  - orchestrator-keyd: "names a check the self-test left out when a cell never gets ready", RED.

**I4 — the gateway address is checked twice** (Tasks 8 and 9; R29 at 12658).
- **What changed:**
  - **In the cell:** desktopd's `gateway` check takes the internal subnet from `/proc/net/route` and connects over TCP to its first host address on two ports. A connection or a refusal fails the check; unreachable or a timeout passes.
  - **Outside the cell:** `#subnet(id, { isolated: true })` refuses an internal network whose IPAM reports a gateway. The create is undone, and the error says to run the doctor.
- **Pinning tests:**
  - desktopd: "fails when the network's gateway address answers, even with a refusal" and "tells a refused or unroutable connection from a connected one". These are among the 7 of 11 that are RED against the old `selftest.ts`, together with I5's.
  - orchestrator-keyd: "refuses an internal network that has a gateway address, and undoes the create", RED.

**I5 — the cell's CA is trusted for TLS server auth only** (Tasks 7 and 8; R30 at 12667, with R20 following; "Not in Part 4b").
- **What changed:**
  - The oneshot installs the system copy with `openssl x509 -addtrust serverAuth`, and never as a plain anchor. NSS holds the CA as `C,,`.
  - `ca-system` fails on any plain copy of the CA, and passes only on a `TRUSTED CERTIFICATE` that is the CA's DER followed by exactly `300c300a06082b06010505070301`. Task 7's Docker test also checks that the CA is in the bundle once.
  - `ca-nss` checks Chromium's store.
- **Pinning tests:** desktopd's "fails unless the system store trusts the cell's CA for TLS server auth only" and "fails when Chromium does not trust the cell's CA, or trusts another one", plus `desktop-keyd-files.docker.test.ts` (Docker, not run).
- **Evidence** (`i5/`, OpenSSL 3.6.3 on the Mac):
  - a TLS leaf verifies against the `TRUSTED CERTIFICATE`;
  - a code-signing chain is refused (error 28);
  - a plain copy of the CA, alone or beside the trusted one, accepts that chain.
- **Residual:** GnuTLS 3.8.13 skips the `TRUSTED CERTIFICATE` block, so git's HTTPS transport and GLib programs fail on a key-bound host. They fail closed; this is recorded.

**I6 — `findDockerSocket()`** (Task 11, the `main.ts` snippet): `new DockerClient(findDockerSocket().path)`. No unit test can tell the two apart. Part 3's `main.test.ts` runs this `main.ts`.

**I7 — rebase.** See "The rebase" below.

**I8 / P4b-C2 — the hairpin guard: router first, one STUN provider, retried, and visible** (Task 1, 229–1344; Tasks 2, 3, 4, 12a and 12b; R16 at 12587).
1. **The router.** keyd sends NAT-PMP's external-address request (RFC 6886) over UDP 5351 to the default gateway, found with macOS's `route -n get default` or Linux's `/proc/net/route`. It resends after 250 ms, then after twice as long each time, until 3 s have passed. An answer in private or shared space means the router sits behind another NAT, and is not taken as public.
2. **STUN, only if the router has no public answer.** keyd asks one server, `stun.cloudflare.com:3478`, with an RFC 8489 Binding request over UDP/IPv4. `-stun off` and `-natpmp off` are the settings.
3. **Retries.** keyd asks every 30 s while the address is unknown and every 5 min once it is known. It keeps up to 16 learned addresses.
4. **Visibility.** `/v1/status` reports `hairpin { state: active|unknown|off, source?, addresses, checkedAt?, error? }`, and `GET /api/keyd` carries it. The doctor's `hairpin-guard` check fails when the state is `unknown` (with keyd's reason) or `off`. The Keys sheet shows a banner, and the top bar a `guard` state. A keyd that reports no field reads as `unknown`, never `active`. Egress is not cut while the state is unknown, as ruled, but the state is shown everywhere. The IPv6 residual is in "Not in Part 4b".
- **Pinning tests:**
  - Go: `TestLearnAsksTheRouterFirstAndNoThirdParty`, `TestLearnAsksSTUNOnlyWhenTheRouterHasNoPublicAnswer`, `TestLearnSaysUnknownWhenNothingAnswersAndKeepsWhatItHad`, `TestLearnIsOffWithBothSourcesOff`, `TestKeepAsksAgainSoonWhileTheAddressIsUnknown`, `TestParseNATPMP`, `TestGatewayLookups`, `TestParseBindingSuccess(RefusesAnythingElse)`, and in `cmd/keyd` `TestStartLearnsThePublicAddressItDeniesAndReportsTheGuard` and `TestStartWithDiscoveryOffSaysTheGuardIsOff`.
  - TypeScript: `keyd.test.ts` (the `HairpinGuard` parse); routes "report keyd's health with its seal key, audit state and hairpin guard"; three new tests in `doctor.test.ts`; KeysSheet "says whether the hairpin guard knows this network's public address"; and `keyStatus`'s `guard`.
- **Live run:** on this Mac's network the router refused NAT-PMP (port unreachable), and keyd fell back to STUN. The result was `active` from `stun`, with one address, in 15 ms.

## Minor

- **M1** (Task 15). The scan counts bytes actually read. The canary test scans for the planted marker together with the canary and requires the marker's hits: in a raw file, a base64 file, the environment and memory. Docker, not run.
- **M2** (Tasks 2 and 4; R31). `surrogateEnvClash` refuses a name whose `LOCALDOT_KEY_` variable is taken, with `409 name-taken`. Pinned by routes "refuse a name whose variable another key's stand-in already has" and by `keyd.test.ts`.
- **M3** (Task 12b). Applied in part:
  - Press feedback comes from Part 2's global `button:active` (`theme.css`, at 1ba1659: scale 0.97, or opacity 0.6 under reduced motion), so there is no per-button rule.
  - The focus trap is new, pinned by "keeps Tab inside the open sheet".
- **M4** (Task 12b; R10 at 12546). The key field is a text field drawn as dots (`-webkit-text-security: disc`), cleared before the save settles. The KeysSheet test pins `type: "text"`. Chrome's save bubble was not observed, since Playwright cannot see browser UI.
- **M5** (Task 14). The test is renamed "takes Node's fetch and Python through the proxy, and keeps it for sudo and apt".
- **M6** (Tasks 3 and 11).
  - `keyd-build.ts` is a global setup for the keyd and Docker configs that builds once and removes its folder at teardown.
  - The e2e `startKeyd` removes its build folder on exit and kills keyd if the test process dies.
- **M7** (Task 13). The stage-model test writes `os: "linux"`.
- **M8** (Task 10). A gate that dies while the computer is frozen comes back with the desktop still frozen (`#startContainers(…, frozen)`). A frozen desktop that dies fails the cell and is never restarted. Pinned by "brings a frozen computer's gate back and keeps the desktop frozen" and "never starts a frozen computer's desktop again behind the user's back".
- **M9** (Task 10). Resume needs keyd before anything thaws. While keyd is offline it answers 503 and the computer stays frozen. Pinned by "keeps the computer frozen while keyd is offline, and says so" and the routes test "keeps a paused computer frozen with 503 while the key layer is offline".
- **M10.** Task 12 is split into 12a (`binding`, `keys-api`, `useKeys`, `keyStatus`) and 12b (the sheet, CSS, App and TopBar, the e2e spec and the screenshots).
- **M11** ("Not in Part 4b"). Three notes added: "keyd down → the task pauses" is M4's; Stop needs a live session, and "Stop computer" covers the rest; and the IPv6 hairpin residual.
- **M12.** `audit-rotated` is noted in Task 4 and in "Not in Part 4b" as M9's doctor's.
- **M13** (Task 6). "spawns `forwarder-main.ts` through tsx" (5060).
- **M14** (Task 11). `refreshRunningCells` takes `starting` cells too. Pinned by "refreshes running and booting computers, and says when one must restart to use the key".

## Decisions

- **Stand:** R1, R2, R17 and R18.
- **Stands with R14 scoped:** R15, whose cost line no longer sweeps containers.
- **Changed:** R6 (I2, M8, M9), R7 (C1), R14 (I1) and R16 (P4b-C2).
- **Follow:** R20 (NSS and the TLS-only system copy) and R22 (`closed`).
- **New:** R28 (I3), R29 (I4), R30 (I5) and R31 (M2).
- **Rewritten:** R10 (M4).

## The rebase (I7)

**Part 2 as built** (`4384f20` during the work, `1ba1659` at the end):
1. **Readiness** (Task 8): `readCapped` (64 KiB; Part 2 now exports it for its stream proxy) and `isHealth` (a boolean `ok`) are kept. `/selftest` is read through the same capped reader with `SELFTEST_TIMEOUT_MS` (8 s). Part 2's readiness tests pass unchanged, with 6 new ones.
2. **The store and `create()`** (Task 9): `inventory()` is read once, in `reconcile()` and in `create()`. `SkippedCellsError` is kept, and its message now names `<LOCALDOT_HOME>/cells/<id>` and `<prefix>*-<id>`; Part 2's `api.test.ts` still builds it from ids alone. **Controller fix 1**, pinned by "names the folder to fix and the containers to remove while a record can't be read".
3. **keyd ports** (Task 9): the ports in use are the on-disk records', plus every cached record's (`[...this.#records.values()].map((r) => r.keydPort)`), plus in-flight reservations. **Controller fix 1**, pinned by "counts a running cell whose folder was deleted by hand when it hands out a port".
4. **Remove** (Task 9): `#remove` sets a `stopping` entry before its first await. **Controller fix 2**, pinned by "emits no failure while a remove runs, even as the watch finds a container gone". Part 2's "lets a remove that lands while readiness awaits its probe win" now expects `["starting", "starting", "stopping", "removed"]`.
5. **Cached records** (`#record` and `#records`) are used by rewire, refresh and the kill switch, never the store.
6. **`endpoints()`** stays undefined unless the cell is ready, and 4b never calls it. A frozen cell is `ready` with `paused`, and `withReadyCell` answers 409.
7. **The raw-IP probes:** `--noproxy '*'` on every direct probe in `orchestrator.docker.test.ts`, the two name probes and Part 2's three raw-address probes.
8. **The clamp:** the self-test's detail and the gateway address go through `clamp` (`MAX_DETAIL`, 200 characters).
9. **`findDockerSocket()`:** see I6.
10. **The fake Docker** (Task 5): `failRequests`, the API version refusal, the 409s and the 403s are kept.
11. **The doctor** (Task 4): Part 2's checks are kept, and `keyd` and `hairpin-guard` follow its port check. `doctor-main.test.ts` runs on a home with no keyd, so it never asks the user's own.
12. **The API:**
    - The key routes use Hono's `bodyLimit` (64 KiB), as the cell API does.
    - Part 2's `app.onError` (`1ba1659`) answers anything they throw with a bare 500.
    - `CellSummary.paused` rides Part 2's status socket (`followCell`) unchanged.
    - Part 2's ticket revoke in `finally` on any removal is untouched.
13. **The IPv6 pin:** Part 2's networks keep `EnableIPv6: false`, and 4b's `direct-ipv6` check stays as a second guard.
14. **`1ba1659`'s additions are kept** by the "keep every option" steps: `createApp`'s `desktop` and `ui`, the stream proxy, and `main.ts`'s desktop route. The anchors (`if (cells) cellRoutes(app, cells);` and the orchestrator's construction) are still there.

**Part 4a as built** (`56990a5`):
- `[surrogate:<ID>]`: R27, the router test and Task 14's audit assertion.
- Audit rotation: not surfaced (M12).
- The vault's fail-closed Put: mapped to 502 `vault`.
- netguard's network refusal and zero-address rule: Task 1's anchors in `guard.go` and `guard_integrity_test.go` match, and netguard is unchanged since.
- The CA's lowercase hosts and subdomain exclusions: Task 14's passthrough test relies on them.
- `scrub` (`fa07db9`, `aa65b40`) and `policy` (`56990a5`): no 4b dependency, and their tests pass in the assembled module.

## Found while verifying

- **N1 — a resumed computer was not watched** (Task 10): pausing ended the watch loop, and nothing restarted it. Pausing and resuming now each start a fresh watch. Pinned by "watches a resumed computer again, so a crash is restarted" (RED in the 8 of 15).
- **N2 — the reconcile never asked keyd** (Task 9; Task 10's snippet; Task 11; Review Focus 8; R7; Interfaces).
  - **Cause:** the keyd monitor starts before the reconcile, and Part 3's revision 6 Task 12 moves the reconcile to the background. The monitor's first "came up" can therefore reach a cell before the reconcile has set its state, and `rewireIfLost` then does nothing. A cell keyd lost while the daemon was away would fail its self-test until the ready timeout.
  - **Fix:** `#rewireIfLost` resolves whether it took the cell over, and the reconcile's running branch calls it before waiting for readiness.
  - **Pinning test:** "rewires a computer keyd lost while the daemon was away, even when keyd answered first". It is RED on the current code (1 desktop start, not 2), and the first draft now fails 9 of 16.
- **N3 — the "Sent as" select ran past the sheet** (the 12b screenshot): the pair's columns are now `minmax(0, 1fr)`, the fields have `min-width: 0`, and the screenshot was re-checked.
- **N4 — Task 5's `DockerRequest` block would drop Part 3's `timeoutMs`** if copied as written. It now keeps it, and "In `request`" now reads "In `#send`".
- **Wording.**
  - R10 and two comments still described a password field.
  - Task 4 claimed `doctor-main.test.ts` "passes unchanged", although it gains one env line.

## Not applied, or applied differently

- **PCP.** keyd sends NAT-PMP's request only. A PCP-only router answers with version 2, which counts as no answer, so STUN follows. PCP's MAP request would create a mapping on the router, so it is never sent ("Not in Part 4b"; R16).
- **I3's "ten ids"** are eleven: I4's `gateway` joined the list.
- **M3:** see Minor.
- **M4's Chrome check:** not observed.
- **M5:** renamed, not extended.
- **I5's "curl, Python and apt still load the bundle":** covered by the `desktop-keyd-files` and `cell-egress` Docker tests, which did not run.
- **Docker:** no Docker suite ran in this pass, per the task's constraint.

## Verification runs

- **Go 1.27.1:**
  - `gofmt` and `go vet` are clean.
  - `go test -race ./...`: 13 packages, 253 top-level tests, and 1 skip (4a's opt-in login-keychain test).
  - `netguard`, `cmd/keyd` and `admin` passed five more runs under `-race`.
  - The live discovery run is described under I8.
- **TypeScript:**
  - tsc 7.0.2: all six packages clean.
  - Biome 2.5.15: 2 errors and 1 warning, all pre-existing (the control characters in Part 3's `text.ts`, and Part 2 Task 14's `.stage-veil` specificity).
  - `hygiene` passes.
- **Vitest 5.0.3:**
  - 64 files and 542 tests, counting the Part 3 stand-in's Task 12 tests. Every count in the plan's steps matches.
  - keyd suites: 2 files and 5 tests, with no keyd process or build folder left behind.
  - Task 9's intermediate state: 6 suites, 117/117.
- **RED runs** against the first draft:
  - protocol `selftest.test.ts`: 2 of 3;
  - desktopd `selftest.test.ts`: 7 of 11;
  - `orchestrator-keyd.test.ts`: 9 of 16;
  - `kill-switch.test.ts`: 8 of 15.
- **Playwright 1.63.0 with Chrome 154:** `keys.spec.ts` passed 2/2 against the daemon and a real keyd, and both screenshots were checked.
- **Part 3's `main.test.ts`** with 4b's `main.ts`: `/healthz` answers while a wedged Docker holds the reconcile.
- **The plan:** `build.py`'s output equals the written plan byte for byte.

## Part 3 assumptions (plan text, not built; re-checked against revision 6)

- **Daemon:**
  - `gateway/live.ts`: `LiveSessions` is unchanged in revision 6, and Task 10's replacement keeps its API and adds `settled`.
  - `gateway/routes.ts`: the stop route and `withReadyCell`'s `cell.state !== "ready"` anchor are unchanged, and so is `GatewayRoutesDeps`.
  - `main.ts`: the `gateway` option with `live: new LiveSessions()`, and the background reconcile, handled by N2.
  - Task 12's `DockerClient(socketPath?, timeoutMs)`, handled by N4.
  - The desktopd registry.
- **desktopd:** `DesktopdDeps` and `createDesktopdApp` (the names are unchanged), the `/healthz` not-ready semantics (F1), and the test helpers.
- **The image:** `localdot-chromium` (revision 6 keeps `--start-maximized --force-renderer-accessibility --remote-debugging-port=9222`, and Task 7's replacement keeps those flags).
- **Web:** `Hud.tsx`, `StageColumn.tsx`, `PlanRail.tsx`, `session-view.ts` (`mergeHud`, `stepRows`), and `useCell`'s run error.
- **Stage:** `model.ts` (`foldEvents`, `SessionModel`) and its test.
- **Protocol:** `clipText`.
- **Never ran:** `stop-and-keys.spec.ts` and the stage model test, which need Part 3's puppet, terminal launch, step list and event schema. `kill-switch-routes.test.ts` ran against a stand-in `gatewayRoutes` with stub `Clock` and `DesktopdRegistry`.

## Other unverifiable items

- **Part 2 after `1ba1659`:** Tasks 13–15 in their plan form (Task 13, the Theatre shell, was being built during this pass): `App.tsx`'s `Theatre`, `TopBar.tsx`, `app.css`, `hud-state.ts`, `useCell.ts` and `e2e/daemon.ts`.
- **Part 4a after `56990a5`:** `admin.go`'s status handler, `cmd/keyd/main.go` (`Config`, flags, `Serve`), `egress`, `keys` and `llm`, all from the 4a plan.
- **Docker:**
  - none of `desktop-keyd-files`, Part 2's `orchestrator.docker.test.ts` with keyd, `cell-egress`, `canary`, Part 2's `desktop-image.docker.test.ts` or `live-desktop.spec.ts` ran;
  - the Dockerfile edit;
  - Ubuntu 26.04's `update-ca-certificates` keeping the `TRUSTED CERTIFICATE`;
  - NSS in Chromium.
- **A router that answers NAT-PMP:** only the fake router was tested.
- **The CI job.**

## Observations outside this plan

- Part 2's e2e harness (plan form) never removes its `local dot's e2e-*` home. That home holds the daemon token and index, and now keyd's audit log.
- Part 3's Task 12 `main.test.ts` leaves its `ld-wedged-*` and `local dot's main-*` folders behind. 24 from earlier runs, not this pass's, were left alone, as were 5 older `localdot-keyd-bin-*` folders.
