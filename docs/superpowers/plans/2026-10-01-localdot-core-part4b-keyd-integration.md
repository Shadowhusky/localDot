# localDot Core — Part 4b: keyd Integration (M3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Part 4a's keyd into localDot so that milestone M3 is done: the daemon talks to keyd
over its admin socket; every desktop cell is opened in keyd before it starts and reaches the web
only through its own keyd listener, with its CA installed for every runtime and for Chromium;
`desktopd`'s boot self-test proves that and the readiness gate requires it; keys are added in the
Theatre through a form that seals them in the page; keyd's key use reaches the session log; Stop
revokes a cell's keys and freezes its processes; keyd learns the network's public address (from
the router first) and denies it, and says when it cannot; and the canary test and S4's probes pass
against real cells.

**Architecture:** keyd runs beside the daemon (dev: `pnpm keyd`) and owns every secret. The daemon
reaches it only through `<home>/keyd/admin.sock`, and only while that socket and its folder are
private to the user. Before a desktop starts, the daemon opens the cell in keyd on the cell's
listener port and writes three files into the stopped container with Docker's archive API:
`/etc/localdot/cell/proxy-token`, `ca.pem` and `surrogates.sh`. At boot, an s6 oneshot installs the
CA into the system store and into the desktop user's NSS database (Chromium). A small forwarder on
the cell's loopback (`127.0.0.1:3129`) adds the proxy token and relays to the gate (`<gate>:3128`),
which relays to keyd. So every program, Chromium included, uses one credential-free proxy URL, and
no token, CA or surrogate ever sits in the container's environment. `desktopd`'s `GET /selftest`
proves there is no route, no DNS, no IPv6, no host, no LAN and no reachable gateway address, and
that the gate answers with the cell's own keyd, which wants its token. It also proves the CA is
installed, for TLS server auth only. The orchestrator marks a cell ready only when every one of the
eleven checks passes, and stops it at once on an isolation failure. The key form seals each key
with WebCrypto to keyd's per-boot key. The daemon relays only `{ binding, sealed }`. Stop aborts the
session, revokes the cell in keyd and then pauses the desktop container; a desktop that cannot be
paused loses its keyd listener instead. Resuming revokes again, thaws the desktop and hands out
fresh surrogates.

**Tech Stack:** Everything Parts 2–4a pinned: host Node 25.6 (cells Node 24.21.0), pnpm 10.29.3,
TypeScript 7.0.2, Biome 2.5.15, Vitest 5.0.3, Hono 4.13.12, zod 4.6.5, React 19.3.0, Vite 8.3.1,
@playwright/test 1.63.0 on system Chrome, Go 1.27.1 (`/opt/homebrew/bin/go`) for keyd. Also the
browser's and Node's WebCrypto (ECDH P-256, HKDF-SHA256, AES-256-GCM), Docker Engine API 1.47+
(`PUT /containers/{id}/archive`, `pause`, `unpause`), Ubuntu's `libnss3-tools` (`certutil`, already
in the desktop image) and `ca-certificates`. No new npm, Go or apt dependency.

**Spec:** `/Volumes/Husky's SSD 4T/Projects/docs/superpowers/specs/2026-09-30-localdot-core-design.md`
is the authority: "Trust rules" 1, 3 and 6, "Key layer (keyd)", "Safety and control",
"Error handling" (keyd down, self-test fails at boot), "Testing" (Security) and "Milestones" M3.
Success criterion 5 is the one that counts here. Interfaces this plan builds on:
- Part 4a (`…/plans/2026-10-01-localdot-core-part4a-keyd-core.md`): "Interfaces Part 4b builds on"
  and "Part 4b obligations".
- Part 3 (`…/2026-10-01-localdot-core-part3.md`): "Interfaces Part 4 builds on".
- Part 2 (`…/2026-10-01-localdot-core-part2.md`): the orchestrator, `ports.ts`, `spec.ts`, the gate
  relay.

Evidence, read from `main`: `spikes/s3-network/FINDINGS.md` and `spikes/s4-keyd/FINDINGS.md`
(Chromium, NSS and `--disable-quic`). The controller's carries are in the Part 2 ledger
(`localdot/.superpowers/sdd/2026-10-01-localdot-core-part2/progress.md`): orphaned containers of an
unreadable cell record, exit statuses, worker threads and percent-encoded Docker names. The UI
direction is `…/design/2026-09-30-localdot-ui-directions/README.md` (C: Theatre), together with
`~/.agents/skills/apple-design/SKILL.md`.

**This is Part 4b of the core plan.** It runs after Part 3, on a branch that holds Parts 2, 3 and
4a (Task 1 creates it). Most of the code below was built and run on the development Mac before
this plan was written. The "Verification" section says against which base, and lists what could
not be run: chiefly the edits to Part 3's files, which exist only as Part 3's plan.

## Global Constraints

- Repo root: `/Volumes/Husky's SSD 4T/Projects/localdot`. Work on branch `feat/core-part4b`, created
  in Task 1 from `feat/core-part3` with `feat/core-part4a` merged in. Never commit on `main`. Quote
  the path in every shell command (it has a space and an apostrophe). Go commands run from
  `"/Volumes/Husky's SSD 4T/Projects/localdot/keyd"`.
- Commit messages: conventional `type(scope): summary`. **Never add `Co-Authored-By` or any AI
  attribution line.** This is a user rule and overrides any harness default.
- **Never bind-mount any path under `/Volumes/Husky's SSD 4T` into a container.** Containers get
  named volumes, `docker cp`, Docker's archive API or build contexts only. Runtime data lives in
  `~/.localdot` (`LOCALDOT_HOME` overrides). keyd keeps its state in `<home>/keyd` (0700).
- Build paths from `fileURLToPath(import.meta.url)`, never `new URL(...).pathname`.
- Ports are all bound to `127.0.0.1`:
  - the daemon and UI on `4750` (`LOCALDOT_PORT` overrides), the brain's tool API on `4751`;
  - keyd listeners on `4760–4789`. keyd's `-ports` and the daemon's `LOCALDOT_KEYD_PORTS` must say
    the same range;
  - spikes and e2e harnesses on `4790–4799`: the e2e daemon on `4790`, test and e2e keyd listeners
    on `4791–4797` (`LOCALDOT_TEST_KEYD_PORTS` moves the tests' range when two checkouts test on one
    Mac), the driver opt-out proxy on `4798`.

  Inside a cell: `desktopd` on `7700`, Selkies on `3000`, and Chromium's DevTools on `9222` and the
  forwarder on `3129`, both on the cell's loopback only. The gate's keyd relay listens on `3128` on
  its internal address.
- Auth is cookie-free. HTTP accepts the install token only as `Authorization: Bearer <token>`.
  WebSocket clients always offer `localdot.v1` and `localdot.token.<token>` together, and the server
  selects only `localdot.v1`. Every inbound cell port requires the per-cell token.
- Every cell network stays `--internal` with
  `com.docker.network.bridge.gateway_mode_ipv4=isolated`. The desktop keeps the default seccomp,
  `NET_RAW` dropped, no added capabilities and passwordless sudo. The gate stays read-only, with
  `no-new-privileges`, every capability dropped and user `nobody`. Nothing in Part 4b opens a port
  on a cell or changes these specs.
- Secrets: never a real one, anywhere. Test values are obviously fake (`canary-…`, `p4b-…`, `e2e-…`)
  and match none of `pnpm hygiene`'s patterns. No key, proxy token, CA or surrogate goes into a
  container's environment: keyd's material for each start goes in as files.
- The daemon never holds a plaintext key. The key form seals it in the page. The daemon's key routes
  refuse any body but `{ binding, sealed }` and relay it to keyd unchanged. Nothing logs a key, a
  surrogate, a proxy token or a request path.
- keyd is started on its own (dev: `pnpm keyd`; the LaunchAgent is M9, P4b-R18). The daemon reaches
  it only through `<home>/keyd/admin.sock`, and only while that socket is mode 0600 in a 0700 folder
  owned by the user.
- No Docker restart policy on any cell container (P2-R14). Start the daemon with `node` directly
  (`node --import tsx src/main.ts` from `apps/daemon`). `pnpm … start` is a terminal convenience
  only.
- The UI follows the Theatre direction. Near-black `--color-void`, with xenon used **only while the
  agent has control**. Every other state stays neutral: warnings and errors are told by text,
  weight and a hollow dot, never by a new hue. **No purple or violet anywhere.** Every colour is a
  token in `theme.css`. Every UI task follows `~/.agents/skills/apple-design/SKILL.md`: respond on
  pointer-down, interruptible transitions that start from the current value, `prefers-reduced-motion`
  (cross-fade, no travel), `prefers-reduced-transparency` and `prefers-contrast: more`. Every UI
  task ends with a screenshot check of the rendered page.
- Code style:
  - named exports only (default exports only in tool config files);
  - small focused files;
  - comments only for non-obvious rules or workarounds;
  - relative imports with explicit `.ts`, workspace imports by package name.

  Run `pnpm format` before `pnpm lint` in every task. Fix an `organizeImports` error with
  `pnpm exec biome check --write <files>`. Go: `gofmt -l .` prints nothing and `go vet ./...` is
  clean before every commit.
- Tests: run only the suites a task touches (`pnpm exec vitest run <paths>`, `go test ./internal/<pkg>/`).
  Before the final review, run the full `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm hygiene` and
  `go test -race ./...`.
  - keyd-backed suites are `*.keyd.test.ts`. Run them with `LOCALDOT_KEYD_TESTS=1 pnpm test:keyd <file>`.
    They build keyd from `keyd/` with Go once per run (a Vitest global setup that removes the build
    afterwards), or use `LOCALDOT_KEYD_BIN`, and start it with `-natpmp off -stun off`, so that no
    test sends anything out.
  - Docker-backed suites are `*.docker.test.ts`. Run them with
    `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker <file>`, **with no `--` before the file**: with `--`
    Vitest ignores the filter and runs every suite.
  - Docker tests name every container, network and volume they create `localdot-test-*` and remove
    them with `docker rm -fv` (`removeAll`) in `afterAll`, even on failure.
  - Every probe whose output is checked also asserts its expected exit status.
  - The Docker CLI helpers are synchronous and block the test thread. So a server that a container
    or a `waitFor` predicate must reach runs on a worker thread or in a child process, never on the
    test thread (keyd always runs as a child process).
  - The S4 probes and the canary need the internet: `example.com`, `postman-echo.com` and `nip.io`
    must be reachable from the Mac.
- No [avatar-name]/[avatar-name]/[avatar-name] names or assets anywhere in the repo (`pnpm hygiene` enforces this).
  The GitHub repo stays private, and nothing in this plan pushes.

## Review Focus

These are the inputs most likely to break the guarantees, most likely first. Each one is pinned by
the tests named after it.

1. **A secret reaching a cell** through its environment, a file, a log, a crash dump or the
   clipboard. The canary must appear nowhere, in any encoding.
   - Task 15 plants a canary key, uses it from the cell (swap and scrubbed reflection), copies the
     answer to the X clipboard and searches every process's environment, command line and memory (a
     crash dump is a copy of memory), every file the container wrote, its tmpfs mounts, its home
     volume, both containers' logs and keyd's own files.
   - Task 7 pins that the container's environment holds no surrogate and no certificate.
   - Part 2's image test already pins Selkies' clipboard: inbound is off, and the server enforces it.
2. **The canary failing open.** A scan that cannot see a process, a file or an encoding would pass
   with nothing found. Task 15 finds a planted marker in a file (raw and as base64), in an
   environment and in memory, and the live surrogate; the canary's own scan must find the marker
   again. It must also read more than 100 MB of memory (bytes actually read, not mapped), and cover
   more than 20 processes and more than 100 files.
3. **A cell bypassing keyd**: direct egress, DNS, IPv6, the Mac, Docker Desktop's host, the LAN,
   a reachable bridge gateway, hairpin NAT, special-purpose IPv6.
   - Task 8's self-test checks each one and fails closed. The daemon, not desktopd, decides which
     checks there are: a report that leaves one out is a failure (Task 2).
   - Task 9 stops a cell whose isolation check fails, and refuses an internal network that has a
     gateway address.
   - Task 14 probes a real cell with exact curl exit statuses (6, 7, 2).
   - Task 1 denies every IPv6 range outside `2000::/3` and the network's public address, learned
     from the router (NAT-PMP) or one STUN server; while it is unknown, `doctor` and the UI say so
     and keyd asks again every 30 s.
4. **Stop leaving a surrogate usable or a process running.**
   - Task 10: revoke comes before pause, the pause happens even with keyd down, and a desktop that
     cannot be paused loses its keyd listener. A frozen cell stays frozen across a daemon restart, a
     keyd restart and a gate restart. Resume revokes again before it mints, and keeps the computer
     frozen while keyd is offline.
   - Task 15: while frozen, keyd sees no request at all. After resume, the old surrogate gets 403
     and a new shell's works.
5. **The daemon seeing a plaintext key.**
   - Task 4 refuses a `value` field, any extra field or a loose shape, and relays the rest byte for
     byte.
   - Task 12a: `saveKey` posts no plaintext. Task 12b: React state never holds the key, the field is
     cleared before the save settles, and it is a text field drawn as dots, which Chrome's password
     manager does not offer to save.
   - Task 12b's Playwright spec inspects the real POST bodies in Chrome.
6. **The admin socket reachable by another user or process**, or a stand-in keyd handing out its own
   seal key.
   - Task 3: the daemon refuses a socket or folder that is not private to the user.
   - Task 14: another container that finds a cell's listener gets 407 with or without a token.
7. **Text the browser and keyd serialize differently**: U+2028 in a base URL, an IDN host, upper
   case. Tasks 2 and 12a: `bindingJson` refuses non-printable text, and the form sends
   `new URL(x).href`. Tasks 4 and 12b: the real keyd opens what Node and Chrome sealed, an IDN base
   URL included. Task 4 refuses a name whose `LOCALDOT_KEY_` variable another key already has.
8. **keyd restarting or going away under running cells.**
   - Task 9: a new boot restarts running desktops with new keyd material, and a start while keyd is
     offline fails with "start keyd". Task 10: never a frozen one.
   - Task 9: the startup reconcile, which Part 3 runs in the background, asks keyd about each
     running cell, so a cell keyd lost while the daemon was away is rewired even when keyd answered
     first.
   - Task 11: the event stream reconnects.
   - Task 12b (jsdom and Playwright): the top bar says "Key layer offline".
9. **An unreadable cell record keeping its keyd port, or a sweep reaching another home's cells.**
   Part 2's `create()` refuses while one exists (`SkippedCellsError`, which names the folder and
   the containers). Task 9: reconcile closes such a cell in keyd and stops its containers by exact
   name, only for a folder in this home, and removes nothing; another home's cells (an e2e run's,
   the user's) are never touched. A running cell whose folder was deleted keeps its port.

## File map

| Task | Creates | Modifies |
|---|---|---|
| 1 | `keyd/internal/netguard/public.go`, `public_test.go`, `natpmp.go`, `natpmp_test.go` | `keyd/internal/netguard/guard.go`, `guard_integrity_test.go`; `keyd/internal/admin/admin.go`; `keyd/cmd/keyd/main.go`, `main_test.go`; `README.md` |
| 2 | `packages/protocol/src/keyd.ts`, `seal.ts`, `selftest.ts`, `keyd.test.ts`, `seal.test.ts`, `selftest.test.ts` | `packages/protocol/src/events.ts`, `events.test.ts`, `index.ts`, `schema/events.schema.json` |
| 3 | `apps/daemon/src/keyd/client.ts`, `client.test.ts`, `client.keyd.test.ts`, `testing/fake-keyd.ts`, `testing/keyd-process.ts`, `testing/keyd-build.ts`; `vitest.keyd.config.ts` | `apps/daemon/src/cells/ports.ts`, `ports.test.ts`; `vitest.config.ts`, `vitest.docker.config.ts`, root `package.json` |
| 4 | `apps/daemon/src/keyd/routes.ts`, `monitor.ts`, `routes.test.ts`, `routes.keyd.test.ts` | `apps/daemon/src/app.ts`, `apps/daemon/src/doctor.ts`, `doctor.test.ts`, `doctor-main.ts`, `doctor-main.test.ts` |
| 5 | `apps/daemon/src/cells/tar.ts`, `tar.test.ts` | `apps/daemon/src/cells/docker.ts`, `docker.test.ts`, `testing/fake-docker.ts`, `testing/fake-docker.test.ts` |
| 6 | `cells/desktop/desktopd/src/forwarder.ts`, `forwarder-main.ts`, `forwarder.test.ts` | `cells/desktop/desktopd/build.mjs` |
| 7 | `cells/desktop/root/etc/s6-overlay/s6-rc.d/{init-localdot-cell,svc-forwarder}/…` (+ `user/contents.d`, `svc-de/dependencies.d` entries), `cells/desktop/root/etc/profile.d/localdot-cell.sh`, `cells/desktop/cell/{apt-proxy.conf,sudoers-proxy}`, `apps/daemon/src/cells/desktop-keyd-files.docker.test.ts` | `cells/desktop/Dockerfile`, `cells/desktop/root/usr/local/bin/localdot-chromium`, `apps/daemon/src/cells/spec.ts`, `spec.test.ts` |
| 8 | `cells/desktop/desktopd/src/selftest.ts`, `selftest.test.ts` | `cells/desktop/desktopd/src/{app.ts,app.test.ts,main.ts}`, `cells/desktop/desktopd/package.json`, `apps/daemon/src/cells/{readiness.ts,readiness.test.ts,types.ts}` |
| 9 | `apps/daemon/src/keyd/cell-wiring.ts`, `cell-wiring.test.ts`, `apps/daemon/src/cells/orchestrator-keyd.test.ts` | `apps/daemon/src/cells/{orchestrator.ts,orchestrator.test.ts,store.ts,store.test.ts,orchestrator.docker.test.ts}` |
| 10 | `apps/daemon/src/gateway/kill-switch.ts`, `kill-switch.test.ts`, `kill-switch-routes.test.ts` | `apps/daemon/src/gateway/{live.ts,routes.ts}`, `apps/daemon/src/cells/{orchestrator.ts,types.ts}` |
| 11 | `apps/daemon/src/keyd/event-router.ts`, `event-router.test.ts` | `apps/daemon/src/keyd/cell-wiring.ts`, `cell-wiring.test.ts`, `apps/daemon/src/main.ts`, `apps/web/e2e/daemon.ts` |
| 12a | `apps/web/src/keys/{binding.ts,keys-api.ts,useKeys.ts}`, `binding.test.ts`, `keys-api.test.ts` | — |
| 12b | `apps/web/src/keys/{KeyForm.tsx,KeyList.tsx,KeysSheet.tsx,keys.css}`, `KeysSheet.test.tsx`, `apps/web/e2e/keys.spec.ts` | `apps/web/src/{App.tsx,app.css}`, `apps/web/src/shell/TopBar.tsx` |
| 13 | `apps/web/src/session/key-uses.ts`, `key-uses.test.ts`, `apps/web/src/shell/{KeyUseRow.tsx,KeyUseRow.test.tsx,Hud.test.tsx}`, `apps/web/e2e/stop-and-keys.spec.ts` | `apps/web/src/cells/{hud-state.ts,hud-state.test.ts,types.ts,useCell.ts}`, `apps/web/src/shell/{Hud.tsx,StageColumn.tsx,PlanRail.tsx}`, `apps/web/src/session/session-view.ts`, `apps/web/src/{App.tsx,app.css}`, `packages/stage/src/model.ts`, `model.test.ts` |
| 14 | `apps/daemon/src/keyd/testing/keyd-cell.ts`, `apps/daemon/src/keyd/cell-egress.docker.test.ts` | — |
| 15 | `apps/daemon/src/keyd/testing/canary-scan.py`, `apps/daemon/src/keyd/canary.docker.test.ts` | — |
| 16 | — | `.github/workflows/ci.yml`, `README.md` |

---

### Task 1: The branch, and keyd's last address rules — special IPv6 and the network's public address

Part 4a's review left two holes in the dial-time guard (controller's interface note, 2026-10-01).

- **Special-purpose IPv6.** Some ranges are outside its deny set: SIIT `::ffff:0:0:0/96`, the rest of
  `64:ff9b::/32`, `100:0:0:1::/64` and `5f00::/16` all lie outside IANA's global unicast `2000::/3`;
  `2001:2::/48`, `2001:10::/28`, `2001:20::/28` and `3fff::/20` lie inside it. One rule ("nothing
  outside `2000::/3` but the well-known NAT64 prefix, whose IPv4 address is checked") covers the
  first group; four named rules cover the second.
- **Hairpin NAT.** A home router answers on its public address from inside the network, often with
  its admin page or a port it forwards to the LAN. keyd cannot see that address on any interface,
  so it learns it and denies it like the Mac's own (controller ruling P4b-C2):
  1. it asks the router first: NAT-PMP's external address request (RFC 6886, UDP 5351 to the
     default gateway), so no third party learns anything;
  2. only if the router has no public answer (no NAT-PMP, a PCP-only router, or a router behind
     another NAT), it asks one STUN server, Cloudflare's; `-stun off` turns that off;
  3. while the address is unknown it asks again every 30 s, and every 5 minutes once it is known;
  4. keyd's `/v1/status` reports the guard as `active`, `unknown` or `off`, and the daemon shows it
     in `doctor` and the UI (Tasks 4 and 12b), so it never fails open silently.

  keyd learns the IPv4 address only: the router's own IPv6 addresses stay reachable (recorded under
  "Not in Part 4b").

Tests pass `-natpmp off -stun off`, so no test sends anything out.

**Files:**
- Create: `keyd/internal/netguard/public.go`, `keyd/internal/netguard/public_test.go`,
  `keyd/internal/netguard/natpmp.go`, `keyd/internal/netguard/natpmp_test.go`
- Modify: `keyd/internal/netguard/guard.go`, `keyd/internal/netguard/guard_integrity_test.go`,
  `keyd/internal/admin/admin.go`, `keyd/cmd/keyd/main.go`, `keyd/cmd/keyd/main_test.go`, `README.md`

**Interfaces:**
- Consumes: Part 4a's `netguard.New(own func() ([]netip.Prefix, error), allow ...netip.AddrPort) *Guard`,
  `(*Guard).Check`, `InterfacePrefixes`, `DeniedError{Target, Rule}` and the `static` rule list;
  `admin.Server` and its `status` handler; `cmd/keyd`'s `Config`, `start`, `(*Daemon).Close`.
- Produces:
  - `netguard.DefaultSTUN = "stun.cloudflare.com:3478"` and `netguard.DefaultGateway() (netip.Addr, error)`;
  - `netguard.Discovery { Router func() (netip.Addr, error); NATPMPPort int; STUN string; Timeout time.Duration }`
    with `Off()` (no router and no STUN);
  - `type Public` with `Addrs() []netip.Addr`, `Status() PublicStatus`, `Learn(Discovery) error`
    and `Keep(d Discovery, every, retry time.Duration, stop <-chan struct{}, logf func(string, ...any))`;
  - `PublicStatus { state: "active" | "unknown" | "off"; source?: "nat-pmp" | "stun"; addresses; checkedAt?; error? }`
    (JSON), which `/v1/status` returns as `hairpin`; `admin.Server.Hairpin *netguard.Public`;
  - `netguard.WithPublic(own, *Public) func() ([]netip.Prefix, error)`;
  - the deny rule names `benchmarking 2001:2::/48`, `orchid 2001:10::/28`, `orchid v2 2001:20::/28`,
    `documentation 3fff::/20`, `outside global unicast 2000::/3`, and `own address <ip>/32` for a
    learned address;
  - keyd's flags `-natpmp on|off` (default `on`) and `-stun host:port|off` (default `DefaultSTUN`),
    and `Config.Discovery` (the zero value: both off).

- [ ] **Step 1: Create the branch**

```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot"
git status --short   # must print nothing
git switch -c feat/core-part4b feat/core-part3
git merge --no-ff feat/core-part4a -m "merge: keyd core (Part 4a) into the integration branch"
```
Expected: the merge completes. If `.gitignore`, `README.md` or `.github/workflows/ci.yml`
conflict, keep both sides: Part 4a appended a `keyd` CI job, the `keyd/bin/` line and a `## keyd`
README section, and Parts 2 and 3 appended their own. Then:
```bash
cd keyd && go test ./... && cd .. && pnpm install && pnpm test
```
Expected: every keyd package `ok`; the whole Vitest suite passes, as on `feat/core-part3`.

- [ ] **Step 2: Write the failing tests**

`keyd/internal/netguard/public_test.go`:
```go
package netguard

import (
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// response builds a Binding success response for txid carrying the given attributes.
func response(txid []byte, attrs ...[]byte) []byte {
	msg := make([]byte, 20)
	binary.BigEndian.PutUint16(msg[0:2], stunBindingSuccess)
	binary.BigEndian.PutUint32(msg[4:8], stunMagicCookie)
	copy(msg[8:20], txid)
	for _, a := range attrs {
		msg = append(msg, a...)
	}
	binary.BigEndian.PutUint16(msg[2:4], uint16(len(msg)-20))
	return msg
}

func attr(typ uint16, val []byte) []byte {
	out := make([]byte, 4, 4+len(val)+3)
	binary.BigEndian.PutUint16(out[0:2], typ)
	binary.BigEndian.PutUint16(out[2:4], uint16(len(val)))
	out = append(out, val...)
	for len(out)%4 != 0 {
		out = append(out, 0)
	}
	return out
}

// mapped encodes addr:port as a (XOR-)MAPPED-ADDRESS value.
func mapped(addr netip.Addr, port uint16, txid []byte, xor bool) []byte {
	family := byte(0x01)
	if addr.Is6() {
		family = 0x02
	}
	raw := addr.AsSlice()
	key := binary.BigEndian.AppendUint32(nil, stunMagicCookie)
	key = append(key, txid...)
	if xor {
		port ^= uint16(stunMagicCookie >> 16)
		for i := range raw {
			raw[i] ^= key[i]
		}
	}
	val := []byte{0, family, byte(port >> 8), byte(port)}
	return append(val, raw...)
}

var txid = []byte("0123456789ab")

func TestParseBindingSuccess(t *testing.T) {
	v4 := netip.MustParseAddr("81.2.69.160")
	v6 := netip.MustParseAddr("2a01:4b00:1234:5678::abcd")
	cases := map[string]struct {
		msg  []byte
		want netip.Addr
	}{
		"xor v4":           {response(txid, attr(stunXorMappedAddress, mapped(v4, 54321, txid, true))), v4},
		"xor v6":           {response(txid, attr(stunXorMappedAddress, mapped(v6, 54321, txid, true))), v6},
		"mapped only":      {response(txid, attr(stunMappedAddress, mapped(v4, 1, nil, false))), v4},
		"xor wins":         {response(txid, attr(stunMappedAddress, mapped(netip.MustParseAddr("1.2.3.4"), 1, nil, false)), attr(stunXorMappedAddress, mapped(v4, 2, txid, true))), v4},
		"unknown skipped":  {response(txid, attr(0x8022, []byte("software")), attr(stunXorMappedAddress, mapped(v4, 2, txid, true))), v4},
		"odd length value": {response(txid, attr(0x8022, []byte("abcde")), attr(stunXorMappedAddress, mapped(v4, 2, txid, true))), v4},
	}
	for name, c := range cases {
		got, err := parseBindingSuccess(c.msg, txid)
		if err != nil || got != c.want {
			t.Errorf("%s: %v %v, want %v", name, got, err, c.want)
		}
	}
}

func TestParseBindingSuccessRefusesAnythingElse(t *testing.T) {
	good := response(txid, attr(stunXorMappedAddress, mapped(netip.MustParseAddr("81.2.69.160"), 1, txid, true)))
	wrongType := append([]byte{}, good...)
	binary.BigEndian.PutUint16(wrongType[0:2], 0x0111)
	wrongCookie := append([]byte{}, good...)
	wrongCookie[4] ^= 0xff
	longer := append([]byte{}, good...)
	binary.BigEndian.PutUint16(longer[2:4], 400)
	truncated := response(txid, []byte{0, 0x20, 0, 20, 0, 1})
	for name, msg := range map[string][]byte{
		"other transaction": response([]byte("ba9876543210"), attr(stunXorMappedAddress, mapped(netip.MustParseAddr("81.2.69.160"), 1, []byte("ba9876543210"), true))),
		"not a success":     wrongType,
		"no magic cookie":   wrongCookie,
		"length past end":   longer,
		"truncated":         truncated,
		"too short":         good[:12],
		"no address":        response(txid, attr(0x8022, []byte("software"))),
		"bad family":        response(txid, attr(stunXorMappedAddress, []byte{0, 0x03, 0, 1, 1, 2, 3, 4})),
	} {
		if a, err := parseBindingSuccess(msg, txid); err == nil {
			t.Errorf("%s: parsed %v", name, a)
		}
	}
}

// fakeSTUN answers each Binding request with addr, from its `from`th request on (1: at once),
// until the test ends, and counts what it was asked.
func fakeSTUN(t *testing.T, addr netip.Addr, from int) (string, *atomic.Int32) {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	asked := &atomic.Int32{}
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from2, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if n < 20 || binary.BigEndian.Uint16(buf[0:2]) != stunBindingRequest {
				continue
			}
			if asked.Add(1) < int32(from) {
				continue
			}
			id := append([]byte{}, buf[8:20]...)
			pc.WriteTo([]byte("noise"), from2)
			pc.WriteTo(response(id, attr(stunXorMappedAddress, mapped(addr, 40000, id, true))), from2)
		}
	}()
	return pc.LocalAddr().String(), asked
}

// fakeRouter answers NAT-PMP's external address request with addr (or stays silent for an
// invalid addr) on a loopback port, and counts what it was asked.
func fakeRouter(t *testing.T, addr netip.Addr) (Discovery, *atomic.Int32) {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	asked := &atomic.Int32{}
	go func() {
		buf := make([]byte, 64)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if n != 2 || buf[0] != 0 || buf[1] != 0 {
				continue
			}
			asked.Add(1)
			if !addr.IsValid() {
				continue
			}
			reply := []byte{0, 128, 0, 0, 0, 0, 0x30, 0x39}
			pc.WriteTo(append(reply, addr.AsSlice()...), from)
		}
	}()
	port := pc.LocalAddr().(*net.UDPAddr).Port
	loopback := func() (netip.Addr, error) { return netip.MustParseAddr("127.0.0.1"), nil }
	return Discovery{Router: loopback, NATPMPPort: port, Timeout: 300 * time.Millisecond}, asked
}

func TestLearnAsksTheRouterFirstAndNoThirdParty(t *testing.T) {
	public := &Public{}
	g := New(WithPublic(noOwn, public))
	if err := check(g, "81.2.69.160"); err != nil {
		t.Fatalf("before learning: %v", err)
	}
	d, routerAsked := fakeRouter(t, netip.MustParseAddr("81.2.69.160"))
	stun, stunAsked := fakeSTUN(t, netip.MustParseAddr("81.2.69.99"), 1)
	d.STUN = stun
	if err := public.Learn(d); err != nil {
		t.Fatal(err)
	}
	var denied *DeniedError
	if err := check(g, "81.2.69.160"); !errors.As(err, &denied) || denied.Rule != "own address 81.2.69.160/32" {
		t.Fatalf("after learning: %v", err)
	}
	if err := check(g, "81.2.69.161"); err != nil {
		t.Fatalf("a neighbour: %v", err)
	}
	if st := public.Status(); st.State != "active" || st.Source != "nat-pmp" || st.Addresses != 1 || st.CheckedAt == "" {
		t.Fatalf("status: %+v", st)
	}
	if routerAsked.Load() == 0 || stunAsked.Load() != 0 {
		t.Fatalf("router asked %d times, STUN %d", routerAsked.Load(), stunAsked.Load())
	}
}

func TestLearnAsksSTUNOnlyWhenTheRouterHasNoPublicAnswer(t *testing.T) {
	for name, router := range map[string]netip.Addr{
		"a silent router":             {},
		"a router behind another NAT": netip.MustParseAddr("192.168.0.2"),
	} {
		public := &Public{}
		d, _ := fakeRouter(t, router)
		stun, stunAsked := fakeSTUN(t, netip.MustParseAddr("81.2.69.160"), 1)
		d.STUN = stun
		if err := public.Learn(d); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if st := public.Status(); st.State != "active" || st.Source != "stun" || stunAsked.Load() != 1 {
			t.Fatalf("%s: %+v, STUN asked %d times", name, st, stunAsked.Load())
		}
		if !slices.Contains(public.Addrs(), netip.MustParseAddr("81.2.69.160")) {
			t.Fatalf("%s: learned %v", name, public.Addrs())
		}
	}
}

func TestLearnSaysUnknownWhenNothingAnswersAndKeepsWhatItHad(t *testing.T) {
	public := &Public{}
	public.add(netip.MustParseAddr("81.2.69.160"))
	d, _ := fakeRouter(t, netip.Addr{})
	silent, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	d.STUN = silent.LocalAddr().String()
	if err := public.Learn(d); err == nil {
		t.Fatal("silence counted as an answer")
	}
	st := public.Status()
	if st.State != "unknown" || !strings.Contains(st.Error, "nat-pmp") || !strings.Contains(st.Error, "stun") {
		t.Fatalf("status: %+v", st)
	}
	if got := public.Addrs(); len(got) != 1 || got[0] != netip.MustParseAddr("81.2.69.160") {
		t.Fatalf("addresses after a failed round: %v", got)
	}
	for i := range maxPublic + 4 {
		public.add(netip.AddrFrom4([4]byte{81, 2, 70, byte(i)}))
	}
	if got := public.Addrs(); len(got) != maxPublic || got[len(got)-1] != netip.AddrFrom4([4]byte{81, 2, 70, byte(maxPublic + 3)}) {
		t.Fatalf("kept %d addresses, last %v", len(got), got[len(got)-1])
	}
}

func TestLearnIsOffWithBothSourcesOff(t *testing.T) {
	public := &Public{}
	if st := public.Status(); st.State != "unknown" {
		t.Fatalf("before any round: %+v", st)
	}
	if err := public.Learn(Discovery{}); err != nil {
		t.Fatal(err)
	}
	if st := public.Status(); st.State != "off" || st.Addresses != 0 {
		t.Fatalf("status: %+v", st)
	}
}

func TestKeepAsksAgainSoonWhileTheAddressIsUnknown(t *testing.T) {
	public := &Public{}
	stun, asked := fakeSTUN(t, netip.MustParseAddr("81.2.69.160"), 3)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		public.Keep(Discovery{STUN: stun, Timeout: 100 * time.Millisecond}, time.Hour, 10*time.Millisecond, stop, t.Logf)
		close(done)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for public.Status().State != "active" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if public.Status().State != "active" || asked.Load() != 3 {
		t.Fatalf("status %+v after %d requests", public.Status(), asked.Load())
	}
	// Known now: the next round waits the long interval.
	time.Sleep(100 * time.Millisecond)
	if asked.Load() != 3 {
		t.Fatalf("asked again while known: %d", asked.Load())
	}
	close(stop)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Keep did not stop")
	}
}
```

`keyd/internal/netguard/natpmp_test.go`:
```go
package netguard

import (
	"net/netip"
	"strings"
	"testing"
)

func TestParseNATPMP(t *testing.T) {
	ok := []byte{0, 128, 0, 0, 0, 0, 0x30, 0x39, 81, 2, 69, 160}
	if a, err := parseNATPMP(ok); err != nil || a != netip.MustParseAddr("81.2.69.160") {
		t.Fatalf("an answer: %v %v", a, err)
	}
	for name, c := range map[string]struct {
		msg  []byte
		want string
	}{
		"a PCP-only router": {[]byte{2, 0x80, 0, 1, 0, 0, 0, 0}, "PCP only"},
		"a refusal":         {[]byte{0, 128, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0}, "result code 2"},
		"no address":        {[]byte{0, 128, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0}, "no external address"},
		"too short":         {ok[:11], errNotNATPMP.Error()},
		"another opcode":    {append([]byte{0, 129}, ok[2:]...), errNotNATPMP.Error()},
	} {
		if a, err := parseNATPMP(c.msg); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v %v, want an error with %q", name, a, err, c.want)
		}
	}
}

func TestGatewayLookups(t *testing.T) {
	routeGet := "   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: en1\n"
	if a, err := gatewayFromRouteGet(routeGet); err != nil || a != netip.MustParseAddr("192.168.1.1") {
		t.Fatalf("route get: %v %v", a, err)
	}
	if _, err := gatewayFromRouteGet("    gateway: link#17\n"); err == nil {
		t.Fatal("an interface gateway counted as a router address")
	}
	proc := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n" +
		"eth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\n" +
		"eth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\n"
	if a, err := gatewayFromProcRoute(proc); err != nil || a != netip.MustParseAddr("192.168.1.1") {
		t.Fatalf("/proc/net/route: %v %v", a, err)
	}
	if _, err := gatewayFromProcRoute(strings.Split(proc, "\n")[0]); err == nil {
		t.Fatal("no default route, yet a gateway")
	}
}
```

In `keyd/internal/netguard/guard_integrity_test.go`, `TestEveryStaticRuleAndEmbeddedFormIsDenied`
pins each range's edges. The new rules take over eight IPv6 addresses its "just outside, where no
other rule takes over" list expects to pass, so those move into the denied map with the new
edges. Append to the `denied` map, after the `"ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff": "multicast ff00::/8",`
entry:
```go

		"2001:2:0:0:0:0:0:0":                     "benchmarking 2001:2::/48",
		"2001:2:0:ffff:ffff:ffff:ffff:ffff":      "benchmarking 2001:2::/48",
		"2001:10:0:0:0:0:0:0":                    "orchid 2001:10::/28",
		"2001:1f:ffff:ffff:ffff:ffff:ffff:ffff":  "orchid 2001:10::/28",
		"2001:20:0:0:0:0:0:0":                    "orchid v2 2001:20::/28",
		"2001:2f:ffff:ffff:ffff:ffff:ffff:ffff":  "orchid v2 2001:20::/28",
		"3fff:0:0:0:0:0:0:0":                     "documentation 3fff::/20",
		"3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff": "documentation 3fff::/20",

		// Outside 2000::/3 and in no named range: SIIT, the rest of 64:ff9b::/32 around the
		// well-known and local-use NAT64 prefixes, the dummy prefix, SRv6 SIDs, unassigned space.
		"::1:0:0":                                 "outside global unicast 2000::/3",
		"::ffff:0:808:808":                        "outside global unicast 2000::/3",
		"64:ff9b:0:ffff:ffff:ffff:ffff:ffff":      "outside global unicast 2000::/3",
		"64:ff9b:2::":                             "outside global unicast 2000::/3",
		"64:ff9b:ffff:ffff:ffff:ffff:ffff:ffff":   "outside global unicast 2000::/3",
		"ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff":   "outside global unicast 2000::/3",
		"100:0:0:1::":                             "outside global unicast 2000::/3",
		"100:0:0:1:ffff:ffff:ffff:ffff":           "outside global unicast 2000::/3",
		"5f00::":                                  "outside global unicast 2000::/3",
		"5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff": "outside global unicast 2000::/3",
		"1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff": "outside global unicast 2000::/3",
		"4000::": "outside global unicast 2000::/3",
		"fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff": "outside global unicast 2000::/3",
		"fe00::": "outside global unicast 2000::/3",
		"fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff": "outside global unicast 2000::/3",
```
and in the same test's pass list replace the four IPv6 lines
```go
		"::1:0:0", "64:ff9b:0:ffff:ffff:ffff:ffff:ffff", "64:ff9b:2::",
		"ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "100:0:0:1::", "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"2001:1::", "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", "2001:db9::",
		"fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe00::", "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
```
with the edges of the new ranges and of `2000::/3`:
```go
		"2000::", "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "2001:1::",
		"2001:1:ffff:ffff:ffff:ffff:ffff:ffff", "2001:2:1::", "2001:f:ffff:ffff:ffff:ffff:ffff:ffff",
		"2001:30::", "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", "2001:db9::",
		"3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "3fff:1000::", "64:ff9b::808:808",
```
(`gofmt -w` realigns the map: the entries after the comment form their own alignment block.)

Append to `keyd/cmd/keyd/main_test.go` (and add `"net/netip"`, `"time"` and
`"github.com/shadowhusky/localdot/keyd/internal/netguard"` to its imports):
```go
// A router on loopback that answers NAT-PMP's external address request with 81.2.69.160.
func fakeRouter(t *testing.T) netguard.Discovery {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	go func() {
		buf := make([]byte, 64)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if n == 2 {
				pc.WriteTo([]byte{0, 128, 0, 0, 0, 0, 0, 9, 81, 2, 69, 160}, from)
			}
		}
	}()
	return netguard.Discovery{
		Router:     func() (netip.Addr, error) { return netip.MustParseAddr("127.0.0.1"), nil },
		NATPMPPort: pc.LocalAddr().(*net.UDPAddr).Port,
		Timeout:    time.Second,
	}
}

func TestStartLearnsThePublicAddressItDeniesAndReportsTheGuard(t *testing.T) {
	d, err := start(Config{Home: shortHome(t), Vault: "memory", Discovery: fakeRouter(t)})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	admin := socketClient(d.Socket)
	deadline := time.Now().Add(3 * time.Second)
	var hairpin map[string]any
	for time.Now().Before(deadline) {
		_, status := adminCall(t, admin, "GET", "/v1/status", nil)
		hairpin, _ = status["hairpin"].(map[string]any)
		if hairpin["state"] == "active" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if hairpin["state"] != "active" || hairpin["source"] != "nat-pmp" || hairpin["addresses"] != float64(1) {
		t.Fatalf("hairpin %v", hairpin)
	}
	if got := d.public.Addrs(); len(got) != 1 || got[0].String() != "81.2.69.160" {
		t.Fatalf("learned %v", got)
	}
}

func TestStartWithDiscoveryOffSaysTheGuardIsOff(t *testing.T) {
	d, err := start(Config{Home: shortHome(t), Vault: "memory"})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	_, status := adminCall(t, socketClient(d.Socket), "GET", "/v1/status", nil)
	if hairpin, _ := status["hairpin"].(map[string]any); hairpin["state"] != "off" {
		t.Fatalf("hairpin %v", status["hairpin"])
	}
	var out bytes.Buffer
	if code := run([]string{"-natpmp", "maybe"}, &out); code != 2 {
		t.Fatalf("-natpmp maybe: exit %d", code)
	}
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd keyd && go test ./internal/netguard/ ./cmd/keyd/`
Expected: build failure. `undefined: Public`, `undefined: Discovery`, `undefined: parseNATPMP`,
`undefined: gatewayFromRouteGet` (netguard), and `undefined: netguard.Discovery` and
`d.public undefined` (cmd/keyd).

- [ ] **Step 4: Write the code**

`keyd/internal/netguard/public.go`:
```go
package netguard

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"sync"
	"time"
)

// DefaultSTUN is the one third party keyd asks, and only when the router gives no public answer.
const DefaultSTUN = "stun.cloudflare.com:3478"

// maxPublic bounds the addresses kept: a dynamic address that changes daily adds one a day.
const maxPublic = 16

// Public holds the addresses this Mac's traffic leaves its network with. A home router answers on
// its public address from inside the network (hairpin NAT), often with its admin page or with a
// port it forwards to the LAN, so keyd denies those addresses like the Mac's own. Addresses once
// learned stay: an old public address may still route back here.
type Public struct {
	mu     sync.RWMutex
	addrs  []netip.Addr
	status PublicStatus
}

// PublicStatus is the hairpin guard as keyd's /v1/status reports it: "active" while the last
// round learned the public address, "unknown" while none could, "off" with discovery turned off.
type PublicStatus struct {
	State     string `json:"state"`
	Source    string `json:"source,omitempty"`
	Addresses int    `json:"addresses"`
	CheckedAt string `json:"checkedAt,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Discovery says where the public address comes from: the router first (NAT-PMP, so no third
// party learns anything), then one STUN server. Router nil or STUN "" turns that source off.
type Discovery struct {
	Router     func() (netip.Addr, error)
	NATPMPPort int
	STUN       string
	Timeout    time.Duration
}

// Off says whether both sources are turned off.
func (d Discovery) Off() bool { return d.Router == nil && d.STUN == "" }

func (p *Public) Addrs() []netip.Addr {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return slices.Clone(p.addrs)
}

func (p *Public) Status() PublicStatus {
	p.mu.RLock()
	defer p.mu.RUnlock()
	st := p.status
	if st.State == "" {
		st.State = "unknown"
	}
	st.Addresses = len(p.addrs)
	return st
}

func (p *Public) add(a netip.Addr) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if slices.Contains(p.addrs, a) {
		return
	}
	p.addrs = append(p.addrs, a)
	if len(p.addrs) > maxPublic {
		p.addrs = slices.Clone(p.addrs[len(p.addrs)-maxPublic:])
	}
}

func (p *Public) record(state, source string, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.status = PublicStatus{State: state, Source: source}
	if state != "off" {
		p.status.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if err != nil {
		msg := err.Error()
		if len(msg) > 300 {
			msg = msg[:300]
		}
		p.status.Error = msg
	}
}

// Learn asks the router, and asks STUN only when the router has no public answer: it does not
// speak NAT-PMP (PCP-only routers answer with a version error), or it sits behind another NAT,
// whose address it then reports (private or shared space, which the guard denies anyway).
func (p *Public) Learn(d Discovery) error {
	if d.Off() {
		p.record("off", "", nil)
		return nil
	}
	if d.Timeout == 0 {
		d.Timeout = 3 * time.Second
	}
	var errs []error
	if d.Router != nil {
		a, err := askRouter(d)
		if err == nil && publicIPv4(a) {
			p.add(a)
			p.record("active", "nat-pmp", nil)
			return nil
		}
		if err == nil {
			p.add(a)
			err = fmt.Errorf("nat-pmp: the router's address %s is behind another NAT", a)
		}
		errs = append(errs, err)
	}
	if d.STUN != "" {
		a, err := stunAddr(d.STUN, d.Timeout)
		if err == nil && publicIPv4(a) {
			p.add(a)
			p.record("active", "stun", nil)
			return nil
		}
		if err == nil {
			err = fmt.Errorf("stun %s: answered %s, which is not a public address", d.STUN, a)
		}
		errs = append(errs, err)
	}
	err := errors.Join(errs...)
	p.record("unknown", "", err)
	return err
}

// Keep learns at once, then again every `every` while the address is known and every `retry`
// while it is not, until stop is closed. A failed round goes to logf and to the status.
func (p *Public) Keep(d Discovery, every, retry time.Duration, stop <-chan struct{}, logf func(string, ...any)) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-stop:
			return
		case <-timer.C:
		}
		wait := every
		if err := p.Learn(d); err != nil {
			logf("keyd: the public address is unknown, so hairpin NAT is not denied yet; asking again in %s: %v", retry, err)
			wait = retry
		}
		timer.Reset(wait)
	}
}

// WithPublic adds the learned addresses to own, so Check denies them as the Mac's own.
func WithPublic(own func() ([]netip.Prefix, error), p *Public) func() ([]netip.Prefix, error) {
	return func() ([]netip.Prefix, error) {
		prefixes, err := own()
		for _, a := range p.Addrs() {
			prefixes = append(prefixes, netip.PrefixFrom(a, a.BitLen()))
		}
		return prefixes, err
	}
}

// publicIPv4 says whether the internet routes a: an answer in private, shared or special space
// comes from a router behind another NAT.
func publicIPv4(a netip.Addr) bool {
	a = a.Unmap()
	if !a.Is4() {
		return false
	}
	for _, s := range static {
		if s.prefix.Contains(a) {
			return false
		}
	}
	return true
}

const (
	stunBindingRequest   = 0x0001
	stunBindingSuccess   = 0x0101
	stunMagicCookie      = 0x2112A442
	stunMappedAddress    = 0x0001
	stunXorMappedAddress = 0x0020
)

// stunAddr sends one Binding request (RFC 8489) over UDP/IPv4 and returns the mapped address.
// Datagrams that are not the answer to this request are ignored until the deadline.
func stunAddr(server string, timeout time.Duration) (netip.Addr, error) {
	conn, err := net.DialTimeout("udp4", server, timeout)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("stun %s: %w", server, err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return netip.Addr{}, err
	}
	req := make([]byte, 20)
	binary.BigEndian.PutUint16(req[0:2], stunBindingRequest)
	binary.BigEndian.PutUint32(req[4:8], stunMagicCookie)
	if _, err := rand.Read(req[8:20]); err != nil {
		return netip.Addr{}, err
	}
	if _, err := conn.Write(req); err != nil {
		return netip.Addr{}, fmt.Errorf("stun %s: %w", server, err)
	}
	buf := make([]byte, 1500)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return netip.Addr{}, fmt.Errorf("stun %s: %w", server, err)
		}
		if a, err := parseBindingSuccess(buf[:n], req[8:20]); err == nil {
			return a, nil
		}
	}
}

// parseBindingSuccess reads the mapped address from a Binding success response to the request
// with transaction ID txid; XOR-MAPPED-ADDRESS wins over the older MAPPED-ADDRESS.
func parseBindingSuccess(msg, txid []byte) (netip.Addr, error) {
	if len(msg) < 20 || binary.BigEndian.Uint16(msg[0:2]) != stunBindingSuccess ||
		binary.BigEndian.Uint32(msg[4:8]) != stunMagicCookie || !bytes.Equal(msg[8:20], txid) {
		return netip.Addr{}, errors.New("stun: not the answer to this request")
	}
	length := int(binary.BigEndian.Uint16(msg[2:4]))
	if length%4 != 0 || 20+length > len(msg) {
		return netip.Addr{}, errors.New("stun: bad message length")
	}
	key := msg[4:20]
	var mapped netip.Addr
	for attrs := msg[20 : 20+length]; len(attrs) >= 4; {
		typ := binary.BigEndian.Uint16(attrs[0:2])
		n := int(binary.BigEndian.Uint16(attrs[2:4]))
		if 4+n > len(attrs) {
			return netip.Addr{}, errors.New("stun: truncated attribute")
		}
		switch typ {
		case stunXorMappedAddress:
			if a, ok := stunAddress(attrs[4:4+n], key); ok {
				return a, nil
			}
		case stunMappedAddress:
			if a, ok := stunAddress(attrs[4:4+n], nil); ok {
				mapped = a
			}
		}
		next := 4 + n + (4-n%4)%4
		if next > len(attrs) {
			break
		}
		attrs = attrs[next:]
	}
	if mapped.IsValid() {
		return mapped, nil
	}
	return netip.Addr{}, errors.New("stun: no mapped address")
}

// stunAddress decodes a MAPPED-ADDRESS value, or an XOR-MAPPED-ADDRESS one when key (the magic
// cookie and the transaction ID) is given.
func stunAddress(val, key []byte) (netip.Addr, bool) {
	if len(val) < 4 {
		return netip.Addr{}, false
	}
	var raw []byte
	switch {
	case val[1] == 0x01 && len(val) == 8:
		raw = slices.Clone(val[4:8])
	case val[1] == 0x02 && len(val) == 20:
		raw = slices.Clone(val[4:20])
	default:
		return netip.Addr{}, false
	}
	for i := range raw {
		if key != nil {
			raw[i] ^= key[i]
		}
	}
	a, ok := netip.AddrFromSlice(raw)
	return a.Unmap(), ok
}
```

`keyd/internal/netguard/natpmp.go`:
```go
package netguard

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const natpmpPort = 5351

// askRouter asks the default gateway for its external IPv4 address: NAT-PMP's request 0 (RFC
// 6886), resent after 250 ms and then twice as long until the timeout. The socket is connected,
// so only the gateway's answers are read.
func askRouter(d Discovery) (netip.Addr, error) {
	router, err := d.Router()
	if err != nil {
		return netip.Addr{}, fmt.Errorf("nat-pmp: %w", err)
	}
	port := d.NATPMPPort
	if port == 0 {
		port = natpmpPort
	}
	conn, err := net.DialUDP("udp4", nil, net.UDPAddrFromAddrPort(netip.AddrPortFrom(router, uint16(port))))
	if err != nil {
		return netip.Addr{}, fmt.Errorf("nat-pmp %s: %w", router, err)
	}
	defer conn.Close()
	deadline := time.Now().Add(d.Timeout)
	buf := make([]byte, 64)
	for wait := 250 * time.Millisecond; ; wait *= 2 {
		if _, err := conn.Write([]byte{0, 0}); err != nil {
			return netip.Addr{}, fmt.Errorf("nat-pmp %s: %w", router, err)
		}
		next := time.Now().Add(wait)
		if next.After(deadline) {
			next = deadline
		}
		if err := conn.SetReadDeadline(next); err != nil {
			return netip.Addr{}, err
		}
		for {
			n, err := conn.Read(buf)
			if err != nil {
				var timeout net.Error
				if errors.As(err, &timeout) && timeout.Timeout() && time.Now().Before(deadline) {
					break
				}
				return netip.Addr{}, fmt.Errorf("nat-pmp %s: %w", router, err)
			}
			a, err := parseNATPMP(buf[:n])
			if errors.Is(err, errNotNATPMP) {
				continue
			}
			if err != nil {
				return netip.Addr{}, fmt.Errorf("nat-pmp %s: %w", router, err)
			}
			return a, nil
		}
	}
}

var errNotNATPMP = errors.New("not a NAT-PMP external address answer")

// parseNATPMP reads an external address response: version 0, opcode 128, a result code, the
// seconds since the router's epoch and the address. A PCP-only router answers version 2.
func parseNATPMP(msg []byte) (netip.Addr, error) {
	if len(msg) >= 2 && msg[0] == 2 {
		return netip.Addr{}, errors.New("the router speaks PCP only")
	}
	if len(msg) < 12 || msg[0] != 0 || msg[1] != 128 {
		return netip.Addr{}, errNotNATPMP
	}
	if code := binary.BigEndian.Uint16(msg[2:4]); code != 0 {
		return netip.Addr{}, fmt.Errorf("the router refused with result code %d", code)
	}
	a := netip.AddrFrom4([4]byte(msg[8:12]))
	if a.IsUnspecified() {
		return netip.Addr{}, errors.New("the router has no external address")
	}
	return a, nil
}

// DefaultGateway finds the IPv4 default gateway: macOS's `route -n get default`, Linux's
// /proc/net/route.
func DefaultGateway() (netip.Addr, error) {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("/sbin/route", "-n", "get", "default").Output()
		if err != nil {
			return netip.Addr{}, fmt.Errorf("route -n get default: %w", err)
		}
		return gatewayFromRouteGet(string(out))
	case "linux":
		text, err := os.ReadFile("/proc/net/route")
		if err != nil {
			return netip.Addr{}, err
		}
		return gatewayFromProcRoute(string(text))
	}
	return netip.Addr{}, fmt.Errorf("no default gateway lookup on %s", runtime.GOOS)
}

func gatewayFromRouteGet(out string) (netip.Addr, error) {
	for _, line := range strings.Split(out, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok || key != "gateway" {
			continue
		}
		a, err := netip.ParseAddr(strings.TrimSpace(value))
		if err == nil && a.Is4() {
			return a, nil
		}
	}
	return netip.Addr{}, errors.New("no IPv4 default gateway")
}

// gatewayFromProcRoute reads the default route's gateway, which /proc/net/route prints as
// little-endian hex.
func gatewayFromProcRoute(text string) (netip.Addr, error) {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || f[1] != "00000000" {
			continue
		}
		v, err := strconv.ParseUint(f[2], 16, 32)
		if err != nil || v == 0 {
			continue
		}
		return netip.AddrFrom4([4]byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)}), nil
	}
	return netip.Addr{}, errors.New("no IPv4 default gateway")
}
```

In `keyd/internal/netguard/guard.go`, add four rules to `static` (after `r("2001::/32", "teredo"),`
and after `r("2001:db8::/32", "documentation"),` respectively):
```go
	r("2001:2::/48", "benchmarking"),
	r("2001:10::/28", "orchid"),
	r("2001:20::/28", "orchid v2"),
```
```go
	r("3fff::/20", "documentation"),
```
add to the `var ( nat64 …; sixToFour … )` block:
```go
	// IANA's global unicast space. Every other IPv6 range is special-purpose (SIIT, local-use NAT64,
	// the dummy prefix, SRv6 SIDs, or whatever is assigned next), so nothing outside it is dialled
	// but the well-known NAT64 prefix, whose embedded IPv4 address is checked instead.
	globalUnicast = netip.MustParsePrefix("2000::/3")
```
and in `Check`, inside `for _, a := range embedded(addr)`, right after the loop over `static` (so
the named ranges keep their names):
```go
		if a.Is6() && !globalUnicast.Contains(a) && !nat64.Contains(a) {
			return &DeniedError{Target: addr.String(), Rule: "outside global unicast 2000::/3"}
		}
```

In `keyd/internal/admin/admin.go`, import `netguard`, add the field to `Server`
```go
	// The hairpin guard's state, reported in /v1/status (nil: not reported).
	Hairpin *netguard.Public
```
add `"hairpin": s.hairpin(),` after `"audit": auditState,` in `status`'s reply, and before
`listSecrets`:
```go
func (s *Server) hairpin() any {
	if s.Hairpin == nil {
		return nil
	}
	return s.Hairpin.Status()
}
```

In `keyd/cmd/keyd/main.go`:
- `Config` gains
  ```go
  	// Where keyd learns its public address, which it then denies (hairpin NAT): the router, then
  	// STUN. The zero value asks nobody, as the tests do.
  	Discovery netguard.Discovery
  ```
  and after `Config`:
  ```go
  // The hairpin guard asks again every 5 minutes while it knows the address, every 30 s while not.
  const (
  	hairpinEvery = 5 * time.Minute
  	hairpinRetry = 30 * time.Second
  )
  ```
- in `run`, after the `ports` flag:
  ```go
  	natpmp := fs.String("natpmp", "on", "ask the router (NAT-PMP) for the public address keyd denies: on or off")
  	stun := fs.String("stun", netguard.DefaultSTUN, "the STUN server (host:port) asked only when the router gives no public address, or off")
  ```
  and replace the flag check and `d, err := start(Config{Home: *home, Vault: *store, Ports: portRange})` with
  ```go
  	if err != nil || (*store != "keychain" && *store != "memory") || (*natpmp != "on" && *natpmp != "off") {
  		fmt.Fprintln(stderr, "keyd: -ports wants MIN-MAX, -vault keychain or memory, -natpmp on or off")
  		return 2
  	}
  	discovery := netguard.Discovery{Timeout: 3 * time.Second}
  	if *natpmp == "on" {
  		discovery.Router = netguard.DefaultGateway
  	}
  	if *stun != "off" {
  		discovery.STUN = *stun
  	}
  	d, err := start(Config{Home: *home, Vault: *store, Ports: portRange, Discovery: discovery})
  ```
- `Daemon` gains two fields:
  ```go
  	public       *netguard.Public
  	stopLearning chan struct{}
  ```
- in `init`, replace `guard := netguard.New(netguard.InterfacePrefixes)` with
  ```go
  	d.public = &netguard.Public{}
  	guard := netguard.New(netguard.WithPublic(netguard.InterfacePrefixes, d.public))
  ```
  add `Hairpin: d.public` to the `admin.Server` literal, and right before `go d.server.Serve(ln)`:
  ```go
  	// With both sources off the guard says so at once; otherwise it is unknown until one answers.
  	if cfg.Discovery.Off() {
  		d.public.Learn(cfg.Discovery)
  	} else {
  		d.stopLearning = make(chan struct{})
  		logf := func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }
  		go d.public.Keep(cfg.Discovery, hairpinEvery, hairpinRetry, d.stopLearning, logf)
  	}
  ```
- `Close` starts with:
  ```go
  	if d.stopLearning != nil {
  		close(d.stopLearning)
  		d.stopLearning = nil
  	}
  ```

Add to the `## keyd` section of `README.md`, after its last sentence:
```markdown
keyd refuses to dial this network's public IPv4 address, where a router answers from inside the
network (hairpin NAT). It asks the router for it first (NAT-PMP, `-natpmp on|off`), and only when
the router has no public answer one STUN server (`-stun`, default Cloudflare's; `-stun off` never
asks a third party). It asks again every 30 seconds while the address is unknown and every five
minutes once it is known. `pnpm --filter @localdot/daemon run doctor` and the Keys sheet say whether
the guard is active. The tests pass `-natpmp off -stun off`.
```

- [ ] **Step 5: Run the tests**

Run: `cd keyd && test -z "$(gofmt -l .)" && go vet ./... && go test -race ./internal/netguard/ ./cmd/keyd/ && go test ./...`
Expected: no output from gofmt or vet. netguard and cmd/keyd are `ok` under `-race`. The new tests:
- netguard: `TestParseBindingSuccess`, `TestParseBindingSuccessRefusesAnythingElse`,
  `TestLearnAsksTheRouterFirstAndNoThirdParty`, `TestLearnAsksSTUNOnlyWhenTheRouterHasNoPublicAnswer`,
  `TestLearnSaysUnknownWhenNothingAnswersAndKeepsWhatItHad`, `TestLearnIsOffWithBothSourcesOff`,
  `TestKeepAsksAgainSoonWhileTheAddressIsUnknown`, `TestParseNATPMP` and `TestGatewayLookups`;
- cmd/keyd: `TestStartLearnsThePublicAddressItDeniesAndReportsTheGuard` and
  `TestStartWithDiscoveryOffSaysTheGuardIsOff`.

Every package of the module is `ok`. Every fake router and STUN server listens on loopback.

- [ ] **Step 6: Commit**

```bash
git add keyd/internal/netguard keyd/internal/admin keyd/cmd/keyd README.md
git commit -m "feat(keyd): deny the rest of the special IPv6 space and the network's public address"
```

---

### Task 2: The protocol — keyd's admin types, the browser seal, the self-test report, budget events

Everything the daemon, `desktopd` and the UI exchange about keys lives in `@localdot/protocol`.

- **Wire types.** keyd's admin replies are parsed loosely (unknown fields dropped), so a newer keyd
  stays readable. What the daemon sends is strict, because keyd refuses unknown fields. A
  `SealedSecret` body is `{ binding, sealed }` and nothing else, so a plaintext value cannot ride
  along.
- **The seal.** `sealSecret` is Part 4a's reference function ("Sealing a key in the UI") on
  WebCrypto, which runs in the browser and in Node. `bindingJson` builds the AAD array. It refuses
  any string outside printable ASCII: Go's encoder escapes U+2028, U+2029 and non-ASCII differently
  from `JSON.stringify`, so the browser and keyd would disagree. The form therefore sends a base URL
  as `new URL(x).href` (controller carry-in).
- **Events.** `key.use` gets the bounds the timeline shows, and `budget.exceeded` joins the event
  log (Part 4a "Events").
- **keyd's status.** It carries the hairpin guard (`HairpinGuard`: `active`, `unknown` or `off`,
  Task 1). A state this code does not know reads as `unknown`, never as `active`.
- **Variable names.** `surrogateEnvName` maps `a-b` and `a_b` to one `LOCALDOT_KEY_A_B`, so
  `surrogateEnvClash` names the stored key a new name would collide with; the key routes refuse it
  (Task 4).
- **The self-test report.** `SelfTestReport` is the self-test's wire shape. `selfTestPassed`
  recomputes the verdict from the checks rather than trusting the report's own `ok`. The daemon,
  not desktopd, decides which checks there are: `SELFTEST_CHECKS` lists all eleven, and a report
  passes only with each of them exactly once and every check ok. A desktopd built before a check
  existed, or one that leaves a check out, never makes a cell ready (review I3).

The vectors in `seal.test.ts` are the ones keyd's `seal_test.go` opens, plus the two blobs keyd's
own tests sealed, opened here with WebCrypto.

**Files:**
- Create: `packages/protocol/src/keyd.ts`, `packages/protocol/src/seal.ts`,
  `packages/protocol/src/selftest.ts`, `packages/protocol/src/keyd.test.ts`,
  `packages/protocol/src/seal.test.ts`, `packages/protocol/src/selftest.test.ts`
- Modify: `packages/protocol/src/events.ts`, `packages/protocol/src/events.test.ts`,
  `packages/protocol/src/index.ts`, `packages/protocol/schema/events.schema.json` (regenerated)

**Interfaces:**
- Consumes: Part 4a's admin API shapes and seal v1 (HKDF info `localdot-keyd seal v1`, AAD
  `"localdot-keyd seal v1:" + JSON [id, kind, provider, baseURL, hosts, header, format, methods, paths]`).
- Produces (all exported from `@localdot/protocol`):
  - **Patterns and constants:** `SECRET_ID_PATTERN`, `RESERVED_SECRET_IDS`, `SURROGATE_PATTERN`,
    `PRINTABLE_ASCII`, `LLM_PROVIDERS`, `HTTP_FORMATS`.
  - **Request schemas:** `SecretId`, `LlmBinding`, `HttpBinding`, `SecretBinding` (type
    `SecretBinding`), `Sealed`, `SealedSecret`.
  - **Reply schemas:** `KeydRecord`, `KeydStatus` (with `hairpin?: HairpinGuard | null`),
    `HairpinGuard { state: "active" | "unknown" | "off"; source?; addresses; checkedAt?; error? }`,
    `KeydOpened`, `KeydCellInfo`, `KeydSecrets`, `KeydRevoked`, `KeydMinted`, `KeydErrorBody`,
    `KeyUseData`, `BudgetData`, `KeydEvent`.
  - **Functions:** `surrogateEnvName(id)` (`LOCALDOT_KEY_<ID>`);
    `surrogateEnvClash(id, existingIds) → string | undefined`;
    `sealSecret(publicKey, binding, value, opts?) → Promise<Sealed>`; `bindingJson(binding)`
    (throws `BindingTextError(field)`); `SEAL_INFO`; `toBase64url`; `fromBase64url`.
  - **Self-test:** `SelfTestCheck { id; kind: "isolation" | "keyd" | "trust"; ok; detail }`,
    `SelfTestReport { ok; checks; ms }`, `SELFTEST_CHECKS` (`{ id, kind }` in desktopd's order:
    `route`, `direct-ipv4`, `direct-ipv6`, `dns`, `host`, `gateway`, `keyd-token`, `keyd`,
    `forwarder`, `ca-system`, `ca-nss`), `SELFTEST_CHECK_IDS`, `selfTestPassed(report)`.
  - **Events:** `KeyUse` data bounded (secretId ≤ 64, host ≤ 255, method ≤ 16, path ≤ 512);
    `BudgetExceeded` (`budget.exceeded`: `scope`, `taskId?`, `limitUSD`, `spentUSD`, `needUSD?`).

- [ ] **Step 1: Write the failing tests**

`packages/protocol/src/keyd.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  KeydEvent,
  KeydOpened,
  KeydStatus,
  Sealed,
  SealedSecret,
  SecretBinding,
  SURROGATE_PATTERN,
  surrogateEnvClash,
  surrogateEnvName,
} from "./keyd.ts";

const sealed = {
  v: 1,
  epk: "BLhfkHvMwLU1VR2xt2QbapafF0HZL1U_EABDIa8GocmgFNZqvKrR0ZinBw_bbXXvp1tZIDoT8KptqEj3qt86wj0",
  nonce: "AAECAwQFBgcICQoL",
  ct: "wpSd7tLllnTJVPphF6Utcgorgp-jGSSn9dEwVhuXCcB6rJ_hpNaF",
};

describe("SecretBinding", () => {
  it("accepts the two kinds keyd stores", () => {
    expect(SecretBinding.parse({ id: "anthropic", kind: "llm", provider: "anthropic" }).kind).toBe(
      "llm",
    );
    expect(
      SecretBinding.parse({
        id: "weather-api",
        kind: "http",
        hosts: ["api.weather.example"],
        header: "X-Api-Key",
        format: "raw",
      }).kind,
    ).toBe("http");
  });

  it("refuses unknown fields, a value field above all, so plaintext can't ride along", () => {
    expect(() =>
      SecretBinding.parse({
        id: "a1",
        kind: "llm",
        provider: "openai",
        value: "real-secret-value",
      }),
    ).toThrow();
    expect(() =>
      SealedSecret.parse({
        binding: { id: "a1", kind: "llm", provider: "openai" },
        sealed,
        value: "x",
      }),
    ).toThrow();
  });

  it("refuses bad ids, reserved ids, empty host lists and non-ASCII text", () => {
    for (const id of ["", "Upper", "-lead", "a/b", "lmstudio", "ollama", "x".repeat(65)]) {
      expect(() => SecretBinding.parse({ id, kind: "llm", provider: "openai" }), id).toThrow();
    }
    expect(() =>
      SecretBinding.parse({ id: "w", kind: "http", hosts: [], header: "X", format: "raw" }),
    ).toThrow();
    expect(() =>
      SecretBinding.parse({
        id: "w",
        kind: "http",
        hosts: ["bücher.example"],
        header: "X",
        format: "raw",
      }),
    ).toThrow();
    expect(() =>
      SecretBinding.parse({
        id: "g",
        kind: "llm",
        provider: "openai-compatible",
        baseURL: "https://e.example/ ",
      }),
    ).toThrow();
  });
});

describe("Sealed", () => {
  it("accepts a v1 blob and refuses padding, other versions and short nonces", () => {
    expect(Sealed.parse(sealed)).toEqual(sealed);
    expect(() => Sealed.parse({ ...sealed, v: 2 })).toThrow();
    expect(() => Sealed.parse({ ...sealed, ct: `${sealed.ct}==` })).toThrow();
    expect(() => Sealed.parse({ ...sealed, nonce: "AAEC" })).toThrow();
  });
});

describe("keyd replies", () => {
  it("parses an opened cell and refuses a surrogate that is not one", () => {
    const opened = {
      cellId: "01JXYZ0000000000000000ABCD",
      port: 4760,
      proxyToken: "j6CLzsRw79yMKkRwPznckks1fdcXOOnPN3DYp3Al_gk",
      caCertPem: "-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----\n",
      caPath: "/tmp/ld/keyd/cells/c/ca.pem",
      surrogates: { weather: "ld_key_0123456789abcdefABCDEF_abc123" },
    };
    expect(KeydOpened.parse(opened).surrogates?.weather).toMatch(SURROGATE_PATTERN);
    expect(() =>
      KeydOpened.parse({ ...opened, surrogates: { weather: "ld_key_x'; rm -rf /'" } }),
    ).toThrow();
  });

  it("parses the three event types and refuses others", () => {
    const keyUse = {
      type: "key.use",
      cell: "c1",
      time: "2026-10-01T12:00:00.123Z",
      data: {
        secretId: "weather",
        host: "api.weather.example",
        method: "GET",
        path: "/v1",
        decision: "allow",
      },
    };
    expect(KeydEvent.parse(keyUse).type).toBe("key.use");
    expect(
      KeydEvent.parse({
        type: "budget.exceeded",
        cell: "c1",
        time: "t",
        data: { scope: "task", taskId: "t1", limitUSD: 5, spentUSD: 5.1 },
      }).type,
    ).toBe("budget.exceeded");
    expect(KeydEvent.parse({ type: "events.dropped", time: "t", data: { count: 4 } }).type).toBe(
      "events.dropped",
    );
    expect(() => KeydEvent.parse({ ...keyUse, type: "key.leak" })).toThrow();
    expect(() =>
      KeydEvent.parse({ ...keyUse, data: { ...keyUse.data, decision: "maybe" } }),
    ).toThrow();
  });
});

describe("surrogateEnvName", () => {
  it("prefixes every name so no key can shadow PATH or a proxy variable", () => {
    expect(surrogateEnvName("weather")).toBe("LOCALDOT_KEY_WEATHER");
    expect(surrogateEnvName("open-weather_2")).toBe("LOCALDOT_KEY_OPEN_WEATHER_2");
    expect(surrogateEnvName("path")).toBe("LOCALDOT_KEY_PATH");
    expect(surrogateEnvName("https_proxy")).toBe("LOCALDOT_KEY_HTTPS_PROXY");
  });

  it("names the stored key whose variable a new name would share", () => {
    expect(surrogateEnvClash("open-weather", ["maps", "open_weather"])).toBe("open_weather");
    expect(surrogateEnvClash("open_weather", ["open_weather", "maps"])).toBeUndefined();
    expect(surrogateEnvClash("weather", ["weather-2", "weather_api"])).toBeUndefined();
  });
});

describe("KeydStatus", () => {
  const status = {
    bootId: "0123456789abcdef",
    version: "0.1.0",
    sealKey: sealed.epk,
    cells: 0,
    secrets: 0,
    limits: { perTaskUSD: 5, perDayUSD: 20 },
    day: { date: "2026-10-01", spentUSD: 0 },
    audit: { ok: true },
  };

  it("reads the hairpin guard's state, and a state it does not know as unknown", () => {
    const active = { state: "active", source: "nat-pmp", addresses: 1, checkedAt: "t" };
    expect(KeydStatus.parse({ ...status, hairpin: active }).hairpin).toEqual(active);
    expect(
      KeydStatus.parse({ ...status, hairpin: { state: "learning", addresses: 0 } }).hairpin?.state,
    ).toBe("unknown");
    expect(KeydStatus.parse(status).hairpin).toBeUndefined();
    expect(KeydStatus.parse({ ...status, hairpin: null }).hairpin).toBeNull();
  });
});
```

`packages/protocol/src/seal.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Sealed, SecretBinding } from "./keyd.ts";
import {
  BindingTextError,
  bindingJson,
  type EcPrivateJwk,
  fromBase64url,
  SEAL_INFO,
  sealSecret,
} from "./seal.ts";

// keyd's fixed test key from Part 4a's vault/seal_test.go (scalar 6b1f3c2a…17f8).
const KEYD_PUBLIC =
  "BG2x8-BG3l6OwZSDEY2jv15f49mKcudyq5wvNeAMGomjt95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM";
const KEYD_PRIVATE: EcPrivateJwk = {
  kty: "EC",
  crv: "P-256",
  x: "bbHz4EbeXo7BlIMRjaO_Xl_j2Ypy53KrnC814AwaiaM",
  y: "t95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM",
  d: "ax88Kp2Of2BRQjMkFQb36NnKu6ydjn9gUUIzJBUGF_g",
};
// A pinned ephemeral key (scalar 1f2e3d4c…8b9a) and nonce for known-answer vectors.
const EPHEMERAL: EcPrivateJwk = {
  kty: "EC",
  crv: "P-256",
  x: "uF-Qe8zAtTVVHbG3ZBtqlp8XQdkvVT8QAEMhrwahyaA",
  y: "FNZqvKrR0ZinBw_bbXXvp1tZIDoT8KptqEj3qt86wj0",
  d: "Hy49TFtqeYgXJjVEU2JxgKm4x9bl9AMSITBPXm18i5o",
};
const NONCE = Uint8Array.from({ length: 12 }, (_, i) => i);
const VALUE = "fake-key-from-webcrypto";

const weather: SecretBinding = {
  id: "weather",
  kind: "http",
  hosts: ["api.example.test", "b.example.test"],
  header: "Authorization",
  format: "bearer",
  methods: ["GET"],
  paths: ["/v1/a&b/"],
};
const groq: SecretBinding = {
  id: "groq",
  kind: "llm",
  provider: "openai-compatible",
  baseURL: "https://api.groq.com/openai/v1",
};

// What keyd does with a sealed value, in WebCrypto: the test's stand-in for vault.Opener.
async function open(sealed: Sealed, binding: SecretBinding): Promise<string> {
  const { subtle } = globalThis.crypto;
  const keyd = await subtle.importKey(
    "jwk",
    KEYD_PRIVATE,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const epkRaw = fromBase64url(sealed.epk);
  const epk = await subtle.importKey(
    "raw",
    epkRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await subtle.deriveBits({ name: "ECDH", public: epk }, keyd, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array([...epkRaw, ...fromBase64url(KEYD_PUBLIC)]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(SEAL_INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64url(sealed.nonce),
      additionalData: new TextEncoder().encode(`${SEAL_INFO}:${bindingJson(binding)}`),
    },
    key,
    fromBase64url(sealed.ct),
  );
  return new TextDecoder().decode(plain);
}

describe("sealSecret", () => {
  it("produces the vectors keyd's Go opener opens", async () => {
    // Opened by vault.Opener with the fixed key above (Go 1.27.1, 2026-10-01).
    expect(
      await sealSecret(KEYD_PUBLIC, weather, VALUE, { ephemeral: EPHEMERAL, nonce: NONCE }),
    ).toEqual({
      v: 1,
      epk: "BLhfkHvMwLU1VR2xt2QbapafF0HZL1U_EABDIa8GocmgFNZqvKrR0ZinBw_bbXXvp1tZIDoT8KptqEj3qt86wj0",
      nonce: "AAECAwQFBgcICQoL",
      ct: "wpSd7tLllnTJVPphF6Utcgorgp-jGSSn9dEwVhuXCcB6rJ_hpNaF",
    });
    expect(
      (await sealSecret(KEYD_PUBLIC, groq, VALUE, { ephemeral: EPHEMERAL, nonce: NONCE })).ct,
    ).toBe("wpSd7tLllnTJVPphF6Utcgorgp-jGSRMDJgiVN_r58h6FkhSL0r3");
  });

  it("opens what keyd's own tests sealed, so both sides agree on the format", async () => {
    const fromGoTests: [SecretBinding, Sealed][] = [
      [
        { id: "anthropic", kind: "llm", provider: "anthropic" },
        {
          v: 1,
          epk: "BDRBSHmompILZT4JXnwFw_aLRlQBykzXvyaBUZKuUZHkfbY1Hi_0x2xLVFEhKRT3RBSwEKdH7ofgaQaMkb1E_-4",
          nonce: "RcWTiYUMWlwdbPpo",
          ct: "eSbQx0PjBEKB5huMwBy6TF0BeOiziJjeNgrtcGcDXzKjeAqbRAcR",
        },
      ],
      [
        weather,
        {
          v: 1,
          epk: "BCghCEuuHBof4xoiFZ9-spP370ghtOh8IKmtP_zyqo34vqD9IbiojExBy3YylZssk48g6qJiST45EKz289oeRzY",
          nonce: "FgtfN8Eg8teW7BSf",
          ct: "G_0PaqZmmO-YCxm4CHC4lqox8u2JRzw7GckBNM6B3LCBKr0Ywfqk",
        },
      ],
    ];
    for (const [binding, sealed] of fromGoTests) expect(await open(sealed, binding)).toBe(VALUE);
  });

  it("seals with a fresh key and nonce every time, bound to the whole binding", async () => {
    const a = await sealSecret(KEYD_PUBLIC, weather, VALUE);
    const b = await sealSecret(KEYD_PUBLIC, weather, VALUE);
    expect(a.epk).not.toBe(b.epk);
    expect(a.nonce).not.toBe(b.nonce);
    expect(await open(a, weather)).toBe(VALUE);
    const elsewhere: SecretBinding = { ...weather, hosts: [...weather.hosts, "evil.example.test"] };
    await expect(open(a, elsewhere)).rejects.toThrow();
    await expect(open(a, { ...weather, id: "other" })).rejects.toThrow();
    await expect(open(a, { ...weather, methods: undefined })).rejects.toThrow();
  });

  it("never puts the value in the sealed fields", async () => {
    const sealed = await sealSecret(KEYD_PUBLIC, groq, VALUE);
    expect(JSON.stringify(sealed)).not.toContain(VALUE);
    expect(JSON.stringify(sealed)).not.toContain(btoa(VALUE).replace(/=+$/, ""));
  });
});

describe("bindingJson", () => {
  it("writes the AAD array exactly as keyd's Go encoder does for printable ASCII", () => {
    // Go: json.Encoder with SetEscapeHTML(false) printed this line for the same record.
    expect(
      bindingJson({
        id: "weather",
        kind: "http",
        hosts: ["api.example.test"],
        header: "Authorization",
        format: "raw",
        paths: ['/a&b<c>/"q"/\\\'~'],
      }),
    ).toBe(
      String.raw`["weather","http","","",["api.example.test"],"Authorization","raw",[],["/a&b<c>/\"q\"/\\'~"]]`,
    );
    expect(bindingJson(groq)).toBe(
      '["groq","llm","openai-compatible","https://api.groq.com/openai/v1",[],"","",[],[]]',
    );
  });

  it("refuses text Go would escape differently, naming the field", () => {
    const lineSeparator = String.fromCodePoint(0x2028);
    expect(() =>
      bindingJson({ ...groq, baseURL: `https://e.example/p${lineSeparator}q` } as SecretBinding),
    ).toThrow(BindingTextError);
    expect(() => bindingJson({ ...weather, hosts: ["bücher.example"] })).toThrow(
      "hosts must be printable ASCII",
    );
    expect(() => bindingJson({ ...weather, header: "X\tKey" })).toThrow(
      "header must be printable ASCII",
    );
  });

  it("is what new URL(x).href makes of a base URL with non-ASCII text", () => {
    const href = new URL(`https://bücher.example/v1/${String.fromCodePoint(0x2028)}`).href;
    expect(href).toBe("https://xn--bcher-kva.example/v1/%E2%80%A8");
    expect(() => bindingJson({ ...groq, baseURL: href } as SecretBinding)).not.toThrow();
  });
});
```

`packages/protocol/src/selftest.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SELFTEST_CHECKS, type SelfTestReport, selfTestPassed } from "./selftest.ts";

const passing = (): SelfTestReport => ({
  ok: true,
  ms: 12,
  checks: SELFTEST_CHECKS.map((c) => ({ ...c, ok: true, detail: "fine" })),
});

describe("selfTestPassed", () => {
  it("passes a report with every check, each once and ok", () => {
    expect(selfTestPassed(passing())).toBe(true);
  });

  it("fails a report that leaves a check out, whatever the rest says", () => {
    const report = passing();
    const withoutDns = { ...report, checks: report.checks.filter((c) => c.id !== "dns") };
    expect(selfTestPassed(withoutDns)).toBe(false);
    expect(selfTestPassed({ ...report, checks: [] })).toBe(false);
  });

  it("fails a report that names a check twice, or fails any check, even one it added", () => {
    const report = passing();
    const twice = { ...report, checks: [...report.checks, { ...report.checks[0], id: "route" }] };
    expect(selfTestPassed(twice as SelfTestReport)).toBe(false);
    const extra = {
      ...report,
      checks: [...report.checks, { id: "new", kind: "isolation", ok: false, detail: "open" }],
    } satisfies SelfTestReport;
    expect(selfTestPassed(extra)).toBe(false);
    const lying = {
      ...report,
      checks: report.checks.map((c) => (c.id === "gateway" ? { ...c, ok: false } : c)),
    };
    expect(selfTestPassed(lying)).toBe(false);
  });
});
```

In `packages/protocol/src/events.test.ts`, add to `describe("parseEvent")`, before the JSON Schema
test:
```ts
  it("accepts keyd's key use and budget events and bounds what a cell chose", () => {
    const keyUse = {
      secretId: "weather",
      host: "api.weather.example",
      method: "GET",
      path: "/v1",
      decision: "deny",
    };
    expect(parseEvent({ ...base, agent: "keyd", type: "key.use", data: keyUse }).type).toBe(
      "key.use",
    );
    expect(() =>
      parseEvent({
        ...base,
        agent: "keyd",
        type: "key.use",
        data: { ...keyUse, path: `/${"a".repeat(512)}` },
      }),
    ).toThrow();
    expect(
      parseEvent({
        ...base,
        agent: "keyd",
        type: "budget.exceeded",
        data: { scope: "day", limitUSD: 20, spentUSD: 20.01, needUSD: 0.4 },
      }).type,
    ).toBe("budget.exceeded");
  });
```
and add `"budget.exceeded",` after `"key.use",` in the JSON Schema test's list of types.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run packages/protocol/src/keyd.test.ts packages/protocol/src/seal.test.ts packages/protocol/src/selftest.test.ts packages/protocol/src/events.test.ts`
Expected: FAIL. `keyd.test.ts`, `seal.test.ts` and `selftest.test.ts` cannot resolve `./keyd.ts`,
`./seal.ts` and `./selftest.ts`; in `events.test.ts` the 513-character path is accepted and
`budget.exceeded` is an unknown type. (Against a `selfTestPassed` that only checks "some checks,
all ok", two of `selftest.test.ts`'s three tests fail: a report without `dns` and one that names a
check twice both pass.)

- [ ] **Step 3: Write the code**

`packages/protocol/src/keyd.ts`:
```ts
import { z } from "zod";

// keyd's admin API as the daemon and the UI see it (Part 4a, "Interfaces Part 4b builds on").
// Replies are parsed loosely (unknown fields dropped) so a newer keyd stays readable; what the
// daemon sends is strict, because keyd refuses unknown fields.

export const SECRET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const RESERVED_SECRET_IDS: readonly string[] = ["lmstudio", "ollama"];
export const SURROGATE_PATTERN = /^ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$/;
export const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openai-compatible",
  "azure",
] as const;
export const HTTP_FORMATS = ["bearer", "raw", "basic-user", "basic-password"] as const;

const printable = (max: number) =>
  z.string().max(max).regex(PRINTABLE_ASCII, "printable ASCII only");

export const SecretId = z
  .string()
  .regex(SECRET_ID_PATTERN, "lowercase letters, digits, - and _, starting with a letter or digit")
  .refine((id) => !RESERVED_SECRET_IDS.includes(id), "this name is reserved");

export const LlmBinding = z.strictObject({
  id: SecretId,
  kind: z.literal("llm"),
  provider: z.enum(LLM_PROVIDERS),
  baseURL: printable(2048).optional(),
});

export const HttpBinding = z.strictObject({
  id: SecretId,
  kind: z.literal("http"),
  hosts: z.array(printable(253).min(1)).min(1).max(16),
  header: printable(128).min(1),
  format: z.enum(HTTP_FORMATS),
  methods: z.array(printable(16).min(1)).max(16).optional(),
  paths: z.array(printable(1024).min(1)).max(16).optional(),
});

// What the UI seals a key for, and what the daemon relays unchanged: the AAD is built from it.
export const SecretBinding = z.discriminatedUnion("kind", [LlmBinding, HttpBinding]);
export type SecretBinding = z.infer<typeof SecretBinding>;

const base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, "base64url without padding");

// v1: ECDH P-256 ephemeral key (uncompressed, 65 bytes), a 12-byte nonce, AES-256-GCM output of
// an 8-8192 byte value plus its 16-byte tag.
export const Sealed = z.strictObject({
  v: z.literal(1),
  epk: base64url(87, 87),
  nonce: base64url(16, 16),
  ct: base64url(32, 10_944),
});
export type Sealed = z.infer<typeof Sealed>;

export const SealedSecret = z.strictObject({ binding: SecretBinding, sealed: Sealed });
export type SealedSecret = z.infer<typeof SealedSecret>;

export const KeydRecord = z.object({
  id: z.string(),
  kind: z.enum(["llm", "http"]),
  provider: z.string().optional(),
  baseURL: z.string().optional(),
  hosts: z.array(z.string()).nullish(),
  header: z.string().optional(),
  format: z.string().optional(),
  methods: z.array(z.string()).nullish(),
  paths: z.array(z.string()).nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KeydRecord = z.infer<typeof KeydRecord>;

// keyd's hairpin-NAT guard: whether it knows the public address it must deny like the Mac's own.
// "unknown" while neither the router nor STUN has answered (keyd asks again every 30 s), "off"
// when both are turned off. A state this code does not know reads as unknown.
export const HairpinGuard = z.object({
  state: z.enum(["active", "unknown", "off"]).catch("unknown"),
  source: z.string().max(32).optional(),
  addresses: z.number().int().nonnegative(),
  checkedAt: z.string().optional(),
  error: z.string().max(500).optional(),
});
export type HairpinGuard = z.infer<typeof HairpinGuard>;

export const KeydStatus = z.object({
  bootId: z.string().min(1),
  version: z.string(),
  sealKey: base64url(87, 87),
  cells: z.number().int().nonnegative(),
  secrets: z.number().int().nonnegative(),
  limits: z.object({ perTaskUSD: z.number(), perDayUSD: z.number() }),
  day: z.object({ date: z.string(), spentUSD: z.number() }),
  audit: z.object({ ok: z.boolean(), error: z.string().optional() }),
  hairpin: HairpinGuard.nullish(),
});
export type KeydStatus = z.infer<typeof KeydStatus>;

export const KeydOpened = z.object({
  cellId: z.string(),
  port: z.number().int(),
  proxyToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  caCertPem: z.string().startsWith("-----BEGIN CERTIFICATE-----"),
  caPath: z.string(),
  surrogates: z.record(z.string(), z.string().regex(SURROGATE_PATTERN)).nullish(),
});
export type KeydOpened = z.infer<typeof KeydOpened>;

export const KeydCellInfo = z.object({
  cellId: z.string(),
  role: z.string(),
  port: z.number().int(),
  intercepts: z.array(z.string()).nullish(),
  surrogates: z.array(z.object({ secretId: z.string(), surrogateId: z.string() })).nullish(),
  task: z.object({ id: z.string(), limitUSD: z.number(), spentUSD: z.number() }).nullish(),
});
export type KeydCellInfo = z.infer<typeof KeydCellInfo>;

export const KeydSecrets = z.object({ secrets: z.array(KeydRecord).nullish() });
export const KeydRevoked = z.object({ revoked: z.number().int().nonnegative() });
export const KeydMinted = z.object({
  surrogates: z.record(z.string(), z.string().regex(SURROGATE_PATTERN)).nullish(),
});
export const KeydErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export const KeyUseData = z.object({
  secretId: z.string(),
  host: z.string(),
  method: z.string(),
  path: z.string(),
  decision: z.enum(["allow", "deny", "ask"]),
});

export const BudgetData = z.object({
  scope: z.enum(["task", "day"]),
  taskId: z.string().optional(),
  limitUSD: z.number(),
  spentUSD: z.number(),
  needUSD: z.number().optional(),
});

export const KeydEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key.use"), cell: z.string(), time: z.string(), data: KeyUseData }),
  z.object({
    type: z.literal("budget.exceeded"),
    cell: z.string(),
    time: z.string(),
    data: BudgetData,
  }),
  z.object({
    type: z.literal("events.dropped"),
    time: z.string(),
    data: z.object({ count: z.number().int().nonnegative() }),
  }),
]);
export type KeydEvent = z.infer<typeof KeydEvent>;

// The environment variable a desktop cell reads a web API key's surrogate from: always prefixed,
// so no secret name can shadow PATH, a proxy variable or anything else the cell relies on.
export function surrogateEnvName(secretId: string): string {
  return `LOCALDOT_KEY_${secretId.toUpperCase().replaceAll("-", "_")}`;
}

// Names that differ only in - and _ share one variable, so one key's stand-in would shadow the
// other's: the key already stored under such a name, if any.
export function surrogateEnvClash(
  secretId: string,
  existing: Iterable<string>,
): string | undefined {
  const name = surrogateEnvName(secretId);
  for (const other of existing) {
    if (other !== secretId && surrogateEnvName(other) === name) return other;
  }
  return undefined;
}
```

`packages/protocol/src/seal.ts`:
```ts
import { PRINTABLE_ASCII, type Sealed, type SecretBinding } from "./keyd.ts";

// keyd's seal v1 (Part 4a, vault/seal.go): ECDH P-256 with an ephemeral key, HKDF-SHA256 over the
// shared secret (salt = ephemeral public key || keyd public key, info = SEAL_INFO), AES-256-GCM
// with the secret's whole binding in the AAD, so a sealed value opens only under its binding.
export const SEAL_INFO = "localdot-keyd seal v1";

export class BindingTextError extends Error {
  constructor(readonly field: string) {
    super(`${field} must be printable ASCII`);
    this.name = "BindingTextError";
  }
}

// The AAD's JSON, byte for byte what keyd's Go encoder writes. Go escapes U+2028, U+2029 and
// invalid UTF-8 where JSON.stringify does not, so anything but printable ASCII is refused here
// (a base URL goes through new URL(x).href first, which encodes it as ASCII).
export function bindingJson(binding: SecretBinding): string {
  const http = binding.kind === "http" ? binding : undefined;
  const llm = binding.kind === "llm" ? binding : undefined;
  const fields: [string, string | string[]][] = [
    ["id", binding.id],
    ["kind", binding.kind],
    ["provider", llm?.provider ?? ""],
    ["baseURL", llm?.baseURL ?? ""],
    ["hosts", http?.hosts ?? []],
    ["header", http?.header ?? ""],
    ["format", http?.format ?? ""],
    ["methods", http?.methods ?? []],
    ["paths", http?.paths ?? []],
  ];
  for (const [name, value] of fields) {
    for (const text of typeof value === "string" ? [value] : value) {
      if (!PRINTABLE_ASCII.test(text)) throw new BindingTextError(name);
    }
  }
  return JSON.stringify(fields.map(([, value]) => value));
}

export interface EcPrivateJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
}

// Tests pin the ephemeral key and the nonce to compare against a vector keyd opens; in use both
// are fresh for every seal.
export interface SealOptions {
  ephemeral?: EcPrivateJwk;
  nonce?: Uint8Array<ArrayBuffer>;
}

export async function sealSecret(
  publicKey: string,
  binding: SecretBinding,
  value: string,
  opts: SealOptions = {},
): Promise<Sealed> {
  const aad = utf8(`${SEAL_INFO}:${bindingJson(binding)}`);
  const { subtle } = globalThis.crypto;
  const keydRaw = fromBase64url(publicKey);
  const keyd = await subtle.importKey(
    "raw",
    keydRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const pair = opts.ephemeral
    ? {
        privateKey: await subtle.importKey(
          "jwk",
          opts.ephemeral,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          ["deriveBits"],
        ),
        raw: rawPoint(opts.ephemeral),
      }
    : await freshPair();
  const shared = await subtle.deriveBits({ name: "ECDH", public: keyd }, pair.privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: concat(pair.raw, keydRaw), info: utf8(SEAL_INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = opts.nonce ?? globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    utf8(value),
  );
  return {
    v: 1,
    epk: toBase64url(pair.raw),
    nonce: toBase64url(nonce),
    ct: toBase64url(new Uint8Array(ct)),
  };
}

async function freshPair() {
  const { subtle } = globalThis.crypto;
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  return {
    privateKey: pair.privateKey,
    raw: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)),
  };
}

function rawPoint(jwk: EcPrivateJwk): Uint8Array<ArrayBuffer> {
  return concat(new Uint8Array([4]), fromBase64url(jwk.x), fromBase64url(jwk.y));
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
```

`packages/protocol/src/selftest.ts`:
```ts
import { z } from "zod";

// A desktop cell's boot self-test (desktopd GET /selftest). "isolation" checks prove the cell has
// no way out but its gate; "keyd" checks prove the gate reaches this cell's own keyd listener,
// which wants the cell's token; "trust" checks prove the cell's CA is installed.
export const SelfTestCheck = z.object({
  id: z.string().max(32),
  kind: z.enum(["isolation", "keyd", "trust"]),
  ok: z.boolean(),
  detail: z.string().max(500),
});
export type SelfTestCheck = z.infer<typeof SelfTestCheck>;

export const SelfTestReport = z.object({
  ok: z.boolean(),
  checks: z.array(SelfTestCheck).max(32),
  ms: z.number().nonnegative(),
});
export type SelfTestReport = z.infer<typeof SelfTestReport>;

// Every check desktopd's self-test runs, in its order.
export const SELFTEST_CHECKS = [
  { id: "route", kind: "isolation" },
  { id: "direct-ipv4", kind: "isolation" },
  { id: "direct-ipv6", kind: "isolation" },
  { id: "dns", kind: "isolation" },
  { id: "host", kind: "isolation" },
  { id: "gateway", kind: "isolation" },
  { id: "keyd-token", kind: "keyd" },
  { id: "keyd", kind: "keyd" },
  { id: "forwarder", kind: "keyd" },
  { id: "ca-system", kind: "trust" },
  { id: "ca-nss", kind: "trust" },
] as const satisfies readonly Pick<SelfTestCheck, "id" | "kind">[];
export const SELFTEST_CHECK_IDS: readonly string[] = SELFTEST_CHECKS.map((c) => c.id);

// The daemon recomputes the verdict from the checks rather than trusting the report's own ok, and
// it decides which checks there are: each one exactly once, so a desktopd built before a check
// existed, or one that leaves a check out, never makes a cell ready.
export function selfTestPassed(report: SelfTestReport): boolean {
  return (
    report.checks.every((c) => c.ok) &&
    SELFTEST_CHECK_IDS.every((id) => report.checks.filter((c) => c.id === id).length === 1)
  );
}
```

In `packages/protocol/src/events.ts`, replace the `KeyUse` event with the bounded one, add
`BudgetExceeded` after it, and add `BudgetExceeded` to the `LocalDotEvent` union right after
`KeyUse`:
```ts
// From keyd's audit: host, method and path are text the cell's request chose, cut to these
// limits by the daemon and shown as plain text, never markup.
export const KeyUse = event(
  "key.use",
  z.object({
    secretId: z.string().max(64),
    host: z.string().max(255),
    method: z.string().max(16),
    path: z.string().max(512),
    decision: z.enum(["allow", "deny", "ask"]),
  }),
);
export const BudgetExceeded = event(
  "budget.exceeded",
  z.object({
    scope: z.enum(["task", "day"]),
    taskId: z.string().max(128).optional(),
    limitUSD: z.number().nonnegative(),
    spentUSD: z.number().nonnegative(),
    needUSD: z.number().nonnegative().optional(),
  }),
);
```
In `packages/protocol/src/index.ts`, add (keeping the list sorted):
```ts
export * from "./keyd.ts";
export * from "./seal.ts";
export * from "./selftest.ts";
```
Regenerate the JSON Schema keyd reads: `pnpm --filter @localdot/protocol schema`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run packages/protocol && pnpm --filter @localdot/protocol typecheck`
Expected: PASS. `keyd.test.ts` has 9 tests, `seal.test.ts` 7, `selftest.test.ts` 3, and
`events.test.ts` one new test; the typecheck is clean. `git diff --stat packages/protocol/schema` shows `events.schema.json`
changed (`budget.exceeded` and the `maxLength`s of `key.use`).

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add packages/protocol
git commit -m "feat(protocol): keyd's admin types, the browser seal, the self-test report and budget events"
```

---

### Task 3: The daemon's keyd client, and the harness that runs the real keyd

The daemon reaches keyd over HTTP/1.1 on the Unix socket `<home>/keyd/admin.sock`. Every reply is
validated with the protocol's schemas, and an unexpected one is an error, never a guess.

**The private-socket check.** Whoever answers on that path receives sealed keys, and hands the UI
the public key to seal them to. A stand-in process there could therefore collect keys sealed to
itself. So before each request the client checks two things: the socket is this user's with no
group or other permission bits, and so is its folder. Otherwise it refuses, and says why. keyd
itself creates them that way (Part 4a: 0600 in a 0700 folder).

**Errors.** A refusal from keyd becomes `KeydError` with keyd's code. keyd being absent becomes
`KeydUnavailableError`, which the UI shows as "Key layer offline".

**Fakes and the harness.**
- `FakeKeyd` serves the admin API from memory on a private socket, for unit tests. Its status
  carries a hairpin guard (active unless a test says otherwise), and each cell keeps every surrogate
  keyd would still accept (`valid`), so a test can tell a revoke from a mint: minting adds one, only
  a revoke ends them, as in keyd.
- `startKeyd()` runs the real keyd with an in-memory vault, on the test ports, with `-natpmp off
  -stun off`. The keyd and Docker test configs build keyd once per run in a global setup
  (`keyd-build.ts`) that removes the build afterwards; elsewhere `keydBinary()` builds it once per
  test process.
- `*.keyd.test.ts` suites use it. They run only with `LOCALDOT_KEYD_TESTS=1 pnpm test:keyd`.

**Port ranges.** The test ports need one more thing from Part 2's `ports.ts`: `allocateKeydPort`
takes a range, and `parsePortRange` reads one (`LOCALDOT_KEYD_PORTS`, `LOCALDOT_TEST_KEYD_PORTS`).

**Files:**
- Create: `apps/daemon/src/keyd/client.ts`, `apps/daemon/src/keyd/client.test.ts`,
  `apps/daemon/src/keyd/client.keyd.test.ts`, `apps/daemon/src/keyd/testing/fake-keyd.ts`,
  `apps/daemon/src/keyd/testing/keyd-process.ts`, `apps/daemon/src/keyd/testing/keyd-build.ts`,
  `vitest.keyd.config.ts`
- Modify: `apps/daemon/src/cells/ports.ts`, `apps/daemon/src/cells/ports.test.ts`,
  `vitest.config.ts`, `vitest.docker.config.ts`, root `package.json`

**Interfaces:**
- Consumes: Task 2's schemas; Part 4a's admin API, ready line and flags; Task 1's `-natpmp` and
  `-stun`.
- Produces:
  - `keydSocketPath(home)`;
  - `privateSocketProblem(path): string | undefined`;
  - `KeydError { status; code; detail; path }` and `KeydUnavailableError` (status 0, code
    `unavailable`);
  - `OpenCellRequest { cellId; role; port; secrets }`;
  - `KeydClient(socketPath, timeoutMs = 5000)` with these methods:
    - `status()`, `secrets()`;
    - `putSecret(binding, sealed)`, `deleteSecret(id) → boolean`;
    - `openCell(req) → KeydOpened`, `cell(id) → KeydCellInfo | undefined`, `closeCell(id) → boolean`;
    - `revoke(id) → number`, `mint(id, secrets) → Record<secretId, surrogate>`;
    - `events(onEvent, signal) → Promise<void>`.
  - The fake: `FakeKeyd` (`calls`, `records`, `cells` of `FakeCell { …; surrogates; valid; revoked }`,
    `bootId`, `auditOk`, `hairpin`, `failures`, `publish(event)`, `subscribers`, `restart()`,
    `stop()`, `close()`), `startFakeKeyd()`, `fakeSurrogate()`, `FAKE_SEAL_KEY`, `FAKE_CA_PEM`.
  - The harness: `KEYD_TESTS`, `TEST_KEYD_PORTS`, `keydBinary()`,
    `startKeyd({ home?, ports? }) → KeydProcess { home; socketPath; bootId; stderr(); stop() }`;
    the Vitest global setup `keyd-build.ts` (`setup`, `teardown`), which sets `LOCALDOT_KEYD_BIN`.
  - In `ports.ts`: `PortRange`, `allocateKeydPort(inUse, range = KEYD_PORT_RANGE)` and
    `parsePortRange(text)` (undefined or "" gives `KEYD_PORT_RANGE`; anything else must be
    `from-to` with 1024 ≤ from ≤ to ≤ 65535, or `RangeError`).
  - Root scripts: `pnpm test:keyd`, `pnpm keyd` (builds `keyd/bin/keyd` and runs it with any extra
    flags).

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/keyd/client.test.ts`:
```ts
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeydClient, KeydError, KeydUnavailableError } from "./client.ts";
import { FAKE_SEAL_KEY, type FakeKeyd, startFakeKeyd } from "./testing/fake-keyd.ts";

const sealed = {
  v: 1 as const,
  epk: "BLhfkHvMwLU1VR2xt2QbapafF0HZL1U_EABDIa8GocmgFNZqvKrR0ZinBw_bbXXvp1tZIDoT8KptqEj3qt86wj0",
  nonce: "AAECAwQFBgcICQoL",
  ct: "wpSd7tLllnTJVPphF6Utcgorgp-jGSSn9dEwVhuXCcB6rJ_hpNaF",
};
const weather = {
  id: "weather",
  kind: "http" as const,
  hosts: ["api.example.test", "b.example.test"],
  header: "Authorization",
  format: "bearer" as const,
  methods: ["GET"],
  paths: ["/v1/a&b/"],
};

let keyd: FakeKeyd;
let client: KeydClient;
beforeEach(async () => {
  keyd = await startFakeKeyd();
  client = new KeydClient(keyd.socketPath, 2000);
});
afterEach(async () => {
  await keyd.close();
});

describe("KeydClient", () => {
  it("talks only to a socket private to this user, and says why it refuses", async () => {
    chmodSync(keyd.socketPath, 0o666);
    const open = client.status();
    await expect(open).rejects.toBeInstanceOf(KeydUnavailableError);
    await expect(open).rejects.toThrow(/open to other users \(mode 666\)/);
    chmodSync(keyd.socketPath, 0o600);
    chmodSync(dirname(keyd.socketPath), 0o755);
    await expect(client.secrets()).rejects.toThrow(/open to other users \(mode 755\)/);
    await expect(client.events(() => {}, new AbortController().signal)).rejects.toThrow(/refusing/);
    chmodSync(dirname(keyd.socketPath), 0o700);
    expect((await client.status()).bootId).toBe(keyd.bootId);
    expect(keyd.calls.filter((c) => c.path !== "/v1/status")).toEqual([]);
  });

  it("reads keyd's status", async () => {
    const status = await client.status();
    expect(status).toMatchObject({
      bootId: keyd.bootId,
      sealKey: FAKE_SEAL_KEY,
      audit: { ok: true },
    });
  });

  it("relays a sealed secret with the binding unchanged and the id in the path only", async () => {
    const record = await client.putSecret(weather, sealed);
    expect(record).toMatchObject({ id: "weather", kind: "http", hosts: weather.hosts });
    const call = keyd.calls.at(-1);
    expect(call?.method).toBe("PUT");
    expect(call?.path).toBe("/v1/secrets/weather");
    const { id: _id, ...fields } = weather;
    expect(call?.body).toEqual({ ...fields, sealed });
    expect((await client.secrets()).map((r) => r.id)).toEqual(["weather"]);
  });

  it("turns keyd's error body into a KeydError with its code", async () => {
    keyd.failures.set("PUT /v1/secrets/", { status: 400, code: "bad-seal" });
    const err = await client.putSecret(weather, sealed).catch((e) => e);
    expect(err).toBeInstanceOf(KeydError);
    expect(err).toMatchObject({ status: 400, code: "bad-seal" });
  });

  it("opens, reads, revokes, mints and closes a cell", async () => {
    await client.putSecret(weather, sealed);
    const opened = await client.openCell({
      cellId: "c1",
      role: "desktop",
      port: 4791,
      secrets: ["weather"],
    });
    expect(opened.proxyToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(opened.surrogates ?? {})).toEqual(["weather"]);
    expect((await client.cell("c1"))?.port).toBe(4791);
    expect(await client.revoke("c1")).toBe(1);
    const minted = await client.mint("c1", ["weather"]);
    expect(minted.weather).not.toBe(opened.surrogates?.weather);
    expect(await client.closeCell("c1")).toBe(true);
    expect(await client.closeCell("c1")).toBe(false);
    expect(await client.cell("c1")).toBeUndefined();
  });

  it("refuses a reply that is not what keyd promises", async () => {
    keyd.failures.set("GET /v1/status", { status: 200, code: "x" });
    await expect(client.status()).rejects.toMatchObject({ code: "bad-reply" });
  });

  it("reports an offline keyd as unavailable, not as a crash", async () => {
    await keyd.stop();
    await expect(client.status()).rejects.toBeInstanceOf(KeydUnavailableError);
    const missing = new KeydClient("/tmp/ld-no-such-dir/keyd/admin.sock", 500);
    await expect(missing.secrets()).rejects.toMatchObject({ status: 0, code: "unavailable" });
  });

  it("streams events, drops unknown lines and ends when keyd restarts", async () => {
    const got: string[] = [];
    const ac = new AbortController();
    const done = client.events((e) => got.push(e.type), ac.signal);
    await waitFor(() => keyd.subscribers === 1);
    keyd.publish({
      type: "key.use",
      cell: "c1",
      time: "2026-10-01T12:00:00Z",
      data: {
        secretId: "weather",
        host: "api.example.test",
        method: "GET",
        path: "/v1",
        decision: "allow",
      },
    });
    keyd.publish({ type: "key.leak" } as never);
    keyd.publish({ type: "events.dropped", time: "t", data: { count: 2 } });
    await waitFor(() => got.length === 2);
    keyd.restart();
    await done;
    expect(got).toEqual(["key.use", "events.dropped"]);
  });

  it("ends the stream when its signal aborts", async () => {
    const ac = new AbortController();
    const done = client.events(() => {}, ac.signal);
    await waitFor(() => keyd.subscribers === 1);
    ac.abort();
    await done;
    await waitFor(() => keyd.subscribers === 0);
  });
});

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
```

`apps/daemon/src/keyd/client.keyd.test.ts`:
```ts
import { request } from "node:http";
import { type KeydEvent, type SecretBinding, sealSecret } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeydClient } from "./client.ts";
import {
  KEYD_TESTS,
  type KeydProcess,
  startKeyd,
  TEST_KEYD_PORTS,
} from "./testing/keyd-process.ts";

const CANARY = `real-secret-value-for-test-${Date.now().toString(36)}`;
const weather: SecretBinding = {
  id: "weather",
  kind: "http",
  hosts: ["api.example.test"],
  header: "Authorization",
  format: "bearer",
};
const CELL = "01JXYZ0000000000000000ABCD";

let keyd: KeydProcess;
let client: KeydClient;

// A plain-HTTP request through a cell's listener, as a cell's tools send one.
function throughListener(port: number, token: string, headers: Record<string, string>) {
  return new Promise<{ status: number; reason: string | undefined }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "http://example.com/",
        headers: {
          host: "example.com",
          "proxy-authorization": `Basic ${Buffer.from(`cell:${token}`).toString("base64")}`,
          ...headers,
        },
      },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode ?? 0,
          reason: res.headers["x-keyd-reason"] as string | undefined,
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!KEYD_TESTS)("KeydClient against the real keyd", () => {
  beforeAll(async () => {
    keyd = await startKeyd();
    client = new KeydClient(keyd.socketPath);
  });
  afterAll(async () => {
    await keyd?.stop();
  });

  it("stores a key the browser sealed, and keyd refuses it under another binding", async () => {
    const status = await client.status();
    expect(status.bootId).toBe(keyd.bootId);
    const sealed = await sealSecret(status.sealKey, weather, CANARY);
    const tampered = { ...weather, hosts: ["api.example.test", "attacker.example"] };
    await expect(client.putSecret(tampered, sealed)).rejects.toMatchObject({
      status: 400,
      code: "bad-seal",
    });
    const record = await client.putSecret(weather, sealed);
    expect(record).toMatchObject({ id: "weather", kind: "http", hosts: ["api.example.test"] });
    const listed = await client.secrets();
    expect(listed.map((r) => r.id)).toEqual(["weather"]);
    expect(JSON.stringify(listed)).not.toContain(CANARY);
  });

  it("opens a desktop cell, alerts on a misplaced surrogate, revokes and closes", async () => {
    const events: KeydEvent[] = [];
    const ac = new AbortController();
    const stream = client.events((e) => events.push(e), ac.signal);
    const opened = await client.openCell({
      cellId: CELL,
      role: "desktop",
      port: TEST_KEYD_PORTS.from,
      secrets: ["weather"],
    });
    const surrogate = opened.surrogates?.weather ?? "";
    expect(surrogate).toMatch(/^ld_/);
    expect((await client.cell(CELL))?.intercepts).toEqual(["api.example.test"]);

    const misplaced = await throughListener(opened.port, opened.proxyToken, {
      "x-leak": surrogate,
    });
    expect(misplaced).toEqual({ status: 403, reason: "misplaced-surrogate" });
    const noToken = await throughListener(opened.port, "x".repeat(43), {});
    expect(noToken.status).toBe(407);

    await waitFor(() => events.some((e) => e.type === "key.use"));
    expect(events.find((e) => e.type === "key.use")).toMatchObject({
      cell: CELL,
      data: { secretId: "weather", host: "example.com", method: "GET", decision: "deny" },
    });
    expect(JSON.stringify(events)).not.toContain(surrogate);

    expect(await client.revoke(CELL)).toBe(1);
    const fresh = await client.mint(CELL, ["weather"]);
    expect(fresh.weather).toMatch(/^ld_/);
    expect(fresh.weather).not.toBe(surrogate);
    expect(await client.closeCell(CELL)).toBe(true);
    expect(await client.cell(CELL)).toBeUndefined();
    ac.abort();
    await stream;
  });

  it("forgets a deleted key", async () => {
    expect(await client.deleteSecret("weather")).toBe(true);
    expect(await client.deleteSecret("weather")).toBe(false);
    expect(await client.secrets()).toEqual([]);
  });
});

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
```

Append to `apps/daemon/src/cells/ports.test.ts` (and import `parsePortRange` next to
`allocateKeydPort`):
```ts
describe("keyd port ranges other than keyd's own", () => {
  it("allocates inside another range, such as a test keyd's", () => {
    expect(allocateKeydPort([4791], { from: 4791, to: 4797 })).toBe(4792);
    expect(() => allocateKeydPort([4791], { from: 4791, to: 4791 })).toThrow("4791-4791");
  });

  it("reads LOCALDOT_KEYD_PORTS and defaults to keyd's own range", () => {
    expect(parsePortRange(undefined)).toEqual(KEYD_PORT_RANGE);
    expect(parsePortRange("")).toEqual(KEYD_PORT_RANGE);
    expect(parsePortRange("4791-4797")).toEqual({ from: 4791, to: 4797 });
    for (const bad of ["4797-4791", "80-90", "4760", "4760-70000", " 4760-4789"]) {
      expect(() => parsePortRange(bad), bad).toThrow(RangeError);
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/daemon/src/keyd/client.test.ts apps/daemon/src/cells/ports.test.ts`
Expected: FAIL. `client.test.ts` cannot resolve `./client.ts`; `ports.test.ts` has no
`parsePortRange`.

- [ ] **Step 3: Write the code**

`apps/daemon/src/keyd/client.ts`:
```ts
import { lstatSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import {
  KeydCellInfo,
  KeydErrorBody,
  KeydEvent,
  KeydMinted,
  KeydOpened,
  KeydRecord,
  KeydRevoked,
  KeydSecrets,
  KeydStatus,
  type Sealed,
  type SecretBinding,
} from "@localdot/protocol";

export function keydSocketPath(home: string): string {
  return join(home, "keyd", "admin.sock");
}

export class KeydError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly path: string,
  ) {
    super(`keyd ${status || "unreachable"} ${code} on ${path}: ${detail}`);
    this.name = "KeydError";
  }
}

// keyd is not running, its socket is gone, or it did not answer in time: the key layer is offline.
export class KeydUnavailableError extends KeydError {
  constructor(detail: string, path: string) {
    super(0, "unavailable", detail, path);
    this.name = "KeydUnavailableError";
  }
}

// Whoever answers on this path receives sealed keys and hands the UI the key to seal them to, so
// the daemon talks only to a socket that this user owns and nobody else can reach: a socket of
// mode 0600 (no group or other bits) in a directory of this user with no group or other bits.
export function privateSocketProblem(socketPath: string): string | undefined {
  const uid = process.getuid?.();
  const check = (path: string, kind: "socket" | "directory") => {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st) return kind === "socket" ? undefined : `${path} does not exist`;
    if (kind === "socket" ? !st.isSocket() : !st.isDirectory()) return `${path} is not a ${kind}`;
    if (uid !== undefined && st.uid !== uid) return `${path} belongs to another user`;
    if (st.mode & 0o077)
      return `${path} is open to other users (mode ${(st.mode & 0o777).toString(8)})`;
    return undefined;
  };
  return check(dirname(socketPath), "directory") ?? check(socketPath, "socket");
}

export type CellRole = "brain" | "desktop" | "browser";

export interface OpenCellRequest {
  cellId: string;
  role: CellRole;
  port: number;
  secrets: string[];
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

interface Reply {
  status: number;
  text: string;
}

const segment = (value: string) => encodeURIComponent(value);

// HTTP/1.1 on keyd's 0600 admin socket (Part 4a, "Admin API"). Every reply is validated, and
// anything unexpected is an error, never a guess.
export class KeydClient {
  constructor(
    readonly socketPath: string,
    private readonly timeoutMs = 5000,
  ) {}

  status(): Promise<KeydStatus> {
    return this.#json("GET", "/v1/status", undefined, KeydStatus);
  }

  async secrets(): Promise<KeydRecord[]> {
    return (await this.#json("GET", "/v1/secrets", undefined, KeydSecrets)).secrets ?? [];
  }

  // The binding goes to keyd exactly as the UI sealed it: keyd rebuilds the AAD from these fields,
  // so the daemon must not change, add or drop a single value.
  putSecret(binding: SecretBinding, sealed: Sealed): Promise<KeydRecord> {
    const { id, ...fields } = binding;
    return this.#json("PUT", `/v1/secrets/${segment(id)}`, { ...fields, sealed }, KeydRecord);
  }

  async deleteSecret(id: string): Promise<boolean> {
    const path = `/v1/secrets/${segment(id)}`;
    const reply = await this.#send("DELETE", path);
    if (reply.status === 404) return false;
    this.#check(reply, path);
    return true;
  }

  openCell(req: OpenCellRequest): Promise<KeydOpened> {
    return this.#json("POST", "/v1/cells", req, KeydOpened);
  }

  async cell(id: string): Promise<KeydCellInfo | undefined> {
    const path = `/v1/cells/${segment(id)}`;
    const reply = await this.#send("GET", path);
    if (reply.status === 404) return undefined;
    return this.#parse(reply, path, KeydCellInfo);
  }

  async closeCell(id: string): Promise<boolean> {
    const path = `/v1/cells/${segment(id)}`;
    const reply = await this.#send("DELETE", path);
    if (reply.status === 404) return false;
    this.#check(reply, path);
    return true;
  }

  // The kill switch: the cell's surrogates, task, upstream connections and tunnels end at once.
  async revoke(id: string): Promise<number> {
    return (await this.#json("POST", `/v1/cells/${segment(id)}/revoke`, undefined, KeydRevoked))
      .revoked;
  }

  async mint(id: string, secrets: string[]): Promise<Record<string, string>> {
    const path = `/v1/cells/${segment(id)}/surrogates`;
    return (await this.#json("POST", path, { secrets }, KeydMinted)).surrogates ?? {};
  }

  // Resolves when the stream ends (keyd stopped, or the signal aborted it). A line that is not a
  // known event is dropped: the stream is best effort and keyd's audit log is the record.
  events(onEvent: (event: KeydEvent) => void, signal: AbortSignal): Promise<void> {
    const path = "/v1/events";
    const unsafe = privateSocketProblem(this.socketPath);
    if (unsafe) return Promise.reject(new KeydUnavailableError(`refusing ${unsafe}`, path));
    return new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { socketPath: this.socketPath, method: "GET", path, headers: { host: "keyd" } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(
              new KeydError(res.statusCode ?? 0, "events", "the event stream was refused", path),
            );
            return;
          }
          let buffered = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffered += chunk;
            for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
              const line = buffered.slice(0, nl).trim();
              buffered = buffered.slice(nl + 1);
              const parsed = KeydEvent.safeParse(safeJson(line));
              if (parsed.success) onEvent(parsed.data);
            }
          });
          res.on("end", () => resolve());
          res.on("error", () => resolve());
        },
      );
      const abort = () => req.destroy();
      signal.addEventListener("abort", abort, { once: true });
      req.on("close", () => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
      req.on("error", (err: NodeJS.ErrnoException) => {
        if (signal.aborted) resolve();
        else reject(new KeydUnavailableError(err.code ?? err.message, path));
      });
      req.end();
    });
  }

  async #json<T>(method: string, path: string, body: unknown, schema: Schema<T>): Promise<T> {
    return this.#parse(await this.#send(method, path, body), path, schema);
  }

  #parse<T>(reply: Reply, path: string, schema: Schema<T>): T {
    this.#check(reply, path);
    const parsed = schema.safeParse(safeJson(reply.text));
    if (!parsed.success) {
      throw new KeydError(reply.status, "bad-reply", "keyd answered something unexpected", path);
    }
    return parsed.data;
  }

  #check(reply: Reply, path: string): void {
    if (reply.status >= 200 && reply.status < 300) return;
    const body = KeydErrorBody.safeParse(safeJson(reply.text));
    const { code, message } = body.success
      ? body.data.error
      : { code: "internal", message: reply.text.slice(0, 200) };
    throw new KeydError(reply.status, code, message, path);
  }

  #send(method: string, path: string, body?: unknown): Promise<Reply> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const unsafe = privateSocketProblem(this.socketPath);
    if (unsafe) return Promise.reject(new KeydUnavailableError(`refusing ${unsafe}`, path));
    return new Promise<Reply>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: {
            host: "keyd",
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", (err) => reject(new KeydUnavailableError(err.message, path)));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      req.setTimeout(this.timeoutMs, () =>
        req.destroy(new Error(`no answer within ${this.timeoutMs} ms`)),
      );
      req.on("error", (err: NodeJS.ErrnoException) =>
        reject(new KeydUnavailableError(err.code ?? err.message, path)),
      );
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
```

`apps/daemon/src/keyd/testing/fake-keyd.ts`:
```ts
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { HairpinGuard, KeydEvent, KeydOpened, KeydRecord } from "@localdot/protocol";

// A stand-in for keyd's admin API on a temporary Unix socket, for unit tests: it keeps secrets'
// records (never values: a sealed body is only recorded), cells and an event stream, and can be
// told to fail. The real keyd is exercised by the *.keyd.test.ts and *.docker.test.ts suites.

export interface FakeCell {
  cellId: string;
  role: string;
  port: number;
  secrets: string[];
  // The newest surrogate of each key.
  surrogates: Record<string, string>;
  // Every surrogate keyd still accepts for the cell: minting adds one, only a revoke ends them.
  valid: Set<string>;
  revoked: number;
}

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const base62 = (n: number) => Array.from(randomBytes(n), (b) => BASE62[b % 62]).join("");

export function fakeSurrogate(): string {
  return `ld_key_${base62(22)}_${base62(6)}`;
}

export const FAKE_SEAL_KEY =
  "BG2x8-BG3l6OwZSDEY2jv15f49mKcudyq5wvNeAMGomjt95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM";
export const FAKE_CA_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBfakecellca\n-----END CERTIFICATE-----\n";

export class FakeKeyd {
  readonly calls: FakeCall[] = [];
  readonly records = new Map<string, KeydRecord>();
  readonly cells = new Map<string, FakeCell>();
  bootId = randomBytes(8).toString("hex");
  auditOk = true;
  hairpin: HairpinGuard = { state: "active", source: "nat-pmp", addresses: 1 };
  // Answers the next request whose "METHOD /path" starts with the key with this error.
  readonly failures = new Map<string, { status: number; code: string }>();
  readonly #streams = new Set<ServerResponse>();
  readonly #dir: string;
  readonly socketPath: string;
  #server: Server | undefined;

  constructor() {
    this.#dir = mkdtempSync("/tmp/ld-fake-keyd-");
    this.socketPath = join(this.#dir, "admin.sock");
  }

  async start(): Promise<this> {
    const server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => server.listen(this.socketPath, resolve));
    // As keyd does: the daemon talks only to a private socket.
    chmodSync(this.socketPath, 0o600);
    this.#server = server;
    return this;
  }

  publish(event: KeydEvent): void {
    for (const res of this.#streams) res.write(`${JSON.stringify(event)}\n`);
  }

  get subscribers(): number {
    return this.#streams.size;
  }

  // keyd restarted: a new boot, every cell gone, every event stream ended.
  restart(): void {
    this.bootId = randomBytes(8).toString("hex");
    this.cells.clear();
    for (const res of this.#streams) res.end();
    this.#streams.clear();
  }

  async stop(): Promise<void> {
    for (const res of this.#streams) res.end();
    this.#streams.clear();
    await new Promise<void>((resolve) =>
      this.#server ? this.#server.close(() => resolve()) : resolve(),
    );
    this.#server = undefined;
  }

  async close(): Promise<void> {
    await this.stop();
    rmSync(this.#dir, { recursive: true, force: true });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let text = "";
    for await (const chunk of req) text += chunk;
    const method = req.method ?? "";
    const path = new URL(req.url ?? "/", "http://keyd").pathname;
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    this.calls.push({ method, path, body });
    for (const [key, failure] of this.failures) {
      if (`${method} ${path}`.startsWith(key)) {
        this.failures.delete(key);
        reply(res, failure.status, {
          error: { code: failure.code, message: `fake ${failure.code}` },
        });
        return;
      }
    }
    this.#route(method, path, body, res);
  }

  #route(method: string, path: string, body: unknown, res: ServerResponse): boolean {
    if (method === "GET" && path === "/v1/status") {
      return reply(res, 200, {
        bootId: this.bootId,
        version: "0.1.0",
        sealKey: FAKE_SEAL_KEY,
        cells: this.cells.size,
        secrets: this.records.size,
        limits: { perTaskUSD: 5, perDayUSD: 20 },
        day: { date: "2026-10-01", spentUSD: 0 },
        audit: this.auditOk ? { ok: true } : { ok: false, error: "disk full" },
        hairpin: this.hairpin,
      });
    }
    if (method === "GET" && path === "/v1/secrets")
      return reply(res, 200, { secrets: [...this.records.values()] });
    if (method === "GET" && path === "/v1/events") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.flushHeaders();
      this.#streams.add(res);
      res.on("close", () => this.#streams.delete(res));
      return true;
    }
    const secret = /^\/v1\/secrets\/([^/]+)$/.exec(path);
    if (secret) {
      const id = decodeURIComponent(secret[1] ?? "");
      if (method === "DELETE") {
        if (!this.records.delete(id))
          return reply(res, 404, { error: { code: "not-found", message: "no such secret" } });
        return reply(res, 204);
      }
      if (method === "PUT") {
        const { sealed: _sealed, ...fields } = body as Record<string, unknown>;
        const now = new Date().toISOString();
        const record = {
          id,
          ...fields,
          createdAt: this.records.get(id)?.createdAt ?? now,
          updatedAt: now,
        } as KeydRecord;
        this.records.set(id, record);
        return reply(res, 200, record);
      }
    }
    if (method === "POST" && path === "/v1/cells") {
      const req = body as { cellId: string; role: string; port: number; secrets: string[] };
      if (this.cells.has(req.cellId))
        return reply(res, 409, { error: { code: "conflict", message: "cell is open" } });
      const unknown = req.secrets.find((id) => !this.records.has(id));
      if (unknown)
        return reply(res, 400, {
          error: { code: "bad-request", message: `unknown secret ${unknown}` },
        });
      const surrogates = Object.fromEntries(req.secrets.map((id) => [id, fakeSurrogate()]));
      this.cells.set(req.cellId, {
        ...req,
        surrogates,
        valid: new Set(Object.values(surrogates)),
        revoked: 0,
      });
      const opened: KeydOpened = {
        cellId: req.cellId,
        port: req.port,
        proxyToken: randomBytes(32).toString("base64url"),
        caCertPem: FAKE_CA_PEM,
        caPath: `/tmp/keyd/cells/${req.cellId}/ca.pem`,
        surrogates,
      };
      return reply(res, 201, opened);
    }
    const cell = /^\/v1\/cells\/([^/]+)(\/revoke|\/surrogates)?$/.exec(path);
    if (cell) {
      const id = decodeURIComponent(cell[1] ?? "");
      const found = this.cells.get(id);
      if (!found) return reply(res, 404, { error: { code: "not-found", message: "no such cell" } });
      if (method === "GET" && !cell[2]) {
        return reply(res, 200, {
          cellId: id,
          role: found.role,
          port: found.port,
          intercepts: [],
          surrogates: Object.keys(found.surrogates).map((secretId) => ({
            secretId,
            surrogateId: "0123456789ab",
          })),
        });
      }
      if (method === "DELETE" && !cell[2]) {
        this.cells.delete(id);
        return reply(res, 204);
      }
      if (method === "POST" && cell[2] === "/revoke") {
        const revoked = found.valid.size;
        found.surrogates = {};
        found.valid.clear();
        found.revoked += 1;
        return reply(res, 200, { revoked });
      }
      if (method === "POST" && cell[2] === "/surrogates") {
        const { secrets } = body as { secrets: string[] };
        const minted = Object.fromEntries(secrets.map((s) => [s, fakeSurrogate()]));
        found.surrogates = { ...found.surrogates, ...minted };
        for (const value of Object.values(minted)) found.valid.add(value);
        return reply(res, 200, { surrogates: minted });
      }
    }
    return reply(res, 404, {
      error: { code: "not-found", message: `fake keyd: no route ${method} ${path}` },
    });
  }
}

function reply(res: ServerResponse, status: number, body?: unknown): true {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return true;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
  return true;
}

export async function startFakeKeyd(): Promise<FakeKeyd> {
  return new FakeKeyd().start();
}
```

`apps/daemon/src/keyd/testing/keyd-process.ts`:
```ts
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePortRange } from "../../cells/ports.ts";
import { keydSocketPath } from "../client.ts";

export const KEYD_TESTS = process.env.LOCALDOT_KEYD_TESTS === "1";
// Test keyds listen in the spikes/e2e block, clear of the e2e daemon (4790) and the driver
// opt-out proxy (4798), so they never collide with a real keyd on 4760-4789.
// LOCALDOT_TEST_KEYD_PORTS moves them when two checkouts test on one Mac.
export const TEST_KEYD_PORTS = parsePortRange(process.env.LOCALDOT_TEST_KEYD_PORTS || "4791-4797");
const KEYD_DIR = fileURLToPath(new URL("../../../../../keyd/", import.meta.url));
// macOS limits a Unix socket path to 103 bytes.
const MAX_SOCKET_PATH = 103;

let built: string | undefined;

// keyd from this checkout. The keyd and Docker test configs build it once per run (keyd-build.ts)
// and remove it afterwards; outside them it is built once per test process.
export function keydBinary(): string {
  if (process.env.LOCALDOT_KEYD_BIN) return process.env.LOCALDOT_KEYD_BIN;
  if (built) return built;
  const dir = mkdtempSync(join(tmpdir(), "localdot-keyd-bin-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "keyd");
  execFileSync(process.env.GO ?? "go", ["build", "-o", out, "./cmd/keyd"], {
    cwd: KEYD_DIR,
    stdio: ["ignore", "ignore", "inherit"],
  });
  built = out;
  return out;
}

export interface KeydProcess {
  home: string;
  socketPath: string;
  bootId: string;
  stderr(): string;
  stop(): Promise<void>;
}

export interface StartKeydOptions {
  home?: string;
  ports?: { from: number; to: number };
}

// A real keyd with an in-memory vault, as Part 4a's README runs one: it prints one ready line on
// stderr, and SIGTERM closes every cell and removes the socket.
export async function startKeyd(opts: StartKeydOptions = {}): Promise<KeydProcess> {
  const ownHome = opts.home === undefined;
  const home = opts.home ?? mkdtempSync("/tmp/ld-keyd-");
  const socketPath = keydSocketPath(home);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    throw new Error(`keyd's socket path is too long for macOS (${socketPath})`);
  }
  const ports = opts.ports ?? TEST_KEYD_PORTS;
  const child: ChildProcess = spawn(
    keydBinary(),
    [
      "-home",
      home,
      "-vault",
      "memory",
      "-ports",
      `${ports.from}-${ports.to}`,
      // Tests ask neither the router nor STUN for the public address: nothing leaves the Mac.
      "-natpmp",
      "off",
      "-stun",
      "off",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  // A test process that dies takes its keyd with it.
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);
  const bootId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`keyd did not get ready within 15 s:\n${stderr}`));
    }, 15_000);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      const ready = /^keyd ready socket=(.+) boot=([0-9a-f]{16})$/m.exec(stderr);
      if (ready?.[2]) {
        clearTimeout(timer);
        resolve(ready[2]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`keyd exited with ${code} before it was ready:\n${stderr}`));
    });
  });
  const stop = async () => {
    process.removeListener("exit", killOnExit);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    }
    if (ownHome) rmSync(home, { recursive: true, force: true });
  };
  return { home, socketPath, bootId, stderr: () => stderr, stop };
}
```

`apps/daemon/src/keyd/testing/keyd-build.ts`:
```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Vitest's global setup for the suites that run the real keyd: built once per run into a
// temporary folder that the teardown removes; the suites find it through LOCALDOT_KEYD_BIN.
let dir: string | undefined;

export function setup(): void {
  const wanted =
    process.env.LOCALDOT_KEYD_TESTS === "1" || process.env.LOCALDOT_DOCKER_TESTS === "1";
  if (!wanted || process.env.LOCALDOT_KEYD_BIN) return;
  dir = mkdtempSync(join(tmpdir(), "localdot-keyd-bin-"));
  const bin = join(dir, "keyd");
  execFileSync(process.env.GO ?? "go", ["build", "-o", bin, "./cmd/keyd"], {
    cwd: fileURLToPath(new URL("../../../../../keyd/", import.meta.url)),
    stdio: ["ignore", "ignore", "inherit"],
  });
  process.env.LOCALDOT_KEYD_BIN = bin;
}

export function teardown(): void {
  if (!dir) return;
  rmSync(dir, { recursive: true, force: true });
  dir = undefined;
}
```

`apps/daemon/src/cells/ports.ts` (replace the file):
```ts
export const KEYD_PORT_RANGE = { from: 4760, to: 4789 } as const;

export interface PortRange {
  from: number;
  to: number;
}

// Each cell gets its own keyd listener port; the gate relays to it and keyd knows the cell by it.
export function allocateKeydPort(
  inUse: Iterable<number>,
  range: PortRange = KEYD_PORT_RANGE,
): number {
  const used = new Set(inUse);
  for (let port = range.from; port <= range.to; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(`no free keyd listener port in ${range.from}-${range.to}`);
}

// LOCALDOT_KEYD_PORTS ("4791-4797"): test harnesses run their own keyd outside the real range, and
// keyd's -ports must say the same.
export function parsePortRange(text: string | undefined): PortRange {
  if (text === undefined || text === "") return KEYD_PORT_RANGE;
  const m = /^(\d{4,5})-(\d{4,5})$/.exec(text);
  const from = Number(m?.[1]);
  const to = Number(m?.[2]);
  if (!m || from < 1024 || to > 65535 || from > to) {
    throw new RangeError(`not a port range: ${JSON.stringify(text)} (want e.g. 4760-4789)`);
  }
  return { from, to };
}
```

`vitest.keyd.config.ts`:
```ts
import { defineConfig } from "vitest/config";

// Suites that run the real keyd built from keyd/: opt in with LOCALDOT_KEYD_TESTS=1 pnpm test:keyd.
export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.keyd.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    // keyd is built once per run, and the build is removed afterwards.
    globalSetup: ["apps/daemon/src/keyd/testing/keyd-build.ts"],
  },
});
```

In `vitest.docker.config.ts` (the Docker suites start keyd too), add the same line after
`fileParallelism: false,`:
```ts
    // keyd is built once per run, and the build is removed afterwards.
    globalSetup: ["apps/daemon/src/keyd/testing/keyd-build.ts"],
```
In `vitest.config.ts`, exclude the keyd-backed suites from `pnpm test`:
```ts
    exclude: ["**/node_modules/**", "**/*.docker.test.ts", "**/*.keyd.test.ts"],
```
In the root `package.json` `scripts`, add:
```json
    "test:keyd": "vitest run --config vitest.keyd.config.ts",
    "keyd": "cd keyd && go build -o bin/keyd ./cmd/keyd && exec ./bin/keyd"
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/daemon/src/keyd/client.test.ts apps/daemon/src/cells/ports.test.ts`
Expected: PASS. `client.test.ts` has 9 tests and `ports.test.ts` 6 (its 4 existing ones plus 2).

Run: `LOCALDOT_KEYD_TESTS=1 pnpm test:keyd apps/daemon/src/keyd/client.keyd.test.ts`
Expected: PASS, 3 tests. The global setup builds keyd first (a few seconds); `go` must be Go
1.27.1, or set `GO`/`LOCALDOT_KEYD_BIN`. Afterwards no `ld-keyd-*` folder is left in `/tmp`, no
`localdot-keyd-bin-*` folder in `$TMPDIR`, and no `keyd` process
(`pgrep -f 'keyd -home /tmp/ld-keyd'` prints nothing).

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add apps/daemon/src/keyd apps/daemon/src/cells/ports.ts apps/daemon/src/cells/ports.test.ts vitest.keyd.config.ts vitest.docker.config.ts vitest.config.ts package.json
git commit -m "feat(daemon): keyd admin-socket client that talks only to a private socket"
```

---

### Task 4: Key routes that relay sealed keys, and keyd's health

The key form's API sits behind the install token like every `/api/*` route. It has four routes:

| Route | What it does |
|---|---|
| `GET /api/keyd` | keyd's health: online, boot id, seal key, audit state and hairpin guard, for the form and the top bar. |
| `GET /api/keys` | keyd's records, which never hold a value. |
| `POST /api/keys` | Accepts exactly `{ binding, sealed }` (strict, at most 64 KiB through Hono's `bodyLimit`, as Part 2's cell API does), relays it to keyd without changing a byte and answers `{ key, restart }`. |
| `DELETE /api/keys/:id` | Deletes a key. A key is replaced by posting it again under the same name. |

A body with a `value` field, any other extra field or a loose shape never reaches keyd.

**Errors.** keyd's refusals become answers the form can act on: `409 bad-seal` means "seal again"
(keyd restarted); `400` with keyd's own message means a bad binding; `502 vault`; `503
key-layer-offline`. The daemon adds two of its own: `413 too-large`, and `409 name-taken` for a name
whose `LOCALDOT_KEY_` variable a stored key already has (`a-b` and `a_b`), since one stand-in would
shadow the other in the computer's shells (review M2).

**After a change.** `afterChange` (wired in Task 11) hands running computers their new surrogates
after a key changes. Its `restart` says whether a running computer can only use the saved key after
it starts again.

**The monitor.** `KeydMonitor` polls `/v1/status`. It tells subscribers when keyd comes up, goes
away, restarts with a new boot or flips its audit state. Its health carries the hairpin guard, and
a keyd that does not report one reads as `unknown`, never as `active`.

**The doctor** (P4b-C2). Part 2's `doctor` gains two checks after its port check: `keyd` (it
answers, and its audit log works) and `hairpin-guard` (`active`, or why not: `unknown` with keyd's
reason, or `off`). Either one failing fails the doctor. Its CLI test runs on a home with no keyd,
so it never asks the user's own. keyd's `audit-rotated` alert (Part 4a) stays M9's doctor's.

**Files:**
- Create: `apps/daemon/src/keyd/routes.ts`, `apps/daemon/src/keyd/monitor.ts`,
  `apps/daemon/src/keyd/routes.test.ts`, `apps/daemon/src/keyd/routes.keyd.test.ts`
- Modify: `apps/daemon/src/app.ts`; Part 2's `apps/daemon/src/doctor.ts`, `doctor.test.ts`,
  `doctor-main.ts`, `doctor-main.test.ts`

**Interfaces:**
- Consumes: `KeydClient` and `keydSocketPath` (Task 3); `SealedSecret`, `SecretId`,
  `surrogateEnvClash`, `surrogateEnvName`, `HairpinGuard` and `KeydStatus` (Task 2); `createApp`'s
  token middleware, Hono's `bodyLimit`, and `runDoctor`, `DoctorDeps`, `skipped` and `localdotHome`
  (Part 2).
- Produces:
  - `KeyRoutesDeps { keyd: KeydClient; monitor: KeydMonitor; afterChange?: (secretId) => Promise<{ restart: boolean }> }`;
  - `keyRoutes(app, deps)`;
  - `AppOptions.keys?: KeyRoutesDeps`;
  - `KeydHealth { online; bootId?; sealKey?; audit?: { ok; error? }; hairpin?: HairpinGuard; error? }`;
  - `KeydMonitor(client, everyMs = 2000)` with `health`, `refresh()`,
    `subscribe((now, before) => void)`, `start()` and `stop()`;
  - `cameUp(now, before)`;
  - the refusal body `{ error: string; message: string }`, with the daemon's own codes `too-large`
    and `name-taken`;
  - `DoctorDeps.keyd?: Pick<KeydClient, "status">`, and the doctor's checks `keyd` and
    `hairpin-guard`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/keyd/routes.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { KeydClient } from "./client.ts";
import { KeydMonitor } from "./monitor.ts";
import { FAKE_SEAL_KEY, type FakeKeyd, startFakeKeyd } from "./testing/fake-keyd.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
const json = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const sealed = {
  v: 1,
  epk: "BLhfkHvMwLU1VR2xt2QbapafF0HZL1U_EABDIa8GocmgFNZqvKrR0ZinBw_bbXXvp1tZIDoT8KptqEj3qt86wj0",
  nonce: "AAECAwQFBgcICQoL",
  ct: "wpSd7tLllnTJVPphF6Utcgorgp-jGSSn9dEwVhuXCcB6rJ_hpNaF",
};
const binding = {
  id: "weather",
  kind: "http",
  hosts: ["api.example.test", "b.example.test"],
  header: "Authorization",
  format: "bearer",
  methods: ["GET"],
  paths: ["/v1/a&b/"],
};

let keyd: FakeKeyd;
let app: ReturnType<typeof createApp>;
let changed: string[];
beforeEach(async () => {
  keyd = await startFakeKeyd();
  changed = [];
  const client = new KeydClient(keyd.socketPath, 1000);
  const eventLog = new EventLog(mkdtempSync(join(tmpdir(), "local dot's keys-")));
  const afterChange = async (id: string) => {
    changed.push(id);
    return { restart: id === "weather" };
  };
  app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog,
    keys: { keyd: client, monitor: new KeydMonitor(client), afterChange },
  });
});
afterEach(async () => {
  await keyd.close();
});

const post = (body: unknown) =>
  app.request(url("/api/keys"), { method: "POST", headers: json, body: JSON.stringify(body) });

describe("key routes", () => {
  it("need the install token", async () => {
    expect((await app.request(url("/api/keyd"))).status).toBe(401);
    expect((await app.request(url("/api/keys"), { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("report keyd's health with its seal key, audit state and hairpin guard", async () => {
    keyd.auditOk = false;
    const res = await app.request(url("/api/keyd"), { headers: json });
    expect(await res.json()).toEqual({
      online: true,
      bootId: keyd.bootId,
      sealKey: FAKE_SEAL_KEY,
      audit: { ok: false, error: "disk full" },
      hairpin: { state: "active", source: "nat-pmp", addresses: 1 },
    });
    keyd.hairpin = { state: "unknown", addresses: 0, error: "nat-pmp: timeout" };
    const unknown = await app.request(url("/api/keyd"), { headers: json });
    expect(((await unknown.json()) as { hairpin: unknown }).hairpin).toEqual(keyd.hairpin);
  });

  it("relay a sealed key to keyd byte for byte, the id in the path", async () => {
    const res = await post({ binding, sealed });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: { id: "weather", kind: "http" }, restart: true });
    expect(changed).toEqual(["weather"]);
    const call = keyd.calls.find((c) => c.method === "PUT");
    const { id: _id, ...fields } = binding;
    expect(call?.path).toBe("/v1/secrets/weather");
    expect(call?.body).toEqual({ ...fields, sealed });
    const list = await app.request(url("/api/keys"), { headers: json });
    expect(((await list.json()) as { keys: { id: string }[] }).keys.map((k) => k.id)).toEqual([
      "weather",
    ]);
  });

  it("refuse plaintext: a value field, or anything but a sealed key, never reaches keyd", async () => {
    for (const body of [
      { binding, sealed, value: "real-secret-value-for-test" },
      { binding: { ...binding, value: "real-secret-value-for-test" }, sealed },
      { binding, value: "real-secret-value-for-test" },
      { binding, sealed: { ...sealed, plain: "real-secret-value-for-test" } },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(
      (await app.request(url("/api/keys"), { method: "POST", headers: json, body: "not json" }))
        .status,
    ).toBe(400);
    expect(
      (
        await app.request(url("/api/keys"), {
          method: "POST",
          headers: json,
          body: "x".repeat(70_000),
        })
      ).status,
    ).toBe(413);
    expect(keyd.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("map keyd's refusals to what the form can act on", async () => {
    keyd.failures.set("PUT /v1/secrets/", { status: 400, code: "bad-seal" });
    expect((await post({ binding, sealed })).status).toBe(409);
    keyd.failures.set("PUT /v1/secrets/", { status: 400, code: "bad-binding" });
    const bad = await post({ binding, sealed });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "bad-binding" });
    keyd.failures.set("PUT /v1/secrets/", { status: 500, code: "vault" });
    expect((await post({ binding, sealed })).status).toBe(502);
  });

  it("refuse a name whose variable another key's stand-in already has", async () => {
    keyd.records.set("weather_api", {
      id: "weather_api",
      kind: "http",
      createdAt: "t",
      updatedAt: "t",
    });
    const res = await post({ binding: { ...binding, id: "weather-api" }, sealed });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "name-taken",
      message: expect.stringContaining("LOCALDOT_KEY_WEATHER_API"),
    });
    expect(keyd.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("delete a key by a valid name only", async () => {
    await post({ binding, sealed });
    expect(
      (await app.request(url("/api/keys/weather"), { method: "DELETE", headers: json })).status,
    ).toBe(204);
    expect(changed).toEqual(["weather", "weather"]);
    expect(
      (await app.request(url("/api/keys/weather"), { method: "DELETE", headers: json })).status,
    ).toBe(404);
    expect(changed).toHaveLength(2);
    expect(
      (await app.request(url("/api/keys/..%2Fx"), { method: "DELETE", headers: json })).status,
    ).toBe(400);
  });

  it("say the key layer is offline when keyd is not running", async () => {
    await keyd.stop();
    const res = await app.request(url("/api/keys"), { headers: json });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "key-layer-offline" });
    expect(await (await app.request(url("/api/keyd"), { headers: json })).json()).toMatchObject({
      online: false,
    });
  });
});

describe("KeydMonitor", () => {
  it("tells listeners when keyd goes away and comes back with a new boot", async () => {
    const client = new KeydClient(keyd.socketPath, 500);
    const monitor = new KeydMonitor(client);
    const seen: string[] = [];
    monitor.subscribe((now, before) =>
      seen.push(`${before.online}->${now.online}:${now.bootId ?? "-"}`),
    );
    const first = keyd.bootId;
    await monitor.refresh();
    await keyd.stop();
    await monitor.refresh();
    keyd.restart();
    await keyd.start();
    await monitor.refresh();
    await monitor.refresh();
    expect(seen).toEqual([`false->true:${first}`, "true->false:-", `false->true:${keyd.bootId}`]);
    expect(keyd.bootId).not.toBe(first);
  });
});
```

`apps/daemon/src/keyd/routes.keyd.test.ts`:
```ts
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SecretBinding, sealSecret } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { KeydClient } from "./client.ts";
import { KeydMonitor } from "./monitor.ts";
import { KEYD_TESTS, type KeydProcess, startKeyd } from "./testing/keyd-process.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
const json = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const CANARY = `real-secret-value-for-test-${Date.now().toString(36)}`;
const groq: SecretBinding = {
  id: "groq",
  kind: "llm",
  provider: "openai-compatible",
  baseURL: new URL("https://api.groq.com/openai/v1").href,
};

let keyd: KeydProcess;
let keydHome: string;
let home: string;
let app: ReturnType<typeof createApp>;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

describe.skipIf(!KEYD_TESTS)("the key form's routes against the real keyd", () => {
  beforeAll(async () => {
    keydHome = mkdtempSync("/tmp/ld-keyd-");
    keyd = await startKeyd({ home: keydHome });
    const client = new KeydClient(keyd.socketPath);
    home = mkdtempSync(join(tmpdir(), "local dot's keys-"));
    app = createApp({
      token: TOKEN,
      port: PORT,
      eventLog: new EventLog(home),
      keys: { keyd: client, monitor: new KeydMonitor(client) },
    });
  });
  afterAll(async () => {
    await keyd?.stop();
    rmSync(keydHome, { recursive: true, force: true });
  });

  it("stores a key sealed to keyd's boot key, which only keyd can open", async () => {
    const health = (await (await app.request(url("/api/keyd"), { headers: json })).json()) as {
      sealKey: string;
    };
    const sealed = await sealSecret(health.sealKey, groq, CANARY);
    const moved = await app.request(url("/api/keys"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        binding: { ...groq, baseURL: "https://attacker.example/v1" },
        sealed,
      }),
    });
    expect(moved.status).toBe(409);
    const stored = await app.request(url("/api/keys"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ binding: groq, sealed }),
    });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({
      key: { id: "groq", kind: "llm", provider: "openai-compatible" },
      restart: false,
    });
    const keys = (await (await app.request(url("/api/keys"), { headers: json })).json()) as {
      keys: unknown[];
    };
    expect(JSON.stringify(keys)).not.toContain(CANARY);
    for (const file of filesUnder(home))
      expect(readFileSync(file, "latin1"), file).not.toContain(CANARY);
  });

  it("refuses a seal made for an earlier keyd", async () => {
    const health = (await (await app.request(url("/api/keyd"), { headers: json })).json()) as {
      sealKey: string;
    };
    const sealed = await sealSecret(health.sealKey, groq, CANARY);
    await keyd.stop();
    keyd = await startKeyd({ home: keydHome });
    const res = await app.request(url("/api/keys"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ binding: groq, sealed }),
    });
    expect(res.status).toBe(409);
  });
});
```

Append to Part 2's `apps/daemon/src/doctor.test.ts` (its `fake`, `images`, `byName` and `freePort`
are the file's own), importing `KeydClient` from `./keyd/client.ts` and `type FakeKeyd, startFakeKeyd`
from `./keyd/testing/fake-keyd.ts`:
```ts
describe("runDoctor's key layer checks", () => {
  let keyd: FakeKeyd | undefined;
  afterEach(async () => {
    await keyd?.close();
    keyd = undefined;
  });

  const keydChecks = async () => {
    fake = await startFakeDocker();
    const report = await runDoctor({
      docker: new DockerClient(fake.socketPath),
      images,
      port: await freePort(),
      keyd: new KeydClient(keyd?.socketPath ?? "/tmp/ld-no-keyd/admin.sock", 500),
    });
    return { report, checks: byName(report) };
  };

  it("passes while keyd answers and its hairpin guard knows the public address", async () => {
    keyd = await startFakeKeyd();
    const { report, checks } = await keydChecks();
    expect(report.ok).toBe(true);
    expect(checks.keyd?.detail).toContain(`boot ${keyd.bootId}`);
    expect(checks["hairpin-guard"]).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^active/),
    });
  });

  it("fails while the hairpin guard is unknown or off, and says why", async () => {
    keyd = await startFakeKeyd();
    keyd.hairpin = { state: "unknown", addresses: 0, error: "nat-pmp 192.168.1.1: timeout" };
    const unknown = (await keydChecks()).checks["hairpin-guard"];
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown?.detail).toMatch(
      /^unknown: .*asks again every 30 s: nat-pmp 192\.168\.1\.1: timeout$/,
    );
    await fake?.close();
    keyd.hairpin = { state: "off", addresses: 0 };
    expect((await keydChecks()).checks["hairpin-guard"]?.detail).toMatch(/^off: /);
  });

  it("says to start keyd when it does not answer", async () => {
    const { report, checks } = await keydChecks();
    expect(report.ok).toBe(false);
    expect(checks.keyd).toMatchObject({ ok: false, detail: expect.stringContaining("start keyd") });
    expect(checks["hairpin-guard"]).toMatchObject({ ok: false, detail: "skipped" });
  });
});
```

In Part 2's `apps/daemon/src/doctor-main.test.ts`, add to the spawned doctor's `env`, after
`LOCALDOT_PORT`:
```ts
        // The doctor asks keyd too: never the keyd of the user's own home.
        LOCALDOT_HOME: "/tmp/ld-doctor-test-no-home",
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/daemon/src/keyd/routes.test.ts apps/daemon/src/doctor.test.ts`
Expected: FAIL. `routes.test.ts` cannot resolve `./monitor.ts`, and `createApp` takes no `keys`;
`doctor.test.ts`'s three new tests find no `keyd` or `hairpin-guard` check.

- [ ] **Step 3: Write the code**

`apps/daemon/src/keyd/monitor.ts`:
```ts
import type { HairpinGuard } from "@localdot/protocol";
import type { KeydClient } from "./client.ts";

export interface KeydHealth {
  online: boolean;
  bootId?: string;
  sealKey?: string;
  // keyd swaps no secret while its audit log cannot be written (Part 4a, P4a-R17).
  audit?: { ok: boolean; error?: string };
  // Whether keyd knows the public address it denies (hairpin NAT); a keyd that does not say is
  // reported as unknown, never as active.
  hairpin?: HairpinGuard;
  error?: string;
}

export type KeydHealthListener = (now: KeydHealth, before: KeydHealth) => void;

const OFFLINE: KeydHealth = { online: false, error: "not checked yet" };

// Watches keyd's status so the UI can say "Key layer offline" and the daemon can rewire its
// cells when keyd comes back with a new boot (every cell's listener, CA and surrogates are gone).
export class KeydMonitor {
  #health: KeydHealth = OFFLINE;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  readonly #listeners = new Set<KeydHealthListener>();

  constructor(
    private readonly client: KeydClient,
    private readonly everyMs = 2000,
  ) {}

  get health(): KeydHealth {
    return this.#health;
  }

  async refresh(): Promise<KeydHealth> {
    let next: KeydHealth;
    try {
      const s = await this.client.status();
      next = {
        online: true,
        bootId: s.bootId,
        sealKey: s.sealKey,
        audit: s.audit,
        hairpin: s.hairpin ?? { state: "unknown", addresses: 0 },
      };
    } catch (err) {
      next = { online: false, error: err instanceof Error ? err.message : String(err) };
    }
    const before = this.#health;
    this.#health = next;
    if (
      next.online !== before.online ||
      next.bootId !== before.bootId ||
      next.audit?.ok !== before.audit?.ok
    ) {
      for (const listener of this.#listeners) {
        try {
          listener(next, before);
        } catch (err) {
          console.error(`keyd health listener failed: ${String(err)}`);
        }
      }
    }
    return next;
  }

  subscribe(listener: KeydHealthListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = async () => {
      await this.refresh();
      if (!this.#running) return;
      this.#timer = setTimeout(tick, this.everyMs);
      this.#timer.unref();
    };
    void tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

// keyd appeared, or came back as a new process: either way its cells must be checked.
export function cameUp(now: KeydHealth, before: KeydHealth): boolean {
  return now.online && (!before.online || now.bootId !== before.bootId);
}
```

`apps/daemon/src/keyd/routes.ts`:
```ts
import { SealedSecret, SecretId, surrogateEnvClash, surrogateEnvName } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type KeydClient, KeydError, KeydUnavailableError } from "./client.ts";
import type { KeydMonitor } from "./monitor.ts";

export interface KeyRoutesDeps {
  keyd: KeydClient;
  monitor: KeydMonitor;
  // Hands running computers their new surrogates once a key is saved or deleted.
  afterChange?: (secretId: string) => Promise<{ restart: boolean }>;
}

// A sealed v1 blob of the largest value keyd takes is about 11 KB; nothing a browser sends here
// is legitimately bigger.
const MAX_BODY = 64 * 1024;

// The key form's API. The browser seals each key to keyd's per-boot key before it leaves the page,
// so these routes carry only a binding and ciphertext: a body with any other field (a plaintext
// "value" above all) is refused, and the daemon relays the rest to keyd without changing a byte.
export function keyRoutes(app: Hono, { keyd, monitor, afterChange }: KeyRoutesDeps): void {
  app.get("/api/keyd", async (c) => c.json(await monitor.refresh()));

  app.get("/api/keys", (c) => withKeyd(c, async () => c.json({ keys: await keyd.secrets() })));

  const limit = bodyLimit({
    maxSize: MAX_BODY,
    onError: (c) => refuse(c, 413, "too-large", "the request is too large"),
  });

  app.post("/api/keys", limit, async (c) => {
    const text = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return refuse(c, 400, "bad-request", "the body is not JSON");
    }
    const parsed = SealedSecret.safeParse(body);
    if (!parsed.success) {
      return refuse(
        c,
        400,
        "bad-request",
        "send a sealed key: { binding, sealed } and nothing else",
      );
    }
    const { binding, sealed } = parsed.data;
    return withKeyd(c, async () => {
      const clash = surrogateEnvClash(
        binding.id,
        (await keyd.secrets()).map((r) => r.id),
      );
      if (clash) {
        const message = `${binding.id} and ${clash} would share ${surrogateEnvName(binding.id)} in your computer: pick another name`;
        return refuse(c, 409, "name-taken", message);
      }
      const key = await keyd.putSecret(binding, sealed);
      const { restart } = (await afterChange?.(key.id)) ?? { restart: false };
      return c.json({ key, restart });
    });
  });

  app.delete("/api/keys/:id", async (c) => {
    const id = SecretId.safeParse(c.req.param("id"));
    if (!id.success) return refuse(c, 400, "bad-request", "not a key name");
    return withKeyd(c, async () => {
      if (!(await keyd.deleteSecret(id.data))) return refuse(c, 404, "not-found", "no such key");
      await afterChange?.(id.data);
      return c.body(null, 204);
    });
  });
}

async function withKeyd(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof KeydUnavailableError) {
      return refuse(c, 503, "key-layer-offline", "the key layer is offline: start keyd");
    }
    if (err instanceof KeydError) {
      // bad-seal: keyd restarted with a new seal key, or the binding changed after sealing; the UI
      // fetches /api/keyd again and seals once more.
      if (err.code === "bad-seal") return refuse(c, 409, "bad-seal", "seal the key again");
      if (err.code === "vault") return refuse(c, 502, "vault", "keyd could not store the key");
      if (err.status === 404) return refuse(c, 404, "not-found", "no such key");
      if (err.status >= 400 && err.status < 500) return refuse(c, 400, err.code, err.detail);
      return refuse(c, 502, err.code, "keyd failed");
    }
    throw err;
  }
}

function refuse(
  c: Context,
  status: 400 | 404 | 409 | 413 | 502 | 503,
  error: string,
  message: string,
): Response {
  return c.json({ error, message }, status);
}
```

In `apps/daemon/src/app.ts`, import the routes, add the option and register them after the cell
routes, inside the token-guarded `/api/*` space (keep every option Parts 2 and 3 added):
```ts
import { type KeyRoutesDeps, keyRoutes } from "./keyd/routes.ts";

export interface AppOptions {
  // …the existing options…
  keys?: KeyRoutesDeps;
}

// in createApp's parameter list add `keys`, and right after `if (cells) cellRoutes(app, cells);`:
  if (keys) keyRoutes(app, keys);
```

In `apps/daemon/src/doctor.ts`, import `type { HairpinGuard, KeydStatus }` from
`@localdot/protocol` and `type { KeydClient }` from `./keyd/client.ts`, add to `DoctorDeps`
```ts
  // keyd's admin client: whether keyd answers, and whether its hairpin guard is active.
  keyd?: Pick<KeydClient, "status">;
```
and replace `runDoctor` with these three functions:
```ts
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks = [
    ...(await dockerChecks(deps)),
    await portCheck(deps.port),
    ...(deps.keyd ? await keydChecks(deps.keyd) : []),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

async function keydChecks(keyd: Pick<KeydClient, "status">): Promise<DoctorCheck[]> {
  let status: KeydStatus;
  try {
    status = await keyd.status();
  } catch (err) {
    return [
      { name: "keyd", ok: false, detail: `${messageOf(err)}; start keyd (pnpm keyd)` },
      ...skipped(["hairpin-guard"]),
    ];
  }
  const { audit } = status;
  const held = `; its audit log fails, so it holds every key back: ${audit.error ?? "no reason given"}`;
  return [
    {
      name: "keyd",
      ok: audit.ok,
      detail: `boot ${status.bootId}, version ${status.version}${audit.ok ? "" : held}`,
    },
    hairpinCheck(status.hairpin ?? { state: "unknown", addresses: 0 }),
  ];
}

// Hairpin NAT: a computer that can reach this network's public address reaches the router's own
// services through it, unless keyd knows that address and denies it.
function hairpinCheck(guard: HairpinGuard): DoctorCheck {
  const name = "hairpin-guard";
  if (guard.state === "active") {
    const source = guard.source ?? "an unnamed source";
    return {
      name,
      ok: true,
      detail: `active: keyd denies this network's public address (from ${source})`,
    };
  }
  if (guard.state === "off") {
    return {
      name,
      ok: false,
      detail:
        "off: keyd asks neither the router nor STUN for the public address (-natpmp off -stun off)",
    };
  }
  const why = guard.error ? `: ${guard.error}` : "";
  return {
    name,
    ok: false,
    detail: `unknown: keyd has not learned this network's public address and asks again every 30 s${why}`,
  };
}
```
In `apps/daemon/src/doctor-main.ts`, import `KeydClient, keydSocketPath` from `./keyd/client.ts` and
`localdotHome` from `./paths.ts`, and pass `keyd: new KeydClient(keydSocketPath(localdotHome())),` to
`runDoctor` after `port`.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/daemon/src/keyd/routes.test.ts apps/daemon/src/doctor.test.ts apps/daemon/src/doctor-main.test.ts`
Expected: PASS. `routes.test.ts` has 9 tests, `doctor.test.ts` three more than before, and
`doctor-main.test.ts` still passes its one test, now on a home with no keyd.

Run: `LOCALDOT_KEYD_TESTS=1 pnpm test:keyd apps/daemon/src/keyd/routes.keyd.test.ts`
Expected: PASS, 2 tests. A key sealed with WebCrypto is stored by the real keyd. A seal made for an
earlier keyd boot gets 409 `bad-seal`. No file under the daemon's home holds the canary.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add apps/daemon/src/keyd apps/daemon/src/app.ts apps/daemon/src/doctor.ts apps/daemon/src/doctor.test.ts apps/daemon/src/doctor-main.ts apps/daemon/src/doctor-main.test.ts
git commit -m "feat(daemon): key routes that relay sealed keys, and keyd's health in the UI and doctor"
```

---

### Task 5: Writing files into a container, and freezing it, through the Docker API

The daemon writes keyd's material for each start into the stopped desktop container with
`PUT /containers/{name}/archive?path=/etc/localdot/cell`, a tar archive of flat files. Docker
extracts it whether the container runs or not. No bind mount and no `docker exec` arguments are
involved. The kill switch (Task 10) freezes and thaws the desktop with `POST …/pause` and
`…/unpause`.

This task adds the minimal tar writer and the client method. It also teaches the fake Docker
three things the later unit tests rely on, keeping what Part 2 built into it (`failRequests`, the
API version refusal, its 409s and 403s):
- the archive endpoint, keeping the extracted files by path;
- pause and unpause as Docker does them: 409 when there is nothing to do, 409 for a start of a
  paused container, and a stop that stops a paused one (Docker signals it, then resumes it);
- `State.Paused` in inspect.

**Files:**
- Create: `apps/daemon/src/cells/tar.ts`, `apps/daemon/src/cells/tar.test.ts`
- Modify: `apps/daemon/src/cells/docker.ts`, `apps/daemon/src/cells/docker.test.ts`,
  `apps/daemon/src/cells/testing/fake-docker.ts`, `apps/daemon/src/cells/testing/fake-docker.test.ts`

**Interfaces:**
- Consumes: Part 2's `DockerClient.request`, `DockerClient.engineVersion`, `DockerError`, and the
  fake Docker's `state`, `handle`, `holds`, `failRequests` and API version refusal.
- Produces:
  - `tar(files: TarFile[], mtimeSeconds?) → Buffer`, with `TarFile { name; data: string | Uint8Array; mode? }`;
    names must be plain (`^[A-Za-z0-9._-]{1,100}$`), or `RangeError`.
  - `DockerRequest.method` adds `"PUT"`, and `DockerRequest.raw?: { contentType; data: Buffer }`.
  - `DockerClient.putArchive(container, dir, archive)`.
  - The fake's `FakeContainer` adds `paused: boolean` and `files: Map<"<dir>/<name>", Buffer>`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/cells/tar.test.ts`:
```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tar } from "./tar.ts";

describe("tar", () => {
  it("writes an archive the system tar extracts byte for byte, with the modes given", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    const big = "x".repeat(1500);
    const archive = tar([
      { name: "ca.pem", data: pem },
      { name: "proxy-token", data: "j6CLzsRw79yMKkRwPznckks1fdcXOOnPN3DYp3Al_gk", mode: 0o640 },
      { name: "big.txt", data: big },
      { name: "empty", data: "" },
    ]);
    expect(archive.length % 512).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "local dot's tar-"));
    const file = join(dir, "a.tar");
    writeFileSync(file, archive);
    const listing = execFileSync("tar", ["-tvf", file], { encoding: "utf8" });
    expect(listing).toMatch(/-rw-r--r--.*ca\.pem/);
    expect(listing).toMatch(/-rw-r-----.*proxy-token/);
    execFileSync("tar", ["-xf", file, "-C", dir]);
    expect(readFileSync(join(dir, "ca.pem"), "utf8")).toBe(pem);
    expect(readFileSync(join(dir, "big.txt"), "utf8")).toBe(big);
    expect(statSync(join(dir, "empty")).size).toBe(0);
  });

  it("refuses names that are paths, empty, too long or not plain", () => {
    for (const name of ["../x", "a/b", "", ".", "..", "x".repeat(101), "a b", "é"]) {
      expect(() => tar([{ name, data: "x" }]), name).toThrow(RangeError);
    }
  });
});
```

In `apps/daemon/src/cells/docker.test.ts`, import `tar` from `./tar.ts` and add, before the
empty-socket-path test:
```ts
  it("uploads a tar archive with PUT, the x-tar type and the target directory", async () => {
    const { socketPath, seen } = await fakeDocker(() => ({ status: 200 }));
    const archive = tar([{ name: "proxy-token", data: "t".repeat(43) }]);
    await new DockerClient(socketPath).putArchive(
      "localdot-desktop-x",
      "/etc/localdot/cell",
      archive,
    );
    expect(seen[0]).toMatchObject({
      method: "PUT",
      url: `/${DOCKER_API}/containers/localdot-desktop-x/archive?path=%2Fetc%2Flocaldot%2Fcell`,
      contentType: "application/x-tar",
    });
    expect(seen[0]?.body.length).toBe(archive.length);
  });
```

Append to `apps/daemon/src/cells/testing/fake-docker.test.ts`'s `describe` (its `fake` and
`statusOf` are the file's own):
```ts
  it("pauses as Docker does: a running container only, stopped even while paused", async () => {
    fake = await startFakeDocker();
    const docker = new DockerClient(fake.socketPath);
    const post = (path: string) => statusOf(docker.request({ method: "POST", path }));
    await docker.request({
      method: "POST",
      path: "/containers/create",
      query: { name: "c" },
      body: { Image: "i", HostConfig: {} },
    });
    expect(await post("/containers/c/pause")).toBe(409);
    expect(await post("/containers/c/start")).toBe("ok");
    expect(await post("/containers/c/pause")).toBe("ok");
    expect(await post("/containers/c/pause")).toBe(409);
    expect(await post("/containers/c/start")).toBe(409);
    expect(await post("/containers/c/stop")).toBe("ok");
    expect(fake.state.containers.get("c")).toMatchObject({ running: false, paused: false });
    expect(await post("/containers/c/unpause")).toBe(409);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/daemon/src/cells/tar.test.ts apps/daemon/src/cells/docker.test.ts`
Expected: FAIL. `./tar.ts` cannot be resolved.

Run: `pnpm exec vitest run apps/daemon/src/cells/testing/fake-docker.test.ts`
Expected: FAIL. The fake has no pause route (404 where Docker answers 409 or 204).

- [ ] **Step 3: Write the code**

`apps/daemon/src/cells/tar.ts`:
```ts
// A minimal ustar writer for Docker's archive endpoint: flat regular files only, owned by root.
// The daemon writes a cell's keyd files this way: never through a bind mount (the repo's path
// wedges Docker Desktop's file sharing), and never as `docker exec` arguments, which `ps` shows.

export interface TarFile {
  name: string;
  data: string | Uint8Array;
  mode?: number;
}

const BLOCK = 512;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function tar(files: TarFile[], mtimeSeconds = Math.floor(Date.now() / 1000)): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    if (!NAME.test(file.name) || file.name === "." || file.name === "..") {
      throw new RangeError(`tar: ${JSON.stringify(file.name)} is not a plain file name`);
    }
    const data =
      typeof file.data === "string" ? Buffer.from(file.data, "utf8") : Buffer.from(file.data);
    parts.push(
      header(file.name, data.length, file.mode ?? 0o644, mtimeSeconds),
      data,
      padding(data.length),
    );
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function header(name: string, size: number, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, "ascii");
  h.write(octal(mode, 7), 100, "ascii");
  h.write(octal(0, 7), 108, "ascii");
  h.write(octal(0, 7), 116, "ascii");
  h.write(octal(size, 11), 124, "ascii");
  h.write(octal(mtime, 11), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write("0", 156, "ascii");
  h.write("ustar\u000000", 257, "ascii");
  h.write("root", 265, "ascii");
  h.write("root", 297, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "ascii");
  return h;
}

function octal(value: number, digits: number): string {
  const text = value.toString(8);
  if (text.length > digits)
    throw new RangeError(`tar: ${value} does not fit ${digits} octal digits`);
  return `${text.padStart(digits, "0")}\u0000`;
}

function padding(length: number): Buffer {
  return Buffer.alloc((BLOCK - (length % BLOCK)) % BLOCK);
}
```

In `apps/daemon/src/cells/docker.ts`, `DockerRequest` takes `PUT` and a raw body, and keeps Part 3's
`timeoutMs`:
```ts
export interface DockerRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  // Sent as is instead of JSON: the tar archive of PUT /containers/{id}/archive.
  raw?: { contentType: string; data: Buffer };
}
```
In `#send`, the body and its type come from `raw` when it is given:
```ts
      let body: string | Buffer | undefined;
      // …
        body = req.raw?.data ?? (req.body === undefined ? undefined : JSON.stringify(req.body));
      // … and in the headers:
                    "content-type": req.raw?.contentType ?? "application/json",
```
and add after `version()`:
```ts
  // Extracts a tar archive into a directory of a container, whether it runs or not.
  putArchive(container: string, dir: string, archive: Buffer): Promise<void> {
    return this.request({
      method: "PUT",
      path: `/containers/${encodeURIComponent(container)}/archive`,
      query: { path: dir },
      raw: { contentType: "application/x-tar", data: archive },
    });
  }
```

In `apps/daemon/src/cells/testing/fake-docker.ts`:
- `FakeContainer` gains
  ```ts
  paused: boolean;
  // Files written with PUT /containers/{id}/archive, by their path in the container.
  files: Map<string, Buffer>;
  ```
  and the container created by `POST /containers/create` starts with `paused: false, files: new Map()`.
- `containerJson` reports `State: { Running: c.running, Paused: c.paused, ExitCode: c.exitCode, Error: "" }`.
- `handle` takes the raw body as a fifth parameter, `raw: Buffer`.
- The server keeps the request's bytes and parses JSON only for a JSON body. Replace the `text`
  accumulation in the request handler with:
  ```ts
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://docker");
      const api = /^\/v(\d+\.\d+)\//.exec(url.pathname)?.[1];
      const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
      const raw = Buffer.concat(chunks);
      const isJson = (req.headers["content-type"] ?? "").includes("application/json");
      const body = isJson && raw.length > 0 ? JSON.parse(raw.toString("utf8")) : undefined;
      state.calls.push({ method: req.method ?? "", path, query: url.searchParams, body });
      await state.holds.get(`${req.method} ${path}`);
      const request = `${req.method} ${path}`;
      const failed = [...state.failRequests].some((prefix) => request.startsWith(prefix));
      const out =
        (failed ? json(500, { message: `fake docker: refusing ${request}` }) : undefined) ??
        (api === undefined ? undefined : refusal(api, path)) ??
        handle(req.method ?? "", path, url.searchParams, body, raw);
      // …the reply as before…
  ```
- Before the container-action route, extract archives:
  ```ts
    const archive = /^\/containers\/([^/]+)\/archive$/.exec(path);
    if (method === "PUT" && archive) {
      const c = state.containers.get(segment(archive));
      if (!c) return notFound("container");
      for (const [name, data] of untar(raw)) c.files.set(`${query.get("path")}/${name}`, data);
      return { status: 200 };
    }
  ```
- The action route matches `(json|start|stop|pause|unpause)`, and right after its `json` branch:
  ```ts
      if (action[2] === "pause" || action[2] === "unpause") {
        const pausing = action[2] === "pause";
        if (!c.running || c.paused === pausing) {
          return json(409, { message: `container ${c.name} cannot ${action[2]} now` });
        }
        c.paused = pausing;
        return { status: 204 };
      }
  ```
  the `start` branch begins with
  ```ts
        // Docker refuses to start a paused container before it looks at whether it runs.
        if (c.paused) {
          return json(409, { message: "cannot start a paused container, try unpause instead" });
        }
  ```
  and the stop at the end of the action route clears the freeze too:
  ```ts
      if (!c.running) return { status: 304 };
      // Docker stops a paused container too: it signals it and then resumes it.
      c.running = false;
      c.paused = false;
      c.exitCode = 0;
      return { status: 204 };
  ```
- At the end of the file:
  ```ts
  // Reads the flat ustar archives the daemon writes (tar.ts): each header's name and size.
  function untar(archive: Buffer): [string, Buffer][] {
    const files: [string, Buffer][] = [];
    for (let at = 0; at + 512 <= archive.length; ) {
      const header = archive.subarray(at, at + 512);
      if (header.every((b) => b === 0)) break;
      const field = (from: number, to: number) =>
        header.subarray(from, to).toString("ascii").replace(/\0.*$/s, "");
      const size = Number.parseInt(field(124, 136), 8);
      files.push([field(0, 100), Buffer.from(archive.subarray(at + 512, at + 512 + size))]);
      at += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
  }
  ```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/daemon/src/cells`
Expected: PASS. `tar.test.ts` has 2 tests, and `docker.test.ts` and `fake-docker.test.ts` one more
each than before; every orchestrator test still passes against the extended fake.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add apps/daemon/src/cells
git commit -m "feat(daemon): write files into containers and freeze them through the Docker API"
```

---

### Task 6: The cell's proxy forwarder

Every program in the desktop uses one credential-free proxy, `http://127.0.0.1:3129`: the
forwarder, a small Node process in the cell. For each request it reads the cell's token from
`/etc/localdot/cell/proxy-token`, sets `Proxy-Authorization: Basic base64(cell:<token>)` and relays
to the gate's keyd relay at `LOCALDOT_GATE_ADDR:3128`. It handles plain absolute-form requests and
CONNECT tunnels. Why not credentials in `HTTPS_PROXY`? Chromium ignores credentials in
`--proxy-server` (Part 4a: "Part 4b answers its 407 challenge"). And a token in an environment
variable is copied into every process's environment.

The forwarder never shows a client a 407, because Chromium would then prompt for credentials: a
refused token becomes 502 with `X-Localdot-Reason: proxy-token-refused`. keyd's own refusals pass
through with their `X-Keyd-Reason`. Without a token file or a gate it answers 503 at once and
contacts nothing.

Its own HTTP agent never consults the cell's proxy variables, and its s6 service unsets them too.
The cell's environment sets `NODE_USE_ENV_PROXY=1`, and a forwarder obeying it would send its own
requests back to itself. The bundle is built beside `desktopd`'s, from the same package, with Node
built-ins only.

**Files:**
- Create: `cells/desktop/desktopd/src/forwarder.ts`, `cells/desktop/desktopd/src/forwarder-main.ts`,
  `cells/desktop/desktopd/src/forwarder.test.ts`
- Modify: `cells/desktop/desktopd/build.mjs`

**Interfaces:**
- Consumes: Part 4a's listener contract (Basic proxy credentials, `X-Keyd-Reason`, CONNECT to
  `host:443`, absolute-form plain HTTP) and Part 2's gate relay (`internal:3128`).
- Produces:
  - `FORWARDER_PORT = 3129`, `GATE_PROXY_PORT = 3128`, `PROXY_TOKEN_FILE`;
  - `readTokenFile(path?)`;
  - `createForwarder({ gate?: { host; port }; readToken(): string | undefined }) → Server`;
  - the bundle `cells/desktop/desktopd/dist/forwarder.mjs`, whose process reads `LOCALDOT_GATE_ADDR`
    and, optionally, `LOCALDOT_GATE_PORT`, `LOCALDOT_FORWARDER_PORT` and
    `LOCALDOT_PROXY_TOKEN_FILE`, and listens on `127.0.0.1` only.

- [ ] **Step 1: Write the failing test**

`cells/desktop/desktopd/src/forwarder.test.ts`:
```ts
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createForwarder, readTokenFile } from "./forwarder.ts";

const TOKEN = "j6CLzsRw79yMKkRwPznckks1fdcXOOnPN3DYp3Al_gk";
const BASIC = `Basic ${Buffer.from(`cell:${TOKEN}`).toString("base64")}`;

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  host: string | undefined;
}

// Stands in for gate → keyd: the cell's listener answers 407 without the cell's token, refuses
// refused.example with keyd's reason header, echoes plain requests and echoes tunnelled bytes.
async function fakeGate(): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers["proxy-authorization"],
        host: req.headers.host,
      });
      if (req.headers["proxy-authorization"] !== BASIC) {
        res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="localdot-keyd"' });
        return res.end();
      }
      if ((req.url ?? "").includes("refused.example")) {
        res.writeHead(403, { "X-Keyd-Reason": "host-denied" });
        return res.end("refused");
      }
      res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
      res.end(JSON.stringify({ url: req.url, body, cookie: req.headers.cookie ?? null }));
    });
  });
  server.on("connect", (req: IncomingMessage, socket: Socket) => {
    seen.push({
      method: "CONNECT",
      url: req.url ?? "",
      auth: req.headers["proxy-authorization"],
      host: req.headers.host,
    });
    if (req.headers["proxy-authorization"] !== BASIC) {
      return socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="localdot-keyd"\r\n\r\n',
      );
    }
    if ((req.url ?? "").startsWith("refused.example")) {
      return socket.end(
        "HTTP/1.1 403 Forbidden\r\nX-Keyd-Reason: host-denied\r\nContent-Length: 0\r\n\r\n",
      );
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.pipe(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as AddressInfo).port, seen };
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function setup(token: string | null = TOKEN, gateUp = true) {
  const gate = await fakeGate();
  closers.push(() => gate.server.close());
  const forwarder = createForwarder({
    gate: gateUp ? { host: "127.0.0.1", port: gate.port } : undefined,
    readToken: () => token ?? undefined,
  });
  forwarder.listen(0, "127.0.0.1");
  await once(forwarder, "listening");
  closers.push(() => forwarder.close());
  return { gate, port: (forwarder.address() as AddressInfo).port };
}

function viaProxy(port: number, url: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; text: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: body ? "POST" : "GET",
          path: url,
          // A proxy client names the origin in Host, as curl does.
          headers: {
            host: url.startsWith("http://") ? new URL(url).host : "127.0.0.1",
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => {
            text += c;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        },
      );
      req.on("error", reject);
      req.end(body);
    },
  );
}

function tunnel(port: number, authority: string) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; socket: Socket }>(
    (resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "CONNECT", path: authority });
      req.on("connect", (res, socket: Socket) =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, socket }),
      );
      req.on("error", reject);
      req.end();
    },
  );
}

describe("the cell's proxy forwarder", () => {
  it("adds the cell's token to a plain request and replaces the client's own", async () => {
    const { gate, port } = await setup();
    const res = await viaProxy(
      port,
      "http://example.test/a?b=1",
      { "proxy-authorization": "Basic evil", cookie: "k=v" },
      "hello",
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      url: "http://example.test/a?b=1",
      body: "hello",
      cookie: "k=v",
    });
    expect(res.headers["x-upstream"]).toBe("yes");
    expect(gate.seen).toEqual([
      { method: "POST", url: "http://example.test/a?b=1", auth: BASIC, host: "example.test" },
    ]);
  });

  it("opens tunnels with the token and carries bytes both ways", async () => {
    const { gate, port } = await setup();
    const t = await tunnel(port, "example.test:443");
    expect(t.status).toBe(200);
    t.socket.write("ping");
    const [echo] = (await once(t.socket, "data")) as [Buffer];
    expect(echo.toString()).toBe("ping");
    t.socket.destroy();
    expect(gate.seen[0]).toMatchObject({ method: "CONNECT", url: "example.test:443", auth: BASIC });
  });

  it("relays keyd's refusals with their reason", async () => {
    const { port } = await setup();
    const plain = await viaProxy(port, "http://refused.example/");
    expect(plain.status).toBe(403);
    expect(plain.headers["x-keyd-reason"]).toBe("host-denied");
    const t = await tunnel(port, "refused.example:443");
    expect(t.status).toBe(403);
    expect(t.headers["x-keyd-reason"]).toBe("host-denied");
    t.socket.destroy();
  });

  it("never lets a client see a 407, which would make browsers prompt for the token", async () => {
    const { port } = await setup("stale-token-0123456789abcdefghijklmnopqrstu");
    const plain = await viaProxy(port, "http://example.test/");
    expect(plain.status).toBe(502);
    expect(plain.headers["x-localdot-reason"]).toBe("proxy-token-refused");
    expect(plain.headers["proxy-authenticate"]).toBeUndefined();
    const t = await tunnel(port, "example.test:443");
    expect(t.status).toBe(502);
    t.socket.destroy();
  });

  it("fails closed without a token or a gate, and never contacts the gate then", async () => {
    for (const [token, gateUp, reason] of [
      [null, true, "no-proxy-token"],
      [TOKEN, false, "no-gate"],
    ] as const) {
      const { gate, port } = await setup(token, gateUp);
      const plain = await viaProxy(port, "http://example.test/");
      expect(plain.status).toBe(503);
      expect(plain.headers["x-localdot-reason"]).toBe(reason);
      const t = await tunnel(port, "example.test:443");
      expect(t.status).toBe(503);
      t.socket.destroy();
      expect(gate.seen).toEqual([]);
    }
  });

  it("refuses origin-form requests and upgrades", async () => {
    const { gate, port } = await setup();
    expect((await viaProxy(port, "/local", { host: "127.0.0.1" })).status).toBe(400);
    const upgraded = await viaProxy(port, "http://example.test/ws", {
      connection: "upgrade",
      upgrade: "websocket",
    }).catch((e: Error) => e);
    expect(upgraded instanceof Error ? 501 : upgraded.status).toBe(501);
    expect(gate.seen).toEqual([]);
  });

  it("reads only a well-formed token from its file", () => {
    const dir = mkdtempSync(join(tmpdir(), "local dot's token-"));
    writeFileSync(join(dir, "good"), `${TOKEN}\n`);
    writeFileSync(join(dir, "bad"), "short");
    expect(readTokenFile(join(dir, "good"))).toBe(TOKEN);
    expect(readTokenFile(join(dir, "bad"))).toBeUndefined();
    expect(readTokenFile(join(dir, "missing"))).toBeUndefined();
  });
});

describe("the forwarder process", () => {
  let child: ChildProcess | undefined;
  afterEach(() => child?.kill("SIGKILL"));

  it("ignores the proxy variables of its environment, so it never loops or leaks", async () => {
    const gate = await fakeGate();
    closers.push(() => gate.server.close());
    const trap = await fakeGate();
    closers.push(() => trap.server.close());
    const dir = mkdtempSync(join(tmpdir(), "local dot's fwd-"));
    writeFileSync(join(dir, "proxy-token"), TOKEN);
    const main = fileURLToPath(new URL("./forwarder-main.ts", import.meta.url));
    const trapUrl = `http://127.0.0.1:${trap.port}`;
    child = spawn(process.execPath, ["--import", "tsx", main], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        LOCALDOT_GATE_ADDR: "127.0.0.1",
        LOCALDOT_GATE_PORT: String(gate.port),
        LOCALDOT_FORWARDER_PORT: "0",
        LOCALDOT_PROXY_TOKEN_FILE: join(dir, "proxy-token"),
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: trapUrl,
        HTTPS_PROXY: trapUrl,
        http_proxy: trapUrl,
        https_proxy: trapUrl,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = once(child, "exit").then(() => {
      throw new Error("the forwarder exited");
    });
    const [line] = (await Promise.race([
      once(child.stdout as NodeJS.ReadableStream, "data"),
      exited,
    ])) as [Buffer];
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(line.toString())?.[1]);
    const res = await viaProxy(port, "http://example.test/");
    expect(res.status).toBe(200);
    expect(gate.seen).toHaveLength(1);
    expect(trap.seen).toEqual([]);
  }, 20_000);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run cells/desktop/desktopd/src/forwarder.test.ts`
Expected: FAIL. `./forwarder.ts` cannot be resolved.

- [ ] **Step 3: Write the code**

`cells/desktop/desktopd/src/forwarder.ts`:
```ts
import { readFileSync } from "node:fs";
import {
  Agent,
  type ClientRequest,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import type { Duplex } from "node:stream";

export const FORWARDER_PORT = 3129;
export const GATE_PROXY_PORT = 3128;
export const PROXY_TOKEN_FILE = "/etc/localdot/cell/proxy-token";
const TOKEN = /^[A-Za-z0-9_-]{32,}$/;
// Headers that describe one hop are never relayed. The client's Proxy-Authorization is replaced
// with the cell's token, and Proxy-Authenticate never reaches a client, so nothing prompts for it.
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ForwarderOptions {
  gate: { host: string; port: number } | undefined;
  readToken(): string | undefined;
}

type Ready =
  | { gate: { host: string; port: number }; authorization: string }
  | { status: 503; reason: string };

// The token is read for every connection, so a rewired cell needs no restart of this process.
export function readTokenFile(path = PROXY_TOKEN_FILE): string | undefined {
  try {
    const token = readFileSync(path, "utf8").trim();
    return TOKEN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

// Every program in the cell reaches keyd through this forwarder on the cell's loopback: it adds
// the cell's proxy token, which some clients cannot send themselves (Chromium ignores credentials
// in --proxy-server; sudo drops proxy variables), and relays to the gate. It never uses a proxy
// of its own: its agent is not the global one that NODE_USE_ENV_PROXY configures.
export function createForwarder(opts: ForwarderOptions): Server {
  const agent = new Agent({ keepAlive: false });
  const server = createServer((req, res) => {
    forwardRequest(opts, agent, req, res);
  });
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    forwardTunnel(opts, agent, req, client, head);
  });
  server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
    refuseRaw(socket, 501, { "X-Localdot-Reason": "upgrade-refused" });
  });
  return server;
}

function forwardRequest(
  opts: ForwarderOptions,
  agent: Agent,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const ready = prepare(opts);
  if ("reason" in ready) {
    refuse(res, ready.status, ready.reason);
    return;
  }
  if (!req.url?.startsWith("http://")) {
    refuse(res, 400, "absolute-form-only");
    return;
  }
  const headers = relayable(req.headers);
  headers["proxy-authorization"] = ready.authorization;
  // The body arrives de-chunked; frame it the same way on the way out.
  if (req.headers["transfer-encoding"]) headers["transfer-encoding"] = "chunked";
  const { host, port } = ready.gate;
  const up = send(() =>
    httpRequest({ host, port, method: req.method, path: req.url, headers, agent }, (upRes) => {
      const status = upRes.statusCode ?? 502;
      if (status === 407) {
        upRes.resume();
        refuse(res, 502, "proxy-token-refused");
        return;
      }
      res.writeHead(status, relayable(upRes.headers));
      upRes.pipe(res);
    }),
  );
  if (!up) {
    refuse(res, 400, "bad-request");
    return;
  }
  up.on("error", () => {
    if (res.headersSent) res.destroy();
    else refuse(res, 502, "gate-unreachable");
  });
  req.pipe(up);
}

function forwardTunnel(
  opts: ForwarderOptions,
  agent: Agent,
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
) {
  client.on("error", () => client.destroy());
  const ready = prepare(opts);
  if ("reason" in ready) {
    refuseRaw(client, ready.status, { "X-Localdot-Reason": ready.reason });
    return;
  }
  const { host, port } = ready.gate;
  const up = send(() =>
    httpRequest({
      host,
      port,
      method: "CONNECT",
      path: req.url,
      headers: { host: req.url, "proxy-authorization": ready.authorization },
      agent,
    }),
  );
  if (!up) {
    refuseRaw(client, 400, { "X-Localdot-Reason": "bad-request" });
    return;
  }
  up.on("connect", (res: IncomingMessage, upSocket: Duplex, upHead: Buffer) => {
    const status = res.statusCode ?? 502;
    if (status !== 200) {
      upSocket.destroy();
      const reason = res.headers["x-keyd-reason"];
      if (status === 407) refuseRaw(client, 502, { "X-Localdot-Reason": "proxy-token-refused" });
      else refuseRaw(client, status, typeof reason === "string" ? { "X-Keyd-Reason": reason } : {});
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (upHead.length > 0) client.write(upHead);
    if (head.length > 0) upSocket.write(head);
    upSocket.on("error", () => client.destroy());
    upSocket.on("close", () => client.destroy());
    client.on("close", () => upSocket.destroy());
    upSocket.pipe(client);
    client.pipe(upSocket);
  });
  up.on("error", () => {
    refuseRaw(client, 502, { "X-Localdot-Reason": "gate-unreachable" });
  });
  up.end();
}

function prepare(opts: ForwarderOptions): Ready {
  if (!opts.gate?.host) return { status: 503, reason: "no-gate" };
  const token = opts.readToken();
  if (!token) return { status: 503, reason: "no-proxy-token" };
  const authorization = `Basic ${Buffer.from(`cell:${token}`).toString("base64")}`;
  return { gate: opts.gate, authorization };
}

// Node refuses a request line or a header it cannot send (CR or LF in a path) by throwing.
function send(make: () => ClientRequest): ClientRequest | undefined {
  try {
    return make();
  } catch {
    return undefined;
  }
}

function relayable(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP.has(name)) out[name] = value;
  }
  return out;
}

function refuse(res: ServerResponse, status: number, reason: string) {
  res.writeHead(status, {
    "X-Localdot-Reason": reason,
    "Content-Length": "0",
    Connection: "close",
  });
  res.end();
}

function refuseRaw(socket: Duplex, status: number, headers: Record<string, string>) {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\n${lines.join("")}Content-Length: 0\r\nConnection: close\r\n\r\n`,
  );
}
```

`cells/desktop/desktopd/src/forwarder-main.ts`:
```ts
import type { AddressInfo } from "node:net";
import {
  createForwarder,
  FORWARDER_PORT,
  GATE_PROXY_PORT,
  PROXY_TOKEN_FILE,
  readTokenFile,
} from "./forwarder.ts";

const gateHost = process.env.LOCALDOT_GATE_ADDR ?? "";
const gatePort = Number(process.env.LOCALDOT_GATE_PORT ?? GATE_PROXY_PORT);
const port = Number(process.env.LOCALDOT_FORWARDER_PORT ?? FORWARDER_PORT);
const tokenFile = process.env.LOCALDOT_PROXY_TOKEN_FILE ?? PROXY_TOKEN_FILE;

if (!gateHost) console.error("forwarder: LOCALDOT_GATE_ADDR is unset; every request gets 503");
const server = createForwarder({
  gate: gateHost ? { host: gateHost, port: gatePort } : undefined,
  readToken: () => readTokenFile(tokenFile),
});
// Loopback only: other containers can never reach a cell's loopback, so only this cell's own
// programs use the token the forwarder adds.
server.listen(port, "127.0.0.1", () => {
  const { port: bound } = server.address() as AddressInfo;
  console.log(`forwarder on 127.0.0.1:${bound} -> ${gateHost || "(no gate)"}:${gatePort}`);
});
```

Append to `cells/desktop/desktopd/build.mjs`, after the `desktopd` build:
```js
// The cell's proxy forwarder: its own process (svc-forwarder), Node built-ins only.
await build({
  entryPoints: [join(here, "src/forwarder-main.ts")],
  outfile: join(here, "dist/forwarder.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  logLevel: "info",
});
```

- [ ] **Step 4: Run the tests and the build**

Run: `pnpm exec vitest run cells/desktop/desktopd/src/forwarder.test.ts && pnpm --filter @localdot/desktopd build`
Expected: PASS, 8 tests. The last one spawns `forwarder-main.ts` through tsx with
`NODE_USE_ENV_PROXY=1` and `HTTP(S)_PROXY` pointing at a trap server, and the trap sees nothing. The build prints
`dist/desktopd.mjs` and `dist/forwarder.mjs` (about 5 kB).

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add cells/desktop/desktopd/src/forwarder.ts cells/desktop/desktopd/src/forwarder-main.ts cells/desktop/desktopd/src/forwarder.test.ts cells/desktop/desktopd/build.mjs
git commit -m "feat(desktopd): the cell's proxy forwarder that adds its keyd token"
```

---

### Task 7: The cell's way to keyd — its proxy settings, its files and its CA

A desktop cell gets its keyd material in two parts.

**The environment, fixed for the cell's life.** `keydEnv(record)` holds:
- `HTTP(S)_PROXY` (both spellings), pointing at the forwarder;
- `NO_PROXY` for loopback only. The cell's own services (DevTools on 9222, the forwarder itself)
  live on its loopback, which never leaves the cell. Nothing else is exempt (P4b-R2);
- `NODE_USE_ENV_PROXY=1`, `NODE_EXTRA_CA_CERTS` for the cell's CA, and `SSL_CERT_FILE` and
  `REQUESTS_CA_BUNDLE` for the system bundle;
- `LOCALDOT_GATE_ADDR` for the forwarder, and `LOCALDOT_CELL_ID` for the self-test.

**Three files, rewritten before every start** (Task 9 writes them):
- `/etc/localdot/cell/proxy-token`, `ca.pem` and `surrogates.sh`;
- the token, CA and surrogates change every time keyd opens the cell, so they can never be
  environment, and none of them is a secret.

The image wires them in as follows.
- **The CA, for TLS server auth only** (Part 4a's carry C3). An s6 oneshot, `init-localdot-cell`,
  runs before the desktop session. It installs `ca.pem` into the system store
  (`update-ca-certificates`) as an OpenSSL `TRUSTED CERTIFICATE` whose trust settings name
  serverAuth alone (`openssl x509 -addtrust serverAuth`): OpenSSL trusts a plain anchor for every
  purpose, and its code-signing purpose ignores the CA's own serverAuth-only key usage. It installs
  it into the desktop user's NSS database with trust `C,,` (TLS only): Chromium trusts a
  name-constrained CA only through NSS (S4). Every old `localdot-cell` entry goes first, and a start
  without the file removes the CA. Trust never outlives the cell's listener.
  - OpenSSL's clients (curl, Python, apt) read the trusted form. Node reads `ca.pem` itself through
    `NODE_EXTRA_CA_CERTS`, for TLS only.
  - GnuTLS ignores a `TRUSTED CERTIFICATE`, so its clients (git's HTTPS transport, GLib
    programs) do not trust the cell's CA at all. They still reach every host keyd passes through,
    but a host bound to a key (which keyd intercepts) fails their certificate check: closed, never
    open (recorded under "Not in Part 4b").
- **The forwarder.** It runs as `svc-forwarder`.
- **The surrogates.** Login and interactive shells source `surrogates.sh` through
  `/etc/profile.d/localdot-cell.sh` and `/etc/bash.bashrc`.
- **sudo and apt.** sudo keeps the proxy and CA variables. apt, which runs through sudo, has its own
  proxy setting.
- **Chromium.** The Chromium launcher passes the forwarder as `--proxy-server`, with
  `--disable-quic`.

The apt setting is copied in the final image stage, after every `apt-get` of the build, which would
otherwise try to use the forwarder.

**Files:**
- Create:
  - `cells/desktop/root/etc/s6-overlay/s6-rc.d/init-localdot-cell/{type,up,run,dependencies.d/init-services}`;
  - `cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-forwarder/{type,run,dependencies.d/init-localdot-cell}`;
  - `cells/desktop/root/etc/s6-overlay/s6-rc.d/user/contents.d/{init-localdot-cell,svc-forwarder}`;
  - `cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-de/dependencies.d/init-localdot-cell`;
  - `cells/desktop/root/etc/profile.d/localdot-cell.sh`;
  - `cells/desktop/cell/apt-proxy.conf`, `cells/desktop/cell/sudoers-proxy`;
  - `apps/daemon/src/cells/desktop-keyd-files.docker.test.ts`.
- Modify: `cells/desktop/Dockerfile`, `cells/desktop/root/usr/local/bin/localdot-chromium` (Part 3's),
  `apps/daemon/src/cells/spec.ts`, `apps/daemon/src/cells/spec.test.ts`

**Interfaces:**
- Consumes: Task 6's `dist/forwarder.mjs`; Part 2's `desktopSpec`, `desktopEnv(record)` and the
  `base` and `desktop` stages; Part 3's launcher.
- Produces:
  - `CELL_PROXY = "http://127.0.0.1:3129"` and `keydEnv(record): string[]`, which `desktopEnv` appends;
  - in the image:
    - the folder `/etc/localdot/cell` (root, 755);
    - the services `init-localdot-cell` (oneshot) and `svc-forwarder` (longrun, user `abc`);
    - the system copy of the CA, `/usr/local/share/ca-certificates/localdot-cell.crt`, as a
      `TRUSTED CERTIFICATE` for serverAuth only, in `/etc/ssl/certs/ca-certificates.crt`;
    - `/etc/profile.d/localdot-cell.sh`, `/etc/sudoers.d/localdot-proxy` and
      `/etc/apt/apt.conf.d/95localdot-proxy`;
    - the NSS nickname `localdot-cell`.

- [ ] **Step 1: Write the failing tests**

In `apps/daemon/src/cells/spec.test.ts`, import `keydEnv` from `./spec.ts`. In the desktop spec test
that lists the environment's keys, append `...keydEnv(record).map((e) => e.split("=")[0])` to the
expected list, rename it, and add the no-secret check at its end:
```ts
  it("passes the per-cell tokens, the scale and the fixed way to keyd, and no secret", () => {
    // …the existing assertions, with the expected key list ending in
    //   ...keydEnv(record).map((e) => e.split("=")[0]),
    // keyd's token, CA and surrogates change at every start: they go in as files, never env.
    expect(spec.Env.join("\n")).not.toMatch(/ld_[a-z0-9]{2,12}_|BEGIN CERTIFICATE/);
  });

  it("points every program at the cell's forwarder and keeps loopback inside the cell", () => {
    expect(keydEnv(record)).toEqual([
      "LOCALDOT_CELL_ID=01JXYZ0000000000000000ABCD",
      "LOCALDOT_GATE_ADDR=172.24.0.10",
      "HTTP_PROXY=http://127.0.0.1:3129",
      "HTTPS_PROXY=http://127.0.0.1:3129",
      "http_proxy=http://127.0.0.1:3129",
      "https_proxy=http://127.0.0.1:3129",
      "NO_PROXY=localhost,127.0.0.1,::1",
      "no_proxy=localhost,127.0.0.1,::1",
      "NODE_USE_ENV_PROXY=1",
      "NODE_EXTRA_CA_CERTS=/etc/localdot/cell/ca.pem",
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
      "REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt",
    ]);
  });
```

`apps/daemon/src/cells/desktop-keyd-files.docker.test.ts`:
```ts
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imagesFromEnv } from "./images.ts";
import {
  DOCKER_TESTS,
  docker,
  dockerExec,
  dockerExecAs,
  removeAll,
  waitFor,
} from "./testing/docker-cli.ts";

// What the image does with the files the daemon writes into /etc/localdot/cell before a start:
// the CA in the system store and in Chromium's NSS database (and gone when the file is), the
// forwarder on the cell's loopback, the surrogates in login shells, the proxy kept by sudo and apt.
const NAME = `localdot-test-keydfiles-${randomBytes(4).toString("hex")}`;
const SURROGATE = "ld_key_AbCdEfGhIjKlMnOpQrStUv_AbCdEf";

// A probe counts only with the exit status it is expected to have.
function probe(status: number, ...cmd: string[]): string {
  const r = dockerExec(NAME, ...cmd);
  expect(r.status, `${cmd.join(" ")}: ${r.out}`).toBe(status);
  return r.out;
}
function probeAs(user: string, status: number, ...cmd: string[]): string {
  const r = dockerExecAs(NAME, user, ...cmd);
  expect(r.status, `${cmd.join(" ")}: ${r.out}`).toBe(status);
  return r.out;
}

const pemBody = (pem: string) => pem.replace(/-----[^-]+-----|\s/g, "");

// How the system bundle holds a CA (argv[1]): "<plain> <server>", the count of plain anchors, which
// OpenSSL trusts for every purpose, and of trusted certificates for TLS server auth only.
const ANCHORS_PY = `
import base64, re, sys
der = lambda body: base64.b64decode(re.sub(r"\\s+", "", body))
blocks = re.findall(r"-----BEGIN ([A-Z ]+)-----([^-]*)-----END \\1-----", open("/etc/ssl/certs/ca-certificates.crt").read())
ca = der(re.search(r"-----BEGIN CERTIFICATE-----([^-]*)-----END CERTIFICATE-----", sys.argv[1]).group(1))
plain = sum(1 for label, body in blocks if label == "CERTIFICATE" and der(body) == ca)
server = sum(1 for label, body in blocks if label == "TRUSTED CERTIFICATE" and der(body) == ca + bytes.fromhex("300c300a06082b06010505070301"))
print(plain, server)
`;

// A CA with its key, and a TLS server leaf and a code-signing leaf it signs, minted in the cell.
const MINT_SH = `
set -e
d=/root/localdot-test-ca; rm -rf "$d"; mkdir -p "$d"; cd "$d"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.pem -days 1 -subj /CN=localdot-test-ca -addext basicConstraints=critical,CA:TRUE,pathlen:0 -addext keyUsage=critical,keyCertSign -addext extendedKeyUsage=serverAuth 2>/dev/null
for leaf in server:serverAuth code:codeSigning; do
  name=\${leaf%%:*}; eku=\${leaf#*:}
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$name.key" -out "$name.csr" -subj /CN=localhost 2>/dev/null
  printf 'basicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature\\nextendedKeyUsage=%s\\nsubjectAltName=DNS:localhost\\n' "$eku" > "$name.ext"
  openssl x509 -req -in "$name.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -extfile "$name.ext" -out "$name.pem" 2>/dev/null
done
cp ca.pem /etc/localdot/cell/ca.pem
`;

describe.skipIf(!DOCKER_TESTS)("the desktop image installs what keyd gives a cell", () => {
  const dir = mkdtempSync(join(tmpdir(), "localdot-test-keydfiles-"));
  const newCa = () =>
    docker(
      "run",
      "--rm",
      "--entrypoint",
      "openssl",
      imagesFromEnv().desktop,
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      "/dev/null",
      "-subj",
      `/CN=localdot-test-${randomBytes(3).toString("hex")}`,
      "-days",
      "1",
    );
  const put = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    docker("cp", join(dir, name), `${NAME}:/etc/localdot/cell/${name}`);
  };
  const nssCa = () =>
    dockerExecAs(
      NAME,
      "abc",
      "certutil",
      "-d",
      "sql:/config/.pki/nssdb",
      "-L",
      "-n",
      "localdot-cell",
      "-a",
    );
  const anchors = (pem: string) => probe(0, "python3", "-c", ANCHORS_PY, pem).trim();
  const restart = () => {
    docker("restart", "-t", "5", NAME);
    waitFor(
      "the forwarder",
      () => dockerExec(NAME, "sh", "-c", "ss -ltn | grep -q 127.0.0.1:3129").status === 0,
      90_000,
    );
  };
  let first = "";

  beforeAll(() => {
    docker(
      "create",
      "--name",
      NAME,
      "-e",
      "HTTPS_PROXY=http://127.0.0.1:3129",
      "-e",
      "NODE_EXTRA_CA_CERTS=/etc/localdot/cell/ca.pem",
      imagesFromEnv().desktop,
    );
    first = newCa();
    put("ca.pem", first);
    put("proxy-token", `${"t".repeat(43)}\n`);
    put("surrogates.sh", `export LOCALDOT_KEY_WEATHER='${SURROGATE}'\n`);
    docker("start", NAME);
    waitFor(
      "the forwarder",
      () => dockerExec(NAME, "sh", "-c", "ss -ltn | grep -q 127.0.0.1:3129").status === 0,
      90_000,
    );
  }, 180_000);
  afterAll(() => {
    removeAll({ containers: [NAME] });
    rmSync(dir, { recursive: true, force: true });
  });

  it("trusts the cell's CA in the system store and in Chromium's NSS database", () => {
    expect(probe(0, "head", "-n", "1", "/usr/local/share/ca-certificates/localdot-cell.crt")).toBe(
      "-----BEGIN TRUSTED CERTIFICATE-----\n",
    );
    expect(anchors(first)).toBe("0 1");
    const listed = probeAs("abc", 0, "certutil", "-d", "sql:/config/.pki/nssdb", "-L");
    expect(listed).toMatch(/^localdot-cell\s+C,,\s*$/m);
    expect(nssCa()).toMatchObject({ status: 0 });
    expect(pemBody(nssCa().out)).toBe(pemBody(first));
  });

  it("runs the forwarder as the desktop's user, on the cell's loopback only", () => {
    const listening = probe(0, "sh", "-c", "ss -ltnpH 'sport = :3129'");
    expect(listening).toContain("127.0.0.1:3129");
    expect(listening).not.toMatch(/(0\.0\.0\.0|\*|\[::\]):3129/);
    probe(0, "pgrep", "-u", "abc", "-f", "/opt/localdot/forwarder.mjs");
    // No gate in this container: the forwarder says so instead of guessing a way out.
    const answer = probeAs(
      "abc",
      0,
      "curl",
      "-sS",
      "-o",
      "/dev/null",
      "-D",
      "-",
      "-x",
      "http://127.0.0.1:3129",
      "http://keyd.ldot/health",
    );
    expect(answer).toMatch(/^HTTP\/1\.1 503/);
    expect(answer).toMatch(/^x-localdot-reason: no-gate/im);
  });

  it("puts the surrogates in login and interactive shells, and keeps the proxy through sudo and apt", () => {
    expect(probeAs("abc", 0, "bash", "-lc", 'printf %s "$LOCALDOT_KEY_WEATHER"')).toBe(SURROGATE);
    expect(probeAs("abc", 0, "bash", "-ic", 'printf %s "$LOCALDOT_KEY_WEATHER"')).toContain(
      SURROGATE,
    );
    expect(probeAs("abc", 0, "sudo", "-n", "sh", "-c", 'printf %s "$HTTPS_PROXY"')).toBe(
      "http://127.0.0.1:3129",
    );
    expect(probe(0, "apt-config", "dump", "Acquire::https::Proxy")).toBe(
      'Acquire::https::Proxy "http://127.0.0.1:3129";\n',
    );
    expect(probe(0, "visudo", "-cf", "/etc/sudoers.d/localdot-proxy")).toContain("parsed OK");
  });

  it("replaces the CA at the next start and forgets it when the daemon writes none", () => {
    const second = newCa();
    put("ca.pem", second);
    restart();
    const listed = probeAs("abc", 0, "certutil", "-d", "sql:/config/.pki/nssdb", "-L");
    expect(listed.match(/^localdot-cell\s/gm)).toHaveLength(1);
    expect(pemBody(nssCa().out)).toBe(pemBody(second));
    expect(anchors(second)).toBe("0 1");
    expect(anchors(first)).toBe("0 0");

    probe(0, "rm", "/etc/localdot/cell/ca.pem");
    restart();
    expect(probeAs("abc", 0, "certutil", "-d", "sql:/config/.pki/nssdb", "-L")).not.toContain(
      "localdot-cell",
    );
    probe(1, "test", "-e", "/usr/local/share/ca-certificates/localdot-cell.crt");
    expect(anchors(second)).toBe("0 0");
  }, 240_000);

  it("trusts the cell's CA for TLS server auth only: curl and Python, never code signing", () => {
    probe(0, "sh", "-c", MINT_SH);
    restart();
    const ca = "/root/localdot-test-ca";
    const bundle = "/etc/ssl/certs/ca-certificates.crt";
    expect(
      probe(0, "openssl", "verify", "-CAfile", bundle, "-purpose", "sslserver", `${ca}/server.pem`),
    ).toContain("OK");
    // OpenSSL's code-signing purpose ignores a CA's own key usage; only the trust settings stop it.
    expect(
      probe(2, "openssl", "verify", "-CAfile", bundle, "-purpose", "codesign", `${ca}/code.pem`),
    ).toContain("certificate rejected");
    probe(
      0,
      "sh",
      "-c",
      `setsid openssl s_server -accept 127.0.0.1:8443 -cert ${ca}/server.pem -key ${ca}/server.key -www -quiet </dev/null >/dev/null 2>&1 & sleep 1`,
    );
    const url = "https://localhost:8443/";
    expect(
      probeAs(
        "abc",
        0,
        "curl",
        "--noproxy",
        "*",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{ssl_verify_result}",
        url,
      ),
    ).toBe("0");
    expect(
      probeAs(
        "abc",
        0,
        "python3",
        "-c",
        `import urllib.request as u; print(u.build_opener(u.ProxyHandler({})).open("${url}").status)`,
      ),
    ).toBe("200\n");
  }, 240_000);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/daemon/src/cells/spec.test.ts`
Expected: FAIL. `keydEnv` is not exported.

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-keyd-files.docker.test.ts`
Expected: FAIL against the current image. `beforeAll` times out waiting for the forwarder on
127.0.0.1:3129, and `afterAll` removes the container.

- [ ] **Step 3: Write the code**

Add to `apps/daemon/src/cells/spec.ts`, before `desktopEnv`, and end `desktopEnv`'s list with
`...keydEnv(record),`:
```ts
// Every program in the desktop reaches keyd through the forwarder on the cell's loopback, which adds
// the cell's proxy token; loopback itself stays inside the cell. The CA and token are files the
// daemon writes at every start (keyd makes new ones each time it opens the cell), so the only
// values here are fixed for the cell's life.
export const CELL_PROXY = "http://127.0.0.1:3129";
const LOOPBACK = "localhost,127.0.0.1,::1";
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

export function keydEnv(record: CellRecord): string[] {
  return [
    `LOCALDOT_CELL_ID=${record.id}`,
    `LOCALDOT_GATE_ADDR=${record.docker.gateInternalIp}`,
    `HTTP_PROXY=${CELL_PROXY}`,
    `HTTPS_PROXY=${CELL_PROXY}`,
    `http_proxy=${CELL_PROXY}`,
    `https_proxy=${CELL_PROXY}`,
    `NO_PROXY=${LOOPBACK}`,
    `no_proxy=${LOOPBACK}`,
    "NODE_USE_ENV_PROXY=1",
    "NODE_EXTRA_CA_CERTS=/etc/localdot/cell/ca.pem",
    `SSL_CERT_FILE=${SYSTEM_CA_BUNDLE}`,
    `REQUESTS_CA_BUNDLE=${SYSTEM_CA_BUNDLE}`,
  ];
}
```

`cells/desktop/root/etc/s6-overlay/s6-rc.d/init-localdot-cell/run` (mode 755):
```bash
#!/usr/bin/with-contenv bash
# Installs the cell's CA, which the daemon writes to /etc/localdot/cell/ca.pem before every start,
# into the system store (OpenSSL's curl, Python and apt; Node through NODE_EXTRA_CA_CERTS) and into
# abc's NSS database, which Chromium reads. Both trust it for TLS server auth only: the system copy
# is an OpenSSL TRUSTED CERTIFICATE, since OpenSSL trusts a plain anchor for every purpose, code
# signing included. A start without the file removes the previous CA.
set -euo pipefail
cell=/etc/localdot/cell
installed=/usr/local/share/ca-certificates/localdot-cell.crt
nssdb=/config/.pki/nssdb
if [[ -s $cell/ca.pem ]]; then
  openssl x509 -in "$cell/ca.pem" -addtrust serverAuth -out "$installed"
  chmod 0644 "$installed"
else
  rm -f "$installed"
fi
update-ca-certificates --fresh >/dev/null 2>&1
s6-setuidgid abc mkdir -p "$nssdb"
if ! s6-setuidgid abc certutil -d "sql:$nssdb" -L >/dev/null 2>&1; then
  s6-setuidgid abc certutil -d "sql:$nssdb" -N --empty-password
fi
while s6-setuidgid abc certutil -d "sql:$nssdb" -D -n localdot-cell >/dev/null 2>&1; do :; done
if [[ -s $cell/ca.pem ]]; then
  s6-setuidgid abc certutil -d "sql:$nssdb" -A -t "C,," -n localdot-cell -i "$cell/ca.pem"
fi
```
`cells/desktop/root/etc/s6-overlay/s6-rc.d/init-localdot-cell/type` holds `oneshot`, `up` holds
`/etc/s6-overlay/s6-rc.d/init-localdot-cell/run`, and `dependencies.d/init-services` is empty.

`cells/desktop/root/etc/s6-overlay/s6-rc.d/svc-forwarder/run` (mode 755):
```bash
#!/usr/bin/with-contenv bash
# The forwarder adds the cell's proxy token for every program in the cell; it must never use the
# cell's proxy variables itself, or it would send its own requests back to itself.
exec s6-setuidgid abc env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  -u NODE_USE_ENV_PROXY /opt/node/bin/node /opt/localdot/forwarder.mjs
```
`svc-forwarder/type` holds `longrun`; `svc-forwarder/dependencies.d/init-localdot-cell`,
`user/contents.d/init-localdot-cell`, `user/contents.d/svc-forwarder` and
`svc-de/dependencies.d/init-localdot-cell` are empty files. That last one makes the desktop session
(and the Chromium it starts) wait for the CA.

`cells/desktop/root/etc/profile.d/localdot-cell.sh`:
```sh
# The surrogates of this computer's web API keys (never the keys), rewritten by the daemon at every
# start and when it resumes after Stop.
if [ -r /etc/localdot/cell/surrogates.sh ]; then . /etc/localdot/cell/surrogates.sh; fi
```

`cells/desktop/cell/apt-proxy.conf`:
```text
// apt runs through sudo, which drops proxy variables: send it to the cell's forwarder.
Acquire::http::Proxy "http://127.0.0.1:3129";
Acquire::https::Proxy "http://127.0.0.1:3129";
```

`cells/desktop/cell/sudoers-proxy`:
```text
# sudo resets the environment; keep the cell's proxy and CA settings, so tools run with sudo still
# reach keyd and trust the cell's CA.
Defaults env_keep += "HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_USE_ENV_PROXY NODE_EXTRA_CA_CERTS SSL_CERT_FILE REQUESTS_CA_BUNDLE"
```

`cells/desktop/root/usr/local/bin/localdot-chromium` (replaces Part 3's):
```bash
#!/bin/bash
# localDot's Chromium launcher: maximized, with the accessibility tree and the DevTools protocol
# desktopd reads web-content boxes from (A10, D13). /usr/bin/chromium is the base image's wrapper.
# In a cell it goes through the forwarder to keyd: Chromium ignores credentials in a proxy URL, so
# the forwarder adds the token. QUIC has no route out anyway (S4).
proxy=()
if [ -n "${HTTPS_PROXY:-}" ]; then proxy=("--proxy-server=${HTTPS_PROXY}"); fi
exec /usr/bin/chromium --start-maximized --force-renderer-accessibility --remote-debugging-port=9222 \
  --disable-quic "${proxy[@]}" "$@"
```

In `cells/desktop/Dockerfile`, extend the `base` stage's `RUN chmod 755 …` line with
`/etc/s6-overlay/s6-rc.d/init-localdot-cell/run /etc/s6-overlay/s6-rc.d/svc-forwarder/run`. Then
in the final `desktop` stage, after `RUN chmod 644 /opt/localdot/desktopd.mjs`, add:
```dockerfile
# The cell's way to keyd (Part 4b). Copied here, after every apt-get of the build, which the apt
# proxy setting would otherwise send to the forwarder.
COPY desktopd/dist/forwarder.mjs /opt/localdot/forwarder.mjs
COPY cell/apt-proxy.conf /etc/apt/apt.conf.d/95localdot-proxy
COPY cell/sudoers-proxy /etc/sudoers.d/localdot-proxy
RUN chmod 644 /opt/localdot/forwarder.mjs /etc/apt/apt.conf.d/95localdot-proxy /etc/profile.d/localdot-cell.sh \
 && chmod 440 /etc/sudoers.d/localdot-proxy \
 && visudo -cf /etc/sudoers.d/localdot-proxy \
 && install -d -m 755 /etc/localdot/cell \
 && printf '\n# localDot: the surrogates of this computer'"'"'s web API keys.\n. /etc/profile.d/localdot-cell.sh\n' >> /etc/bash.bashrc
```
Then rebuild: `cells/desktop/build.sh` (it builds both `desktopd` bundles first).

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/daemon/src/cells/spec.test.ts`
Expected: PASS, with one more test than before.

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-keyd-files.docker.test.ts`
Expected: PASS, 5 tests in about 30 s:
- the CA is in the system bundle once, as a `TRUSTED CERTIFICATE` for serverAuth and never as a
  plain anchor, and in NSS as `localdot-cell C,,`;
- the forwarder runs as `abc`, on 127.0.0.1:3129 only, and answers 503 `no-gate` without a gate;
- the surrogates reach login and interactive shells, and sudo and apt keep the proxy;
- a new CA replaces the old one at the next start, and no CA file means no trust;
- with a CA the test mints in the cell, `openssl verify` accepts a TLS server leaf it signed and
  refuses a code-signing leaf (`certificate rejected`, exit 2), and curl and Python trust it for a
  TLS server on the cell's loopback.

Afterwards `docker ps -a --filter name=localdot-test-keydfiles` prints nothing.

Also run Part 2's image test again: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts`
Expected: PASS, unchanged. It starts the image with no keyd files, which the oneshot handles by
installing no CA.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add cells/desktop apps/daemon/src/cells/spec.ts apps/daemon/src/cells/spec.test.ts apps/daemon/src/cells/desktop-keyd-files.docker.test.ts
git commit -m "feat(desktop): the cell's proxy settings and its CA in the system store and NSS"
```

---

### Task 8: `desktopd`'s boot self-test, and the readiness gate that requires it

`GET /selftest` runs eleven checks in parallel, each bounded to 2 s. A check that cannot reach a
conclusion fails (fail closed).

| Check | Kind | Proves |
|---|---|---|
| `route` | isolation | `/proc/net/route` has no default route; `/proc/net/ipv6_route` has none but loopback's |
| `direct-ipv4`, `direct-ipv6` | isolation | `1.1.1.1:443` and `[2606:4700:4700::1111]:443` cannot be reached |
| `dns` | isolation | `example.com` does not resolve (c-ares, one try, so no threadpool thread is pinned) |
| `host` | isolation | Docker Desktop's host (`192.168.65.254`, and whatever `host.docker.internal` or `gateway.docker.internal` resolve to) answers on neither LM Studio's 1234 nor Ollama's 11434 |
| `gateway` | isolation | nothing holds the internal network's gateway slot (the first host address of `/proc/net/route`'s cell network): a connection to it on 53 or 80 is unreachable or times out. `connected` or `ECONNREFUSED` means an address that answers, the bridge gateway an engine that ignores isolated gateway mode leaves reachable (trust rule 1), so the check fails |
| `keyd-token` | keyd | the gate's relay without the token gets 407: the listener is keyd's, and it wants a token |
| `keyd` | keyd | the gate with the cell's token answers `http://keyd.ldot/health` with this cell's id |
| `forwarder` | keyd | the same through the forwarder on 127.0.0.1:3129 |
| `ca-system` | trust | the system bundle holds the cell's CA as a `TRUSTED CERTIFICATE` for serverAuth only (its DER followed by exactly that trust setting), and nowhere as a plain anchor, which OpenSSL would trust for code signing too |
| `ca-nss` | trust | the desktop user's NSS database holds exactly that CA as `localdot-cell` with trust `C,,` |

Results are cached for 2 s and run single-flight, because readiness asks every second.

`probeDesktopd` asks `/selftest` once `/healthz` is ok, with its own 8 s timeout, and reads it as
Part 2's readiness reads `/healthz` (as built in `cb9370f`): at most 64 KiB, and only a boolean
`ok`. A cell is ready only when the report holds each of the eleven checks exactly once, all
passing: the daemon recomputes that verdict with Task 2's `selfTestPassed`, and a missing,
oversized or malformed report counts as a failure. From this task on, a cell can
get ready only with keyd: Task 9 wires keyd into the orchestrator, Task 11 into the daemon.

**Files:**
- Create: `cells/desktop/desktopd/src/selftest.ts`, `cells/desktop/desktopd/src/selftest.test.ts`
- Modify: `cells/desktop/desktopd/src/app.ts`, `cells/desktop/desktopd/src/app.test.ts`,
  `cells/desktop/desktopd/src/main.ts`, `cells/desktop/desktopd/package.json`,
  `apps/daemon/src/cells/readiness.ts`, `apps/daemon/src/cells/readiness.test.ts`,
  `apps/daemon/src/cells/types.ts`

**Interfaces:**
- Consumes: Task 2's `SelfTestReport`, `SelfTestCheck`, `SELFTEST_CHECKS`, `SELFTEST_CHECK_IDS`
  and `selfTestPassed`; Task 6's forwarder; Task 7's environment (`LOCALDOT_CELL_ID`,
  `LOCALDOT_GATE_ADDR`), files and TLS-only system copy of the CA; Part 2's `readiness.ts` as built
  (`MAX_HEALTH_BYTES`, `readCapped`, `isHealth`, `probeStream`).
- Produces:
  - `runSelfTest(cfg, probes) → Promise<SelfTestReport>`, the `Probes` interface and `nodeProbes()`;
  - `cachedSelfTest(run, ttlMs = 2000)`, `selfTestConfigFromEnv(env)`;
  - `DesktopdDeps.selfTest?: () => Promise<SelfTestReport>`, and `GET /selftest` (bearer). Without
    a self-test wired it answers a failing report, never a pass;
  - `SELFTEST_TIMEOUT_MS = 8000` and `DesktopdHealth.selftest?: SelfTestReport`. `probeDesktopd`
    returns `{ ...health, ok: selfTestPassed(selftest), selftest }` once `/healthz` is ok.

- [ ] **Step 1: Write the failing tests**

`cells/desktop/desktopd/src/selftest.test.ts`:
```ts
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { SELFTEST_CHECK_IDS, selfTestPassed } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  cachedSelfTest,
  nodeProbes,
  type Probes,
  type ProxyReply,
  runSelfTest,
  type SelfTestConfig,
  selfTestConfigFromEnv,
} from "./selftest.ts";

const CELL = "01JXYZ0000000000000000ABCD";
const TOKEN = "j6CLzsRw79yMKkRwPznckks1fdcXOOnPN3DYp3Al_gk";
const pem = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${der.toString("base64")}\n-----END ${label}-----\n`;
const CA_DER = Buffer.from("the cell's CA, DER-encoded");
const CA = pem("CERTIFICATE", CA_DER);
// What `openssl x509 -addtrust serverAuth` writes: the DER, then trust settings for serverAuth only.
const trusted = (aux = "300c300a06082b06010505070301") =>
  pem("TRUSTED CERTIFICATE", Buffer.concat([CA_DER, Buffer.from(aux, "hex")]));
const OTHER = pem("CERTIFICATE", Buffer.from("another root"));
const cfg: SelfTestConfig = {
  ...selfTestConfigFromEnv({ LOCALDOT_CELL_ID: CELL, LOCALDOT_GATE_ADDR: "172.24.0.10" }),
  timeoutMs: 50,
};
const ROUTE_ISOLATED =
  "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\nlo\t0000007F\t00000000\t0001\t0\t0\t0\t000000FF\neth0\t000018AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n";
const ROUTE_DEFAULT = `${ROUTE_ISOLATED}eth0\t00000000\t010018AC\t0003\t0\t0\t0\t00000000\n`;

// A sealed cell as the real one answers (verified in a real topology): no route, no DNS, the gate
// reaching exactly this cell's keyd listener, and the CA in both stores.
function sealedCell(over: Partial<Probes> = {}): Probes {
  const files: Record<string, string> = {
    "/proc/net/route": ROUTE_ISOLATED,
    "/proc/net/ipv6_route":
      "00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000001 00000000 00200001       lo\n",
    [cfg.tokenFile]: `${TOKEN}\n`,
    [cfg.caFile]: CA,
    [cfg.systemBundle]: `${OTHER}${trusted()}`,
  };
  const health = (cell = CELL): ProxyReply => ({
    status: 200,
    body: JSON.stringify({ cell, ok: true }),
  });
  return {
    readFile: async (path) => files[path],
    tcpConnect: async () => "ENETUNREACH",
    resolve: async () => "ESERVFAIL",
    proxyGet: async (proxy, _url, authorization) => {
      if (proxy.port === 3129) return health();
      return authorization === `Basic ${Buffer.from(`cell:${TOKEN}`).toString("base64")}`
        ? health()
        : { status: 407, body: "" };
    },
    run: async (_cmd, args) =>
      args.includes("-a")
        ? { code: 0, stdout: CA }
        : {
            code: 0,
            stdout:
              "\nCertificate Nickname   Trust Attributes\n\nlocaldot-cell                C,,  \n",
          },
    ...over,
  };
}

const failed = async (probes: Probes) =>
  (await runSelfTest(cfg, probes)).checks.filter((c) => !c.ok).map((c) => c.id);

describe("runSelfTest", () => {
  it("passes a sealed cell, with every check the daemon requires", async () => {
    const report = await runSelfTest(cfg, sealedCell());
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(SELFTEST_CHECK_IDS);
    expect(selfTestPassed(report)).toBe(true);
  });

  it("fails on every way out of the cell, naming the check", async () => {
    const open = (target: string) => async (host: string, port: number) =>
      `${host}:${port}` === target ? "connected" : "ENETUNREACH";
    const files = sealedCell();
    expect(
      await failed(
        sealedCell({
          readFile: async (p) => (p === "/proc/net/route" ? ROUTE_DEFAULT : files.readFile(p)),
        }),
      ),
    ).toEqual(["route"]);
    expect(await failed(sealedCell({ tcpConnect: open("1.1.1.1:443") }))).toEqual(["direct-ipv4"]);
    expect(await failed(sealedCell({ tcpConnect: open("2606:4700:4700::1111:443") }))).toEqual([
      "direct-ipv6",
    ]);
    expect(
      await failed(
        sealedCell({
          resolve: async (n) => (n === "example.com" ? ["93.184.215.14"] : "ESERVFAIL"),
        }),
      ),
    ).toEqual(["dns"]);
    expect(await failed(sealedCell({ tcpConnect: open("192.168.65.254:1234") }))).toEqual(["host"]);
    expect(await failed(sealedCell({ tcpConnect: open("172.24.0.1:80") }))).toEqual(["gateway"]);
    expect(
      await failed(
        sealedCell({
          resolve: async (n) => (n === "host.docker.internal" ? ["192.168.65.7"] : "ESERVFAIL"),
          tcpConnect: open("192.168.65.7:11434"),
        }),
      ),
    ).toEqual(["host"]);
  });

  it("fails when the network's gateway address answers, even with a refusal", async () => {
    const answer = (result: string) => async (host: string, port: number) =>
      `${host}:${port}` === "172.24.0.1:53" ? result : "EHOSTUNREACH";
    expect(await failed(sealedCell({ tcpConnect: answer("ECONNREFUSED") }))).toEqual(["gateway"]);
    expect(await failed(sealedCell({ tcpConnect: answer("connected") }))).toEqual(["gateway"]);
    const quiet = await runSelfTest(cfg, sealedCell({ tcpConnect: answer("timeout") }));
    expect(quiet.checks.find((c) => c.id === "gateway")).toMatchObject({
      ok: true,
      detail: "172.24.0.1: timeout, EHOSTUNREACH",
    });
    const base = sealedCell();
    const noNetwork = sealedCell({
      readFile: async (p) =>
        p === "/proc/net/route"
          ? "Iface\tDestination\tGateway\nlo\t0000007F\t00000000\n"
          : base.readFile(p),
    });
    expect(await failed(noNetwork)).toEqual(["gateway"]);
  });

  it("fails when keyd answers without the token, for another cell, or not at all", async () => {
    const base = sealedCell();
    expect(
      await failed(
        sealedCell({
          proxyGet: async () => ({ status: 200, body: JSON.stringify({ ok: true, cell: CELL }) }),
        }),
      ),
    ).toEqual(["keyd-token"]);
    expect(
      await failed(
        sealedCell({
          proxyGet: async (proxy, url, auth, ms) =>
            auth
              ? { status: 200, body: JSON.stringify({ ok: true, cell: "another-cell" }) }
              : base.proxyGet(proxy, url, auth, ms),
        }),
      ),
    ).toEqual(["keyd"]);
    expect(await failed(sealedCell({ proxyGet: async () => "timeout" }))).toEqual([
      "keyd-token",
      "keyd",
      "forwarder",
    ]);
    expect(
      await failed(
        sealedCell({
          proxyGet: async (p, u, a, m) =>
            p.port === 3129 ? { status: 502, body: "" } : base.proxyGet(p, u, a, m),
        }),
      ),
    ).toEqual(["forwarder"]);
  });

  it("fails closed without a gate, a cell id, a token or the CA", async () => {
    const base = sealedCell();
    const without = (path: string) =>
      sealedCell({ readFile: async (p) => (p === path ? undefined : base.readFile(p)) });
    expect(
      (await runSelfTest({ ...cfg, gate: undefined }, sealedCell())).checks
        .filter((c) => !c.ok)
        .map((c) => c.id),
    ).toEqual(["keyd-token", "keyd"]);
    expect((await runSelfTest({ ...cfg, cellId: undefined }, sealedCell())).ok).toBe(false);
    expect(await failed(without(cfg.tokenFile))).toEqual(["keyd"]);
    expect(await failed(without(cfg.caFile))).toEqual(["ca-system", "ca-nss"]);
    expect(await failed(without("/proc/net/route"))).toEqual(["route", "gateway"]);
  });

  it("fails unless the system store trusts the cell's CA for TLS server auth only", async () => {
    const base = sealedCell();
    const bundle = (text: string) =>
      sealedCell({ readFile: async (p) => (p === cfg.systemBundle ? text : base.readFile(p)) });
    // A plain copy is an anchor OpenSSL trusts for code signing too, even beside the trusted one.
    expect(await failed(bundle(`${OTHER}${CA}`))).toEqual(["ca-system"]);
    expect(await failed(bundle(`${OTHER}${CA}${trusted()}`))).toEqual(["ca-system"]);
    // Trust settings for code signing (1.3.6.1.5.5.7.3.3) are not TLS server auth.
    expect(await failed(bundle(`${OTHER}${trusted("300c300a06082b06010505070303")}`))).toEqual([
      "ca-system",
    ]);
    expect(await failed(bundle(OTHER))).toEqual(["ca-system"]);
  });

  it("fails when Chromium does not trust the cell's CA, or trusts another one", async () => {
    expect(await failed(sealedCell({ run: async () => ({ code: 255, stdout: "" }) }))).toEqual([
      "ca-nss",
    ]);
    expect(
      await failed(
        sealedCell({
          run: async (_c, args) =>
            args.includes("-a")
              ? {
                  code: 0,
                  stdout: pem("CERTIFICATE", Buffer.from("an older cell CA")),
                }
              : { code: 0, stdout: "localdot-cell   C,,\n" },
        }),
      ),
    ).toEqual(["ca-nss"]);
    expect(
      await failed(
        sealedCell({
          run: async (_c, a) =>
            a.includes("-a")
              ? { code: 0, stdout: CA }
              : { code: 0, stdout: "localdot-cell   ,,\n" },
        }),
      ),
    ).toEqual(["ca-nss"]);
  });
});

describe("cachedSelfTest", () => {
  it("runs once for concurrent callers and reuses a fresh result", async () => {
    let runs = 0;
    const cached = cachedSelfTest(async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, checks: [], ms: 20 };
    }, 1000);
    await Promise.all([cached(), cached(), cached()]);
    await cached();
    expect(runs).toBe(1);
  });
});

describe("nodeProbes", () => {
  const probes = nodeProbes();

  it("tells a refused or unroutable connection from a connected one", async () => {
    const server = createServer((s) => s.end()).listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    expect(await probes.tcpConnect("127.0.0.1", port, 1000)).toBe("connected");
    server.close();
    await once(server, "close");
    expect(await probes.tcpConnect("127.0.0.1", port, 1000)).toBe("ECONNREFUSED");
  });

  it("asks a proxy for an absolute URL, with and without credentials", async () => {
    const seen: (string | undefined)[] = [];
    const server = createHttpServer((req, res) => {
      seen.push(`${req.url} ${req.headers["proxy-authorization"] ?? "-"}`);
      res.writeHead(req.headers["proxy-authorization"] ? 200 : 407);
      res.end(JSON.stringify({ ok: true, cell: CELL }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const proxy = { host: "127.0.0.1", port: (server.address() as AddressInfo).port };
    expect(await probes.proxyGet(proxy, "http://keyd.ldot/health", undefined, 1000)).toMatchObject({
      status: 407,
    });
    expect(await probes.proxyGet(proxy, "http://keyd.ldot/health", "Basic eA==", 1000)).toEqual({
      status: 200,
      body: JSON.stringify({ ok: true, cell: CELL }),
    });
    expect(seen).toEqual(["http://keyd.ldot/health -", "http://keyd.ldot/health Basic eA=="]);
    server.close();
  });

  it("reads files and runs commands without throwing", async () => {
    expect(await probes.readFile("/no/such/file")).toBeUndefined();
    expect(await probes.run("/no/such/command", [], 1000)).toMatchObject({
      code: expect.any(Number),
    });
    expect((await probes.run("echo", ["hi"], 1000)).stdout.trim()).toBe("hi");
  });
});
```

Append to `cells/desktop/desktopd/src/app.test.ts` (its `TOKEN`, `bearer` and `app(…)` helpers are
the file's own):
```ts
describe("desktopd self-test route", () => {
  it("serves the self-test behind the cell token, and fails without one wired", async () => {
    const report = {
      ok: true,
      checks: [{ id: "route", kind: "isolation" as const, ok: true, detail: "no default route" }],
      ms: 3,
    };
    const wired = createDesktopdApp({
      token: TOKEN,
      scale: 2,
      display: ":1",
      readXsettings: async () => ({ windowScalingFactor: 2, xftDpi: 96 }),
      readScreen: async () => ({ w: 2560, h: 1600 }),
      selfTest: async () => report,
    });
    expect((await wired.request("/selftest")).status).toBe(401);
    expect(await (await wired.request("/selftest", { headers: bearer })).json()).toEqual(report);
    const bare = app({ scale: 2, factor: 2, dpi: 96, screen: { w: 2560, h: 1600 } });
    expect(await (await bare.request("/selftest", { headers: bearer })).json()).toMatchObject({
      ok: false,
    });
  });
});
```

In `apps/daemon/src/cells/readiness.test.ts`, import `SELFTEST_TIMEOUT_MS` next to `probeDesktopd`
and `SELFTEST_CHECKS` from `@localdot/protocol`, and add before `describe("probeStream")` (the
file's `serve` helper, `server` variable and `notReady` are its own):
```ts
describe("probeDesktopd and the boot self-test", () => {
  const healthy: DesktopdHealth = { ...notReady, ok: true, screen: { w: 2560, h: 1600 } };
  const passing = {
    ok: true,
    ms: 16,
    checks: SELFTEST_CHECKS.map((c) => ({ ...c, ok: true, detail: "fine" })),
  };
  const answer =
    (selftest: unknown, status = 200): RequestListener =>
    (req, res) => {
      const body = req.url === "/healthz" ? healthy : selftest;
      res.writeHead(req.url === "/healthz" ? 200 : status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

  it("is ready only when the self-test passes too", async () => {
    const baseUrl = await serve(answer(passing));
    expect(await probeDesktopd({ baseUrl, token: "t" })).toEqual({
      ...healthy,
      ok: true,
      selftest: passing,
    });
  });

  it("is not ready when a check fails, even if the report claims ok", async () => {
    const lying = {
      ...passing,
      checks: passing.checks.map((c) =>
        c.id === "dns" ? { ...c, ok: false, detail: "example.com resolved" } : c,
      ),
    };
    const baseUrl = await serve(answer(lying));
    expect(await probeDesktopd({ baseUrl, token: "t" })).toMatchObject({
      ok: false,
      selftest: lying,
    });
  });

  it("is not ready when the report leaves a check out", async () => {
    const withoutDns = { ...passing, checks: passing.checks.filter((c) => c.id !== "dns") };
    const baseUrl = await serve(answer(withoutDns));
    expect(await probeDesktopd({ baseUrl, token: "t" })).toMatchObject({
      ok: false,
      selftest: withoutDns,
    });
  });

  it("reads the self-test like /healthz: past 64 KiB it counts as no report", async () => {
    const padded = {
      ...passing,
      checks: passing.checks.map((c) => ({ ...c, detail: "x".repeat(450) })),
      pad: "x".repeat(65 * 1024),
    };
    const baseUrl = await serve(answer(padded));
    expect(await probeDesktopd({ baseUrl, token: "t" })).toMatchObject({
      ok: false,
      selftest: { checks: [{ id: "selftest", ok: false }] },
    });
  });

  it("is not ready when desktopd has no self-test or answers something else", async () => {
    for (const [body, status] of [
      [{}, 404],
      [{ ok: true }, 200],
      [{ ok: true, checks: [], ms: 0 }, 200],
    ] as const) {
      const baseUrl = await serve(answer(body, status));
      expect((await probeDesktopd({ baseUrl, token: "t" }))?.ok, JSON.stringify(body)).toBe(false);
      server?.close();
    }
  });

  it("gives the self-test its own, longer timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const baseUrl = await serve(answer(passing));
    await probeDesktopd({ baseUrl, token: "t" });
    expect(timeout.mock.calls).toEqual([[3000], [SELFTEST_TIMEOUT_MS]]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run cells/desktop/desktopd/src apps/daemon/src/cells/readiness.test.ts`
Expected: FAIL. `./selftest.ts` cannot be resolved, `/selftest` answers 404, and
`SELFTEST_TIMEOUT_MS` is not exported.

- [ ] **Step 3: Write the code**

`cells/desktop/desktopd/src/selftest.ts`:
```ts
import { execFile } from "node:child_process";
import { promises as dns } from "node:dns";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import type { SelfTestCheck, SelfTestReport } from "@localdot/protocol";

// The cell's boot self-test (spec, trust rule 1 and success criterion 5): the cell reaches
// nothing but its gate, and through the gate exactly its own keyd listener, which wants its token.
// Every check fails closed: a check that cannot reach a conclusion fails.

type CheckKind = SelfTestCheck["kind"];

export interface ProxyReply {
  status: number;
  body: string;
}

// The network and file primitives, injected so the checks can be tested without a cell.
export interface Probes {
  readFile(path: string): Promise<string | undefined>;
  // "connected", or why not (an errno code or "timeout").
  tcpConnect(host: string, port: number, timeoutMs: number): Promise<string>;
  // The addresses a name resolves to through the cell's resolver, or why not.
  resolve(name: string, timeoutMs: number): Promise<string[] | string>;
  proxyGet(
    proxy: { host: string; port: number },
    url: string,
    authorization: string | undefined,
    timeoutMs: number,
  ): Promise<ProxyReply | string>;
  run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string }>;
}

export interface SelfTestConfig {
  cellId: string | undefined;
  gate: { host: string; port: number } | undefined;
  forwarder: { host: string; port: number };
  tokenFile: string;
  caFile: string;
  systemBundle: string;
  nssDb: string;
  timeoutMs: number;
}

// Addresses only a route out could reach: a public anycast resolver on both families, and Docker
// Desktop's host address, where LM Studio (1234) and Ollama (11434) would answer.
const PUBLIC_V4 = { host: "1.1.1.1", port: 443 };
const PUBLIC_V6 = { host: "2606:4700:4700::1111", port: 443 };
const PUBLIC_NAME = "example.com";
const HOST_NAMES = ["host.docker.internal", "gateway.docker.internal"];
const HOST_ADDRESS = "192.168.65.254";
const HOST_PORTS = [1234, 11434];
// The internal network's gateway slot (its first host address) on two ports: with isolated
// gateway mode nothing holds that address, so a connection is unreachable or times out; where an
// engine ignores the mode, Docker Desktop's VM holds it and connects or refuses (trust rule 1).
const GATEWAY_PORTS = [53, 80];
const HEALTH_URL = "http://keyd.ldot/health";
// The trust settings `openssl x509 -addtrust serverAuth` appends to a certificate's DER in a
// TRUSTED CERTIFICATE: serverAuth and nothing else.
const SERVER_AUTH_ONLY = Buffer.from("300c300a06082b06010505070301", "hex");

export async function runSelfTest(cfg: SelfTestConfig, probes: Probes): Promise<SelfTestReport> {
  const started = Date.now();
  const checks = await Promise.all([
    noDefaultRoute(probes),
    noDirect("direct-ipv4", PUBLIC_V4, cfg, probes),
    noDirect("direct-ipv6", PUBLIC_V6, cfg, probes),
    noDns(cfg, probes),
    noHost(cfg, probes),
    noGateway(cfg, probes),
    keydWantsToken(cfg, probes),
    keydAnswers(cfg, probes),
    forwarderAnswers(cfg, probes),
    caInSystemStore(cfg, probes),
    caInNss(cfg, probes),
  ]);
  return { ok: checks.every((c) => c.ok), checks, ms: Date.now() - started };
}

const pass = (id: string, kind: CheckKind, detail: string): SelfTestCheck => ({
  id,
  kind,
  ok: true,
  detail,
});
const fail = (id: string, kind: CheckKind, detail: string): SelfTestCheck => ({
  id,
  kind,
  ok: false,
  detail,
});

async function noDefaultRoute(probes: Probes): Promise<SelfTestCheck> {
  const v4 = await probes.readFile("/proc/net/route");
  if (v4 === undefined) return fail("route", "isolation", "cannot read /proc/net/route");
  const v4Default = v4
    .split("\n")
    .slice(1)
    .find((line) => line.split(/\s+/)[1] === "00000000");
  if (v4Default)
    return fail(
      "route",
      "isolation",
      `an IPv4 default route exists (${v4Default.split(/\s+/)[0]})`,
    );
  const v6 = await probes.readFile("/proc/net/ipv6_route");
  const v6Default = (v6 ?? "")
    .split("\n")
    .find(
      (line) =>
        line.startsWith("00000000000000000000000000000000 00 ") && !/\slo$/.test(line.trim()),
    );
  if (v6Default) return fail("route", "isolation", "an IPv6 default route exists");
  return pass(
    "route",
    "isolation",
    v6 === undefined ? "no default route; no IPv6" : "no default route",
  );
}

async function noDirect(
  id: string,
  target: { host: string; port: number },
  cfg: SelfTestConfig,
  probes: Probes,
): Promise<SelfTestCheck> {
  const result = await probes.tcpConnect(target.host, target.port, cfg.timeoutMs);
  return result === "connected"
    ? fail(id, "isolation", `${target.host}:${target.port} is reachable without keyd`)
    : pass(id, "isolation", `${target.host}:${target.port}: ${result}`);
}

async function noDns(cfg: SelfTestConfig, probes: Probes): Promise<SelfTestCheck> {
  const result = await probes.resolve(PUBLIC_NAME, cfg.timeoutMs);
  return Array.isArray(result) && result.length > 0
    ? fail("dns", "isolation", `${PUBLIC_NAME} resolved to ${result.join(", ")}`)
    : pass("dns", "isolation", `${PUBLIC_NAME}: ${Array.isArray(result) ? "no answer" : result}`);
}

async function noHost(cfg: SelfTestConfig, probes: Probes): Promise<SelfTestCheck> {
  const addresses = new Set([HOST_ADDRESS]);
  for (const name of HOST_NAMES) {
    const found = await probes.resolve(name, cfg.timeoutMs);
    if (Array.isArray(found)) for (const a of found) addresses.add(a);
  }
  const attempts = [...addresses].flatMap((host) => HOST_PORTS.map((port) => ({ host, port })));
  const results = await Promise.all(
    attempts.map((a) => probes.tcpConnect(a.host, a.port, cfg.timeoutMs)),
  );
  const open = attempts.filter((_, i) => results[i] === "connected");
  return open.length > 0
    ? fail(
        "host",
        "isolation",
        `the Mac answers at ${open.map((a) => `${a.host}:${a.port}`).join(", ")}`,
      )
    : pass("host", "isolation", `${attempts.length} host addresses unreachable`);
}

async function noGateway(cfg: SelfTestConfig, probes: Probes): Promise<SelfTestCheck> {
  const routes = await probes.readFile("/proc/net/route");
  if (routes === undefined) return fail("gateway", "isolation", "cannot read /proc/net/route");
  const slot = gatewaySlot(routes);
  if (!slot) return fail("gateway", "isolation", "no cell network in /proc/net/route");
  const results = await Promise.all(
    GATEWAY_PORTS.map((port) => probes.tcpConnect(slot, port, cfg.timeoutMs)),
  );
  const answering = GATEWAY_PORTS.filter(
    (_, i) => results[i] === "connected" || results[i] === "ECONNREFUSED",
  );
  return answering.length > 0
    ? fail(
        "gateway",
        "isolation",
        `the network's gateway ${slot} answers on ${answering.join(", ")}`,
      )
    : pass("gateway", "isolation", `${slot}: ${results.join(", ")}`);
}

// The first host address of the cell's network: the route that is neither the default one nor
// loopback's. /proc/net/route prints addresses as little-endian hex.
function gatewaySlot(routes: string): string | undefined {
  for (const line of routes.split("\n").slice(1)) {
    const [iface, destination] = line.trim().split(/\s+/);
    if (!iface || iface === "lo" || !destination || destination === "00000000") continue;
    const net = Number.parseInt(destination, 16);
    if (!Number.isInteger(net)) continue;
    const host =
      (((net & 0xff) << 24) |
        (((net >>> 8) & 0xff) << 16) |
        (((net >>> 16) & 0xff) << 8) |
        (net >>> 24)) +
      1;
    return [host >>> 24, (host >>> 16) & 0xff, (host >>> 8) & 0xff, host & 0xff].join(".");
  }
  return undefined;
}

async function keydWantsToken(cfg: SelfTestConfig, probes: Probes): Promise<SelfTestCheck> {
  if (!cfg.gate) return fail("keyd-token", "keyd", "no gate address (LOCALDOT_GATE_ADDR)");
  const reply = await probes.proxyGet(cfg.gate, HEALTH_URL, undefined, cfg.timeoutMs);
  if (typeof reply === "string") return fail("keyd-token", "keyd", `the gate: ${reply}`);
  return reply.status === 407
    ? pass("keyd-token", "keyd", "keyd refuses a request without the cell's token")
    : fail("keyd-token", "keyd", `keyd answered ${reply.status} without the cell's token`);
}

async function keydAnswers(cfg: SelfTestConfig, probes: Probes): Promise<SelfTestCheck> {
  if (!cfg.gate) return fail("keyd", "keyd", "no gate address (LOCALDOT_GATE_ADDR)");
  const token = (await probes.readFile(cfg.tokenFile))?.trim();
  if (!token) return fail("keyd", "keyd", `no proxy token in ${cfg.tokenFile}`);
  const basic = `Basic ${Buffer.from(`cell:${token}`).toString("base64")}`;
  return healthIs("keyd", cfg, await probes.proxyGet(cfg.gate, HEALTH_URL, basic, cfg.timeoutMs));
}

async function forwarderAnswers(cfg: SelfTestConfig, probes: Probes): Promise<SelfTestCheck> {
  return healthIs(
    "forwarder",
    cfg,
    await probes.proxyGet(cfg.forwarder, HEALTH_URL, undefined, cfg.timeoutMs),
  );
}

function healthIs(id: string, cfg: SelfTestConfig, reply: ProxyReply | string): SelfTestCheck {
  if (typeof reply === "string") return fail(id, "keyd", reply);
  if (reply.status !== 200) return fail(id, "keyd", `keyd.ldot answered ${reply.status}`);
  let body: { ok?: unknown; cell?: unknown };
  try {
    body = JSON.parse(reply.body) as typeof body;
  } catch {
    return fail(id, "keyd", "keyd.ldot answered something other than JSON");
  }
  if (!cfg.cellId) return fail(id, "keyd", "no cell id (LOCALDOT_CELL_ID)");
  return body.ok === true && body.cell === cfg.cellId
    ? pass(id, "keyd", `keyd knows this cell as ${cfg.cellId}`)
    : fail(id, "keyd", `keyd answered for cell ${String(body.cell)}, not ${cfg.cellId}`);
}

// The system store holds the cell's CA as a TRUSTED CERTIFICATE for TLS server auth only, and
// never as a plain one: OpenSSL trusts a plain anchor for every purpose, code signing included,
// whatever the CA's own key usage says (Part 4a carry C3).
async function caInSystemStore(cfg: SelfTestConfig, probes: Probes): Promise<SelfTestCheck> {
  const ca = derOf(await probes.readFile(cfg.caFile));
  if (!ca) return fail("ca-system", "trust", `no cell CA in ${cfg.caFile}`);
  const bundle = await probes.readFile(cfg.systemBundle);
  if (bundle === undefined) return fail("ca-system", "trust", `cannot read ${cfg.systemBundle}`);
  const blocks = pemBlocks(bundle);
  if (blocks.some((b) => b.label === "CERTIFICATE" && b.der.equals(ca))) {
    return fail("ca-system", "trust", "the system store trusts the cell's CA for every purpose");
  }
  const serverOnly = Buffer.concat([ca, SERVER_AUTH_ONLY]);
  return blocks.some((b) => b.label === "TRUSTED CERTIFICATE" && b.der.equals(serverOnly))
    ? pass("ca-system", "trust", "the system store trusts the cell's CA for TLS server auth only")
    : fail("ca-system", "trust", `the cell's CA is not in ${cfg.systemBundle} for TLS server auth`);
}

async function caInNss(cfg: SelfTestConfig, probes: Probes): Promise<SelfTestCheck> {
  const ca = derOf(await probes.readFile(cfg.caFile));
  if (!ca) return fail("ca-nss", "trust", `no cell CA in ${cfg.caFile}`);
  const db = `sql:${cfg.nssDb}`;
  const list = await probes.run("certutil", ["-d", db, "-L"], cfg.timeoutMs);
  const trusted = list.stdout
    .split("\n")
    .some((line) => /^localdot-cell\s+C,,\s*$/.test(line.trim()));
  if (list.code !== 0 || !trusted)
    return fail("ca-nss", "trust", "Chromium's NSS database does not trust localdot-cell as C,,");
  const exported = await probes.run(
    "certutil",
    ["-d", db, "-L", "-n", "localdot-cell", "-a"],
    cfg.timeoutMs,
  );
  return exported.code === 0 && derOf(exported.stdout)?.equals(ca)
    ? pass("ca-nss", "trust", "Chromium trusts the cell's CA")
    : fail("ca-nss", "trust", "Chromium's localdot-cell is another CA");
}

function pemBlocks(text: string): { label: string; der: Buffer }[] {
  return [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----([^-]*)-----END \1-----/g)].map((m) => ({
    label: m[1] ?? "",
    der: Buffer.from((m[2] ?? "").replace(/\s+/g, ""), "base64"),
  }));
}

function derOf(pem: string | undefined): Buffer | undefined {
  const der = pemBlocks(pem ?? "").find((b) => b.label === "CERTIFICATE")?.der;
  return der && der.length > 0 ? der : undefined;
}

// The real primitives. Names go through c-ares with a bounded timeout, never getaddrinfo, whose
// stuck lookups would pin libuv's small thread pool on a cell without DNS.
export function nodeProbes(): Probes {
  return {
    readFile: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    tcpConnect: (host, port, timeoutMs) =>
      new Promise<string>((resolve) => {
        const socket = connect({ host, port, timeout: timeoutMs });
        socket.once("connect", () => {
          socket.destroy();
          resolve("connected");
        });
        socket.once("timeout", () => {
          socket.destroy();
          resolve("timeout");
        });
        socket.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      }),
    resolve: async (name, timeoutMs) => {
      const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
      const found = await Promise.allSettled([resolver.resolve4(name), resolver.resolve6(name)]);
      const addresses = found.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      if (addresses.length > 0) return addresses;
      const why = found.find((r) => r.status === "rejected");
      return why?.status === "rejected"
        ? String((why.reason as NodeJS.ErrnoException).code ?? why.reason)
        : "no answer";
    },
    proxyGet: (proxy, url, authorization, timeoutMs) =>
      new Promise<ProxyReply | string>((resolve) => {
        const socket = connect({ host: proxy.host, port: proxy.port, timeout: timeoutMs });
        const chunks: Buffer[] = [];
        let size = 0;
        socket.once("connect", () => {
          const auth = authorization ? `Proxy-Authorization: ${authorization}\r\n` : "";
          socket.write(
            `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n${auth}Connection: close\r\n\r\n`,
          );
        });
        socket.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= 65_536) chunks.push(c);
        });
        socket.once("timeout", () => {
          socket.destroy();
          resolve("timeout");
        });
        socket.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
        socket.once("close", () => resolve(parseReply(Buffer.concat(chunks))));
      }),
    run: (command, args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(command, args, { timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) => {
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout) });
        });
      }),
  };
}

function parseReply(raw: Buffer): ProxyReply | string {
  const end = raw.indexOf("\r\n\r\n");
  const head = raw.subarray(0, end < 0 ? raw.length : end).toString("latin1");
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  if (status === 0) return "no HTTP reply";
  const body = end < 0 ? Buffer.alloc(0) : raw.subarray(end + 4);
  const chunked = /^transfer-encoding:\s*chunked\s*$/im.test(head);
  return { status, body: (chunked ? dechunk(body) : body).toString("utf8") };
}

function dechunk(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const nl = body.indexOf("\r\n", at);
    const size = nl < 0 ? 0 : Number.parseInt(body.subarray(at, nl).toString("latin1"), 16);
    if (!Number.isFinite(size) || size <= 0) return Buffer.concat(parts);
    parts.push(body.subarray(nl + 2, nl + 2 + size));
    at = nl + 2 + size + 2;
  }
}

// The readiness probe asks every second while a cell boots: one run at a time, and a result is
// reused for two seconds.
export function cachedSelfTest(
  run: () => Promise<SelfTestReport>,
  ttlMs = 2000,
): () => Promise<SelfTestReport> {
  let last: { at: number; report: SelfTestReport } | undefined;
  let running: Promise<SelfTestReport> | undefined;
  return () => {
    if (last && Date.now() - last.at < ttlMs) return Promise.resolve(last.report);
    running ??= run()
      .then((report) => {
        last = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
}

export function selfTestConfigFromEnv(env: NodeJS.ProcessEnv): SelfTestConfig {
  return {
    cellId: env.LOCALDOT_CELL_ID || undefined,
    gate: env.LOCALDOT_GATE_ADDR ? { host: env.LOCALDOT_GATE_ADDR, port: 3128 } : undefined,
    forwarder: { host: "127.0.0.1", port: 3129 },
    tokenFile: "/etc/localdot/cell/proxy-token",
    caFile: "/etc/localdot/cell/ca.pem",
    systemBundle: "/etc/ssl/certs/ca-certificates.crt",
    nssDb: "/config/.pki/nssdb",
    timeoutMs: 2000,
  };
}
```

In `cells/desktop/desktopd/src/app.ts`, add `import type { SelfTestReport } from "@localdot/protocol";`,
the optional dependency `selfTest?: () => Promise<SelfTestReport>;` in `DesktopdDeps`, and the route
next to `/healthz` (inside the bearer-guarded app, keeping Part 3's routes):
```ts
  // Without a self-test the cell must never look ready: report a failure, never a pass.
  app.get("/selftest", async (c) => {
    const report: SelfTestReport = deps.selfTest
      ? await deps.selfTest()
      : {
          ok: false,
          checks: [
            { id: "selftest", kind: "keyd", ok: false, detail: "this desktopd has no self-test" },
          ],
          ms: 0,
        };
    return c.json(report);
  });
```
In `cells/desktop/desktopd/src/main.ts`, import
`import { cachedSelfTest, nodeProbes, runSelfTest, selfTestConfigFromEnv } from "./selftest.ts";` and
pass to `createDesktopdApp({ … })`:
```ts
  selfTest: cachedSelfTest(() => runSelfTest(selfTestConfigFromEnv(process.env), nodeProbes())),
```
If Part 3 did not already add it, add `"@localdot/protocol": "workspace:*"` to
`cells/desktop/desktopd/package.json`'s `dependencies` and run `pnpm install`. esbuild bundles it,
so the image needs nothing more.

In `apps/daemon/src/cells/readiness.ts`, replace everything above `readCapped` with this; keep
Part 2's `readCapped`, `isHealth` and `probeStream` as they are:
```ts
import { SelfTestReport, selfTestPassed } from "@localdot/protocol";
import type { DesktopdEndpoint, DesktopdHealth, StreamEndpoint } from "./types.ts";

// desktopd runs inside the cell, so its answer is read like any other input from the cell.
const MAX_HEALTH_BYTES = 64 * 1024;
// The self-test makes network checks with their own 2 s bounds; it gets more room than /healthz.
export const SELFTEST_TIMEOUT_MS = 8000;

// Ready means healthy and through the boot self-test (spec: "the boot self-test must pass before
// the cell is marked ready"). An answer that is not a complete self-test report counts as a failure.
export async function probeDesktopd(
  endpoint: DesktopdEndpoint,
  timeoutMs = 3000,
): Promise<DesktopdHealth | undefined> {
  const health = await getJson(endpoint, "/healthz", timeoutMs);
  if (!isHealth(health)) return undefined;
  if (!health.ok) return health;
  const parsed = SelfTestReport.safeParse(
    await getJson(endpoint, "/selftest", SELFTEST_TIMEOUT_MS),
  );
  const selftest: SelfTestReport = parsed.success
    ? parsed.data
    : {
        ok: false,
        ms: 0,
        checks: [
          { id: "selftest", kind: "keyd", ok: false, detail: "desktopd gave no self-test report" },
        ],
      };
  return { ...health, ok: selfTestPassed(selftest), selftest };
}

async function getJson(
  endpoint: DesktopdEndpoint,
  path: string,
  timeoutMs: number,
): Promise<unknown> {
  try {
    const res = await fetch(`${endpoint.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const text = await readCapped(res, MAX_HEALTH_BYTES);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}
```
In `apps/daemon/src/cells/types.ts`, add `import type { SelfTestReport } from "@localdot/protocol";`
and, at the end of `DesktopdHealth`:
```ts
  // Set once /healthz is ok: the cell's boot self-test, which readiness also requires.
  selftest?: SelfTestReport;
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run cells/desktop/desktopd/src apps/daemon/src/cells/readiness.test.ts && pnpm typecheck`
Expected: PASS. `selftest.test.ts` has 11 tests, `app.test.ts` one more and `readiness.test.ts`
six more; Part 2's readiness tests (the 64 KiB cap, the boolean `ok`, the timeouts) pass
unchanged. The typecheck is clean.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add cells/desktop/desktopd apps/daemon/src/cells/readiness.ts apps/daemon/src/cells/readiness.test.ts apps/daemon/src/cells/types.ts pnpm-lock.yaml
git commit -m "feat(desktopd): boot self-test, required for a ready cell"
```

---

### Task 9: Every cell is opened in keyd before its desktop starts

`CellKeydWiring` is the orchestrator's link to keyd:
- `wire(record)` closes any cell keyd still holds under this id and opens it again on the record's
  port, with every web API key keyd has. A fresh open gives a new token, CA and surrogates. It then
  writes the three files into the stopped desktop container.
- `isWired(record)` says whether keyd still holds the cell on that port. After a keyd restart it
  does not.
- `refresh(record)` mints fresh surrogates for a running desktop and rewrites `surrogates.sh`.
  keyd mints all-or-nothing, so each key is asked for alone. A key bound to a host outside the
  cell's CA (one added after the cell opened) is skipped and returned, to be picked up at the next
  start.
- `revoke` and `close` pass through to keyd; a revoke of a cell keyd no longer knows (it
  restarted) revokes nothing and is not an error.

An offline keyd becomes `KeyLayerError` ("the key layer is offline: start keyd, then start the
computer again"), and that becomes the cell's failure text.

The orchestrator uses it in five places.
- **Starting.** `#startContainers` wires the cell before the desktop starts. A desktop that is still
  running keeps its keyd material, as when only the gate is restarted, unless keyd lost the cell;
  then the desktop is restarted with new material.
- **keyd coming back.** `rewireIfLost(id)`, queued like any other operation, does the same for a
  ready cell when keyd comes back with a new boot (Task 11 calls it). The reconcile asks keyd the
  same for each running cell before it waits for it. Part 3 runs the startup reconcile in the
  background, so keyd can answer before the reconcile reaches a cell, and a cell keyd lost while
  the daemon was away would otherwise fail its self-test until the ready timeout.
- **Isolation failures.** `#waitReady` stops the desktop at once if the self-test reports an
  isolation failure, closes the cell in keyd, and fails with the check's name. A keyd or trust
  failure only names itself in the "not ready" text.
- **Stop and remove.** These close the cell in keyd first, before Docker stops its processes. An
  offline keyd only means its cells are already gone.
- **Unreadable records** (review I1, controller carry). Part 2's store reports a folder whose
  `cell.json` can't be read as skipped, and `create()` refuses while one exists
  (`SkippedCellsError`), since that cell's keyd port may still be in use. Reconcile closes each such
  cell in keyd and stops its containers by exact name. It removes nothing, so a fixed record starts
  the cell again. Only folders in this home count: another daemon's cells (an e2e run's, or the
  user's own, which share the `localdot-` prefix) are never this daemon's to touch.

Three more fixes land here, from Part 2's latest review (controller, 2026-10-01), because keyd
knows a cell by its port:
- `create()` counts the ports of every record the orchestrator holds in memory as well as those on
  disk, so a running cell whose folder was deleted by hand keeps its port;
- `SkippedCellsError` names the folder to fix or remove (`<LOCALDOT_HOME>/cells/<id>`) and the
  containers to remove (`<prefix>*-<id>`);
- a remove marks the cell `stopping` before its first await, so the watch and readiness loops let
  go of it and no `failed: desktop container is missing` shows before `removed`.

Outside the cell, where nothing in it can fake the answer, the orchestrator refuses an internal
network whose IPAM reports a gateway address (review I4): an engine that ignores isolated gateway
mode fails the create, which is undone, and the error says to run the doctor. Self-test details
are desktopd's text, so they are clamped like any other (Part 2's `MAX_DETAIL`).

The cell store now carries the keyd port range its records may use (`LOCALDOT_KEYD_PORTS`; tests
use 4791–4797) and says where a record lives (`folder(id)`). The orchestrator allocates from that
range, so a record outside it is refused as before.

**Files:**
- Create: `apps/daemon/src/keyd/cell-wiring.ts`, `apps/daemon/src/keyd/cell-wiring.test.ts`,
  `apps/daemon/src/cells/orchestrator-keyd.test.ts`
- Modify: `apps/daemon/src/cells/orchestrator.ts`, `apps/daemon/src/cells/orchestrator.test.ts`,
  `apps/daemon/src/cells/store.ts`, `apps/daemon/src/cells/store.test.ts`,
  `apps/daemon/src/cells/orchestrator.docker.test.ts`

**Interfaces:**
- Consumes:
  - `KeydClient`, `KeydError`, `KeydUnavailableError`, `startKeyd` and `TEST_KEYD_PORTS` (Task 3);
  - `tar` and `DockerClient.putArchive`, and the fake Docker's `files` (Task 5);
  - `DesktopdHealth.selftest` (Task 8) and `SELFTEST_CHECK_IDS` (Task 2);
  - Part 2's orchestrator as built (`#queued`, `#detach`, `#current`, `#record`, `#records`,
    `#reconcile`, `#startContainers`, `#waitReady`, `#removeContainer`, `#subnet`, `objectPath`,
    `isStatus`, `clamp`, `codeOf`, `statusOf`, `cellNames`, `SkippedCellsError`), `CellStore` with
    `inventory()`, the fake Docker's `gatewayOnInternal` and `holds`, and `sampleRecord`.
- Produces:
  - `CELL_FILES_DIR = "/etc/localdot/cell"`;
  - `interface CellKeyd { wire(record); isWired(record): Promise<boolean>; refresh(record): Promise<string[]>; revoke(cellId): Promise<number>; close(cellId) }`;
  - `CellKeydWiring({ keyd, docker }) implements CellKeyd`, `KeyLayerError`, `surrogatesFile(map)`;
  - `OrchestratorDeps.keyd?: CellKeyd`, `CellOrchestrator.rewireIfLost(id): Promise<void>`;
  - `new CellStore(home, keydPorts = KEYD_PORT_RANGE)` with `store.keydPorts` and `store.folder(id)`;
  - `SkippedCellsError(cellIds, where?)`, whose message names each folder and its containers.
  - The failure texts:
    - `network isolation check failed (<id>: <detail>); the computer was stopped`;
    - `not ready after N s: self-test failed: <id>: <detail>; …`, a check left out as `<id>: missing`;
    - `network <id> has a gateway address (<ip>): this Docker Engine does not isolate internal networks; run the doctor`;
    - `remove failed: <reason>`;
    - `the key layer is offline: start keyd, then start the computer again`;
    - `the key layer restarted; reconnecting the computer`, the note shown while starting.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/keyd/cell-wiring.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerClient } from "../cells/docker.ts";
import { type FakeDocker, startFakeDocker } from "../cells/testing/fake-docker.ts";
import { sampleRecord } from "../cells/testing/sample-record.ts";
import { CELL_FILES_DIR, CellKeydWiring, KeyLayerError, surrogatesFile } from "./cell-wiring.ts";
import { KeydClient } from "./client.ts";
import { type FakeKeyd, fakeSurrogate, startFakeKeyd } from "./testing/fake-keyd.ts";

const http = (id: string) => ({ id, kind: "http" as const, createdAt: "t", updatedAt: "t" });
const HEADER = "# Surrogates for this computer's web API keys: they work only through keyd.";

describe("surrogatesFile", () => {
  it("exports each surrogate under its prefixed name, sorted", () => {
    const a = fakeSurrogate();
    const b = fakeSurrogate();
    expect(surrogatesFile({ "z-api": a, weather: b })).toBe(
      `${HEADER}\nexport LOCALDOT_KEY_WEATHER='${b}'\nexport LOCALDOT_KEY_Z_API='${a}'\n`,
    );
    expect(surrogatesFile({})).toBe(`${HEADER}\n`);
  });

  it("refuses anything a shell could read as more than a value", () => {
    expect(() => surrogatesFile({ weather: "ld_key_x'; curl evil.example #" })).toThrow(
      KeyLayerError,
    );
    expect(() => surrogatesFile({ "a;b": fakeSurrogate() })).toThrow(KeyLayerError);
  });
});

describe("CellKeydWiring.revoke", () => {
  it("revokes nothing, without an error, for a cell keyd no longer knows", async () => {
    const keyd = await startFakeKeyd();
    try {
      const docker = new DockerClient("/tmp/ld-no-docker.sock");
      const wiring = new CellKeydWiring({ keyd: new KeydClient(keyd.socketPath, 1000), docker });
      expect(await wiring.revoke("01JXYZ0000000000000000ABCD")).toBe(0);
      keyd.failures.set("POST /v1/cells/", { status: 500, code: "internal" });
      await expect(wiring.revoke("01JXYZ0000000000000000ABCD")).rejects.toMatchObject({
        code: "internal",
      });
    } finally {
      await keyd.close();
    }
  });
});

describe("CellKeydWiring.refresh", () => {
  let docker: FakeDocker;
  let keyd: FakeKeyd;
  beforeEach(async () => {
    docker = await startFakeDocker();
    keyd = await startFakeKeyd();
  });
  afterEach(async () => {
    await docker.close();
    await keyd.close();
  });

  it("mints new surrogates after a revoke, skipping a key keyd refuses for this cell", async () => {
    const record = sampleRecord("01JXYZ0000000000000000ABCD");
    docker.state.containers.set(record.docker.desktop, {
      name: record.docker.desktop,
      body: { Image: "i", HostConfig: {} },
      running: true,
      paused: false,
      exitCode: 0,
      starts: 1,
      ports: {},
      networks: {},
      files: new Map(),
    });
    keyd.records.set("weather", http("weather"));
    const client = new DockerClient(docker.socketPath);
    const wiring = new CellKeydWiring({
      keyd: new KeydClient(keyd.socketPath, 1000),
      docker: client,
    });
    await wiring.wire(record);
    expect(await wiring.revoke(record.id)).toBe(1);
    keyd.records.set("maps", http("maps"));
    // keyd refuses the first key asked for (weather, in keyd's order), as it does for a host
    // outside the cell's CA: that key waits for the next start, the other gets its surrogate.
    keyd.failures.set(`POST /v1/cells/${record.id}/surrogates`, {
      status: 400,
      code: "bad-request",
    });
    expect(await wiring.refresh(record)).toEqual(["weather"]);
    const files = docker.state.containers.get(record.docker.desktop)?.files;
    const text = files?.get(`${CELL_FILES_DIR}/surrogates.sh`)?.toString() ?? "";
    expect(text).not.toContain("LOCALDOT_KEY_WEATHER");
    expect(text).toContain(`LOCALDOT_KEY_MAPS='${keyd.cells.get(record.id)?.surrogates.maps}'`);
  });
});
```

`apps/daemon/src/cells/orchestrator-keyd.test.ts`:
```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SELFTEST_CHECKS, type SelfTestReport } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CELL_FILES_DIR, CellKeydWiring } from "../keyd/cell-wiring.ts";
import { KeydClient } from "../keyd/client.ts";
import { FAKE_CA_PEM, type FakeKeyd, startFakeKeyd } from "../keyd/testing/fake-keyd.ts";
import { DockerClient } from "./docker.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { CellStore } from "./store.ts";
import { type FakeDocker, startFakeDocker } from "./testing/fake-docker.ts";
import type { CellSummary, DesktopdHealth } from "./types.ts";

const images = { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" };
const passing: SelfTestReport = {
  ok: true,
  ms: 16,
  checks: SELFTEST_CHECKS.map((c) => ({ ...c, ok: true, detail: "fine" })),
};
const healthy: DesktopdHealth = {
  ok: true,
  scale: 2,
  display: ":1",
  screen: { w: 2560, h: 1600 },
  hidpi: {
    ok: true,
    expected: { windowScalingFactor: 2, xftDpi: 96 },
    windowScalingFactor: 2,
    xftDpi: 96,
  },
  selftest: passing,
};

let docker: FakeDocker;
let keyd: FakeKeyd;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup(
  opts: {
    probe?: () => DesktopdHealth | undefined;
    readyTimeoutMs?: number;
    gatewayOnInternal?: boolean;
  } = {},
) {
  docker = await startFakeDocker({ gatewayOnInternal: opts.gatewayOnInternal ?? false });
  keyd = await startFakeKeyd();
  const home = mkdtempSync(join(tmpdir(), "local dot's orch-keyd-"));
  const store = new CellStore(home, { from: 4791, to: 4797 });
  const client = new DockerClient(docker.socketPath);
  const orchestrator = new CellOrchestrator({
    docker: client,
    store,
    images,
    probeDesktopd: async () => (opts.probe ?? (() => healthy))(),
    probeStream: async () => true,
    sleep: async () => {},
    readyTimeoutMs: opts.readyTimeoutMs ?? 5000,
    watchEveryMs: 0,
    restartBackoffMs: [0, 0],
    keyd: new CellKeydWiring({ keyd: new KeydClient(keyd.socketPath, 1000), docker: client }),
  });
  cleanup.push(
    () => docker.close(),
    () => keyd.close(),
    () => rmSync(home, { recursive: true, force: true }),
    () => orchestrator.dispose(),
  );
  const changes: CellSummary[] = [];
  orchestrator.subscribe((c) => changes.push(c));
  const until = (pred: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => (pred() ? resolve() : setTimeout(check, 5));
      check();
    });
  const stateOf = async (id: string, state: CellSummary["state"]) => {
    await until(() => changes.some((c) => c.id === id && c.state === state));
    return changes.filter((c) => c.id === id && c.state === state).at(-1) as CellSummary;
  };
  return { orchestrator, store, changes, until, stateOf, home, client };
}

const record = { kind: "http" as const, createdAt: "t", updatedAt: "t" };

describe("CellOrchestrator with keyd", () => {
  it("opens the cell in keyd and writes its files before the desktop starts", async () => {
    const { orchestrator, store, stateOf } = await setup();
    keyd.records.set("weather", { id: "weather", ...record, hosts: ["api.weather.example"] });
    keyd.records.set("anthropic", {
      id: "anthropic",
      kind: "llm",
      provider: "anthropic",
      createdAt: "t",
      updatedAt: "t",
    });
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const r = store.get(cell.id);
    if (!r) throw new Error("no record");
    expect(r.keydPort).toBe(4791);
    expect(keyd.calls.find((c) => c.method === "POST" && c.path === "/v1/cells")?.body).toEqual({
      cellId: cell.id,
      role: "desktop",
      port: 4791,
      secrets: ["weather"],
    });
    const files = docker.state.containers.get(r.docker.desktop)?.files;
    expect(files?.get(`${CELL_FILES_DIR}/ca.pem`)?.toString()).toBe(FAKE_CA_PEM);
    expect(files?.get(`${CELL_FILES_DIR}/proxy-token`)?.toString()).toMatch(
      /^[A-Za-z0-9_-]{43}\n$/,
    );
    const surrogate = keyd.cells.get(cell.id)?.surrogates.weather;
    expect(files?.get(`${CELL_FILES_DIR}/surrogates.sh`)?.toString()).toContain(
      `export LOCALDOT_KEY_WEATHER='${surrogate}'`,
    );
    const order = docker.state.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf(`PUT /containers/${r.docker.desktop}/archive`)).toBeLessThan(
      order.indexOf(`POST /containers/${r.docker.desktop}/start`),
    );
  });

  it("will not start a computer while the key layer is offline, and says so", async () => {
    const { orchestrator, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    await orchestrator.stop(cell.id);
    await keyd.stop();
    await expect(orchestrator.start(cell.id)).rejects.toThrow("key layer is offline");
    expect(orchestrator.get(cell.id)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("start keyd"),
    });
  });

  it("closes the cell in keyd when the computer stops or is removed", async () => {
    const { orchestrator, stateOf } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    await orchestrator.stop(cell.id);
    expect(keyd.cells.has(cell.id)).toBe(false);
    await orchestrator.start(cell.id);
    await stateOf(cell.id, "ready");
    expect(keyd.cells.has(cell.id)).toBe(true);
    await orchestrator.remove(cell.id);
    expect(keyd.cells.has(cell.id)).toBe(false);
  });

  it("keeps a running desktop's keyd cell when only its gate restarts", async () => {
    const { orchestrator, store, stateOf, until } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const r = store.get(cell.id);
    const gate = docker.state.containers.get(r?.docker.gate ?? "");
    if (gate) {
      gate.running = false;
      gate.exitCode = 137;
    }
    await until(() => gate?.starts === 2 && orchestrator.get(cell.id)?.state === "ready");
    expect(keyd.calls.filter((c) => c.method === "POST" && c.path === "/v1/cells")).toHaveLength(1);
    expect(docker.state.containers.get(r?.docker.desktop ?? "")?.starts).toBe(1);
  });

  it("restarts a running desktop with new keyd files when keyd lost the cell", async () => {
    const { orchestrator, store, stateOf, until } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const r = store.get(cell.id);
    const desktop = docker.state.containers.get(r?.docker.desktop ?? "");
    const tokenBefore = desktop?.files.get(`${CELL_FILES_DIR}/proxy-token`)?.toString();
    await orchestrator.rewireIfLost(cell.id);
    expect(desktop?.starts).toBe(1);
    keyd.restart();
    await orchestrator.rewireIfLost(cell.id);
    await until(() => orchestrator.get(cell.id)?.state === "ready");
    expect(desktop?.starts).toBe(2);
    expect(keyd.cells.has(cell.id)).toBe(true);
    expect(desktop?.files.get(`${CELL_FILES_DIR}/proxy-token`)?.toString()).not.toBe(tokenBefore);
  });

  it("rewires a computer keyd lost while the daemon was away, even when keyd answered first", async () => {
    const { orchestrator, store, stateOf, client, until } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const desktop = docker.state.containers.get(store.get(cell.id)?.docker.desktop ?? "");
    orchestrator.dispose();
    keyd.restart();
    const fresh = new CellOrchestrator({
      docker: client,
      store,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
      watchEveryMs: 0,
      keyd: new CellKeydWiring({ keyd: new KeydClient(keyd.socketPath, 1000), docker: client }),
    });
    cleanup.push(() => fresh.dispose());
    // The daemon's startup reconcile runs in the background: keyd's monitor can ask about the
    // cell before the reconcile has reached it.
    await fresh.rewireIfLost(cell.id);
    await fresh.reconcile();
    await until(() => fresh.get(cell.id)?.state === "ready");
    expect(desktop?.starts).toBe(2);
    expect(keyd.cells.has(cell.id)).toBe(true);
  });

  it("stops a computer whose self-test finds a way out, naming the check", async () => {
    const breach: DesktopdHealth = {
      ...healthy,
      ok: false,
      selftest: {
        ok: false,
        ms: 9,
        checks: [
          {
            id: "dns",
            kind: "isolation",
            ok: false,
            detail: "example.com resolved to 93.184.215.14",
          },
        ],
      },
    };
    const { orchestrator, store, stateOf } = await setup({ probe: () => breach });
    const cell = await orchestrator.create({ scale: 2 });
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toBe(
      "network isolation check failed (dns: example.com resolved to 93.184.215.14); the computer was stopped",
    );
    expect(docker.state.containers.get(store.get(cell.id)?.docker.desktop ?? "")?.running).toBe(
      false,
    );
    expect(keyd.cells.has(cell.id)).toBe(false);
  });

  it("names the failing self-test check when a cell never gets ready", async () => {
    const stuck: DesktopdHealth = {
      ...healthy,
      ok: false,
      selftest: {
        ok: false,
        ms: 4,
        checks: passing.checks.map((c) =>
          c.id === "keyd" ? { ...c, ok: false, detail: "timeout" } : c,
        ),
      },
    };
    const { orchestrator, stateOf } = await setup({ probe: () => stuck, readyTimeoutMs: 30 });
    const cell = await orchestrator.create({ scale: 2 });
    expect((await stateOf(cell.id, "failed")).error).toMatch(
      /^not ready after .* s: self-test failed: keyd: timeout$/,
    );
  });

  it("stops the containers of a cell whose record can't be read, closes it in keyd, removes nothing", async () => {
    const { orchestrator, store, stateOf, home, client } = await setup();
    const lost = await orchestrator.create({ scale: 2 });
    const kept = await orchestrator.create({ scale: 2 });
    await stateOf(lost.id, "ready");
    await stateOf(kept.id, "ready");
    const names = store.get(lost.id)?.docker;
    if (!names) throw new Error("no record");
    writeFileSync(join(home, "cells", lost.id, "cell.json"), "{ not json");
    orchestrator.dispose();
    const fresh = new CellOrchestrator({
      docker: client,
      store,
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
      watchEveryMs: 0,
      keyd: new CellKeydWiring({ keyd: new KeydClient(keyd.socketPath, 1000), docker: client }),
    });
    cleanup.push(() => fresh.dispose());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await fresh.reconcile();
    } finally {
      error.mockRestore();
    }
    for (const name of [names.desktop, names.gate]) {
      expect(docker.state.containers.get(name)).toMatchObject({ running: false });
    }
    expect(docker.state.networks.has(names.internalNetwork)).toBe(true);
    expect(docker.state.volumes.has(names.homeVolume)).toBe(true);
    expect(keyd.cells.has(lost.id)).toBe(false);
    const keptRecord = store.get(kept.id);
    expect(docker.state.containers.get(keptRecord?.docker.desktop ?? "")?.running).toBe(true);
    expect(keyd.cells.has(kept.id)).toBe(true);
  });

  it("never touches a cell of another home, whatever its prefix", async () => {
    const { orchestrator, store, stateOf, client } = await setup();
    const mine = await orchestrator.create({ scale: 2 });
    await stateOf(mine.id, "ready");
    // A second daemon on another LOCALDOT_HOME (an e2e run, say), with the same name prefix.
    const otherHome = mkdtempSync(join(tmpdir(), "local dot's other-home-"));
    cleanup.push(() => rmSync(otherHome, { recursive: true, force: true }));
    const other = new CellOrchestrator({
      docker: client,
      store: new CellStore(otherHome, { from: 4791, to: 4797 }),
      images,
      probeDesktopd: async () => healthy,
      probeStream: async () => true,
      sleep: async () => {},
      watchEveryMs: 0,
      keyd: new CellKeydWiring({ keyd: new KeydClient(keyd.socketPath, 1000), docker: client }),
    });
    cleanup.push(() => other.dispose());
    await other.reconcile();
    const names = store.get(mine.id)?.docker;
    for (const name of [names?.desktop ?? "", names?.gate ?? ""]) {
      expect(docker.state.containers.get(name)).toMatchObject({ running: true });
    }
    expect(docker.state.networks.has(names?.internalNetwork ?? "")).toBe(true);
    expect(keyd.cells.has(mine.id)).toBe(true);
  });

  it("refuses an internal network that has a gateway address, and undoes the create", async () => {
    const { orchestrator, store } = await setup({ gatewayOnInternal: true });
    const err = await orchestrator.create({ scale: 2 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(
      /has a gateway address .*does not isolate internal networks/,
    );
    expect(store.list()).toEqual([]);
    expect(docker.state.networks.size).toBe(0);
    expect(docker.state.containers.size).toBe(0);
    expect(keyd.cells.size).toBe(0);
  });

  it("clamps the self-test's detail in the cell's error", async () => {
    const breach: DesktopdHealth = {
      ...healthy,
      ok: false,
      selftest: {
        ok: false,
        ms: 9,
        checks: [{ id: "dns", kind: "isolation", ok: false, detail: "x".repeat(500) }],
      },
    };
    const { orchestrator, stateOf } = await setup({ probe: () => breach });
    const cell = await orchestrator.create({ scale: 2 });
    const failed = await stateOf(cell.id, "failed");
    expect(failed.error).toBe(
      `network isolation check failed (dns: ${"x".repeat(199)}…); the computer was stopped`,
    );
  });

  it("names a check the self-test left out when a cell never gets ready", async () => {
    const partial: DesktopdHealth = {
      ...healthy,
      ok: false,
      selftest: { ...passing, checks: passing.checks.filter((c) => c.id !== "gateway") },
    };
    const { orchestrator, stateOf } = await setup({ probe: () => partial, readyTimeoutMs: 30 });
    const cell = await orchestrator.create({ scale: 2 });
    expect((await stateOf(cell.id, "failed")).error).toMatch(
      /^not ready after .* s: self-test failed: gateway: missing$/,
    );
  });
});

describe("CellOrchestrator's keyd ports and removals", () => {
  it("counts a running cell whose folder was deleted by hand when it hands out a port", async () => {
    const { orchestrator, store, stateOf, home } = await setup();
    const first = await orchestrator.create({ scale: 2 });
    await stateOf(first.id, "ready");
    expect(store.get(first.id)?.keydPort).toBe(4791);
    rmSync(join(home, "cells", first.id), { recursive: true, force: true });
    const second = await orchestrator.create({ scale: 2 });
    expect(store.get(second.id)?.keydPort).toBe(4792);
  });

  it("names the folder to fix and the containers to remove while a record can't be read", async () => {
    const { orchestrator, stateOf, home } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    writeFileSync(join(home, "cells", cell.id, "cell.json"), "{ not json");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = await orchestrator.create({ scale: 2 }).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "SkippedCellsError" });
      expect((err as Error).message).toContain(join(home, "cells", cell.id));
      expect((err as Error).message).toContain(`localdot-*-${cell.id}`);
    } finally {
      error.mockRestore();
    }
  });

  it("emits no failure while a remove runs, even as the watch finds a container gone", async () => {
    const { orchestrator, store, stateOf, changes, until } = await setup();
    const cell = await orchestrator.create({ scale: 2 });
    await stateOf(cell.id, "ready");
    const names = store.get(cell.id)?.docker;
    const gateGone = Promise.withResolvers<void>();
    docker.state.holds.set(`DELETE /containers/${names?.gate}`, gateGone.promise);
    const removed = orchestrator.remove(cell.id);
    await until(() => !docker.state.containers.has(names?.desktop ?? ""));
    // The watch loop polls without pause here: give it time to see the desktop gone.
    await new Promise((r) => setTimeout(r, 50));
    gateGone.resolve();
    await removed;
    const states = changes.filter((c) => c.id === cell.id).map((c) => c.state);
    expect(states).not.toContain("failed");
    expect(states.at(-1)).toBe("removed");
  });
});
```

Append to `apps/daemon/src/cells/store.test.ts`'s outer `describe`:
```ts
  it("keeps records in its own keyd port range only", () => {
    const home = mkdtempSync(join(tmpdir(), "local dot's store-ports-"));
    const record = sampleRecord("01JXYZ0000000000000000ABCD");
    const e2e = new CellStore(home, { from: 4791, to: 4797 });
    e2e.save({ ...record, keydPort: 4791 });
    expect(e2e.get(record.id)?.keydPort).toBe(4791);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(new CellStore(home).get(record.id)).toBeUndefined();
    } finally {
      error.mockRestore();
    }
  });
```

In `apps/daemon/src/cells/orchestrator.test.ts`, the remove now marks the cell `stopping` first:
in "lets a remove that lands while readiness awaits its probe win", the expected states become
`["starting", "starting", "stopping", "removed"]`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/daemon/src/keyd/cell-wiring.test.ts apps/daemon/src/cells/orchestrator-keyd.test.ts apps/daemon/src/cells/orchestrator.test.ts apps/daemon/src/cells/store.test.ts`
Expected: FAIL. `./cell-wiring.ts` cannot be resolved, `CellOrchestrator` takes no `keyd`,
`CellStore` takes no port range, and the remove emits no `stopping`. (Run against this plan's first
draft of the orchestrator, merged onto Part 2 as built, nine of `orchestrator-keyd.test.ts`'s 16
tests fail: the two unreadable-record tests, the gateway refusal, the clamp, the missing check,
the cached port, the folder in the error, the remove's `failed`, and the reconcile that never asks
keyd.)

- [ ] **Step 3: Write the code**

`apps/daemon/src/keyd/cell-wiring.ts`:
```ts
import { SECRET_ID_PATTERN, SURROGATE_PATTERN, surrogateEnvName } from "@localdot/protocol";
import type { DockerClient } from "../cells/docker.ts";
import { type TarFile, tar } from "../cells/tar.ts";
import type { CellRecord } from "../cells/types.ts";
import { type KeydClient, KeydError, KeydUnavailableError } from "./client.ts";

// Where a desktop cell finds what keyd gave it (the image creates the directory; its boot oneshot
// installs the CA, the forwarder reads the token, login and interactive shells source the
// surrogates). Nothing here is a secret: all of it is worthless off this Mac.
export const CELL_FILES_DIR = "/etc/localdot/cell";

// keyd is part of a cell's start: a cell without its listener has no egress and fails its boot
// self-test, so the orchestrator never starts one without it.
export interface CellKeyd {
  // Opens the cell in keyd afresh (a new token, CA and surrogates) and writes them into the
  // desktop container, which must not be running: its CA is installed at boot.
  wire(record: CellRecord): Promise<void>;
  // Whether keyd still has the cell open on its port (false after a keyd restart).
  isWired(record: CellRecord): Promise<boolean>;
  // Fresh surrogates for a running desktop (after the kill switch, or after a key changed); returns
  // the web keys keyd would not mint because the cell's CA does not cover their hosts.
  refresh(record: CellRecord): Promise<string[]>;
  revoke(cellId: string): Promise<number>;
  close(cellId: string): Promise<void>;
}

export class KeyLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyLayerError";
  }
}

export class CellKeydWiring implements CellKeyd {
  constructor(private readonly deps: { keyd: KeydClient; docker: DockerClient }) {}

  async wire(record: CellRecord): Promise<void> {
    await guard(async () => {
      const { keyd } = this.deps;
      const secrets = await this.#webSecrets();
      await keyd.closeCell(record.id);
      const opened = await keyd.openCell({
        cellId: record.id,
        role: "desktop",
        port: record.keydPort,
        secrets,
      });
      await this.#write(record, [
        { name: "proxy-token", data: `${opened.proxyToken}\n` },
        { name: "ca.pem", data: opened.caCertPem },
        { name: "surrogates.sh", data: surrogatesFile(opened.surrogates ?? {}) },
      ]);
    });
  }

  async isWired(record: CellRecord): Promise<boolean> {
    return (await this.deps.keyd.cell(record.id))?.port === record.keydPort;
  }

  // keyd mints all-or-nothing, so each key is asked for alone: a key bound to a host outside the
  // cell's CA (added after the cell opened) waits for the next start without holding up the rest.
  async refresh(record: CellRecord): Promise<string[]> {
    const skipped: string[] = [];
    await guard(async () => {
      const surrogates: Record<string, string> = {};
      for (const id of await this.#webSecrets()) {
        try {
          Object.assign(surrogates, await this.deps.keyd.mint(record.id, [id]));
        } catch (err) {
          if (!(err instanceof KeydError) || err.status !== 400) throw err;
          skipped.push(id);
        }
      }
      await this.#write(record, [{ name: "surrogates.sh", data: surrogatesFile(surrogates) }]);
    });
    return skipped;
  }

  // A cell keyd no longer knows (it restarted) has nothing left to revoke.
  async revoke(cellId: string): Promise<number> {
    try {
      return await this.deps.keyd.revoke(cellId);
    } catch (err) {
      if (err instanceof KeydError && err.status === 404) return 0;
      throw err;
    }
  }

  async close(cellId: string): Promise<void> {
    await this.deps.keyd.closeCell(cellId);
  }

  async #webSecrets(): Promise<string[]> {
    return (await this.deps.keyd.secrets()).filter((s) => s.kind === "http").map((s) => s.id);
  }

  async #write(record: CellRecord, files: TarFile[]): Promise<void> {
    await this.deps.docker.putArchive(record.docker.desktop, CELL_FILES_DIR, tar(files));
  }
}

// One `export NAME='surrogate'` line per web API key; ids and surrogates are checked again here
// because this text is sourced by a shell.
export function surrogatesFile(surrogates: Record<string, string>): string {
  const lines = Object.entries(surrogates)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      if (!SECRET_ID_PATTERN.test(id) || !SURROGATE_PATTERN.test(value)) {
        throw new KeyLayerError(`keyd returned a malformed surrogate for ${JSON.stringify(id)}`);
      }
      return `export ${surrogateEnvName(id)}='${value}'`;
    });
  return [
    "# Surrogates for this computer's web API keys: they work only through keyd.",
    ...lines,
    "",
  ].join("\n");
}

async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof KeydUnavailableError) {
      throw new KeyLayerError(
        "the key layer is offline: start keyd, then start the computer again",
      );
    }
    throw err;
  }
}
```

In `apps/daemon/src/cells/store.ts`, import `type PortRange` with `KEYD_PORT_RANGE`, give
`isCellRecord` a third parameter `keydPorts: PortRange` that replaces `KEYD_PORT_RANGE` in its
bounds check, and make the range part of the store:
```ts
  // keydPorts: the range this daemon's cells take keyd ports from (LOCALDOT_KEYD_PORTS); a record
  // outside it is not this daemon's to use.
  constructor(
    home: string,
    readonly keydPorts: PortRange = KEYD_PORT_RANGE,
  ) {
```
and in `get`, call `isCellRecord(value, id, this.keydPorts)`. After `remove`, add:
```ts
  // Where a cell's record lives: what a user fixes or removes when it can't be read.
  folder(id: string): string {
    return this.#dir(id);
  }
```

In `apps/daemon/src/cells/orchestrator.ts` (Part 2's as built, with its per-cell queue, cached
records and `SkippedCellsError`; keep anything Part 3 added):
- Imports: `SELFTEST_CHECK_IDS` next to `ulid` from `@localdot/protocol`, and
  `import type { CellKeyd } from "../keyd/cell-wiring.ts";`.
- `OrchestratorDeps` gains
  ```ts
  // The key layer (M3): a cell is opened in keyd before its desktop starts and closed with it.
  keyd?: CellKeyd;
  ```
  with a field `readonly #keyd: CellKeyd | undefined;` set in the constructor
  (`this.#keyd = deps.keyd;`). `NetworkInspect`'s IPAM config becomes
  `{ Subnet?: string; Gateway?: string }[]`.
- `SkippedCellsError` names each folder and its containers (Part 2's `api.test.ts` still builds it
  from ids alone):
  ```ts
  export class SkippedCellsError extends Error {
    constructor(
      readonly cellIds: string[],
      // Where each record lives and which containers it may still have, for the message.
      where: { folder(id: string): string; containers(id: string): string } = {
        folder: (id) => id,
        containers: (id) => `localdot-*-${id}`,
      },
    ) {
      super(
        `cell records that can't be read may still hold their keyd ports: fix or remove ${cellIds.map((id) => where.folder(id)).join(", ")}, and remove their containers (${cellIds.map((id) => where.containers(id)).join(", ")}), before creating another computer`,
      );
      this.name = "SkippedCellsError";
    }
  }
  ```
- `reconcile()` reads the store once, and stops the cells it skipped before anything else:
  ```ts
  async reconcile(): Promise<void> {
    const { records, skipped } = this.#store.inventory();
    await this.#stopSkipped(skipped);
    for (const { id } of records) {
      await this.#queued(id, () => this.#reconcile(id)).catch((err: unknown) => {
        console.error(`cell ${id}: not reconciled (${codeOf(err)})`);
      });
    }
  }
  ```
- In `create`, after `const id = ulid();`, replace the skipped check and the allocation with
  ```ts
    const { records, skipped } = this.#store.inventory();
    if (skipped.length > 0) {
      throw new SkippedCellsError(skipped, {
        folder: (cell) => this.#store.folder(cell),
        containers: (cell) => `${this.#namePrefix}*-${cell}`,
      });
    }
    // keyd tells cells apart by their listener port (M3), so the port is reserved before the first
    // await: two concurrent creates never get the same one. A cell this daemon still runs counts
    // even when its folder is gone from disk.
    const keydPort = allocateKeydPort(
      [
        ...records.map((r) => r.keydPort),
        ...[...this.#records.values()].map((r) => r.keydPort),
        ...this.#reservedKeydPorts,
      ],
      this.#store.keydPorts,
    );
  ```
- In `#provision`, the internal network's subnet is read with
  `await this.#subnet(internal.Id, { isolated: true })`.
- After `#start`, add:
  ```ts
  // keyd came up or restarted: a running cell keyd no longer knows has lost its listener, CA and
  // surrogates, so its desktop restarts with new ones. Does nothing while keyd cannot be asked.
  async rewireIfLost(id: string): Promise<void> {
    await this.#queued(id, () => this.#rewireIfLost(id));
  }

  // Resolves true when keyd had lost the cell and its restart took the cell over.
  async #rewireIfLost(id: string): Promise<boolean> {
    const live = this.#live.get(id);
    const record = this.#record(id);
    if (!record || !this.#keyd || (live?.state !== "ready" && live?.state !== "starting")) {
      return false;
    }
    const wired = await this.#keyd.isWired(record).catch(() => true);
    if (wired || !this.#current(id, live)) return false;
    const note = "the key layer restarted; reconnecting the computer";
    if (await this.#startContainers(record, live.restarts, note).catch(() => false)) {
      this.#detach(id, this.#waitReady(record));
    }
    return true;
  }
  ```
- In `#reconcile`, the running branch's `this.#detach(id, this.#waitReady(record));` becomes
  ```ts
        // The startup reconcile runs in the background, so keyd may have answered before it got
        // here: a cell keyd lost while the daemon was away is rewired now, not left failing.
        if (!(await this.#rewireIfLost(id))) this.#detach(id, this.#waitReady(record));
  ```
- In `#stop`, right after `this.#set(id, stopping);`:
  ```ts
    // keyd first: the listener goes before the processes, so a desktop Stop froze never runs
    // again with its egress open while Docker stops it (Docker stops a paused container itself).
    await this.#closeInKeyd(id);
  ```
- Replace `#remove`:
  ```ts
  async #remove(id: string, opts: { purgeHome?: boolean }): Promise<void> {
    const record = this.#require(id);
    const d = record.docker;
    const ignoreMissing = (err: unknown) => {
      if (!isStatus(err, 404)) throw err;
    };
    // Before the first await: the watch and readiness loops let go of the cell, so a poll that
    // finds a container already removed reports nothing before "removed".
    const removing: Live = { state: "stopping", restarts: 0, stream: NO_STREAM };
    this.#set(id, removing);
    await this.#closeInKeyd(id);
    try {
      for (const name of [d.desktop, d.gate]) {
        await this.#removeContainer(name).catch(ignoreMissing);
      }
      for (const name of [d.internalNetwork, d.egressNetwork]) {
        await this.#docker
          .request({ method: "DELETE", path: objectPath("networks", name) })
          .catch(ignoreMissing);
      }
      if (opts.purgeHome) {
        await this.#docker
          .request({
            method: "DELETE",
            path: objectPath("volumes", d.homeVolume),
            query: { force: "true" },
          })
          .catch(ignoreMissing);
      }
    } catch (err) {
      if (this.#current(id, removing)) {
        this.#set(id, {
          state: "failed",
          restarts: 0,
          error: `remove failed: ${messageOf(err)}`,
          stream: NO_STREAM,
        });
      }
      throw err;
    }
    this.#set(id, { state: "removed", restarts: 0, stream: NO_STREAM });
    this.#store.remove(id);
    this.#records.delete(id);
    this.#live.delete(id);
  }
  ```
- In `#startContainers`, first thing inside `try`, before the gate starts:
  ```ts
      if (this.#keyd) {
        // keyd first: a desktop boots with the CA, token and surrogates of its cell's listener. A
        // running desktop keeps its own unless keyd lost the cell, and then it restarts.
        let running = (await this.#inspect(d.desktop)).State.Running;
        if (running && !(await this.#keyd.isWired(record))) {
          await this.#stopContainer(d.desktop);
          running = false;
        }
        if (!this.#current(record.id, starting)) return false;
        if (!running) await this.#keyd.wire(record);
        if (!this.#current(record.id, starting)) return false;
      }
  ```
- In `#waitReady`, between the `if (health?.ok) { … }` branch and the `else if (health)` branch:
  ```ts
      } else if (health?.selftest) {
        // A way out of the cell is not a boot hiccup: the computer is stopped at once.
        const breach = health.selftest.checks.find((c) => c.kind === "isolation" && !c.ok);
        if (breach) {
          await this.#stopContainer(record.docker.desktop).catch(() => {});
          await this.#closeInKeyd(record.id);
          if (!this.#current(record.id, live)) return;
          this.#set(record.id, {
            ...live,
            state: "failed",
            error: `network isolation check failed (${breach.id}: ${clamp(breach.detail)}); the computer was stopped`,
          });
          return;
        }
        const { checks } = health.selftest;
        const problems = [
          ...checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`),
          ...SELFTEST_CHECK_IDS.filter((id) => !checks.some((c) => c.id === id)).map(
            (id) => `${id}: missing`,
          ),
        ];
        lastDetail = `self-test failed: ${clamp(problems.join("; "))}`;
  ```
- Before `#removeContainer`, add three helpers:
  ```ts
  // A cell whose cell.json can't be read is skipped by the store, and create() refuses while one
  // exists: its keyd port may still be in use, and keyd knows a cell by its port. Only such a cell
  // of this home is touched: keyd closes it and its containers stop, by exact name. Nothing is
  // removed, so a fixed record starts it again; an id with no folder here is another home's.
  async #stopSkipped(skipped: string[]): Promise<void> {
    for (const id of skipped) {
      const names = cellNames(id, this.#namePrefix);
      await this.#closeInKeyd(id);
      for (const name of [names.desktop, names.gate]) {
        await this.#stopContainer(name).catch((err: unknown) => {
          console.error(`cell ${id}: could not stop ${name} (${statusOf(err)})`);
        });
      }
      console.error(
        `cell ${id}: cell.json can't be read, so keyd closed the cell and its containers were stopped; fix or remove ${this.#store.folder(id)}`,
      );
    }
  }

  async #stopContainer(name: string): Promise<void> {
    await this.#docker
      .request({ method: "POST", path: objectPath("containers", name, "stop"), query: { t: "10" } })
      .catch((err) => {
        if (!isStatus(err, 304, 404)) throw err;
      });
  }

  // The cell's listener, surrogates and CA go with it; an offline keyd means they already went.
  async #closeInKeyd(id: string): Promise<void> {
    await this.#keyd
      ?.close(id)
      .catch((err: unknown) => console.error(`cell ${id}: keyd did not close it (${codeOf(err)})`));
  }
  ```
- Replace `#subnet`:
  ```ts
  async #subnet(networkId: string, opts: { isolated?: boolean } = {}): Promise<string> {
    const info = await this.#docker.request<NetworkInspect>({
      method: "GET",
      path: objectPath("networks", networkId),
    });
    const config = info.IPAM.Config[0];
    const subnet = config?.Subnet;
    if (!subnet) throw new Error(`network ${networkId} has no IPv4 subnet`);
    // Trust rule 1: no reachable gateway address. An engine that ignores isolated gateway mode
    // gives the internal network one, and Docker Desktop's VM listeners answer on it. The API
    // leaves an unset gateway out or empty; the CLI prints "invalid IP".
    const gateway = config.Gateway;
    if (opts.isolated && gateway && gateway !== "invalid IP") {
      throw new Error(
        `network ${networkId} has a gateway address (${clamp(gateway)}): this Docker Engine does not isolate internal networks; run the doctor`,
      );
    }
    return subnet;
  }
  ```

Part 2's orchestrator Docker test needs a keyd from now on: a cell is ready only through its
self-test. In `apps/daemon/src/cells/orchestrator.docker.test.ts`:
- import `SELFTEST_CHECK_IDS` from `@localdot/protocol`, `CellKeydWiring` from
  `../keyd/cell-wiring.ts`, `KeydClient` from `../keyd/client.ts`, and
  `type KeydProcess, startKeyd, TEST_KEYD_PORTS` from `../keyd/testing/keyd-process.ts`;
- declare `let keyd: KeydProcess;` beside `store` and `orchestrator`;
- make `beforeAll` async, and build the pieces with keyd:
  ```ts
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "local dot's orch-docker-"));
    keyd = await startKeyd();
    store = new CellStore(home, TEST_KEYD_PORTS);
    const docker = new DockerClient();
    orchestrator = new CellOrchestrator({
      docker,
      store,
      images: imagesFromEnv(),
      probeDesktopd,
      probeStream,
      namePrefix: PREFIX,
      keyd: new CellKeydWiring({ keyd: new KeydClient(keyd.socketPath), docker }),
    });
    orchestrator.subscribe((c) => seen.add(c.id));
  });
  ```
- end `afterAll` with `await keyd?.stop();`;
- every direct probe skips the cell's proxy settings with `--noproxy '*'`: the two name probes, and
  Part 2's three raw-address probes (`cb9370f`), which through the forwarder would reach keyd, get
  403 `ip-literal` and exit 0 instead of 7. The way through keyd has its own tests in Task 14:
  ```ts
    // --noproxy '*' skips the cell's proxy settings: the way through keyd has its own tests
    // (keyd/cell-egress.docker.test.ts).
    probe(desktop, 6, "curl", "--noproxy", "*", "-sS", "-m", "5", "https://example.com");
    probe(desktop, 6, "curl", "--noproxy", "*", "-sS", "-m", "5", "http://host.docker.internal:4750/");
  ```
  and in the raw-address loop:
  ```ts
      probe(desktop, 7, "curl", "--noproxy", "*", "-sS", "-m", "5", `http://${address}:4750/`);
  ```
- after `expect(health?.ok).toBe(true);` in the first test:
  ```ts
    expect(health?.selftest?.checks.map((c) => `${c.id}:${c.ok}`)).toEqual(
      SELFTEST_CHECK_IDS.map((check) => `${check}:true`),
    );
  ```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/daemon/src/keyd apps/daemon/src/cells`
Expected: PASS. `cell-wiring.test.ts` has 4 tests, `orchestrator-keyd.test.ts` 16 and
`store.test.ts` one more. Every other orchestrator test passes unchanged (one expects the remove's
`stopping`): an orchestrator without `keyd` behaves as before, and Part 2's own
`SkippedCellsError` test still finds the id in the message.

Rebuild the image (`cells/desktop/build.sh`), then run:
`LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/orchestrator.docker.test.ts`
Expected: PASS, every test (about 30 s). The kill-and-restart test and the concurrent stop and start
test pass with keyd: a restarted gate keeps the desktop's keyd material, and a restarted desktop gets
new material. All eleven self-test checks pass, `gateway` among them. `docker ps -a --filter
name=localdot-test-` prints nothing afterwards.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add apps/daemon/src/keyd apps/daemon/src/cells
git commit -m "feat(daemon): open each cell in keyd before its desktop starts"
```

---

### Task 10: Stop is a kill switch — revoke the cell's keys, then freeze its desktop

Part 4a's kill switch (`POST /v1/cells/{id}/revoke`) drops the cell's surrogates, ends its task,
and cancels every upstream request and tunnel. But the listener and the CA stay, so a process the
agent left running could keep using the web (P4a-R20). So Stop now runs in four steps:
1. It aborts the live session (Part 3's `LiveSessions.stop`).
2. It revokes the cell in keyd. Keys go first, so a request still in flight is cut off while the
   session winds down.
3. It waits up to 4 s for the session's run to finish the input already on its way. A frozen
   `desktopd` would hold that call until it timed out, and it could land after a resume.
4. It pauses the desktop container (Docker's freezer). Every process in it stops, the gate stays.
   If the pause fails (the cell is restarting, or Docker refuses), keyd closes the cell instead,
   so no process in it keeps surrogate-free web egress through the listener (review I2).

If keyd is down, Stop still freezes the desktop and reports what failed. A frozen computer refuses
input, launches and puppet runs with 409 until it is resumed.

Resume revokes the cell in keyd again before anything thaws, so a revoke Stop could not make still
happens and no surrogate the frozen processes hold survives (review I2). Then it thaws the desktop
and writes fresh surrogates; if keyd lost the cell meanwhile, the desktop restarts instead. With
keyd offline, Resume answers 503 and the computer stays frozen (review M9).

A frozen cell stays frozen:
- across a daemon restart;
- across a keyd restart: `rewireIfLost` leaves a frozen cell alone, and Resume rewires it
  (review C1). Restarting it would boot whatever the agent left in its home, unfrozen, with
  working surrogates;
- across a gate restart: the watch brings the gate back and keeps the desktop frozen (review M8).
  A frozen desktop that dies is not started again behind the user's back: the cell fails, and the
  user starts it.

Pausing and resuming each start a fresh watch of the cell, so a frozen cell's gate and a resumed
cell's crash are still seen. Stop computer and Remove need no thaw: Task 9 closes the cell in keyd
first, and Docker stops a paused container itself (it signals it, then resumes it).

**Files:**
- Create: `apps/daemon/src/gateway/kill-switch.ts`, `apps/daemon/src/gateway/kill-switch.test.ts`,
  `apps/daemon/src/gateway/kill-switch-routes.test.ts`
- Modify: `apps/daemon/src/gateway/live.ts`, `apps/daemon/src/gateway/routes.ts` (both Part 3's),
  `apps/daemon/src/cells/orchestrator.ts`, `apps/daemon/src/cells/types.ts`

**Interfaces:**
- Consumes:
  - Part 3's `LiveSessions`, `gatewayRoutes(app, cells, deps)`, `GatewayRoutesDeps` and
    `withReadyCell`;
  - Task 9's `CellKeyd` (`revoke`, `refresh`, `isWired`, `close`), `rewireIfLost` and
    `KeyLayerError`; Task 3's `KeydUnavailableError`;
  - Task 5's fake pause and unpause, and the fake keyd's `valid` surrogates (Task 3);
  - Part 2's `#watch`, `#exitedContainer`, `#startContainers` and `#detach`.
- Produces:
  - `LiveSessions.settled(sessionId): Promise<void>`;
  - `KillSwitch({ live, keyd, cells, settleMs = 4000 })`, with
    `stopSession(sessionId) → Promise<StopOutcome | undefined>` (where
    `StopOutcome = { revoked; paused; closed; errors: string[] }`, `closed` meaning keyd closed a
    cell that could not be frozen) and `resume(cellId)`, which throws `KeydUnavailableError` and
    leaves the computer frozen while keyd is offline;
  - `CellOrchestrator.pause(id)` (only from ready) and `unpause(id)`, both queued and each
    watching the cell afresh, and `CellSummary.paused?: true`;
  - `GatewayRoutesDeps.killSwitch?: Pick<KillSwitch, "stopSession" | "resume">`;
  - routes:
    - `POST /api/sessions/:id/stop` → 202 with the `StopOutcome` when a kill switch is wired (the
      body is empty without one, as before);
    - `POST /api/cells/:id/resume` → 204, or 409 if the computer is not paused, 400 or 404, and 503
      without a kill switch or while the key layer is offline (the computer stays frozen);
    - every `withReadyCell` route → 409 `the computer is paused: resume it first`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/gateway/kill-switch.test.ts`:
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerClient } from "../cells/docker.ts";
import { CellOrchestrator } from "../cells/orchestrator.ts";
import { CellStore } from "../cells/store.ts";
import { type FakeDocker, startFakeDocker } from "../cells/testing/fake-docker.ts";
import type { CellSummary, DesktopdHealth } from "../cells/types.ts";
import { CELL_FILES_DIR, CellKeydWiring } from "../keyd/cell-wiring.ts";
import { KeydClient, KeydUnavailableError } from "../keyd/client.ts";
import { type FakeKeyd, startFakeKeyd } from "../keyd/testing/fake-keyd.ts";
import { KillSwitch } from "./kill-switch.ts";
import { LiveSessions } from "./live.ts";

const healthy: DesktopdHealth = {
  ok: true,
  scale: 2,
  display: ":1",
  screen: { w: 2560, h: 1600 },
  hidpi: {
    ok: true,
    expected: { windowScalingFactor: 2, xftDpi: 96 },
    windowScalingFactor: 2,
    xftDpi: 96,
  },
};
const SESSION = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
// Gives up after 2 s so a test that never gets there fails on its assertions.
const until = (pred: () => boolean) =>
  new Promise<void>((resolve) => {
    const deadline = Date.now() + 2000;
    const check = () => (pred() || Date.now() > deadline ? resolve() : setTimeout(check, 5));
    check();
  });
// A session that runs until Stop aborts it.
const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));

let docker: FakeDocker;
let keyd: FakeKeyd;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function readyCell(settleMs = 200) {
  docker = await startFakeDocker();
  keyd = await startFakeKeyd();
  keyd.records.set("weather", { id: "weather", kind: "http", createdAt: "t", updatedAt: "t" });
  const home = mkdtempSync(join(tmpdir(), "local dot's kill-"));
  const client = new DockerClient(docker.socketPath);
  const wiring = new CellKeydWiring({
    keyd: new KeydClient(keyd.socketPath, 1000),
    docker: client,
  });
  const store = new CellStore(home);
  const cells = new CellOrchestrator({
    docker: client,
    store,
    images: { desktop: "d", gate: "g" },
    probeDesktopd: async () => healthy,
    probeStream: async () => true,
    sleep: async () => {},
    watchEveryMs: 60_000,
    keyd: wiring,
  });
  cleanup.push(
    () => docker.close(),
    () => keyd.close(),
    () => rmSync(home, { recursive: true, force: true }),
    () => cells.dispose(),
  );
  const changes: CellSummary[] = [];
  cells.subscribe((c) => changes.push(c));
  const cell = await cells.create({ scale: 2 });
  await new Promise<void>((resolve) => {
    const check = () => (cells.get(cell.id)?.state === "ready" ? resolve() : setTimeout(check, 5));
    check();
  });
  const live = new LiveSessions();
  const killSwitch = new KillSwitch({ live, keyd: wiring, cells, settleMs });
  const desktop = () => docker.state.containers.get(store.get(cell.id)?.docker.desktop ?? "");
  return { cells, live, killSwitch, id: cell.id, desktop, changes, store, client, wiring };
}

describe("KillSwitch.stopSession", () => {
  it("aborts the session, revokes the cell's keys, lets the run finish, then freezes the desktop", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    const timeline: string[] = [];
    live.start(id, SESSION, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      timeline.push(`aborted, keyd revoked ${keyd.cells.get(id)?.revoked}`);
      await new Promise((r) => setTimeout(r, 30));
      timeline.push(`run ended, paused ${desktop()?.paused}`);
    });
    const outcome = await killSwitch.stopSession(SESSION);
    expect(outcome).toEqual({ revoked: true, paused: true, closed: false, errors: [] });
    expect(timeline).toEqual(["aborted, keyd revoked 0", "run ended, paused false"]);
    expect(keyd.cells.get(id)).toMatchObject({ revoked: 1, surrogates: {} });
    expect(desktop()?.paused).toBe(true);
    expect(cells.get(id)).toMatchObject({ state: "ready", paused: true });
    expect(live.get(id)).toBeUndefined();
  });

  it("freezes the desktop after a bounded wait even if the run never ends", async () => {
    const { live, killSwitch, id, desktop } = await readyCell(50);
    live.start(id, SESSION, () => new Promise(() => {}));
    const started = Date.now();
    expect(await killSwitch.stopSession(SESSION)).toMatchObject({ paused: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(desktop()?.paused).toBe(true);
  });

  it("still freezes the desktop when keyd is down, and says what failed", async () => {
    const { live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await keyd.stop();
    const outcome = await killSwitch.stopSession(SESSION);
    expect(outcome).toMatchObject({ revoked: false, paused: true });
    expect(outcome?.errors.join()).toContain("keyd");
    expect(desktop()?.paused).toBe(true);
  });

  it("closes the cell in keyd when the desktop cannot be frozen, so nothing in it reaches the web", async () => {
    const { live, killSwitch, id, desktop, store } = await readyCell();
    live.start(id, SESSION, untilAborted);
    docker.state.failRequests.add(`POST /containers/${store.get(id)?.docker.desktop}/pause`);
    const outcome = await killSwitch.stopSession(SESSION);
    expect(outcome).toMatchObject({ revoked: true, paused: false, closed: true });
    expect(outcome?.errors.join()).toContain("pause");
    expect(keyd.cells.has(id)).toBe(false);
    expect(desktop()?.paused).toBe(false);
  });

  it("does nothing for a session that is not live", async () => {
    const { killSwitch } = await readyCell();
    expect(await killSwitch.stopSession(SESSION)).toBeUndefined();
  });
});

describe("KillSwitch.resume", () => {
  it("watches a resumed computer again, so a crash is restarted", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    await killSwitch.resume(id);
    const d = desktop();
    if (!d) throw new Error("no desktop");
    d.running = false;
    d.exitCode = 137;
    await until(() => d.starts === 2 && cells.get(id)?.state === "ready");
    expect(d).toMatchObject({ starts: 2, running: true });
  });

  it("thaws the desktop and writes fresh surrogates", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    const before = keyd.cells.get(id)?.surrogates.weather;
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    await killSwitch.resume(id);
    const after = keyd.cells.get(id)?.surrogates.weather;
    expect(after).toMatch(/^ld_key_/);
    expect(after).not.toBe(before);
    expect(desktop()?.paused).toBe(false);
    expect(cells.get(id)?.paused).toBeUndefined();
    expect(desktop()?.files.get(`${CELL_FILES_DIR}/surrogates.sh`)?.toString()).toContain(
      `'${after}'`,
    );
  });

  it("revokes again before it mints, so a revoke Stop could not make still holds", async () => {
    const { live, killSwitch, id } = await readyCell();
    const first = keyd.cells.get(id)?.surrogates.weather ?? "";
    live.start(id, SESSION, untilAborted);
    keyd.failures.set(`POST /v1/cells/${id}/revoke`, { status: 500, code: "internal" });
    expect(await killSwitch.stopSession(SESSION)).toMatchObject({ revoked: false, paused: true });
    expect(keyd.cells.get(id)?.valid.has(first)).toBe(true);
    await killSwitch.resume(id);
    expect(keyd.cells.get(id)?.valid.has(first)).toBe(false);
    expect(keyd.cells.get(id)?.valid.size).toBe(1);
  });

  it("keeps the computer frozen while keyd is offline, and says so", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    await keyd.stop();
    await expect(killSwitch.resume(id)).rejects.toBeInstanceOf(KeydUnavailableError);
    expect(desktop()?.paused).toBe(true);
    expect(cells.get(id)?.paused).toBe(true);
  });

  it("restarts the desktop when keyd lost the cell while it was frozen", async () => {
    const { live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    keyd.restart();
    await killSwitch.resume(id);
    expect(desktop()?.starts).toBe(2);
    expect(keyd.cells.has(id)).toBe(true);
  });
});

describe("CellOrchestrator pause", () => {
  it("only pauses a ready cell, and Stop computer stops a frozen one", async () => {
    const { cells, id, desktop } = await readyCell();
    await cells.pause(id);
    await cells.pause(id);
    expect(desktop()?.paused).toBe(true);
    await cells.stop(id);
    expect(desktop()).toMatchObject({ paused: false, running: false });
    expect(keyd.cells.has(id)).toBe(false);
    await expect(cells.pause(id)).rejects.toThrow("not ready");
  });

  it("keeps a frozen computer frozen when keyd restarts", async () => {
    const { cells, live, killSwitch, id, desktop } = await readyCell();
    live.start(id, SESSION, untilAborted);
    await killSwitch.stopSession(SESSION);
    keyd.restart();
    await cells.rewireIfLost(id);
    expect(desktop()).toMatchObject({ starts: 1, paused: true });
    expect(cells.get(id)).toMatchObject({ state: "ready", paused: true });
  });

  it("brings a frozen computer's gate back and keeps the desktop frozen", async () => {
    const { cells, id, desktop, store } = await readyCell();
    await cells.pause(id);
    const gate = docker.state.containers.get(store.get(id)?.docker.gate ?? "");
    if (!gate) throw new Error("no gate");
    gate.running = false;
    gate.exitCode = 137;
    await until(() => gate.starts === 2 && cells.get(id)?.state === "ready");
    expect(gate).toMatchObject({ starts: 2, running: true });
    expect(cells.get(id)).toMatchObject({ state: "ready", paused: true });
    expect(desktop()).toMatchObject({ starts: 1, paused: true });
  });

  it("never starts a frozen computer's desktop again behind the user's back", async () => {
    const { cells, id, desktop } = await readyCell();
    await cells.pause(id);
    const d = desktop();
    if (!d) throw new Error("no desktop");
    d.running = false;
    d.paused = false;
    d.exitCode = 137;
    await until(() => cells.get(id)?.state === "failed");
    expect(cells.get(id)).toMatchObject({
      state: "failed",
      error: "desktop container exited with 137 while it was frozen; start the computer again",
    });
    expect(cells.get(id)?.paused).toBeUndefined();
    expect(d.starts).toBe(1);
  });

  it("keeps a frozen cell frozen across a daemon restart, without probing it", async () => {
    const { cells, id, store, client, wiring } = await readyCell();
    await cells.pause(id);
    cells.dispose();
    const fresh = new CellOrchestrator({
      docker: client,
      store,
      images: { desktop: "d", gate: "g" },
      probeDesktopd: async () => undefined,
      probeStream: async () => false,
      sleep: async () => {},
      watchEveryMs: 60_000,
      keyd: wiring,
    });
    cleanup.push(() => fresh.dispose());
    await fresh.reconcile();
    expect(fresh.get(id)).toMatchObject({ state: "ready", paused: true });
  });
});
```

`apps/daemon/src/gateway/kill-switch-routes.test.ts`:
```ts
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../cells/types.ts";
import type { Clock } from "../clock.ts";
import type { DesktopdRegistry } from "../desktopd/registry.ts";
import { KeydUnavailableError } from "../keyd/client.ts";
import { LiveSessions } from "./live.ts";
import { gatewayRoutes } from "./routes.ts";

const SESSION = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const CELL = "01JXYZ0000000000000000ABCD";

// Only the routes Part 4b changes: the registry and the clock are never reached here.
function setup(paused = false, keydOffline = false) {
  const cells = new FakeOrchestrator();
  cells.emit({
    id: CELL,
    state: "ready",
    scale: 2,
    createdAt: "t",
    stream: NO_STREAM,
    ...(paused ? { paused: true as const } : {}),
  });
  const live = new LiveSessions();
  const calls: string[] = [];
  const killSwitch = {
    stopSession: async (id: string) => {
      calls.push(`stop ${id}`);
      return live.cellOf(id)
        ? { revoked: true, paused: true, closed: false, errors: [] }
        : undefined;
    },
    resume: async (id: string) => {
      calls.push(`resume ${id}`);
      if (keydOffline) throw new KeydUnavailableError("ENOENT", `/v1/cells/${id}/revoke`);
    },
  };
  const app = new Hono();
  gatewayRoutes(app, cells, {
    registry: { for: () => undefined } as unknown as DesktopdRegistry,
    clock: { nowMicros: () => 0 } as unknown as Clock,
    live,
    killSwitch,
  });
  return { app, live, calls };
}

describe("Stop, resume and a paused computer", () => {
  it("runs the kill switch on Stop and reports what it did", async () => {
    const { app, live, calls } = setup();
    live.start(CELL, SESSION, (signal) => new Promise((r) => signal.addEventListener("abort", r)));
    const res = await app.request(`/api/sessions/${SESSION}/stop`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ revoked: true, paused: true, closed: false, errors: [] });
    expect(calls).toEqual([`stop ${SESSION}`]);
    live.stop(SESSION);
    const other = await app.request("/api/sessions/01J9ZQ3V8Y7X6W5T4S3R2Q1P0Z/stop", {
      method: "POST",
    });
    expect(other.status).toBe(404);
  });

  it("refuses input to a paused computer and resumes it on request", async () => {
    const { app, calls } = setup(true);
    const input = await app.request(`/api/cells/${CELL}/input`, { method: "POST" });
    expect(input.status).toBe(409);
    expect(await input.text()).toBe("the computer is paused: resume it first");
    expect((await app.request(`/api/cells/${CELL}/resume`, { method: "POST" })).status).toBe(204);
    expect(calls).toEqual([`resume ${CELL}`]);
  });

  it("keeps a paused computer frozen with 503 while the key layer is offline", async () => {
    const { app } = setup(true, true);
    const res = await app.request(`/api/cells/${CELL}/resume`, { method: "POST" });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("the key layer is offline: start keyd, then resume the computer");
  });

  it("refuses to resume a computer that is not paused, or an unknown one", async () => {
    const { app } = setup();
    expect((await app.request(`/api/cells/${CELL}/resume`, { method: "POST" })).status).toBe(409);
    expect((await app.request("/api/cells/nope/resume", { method: "POST" })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/daemon/src/gateway/kill-switch.test.ts apps/daemon/src/gateway/kill-switch-routes.test.ts`
Expected: FAIL. `./kill-switch.ts` cannot be resolved, `GatewayRoutesDeps` has no `killSwitch`,
and the orchestrator has no `pause`. (Against this plan's first draft of the kill switch and the
orchestrator, eight of `kill-switch.test.ts`'s 15 tests fail: the frozen computer that keyd's
restart reboots (C1), the failed freeze that keeps its listener and the Resume that leaves a
first-generation surrogate valid (I2), the Resume that thaws while keyd is offline (M9), the gate
restart and the dead frozen desktop (M8), the resumed cell nobody watches, and the outcome without
`closed`.)

- [ ] **Step 3: Write the code**

`apps/daemon/src/gateway/live.ts` (replaces Part 3's. It is the same class with each run's settle
promise kept, plus `settled`):
```ts
// One live session per cell. Stop aborts it; the kill switch (kill-switch.ts) waits for its run to
// settle before it freezes the computer.
export class LiveSessions {
  readonly #byCell = new Map<
    string,
    { sessionId: string; controller: AbortController; done: Promise<void> }
  >();

  start(cellId: string, sessionId: string, run: (signal: AbortSignal) => Promise<unknown>): void {
    if (this.#byCell.has(cellId)) throw new Error(`cell ${cellId} already has a live session`);
    const controller = new AbortController();
    const done = run(controller.signal)
      .then(() => {})
      .catch((err) => console.error(`session ${sessionId}: ${String(err)}`))
      .finally(() => {
        if (this.#byCell.get(cellId)?.sessionId === sessionId) this.#byCell.delete(cellId);
      });
    this.#byCell.set(cellId, { sessionId, controller, done });
  }

  get(cellId: string): string | undefined {
    return this.#byCell.get(cellId)?.sessionId;
  }

  cellOf(sessionId: string): string | undefined {
    for (const [cellId, live] of this.#byCell) if (live.sessionId === sessionId) return cellId;
    return undefined;
  }

  stop(sessionId: string): boolean {
    const cellId = this.cellOf(sessionId);
    if (!cellId) return false;
    this.#byCell.get(cellId)?.controller.abort();
    return true;
  }

  // Resolves when the session's run has finished (at once for a session that is not live).
  settled(sessionId: string): Promise<void> {
    const cellId = this.cellOf(sessionId);
    return (cellId && this.#byCell.get(cellId)?.done) || Promise.resolve();
  }
}
```

`apps/daemon/src/gateway/kill-switch.ts`:
```ts
import { setTimeout as sleep } from "node:timers/promises";
import type { CellOrchestrator } from "../cells/orchestrator.ts";
import type { CellKeyd } from "../keyd/cell-wiring.ts";
import type { LiveSessions } from "./live.ts";

export interface KillSwitchDeps {
  live: Pick<LiveSessions, "cellOf" | "stop" | "settled">;
  keyd: Pick<CellKeyd, "revoke" | "refresh" | "isWired" | "close">;
  cells: Pick<CellOrchestrator, "get" | "record" | "pause" | "unpause" | "rewireIfLost">;
  // How long the session gets to finish the input already on its way before the desktop freezes.
  settleMs?: number;
}

export interface StopOutcome {
  revoked: boolean;
  paused: boolean;
  // The desktop could not be frozen, so keyd closed the cell: nothing in it reaches the web.
  closed: boolean;
  errors: string[];
}

// Stop (spec "Safety and control"; Part 4a ruling R20): the session is aborted, keyd drops the
// cell's surrogates, ends its task and closes its upstream connections and tunnels, and then every
// process in the desktop is frozen, so nothing the agent started keeps its web egress. keyd's
// listener and CA stay, so resuming needs only fresh surrogates.
export class KillSwitch {
  readonly #settleMs: number;

  constructor(private readonly deps: KillSwitchDeps) {
    this.#settleMs = deps.settleMs ?? 4000;
  }

  async stopSession(sessionId: string): Promise<StopOutcome | undefined> {
    const { live, keyd, cells } = this.deps;
    const cellId = live.cellOf(sessionId);
    if (!cellId) return undefined;
    const settled = live.settled(sessionId);
    live.stop(sessionId);
    const errors: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        return true;
      } catch (err) {
        errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    };
    // Keys first: a request still in flight is cut off at keyd while the session winds down.
    const revoked = await attempt("keyd", () => keyd.revoke(cellId));
    // A frozen desktopd would hold the session's last call until it timed out, and that input
    // could land after a resume; the session gets a moment to finish it first.
    await Promise.race([settled, sleep(this.#settleMs)]);
    const paused = await attempt("pause", () => cells.pause(cellId));
    // A desktop that cannot be frozen (it is restarting, or Docker failed) loses its keyd listener
    // instead, so no process the agent started keeps web egress through it.
    const closed = !paused && (await attempt("keyd close", () => keyd.close(cellId)));
    return { revoked, paused, closed, errors };
  }

  // Resume after Stop: the desktop thaws (the programs it was running carry on) and gets fresh
  // surrogates; if keyd lost the cell meanwhile, the desktop restarts with new ones instead.
  async resume(cellId: string): Promise<void> {
    const { keyd, cells } = this.deps;
    if (!cells.get(cellId)?.paused) return;
    const record = cells.record(cellId);
    if (!record) return;
    // Revoked again before anything thaws: if Stop's revoke failed, the surrogates the frozen
    // processes hold would stay valid. Without keyd this throws, and the computer stays frozen.
    await keyd.revoke(cellId);
    await cells.unpause(cellId);
    if (await keyd.isWired(record)) await keyd.refresh(record);
    else await cells.rewireIfLost(cellId);
  }
}
```

In `apps/daemon/src/gateway/routes.ts` (Part 3's):
- import `type { KillSwitch } from "./kill-switch.ts"`, and add to `GatewayRoutesDeps`:
  ```ts
    killSwitch?: Pick<KillSwitch, "stopSession" | "resume">;
  ```
- replace the stop route, and add the resume route after it:
  ```ts
  // Stop: with keyd wired, the kill switch (abort, revoke, freeze); the reply says what held.
  app.post("/api/sessions/:id/stop", async (c) => {
    const id = c.req.param("id") ?? "";
    if (!ULID_PATTERN.test(id)) return c.text("invalid session id", 400);
    if (deps.killSwitch) {
      const outcome = await deps.killSwitch.stopSession(id);
      return outcome ? c.json(outcome, 202) : c.text("no such live session", 404);
    }
    return deps.live?.stop(id) ? c.body(null, 202) : c.text("no such live session", 404);
  });

  app.post("/api/cells/:id/resume", async (c) => {
    const id = c.req.param("id") ?? "";
    if (!ULID_PATTERN.test(id)) return c.text("invalid cell id", 400);
    const cell = cells.get(id);
    if (!cell) return c.text("unknown cell", 404);
    if (!cell.paused) return c.text("the computer is not paused", 409);
    if (!deps.killSwitch) return c.text("the kill switch is not available", 503);
    try {
      await deps.killSwitch.resume(id);
    } catch (err) {
      // Resume needs keyd before anything thaws: the computer stays frozen until keyd is back.
      if (err instanceof KeydUnavailableError || err instanceof KeyLayerError) {
        return c.text("the key layer is offline: start keyd, then resume the computer", 503);
      }
      throw err;
    }
    return c.body(null, 204);
  });
  ```
  (importing `KeyLayerError` from `../keyd/cell-wiring.ts` and `KeydUnavailableError` from
  `../keyd/client.ts`);
- in `withReadyCell`, right after the `cell.state !== "ready"` check:
  ```ts
  // A frozen desktopd answers nothing: input would hang until it timed out.
  if (cell.paused) return c.text("the computer is paused: resume it first", 409);
  ```

In `apps/daemon/src/cells/types.ts`, add to `CellSummary`:
```ts
  // Frozen by Stop's kill switch until the user resumes it.
  paused?: true;
```

In `apps/daemon/src/cells/orchestrator.ts`:
- `Live` gains
  ```ts
  // Frozen by the kill switch: every process in the desktop is stopped until it is resumed.
  paused?: true;
  ```
  and `ContainerInspect`'s state becomes
  `State: { Running: boolean; Paused?: boolean; ExitCode: number; Error: string };`.
- In `#reconcile`, before the `desktop.State.Running && gate.State.Running` branch:
  ```ts
      if (desktop.State.Running && gate.State.Running && desktop.State.Paused) {
        // A cell the kill switch froze stays frozen: it was ready, and a frozen desktopd cannot
        // answer a readiness probe until it is resumed.
        const ports = await this.#readPorts(record.docker.gate);
        this.#set(id, { state: "ready", restarts: 0, ports, stream: NO_STREAM, paused: true });
        this.#detach(id, this.#watch(record));
      } else if (desktop.State.Running && gate.State.Running) {
  ```
- Before `rewireIfLost`, add:
  ```ts
  // The kill switch's second half: keyd's revoke ends the cell's keys and connections, and this
  // freezes every process in the desktop (research §3.10), so nothing the agent started keeps its
  // web egress through the listener, which stays open. The gate and its published ports stay.
  pause(id: string): Promise<void> {
    return this.#queued(id, () => this.#pause(id));
  }

  async #pause(id: string): Promise<void> {
    const record = this.#require(id);
    const live = this.#live.get(id);
    if (live?.state !== "ready") {
      throw new Error(`cell ${id} is ${live?.state ?? "stopped"}, not ready`);
    }
    if (live.paused) return;
    await this.#docker.request({
      method: "POST",
      path: objectPath("containers", record.docker.desktop, "pause"),
    });
    if (!this.#current(id, live)) return;
    this.#set(id, { ...live, paused: true });
    // Watched while frozen too: a gate that dies comes back, and the desktop stays frozen.
    this.#detach(id, this.#watch(record));
  }

  unpause(id: string): Promise<void> {
    return this.#queued(id, () => this.#unpause(id));
  }

  async #unpause(id: string): Promise<void> {
    const record = this.#require(id);
    const live = this.#live.get(id);
    if (!live?.paused) return;
    await this.#unfreeze(record);
    if (!this.#current(id, live)) return;
    this.#set(id, thawed(live));
    this.#detach(id, this.#watch(record));
  }
  ```
- `#rewireIfLost` leaves a frozen cell alone; its first lines become
  ```ts
  async #rewireIfLost(id: string): Promise<boolean> {
    const live = this.#live.get(id);
    // A computer Stop froze stays frozen through a keyd restart: Resume revokes, thaws and rewires
    // it. Restarting it here would boot whatever the agent left in its home, unfrozen.
    if (live?.paused) return false;
    const record = this.#record(id);
  ```
- `#startContainers` takes a fourth parameter: a frozen cell (only its gate died) gets its gate
  back and stays frozen. Its signature becomes
  ```ts
  // Resolves false when a stop, a remove or a newer start took the cell over while it ran. A frozen
  // cell (only its gate died) gets its gate back and stays frozen, ready for Resume.
  async #startContainers(
    record: CellRecord,
    restarts: number,
    error?: string,
    frozen = false,
  ): Promise<boolean> {
  ```
  the keyd block starts `if (this.#keyd && !frozen) {`, the desktop's start becomes
  ```ts
      if (!frozen) {
        await this.#docker.request({
          method: "POST",
          path: objectPath("containers", d.desktop, "start"),
        });
      }
  ```
  and the last `#set` becomes
  ```ts
      this.#set(
        record.id,
        frozen
          ? { state: "ready", restarts, ports, stream: NO_STREAM, paused: true }
          : { ...starting, ports },
      );
  ```
- `#exitedContainer` returns the role too: `{ role: "desktop" | "gate"; detail: string; gone: boolean }`
  (add `role,` to both objects it returns).
- In `#watch`, every `failed` it sets spreads `thawed(live)` instead of `live`. Right after the
  `exited.gone` branch:
  ```ts
      // A frozen computer's desktop is never started again behind the user's back (P4b-R6).
      if (live.paused && exited.role === "desktop") {
        this.#set(record.id, {
          ...thawed(live),
          state: "failed",
          error: `${exited.detail} while it was frozen; start the computer again`,
        });
        return;
      }
  ```
  and the restart at the end of the loop becomes
  ```ts
      const frozen = live.paused === true;
      const restarted = await this.#queued(record.id, async () =>
        this.#current(record.id, restarting)
          ? this.#startContainers(record, attempt, note, frozen)
          : false,
      ).catch(() => false);
      if (restarted)
        this.#detach(record.id, frozen ? this.#watch(record) : this.#waitReady(record));
  ```
- Next to `#stopContainer`:
  ```ts
  // Docker answers 409 when the container is not paused (any more): nothing is left to do then.
  async #unfreeze(record: CellRecord): Promise<void> {
    await this.#docker
      .request({ method: "POST", path: objectPath("containers", record.docker.desktop, "unpause") })
      .catch((err) => {
        if (!isStatus(err, 409, 404)) throw err;
      });
  }
  ```
- `#summary` ends with `...(live.paused ? { paused: true as const } : {}),`, and at the end of the
  file:
  ```ts
  function thawed(live: Live): Live {
    const { paused: _paused, ...rest } = live;
    return rest;
  }
  ```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/daemon/src/gateway apps/daemon/src/cells`
Expected: PASS. `kill-switch.test.ts` has 15 tests and `kill-switch-routes.test.ts` 4. Part 3's
route tests still pass: they wire no kill switch, so Stop answers 202 with no body, as before.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add apps/daemon/src/gateway apps/daemon/src/cells
git commit -m "feat(daemon): Stop revokes the cell's keys and freezes its desktop"
```

---

### Task 11: keyd's key use in the session log, and keyd wired into the daemon

**Events.** `KeydEventRouter` follows keyd's `GET /v1/events` stream and appends each event to the
session that is live on the event's cell:
- `key.use` and `budget.exceeded` are appended with `agent: "keyd"` (spec "Event log"; Part 4a
  "Events").
- Host, method and path are text the cell's request chose. keyd writes a surrogate in them as
  `[surrogate:<ID>]` and caps them at 2 KiB, so the router cuts them to the event's limits with
  `clipText`, which also turns control characters into spaces.
- A cell with no live session has nobody to show its events to. keyd's audit log is the record
  either way.
- A cell that floods keyd with refused requests must not flood its log, so at most 20 events a
  second per cell are appended, and the rest are counted in the daemon's log.
- When keyd stops or restarts, the stream ends, and the router reconnects with backoff (250 ms
  doubling to 5 s).

**The daemon.** `main.ts` builds the pieces once:
- the client, on `<home>/keyd/admin.sock`, and the wiring, on the Docker client Part 2's daemon
  builds from `findDockerSocket()` (so a Mac whose `/var/run/docker.sock` is off, or another Docker
  context, still works: review I6);
- the cell store and orchestrator on `LOCALDOT_KEYD_PORTS`;
- the monitor. When keyd comes up, or comes back with a new boot, every cell keyd lost is rewired
  (`rewireIfLost`). Part 3's startup reconcile runs in the background, so a cell it has not reached
  yet is passed over here; the reconcile asks keyd about it itself (Task 9);
- the kill switch, passed to the gateway routes, and the event router;
- the key routes. Their `afterChange` hands every running or booting, unfrozen computer fresh
  surrogates (`refreshRunningCells`): keyd revoked the changed key's surrogates everywhere, and a
  computer that is still starting may hold files written before the change (review M14). It says
  whether a running computer can only use the saved key after it starts again.

The e2e harness starts a keyd in the daemon's home, which is where the daemon looks for its
socket. It is the same binary as the tests', on the e2e ports, with an in-memory vault and
`-natpmp off -stun off`. Its build folder goes when the test process ends, and so does the keyd if
the test process dies first (review M6).

**Files:**
- Create: `apps/daemon/src/keyd/event-router.ts`, `apps/daemon/src/keyd/event-router.test.ts`
- Modify: `apps/daemon/src/keyd/cell-wiring.ts`, `apps/daemon/src/keyd/cell-wiring.test.ts`,
  `apps/daemon/src/main.ts`, `apps/web/e2e/daemon.ts`

**Interfaces:**
- Consumes:
  - `KeydClient.events` and `keydSocketPath` (Task 3);
  - `KeydMonitor`, `cameUp` and `KeyRoutesDeps.afterChange` (Task 4);
  - `CellKeydWiring` and `rewireIfLost` (Task 9);
  - `KillSwitch`, `LiveSessions` and `GatewayRoutesDeps.killSwitch` (Task 10);
  - `parsePortRange` (Task 3); `clipText` (Part 3); `EventLog.append` and `findDockerSocket`
    (Part 2).
- Produces:
  - `KeydEventRouter({ keyd, live, eventLog, perCellPerSecond = 20, retryMs = { min: 250, max: 5000 }, now? })`,
    with `start()`, `stop()` and `route(event)`;
  - `refreshRunningCells(cells, keyd, secretId) → Promise<{ restart: boolean }>`;
  - in the e2e harness, `RunningDaemon.keyd`, `startKeyd(home)` and `E2E_KEYD_PORTS = "4791-4797"`;
  - the daemon reads `LOCALDOT_KEYD_PORTS` and exits with `LOCALDOT_KEYD_PORTS: <reason>` on a bad
    range.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/keyd/event-router.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeydEvent } from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "../gateway/live.ts";
import { KeydClient } from "./client.ts";
import { KeydEventRouter } from "./event-router.ts";
import { type FakeKeyd, startFakeKeyd } from "./testing/fake-keyd.ts";

const CELL = "01JXYZ0000000000000000ABCD";
const use = (
  over: Partial<Extract<KeydEvent, { type: "key.use" }>["data"]> = {},
  cell = CELL,
): KeydEvent => ({
  type: "key.use",
  cell,
  time: "2026-10-01T12:00:00Z",
  data: {
    secretId: "weather",
    host: "api.weather.example",
    method: "GET",
    path: "/v1/now",
    decision: "allow",
    ...over,
  },
});

let keyd: FakeKeyd;
let eventLog: EventLog;
let live: LiveSessions;
let sessionId: string;
let router: KeydEventRouter | undefined;
beforeEach(async () => {
  keyd = await startFakeKeyd();
  eventLog = new EventLog(mkdtempSync(join(tmpdir(), "local dot's router-")));
  live = new LiveSessions();
  sessionId = eventLog.createSession("t");
  live.start(CELL, sessionId, (signal) => new Promise((r) => signal.addEventListener("abort", r)));
});
afterEach(async () => {
  router?.stop();
  live.stop(sessionId);
  await keyd.close();
});

const keyEvents = () =>
  eventLog.read(sessionId).filter((e) => e.type === "key.use" || e.type === "budget.exceeded");
const until = async (pred: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("KeydEventRouter", () => {
  it("appends key use to the cell's live session as keyd, cutting what a cell chose", () => {
    router = new KeydEventRouter({ keyd: new KeydClient(keyd.socketPath), live, eventLog });
    router.route(
      use({
        host: `evil\u0000${"x".repeat(400)}`,
        path: `/a\nb${"/c".repeat(400)}`,
        decision: "deny",
      }),
    );
    const [event] = keyEvents();
    expect(event).toMatchObject({
      type: "key.use",
      agent: "keyd",
      data: { secretId: "weather", method: "GET", decision: "deny" },
    });
    const data = event?.type === "key.use" ? event.data : undefined;
    expect([...(data?.host ?? "")]).toHaveLength(255);
    expect(data?.host.startsWith("evil x")).toBe(true);
    expect([...(data?.path ?? "")]).toHaveLength(512);
    expect([...(data?.path ?? "")].some((c) => c < " ")).toBe(false);
  });

  it("drops events for cells with no live session", () => {
    router = new KeydEventRouter({ keyd: new KeydClient(keyd.socketPath), live, eventLog });
    router.route(use({}, "01JXYZ0000000000000000ZZZZ"));
    expect(keyEvents()).toEqual([]);
  });

  it("logs at most the per-second limit for one cell and counts the rest", () => {
    let now = 1_000_000;
    router = new KeydEventRouter({
      keyd: new KeydClient(keyd.socketPath),
      live,
      eventLog,
      perCellPerSecond: 5,
      now: () => now,
    });
    for (let i = 0; i < 12; i++) router.route(use({ path: `/v1/${i}` }));
    expect(keyEvents()).toHaveLength(5);
    now += 1000;
    router.route(use({ path: "/v1/later" }));
    expect(keyEvents()).toHaveLength(6);
  });

  it("appends budget refusals for the agent loop and the budget UI", () => {
    router = new KeydEventRouter({ keyd: new KeydClient(keyd.socketPath), live, eventLog });
    router.route({
      type: "budget.exceeded",
      cell: CELL,
      time: "t",
      data: { scope: "task", taskId: "t1", limitUSD: 5, spentUSD: 5, needUSD: 0.2 },
    });
    expect(keyEvents()).toMatchObject([
      { type: "budget.exceeded", agent: "keyd", data: { scope: "task", needUSD: 0.2 } },
    ]);
  });

  it("follows keyd's stream and picks it up again after keyd restarts", async () => {
    router = new KeydEventRouter({
      keyd: new KeydClient(keyd.socketPath),
      live,
      eventLog,
      retryMs: { min: 10, max: 50 },
    });
    router.start();
    await until(() => keyd.subscribers === 1);
    keyd.publish(use({ path: "/before" }));
    await until(() => keyEvents().length === 1);
    keyd.restart();
    await until(() => keyd.subscribers === 1);
    keyd.publish(use({ path: "/after" }));
    await until(() => keyEvents().length === 2);
    expect(keyEvents().map((e) => (e.type === "key.use" ? e.data.path : ""))).toEqual([
      "/before",
      "/after",
    ]);
    router.stop();
    await until(() => keyd.subscribers === 0);
  });
});
```

In `apps/daemon/src/keyd/cell-wiring.test.ts`, add `refreshRunningCells` to the import from
`./cell-wiring.ts` and `import type { CellSummary } from "../cells/types.ts";`, and append:
```ts
describe("refreshRunningCells", () => {
  const summary = (id: string, state: CellSummary["state"], paused?: true): CellSummary => ({
    id,
    state,
    scale: 2,
    createdAt: "t",
    stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
    ...(paused ? { paused } : {}),
  });

  it("refreshes running and booting computers, and says when one must restart to use the key", async () => {
    const cells = [
      summary("A", "ready"),
      summary("B", "ready", true),
      summary("C", "stopped"),
      summary("D", "ready"),
      summary("E", "starting"),
    ];
    const refreshed: string[] = [];
    const out = await refreshRunningCells(
      { list: () => cells, record: (id) => sampleRecord(`01JXYZ000000000000000000${id}${id}`) },
      {
        refresh: async (r) => {
          refreshed.push(r.id);
          if (r.id.endsWith("DD")) throw new Error("keyd went away");
          return r.id.endsWith("AA") ? ["maps"] : [];
        },
      },
      "maps",
    );
    expect(refreshed).toEqual([
      "01JXYZ000000000000000000AA",
      "01JXYZ000000000000000000DD",
      "01JXYZ000000000000000000EE",
    ]);
    expect(out).toEqual({ restart: true });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/daemon/src/keyd/event-router.test.ts apps/daemon/src/keyd/cell-wiring.test.ts`
Expected: FAIL. `./event-router.ts` cannot be resolved, and `refreshRunningCells` is not exported.

- [ ] **Step 3: Write the code**

`apps/daemon/src/keyd/event-router.ts`:
```ts
import { setTimeout as sleep } from "node:timers/promises";
import { clipText, type EventDraft, type KeydEvent } from "@localdot/protocol";
import type { EventLog } from "../event-log.ts";
import type { LiveSessions } from "../gateway/live.ts";
import type { KeydClient } from "./client.ts";

export interface KeydEventRouterDeps {
  keyd: Pick<KeydClient, "events">;
  live: Pick<LiveSessions, "get">;
  eventLog: Pick<EventLog, "append">;
  // A cell that floods keyd with refused requests must not flood its session's log: past this
  // many events a second the rest are counted, and keyd's audit log keeps every one.
  perCellPerSecond?: number;
  retryMs?: { min: number; max: number };
  now?: () => number;
}

// keyd's key.use and budget.exceeded events, into the live session of the cell they belong to
// (spec "Event log": key.use comes from keyd's audit). A cell with no live session has nobody to
// show them to; keyd's audit log is the record either way.
export class KeydEventRouter {
  readonly #deps: KeydEventRouterDeps;
  readonly #limit: number;
  readonly #window = new Map<string, { second: number; count: number; dropped: number }>();
  #abort: AbortController | undefined;

  constructor(deps: KeydEventRouterDeps) {
    this.#deps = deps;
    this.#limit = deps.perCellPerSecond ?? 20;
  }

  start(): void {
    if (this.#abort) return;
    const abort = new AbortController();
    this.#abort = abort;
    const { min, max } = this.#deps.retryMs ?? { min: 250, max: 5000 };
    void (async () => {
      let wait = min;
      while (!abort.signal.aborted) {
        const opened = Date.now();
        await this.#deps.keyd.events((e) => this.route(e), abort.signal).catch(() => {});
        if (abort.signal.aborted) return;
        // keyd stopped or restarted; a stream that lasted a while starts the backoff again.
        wait = Date.now() - opened > max ? min : Math.min(wait * 2, max);
        await sleep(wait, undefined, { signal: abort.signal }).catch(() => {});
      }
    })();
  }

  stop(): void {
    this.#abort?.abort();
    this.#abort = undefined;
  }

  route(event: KeydEvent): void {
    if (event.type === "events.dropped") {
      console.warn(`keyd: ${event.data.count} events dropped; its audit log has them`);
      return;
    }
    const sessionId = this.#deps.live.get(event.cell);
    if (!sessionId || !this.#admit(event.cell)) return;
    const draft: EventDraft =
      event.type === "key.use"
        ? {
            type: "key.use",
            agent: "keyd",
            data: {
              secretId: clipText(event.data.secretId, 64),
              host: clipText(event.data.host, 255),
              method: clipText(event.data.method, 16),
              path: clipText(event.data.path, 512),
              decision: event.data.decision,
            },
          }
        : { type: "budget.exceeded", agent: "keyd", data: event.data };
    try {
      this.#deps.eventLog.append(sessionId, draft);
    } catch (err) {
      console.error(`keyd event for session ${sessionId}: ${String(err)}`);
    }
  }

  #admit(cell: string): boolean {
    const second = Math.floor((this.#deps.now ?? Date.now)() / 1000);
    let w = this.#window.get(cell);
    if (!w || w.second !== second) {
      if (w?.dropped)
        console.warn(
          `keyd: ${w.dropped} events of cell ${cell} not logged (more than ${this.#limit}/s)`,
        );
      w = { second, count: 0, dropped: 0 };
      this.#window.set(cell, w);
    }
    if (w.count >= this.#limit) {
      w.dropped += 1;
      return false;
    }
    w.count += 1;
    return true;
  }
}
```

In `apps/daemon/src/keyd/cell-wiring.ts`, add `import type { CellOrchestrator } from "../cells/orchestrator.ts";`
and, before `surrogatesFile`:
```ts
// After a key is saved or deleted (keyd revoked that key's surrogates everywhere), every running
// or booting desktop gets fresh surrogates; a frozen one gets them when it is resumed. `restart`
// says whether a running computer cannot use the saved key until it starts again.
export async function refreshRunningCells(
  cells: Pick<CellOrchestrator, "list" | "record">,
  keyd: Pick<CellKeyd, "refresh">,
  secretId: string,
): Promise<{ restart: boolean }> {
  let restart = false;
  for (const cell of cells.list()) {
    const running = (cell.state === "ready" || cell.state === "starting") && !cell.paused;
    const record = running ? cells.record(cell.id) : undefined;
    if (!record) continue;
    try {
      if ((await keyd.refresh(record)).includes(secretId)) restart = true;
    } catch (err) {
      console.error(`keys: computer ${cell.id} keeps its old surrogates: ${String(err)}`);
    }
  }
  return { restart };
}

```

In `apps/daemon/src/main.ts` (Part 3's), keeping everything else:
- imports:
  ```ts
  import { parsePortRange } from "./cells/ports.ts";
  import { KillSwitch } from "./gateway/kill-switch.ts";
  import { CellKeydWiring, refreshRunningCells } from "./keyd/cell-wiring.ts";
  import { KeydClient, keydSocketPath } from "./keyd/client.ts";
  import { KeydEventRouter } from "./keyd/event-router.ts";
  import { cameUp, KeydMonitor } from "./keyd/monitor.ts";
  ```
- replace the orchestrator's construction (Part 2's daemon already finds Docker's socket this way:
  keep it):
  ```ts
  const docker = new DockerClient(findDockerSocket().path);
  const keyd = new KeydClient(keydSocketPath(home));
  const keydWiring = new CellKeydWiring({ keyd, docker });
  const orchestrator = new CellOrchestrator({
    docker,
    store: new CellStore(home, keydPortsFromEnv()),
    images: imagesFromEnv(),
    probeDesktopd,
    probeStream,
    keyd: keydWiring,
  });
  ```
- before `createApp`, one `LiveSessions` for the gateway, the kill switch and the event router:
  ```ts
  const live = new LiveSessions();
  const killSwitch = new KillSwitch({ live, keyd: keydWiring, cells: orchestrator });
  const keydMonitor = new KeydMonitor(keyd);
  // A keyd that restarted has lost every cell: running computers get a new listener, CA and
  // surrogates, which means restarting their desktops.
  keydMonitor.subscribe((now, before) => {
    if (!cameUp(now, before)) return;
    for (const cell of orchestrator.list()) {
      void orchestrator
        .rewireIfLost(cell.id)
        .catch((err) => console.error(`keyd: computer ${cell.id}: ${String(err)}`));
    }
  });
  keydMonitor.start();
  const keydEvents = new KeydEventRouter({ keyd, live, eventLog });
  keydEvents.start();
  ```
- in `createApp`'s options, the gateway gets `live` (instead of `new LiveSessions()`) and
  `killSwitch`, and the key routes join:
  ```ts
    gateway: { registry, clock, eventLog, gateway, frames: new FrameStore(home), live, killSwitch },
    keys: {
      keyd,
      monitor: keydMonitor,
      afterChange: (id) => refreshRunningCells(orchestrator, keydWiring, id),
    },
  ```
- next to `portFromEnv`:
  ```ts
  function keydPortsFromEnv() {
    try {
      return parsePortRange(process.env.LOCALDOT_KEYD_PORTS);
    } catch (err) {
      return fail(`LOCALDOT_KEYD_PORTS: ${(err as Error).message}`);
    }
  }
  ```

In `apps/web/e2e/daemon.ts`:
- import `mkdirSync` and `rmSync` with the other `node:fs` imports;
- after `E2E_PORT`:
  ```ts
  // keyd's listeners for e2e cells: clear of the e2e daemon (4790) and of a real keyd (4760-4789).
  export const E2E_KEYD_PORTS = "4791-4797";
  ```
- add `keyd: RunningKeyd;` to `RunningDaemon`, and before `startDaemon`:
  ```ts
  export interface RunningKeyd {
    socketPath: string;
    stop(): Promise<void>;
  }

  // keyd from this checkout (or LOCALDOT_KEYD_BIN) with an in-memory vault, in the daemon's home,
  // where the daemon looks for its socket. Its ready line says the socket is up.
  export async function startKeyd(home: string): Promise<RunningKeyd> {
    let bin = process.env.LOCALDOT_KEYD_BIN;
    if (!bin) {
      const dir = mkdtempSync(join(tmpdir(), "localdot-e2e-keyd-"));
      process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
      bin = join(dir, "keyd");
      execFileSync(process.env.GO ?? "go", ["build", "-o", bin, "./cmd/keyd"], {
        cwd: join(REPO, "keyd"),
        stdio: ["ignore", "ignore", "inherit"],
      });
    }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const child = spawn(
      bin,
      // Nothing leaves the Mac: neither the router nor STUN is asked for the public address.
      ["-home", home, "-vault", "memory", "-ports", E2E_KEYD_PORTS, "-natpmp", "off", "-stun", "off"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    // A test run that dies takes its keyd with it.
    const killOnExit = () => child.kill("SIGKILL");
    process.once("exit", killOnExit);
    let stderr = "";
    const socketPath = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`keyd not ready within 15 s:\n${stderr}`)),
        15_000,
      );
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        const ready = /^keyd ready socket=(.+) boot=[0-9a-f]{16}$/m.exec(stderr);
        if (ready?.[1]) {
          clearTimeout(timer);
          resolve(ready[1]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`keyd exited with ${code}:\n${stderr}`));
      });
    });
    const stop = async () => {
      process.removeListener("exit", killOnExit);
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    };
    return { socketPath, stop };
  }
  ```
- in `startDaemon`, start keyd first (`const keyd = await startKeyd(home);` right after `home` is
  chosen), pass `LOCALDOT_KEYD_PORTS: E2E_KEYD_PORTS` in the daemon's environment (before `...env`),
  end `stop()` with `await keyd.stop();`, and return `{ origin, token, home, keyd, stop }`.

The e2e home is `join(mkdtempSync(join(tmpdir(), "local dot's e2e-")), "home")`. That puts keyd's
socket at about 92 bytes, under macOS's 104.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/daemon/src && pnpm typecheck`
Expected: PASS. `event-router.test.ts` has 5 tests and `cell-wiring.test.ts` 5. Part 3's
`main.test.ts` still gets `/healthz` while a wedged Docker holds the reconcile: nothing keyd adds
to `main.ts` waits on keyd or Docker. The typecheck is clean, the web e2e folder included.

Then run the daemon by hand against a throwaway keyd, in two terminals:
```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot" && mkdir -p /tmp/ld-dev && pnpm keyd -home /tmp/ld-dev -vault memory -natpmp off -stun off
cd "/Volumes/Husky's SSD 4T/Projects/localdot/apps/daemon" && LOCALDOT_HOME=/tmp/ld-dev node --import tsx src/main.ts
```
Expected:
- keyd prints `keyd ready socket=/tmp/ld-dev/keyd/admin.sock boot=…`, and the daemon prints its URL;
- `curl -s -H "authorization: Bearer $(cat /tmp/ld-dev/daemon-token)" http://127.0.0.1:4750/api/keyd`
  prints `{"online":true,…,"hairpin":{"state":"off","addresses":0}}`;
- `LOCALDOT_HOME=/tmp/ld-dev pnpm --filter @localdot/daemon run doctor` prints an `ok` line for
  `keyd` and a `FAIL` line for `hairpin-guard` (`off: …`), and exits 1;
- stop keyd with Ctrl-C, and the same request prints `{"online":false,…}`.

Stop the daemon and `rm -rf /tmp/ld-dev`.

Then: `LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e live-desktop.spec.ts`
Expected: PASS as before. The harness's keyd lets the cell pass its self-test.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add apps/daemon/src apps/web/e2e/daemon.ts
git commit -m "feat(daemon): keyd's key use in the session log, and keyd wired into the daemon"
```

---

### Task 12a: The key form's logic — the binding, the seal and the key layer's state

The key form (Task 12b) is split from its logic, which this task builds and tests on its own
(review M10):
- **The binding.** `bindingOf(draft)` turns what the form holds into the `SecretBinding` the key is
  sealed for, and names the field to fix. A model provider takes a name and a provider (Anthropic,
  OpenAI, Google Gemini, OpenAI-compatible, Azure OpenAI); the last two also take an `https://`
  base URL, sent as `new URL(x).href`, so the binding the browser seals is byte for byte the one
  keyd rebuilds. A web API takes a name, hosts, a header (default `Authorization`) and how the key
  is sent (Bearer, as is, Basic as user or password). Methods and paths stay API-only (P4b-R9).
  `valueProblem` refuses a value outside 8–8,192 printable ASCII characters.
- **Saving.** `saveKey` reads `/api/keyd`'s seal key, seals the value with WebCrypto and posts only
  `{ binding, sealed }`. On `409 bad-seal` (keyd restarted in between) it seals once more.
  `problemText` turns the daemon's refusals (`name-taken` among them) into a sentence.
- **The key layer's state.** `useKeys` polls `/api/keyd` every 5 s and reloads the list on a new
  boot or a change. `keyStatus` gives the top bar's label: `Keys`, `Key layer offline` (spec
  "Error handling"), `Keys on hold` while keyd cannot write its audit log, and the state `guard`
  (label `Keys`) while the hairpin guard is anything but `active` (P4b-C2).

**Files:**
- Create: `apps/web/src/keys/binding.ts`, `apps/web/src/keys/keys-api.ts`,
  `apps/web/src/keys/useKeys.ts`, `apps/web/src/keys/binding.test.ts`,
  `apps/web/src/keys/keys-api.test.ts`

**Interfaces:**
- Consumes:
  - `sealSecret`, `SecretBinding`, `HairpinGuard`, `PRINTABLE_ASCII`, `SECRET_ID_PATTERN`,
    `RESERVED_SECRET_IDS`, `LLM_PROVIDERS` and `HTTP_FORMATS` (Task 2);
  - `/api/keyd`, `/api/keys` and `DELETE /api/keys/:id` (Task 4);
  - Part 2's `ApiClient` and `ApiError`.
- Produces:
  - from `binding.ts`: `KeyDraft`, `EMPTY_DRAFT`, `bindingOf(draft) → DraftCheck`,
    `valueProblem(value)`, `describeKey(record)`, `PROVIDER_NAMES`, `FORMAT_NAMES`, `needsBaseURL`;
  - from `keys-api.ts`: `KeydHealth` (with `hairpin?`), `KeyRecord`, `KeyProblem`, `loadHealth`,
    `loadKeys`, `saveKey(api, binding, value, seal?) → { key; restart }`, `deleteKey`,
    `problemText(err)`;
  - from `useKeys.ts`: `useKeys(api, everyMs = 5000) → KeysController { health; keys; loadError; save; remove }`,
    `keyStatus(health) → { label; state: "unknown" | "ok" | "offline" | "audit" | "guard" }`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/keys/binding.test.ts`:
```ts
import { bindingJson, SecretBinding } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { bindingOf, describeKey, EMPTY_DRAFT, type KeyDraft, valueProblem } from "./binding.ts";

const draft = (over: Partial<KeyDraft>): KeyDraft => ({ ...EMPTY_DRAFT, ...over });

describe("bindingOf", () => {
  it("builds a preset provider's binding with no base URL", () => {
    expect(
      bindingOf(draft({ id: " anthropic ", provider: "anthropic", baseURL: "https://x.test" })),
    ).toEqual({
      ok: true,
      binding: { id: "anthropic", kind: "llm", provider: "anthropic" },
    });
  });

  it("sends a base URL as the URL parser writes it, so the sealed binding is printable ASCII", () => {
    const check = bindingOf(
      draft({
        id: "groq",
        provider: "openai-compatible",
        baseURL: " https://API.groq.com/openai/v1 ",
      }),
    );
    expect(check).toEqual({
      ok: true,
      binding: {
        id: "groq",
        kind: "llm",
        provider: "openai-compatible",
        baseURL: "https://api.groq.com/openai/v1",
      },
    });
    const unicode = bindingOf(
      draft({ id: "b", provider: "azure", baseURL: "https://bücher.example/v1/ x" }),
    );
    expect(unicode.ok && unicode.binding.kind === "llm" ? unicode.binding.baseURL : "").toBe(
      "https://xn--bcher-kva.example/v1/%E2%80%A8x",
    );
    if (unicode.ok) expect(() => bindingJson(unicode.binding)).not.toThrow();
  });

  it("refuses base URLs keyd would refuse", () => {
    for (const baseURL of [
      "",
      "http://api.example.com/v1",
      "https://u:p@api.example.com",
      "https://api.example.com:8443/v1",
      "https://api.example.com/v1?x=1",
      "https://api.example.com/#a",
      "not a url",
    ]) {
      expect(bindingOf(draft({ id: "x", provider: "openai-compatible", baseURL }))).toMatchObject({
        ok: false,
        field: "baseURL",
      });
    }
  });

  it("splits, lower-cases and de-duplicates hosts, and keeps the header as typed", () => {
    expect(
      bindingOf(
        draft({
          kind: "http",
          id: "weather",
          hosts: "API.weather.example, api.weather.example\nmaps.example",
          header: "X-Api-Key",
          format: "raw",
        }),
      ),
    ).toEqual({
      ok: true,
      binding: {
        id: "weather",
        kind: "http",
        hosts: ["api.weather.example", "maps.example"],
        header: "X-Api-Key",
        format: "raw",
      },
    });
  });

  it("names the field to fix", () => {
    expect(bindingOf(draft({ id: "Weather" }))).toMatchObject({ ok: false, field: "id" });
    expect(bindingOf(draft({ id: "lmstudio" }))).toMatchObject({ ok: false, field: "id" });
    expect(bindingOf(draft({ kind: "http", id: "w", hosts: "" }))).toMatchObject({
      ok: false,
      field: "hosts",
    });
    expect(
      bindingOf(draft({ kind: "http", id: "w", hosts: "https://api.example.com/v1" })),
    ).toMatchObject({ ok: false, field: "hosts" });
    expect(bindingOf(draft({ kind: "http", id: "w", hosts: "10.0.0.1" }))).toMatchObject({
      ok: false,
      field: "hosts",
    });
    expect(
      bindingOf(draft({ kind: "http", id: "w", hosts: "a.example", header: "X Key" })),
    ).toMatchObject({ ok: false, field: "header" });
    expect(
      bindingOf(
        draft({ kind: "http", id: "w", hosts: "a.example", header: "X-Key", format: "basic-user" }),
      ),
    ).toMatchObject({ ok: false, field: "header" });
  });

  it("only ever produces bindings the daemon accepts", () => {
    const samples = [
      draft({ id: "a" }),
      draft({ id: "g", provider: "google" }),
      draft({ kind: "http", id: "w", hosts: "a.example", format: "basic-password" }),
    ];
    for (const d of samples) {
      const check = bindingOf(d);
      expect(check.ok && SecretBinding.safeParse(check.binding).success).toBe(true);
    }
  });
});

describe("valueProblem", () => {
  it("accepts 8 to 8192 printable ASCII characters", () => {
    expect(valueProblem("sk-ant-0123")).toBeUndefined();
    expect(valueProblem("x".repeat(8192))).toBeUndefined();
    for (const bad of ["short", "x".repeat(8193), "sk-ant-é123456", "sk-ant\t0123456"]) {
      expect(valueProblem(bad)).toBeDefined();
    }
  });
});

describe("describeKey", () => {
  it("reads as the provider, or the hosts and header", () => {
    expect(describeKey({ kind: "llm", provider: "anthropic" })).toBe("Anthropic");
    expect(
      describeKey({
        kind: "llm",
        provider: "openai-compatible",
        baseURL: "https://api.groq.com/openai/v1",
      }),
    ).toBe("OpenAI-compatible · api.groq.com");
    expect(
      describeKey({ kind: "http", hosts: ["a.example", "b.example"], header: "Authorization" }),
    ).toBe("a.example, b.example · Authorization");
  });
});
```

`apps/web/src/keys/keys-api.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { deleteKey, KeyProblem, problemText, saveKey } from "./keys-api.ts";
import { keyStatus } from "./useKeys.ts";

const binding = {
  id: "weather",
  kind: "http" as const,
  hosts: ["api.weather.example"],
  header: "Authorization",
  format: "bearer" as const,
};
const record = { id: "weather", kind: "http" as const, createdAt: "t", updatedAt: "t" };

function fakeApi(replies: ((path: string, body?: unknown) => unknown)[]) {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const next = (method: string, path: string, body?: unknown) => {
    sent.push({ method, path, body });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected ${method} ${path}`);
    return Promise.resolve().then(() => reply(path, body));
  };
  const api: ApiClient = {
    get: <T>(path: string) => next("GET", path) as Promise<T>,
    post: <T>(path: string, body?: unknown) => next("POST", path, body) as Promise<T>,
    del: async (path: string) => {
      await next("DELETE", path);
    },
    socketUrl: (p) => p,
    socketProtocols: () => [],
  };
  return { api, sent };
}

const online = (sealKey: string) => () => ({ online: true, bootId: "b", sealKey });
const fakeSeal = async (key: string, _b: unknown, value: string) => ({
  v: 1 as const,
  epk: key,
  nonce: "n",
  ct: `sealed(${value.length})`,
});

describe("saveKey", () => {
  it("seals to keyd's current key and sends only the binding and the ciphertext", async () => {
    const { api, sent } = fakeApi([online("K1"), () => ({ key: record, restart: false })]);
    expect(await saveKey(api, binding, "sk-weather-123", fakeSeal)).toEqual({
      key: record,
      restart: false,
    });
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /api/keyd", "POST /api/keys"]);
    expect(sent[1]?.body).toEqual({
      binding,
      sealed: { v: 1, epk: "K1", nonce: "n", ct: "sealed(14)" },
    });
    expect(JSON.stringify(sent)).not.toContain("sk-weather-123");
  });

  it("seals once more when keyd restarted between reading its key and storing", async () => {
    const badSeal = () => {
      throw new ApiError(409, JSON.stringify({ error: "bad-seal", message: "seal the key again" }));
    };
    const { api, sent } = fakeApi([
      online("K1"),
      badSeal,
      online("K2"),
      () => ({ key: record, restart: true }),
    ]);
    expect(await saveKey(api, binding, "sk-weather-123", fakeSeal)).toMatchObject({
      restart: true,
    });
    const resent = sent[3]?.body as { sealed: { epk: string } } | undefined;
    expect(resent?.sealed.epk).toBe("K2");
  });

  it("refuses to seal while the key layer is offline", async () => {
    const { api } = fakeApi([() => ({ online: false, error: "connect ENOENT" })]);
    await expect(saveKey(api, binding, "sk-weather-123", fakeSeal)).rejects.toBeInstanceOf(
      KeyProblem,
    );
  });
});

describe("problemText", () => {
  it("turns the daemon's refusals into a sentence", () => {
    expect(
      problemText(
        new ApiError(
          400,
          JSON.stringify({
            error: "bad-binding",
            message: 'keys: header "Cookie" cannot carry a key',
          }),
        ),
      ),
    ).toBe('Header "Cookie" cannot carry a key.');
    expect(problemText(new ApiError(503, "offline"))).toBe("The key layer is offline: start keyd.");
    expect(problemText(new Error("boom"))).toBe("Something went wrong saving the key. Try again.");
  });
});

describe("deleteKey", () => {
  it("names the key in the path", async () => {
    const { api, sent } = fakeApi([() => undefined]);
    await deleteKey(api, "weather");
    expect(sent).toEqual([{ method: "DELETE", path: "/api/keys/weather", body: undefined }]);
  });
});

describe("keyStatus", () => {
  const active = { state: "active" as const, source: "nat-pmp", addresses: 1 };

  it("says the key layer is offline, on hold, or unsure of the public address", () => {
    expect(keyStatus(null)).toEqual({ label: "Keys", state: "unknown" });
    expect(keyStatus({ online: false })).toEqual({ label: "Key layer offline", state: "offline" });
    expect(keyStatus({ online: true, audit: { ok: false }, hairpin: active })).toEqual({
      label: "Keys on hold",
      state: "audit",
    });
    for (const hairpin of [{ state: "unknown" as const, addresses: 0 }, undefined]) {
      expect(keyStatus({ online: true, audit: { ok: true }, hairpin }).state).toBe("guard");
    }
    expect(keyStatus({ online: true, audit: { ok: true }, hairpin: active })).toEqual({
      label: "Keys",
      state: "ok",
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/web/src/keys`
Expected: FAIL. `./binding.ts`, `./keys-api.ts` and `./useKeys.ts` cannot be resolved.

- [ ] **Step 3: Write the code**

`apps/web/src/keys/binding.ts`:
```ts
import {
  type HTTP_FORMATS,
  type LLM_PROVIDERS,
  PRINTABLE_ASCII,
  RESERVED_SECRET_IDS,
  SECRET_ID_PATTERN,
  type SecretBinding,
} from "@localdot/protocol";

export type Provider = (typeof LLM_PROVIDERS)[number];
export type HttpFormat = (typeof HTTP_FORMATS)[number];

export interface KeyDraft {
  kind: "llm" | "http";
  id: string;
  provider: Provider;
  baseURL: string;
  hosts: string;
  header: string;
  format: HttpFormat;
}

export const EMPTY_DRAFT: KeyDraft = {
  kind: "llm",
  id: "",
  provider: "anthropic",
  baseURL: "",
  hosts: "",
  header: "Authorization",
  format: "bearer",
};

export const PROVIDER_NAMES: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  "openai-compatible": "OpenAI-compatible",
  azure: "Azure OpenAI",
};

export const FORMAT_NAMES: Record<HttpFormat, string> = {
  bearer: "Bearer token",
  raw: "The key as is",
  "basic-user": "Basic auth, key as user",
  "basic-password": "Basic auth, key as password",
};

// The two providers with no fixed address: the key goes to the base URL the user names.
export const needsBaseURL = (p: Provider) => p === "openai-compatible" || p === "azure";

export type DraftField = "id" | "baseURL" | "hosts" | "header" | "value";
export type DraftCheck =
  | { ok: true; binding: SecretBinding }
  | { ok: false; field: DraftField; message: string };

const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

// The binding the key will be sealed for, from what the form holds. keyd checks every field again
// (and more: the deny list, forbidden headers); this catches what a person can fix while typing.
// Text keyd will see is printable ASCII: a base URL goes as `new URL(x).href`, which encodes
// anything else, so the binding the browser seals is byte for byte the one keyd rebuilds.
export function bindingOf(d: KeyDraft): DraftCheck {
  const id = d.id.trim();
  if (!SECRET_ID_PATTERN.test(id)) {
    return fail(
      "id",
      "Use lower-case letters, digits, - or _ (up to 64), starting with a letter or digit.",
    );
  }
  if (RESERVED_SECRET_IDS.includes(id))
    return fail("id", `"${id}" is built in; pick another name.`);
  if (d.kind === "llm") {
    if (!needsBaseURL(d.provider))
      return { ok: true, binding: { id, kind: "llm", provider: d.provider } };
    const baseURL = httpsBase(d.baseURL);
    if (!baseURL)
      return fail(
        "baseURL",
        "Enter the https:// address the API lives at, with no port, user, query or #.",
      );
    return { ok: true, binding: { id, kind: "llm", provider: d.provider, baseURL } };
  }
  const hosts = [
    ...new Set(
      d.hosts
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean),
    ),
  ];
  if (hosts.length === 0 || hosts.length > 16)
    return fail("hosts", "Name 1 to 16 hosts, like api.example.com.");
  const bad = hosts.find((h) => !HOST.test(h));
  if (bad)
    return fail(
      "hosts",
      `"${bad}" is not a host name: use names like api.example.com, not addresses or URLs.`,
    );
  const header = d.header.trim();
  if (!HEADER.test(header))
    return fail("header", "Enter a header name, like Authorization or X-Api-Key.");
  if (d.format.startsWith("basic-") && header.toLowerCase() !== "authorization") {
    return fail("header", "Basic auth travels in the Authorization header.");
  }
  return { ok: true, binding: { id, kind: "http", hosts, header, format: d.format } };
}

// keyd stores 8 to 8,192 printable ASCII characters with no space at either end; a paste's stray
// spaces are trimmed first.
export function valueProblem(value: string): string | undefined {
  if (value.length < 8 || value.length > 8192 || !PRINTABLE_ASCII.test(value)) {
    return "A key is 8 to 8,192 characters of printable ASCII.";
  }
  return undefined;
}

function httpsBase(text: string): string | undefined {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) {
    return undefined;
  }
  const href = u.href;
  return href.length <= 2048 && PRINTABLE_ASCII.test(href) ? href : undefined;
}

function fail(field: DraftField, message: string): DraftCheck {
  return { ok: false, field, message };
}

// How a stored key reads in the list.
export function describeKey(k: {
  kind: "llm" | "http";
  provider?: string;
  baseURL?: string;
  hosts?: string[] | null;
  header?: string;
}): string {
  if (k.kind === "llm") {
    const name = PROVIDER_NAMES[k.provider as Provider] ?? k.provider ?? "Model provider";
    return k.baseURL ? `${name} · ${new URL(k.baseURL).host}` : name;
  }
  return `${(k.hosts ?? []).join(", ")} · ${k.header ?? ""}`;
}
```

`apps/web/src/keys/keys-api.ts`:
```ts
import { type HairpinGuard, type Sealed, type SecretBinding, sealSecret } from "@localdot/protocol";
import { type ApiClient, ApiError } from "../lib/api.ts";

export interface KeydHealth {
  online: boolean;
  bootId?: string;
  sealKey?: string;
  audit?: { ok: boolean; error?: string };
  hairpin?: HairpinGuard;
  error?: string;
}

export interface KeyRecord {
  id: string;
  kind: "llm" | "http";
  provider?: string;
  baseURL?: string;
  hosts?: string[] | null;
  header?: string;
  format?: string;
  createdAt: string;
  updatedAt: string;
}

export type Seal = (publicKey: string, binding: SecretBinding, value: string) => Promise<Sealed>;

export class KeyProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyProblem";
  }
}

export const loadHealth = (api: ApiClient) => api.get<KeydHealth>("/api/keyd");

export async function loadKeys(api: ApiClient): Promise<KeyRecord[]> {
  return (await api.get<{ keys: KeyRecord[] }>("/api/keys")).keys;
}

// Seals the value to keyd's current boot key and hands the daemon only the binding and the
// ciphertext. keyd answers 409 bad-seal when it restarted (new boot key) after the seal key was
// read: the value is sealed once more to the new key.
export async function saveKey(
  api: ApiClient,
  binding: SecretBinding,
  value: string,
  seal: Seal = sealSecret,
): Promise<{ key: KeyRecord; restart: boolean }> {
  const send = async () => {
    const health = await loadHealth(api);
    if (!health.online || !health.sealKey)
      throw new KeyProblem("The key layer is offline: start keyd.");
    const sealed = await seal(health.sealKey, binding, value);
    return api.post<{ key: KeyRecord; restart: boolean }>("/api/keys", { binding, sealed });
  };
  try {
    return await send();
  } catch (err) {
    if (errorCode(err) === "bad-seal") return send();
    throw err;
  }
}

export const deleteKey = (api: ApiClient, id: string) =>
  api.del(`/api/keys/${encodeURIComponent(id)}`);

// The daemon's refusals are `{ error, message }`; anything else becomes one plain sentence.
export function problemText(err: unknown): string {
  if (err instanceof KeyProblem) return err.message;
  if (err instanceof ApiError) {
    const body = parse(err.message);
    if (body?.message) return sentence(body.message);
    if (err.status === 503) return "The key layer is offline: start keyd.";
  }
  return "Something went wrong saving the key. Try again.";
}

function errorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? parse(err.message)?.error : undefined;
}

function parse(text: string): { error?: string; message?: string } | undefined {
  try {
    const body = JSON.parse(text) as unknown;
    return typeof body === "object" && body !== null
      ? (body as { error?: string; message?: string })
      : undefined;
  } catch {
    return undefined;
  }
}

function sentence(text: string): string {
  const t = text.replace(/^keys: /, "");
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`;
}
```

`apps/web/src/keys/useKeys.ts`:
```ts
import type { SecretBinding } from "@localdot/protocol";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import {
  deleteKey,
  type KeydHealth,
  type KeyRecord,
  loadHealth,
  loadKeys,
  problemText,
  saveKey,
} from "./keys-api.ts";

export interface KeysController {
  health: KeydHealth | null;
  keys: KeyRecord[];
  loadError: string | null;
  save(binding: SecretBinding, value: string): Promise<{ restart: boolean }>;
  remove(id: string): Promise<void>;
}

export type KeyStatus = {
  label: string;
  state: "unknown" | "ok" | "offline" | "audit" | "guard";
};

// The spec's "Key layer offline"; while keyd cannot write its audit log it swaps no key, which the
// user sees as every keyed request failing, so that is said too; and a hairpin guard that does not
// know the public address is never silent (the sheet says why).
export function keyStatus(health: KeydHealth | null): KeyStatus {
  if (!health) return { label: "Keys", state: "unknown" };
  if (!health.online) return { label: "Key layer offline", state: "offline" };
  if (health.audit && !health.audit.ok) return { label: "Keys on hold", state: "audit" };
  if (health.hairpin?.state !== "active") return { label: "Keys", state: "guard" };
  return { label: "Keys", state: "ok" };
}

export function useKeys(api: ApiClient, everyMs = 5000): KeysController {
  const [health, setHealth] = useState<KeydHealth | null>(null);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const online = health?.online ?? false;
  const bootId = health?.bootId;

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      loadHealth(api).then(
        (h) => !cancelled && setHealth(h),
        () => !cancelled && setHealth({ online: false }),
      );
    void poll();
    const timer = setInterval(poll, everyMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, everyMs]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new keyd boot or a save reloads the list
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    loadKeys(api).then(
      (list) => {
        if (cancelled) return;
        setKeys(list);
        setLoadError(null);
      },
      (err) => !cancelled && setLoadError(problemText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, online, bootId, version]);

  const save = useCallback(
    async (binding: SecretBinding, value: string) => {
      const { restart } = await saveKey(api, binding, value);
      setVersion((v) => v + 1);
      return { restart };
    },
    [api],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteKey(api, id);
      setVersion((v) => v + 1);
    },
    [api],
  );

  return { health, keys, loadError, save, remove };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run apps/web/src/keys && pnpm --filter @localdot/web typecheck`
Expected: PASS. `binding.test.ts` has 8 tests and `keys-api.test.ts` 6. The typecheck is clean.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add apps/web/src/keys
git commit -m "feat(web): the key form's binding, sealing and key layer state"
```

---

### Task 12b: The key sheet — keys sealed in the page, from a sheet in the Theatre

A **Keys** button sits in the top bar's right group, before the Live indicator. Its label is the
key layer's state (Task 12a's `keyStatus`), told by text and a dot that is hollow when something is
wrong, never by a new colour:
- `Keys` normally;
- `Key layer offline` while keyd is down (spec "Error handling");
- `Keys on hold` while keyd cannot write its audit log, during which it swaps no key;
- `Keys` with a hollow dot while the hairpin guard does not know the network's public address.

It opens a modal sheet anchored under the button. It grows from the button and returns to it,
with a dimming scrim. It stays mounted, so opening and closing is one interruptible CSS
transition, and it is inert while closed. Escape and the scrim close it, and focus goes back to
the button. While it is open, Tab and Shift-Tab go round its own controls (`aria-modal`, review M3).

The sheet lists the stored keys: name, provider or hosts and header. Deleting is a two-step press,
and an armed button disarms after 4 s. Under the list it states the hairpin guard: one quiet line
while it is active, and a note saying what is exposed and why while it is unknown or off.

**The form** takes what Task 12a's `bindingOf` reads. **The key itself** is a text field drawn as
dots (`-webkit-text-security: disc`) that React never reads into state: Chrome offers to save a
password field's value to the user's synced password manager, `autocomplete="off"` or not (review
M4). On submit the field is cleared at once, before the save settles. Fields are checked inline.
Saving says `Saved <name>.`, or `Saved <name>. Restart your computer to use it there.` when a
running computer cannot use it until it restarts.

The sheet's surface is solid (`--color-surface`), never a translucent layer on the blurred HUD.
Reduced motion drops the travel and keeps the fade; `prefers-contrast: more` gives it a defined
edge. Focus rings are neutral grey: the browser's default blue would read as xenon. Every control
is a `<button>` and so answers on pointer-down with the theme's press (Part 2's `button:active`,
none under reduced motion); nothing here sets a transform or a transition on a button.

**Files:**
- Create: `apps/web/src/keys/KeyForm.tsx`, `apps/web/src/keys/KeyList.tsx`,
  `apps/web/src/keys/KeysSheet.tsx`, `apps/web/src/keys/keys.css`,
  `apps/web/src/keys/KeysSheet.test.tsx`, `apps/web/e2e/keys.spec.ts`
- Modify: `apps/web/src/shell/TopBar.tsx`, `apps/web/src/App.tsx` (Part 3's `Theatre`),
  `apps/web/src/app.css`

**Interfaces:**
- Consumes: Task 12a's `bindingOf`, `valueProblem`, `describeKey`, `problemText`, `useKeys`,
  `keyStatus` and `KeysController`; Task 11's e2e harness.
- Produces:
  - `KeysSheet({ open, keys, onClose })`;
  - `TopBar` gains `keys: KeyStatus`, `keysOpen`, `onKeys()` and `keysRef?`, and
    `data-testid="keys-button"`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/keys/KeysSheet.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeysSheet } from "./KeysSheet.tsx";
import type { KeyRecord } from "./keys-api.ts";
import type { KeysController } from "./useKeys.ts";

afterEach(cleanup);

const weather: KeyRecord = {
  id: "weather",
  kind: "http",
  hosts: ["api.weather.example"],
  header: "Authorization",
  format: "bearer",
  createdAt: "t",
  updatedAt: "t",
};

function controller(over: Partial<KeysController> = {}): KeysController {
  return {
    health: {
      online: true,
      bootId: "b",
      sealKey: "K",
      audit: { ok: true },
      hairpin: { state: "active", source: "nat-pmp", addresses: 1 },
    },
    keys: [],
    loadError: null,
    save: vi.fn(async () => ({ restart: false })),
    remove: vi.fn(async () => {}),
    ...over,
  };
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const type = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });

describe("KeysSheet", () => {
  it("hands save the binding and the key, then clears the key field before the save settles", async () => {
    let settle: (v: { restart: boolean }) => void = () => {};
    const save = vi.fn(() => new Promise<{ restart: boolean }>((r) => (settle = r)));
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Web API" }));
    type("Name", "weather");
    type("Hosts", "api.weather.example");
    type("Key", "  sk-weather-123456 ");
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(save).toHaveBeenCalledWith(
      {
        id: "weather",
        kind: "http",
        hosts: ["api.weather.example"],
        header: "Authorization",
        format: "bearer",
      },
      "sk-weather-123456",
    );
    expect(field("Key").value).toBe("");
    // A text field drawn as dots: not a password field, which Chrome offers to save.
    expect(field("Key")).toMatchObject({ type: "text", className: "secret" });
    settle({ restart: true });
    expect(
      await screen.findByText("Saved weather. Restart your computer to use it there."),
    ).toBeTruthy();
    expect(field("Name").value).toBe("");
  });

  it("names what to fix and saves nothing", async () => {
    const save = vi.fn(async () => ({ restart: false }));
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    type("Name", "My Key");
    type("Key", "sk-ant-0123456");
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(screen.getByText(/lower-case letters/)).toBeTruthy();
    expect(field("Name").getAttribute("aria-invalid")).toBe("true");
    type("Name", "anthropic");
    type("Key", "short");
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(screen.getByText(/8 to 8,192 characters/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("says when saving failed and asks for the key again", async () => {
    const save = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<KeysSheet open keys={controller({ save })} onClose={() => {}} />);
    type("Name", "anthropic");
    type("Key", "sk-ant-0123456");
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Something went wrong saving the key. Try again. Paste the key again to retry.",
    );
  });

  it("asks for a base URL only for providers without a fixed one", () => {
    render(<KeysSheet open keys={controller()} onClose={() => {}} />);
    expect(screen.queryByLabelText("Base URL")).toBeNull();
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openai-compatible" } });
    expect(screen.getByLabelText("Base URL")).toBeTruthy();
  });

  it("says the key layer is offline and will not save", () => {
    render(<KeysSheet open keys={controller({ health: { online: false } })} onClose={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("The key layer is offline");
    expect((screen.getByRole("button", { name: "Save key" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("says keyd is holding keys back while its audit log fails", () => {
    const health = {
      online: true,
      bootId: "b",
      sealKey: "K",
      audit: { ok: false, error: "disk full" },
    };
    render(<KeysSheet open keys={controller({ health })} onClose={() => {}} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "keyd can't write its audit log, so it holds every key back until it can: disk full",
    );
  });

  it("deletes a key on the second press only", async () => {
    const remove = vi.fn(async () => {});
    render(<KeysSheet open keys={controller({ keys: [weather], remove })} onClose={() => {}} />);
    expect(screen.getByText("api.weather.example · Authorization")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete weather" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm deleting weather" }));
    expect(remove).toHaveBeenCalledWith("weather");
  });

  it("says whether the hairpin guard knows this network's public address", () => {
    const { rerender } = render(<KeysSheet open keys={controller()} onClose={() => {}} />);
    expect(screen.getByText(/^Hairpin guard: active/)).toBeTruthy();
    const unknown = controller({
      health: {
        online: true,
        bootId: "b",
        sealKey: "K",
        hairpin: { state: "unknown", addresses: 0 },
      },
    });
    rerender(<KeysSheet open keys={unknown} onClose={() => {}} />);
    expect(screen.getByText(/^Hairpin guard: unknown/).textContent).toContain(
      "asks again every 30 seconds",
    );
  });

  it("keeps Tab inside the open sheet", () => {
    render(<KeysSheet open keys={controller()} onClose={() => {}} />);
    const close = screen.getByRole("button", { name: "Close keys" });
    const save = screen.getByRole("button", { name: "Save key" });
    save.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it("closes on Escape and on the scrim, and is inert while closed", () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <KeysSheet open keys={controller()} onClose={onClose} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(container.querySelector(".scrim") as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
    rerender(<KeysSheet open={false} keys={controller()} onClose={onClose} />);
    expect(container.querySelector(".sheet")?.hasAttribute("inert")).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/web/src/keys/KeysSheet.test.tsx`
Expected: FAIL. `./KeysSheet.tsx` cannot be resolved.

- [ ] **Step 3: Write the code**

`apps/web/src/keys/KeyForm.tsx`:
```tsx
import type { SecretBinding } from "@localdot/protocol";
import { type FormEvent, useRef, useState } from "react";
import {
  bindingOf,
  type DraftField,
  EMPTY_DRAFT,
  FORMAT_NAMES,
  type HttpFormat,
  type KeyDraft,
  needsBaseURL,
  PROVIDER_NAMES,
  type Provider,
  valueProblem,
} from "./binding.ts";
import { problemText } from "./keys-api.ts";

export interface KeyFormProps {
  disabled: boolean;
  save(binding: SecretBinding, value: string): Promise<{ restart: boolean }>;
}

type Problem = { field: DraftField | "form"; message: string };

// The key itself lives only in the key field's DOM value (never in React state): it is read
// on submit, the field is cleared at once, and the page sends keyd's sealed copy.
export function KeyForm({ disabled, save }: KeyFormProps) {
  const [draft, setDraft] = useState<KeyDraft>(EMPTY_DRAFT);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const check = bindingOf(draft);
  const shown: Problem | null = problem ?? (tried && !check.ok ? check : null);
  const set = (patch: Partial<KeyDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setProblem(null);
    setSaved(null);
  };
  const errorFor = (field: DraftField) =>
    shown?.field === field ? (
      <p className="field-error" id={`key-${field}-error`}>
        {shown.message}
      </p>
    ) : null;
  const invalid = (field: DraftField) =>
    shown?.field === field
      ? { "aria-invalid": true, "aria-describedby": `key-${field}-error` }
      : {};

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    setSaved(null);
    const input = valueRef.current;
    if (!check.ok || !input || busy) return;
    const value = input.value.trim();
    const bad = valueProblem(value);
    if (bad) {
      setProblem({ field: "value", message: bad });
      return;
    }
    setBusy(true);
    const saving = save(check.binding, value);
    input.value = "";
    try {
      const { restart } = await saving;
      const id = check.binding.id;
      setDraft((d) => ({ ...d, id: "", baseURL: "", hosts: "" }));
      setTried(false);
      setSaved(restart ? `Saved ${id}. Restart your computer to use it there.` : `Saved ${id}.`);
    } catch (err) {
      setProblem({ field: "form", message: `${problemText(err)} Paste the key again to retry.` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="key-form" onSubmit={submit} noValidate aria-label="Add a key">
      <h3>Add a key</h3>
      <fieldset className="kinds">
        <legend className="sr-only">Kind of key</legend>
        <button
          type="button"
          className="kind"
          aria-pressed={draft.kind === "llm"}
          onClick={() => set({ kind: "llm" })}
        >
          Model provider
        </button>
        <button
          type="button"
          className="kind"
          aria-pressed={draft.kind === "http"}
          onClick={() => set({ kind: "http" })}
        >
          Web API
        </button>
      </fieldset>
      <label>
        <span>Name</span>
        <input
          value={draft.id}
          onChange={(e) => set({ id: e.target.value })}
          placeholder={draft.kind === "llm" ? "anthropic" : "weather"}
          autoComplete="off"
          spellCheck={false}
          {...invalid("id")}
        />
      </label>
      {errorFor("id")}
      {draft.kind === "llm" ? (
        <>
          <label>
            <span>Provider</span>
            <select
              value={draft.provider}
              onChange={(e) => set({ provider: e.target.value as Provider })}
            >
              {Object.entries(PROVIDER_NAMES).map(([p, name]) => (
                <option key={p} value={p}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {needsBaseURL(draft.provider) && (
            <>
              <label>
                <span>Base URL</span>
                <input
                  value={draft.baseURL}
                  onChange={(e) => set({ baseURL: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                  {...invalid("baseURL")}
                />
              </label>
              {errorFor("baseURL")}
            </>
          )}
        </>
      ) : (
        <>
          <label>
            <span>Hosts</span>
            <input
              value={draft.hosts}
              onChange={(e) => set({ hosts: e.target.value })}
              placeholder="api.example.com"
              autoComplete="off"
              spellCheck={false}
              {...invalid("hosts")}
            />
          </label>
          {errorFor("hosts")}
          <div className="pair">
            <label>
              <span>Header</span>
              <input
                value={draft.header}
                onChange={(e) => set({ header: e.target.value })}
                autoComplete="off"
                spellCheck={false}
                {...invalid("header")}
              />
            </label>
            <label>
              <span>Sent as</span>
              <select
                value={draft.format}
                onChange={(e) => set({ format: e.target.value as HttpFormat })}
              >
                {Object.entries(FORMAT_NAMES).map(([f, name]) => (
                  <option key={f} value={f}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {errorFor("header")}
        </>
      )}
      <label>
        <span>Key</span>
        {/* A text field drawn as dots: Chrome offers to save a password field's value to the
            user's synced password manager, autocomplete="off" or not. */}
        <input
          ref={valueRef}
          type="text"
          className="secret"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          onChange={() => problem?.field === "value" && setProblem(null)}
          {...invalid("value")}
        />
      </label>
      {errorFor("value")}
      {shown?.field === "form" && (
        <p className="field-error" role="alert">
          {shown.message}
        </p>
      )}
      <button type="submit" className="save" disabled={disabled || busy}>
        {busy ? "Saving…" : "Save key"}
      </button>
      {saved && (
        <p className="keys-note" role="status">
          {saved}
        </p>
      )}
    </form>
  );
}
```

`apps/web/src/keys/KeyList.tsx`:
```tsx
import { useEffect, useState } from "react";
import { describeKey } from "./binding.ts";
import { type KeyRecord, problemText } from "./keys-api.ts";

export interface KeyListProps {
  keys: KeyRecord[];
  disabled: boolean;
  remove(id: string): Promise<void>;
}

// Deleting a key cannot be undone, so the first press arms the button and a second one, within a
// few seconds, deletes.
export function KeyList({ keys, disabled, remove }: KeyListProps) {
  const [armed, setArmed] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (keys.length === 0) return <p className="keys-empty">No keys yet.</p>;
  return (
    <>
      <ul className="key-list" aria-label="Saved keys">
        {keys.map((k) => (
          <li key={k.id}>
            <span className="key-name">{k.id}</span>
            <span className="key-what">{describeKey(k)}</span>
            <button
              type="button"
              className={armed === k.id ? "key-del armed" : "key-del"}
              disabled={disabled}
              aria-label={armed === k.id ? `Confirm deleting ${k.id}` : `Delete ${k.id}`}
              onClick={() => {
                if (armed !== k.id) {
                  setArmed(k.id);
                  return;
                }
                setArmed(null);
                remove(k.id).then(
                  () => setProblem(null),
                  (err) => setProblem(problemText(err)),
                );
              }}
            >
              {armed === k.id ? "Delete" : "Remove"}
            </button>
          </li>
        ))}
      </ul>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}
```

`apps/web/src/keys/KeysSheet.tsx`:
```tsx
import { useEffect, useRef } from "react";
import { KeyForm } from "./KeyForm.tsx";
import { KeyList } from "./KeyList.tsx";
import type { KeydHealth } from "./keys-api.ts";
import { type KeysController, keyStatus } from "./useKeys.ts";
import "./keys.css";

export interface KeysSheetProps {
  open: boolean;
  keys: KeysController;
  onClose(): void;
}

// A modal sheet that grows from the top bar's Keys button and returns to it. It stays mounted so
// opening and closing are one interruptible transition; closed, it is inert.
export function KeysSheet({ open, keys, onClose }: KeysSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const status = keyStatus(keys.health);
  const offline = status.state === "offline";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && panel.current) keepFocusIn(panel.current, e);
    };
    window.addEventListener("keydown", onKey);
    panel.current?.querySelector<HTMLElement>(".key-form input")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={open ? "scrim on" : "scrim"} onPointerDown={onClose} aria-hidden="true" />
      <div
        ref={panel}
        className={open ? "sheet on" : "sheet"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-title"
        inert={!open}
      >
        <header>
          <h2 id="keys-title">Keys</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Close keys">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <p className="lede">
          Keys stay in keyd on this Mac. Your computer gets stand-ins that only work through keyd.
        </p>
        {offline && (
          <p className="keys-note" role="alert">
            The key layer is offline. Start keyd, then come back here.
          </p>
        )}
        {status.state === "audit" && (
          <p className="keys-note" role="alert">
            keyd can't write its audit log, so it holds every key back until it can
            {keys.health?.audit?.error ? `: ${keys.health.audit.error}` : "."}
          </p>
        )}
        {keys.loadError && !offline && (
          <p className="keys-note" role="alert">
            {keys.loadError}
          </p>
        )}
        {!offline && keys.health && <HairpinLine guard={keys.health.hairpin} />}
        <KeyList keys={keys.keys} disabled={offline} remove={keys.remove} />
        <KeyForm disabled={offline} save={keys.save} />
      </div>
    </>
  );
}

// Hairpin NAT: a computer could reach the router's own pages through this network's public
// address, unless keyd knows that address and refuses it.
function HairpinLine({ guard }: { guard: KeydHealth["hairpin"] }) {
  if (guard?.state === "active") {
    return (
      <p className="keys-guard">Hairpin guard: active. Your router's public address is blocked.</p>
    );
  }
  const why =
    guard?.state === "off"
      ? "keyd is set to ask neither your router nor STUN for this network's public address"
      : "keyd hasn't learned this network's public address yet and asks again every 30 seconds";
  return (
    <p className="keys-note">
      Hairpin guard: {guard?.state === "off" ? "off" : "unknown"}. A computer could reach your
      router through its public address: {why}.
    </p>
  );
}

// aria-modal: Tab and Shift-Tab go round the sheet's own controls.
function keepFocusIn(panel: HTMLElement, e: KeyboardEvent) {
  const items = [
    ...panel.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled])",
    ),
  ];
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const inside = panel.contains(document.activeElement);
  if (e.shiftKey && (!inside || document.activeElement === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
    e.preventDefault();
    first.focus();
  }
}
```

`apps/web/src/keys/keys.css`:
```css
.scrim {
  position: fixed;
  inset: 0;
  background: var(--color-shade-hud);
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease-out;
  z-index: 20;
}

.scrim.on {
  opacity: 1;
  pointer-events: auto;
}

.sheet {
  position: fixed;
  top: 50px;
  right: 16px;
  width: min(400px, calc(100vw - 32px));
  max-height: calc(100vh - 66px);
  overflow-y: auto;
  padding: 18px 18px 20px;
  border-radius: 14px;
  background: var(--color-surface);
  box-shadow:
    inset 0 0 0 1px var(--color-hud-line),
    0 24px 64px var(--color-edge);
  transform-origin: calc(100% - 40px) -8px;
  transform: translateY(-6px) scale(0.97);
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 180ms ease-out,
    transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1),
    visibility 0s linear 260ms;
  z-index: 21;
}

.sheet.on {
  transform: none;
  opacity: 1;
  visibility: visible;
  transition:
    opacity 180ms ease-out,
    transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1),
    visibility 0s;
}

.sheet header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.sheet h2 {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.sheet h3 {
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 10px;
}

.sheet .x {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 14px;
  background: var(--color-hud-button);
  color: var(--color-text-2);
  font-size: 17px;
  line-height: 1;
}

.sheet .lede {
  color: var(--color-text-2);
  margin-bottom: 14px;
}

.keys-note {
  margin: 0 0 14px;
  padding: 9px 12px;
  border-radius: 10px;
  background: var(--color-surface-2);
  color: var(--color-text);
}

.keys-empty {
  color: var(--color-text-3);
  margin-bottom: 16px;
}

.key-list {
  list-style: none;
  margin-bottom: 16px;
  border-top: 1px solid var(--color-line);
}

.key-list li {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  border-bottom: 1px solid var(--color-line);
}

.key-name {
  font-family: var(--font-mono);
  font-size: 12.5px;
}

.key-what {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-2);
}

.key-del {
  height: 26px;
  padding: 0 10px;
  border-radius: 13px;
  background: var(--color-hud-button);
  color: var(--color-text-2);
  font-size: 12px;
  font-weight: 500;
}

.key-del.armed {
  background: var(--color-text);
  color: var(--color-void);
}

.key-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px;
}

.key-form label {
  display: grid;
  gap: 5px;
}

.key-form label > span {
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--color-text-3);
}

.key-form input,
.key-form select {
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--color-line);
  background: var(--color-void);
  color: var(--color-text);
  font: inherit;
}

.key-form input:focus-visible,
.key-form select:focus-visible,
.sheet button:focus-visible {
  outline: 2px solid var(--color-text-2);
  outline-offset: 1px;
}

.key-form input.secret {
  -webkit-text-security: disc;
}

.keys-guard {
  margin: 0 0 14px;
  color: var(--color-text-3);
}

.key-form input[aria-invalid="true"] {
  border-color: var(--color-text-2);
}

.key-form .pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}

.kinds {
  border: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 3px;
  border-radius: 10px;
  background: var(--color-void);
}

.kind {
  height: 28px;
  border-radius: 7px;
  color: var(--color-text-2);
  font-weight: 500;
  font-size: 12.5px;
}

.kind[aria-pressed="true"] {
  background: var(--color-surface-2);
  color: var(--color-text);
}

.field-error {
  margin-top: -4px;
  font-size: 12px;
  color: var(--color-text);
}

.field-error::before {
  content: "";
  display: inline-block;
  width: 5px;
  height: 5px;
  margin: 0 7px 1px 1px;
  border: 1.5px solid var(--color-text);
  border-radius: 50%;
}

.key-form .save {
  align-self: flex-end;
  height: 34px;
  padding: 0 16px;
  border-radius: 17px;
  background: var(--color-text);
  color: var(--color-void);
  font-weight: 600;
}

.key-form .save:disabled {
  opacity: 0.4;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .sheet,
  .sheet.on {
    transform: none;
  }
}

@media (prefers-contrast: more) {
  .sheet {
    box-shadow:
      inset 0 0 0 1px var(--color-text-2),
      0 24px 64px var(--color-edge);
  }
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
```

`apps/web/src/shell/TopBar.tsx` (replace):
```tsx
import type { Ref } from "react";
import type { KeyStatus } from "../keys/useKeys.ts";
import { Mascot } from "./Mascot.tsx";

export interface TopBarProps {
  title: string;
  live: boolean;
  keys: KeyStatus;
  keysOpen: boolean;
  onKeys(): void;
  keysRef?: Ref<HTMLButtonElement>;
}

export function TopBar({ title, live, keys, keysOpen, onKeys, keysRef }: TopBarProps) {
  const alert = keys.state === "offline" || keys.state === "audit" || keys.state === "guard";
  return (
    <header className="bar">
      <div className="bar-l">
        <span className="brand">
          <Mascot size={16} />
          localDot
        </span>
        <span className="title">{title}</span>
      </div>
      <nav className="modes" aria-label="Mode">
        <span aria-disabled="true">Glance</span>
        <span className="on" aria-current="page">
          Watch
        </span>
        <span aria-disabled="true">Replay</span>
      </nav>
      <div className="bar-r">
        <button
          ref={keysRef}
          type="button"
          className={alert ? "keys-btn alert" : "keys-btn"}
          aria-haspopup="dialog"
          aria-expanded={keysOpen}
          onClick={onKeys}
          data-testid="keys-button"
        >
          <span className="dot" aria-hidden="true" />
          {keys.label}
        </button>
        <span className={live ? "live on" : "live"}>
          <b aria-hidden="true" />
          {live ? "Live" : "Offline"}
        </span>
      </div>
    </header>
  );
}
```

Append to `apps/web/src/app.css`:
```css
.keys-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 10px;
  border-radius: 14px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--color-text-2);
}

.keys-btn:focus-visible {
  outline: 2px solid var(--color-text-2);
  outline-offset: 1px;
}

.keys-btn:hover,
.keys-btn[aria-expanded="true"] {
  background: var(--color-hud-button);
  color: var(--color-text);
}

.keys-btn .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-3);
}

.keys-btn.alert {
  color: var(--color-text);
}

.keys-btn.alert .dot {
  background: none;
  box-shadow: inset 0 0 0 1.5px var(--color-text);
}
```

In `apps/web/src/App.tsx`, inside Part 3's `Theatre`:
- imports: add `useCallback`, `useRef` and `useState` to the React import if missing, then
  ```tsx
  import { KeysSheet } from "./keys/KeysSheet.tsx";
  import { keyStatus, useKeys } from "./keys/useKeys.ts";
  ```
- after `useCell(api)`:
  ```tsx
  const keys = useKeys(api);
  const [keysOpen, setKeysOpen] = useState(false);
  const keysButton = useRef<HTMLButtonElement>(null);
  const closeKeys = useCallback(() => {
    setKeysOpen(false);
    keysButton.current?.focus();
  }, []);
  ```
- the top bar gets the key layer's state:
  ```tsx
      <TopBar
        title={session.model.title ?? "Your computer"}
        live={hud.live}
        keys={keyStatus(keys.health)}
        keysOpen={keysOpen}
        onKeys={() => setKeysOpen((o) => !o)}
        keysRef={keysButton}
      />
  ```
- and the sheet is the last child of the `.app` element:
  ```tsx
      <KeysSheet open={keysOpen} keys={keys} onClose={closeKeys} />
  ```

`apps/web/e2e/keys.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
import { type RunningDaemon, startDaemon } from "./daemon.ts";

// The key form end to end: Chrome seals the key with WebCrypto to keyd's boot key, the daemon
// relays ciphertext, keyd stores it. No Docker: keys are keyd's alone.
const VALUE = `e2e-${Math.random().toString(36).slice(2)}-key-value`;
let daemon: RunningDaemon;

test.beforeAll(async () => {
  daemon = await startDaemon();
});

test.afterAll(async () => {
  await daemon?.stop();
});

test("save a web API key sealed in the page, list it, remove it", async ({ page }) => {
  const posted: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/keys")
      posted.push(r.postData() ?? "");
  });
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(page.getByTestId("keys-button")).toHaveText("Keys");
  await page.getByTestId("keys-button").click();
  const sheet = page.getByRole("dialog", { name: "Keys" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("No keys yet.")).toBeVisible();

  await sheet.getByRole("button", { name: "Web API" }).click();
  await sheet.getByLabel("Name", { exact: true }).fill("weather");
  await sheet.getByLabel("Hosts", { exact: true }).fill("api.weather.example");
  await sheet.getByLabel("Key", { exact: true }).fill(VALUE);
  await sheet.getByRole("button", { name: "Save key" }).click();
  await expect(sheet.getByRole("status")).toHaveText("Saved weather.");
  await expect(sheet.getByLabel("Key", { exact: true })).toHaveValue("");
  await expect(sheet.getByText("api.weather.example · Authorization")).toBeVisible();
  await expect(sheet).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "e2e/out/keys-sheet.png" });

  expect(posted).toHaveLength(1);
  expect(posted[0]).not.toContain(VALUE);
  const body = JSON.parse(posted[0] ?? "{}") as {
    binding: unknown;
    sealed: { v: number; ct: string };
  };
  expect(body.binding).toEqual({
    id: "weather",
    kind: "http",
    hosts: ["api.weather.example"],
    header: "Authorization",
    format: "bearer",
  });
  expect(body.sealed.v).toBe(1);

  // A base URL with non-ASCII text goes as the URL parser writes it, so the binding Chrome seals
  // is byte for byte the one keyd rebuilds.
  await sheet.getByRole("button", { name: "Model provider" }).click();
  await sheet.getByLabel("Name", { exact: true }).fill("books");
  await sheet.getByLabel("Provider").selectOption("openai-compatible");
  await sheet.getByLabel("Base URL").fill("https://bücher.example/openai/v1");
  await sheet.getByLabel("Key", { exact: true }).fill(`${VALUE}-2`);
  await sheet.getByRole("button", { name: "Save key" }).click();
  await expect(sheet.getByRole("status")).toHaveText("Saved books.");
  await expect(sheet.getByText("OpenAI-compatible · xn--bcher-kva.example")).toBeVisible();
  expect(posted).toHaveLength(2);
  expect(posted[1]).not.toContain(VALUE);
  await sheet.getByRole("button", { name: "Delete books" }).click();
  await sheet.getByRole("button", { name: "Confirm deleting books" }).click();

  await sheet.getByRole("button", { name: "Delete weather" }).click();
  await sheet.getByRole("button", { name: "Confirm deleting weather" }).click();
  await expect(sheet.getByText("No keys yet.")).toBeVisible();
  const keys = await (
    await fetch(`${daemon.origin}/api/keys`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    })
  ).json();
  expect(keys).toEqual({ keys: [] });

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("keys-button")).toBeFocused();
});

test("say the key layer is offline when keyd stops", async ({ page }) => {
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await expect(page.getByTestId("keys-button")).toHaveText("Keys");
  await daemon.keyd.stop();
  await expect(page.getByTestId("keys-button")).toHaveText("Key layer offline", {
    timeout: 15_000,
  });
  await page.getByTestId("keys-button").click();
  const sheet = page.getByRole("dialog", { name: "Keys" });
  await expect(sheet.getByRole("alert")).toContainText("The key layer is offline");
  await expect(sheet.getByRole("button", { name: "Save key" })).toBeDisabled();
  await expect(sheet).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "e2e/out/keys-offline.png" });
});
```

- [ ] **Step 4: Run the tests, and look at the sheet**

Run: `pnpm exec vitest run apps/web/src && pnpm --filter @localdot/web typecheck`
Expected: PASS. `KeysSheet.test.tsx` has 10 tests. `App.test.tsx` passes unchanged: its fetch stub
answers `/api/keyd` with `[]`, which reads as offline.

Run: `pnpm --filter @localdot/web build && pnpm --filter @localdot/web e2e keys.spec.ts`
Expected: PASS, 2 tests, in about 10 s with keyd built.
- Chrome seals a web API key that keyd stores. The POST body holds the binding and a v1 seal, and
  never the value. The key field is empty after saving. The key is listed, then deleted with two
  presses. Escape closes the sheet and focus returns to the Keys button.
- A model-provider key with the base URL `https://bücher.example/openai/v1` is sealed for
  `https://xn--bcher-kva.example/openai/v1` and stored by keyd: Chrome and keyd agree on the AAD.
- With keyd stopped, the button reads `Key layer offline`, the sheet says so, and Save is disabled.
- The e2e keyd asks nobody for the public address (`-natpmp off -stun off`), so the sheet says the
  hairpin guard is off, and the Keys button's dot is hollow.

Open `apps/web/e2e/out/keys-sheet.png` and `keys-offline.png` and check the look:
- the sheet sits under the Keys button, is solid and fully opaque, and the house behind it is dimmed;
- no blue focus ring and no colour but the Theatre's greys (no xenon, no purple);
- errors and the hairpin note carry no new hue: a hollow dot and text say it.

Fix anything that is off before committing.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add apps/web/src/keys apps/web/src/shell/TopBar.tsx apps/web/src/App.tsx apps/web/src/app.css apps/web/e2e/keys.spec.ts
git commit -m "feat(web): the key sheet seals keys in the page"
```

---

### Task 13: A paused computer, Resume, and key use in the steps

The Theatre has to show what Stop did, and what keyd saw.

**The paused computer.** A computer Stop froze shows `Paused` in the HUD, with **Resume computer**
and **Stop computer**. The caption under the stage reads: "dot stopped and your computer is frozen.
Resume it to use it again: programs dot started carry on. Stop it for a clean start." A frozen
cell's stream stalls, but the HUD says `Paused`, not "Reconnecting…". The ended session's
"Stopped." does not replace the caption. While keyd is offline, Resume answers 503 and the computer
stays frozen; `useCell` shows that answer's text as its error (Task 10).

**Key use in the steps.** Key use appears inline among the steps (spec "Audit": "used Anthropic key
→ api.anthropic.com"):
- `Used weather key → api.weather.example`, with the method and path in quiet mono;
- `Blocked weather key → …` for a refused one, with a hollow dot and brighter text (no colour);
- a run of uses with the same key, host and outcome is one row with a count.

The stage model folds `key.use` into `keyUses` (never drawn on the stage), and the steps merge
them by time.

**Files:**
- Create: `apps/web/src/session/key-uses.ts`, `apps/web/src/session/key-uses.test.ts`,
  `apps/web/src/shell/KeyUseRow.tsx`, `apps/web/src/shell/KeyUseRow.test.tsx`,
  `apps/web/src/shell/Hud.test.tsx`, `apps/web/e2e/stop-and-keys.spec.ts`
- Modify:
  - in `apps/web/src/cells/`: `types.ts`, `hud-state.ts`, `hud-state.test.ts`, `useCell.ts`;
  - in `apps/web/src/shell/`: `Hud.tsx`, `StageColumn.tsx`, `PlanRail.tsx` (all Part 3's);
  - `apps/web/src/session/session-view.ts` and `apps/web/src/App.tsx` (Part 3's),
    `apps/web/src/app.css`;
  - `packages/stage/src/model.ts` and its test, and the package index (Part 3's).

**Interfaces:**
- Consumes:
  - `CellSummary.paused` and `POST /api/cells/:id/resume` (Task 10);
  - the `key.use` events of Task 11;
  - Part 3's `foldEvents`, `SessionModel`, `stepRows`, `StepRowView`, `mergeHud`, `Hud`,
    `StageColumn`, `PlanRail` and `StepRow`.
- Produces:
  - `HudState.action` adds `"resume"`, and `CellController.resume()`;
  - `HudProps.onResume()`;
  - `KeyUseState` (exported from `@localdot/stage`), and `SessionModel.keyUses: KeyUseState[]`;
  - `StepRowView.startT: number`;
  - `keyUseRow(k) → KeyUseRowView` and `timelineRows(steps, keyUses) → TimelineRow<StepRowView>[]`;
  - `KeyUseRow({ row })` (`data-testid="key-use"`).

- [ ] **Step 1: Write the failing tests**

`apps/web/src/session/key-uses.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { type KeyUseState, keyUseRow, timelineRows } from "./key-uses.ts";

const use = (t: number, over: Partial<KeyUseState> = {}): KeyUseState => ({
  id: `k${t}`,
  t,
  secretId: "weather",
  host: "api.weather.example",
  method: "GET",
  path: "/v1/now",
  decision: "allow",
  ...over,
});

describe("keyUseRow", () => {
  it("reads like the spec's inline key use, and says when keyd blocked one", () => {
    expect(keyUseRow(use(1))).toMatchObject({
      label: "Used weather key → api.weather.example",
      detail: "GET /v1/now",
      blocked: false,
    });
    expect(
      keyUseRow(use(1, { decision: "deny", secretId: "unknown", host: "evil.example" })),
    ).toMatchObject({
      label: "Blocked an unknown key → evil.example",
      blocked: true,
    });
  });

  it("keeps the cell's text as text", () => {
    const row = keyUseRow(
      use(1, { host: "<img src=x onerror=alert(1)>", path: "/[surrogate:4235622e4ffe]" }),
    );
    expect(row.label).toBe("Used weather key → <img src=x onerror=alert(1)>");
    expect(row.detail).toBe("GET /[surrogate:4235622e4ffe]");
  });
});

describe("timelineRows", () => {
  it("puts key uses between the steps they happened in, and folds a run into one row", () => {
    const steps = [
      { id: "s1", startT: 10 },
      { id: "s2", startT: 50 },
    ];
    const rows = timelineRows(steps, [
      use(20),
      use(21, { path: "/v1/later" }),
      use(22),
      use(30, { decision: "deny" }),
      use(60),
    ]);
    expect(rows.map((r) => (r.kind === "step" ? r.id : `${r.label} ×${r.count}`))).toEqual([
      "s1",
      "Used weather key → api.weather.example ×3",
      "Blocked weather key → api.weather.example ×1",
      "s2",
      "Used weather key → api.weather.example ×1",
    ]);
    const folded = rows[1];
    expect(folded?.kind === "key" && folded.detail).toBe("GET /v1/now");
  });
});
```

`apps/web/src/shell/KeyUseRow.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { keyUseRow } from "../session/key-uses.ts";
import { KeyUseRow } from "./KeyUseRow.tsx";

afterEach(cleanup);

const use = {
  id: "k1",
  t: 10,
  secretId: "weather",
  host: "api.weather.example",
  method: "GET",
  path: "/v1/now",
  decision: "allow" as const,
};

describe("KeyUseRow", () => {
  it("shows the key, the host, the request and how many times", () => {
    const { container } = render(<KeyUseRow row={{ ...keyUseRow(use), count: 3 }} />);
    expect(screen.getByTestId("key-use").textContent).toBe(
      "Used weather key → api.weather.example×3GET /v1/now",
    );
    expect(container.querySelector(".blocked")).toBeNull();
  });

  it("marks a blocked use and renders the cell's text as text", () => {
    const row = keyUseRow({ ...use, decision: "deny", host: "<img src=x onerror=alert(1)>" });
    const { container } = render(<KeyUseRow row={row} />);
    expect(container.querySelector(".keyuse.blocked")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Blocked weather key → <img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
  });
});
```

`apps/web/src/shell/Hud.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hud } from "./Hud.tsx";

afterEach(cleanup);

describe("Hud", () => {
  it("offers Resume and Stop on a computer Stop froze", () => {
    const onResume = vi.fn();
    const onStop = vi.fn();
    render(
      <Hud
        hud={{ label: "Paused", caption: "", action: "resume", live: false }}
        onStart={() => {}}
        onStop={onStop}
        onStopSession={() => {}}
        onResume={onResume}
      />,
    );
    expect(screen.getByTestId("hud-status").textContent).toBe("Paused");
    fireEvent.click(screen.getByRole("button", { name: "Resume computer" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop computer" }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Start computer" })).toBeNull();
  });
});
```

Append to `apps/web/src/cells/hud-state.test.ts`'s `describe` (its `cell(state, connection)`
helper is the file's own):
```ts
  it("shows a computer frozen by Stop as paused, whatever its stream says", () => {
    for (const connection of ["live", "stalled", "disconnected"] as const) {
      expect(hudFor({ ...cell("ready", connection), paused: true }, false)).toMatchObject({
        label: "Paused",
        action: "resume",
        live: false,
      });
    }
    expect(hudFor({ ...cell("ready", "live"), paused: true }, true).action).toBe("none");
  });
```

Append to `packages/stage/src/model.test.ts` (Part 3's), using the file's own event helpers. If it
has none, build the event with `parseEvent` from `@localdot/protocol`:
```ts
  it("folds keyd's key use beside the actions, never into them", () => {
    const model = foldEvents(emptyModel(), [
      parseEvent({ v: 1, id: "01JXYZ00000000000000000001", seq: 0, t: 0, agent: "system", type: "session.start", data: { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "t" } }),
      parseEvent({ v: 1, id: "01JXYZ00000000000000000002", seq: 1, t: 1500, agent: "keyd", type: "key.use", data: { secretId: "weather", host: "api.weather.example", method: "GET", path: "/v1/now", decision: "allow" } }),
    ]);
    expect(model.actions).toEqual([]);
    expect(model.keyUses).toEqual([
      { id: "01JXYZ00000000000000000002", t: 1.5, secretId: "weather", host: "api.weather.example", method: "GET", path: "/v1/now", decision: "allow" },
    ]);
  });
```
(`t` is in session milliseconds, as `sessionMsOf` gives it. `session.start`'s `os` is required.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run apps/web/src packages/stage`
Expected: FAIL. `./key-uses.ts` and `./KeyUseRow.tsx` cannot be resolved, the HUD has no
`Resume computer`, `hudFor` has no paused state, and `model.keyUses` is undefined.

- [ ] **Step 3: Write the code**

In `packages/stage/src/model.ts`, add and export (from the package index too, next to
`SessionModel`):
```ts
// keyd's key use, from its audit (Part 4b): shown inline in the steps, never drawn on the stage.
// host and path are text the cell's request chose: rendered as plain text, never as markup.
export interface KeyUseState {
  id: string;
  t: number;
  secretId: string;
  host: string;
  method: string;
  path: string;
  decision: "allow" | "deny" | "ask";
}
```
Then add `keyUses: KeyUseState[];` to `SessionModel` and `keyUses: []` to `emptyModel()`, and add
this case to `foldEvents`' switch:
```ts
      case "key.use":
        model.keyUses.push({ id: e.id, t, ...e.data });
        break;
```

`apps/web/src/session/key-uses.ts`:
```ts
import type { KeyUseState } from "@localdot/stage";

export type { KeyUseState };

export interface KeyUseRowView {
  kind: "key";
  id: string;
  t: number;
  label: string;
  detail: string;
  blocked: boolean;
  count: number;
}

export type TimelineRow<S> = (S & { kind: "step" }) | KeyUseRowView;

export function keyUseRow(k: KeyUseState): KeyUseRowView {
  const blocked = k.decision !== "allow";
  const key = k.secretId === "unknown" ? "an unknown key" : `${k.secretId} key`;
  return {
    kind: "key",
    id: k.id,
    t: k.t,
    label: `${blocked ? "Blocked" : "Used"} ${key} → ${k.host}`,
    detail: `${k.method} ${k.path}`,
    blocked,
    count: 1,
  };
}

// Steps and key uses in time order; a run of key uses with the same key, host and outcome is one
// row with a count, so a page that calls an API forty times does not bury the steps.
export function timelineRows<S extends { startT: number }>(
  steps: S[],
  keyUses: KeyUseState[],
): TimelineRow<S>[] {
  const rows: TimelineRow<S>[] = [];
  const items = [
    ...steps.map((s) => ({ t: s.startT, step: s })),
    ...keyUses.map((k) => ({ t: k.t, key: k })),
  ].sort((a, b) => a.t - b.t);
  for (const item of items) {
    if ("step" in item && item.step) {
      rows.push({ ...item.step, kind: "step" });
      continue;
    }
    if (!("key" in item) || !item.key) continue;
    const row = keyUseRow(item.key);
    const last = rows.at(-1);
    if (last?.kind === "key" && last.label === row.label) {
      last.count += 1;
      last.detail = row.detail;
      continue;
    }
    rows.push(row);
  }
  return rows;
}
```

`apps/web/src/shell/KeyUseRow.tsx`:
```tsx
import type { KeyUseRowView } from "../session/key-uses.ts";

// One key use inline in the steps (spec "Audit"). Everything here is text the cell's request
// chose or keyd wrote: React renders it as text, and none of it becomes a link.
export function KeyUseRow({ row }: { row: KeyUseRowView }) {
  return (
    <div className={row.blocked ? "keyuse blocked" : "keyuse"} data-testid="key-use">
      <span className="kd" aria-hidden="true" />
      <span className="kl">{row.label}</span>
      {row.count > 1 && <span className="kc">×{row.count}</span>}
      <span className="kp">{row.detail}</span>
    </div>
  );
}
```

In `apps/web/src/session/session-view.ts` (Part 3's):
- `StepRowView` gains `startT: number;`, and `stepRows` sets it from the step's first action:
  `startT: rows.get(id)?.startT ?? a.intentT,`.
- In `mergeHud`, a computer Stop froze keeps its own caption:
  ```ts
  if (!session || session.state === "done" || session.state === "stopped" || session.state === "error") {
    return { ...hud, control: false, ...(session && hud.action !== "resume" ? { caption: session.caption } : {}) };
  }
  ```

In `apps/web/src/shell/PlanRail.tsx` (Part 3's), `rows` becomes `TimelineRow<StepRowView>[]` (import
the type from `../session/key-uses.ts` and `KeyUseRow` from `./KeyUseRow.tsx`), and the list renders
either kind:
```tsx
          {rows.map((row, i) =>
            row.kind === "key" ? (
              <KeyUseRow key={`key-${row.id}`} row={row} />
            ) : (
              <StepRow key={row.id} row={row} sessionId={sessionId} scale={scale} api={api} current={i === rows.length - 1 && row.status === "doing"} />
            ),
          )}
```

In `apps/web/src/cells/types.ts`, add to `CellSummary`:
```ts
  // Frozen by Stop's kill switch until it is resumed.
  paused?: true;
```
In `apps/web/src/cells/hud-state.ts`, `action` becomes `"start" | "stop" | "resume" | "none"`, and
right after the state `switch` (before the stream's), add:
```ts
  if (cell.paused) {
    return idle(
      "Paused",
      "dot stopped and your computer is frozen. Resume it to use it again: programs dot started carry on. Stop it for a clean start.",
      "resume",
    );
  }
```
In `apps/web/src/cells/useCell.ts`, add `resume(): void;` to `CellController`, and before the
`return`:
```ts
  const resume = useCallback(() => {
    if (cellId) void run(() => api$.current.post(`/api/cells/${cellId}/resume`));
  }, [cellId, run]);
```
and return `{ cell, busy, error, start, stop, resume }`.

In `apps/web/src/shell/Hud.tsx` (Part 3's), add `onResume(): void;` to `HudProps`, destructure it,
and replace the `hud.action === "stop"` button with these two:
```tsx
        {!hud.stop && hud.action === "resume" && (
          <button type="button" className="a" onClick={onResume}>
            Resume computer
          </button>
        )}
        {!hud.stop && (hud.action === "stop" || hud.action === "resume") && (
          <button type="button" className="a" onClick={onStop}>
            <span className="sq" aria-hidden="true" />
            Stop computer
          </button>
        )}
```
`apps/web/src/shell/StageColumn.tsx` (Part 3's) destructures `onResume` and passes it to `<Hud>`.

In `apps/web/src/App.tsx`'s `Theatre`:
- take `resume` from `useCell(api)`;
- pass `onResume={resume}` to `StageColumn`;
- build the steps with the key uses (importing `timelineRows` from `./session/key-uses.ts`):
  ```tsx
  const rows = session.sessionId ? timelineRows(stepRows(session.model), session.model.keyUses) : [];
  ```

Append to `apps/web/src/app.css`:
```css
.keyuse {
  display: grid;
  grid-template-columns: 12px 1fr auto;
  column-gap: 8px;
  align-items: baseline;
  padding: 6px 0;
  font-size: 12.5px;
  color: var(--color-text-2);
}

.keyuse .kd {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-text-3);
  align-self: center;
}

.keyuse.blocked {
  color: var(--color-text);
}

.keyuse.blocked .kd {
  background: none;
  box-shadow: inset 0 0 0 1.5px var(--color-text);
}

.keyuse .kl {
  min-width: 0;
  overflow-wrap: anywhere;
}

.keyuse .kc {
  font-variant-numeric: tabular-nums;
  color: var(--color-text-3);
}

.keyuse .kp {
  grid-column: 2 / -1;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--color-text-3);
  overflow-wrap: anywhere;
}
```

`apps/web/e2e/stop-and-keys.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
import { type RunningDaemon, startDaemon } from "./daemon.ts";

const DOCKER = process.env.LOCALDOT_DOCKER_TESTS === "1";
let daemon: RunningDaemon;

test.skip(!DOCKER, "needs LOCALDOT_DOCKER_TESTS=1, the images, Docker Desktop and the internet");

test.beforeAll(async () => {
  daemon = await startDaemon();
});

test.afterAll(async () => {
  await daemon?.stop();
});

test("a key's use shows in the steps; Stop freezes the computer and Resume thaws it", async ({
  page,
}) => {
  const auth = { authorization: `Bearer ${daemon.token}` };
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);

  // A web API key for postman-echo.com, sealed in the page as a user would add it. The value is a
  // stand-in: postman-echo answers anything.
  await page.getByTestId("keys-button").click();
  const sheet = page.getByRole("dialog", { name: "Keys" });
  await sheet.getByRole("button", { name: "Web API" }).click();
  await sheet.getByLabel("Name", { exact: true }).fill("echo");
  await sheet.getByLabel("Hosts", { exact: true }).fill("postman-echo.com");
  await sheet.getByLabel("Key", { exact: true }).fill(`e2e-${Date.now()}-echo-value`);
  await sheet.getByRole("button", { name: "Save key" }).click();
  await expect(sheet.getByRole("status")).toHaveText("Saved echo.");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Start computer" }).click();
  await expect(page.getByTestId("hud-status")).toHaveText("Live", { timeout: 300_000 });
  const cells = (await (await fetch(`${daemon.origin}/api/cells`, { headers: auth })).json()) as {
    id: string;
  }[];
  const cellId = cells[0]?.id ?? "";

  // The puppet types a request carrying the key's surrogate into a terminal, then waits so the
  // session is still live when Stop is pressed.
  const script = {
    v: 1,
    title: "Use a web API key",
    steps: [
      { do: "launch", app: "terminal", waitMs: 4000 },
      {
        do: "type",
        text: 'curl -s -o /dev/null -H "Authorization: Bearer $LOCALDOT_KEY_ECHO" https://postman-echo.com/get',
      },
      { do: "key", combo: ["Return"] },
      { do: "wait", ms: 30_000 },
    ],
  };
  const started = await fetch(`${daemon.origin}/api/cells/${cellId}/puppet`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(script),
  });
  expect(started.status).toBe(202);
  await expect(page.getByTestId("key-use").first()).toContainText(
    "Used echo key → postman-echo.com",
    { timeout: 90_000 },
  );
  await page.screenshot({ path: "e2e/out/key-use.png" });

  // Stop: the session ends, keyd drops the computer's keys, and the computer freezes.
  await page.getByTestId("hud-stop-session").click();
  await expect(page.getByTestId("hud-status")).toHaveText("Paused", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Resume computer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop computer" })).toBeVisible();
  await page.screenshot({ path: "e2e/out/paused.png" });

  await page.getByRole("button", { name: "Resume computer" }).click();
  await expect(page.getByTestId("hud-status")).not.toHaveText("Paused", { timeout: 20_000 });
});
```

- [ ] **Step 4: Run the tests, and look at the HUD and the steps**

Run: `pnpm exec vitest run apps/web/src packages/stage && pnpm typecheck`
Expected: PASS. `key-uses.test.ts` has 3 tests, `KeyUseRow.test.tsx` 2, `Hud.test.tsx` 1 and
`hud-state.test.ts` one more; the stage model test passes; and Part 3's `mergeHud` and step-row
tests pass unchanged.

Rebuild the UI and the image, then run:
`LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e stop-and-keys.spec.ts`
Expected: PASS.
- A key saved in the sheet reaches the new computer as `$LOCALDOT_KEY_ECHO`, and the puppet's curl
  in the terminal shows up in the steps as `Used echo key → postman-echo.com`.
- Stop turns the HUD into `Paused` with Resume and Stop.
- Resume brings it back.

Open `apps/web/e2e/out/key-use.png` and `paused.png`:
- the key-use row reads as quiet text among the steps;
- the paused HUD is neutral (no xenon rim or accent, since nobody holds control) and its caption
  explains Resume.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint
git add apps/web/src apps/web/e2e/stop-and-keys.spec.ts packages/stage/src
git commit -m "feat(web): paused computers and key use in the Theatre"
```

---

### Task 14: A real cell reaches the web only through keyd — S4's probes from a cell

This task ports S4's `run.sh` and `chromium.sh` (Part 4a Task 17 pins the same probes in process).
They now run from a real desktop cell, as its user, through the forwarder, the gate and the cell's
own keyd listener, to the real internet. Each probe asserts its exit status and keyd's
`X-Keyd-Reason`. Before the first probe, the cell has passed its boot self-test.

| Probe | Expected |
|---|---|
| Direct egress with the proxy bypassed | `example.com` exit 6 (no DNS); `1.1.1.1` exit 7 (no route); IPv6 exit 7; `host.docker.internal` exit 6; Docker Desktop's host on 1234 and 11434 exit 7; the gate's address on any port but 3128 exit 7; `getent` exit 2 |
| `http://keyd.ldot/health` | 200, `{ ok: true, cell: <id> }`; straight to the gate without the token, or with a wrong one, 407 |
| Another container on the default bridge, at `host.docker.internal:<keyd port>` | 407 with no token and with a wrong one |
| A surrogate for its bound host | swapped upstream (the audit says `swapped`), and postman-echo's reflection comes back scrubbed to the surrogate |
| The bound host without a surrogate | 200 (P4a-R8) |
| An unknown surrogate (GET and PROPFIND) | 403 `unknown-surrogate` |
| A surrogate in the wrong header, over plain HTTP, or in the path | 403 `misplaced-surrogate` |
| A surrogate sent to an unbound subdomain | passes through its tunnel unswapped (P4a-R9) |
| `example.com` | passes through with its own certificate (issuer is not the cell's CA) |
| IP literals (`169.254.169.254`, `10.0.0.1`, `127.0.0.1`, `[::1]`, `0.0.0.0`) | 403 `ip-literal`; over CONNECT, exit 7 with the same reason |
| Plain HTTP to port 8080, CONNECT to 8443 | `port-not-allowed` |
| `printer.local` | `host-denied`; `localhost` gives `host-invalid` |
| `*.nip.io` names resolving to loopback, Docker Desktop, metadata or private ranges | 403 `address-denied` at dial time |
| keyd's audit for the cell | every line names the cell and its port, never holds the value or a surrogate, and redacts as `[surrogate:<ID>]` |
| Chromium through `--proxy-server` | loads `example.com` (passthrough) and the bound host (the cell's CA through NSS) |
| Node's `fetch` and Python | reach the web through the proxy; sudo keeps the proxy and CA variables, and apt's proxy setting is the forwarder (no apt or git fetch runs here) |

Loopback literals use `--noproxy ''`: the cell's `NO_PROXY` keeps its own loopback local, and that
is not what these probe. curl reports a refused CONNECT as exit 7 (curl 8). keyd only runs as a
child process, and the helpers here start nothing on the test thread.

**Files:**
- Create: `apps/daemon/src/keyd/testing/keyd-cell.ts`, `apps/daemon/src/keyd/cell-egress.docker.test.ts`

**Interfaces:**
- Consumes: `startKeyd` and `TEST_KEYD_PORTS` (Task 3); `CellKeydWiring` and `CellStore(home, range)`
  (Task 9); Part 2's `dockerExecAs`, `docker`, `DOCKER_TESTS` and `imagesFromEnv`; the image of
  Task 7.
- Produces:
  - `TEST_PREFIX = "localdot-test-"`;
  - `startKeydCell(secrets) → KeydCell { keyd; client; wiring; orchestrator; id; record; sh(script); close() }`;
  - `auditLines(keyd, cellId)`.

- [ ] **Step 1: Write the test and its helper**

`apps/daemon/src/keyd/testing/keyd-cell.ts`:
```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SecretBinding, sealSecret } from "@localdot/protocol";
import { DockerClient } from "../../cells/docker.ts";
import { imagesFromEnv } from "../../cells/images.ts";
import { CellOrchestrator } from "../../cells/orchestrator.ts";
import { probeDesktopd, probeStream } from "../../cells/readiness.ts";
import { CellStore } from "../../cells/store.ts";
import { dockerExecAs } from "../../cells/testing/docker-cli.ts";
import type { CellRecord } from "../../cells/types.ts";
import { CellKeydWiring } from "../cell-wiring.ts";
import { KeydClient } from "../client.ts";
import { type KeydProcess, startKeyd, TEST_KEYD_PORTS } from "./keyd-process.ts";

export const TEST_PREFIX = "localdot-test-";

export interface KeydCell {
  keyd: KeydProcess;
  client: KeydClient;
  wiring: CellKeydWiring;
  orchestrator: CellOrchestrator;
  id: string;
  record: CellRecord;
  // A login shell as the desktop's user, as the agent's terminal runs: the cell's proxy settings
  // and its surrogates (sourced from /etc/localdot/cell/surrogates.sh) are in its environment.
  sh(script: string): { status: number; out: string };
  close(): Promise<void>;
}

// A real keyd (in-memory vault, test ports) holding the given keys, and a ready desktop cell wired
// to it through its gate: the topology of a real install.
export async function startKeydCell(
  secrets: { binding: SecretBinding; value: string }[] = [],
): Promise<KeydCell> {
  const keyd = await startKeyd();
  const home = mkdtempSync(join(tmpdir(), "local dot's keyd-cell-"));
  const client = new KeydClient(keyd.socketPath);
  const docker = new DockerClient();
  const wiring = new CellKeydWiring({ keyd: client, docker });
  const orchestrator = new CellOrchestrator({
    docker,
    store: new CellStore(home, TEST_KEYD_PORTS),
    images: imagesFromEnv(),
    probeDesktopd,
    probeStream,
    namePrefix: TEST_PREFIX,
    keyd: wiring,
  });
  let id: string | undefined;
  const close = async () => {
    if (id) await orchestrator.remove(id, { purgeHome: true }).catch(() => {});
    orchestrator.dispose();
    await keyd.stop();
    rmSync(home, { recursive: true, force: true });
  };
  try {
    const { sealKey } = await client.status();
    for (const { binding, value } of secrets) {
      await client.putSecret(binding, await sealSecret(sealKey, binding, value));
    }
    const created = await orchestrator.create({ scale: 2 });
    id = created.id;
    await new Promise<void>((resolve, reject) => {
      const settle = (state: string | undefined, error?: string) => {
        if (state === "ready") resolve();
        if (state === "failed") reject(new Error(`the cell failed: ${error}`));
      };
      orchestrator.subscribe((c) => c.id === created.id && settle(c.state, c.error));
      const now = orchestrator.get(created.id);
      settle(now?.state, now?.error);
    });
    const record = orchestrator.record(created.id);
    if (!record) throw new Error("the cell has no record");
    const sh = (script: string) =>
      dockerExecAs(record.docker.desktop, "abc", "bash", "-lc", script);
    return { keyd, client, wiring, orchestrator, id: created.id, record, sh, close };
  } catch (err) {
    await close();
    throw err;
  }
}

// keyd's audit lines about one cell, parsed.
export function auditLines(keyd: KeydProcess, cellId: string): Record<string, unknown>[] {
  return readFileSync(join(keyd.home, "keyd", "audit.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.cell === cellId);
}
```

`apps/daemon/src/keyd/cell-egress.docker.test.ts`:
```ts
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imagesFromEnv } from "../cells/images.ts";
import { DOCKER_TESTS, docker } from "../cells/testing/docker-cli.ts";
import { auditLines, type KeydCell, startKeydCell } from "./testing/keyd-cell.ts";

// S4's run.sh and chromium.sh, ported (Part 4a Task 17 pins the same probes in process): every
// probe runs in a real desktop cell, through its forwarder, its gate and its keyd listener, to the
// real internet (example.com, postman-echo.com and nip.io must be reachable from this Mac).
const VALUE = `p4b-${randomBytes(12).toString("hex")}`;
const UNKNOWN = "ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA";

describe.skipIf(!DOCKER_TESTS)("a desktop cell reaches the web only through keyd", () => {
  let cell: KeydCell;
  let surrogate = "";
  // curl through the cell's proxy settings; -D - prints every header it receives, the proxy's
  // answer to a refused CONNECT included, so a refusal's X-Keyd-Reason is in the output.
  const curl = (args: string) => cell.sh(`curl -sS -m 30 ${args}`);
  const reason = (out: string) => /^x-keyd-reason: *(\S+)/im.exec(out)?.[1];

  beforeAll(async () => {
    cell = await startKeydCell([
      {
        binding: {
          id: "echo",
          kind: "http",
          hosts: ["postman-echo.com"],
          header: "Authorization",
          format: "bearer",
        },
        value: VALUE,
      },
    ]);
    const printed = cell.sh('printf %s "$LOCALDOT_KEY_ECHO"');
    expect(printed.status).toBe(0);
    surrogate = printed.out;
    expect(surrogate).toMatch(/^ld_key_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$/);
  }, 600_000);
  afterAll(async () => {
    await cell?.close();
  });

  it("has no way out but its gate: no route, no DNS, no IPv6, no host, no LAN", () => {
    const direct = (args: string) => cell.sh(`curl --noproxy '*' -sS -m 5 ${args}`);
    expect(direct("https://example.com/").status).toBe(6);
    expect(direct("https://1.1.1.1/").status).toBe(7);
    expect(direct("-6 'https://[2606:4700:4700::1111]/'").status).toBe(7);
    expect(direct("http://host.docker.internal:1234/").status).toBe(6);
    expect(direct("http://192.168.65.254:1234/").status).toBe(7);
    expect(direct("http://192.168.65.254:11434/").status).toBe(7);
    expect(direct(`http://${cell.record.docker.gateInternalIp}:80/`).status).toBe(7);
    expect(cell.sh("getent hosts example.com").status).toBe(2);
  });

  it("answers keyd's health check with this cell's id, and refuses a request without its token", () => {
    const health = curl("http://keyd.ldot/health");
    expect(health.status).toBe(0);
    expect(JSON.parse(health.out)).toEqual({ ok: true, cell: cell.id });
    const gate = `${cell.record.docker.gateInternalIp}:3128`;
    for (const proxy of [`http://${gate}`, `http://cell:${"x".repeat(43)}@${gate}`]) {
      const res = cell.sh(
        `curl -sS -m 10 -o /dev/null -w '%{http_code}' -x ${proxy} http://keyd.ldot/health`,
      );
      expect(res).toEqual({ status: 0, out: "407" });
    }
  });

  it("refuses another container that finds the cell's listener, with or without a token", () => {
    const target = `host.docker.internal:${cell.record.keydPort}`;
    for (const proxy of [`http://${target}`, `http://cell:${"x".repeat(43)}@${target}`]) {
      const intruder = docker(
        "run",
        "--rm",
        "--name",
        `localdot-test-intruder-${randomBytes(4).toString("hex")}`,
        "--entrypoint",
        "curl",
        imagesFromEnv().desktop,
        "-sS",
        "-m",
        "10",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-x",
        proxy,
        "http://keyd.ldot/health",
      );
      expect(intruder).toBe("407");
    }
  });

  it("swaps the surrogate for the bound host, scrubs the reflection, and audits the swap", () => {
    const echo = curl(
      `https://postman-echo.com/headers -H "Authorization: Bearer $LOCALDOT_KEY_ECHO"`,
    );
    expect(echo.status).toBe(0);
    expect(echo.out).toContain(`Bearer ${surrogate}`);
    expect(echo.out).not.toContain(VALUE);
    expect(
      auditLines(cell.keyd, cell.id).some(
        (l) => l.host === "postman-echo.com" && l.secretId === "echo" && l.swapped === true,
      ),
    ).toBe(true);
  });

  it("lets the bound host be browsed without a surrogate (P4a-R8)", () => {
    expect(curl("-o /dev/null -w '%{http_code}' https://postman-echo.com/get")).toEqual({
      status: 0,
      out: "200",
    });
  });

  it("blocks unknown and misplaced surrogates wherever they appear", () => {
    const unknown = curl(
      `-o /dev/null -D - https://postman-echo.com/headers -H "Authorization: Bearer ${UNKNOWN}"`,
    );
    expect(unknown.status).toBe(0);
    expect(reason(unknown.out)).toBe("unknown-surrogate");
    const propfind = curl(
      `-o /dev/null -D - -X PROPFIND https://postman-echo.com/ -H "Authorization: Bearer ${UNKNOWN}"`,
    );
    expect(propfind.status).toBe(0);
    expect(reason(propfind.out)).toBe("unknown-surrogate");
    for (const args of [
      `https://postman-echo.com/headers -H "X-Api-Key: $LOCALDOT_KEY_ECHO"`,
      `http://postman-echo.com/headers -H "Authorization: Bearer $LOCALDOT_KEY_ECHO"`,
      `"https://postman-echo.com/$LOCALDOT_KEY_ECHO"`,
    ]) {
      const res = curl(`-o /dev/null -D - ${args}`);
      expect(res.status).toBe(0);
      expect(reason(res.out)).toBe("misplaced-surrogate");
    }
  });

  it("passes a surrogate sent to an unbound host through its tunnel unswapped (P4a-R9)", () => {
    const res = curl(
      `https://www.postman-echo.com/headers -H "Authorization: Bearer $LOCALDOT_KEY_ECHO"`,
    );
    expect(res.status).toBe(0);
    expect(res.out).not.toContain(VALUE);
  });

  it("passes example.com through with its own certificate", () => {
    const res = curl("-o /dev/null -w '%{http_code} %{ssl_verify_result}' https://example.com/");
    expect(res).toEqual({ status: 0, out: "200 0" });
    const issuer = cell.sh(
      "echo | openssl s_client -proxy 127.0.0.1:3129 -connect example.com:443 -servername example.com 2>/dev/null | openssl x509 -noout -issuer",
    );
    expect(issuer.status).toBe(0);
    expect(issuer.out).not.toContain("localDot");
  });

  it("refuses addresses, odd ports and private names by policy", () => {
    // --noproxy '' sends loopback through the proxy too: the cell's NO_PROXY keeps its own
    // loopback services (CDP, desktopd) local, and that is not what these probe.
    const refused = (url: string) => {
      const res = curl(`--noproxy '' -o /dev/null -D - '${url}'`);
      return { status: res.status, reason: reason(res.out) };
    };
    for (const url of [
      "http://169.254.169.254/",
      "http://10.0.0.1/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://0.0.0.0/",
    ]) {
      expect(refused(url)).toEqual({ status: 0, reason: "ip-literal" });
    }
    expect(refused("https://1.1.1.1/")).toEqual({ status: 7, reason: "ip-literal" });
    expect(refused("http://example.com:8080/")).toEqual({ status: 0, reason: "port-not-allowed" });
    expect(refused("https://example.com:8443/")).toEqual({
      status: 7,
      reason: "port-not-allowed",
    });
    expect(refused("http://printer.local/")).toEqual({ status: 0, reason: "host-denied" });
    expect(refused("https://printer.local/")).toEqual({ status: 7, reason: "host-denied" });
    expect(refused("http://localhost/")).toEqual({ status: 0, reason: "host-invalid" });
  });

  it("refuses names that resolve to the Mac, Docker Desktop or a private range at dial time", () => {
    for (const name of [
      "127.0.0.1.nip.io",
      "192.168.65.254.nip.io",
      "169.254.169.254.nip.io",
      "10.0.0.1.nip.io",
    ]) {
      const res = curl(`-o /dev/null -D - http://${name}/`);
      expect(res.status).toBe(0);
      expect(reason(res.out)).toBe("address-denied");
    }
  });

  it("names this cell and its listener on every audit line, and never holds the value or a surrogate", () => {
    const lines = auditLines(cell.keyd, cell.id);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(line.port).toBe(cell.record.keydPort);
    const raw = JSON.stringify(lines);
    expect(raw).not.toContain(VALUE);
    expect(raw).not.toMatch(/ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}/);
    expect(raw).toContain("[surrogate:");
  });

  it("takes Chromium to the web through keyd, trusting the cell's CA for the bound host only", () => {
    const chromium = (url: string) =>
      cell.sh(
        `timeout 60 /usr/bin/chromium --headless=new --disable-gpu --disable-quic --proxy-server="$HTTPS_PROXY" --dump-dom ${url}`,
      );
    const example = chromium("https://example.com/");
    expect(example.status).toBe(0);
    expect(example.out).toContain("Example Domain");
    const bound = chromium("https://postman-echo.com/get");
    expect(bound.status).toBe(0);
    expect(bound.out).toContain('"host":"postman-echo.com"');
    expect(bound.out).not.toContain("ERR_CERT");
  });

  it("takes Node's fetch and Python through the proxy, and keeps it for sudo and apt", () => {
    const node = cell.sh(
      `/opt/node/bin/node -e 'fetch("https://example.com/").then((r) => console.log(r.status))'`,
    );
    expect(node).toEqual({ status: 0, out: "200\n" });
    const python = cell.sh(
      `python3 -c 'import urllib.request as u; print(u.urlopen(u.Request("https://example.com/", headers={"User-Agent": "localdot-test"})).status)'`,
    );
    expect(python).toEqual({ status: 0, out: "200\n" });
    const sudo = cell.sh("sudo -n env | grep -E '^(HTTPS_PROXY|NODE_EXTRA_CA_CERTS)=' | sort");
    expect(sudo).toEqual({
      status: 0,
      out: "HTTPS_PROXY=http://127.0.0.1:3129\nNODE_EXTRA_CA_CERTS=/etc/localdot/cell/ca.pem\n",
    });
    expect(cell.sh("apt-config dump Acquire::https::Proxy")).toEqual({
      status: 0,
      out: 'Acquire::https::Proxy "http://127.0.0.1:3129";\n',
    });
  });
});
```

- [ ] **Step 2: Run it**

This task adds tests only. They pin what Tasks 1 and 3–9 built, so they pass at once; a failure is
a regression in those tasks. To see that they can fail, run them once against an image built
before Task 7: `beforeAll` fails because the cell never passes its self-test.

Run (with the image of Task 9 built): `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/keyd/cell-egress.docker.test.ts`
Expected: PASS, 13 tests in about 10 s once the image is cached. Afterwards
`docker ps -a --filter name=localdot-test-` and `docker network ls --filter name=localdot-test-`
print nothing.

- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint
git add apps/daemon/src/keyd/testing/keyd-cell.ts apps/daemon/src/keyd/cell-egress.docker.test.ts
git commit -m "test(keyd): a real cell reaches the web only through keyd"
```

---

### Task 15: The canary never reaches a cell, and Stop freezes it

This task is success criterion 5 and the spec's Security test: "a canary secret planted in keyd
never appears in any cell's environment, files, process list or memory dump".

**Planting and using the canary.** A fresh random canary is planted as a web API key bound to
`postman-echo.com`. The cell uses it: keyd swaps it upstream, and postman-echo echoes it back,
scrubbed. What the cell got back goes to the X clipboard.

**The scanner.** `canary-scan.py` runs inside the cell as root with `docker exec --privileged`. It
searches for each needle, raw and in base64, base64url, hex and UTF-16LE:
- every process's environment, command line and readable memory (a crash dump is a copy of memory,
  and the clipboard is served from `xclip`'s memory);
- every file the container wrote: its layer's changes from `docker diff`, its tmpfs mounts and its
  home volume.

**The checks.**
- Both containers' logs and keyd's own files are searched too.
- A marker is planted where a leak would sit: in a file raw, in another file as base64, in a
  process's environment and so in memory. A scan for the marker must find it in each of those
  places, and the live surrogate in an environment and in memory. The canary's own scan looks for
  the marker too and must find it there again, so "nothing found" for the canary means absence, not
  blindness, in the very run that says so (review M1).
- The canary scan must also cover more than 20 processes, 100 MB of memory and 100 files. The
  scanner counts the bytes of memory it actually read, and a process only once some of its memory
  was read; what was mapped but unreadable counts for nothing.

**Then Stop.** A loop in the cell calls the bound host every second with the surrogate. The kill
switch must report `{ revoked: true, paused: true, closed: false }` and Docker must report the
desktop paused.
keyd must see no request at all for 4 s. After Resume the loop's old surrogate must be refused
(403) and never succeed again, and a new shell's surrogate must work.

**Files:**
- Create: `apps/daemon/src/keyd/testing/canary-scan.py`, `apps/daemon/src/keyd/canary.docker.test.ts`

**Interfaces:**
- Consumes: `startKeydCell` and `auditLines` (Task 14); `KillSwitch` and `LiveSessions` (Task 10);
  Part 2's `docker`, `dockerLogs` and `DOCKER_TESTS`.
- Produces: `canary-scan.py <needles…> --files <paths…>`, which prints
  `{"processes", "bytes", "files", "hits": ["needle|form|where"]}`: the processes whose memory it
  read, the bytes of memory it read, and the files it read.

- [ ] **Step 1: Write the scanner and the test**

`apps/daemon/src/keyd/testing/canary-scan.py`:
```python
# Looks for each needle, raw and in its base64, base64url, hex and UTF-16LE forms, in every
# process's environment, command line and readable memory, and in every regular file under the
# paths given after --files. Prints {"processes", "bytes", "files", "hits": ["needle|form|where"]}:
# the processes whose memory it read, the bytes of memory it read, and the files it read.
# Run as root with docker exec --privileged (reading other processes' memory needs ptrace rights).
import base64, json, os, sys

def forms(needle: bytes):
    yield "raw", needle
    yield "base64", base64.b64encode(needle).rstrip(b"=")
    yield "base64url", base64.urlsafe_b64encode(needle).rstrip(b"=")
    yield "hex", needle.hex().encode()
    yield "HEX", needle.hex().upper().encode()
    yield "utf16le", needle.decode().encode("utf-16-le")

CHUNK = 16 << 20
MAX_FILE = 256 << 20

def scan_stream(read, patterns, found, where):
    overlap = max(len(p) for _, _, p in patterns) - 1
    tail = b""
    while True:
        data = read()
        if not data:
            return
        window = tail + data
        for needle, label, p in patterns:
            if p in window:
                found.add((needle, label, where))
        tail = window[-overlap:]

def scan_processes(patterns, found):
    scanned, total, me = 0, [0], str(os.getpid())
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or pid == me:
            continue
        for kind in ("environ", "cmdline"):
            try:
                blob = open(f"/proc/{pid}/{kind}", "rb").read()
            except OSError:
                continue
            for needle, label, p in patterns:
                if p in blob:
                    found.add((needle, label, kind))
        try:
            maps = open(f"/proc/{pid}/maps").read().splitlines()
            mem = open(f"/proc/{pid}/mem", "rb", 0)
        except OSError:
            continue
        before = total[0]
        with mem:
            for line in maps:
                fields = line.split()
                if "r" not in fields[1] or (len(fields) > 5 and fields[5] in ("[vvar]", "[vsyscall]")):
                    continue
                start, end = (int(x, 16) for x in fields[0].split("-"))
                pos = [start]
                def read():
                    if pos[0] >= end:
                        return b""
                    size = min(CHUNK, end - pos[0])
                    try:
                        mem.seek(pos[0])
                        data = mem.read(size)
                    except OSError:
                        return b""
                    pos[0] += size
                    total[0] += len(data)
                    return data
                scan_stream(read, patterns, found, "memory")
        if total[0] > before:
            scanned += 1
    return scanned, total[0]

def scan_files(roots, patterns, found):
    count = 0
    for root in roots:
        for path in walk(root):
            try:
                st = os.lstat(path)
                if not os.path.isfile(path) or os.path.islink(path) or st.st_size > MAX_FILE:
                    continue
                with open(path, "rb") as f:
                    count += 1
                    scan_stream(lambda: f.read(CHUNK), patterns, found, "file " + path)
            except OSError:
                continue
    return count

def walk(root):
    if os.path.isfile(root) and not os.path.islink(root):
        yield root
        return
    for dirpath, _, names in os.walk(root, followlinks=False):
        for name in names:
            yield os.path.join(dirpath, name)

def main():
    args = sys.argv[1:]
    roots = args[args.index("--files") + 1:] if "--files" in args else []
    needles = args[: args.index("--files")] if "--files" in args else args
    patterns = [(n, label, p) for n in needles for label, p in forms(n.encode())]
    found = set()
    processes, total = scan_processes(patterns, found)
    files = scan_files(roots, patterns, found)
    print(json.dumps({"processes": processes, "bytes": total, "files": files,
                      "hits": sorted({f"{n}|{label}|{where}" for n, label, where in found})}))

main()
```

`apps/daemon/src/keyd/canary.docker.test.ts`:
```ts
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOCKER_TESTS, docker, dockerLogs } from "../cells/testing/docker-cli.ts";
import { KillSwitch } from "../gateway/kill-switch.ts";
import { LiveSessions } from "../gateway/live.ts";
import { auditLines, type KeydCell, startKeydCell } from "./testing/keyd-cell.ts";

// Success criterion 5: no real secret exists anywhere inside a cell. A canary key is planted in
// keyd and used from the cell; then every process's environment, command line and memory, every
// file the cell wrote, its clipboard and its logs are searched for the canary in every encoding.
const CANARY = `canary-${randomBytes(16).toString("hex")}`;
const SCAN = fileURLToPath(new URL("./testing/canary-scan.py", import.meta.url));
const SESSION = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";

interface ScanResult {
  processes: number;
  bytes: number;
  files: number;
  hits: string[];
}

describe.skipIf(!DOCKER_TESTS)("the canary never reaches a cell", () => {
  let cell: KeydCell;
  let desktop = "";
  // Planted where a leak would sit, raw and in base64: every scan for the canary also looks for
  // this, and must find it, so a canary scan that finds nothing has looked.
  const marker = `marker-${randomBytes(8).toString("hex")}`;
  const markerHits = [
    `${marker}|raw|file /tmp/marker.txt`,
    `${marker}|base64|file /tmp/marker.b64`,
    `${marker}|raw|environ`,
    `${marker}|raw|memory`,
  ];

  beforeAll(async () => {
    cell = await startKeydCell([
      {
        binding: {
          id: "canary",
          kind: "http",
          hosts: ["postman-echo.com"],
          header: "Authorization",
          format: "bearer",
        },
        value: CANARY,
      },
    ]);
    desktop = cell.record.docker.desktop;
    docker("cp", SCAN, `${desktop}:/tmp/canary-scan.py`);
    const encoded = Buffer.from(marker).toString("base64").replace(/=+$/, "");
    expect(cell.sh(`printf %s ${marker} > /tmp/marker.txt`).status).toBe(0);
    expect(cell.sh(`printf %s ${encoded} > /tmp/marker.b64`).status).toBe(0);
    docker("exec", "-d", "-u", "abc", "-e", `LOCALDOT_MARKER=${marker}`, desktop, "sleep", "600");
  }, 600_000);
  afterAll(async () => {
    await cell?.close();
  });

  // Every file the container wrote (its layer's changes), its home volume and its tmpfs mounts.
  const writtenPaths = () => {
    const changed = docker("diff", desktop)
      .split("\n")
      .filter((l) => /^[AC] /.test(l))
      .map((l) => l.slice(2))
      .filter((p) => !p.startsWith("/proc") && !p.startsWith("/sys") && !p.startsWith("/dev/"));
    const mounts = docker(
      "exec",
      desktop,
      "sh",
      "-c",
      "awk '$3 == \"tmpfs\" { print $2 }' /proc/mounts",
    )
      .split("\n")
      .filter((p) => p && !p.startsWith("/proc") && !p.startsWith("/sys") && p !== "/dev");
    return [...new Set([...changed, ...mounts, "/config"])];
  };
  const scan = (...needles: string[]): ScanResult =>
    JSON.parse(
      docker(
        "exec",
        "--privileged",
        "-u",
        "root",
        desktop,
        "/usr/bin/python3",
        "/tmp/canary-scan.py",
        ...needles,
        "--files",
        ...writtenPaths(),
      ),
    ) as ScanResult;

  it("uses the key from the cell: keyd swaps it upstream and scrubs the echo", () => {
    const echo = cell.sh(
      `curl -sS -m 30 https://postman-echo.com/headers -H "Authorization: Bearer $LOCALDOT_KEY_CANARY"`,
    );
    expect(echo.status).toBe(0);
    expect(echo.out).toMatch(/Bearer ld_key_/);
    expect(echo.out).not.toContain(CANARY);
    expect(
      auditLines(cell.keyd, cell.id).some((l) => l.secretId === "canary" && l.swapped === true),
    ).toBe(true);
    // What the agent copies goes to the X clipboard, served from xclip's memory.
    const copied = cell.sh(
      `printf %s ${JSON.stringify(echo.out)} | DISPLAY=:1 xclip -selection clipboard -loops 0 >/dev/null 2>&1 & sleep 1; DISPLAY=:1 xclip -o -selection clipboard`,
    );
    expect(copied.status).toBe(0);
    expect(copied.out).toContain("Bearer ld_key_");
  });

  it("finds the planted marker and the live surrogate, so a miss means absence", () => {
    const surrogate = cell.sh('printf %s "$LOCALDOT_KEY_CANARY"').out;
    docker("exec", "-d", "-u", "abc", "-e", `HOLDS=${surrogate}`, desktop, "sleep", "300");
    const found = scan(marker, surrogate);
    expect(found.processes).toBeGreaterThan(20);
    expect(found.hits).toEqual(
      expect.arrayContaining([
        ...markerHits,
        `${surrogate}|raw|environ`,
        `${surrogate}|raw|memory`,
      ]),
    );
  });

  it("finds the canary in no environment, command line, memory or file of the cell", () => {
    const result = scan(CANARY, marker);
    // Bytes of memory actually read, and files actually opened: not what was mapped or listed.
    expect(result.bytes).toBeGreaterThan(100 * 1024 * 1024);
    expect(result.files).toBeGreaterThan(100);
    expect(result.hits).toEqual(expect.arrayContaining(markerHits));
    expect(result.hits.filter((hit) => hit.startsWith(`${CANARY}|`))).toEqual([]);
  }, 300_000);

  it("finds the canary in neither container's logs, nor in keyd's audit log", () => {
    expect(dockerLogs(desktop)).not.toContain(CANARY);
    expect(dockerLogs(cell.record.docker.gate)).not.toContain(CANARY);
    const auditFiles = readdirSync(join(cell.keyd.home, "keyd")).filter((f) =>
      statSync(join(cell.keyd.home, "keyd", f)).isFile(),
    );
    for (const f of auditFiles)
      expect(readFileSync(join(cell.keyd.home, "keyd", f), "utf8")).not.toContain(CANARY);
  });

  it("Stop revokes the surrogates and freezes every process; resuming hands out new ones", async () => {
    const live = new LiveSessions();
    const killSwitch = new KillSwitch({ live, keyd: cell.wiring, cells: cell.orchestrator });
    const loop = `while :; do curl -s -m 10 -o /dev/null -w '%{http_code}\\n' -H "Authorization: Bearer $LOCALDOT_KEY_CANARY" https://postman-echo.com/get >> /tmp/loop.log; sleep 1; done`;
    docker("exec", "-d", "-u", "abc", desktop, "bash", "-lc", loop);
    const codes = () => cell.sh("cat /tmp/loop.log 2>/dev/null").out.split("\n").filter(Boolean);
    while (codes().filter((c) => c === "200").length < 2) await sleep(500);

    live.start(
      cell.id,
      SESSION,
      (signal) => new Promise((resolve) => signal.addEventListener("abort", resolve)),
    );
    expect(await killSwitch.stopSession(SESSION)).toEqual({
      revoked: true,
      paused: true,
      closed: false,
      errors: [],
    });
    expect(docker("inspect", "-f", "{{.State.Paused}}", desktop)).toBe("true");
    expect(cell.orchestrator.get(cell.id)).toMatchObject({ state: "ready", paused: true });
    const frozenAt = auditLines(cell.keyd, cell.id).length;
    await sleep(4000);
    expect(auditLines(cell.keyd, cell.id).length).toBe(frozenAt);

    const before = codes().length;
    await killSwitch.resume(cell.id);
    expect(docker("inspect", "-f", "{{.State.Paused}}", desktop)).toBe("false");
    while (codes().length < before + 3) await sleep(500);
    // The loop's shell still holds the revoked surrogate: keyd refuses it.
    expect(codes().slice(before + 1)).toEqual(expect.arrayContaining(["403"]));
    expect(
      codes()
        .slice(before + 1)
        .includes("200"),
    ).toBe(false);
    // A new shell reads the new surrogate.
    const fresh = cell.sh(
      `curl -sS -m 30 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $LOCALDOT_KEY_CANARY" https://postman-echo.com/get`,
    );
    expect(fresh).toEqual({ status: 0, out: "200" });
    cell.sh("pkill -f 'loop.log' || true");
  }, 120_000);
});
```

- [ ] **Step 2: Run it**

Like Task 14, these tests pin what earlier tasks built, so they pass at once. To see the canary
test fail for the right reason, add ``cell.sh(`printf %s ${CANARY} > /tmp/leak`);`` as the first line
of the "finds the canary in no environment…" test for one run. The scan then reports
`<canary>|raw|file /tmp/leak`. Revert it before committing.

Run: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/keyd/canary.docker.test.ts`
Expected: PASS, 5 tests in about 60 s. The memory scan reads every process of the desktop (about
70) in about 15 s; the bytes it reports are what it read, well under the 8 GB those processes map. Afterwards no `localdot-test-*` container,
network or volume is left.

- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint
git add apps/daemon/src/keyd/testing/canary-scan.py apps/daemon/src/keyd/canary.docker.test.ts
git commit -m "test(keyd): the canary never reaches a cell, and Stop freezes it"
```

---

### Task 16: The keyd suites in CI, the README, and the whole branch green

CI gets one job that builds keyd and runs the TypeScript suites against it. Linux runs them as the
Mac does: keyd's in-memory vault, a socket under `/tmp`, test listeners on 4791–4797, no internet
needed. The Docker and e2e suites stay local (they need Docker Desktop, the images and the
internet). The README tells a developer how to run keyd beside the daemon and how to test the key
layer.

**Files:**
- Modify: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: every earlier task.
- Produces: the CI job `keyd-integration`.

- [ ] **Step 1: The CI job**

Append to `.github/workflows/ci.yml`, after the `keyd` job Part 4a added (same indentation as
`check:`):
```yaml
  keyd-integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - uses: actions/setup-go@v5
        with:
          go-version-file: keyd/go.mod
          cache: false
      - run: pnpm install --frozen-lockfile
      - run: LOCALDOT_KEYD_TESTS=1 pnpm test:keyd
```

- [ ] **Step 2: The README**

Add to `README.md`, after the `## keyd` section:
```markdown
## Keys

Real API keys live only in keyd. In development, start it in its own terminal before the daemon:
`pnpm keyd` builds `keyd/bin/keyd` and runs it on `~/.localdot` (`LOCALDOT_HOME` too), keeping keys
in the login keychain; `pnpm keyd -vault memory` keeps them in memory only. The daemon reaches it at
`<home>/keyd/admin.sock` and refuses a socket other users could reach. Until keyd runs, computers do
not start and the top bar says "Key layer offline". `LOCALDOT_KEYD_PORTS` (default `4760-4789`) must
match keyd's `-ports`.

Add keys with the Theatre's **Keys** button. The page seals each key to keyd's key for this boot
(WebCrypto) and the daemon only relays the sealed copy. A computer never holds a key: its shells get
stand-ins named `LOCALDOT_KEY_<NAME>`, which work only through keyd and only for the hosts and header
the key is bound to, and its programs reach the web only through keyd. **Stop** revokes the
computer's stand-ins and freezes it (a computer that cannot be frozen loses its way to keyd
instead); **Resume computer** revokes again and thaws it with new ones, and needs keyd running.
The Keys sheet and `pnpm --filter @localdot/daemon run doctor` say whether keyd knows this network's
public address, which it refuses to dial (the hairpin guard).

Tests: `LOCALDOT_KEYD_TESTS=1 pnpm test:keyd` runs the daemon's suites against a real keyd built from
`keyd/` (Go 1.27; `LOCALDOT_KEYD_BIN` uses a built one). With Docker Desktop and the internet,
`LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/keyd/cell-egress.docker.test.ts` runs S4's
probes from a real cell, and `…/canary.docker.test.ts` proves that a planted key never reaches one.
```

- [ ] **Step 3: Run everything**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm hygiene && pnpm test
LOCALDOT_KEYD_TESTS=1 pnpm test:keyd
cd keyd && test -z "$(gofmt -l .)" && go vet ./... && go test -race ./... && cd ..
cells/desktop/build.sh
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-keyd-files.docker.test.ts
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/orchestrator.docker.test.ts
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/keyd/cell-egress.docker.test.ts
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/keyd/canary.docker.test.ts
pnpm --filter @localdot/web build
pnpm --filter @localdot/web e2e keys.spec.ts
LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e
```
Expected: every command passes.
- `pnpm test:keyd` runs 5 tests.
- Every keyd package is `ok` under `-race`.
- The four Docker suites pass.
- The e2e run passes Part 2's and Part 3's specs, `keys.spec.ts` and `stop-and-keys.spec.ts`.

Afterwards, these must all print nothing:
- `docker ps -a --filter name=localdot-test-`;
- `docker network ls --filter name=localdot-test-`;
- `docker volume ls --filter name=localdot-test-`;
- `pgrep -fl 'keyd -home'`;
- `ls -d "$TMPDIR"/localdot-keyd-bin-*`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci(keyd): run the daemon's keyd suites against a real keyd; document the key layer"
```

---

## M3 when this plan is done

| M3 item (spec "Milestones") | Where |
|---|---|
| keyd vault, surrogates, per-cell listeners, egress policy, SSRF guard, LLM gateway, budgets, audit, admin socket | Part 4a, with Task 1's last address rules and hairpin guard |
| key form | Tasks 4, 12a and 12b |
| self-tests | Task 2 (the checks the daemon requires), Task 8 (desktopd), Task 9 (the readiness gate, the isolation stop and the gateway refusal) |
| canary test | Task 15 |
| S4's probes from a real cell | Task 14 |
| Stop and the kill switch's key half (M5 builds the rest of control on it) | Task 10 |
| `key.use` in the event log | Tasks 11 and 13 |

## Interfaces later parts build on

**keyd from the daemon**
- `apps/daemon/src/keyd/client.ts` provides `KeydClient`:
  - methods: `status`, `secrets`, `putSecret`, `deleteSecret`, `openCell`, `cell`, `closeCell`,
    `revoke`, `mint`, `events`;
  - errors: `KeydError { status; code; detail }` and `KeydUnavailableError`;
  - `privateSocketProblem(path)`;
  - `status()` carries `hairpin` (`HairpinGuard`: `active`, `unknown` or `off`).

  M4 adds the methods it needs on the same `#json` and `#send` helpers:
  - `PUT /v1/cells/{id}/task` with `{ taskId, budgetUSD }` and `DELETE …/task`;
  - `PUT /v1/llm/routes/{route}/models`, with each priced model's `maxOutputTokens` from
    models.dev's `limit.output`: keyd refuses a priced model without it (P4a-R15);
  - `GET` and `PUT /v1/budget`.
- `apps/daemon/src/keyd/cell-wiring.ts` provides `CellKeyd` and `CellKeydWiring`. It opens a cell
  with role `desktop` and every `http` key. M4's brain cell opens with role `brain` and its `llm`
  keys, and takes keyd's gateway base URLs (`http://llm.ldot/<route>`, P4a), so it needs no CA.
  M7's signed-in browser cell opens with role `browser` and uses the same three files, NSS install
  and TLS-server-only system copy of the CA. `refreshRunningCells` gives every running or booting,
  unfrozen computer fresh surrogates. `revoke` of a cell keyd no longer knows revokes nothing.
- `apps/daemon/src/keyd/monitor.ts` provides `KeydMonitor` and `cameUp`; `KeydHealth.hairpin` is
  never `active` unless keyd says so.
- Part 2's `doctor` has the checks `keyd` and `hairpin-guard` (`DoctorDeps.keyd`). M9's doctor adds
  keyd's `audit-rotated` alert and every cell's `GET /selftest`.
- `apps/daemon/src/keyd/event-router.ts` appends `budget.exceeded` to the live session. M4 pauses
  the agent loop on it, and the UI offers to raise the budget with `PUT …/task` and the same
  `taskId` (not Stop, which ends the task in keyd: Part 4a review 2, N5).
- `apps/daemon/src/gateway/kill-switch.ts` provides `KillSwitch.stopSession` and `resume`. M5's
  "stop everything" runs them over every cell of the task: brain, desktop and browser. It revokes
  each, pauses the desktop and browser (closing in keyd any it cannot pause), and aborts the
  brain's loop through the session. `resume` revokes before it mints and throws
  `KeydUnavailableError`, the computer still frozen, while keyd is offline. M5's pause
  (`pause.change`) is a different, agent-level pause and does not freeze the cell.
- Routes:
  - `GET /api/keyd`, `GET` and `POST /api/keys`, `DELETE /api/keys/:id`;
  - `POST /api/cells/:id/resume` (503 while the key layer is offline);
  - `POST /api/sessions/:id/stop` → 202 `{ revoked, paused, closed, errors }`.

  `withReadyCell` refuses a paused computer with 409.
- The cell store takes a keyd port range (`new CellStore(home, range)`): the daemon reads it from
  `LOCALDOT_KEYD_PORTS`, and it must match keyd's `-ports`. `store.folder(id)` says where a record
  lives; `SkippedCellsError` names each unreadable record's folder and containers, and reconcile
  stops those cells (this home's only) and closes them in keyd.
- The orchestrator keeps a frozen cell frozen through a daemon, keyd or gate restart, and never
  restarts a frozen desktop. Its startup reconcile asks keyd about each running cell, so a cell
  keyd lost while the daemon was away is rewired even when keyd answered before the reconcile
  reached it.

**keyd**
- `/v1/status` reports `hairpin`: `{ state: "active" | "unknown" | "off", source?: "nat-pmp" | "stun", addresses, checkedAt?, error? }`.
- `-natpmp on|off` (default on) asks the default gateway first; `-stun host:port|off` (default
  Cloudflare's) is asked only when the router gives no public address. keyd asks again every 30 s
  while the address is unknown and every 5 minutes once it is known. M9's LaunchAgent runs keyd
  with the defaults and offers `-stun off`.

**In the cell**
- Files: `/etc/localdot/cell/{proxy-token,ca.pem,surrogates.sh}` (written before every start).
- The proxy: `http://127.0.0.1:3129` (the forwarder), and `NO_PROXY` holds loopback only.
- Surrogates: `LOCALDOT_KEY_<ID>` (`surrogateEnvName`), sourced by login and interactive shells.
  M4's shell tool must start its shells the same way (`bash -l`), or source the file.
- The self-test: `GET /selftest` returns a `SelfTestReport` with checks `route`, `direct-ipv4`,
  `direct-ipv6`, `dns`, `host`, `gateway`, `keyd-token`, `keyd`, `forwarder`, `ca-system` and
  `ca-nss`. `SELFTEST_CHECKS` in `@localdot/protocol` is the list the daemon requires, each exactly
  once: a new check goes there and into desktopd in one change, and an image without it never gets
  ready.
- The system copy of the CA is an OpenSSL `TRUSTED CERTIFICATE` for serverAuth only; NSS holds it
  as `C,,`.

**UI**
- `apps/web/src/keys/*`: `saveKey(api, binding, value)`, `bindingOf`, `valueProblem`, `useKeys`,
  `keyStatus` (`guard` while the hairpin guard is not active) and `KeysSheet`. M9's onboarding
  ("paste keys") reuses `KeyForm` and `saveKey`.
- `SessionModel.keyUses` and `timelineRows` let M6's replay show key use from a stored log with no
  change.

**Not in Part 4b**
- **The LaunchAgent and a signed keyd binary (M9, P4b-R18).** Until then:
  - keyd is started by hand (`pnpm keyd`);
  - the Keychain items trust `/usr/bin/security` (P4a-R3);
  - a keyd started later than the daemon is noticed within 2 s, and the cells it lost are rewired.
- **A key added while a computer runs**, for a host its CA does not cover, reaches that computer at
  its next start. The UI says so.
- **Surrogates reach shells, not graphical apps** started from the dock. A graphical app that needs
  a key reads `/etc/localdot/cell/surrogates.sh` (P4b-R4).
- **"keyd down → the task pauses"** (spec "Error handling") is M4's: M3 has no agent loop. Until
  then a computer whose keyd went away has no egress, and keyd's return rewires it (P4b-R8).
- **Stop needs a live session.** A computer nobody drives has no session to stop: "Stop computer"
  (Part 2's `POST /api/cells/:id/stop`) covers it.
- **The router's own IPv6 addresses** (its WAN address, other delegated /64s) stay reachable. keyd
  learns the public IPv4 address only (NAT-PMP and STUN over IPv4); a global IPv6 address is
  dialled like any other.
- **A PCP-only router** answers NAT-PMP's request with a version error, and keyd falls back to STUN
  (or, with `-stun off`, stays unknown and says so). PCP's MAP request would create a mapping on the
  router, so keyd does not send it.
- **GnuTLS clients do not trust the cell's CA.** GnuTLS ignores a `TRUSTED CERTIFICATE`, so git's
  HTTPS transport and GLib programs reach every host keyd passes through, but a host bound to a key
  (which keyd intercepts) fails their certificate check: closed, never open.
- **A computer whose freeze failed** lost its keyd cell at Stop. It has no egress until it is
  stopped and started, or until keyd restarts and `rewireIfLost` restarts it like any running
  computer.
- **keyd's `audit-rotated` alert** (Part 4a) is not shown: the health carries `audit.ok` only. M9's
  doctor shows it.

## Decisions taken by this plan (P4b-R1 to P4b-R31)

Review 1's verdicts (`part4b-review-1.md`) and the controller's rulings P4b-C1 and P4b-C2 are
applied: R1, R2, R17 and R18 stand; R15 stands with R14 scoped; R6, R7, R14 and R16 changed;
R20 and R22 follow; R28 to R31 are new.

- **P4b-R1 One forwarder in each cell adds the proxy token.** The cell's programs use
  `http://127.0.0.1:3129` with no credentials. A forwarder on the cell's loopback adds
  `Proxy-Authorization` and relays to the gate.
  - Why: Chromium ignores credentials in `--proxy-server` (Part 4a). One URL then works for every
    runtime, and the token never sits in an environment variable, which every process and crash
    report copies.
  - Cost if wrong: one more process per cell; if it dies, egress stops (fails closed) until s6
    restarts it. Part 4a's alternative was a Chromium extension answering the 407, for Chromium
    only.
- **P4b-R2 `NO_PROXY` is loopback only** (`localhost,127.0.0.1,::1`), where Part 4a's obligations
  said "empty".
  - Why: the cell's own services (DevTools on 9222, desktopd's helpers, the forwarder itself) are on
    its loopback, which never leaves the cell. Everything else, the host names and the LAN included,
    goes to keyd.
  - Cost if wrong: none for egress. An empty list would send the cell's own loopback calls to keyd,
    which refuses them.
- **P4b-R3 keyd's material for each start goes in as files**, written with Docker's archive API
  into the stopped container. They are `proxy-token`, `ca.pem` and `surrogates.sh` in
  `/etc/localdot/cell`.
  - Why: keyd mints a new token, CA and surrogates at every open, while a container's environment
    is fixed at create. Files need no recreate, no bind mount and no `docker exec` arguments.
  - Cost if wrong: if Docker ever refuses archives on stopped containers, the files would go in
    right after start, before the s6 oneshot runs.
- **P4b-R4 Surrogates live in shells as `LOCALDOT_KEY_<ID>`.** They are sourced from
  `/etc/profile.d` and `/etc/bash.bashrc`, not set in the container's environment.
  - Why: the prefix keeps a key named `path` or `https_proxy` from shadowing a variable the cell
    relies on, and only shells (the agent's tools) need them.
  - Cost if wrong: a graphical app that wants a key reads the file.
- **P4b-R5 The self-test fails closed, and the daemon is the judge.**
  - Any failing check keeps the cell from ready, and a check that cannot conclude fails.
  - An *isolation* failure stops the desktop at once and fails the cell with the check's name.
  - A keyd or trust failure keeps it starting until the readiness timeout, named in the error.
  - The daemon recomputes the verdict from the checks rather than trusting the report's `ok`.
  - Cost if wrong: a cell on an engine without isolated gateway mode never starts. That is the
    point, and `doctor` (M9) explains it.
- **P4b-R6 Stop runs as abort → revoke → settle (≤ 4 s) → pause, and a pause that fails closes the
  cell in keyd** (changed after review 1: C1, I2, M8, M9). Only the desktop is paused, and the gate
  stays up.
  - A frozen computer refuses input, launches and puppet runs with 409.
  - Resume revokes the cell again before anything thaws, then writes fresh surrogates, or restarts
    the desktop if keyd lost the cell. With keyd offline it answers 503 and the computer stays
    frozen.
  - A frozen computer stays frozen across a daemon restart, a keyd restart (R7) and a gate restart;
    a frozen desktop that dies is not started again. Pausing and resuming each watch the cell
    afresh.
  - Stop computer and Remove close the cell in keyd first and need no thaw: Docker stops a paused
    container itself (it signals it, then resumes it).
  - Why: Part 4a's revoke leaves the listener open (P4a-R20). The settle wait keeps a frozen
    `desktopd` from holding the session's last call until it times out and acting after a resume.
  - Cost if wrong: the listener stays open for the whole settle window, so for up to 4 s every
    process keeps surrogate-free web egress (its surrogates are already revoked). If 4 s is too
    short for a slow action, that action lands after the resume; if it is too long, Stop takes up
    to 4 s to freeze. A computer whose pause failed has no egress until it is stopped and started,
    or until keyd restarts.
- **P4b-R7 When keyd restarts, running desktops restart, frozen ones do not** (changed after
  review 1: C1). keyd's restart replaces every cell's listener, token and CA. A running Chromium
  cannot take a new CA, and the token file alone would leave old tunnels' trust. So `rewireIfLost`
  restarts a running desktop with new material, and the startup reconcile asks the same of each
  running cell. A desktop Stop froze is left frozen: restarting it
  would boot whatever the agent left in its home, unfrozen and with working surrogates. Resume
  rewires it.
  - Cost if wrong: a keyd crash restarts the user's running computers and closes their windows.
    keyd restarts are rare (crash, upgrade).
- **P4b-R8 With keyd offline, computers do not start.** The error reads "the key layer is offline:
  start keyd, then start the computer again". Running ones keep running with no egress until keyd
  is back, and are then rewired.
  - Cost if wrong: none for safety. A computer with no internet could still be useful offline, but
    the spec's "keyd down: cells have no egress" holds either way.
- **P4b-R9 The key form exposes no method or path restrictions.** It asks for the kind, name,
  provider and base URL, or hosts, header and format. keyd accepts methods and paths through the
  API.
  - Why: YAGNI. Every first-party provider and most web APIs need neither.
  - Cost if wrong: two more optional fields in `KeyForm`.
- **P4b-R10 The key exists in the page only in the key field's DOM value.**
  - React state never holds it. The field is cleared as soon as sealing starts, and a failed save
    asks for the key again.
  - It is a text field drawn as dots (`-webkit-text-security: disc`), not a password field, which
    Chrome offers to save to the user's synced password manager whatever `autocomplete` says
    (review M4). It is marked `autocomplete="off"`, `data-1p-ignore` and `data-lpignore`, so
    password managers leave it alone.
  - Cost if wrong: a user re-pastes after a failure.
- **P4b-R11 A key change reaches running computers.** After a save or delete, `refreshRunningCells`
  mints fresh surrogates for every ready, unfrozen computer. keyd revoked the changed key's
  surrogates everywhere, so without this a running computer would keep a dead stand-in. A web key
  bound to a host outside a running computer's CA needs a restart, and the form says so. Frozen
  computers get theirs at Resume.
  - Cost if wrong: surrogates accumulate in keyd's registry, one per key per change, until the cell
    closes. They are bounded and harmless.
- **P4b-R12 keyd's events go into the session at no more than 20 per second per cell**, folded into
  counted runs in the steps.
  - Why: a cell can make keyd refuse thousands of requests. The audit log keeps every one, and the
    timeline only needs to show that it happened.
  - Cost if wrong: a burst shows as fewer rows than requests. The daemon's log counts the rest.
- **P4b-R13 The daemon talks only to a private socket.** The admin socket and its folder must
  belong to the user, with no group or other permission bits, or the daemon refuses to use them.
  - Why: whoever answers there hands the UI the key to seal to.
  - Cost if wrong: a keyd home on a file system without Unix permissions cannot be used. None is
    supported.
- **P4b-R14 Reconcile stops this home's unreadable cells and removes nothing** (changed after
  review 1: I1). For each folder Part 2's store reports as skipped (a `cell.json` it cannot read),
  reconcile closes the cell in keyd and stops its containers by exact name. Part 2's
  `SkippedCellsError` keeps `create()` from handing out a port while one exists, and names the
  folder and the containers to clean up. A cell with no folder in this home (an e2e run's, or the
  user's own under another `LOCALDOT_HOME`, which share the prefix) is never touched.
  - Why: keyd knows a cell by its port, and the sweep this replaced removed every unknown cell of
    the prefix: an e2e run deleted the user's running computers.
  - Cost if wrong: a cell whose record is corrupt stays stopped until the user fixes or removes its
    folder; nothing of it is lost.
- **P4b-R15 The cell store owns the keyd port range.** A record outside it is not this daemon's,
  and the orchestrator allocates from it. Tests and e2e use 4791–4797; `LOCALDOT_TEST_KEYD_PORTS`
  moves the tests' range when two checkouts test on one Mac.
  - Cost if wrong: a daemon restarted with a different `LOCALDOT_KEYD_PORTS` skips its old cells'
    records: creating a computer is refused, and those cells are stopped and closed in keyd until
    the range is restored. Nothing is removed.
- **P4b-R16 Hairpin NAT is closed by the router first** (changed after review 1: I8; controller
  ruling P4b-C2, which the user may veto). keyd learns the network's public IPv4 address and denies
  it like the Mac's own:
  1. NAT-PMP's external address request to the default gateway (RFC 6886), so no third party
     learns anything;
  2. only if the router gives no public address, one STUN server, Cloudflare's (`-stun off`
     turns it off, `-natpmp off` the router);
  3. while the address is unknown it asks again every 30 s, and every 5 minutes once known;
  4. `/v1/status`, `doctor` and the Keys sheet say `active`, `unknown` or `off`, never silently.

  Start never waits for it. Old addresses are kept, up to 16. Tests pass `-natpmp off -stun off`.
  - Cost if wrong: an outbound call the user did not want (STUN, only when the router has no
    answer), or a guard that stays unknown on a router without NAT-PMP when STUN is off: a hairpin
    to the router's public address then stays possible (its admin page would also need a name
    resolving to that address), and the UI and `doctor` say so.
- **P4b-R17 IPv6 is global unicast only** (controller residual). keyd dials nothing outside
  `2000::/3` except the well-known NAT64 prefix, whose embedded IPv4 address is checked. Named
  rules cover `2001:2::/48`, `2001:10::/28`, `2001:20::/28` and `3fff::/20`. Part 4a's integrity
  test's "just outside" edges move to the denied list.
  - Cost if wrong: if IANA allocates outside `2000::/3`, keyd refuses it until this rule changes.
- **P4b-R18 The LaunchAgent is M9's.** The spec puts install (`npx localdot`, "starts keyd as a
  LaunchAgent") in M9, and M3 lists only keyd's functions. Development runs `pnpm keyd`.
  - Cost if wrong: in M3 keyd must be started by hand before computers can start, and the UI says
    so.
- **P4b-R19 The Cua Driver gets no proxy variables.** Part 3's explicit environment stays. It has no
  business on the web, and with no route its egress fails closed even if its telemetry were turned
  on.
  - Cost if wrong: none.
- **P4b-R20 Chromium gets the forwarder and NSS trust.** The launcher passes `--proxy-server`
  (the forwarder) and `--disable-quic`. The desktop session waits for the CA oneshot, and Chromium
  trusts the cell's CA through NSS with `C,,`, since Chromium trusts a name-constrained CA only
  there (S4). Every old `localdot-cell` entry is deleted first, so trust never outlives the
  listener. The system copy is for TLS server auth only too (R30).
  - Cost if wrong: a Chromium launched outside the launcher uses no proxy and has no route out.
- **P4b-R21 The forwarder never shows a 407.** A refused token becomes 502 with
  `X-Localdot-Reason: proxy-token-refused`.
  - Why: a 407 makes Chromium prompt for proxy credentials.
  - Cost if wrong: none.
- **P4b-R22 Stop answers 202 with what happened**, `{ revoked, paused, closed, errors }` (`closed`:
  keyd closed a cell that could not be paused). It stays 202 without a body when no kill switch is
  wired, as Part 3's tests expect.
  - Cost if wrong: none.
- **P4b-R23 The kill switch freezes even when keyd is down**, and reports what failed.
  - Why: the freeze is the part that holds without keyd.
  - Cost if wrong: none.
- **P4b-R24 The acceptance tests use the real internet**: `postman-echo.com` as the bound host,
  `example.com` and `nip.io`.
  - Why: keyd refuses loopback, LAN and Docker addresses by design, so no local upstream can stand
    in.
  - Cost if wrong: offline, the Docker suites fail at the first probe. They are opt-in.
- **P4b-R25 The canary scan covers four places.** It searches every process's environment, command
  line and memory (crash dumps and the X clipboard included), the files the container wrote
  (`docker diff`, tmpfs, the home volume), both containers' logs and keyd's files.
  - Positive controls come first, and minimum coverage counts are asserted.
  - Cost if wrong: a file written to an anonymous volume other than the home is not scanned. The
    image declares none.
- **P4b-R26 Exit statuses are pinned to curl 8**: 6 for no DNS, 7 for no route and for a refused
  CONNECT, and 2 for `getent`.
  - Cost if wrong: a curl upgrade that renumbers fails the probes loudly.
- **P4b-R27 The audit redaction format is pinned** to Part 4a's implementation, `[surrogate:<ID>]`
  (controller's interface note). The router cuts keyd's fields, which are capped at 2 KiB, to the
  event's limits.
  - Cost if wrong: one expected string in Task 14.

- **P4b-R28 The daemon decides which self-test checks there are** (review I3). `SELFTEST_CHECKS`
  lists all eleven, and a report passes only with each exactly once and every check ok, whatever
  desktopd chose to run.
  - Why: an image built before a check existed, or a bundling or wiring bug, would otherwise pass
    with checks missing (success criterion 5: a self-test that fails closed).
  - Cost if wrong: a new check needs the protocol and the image to change together; an image
    without it never gets ready, which is the point.
- **P4b-R29 No reachable gateway address, checked twice** (review I4, trust rule 1). In the cell,
  the `gateway` check connects to the internal network's gateway slot on ports 53 and 80: an answer
  or a refusal means the address is held, so the cell never gets ready and is stopped. Outside it,
  the orchestrator refuses an internal network whose IPAM reports a gateway, so the create fails
  and is undone.
  - Why: on an engine that ignores isolated gateway mode, every other check still passes, and
    Docker Desktop's VM listeners answer on the bridge gateway.
  - Cost if wrong: if something dropped both ports silently, the in-cell check would pass; the IPAM
    refusal and `doctor` still catch such an engine.
- **P4b-R30 The cell's CA is trusted for TLS server auth only** (review I5, Part 4a carry C3). The
  system copy is an OpenSSL `TRUSTED CERTIFICATE` whose trust settings name serverAuth alone; NSS
  holds it as `C,,`; Node reads it for TLS only. The self-test fails a bundle that holds it as a
  plain anchor.
  - Why: OpenSSL trusts a plain anchor for every purpose, and its code-signing purpose ignores the
    CA's own serverAuth-only key usage (verified with OpenSSL 3.6: a code-signing leaf the CA signed
    verifies against a plain anchor and is rejected against the trusted one).
  - Cost if wrong: GnuTLS clients (git's HTTPS, GLib programs) ignore the trusted form, so a host
    bound to a key fails their certificate check (closed, never open).
- **P4b-R31 A key name whose variable is taken is refused** (review M2). `a-b` and `a_b` share
  `LOCALDOT_KEY_A_B`, so the key routes answer 409 `name-taken` for the second.
  - Cost if wrong: a user who wanted both spellings renames one.

## Verification

Done on the development Mac on 2026-10-01, in a scratch copy, before the plan was written. The
plan's code is embedded from that copy. The setup:
- Tools: Node 25.6.0, Go 1.27.1, TypeScript 7.0.2, Biome 2.5.15, Vitest 5.0.3, Playwright 1.63.0
  with Chrome 154, OpenSSL 3.6.3 and GnuTLS 3.8.13.
- The scratch copy:
  - `feat/core-part2` at `1ba1659` (through its Task 12), with the Part 2 plan's Tasks 13 to 15;
  - Part 3 written from its plan text (revision 6) as far as this plan touches it (listed below),
    with its Task 12: Docker requests that time out, and the startup reconcile in the background;
  - Part 4a's keyd: `feat/core-part4a` at `56990a5` for `audit`, `cellca`, `events`, `netguard`,
    `policy`, `scrub`, `surrogate` and `vault`, and the Part 4a plan for `admin`, `egress`, `keys`,
    `llm` and `cmd/keyd`.

**What ran and passed:**
- **Go.**
  - `gofmt` and `go vet`, clean.
  - `go test -race ./...` for the whole module: 13 packages, 253 tests. Part 4a's login-keychain
    test skips without its opt-in.
  - `netguard`, `cmd/keyd` and `admin` five more times under `-race`.
- **The public address, live.** On the development Mac's network, from a copy of `netguard`: the
  router refused NAT-PMP (port unreachable), so keyd asked Cloudflare's STUN server, and the guard
  reported `active` from `stun` with one address, in 15 ms.
- **Vitest.**
  - The whole unit suite: 64 files, 542 tests. Every unit-test count in this plan's steps matches.
  - Part 3's `main.test.ts` against this plan's `main.ts`: the daemon answers `/healthz` while a
    wedged Docker socket holds the reconcile, with keyd's monitor, router and routes wired.
  - `typecheck` in all six packages, and `hygiene`.
  - `lint`, clean but for findings that predate this plan: Part 2's `.stage-veil` specificity
    warning, and the control characters in Part 3's `text.ts`.
- **Red first.** The review's pinning tests fail against the code this plan held before the review:
  - protocol's `selftest.test.ts`, 2 of 3;
  - desktopd's `selftest.test.ts`, 7 of 11;
  - `orchestrator-keyd.test.ts`, 9 of 16;
  - `kill-switch.test.ts`, 8 of 15.
- **The real keyd.** `pnpm test:keyd` passed, 2 files and 5 tests:
  - Node WebCrypto seals, opened by Go;
  - a tampered binding refused with `bad-seal`;
  - a misplaced surrogate through a cell listener refused with 403, plus a `key.use` deny;
  - 407 without a token;
  - revoke, mint, close and delete;
  - a stale seal refused with 409.

  No keyd process or build folder was left behind.
- **Chrome.** `keys.spec.ts` passed 2/2 against a daemon and a real keyd. The sheet's screenshots
  were checked. The web API form's "Sent as" select ran past the sheet's edge, and its columns are
  now `minmax(0, 1fr)`.
- **The trust settings.** With OpenSSL 3.6.3:
  - a TLS server certificate from the cell's CA verifies against the `TRUSTED CERTIFICATE` copy;
  - a code-signing chain is refused (error 28, "certificate rejected");
  - a plain copy of the same CA, alone or next to the trusted one, accepts that code-signing chain.

  GnuTLS 3.8.13 skips the `TRUSTED CERTIFICATE` block ("issuer is unknown").

**What could not be run** (assumptions this plan makes about code that does not exist yet, and
what this Mac could not exercise):
1. **Docker.** No Docker suite ran for this revision. They typecheck, but none of them ran:
   - `desktop-keyd-files`;
   - Part 2's `orchestrator.docker.test.ts` with keyd;
   - `cell-egress`;
   - `canary`;
   - Part 2's `desktop-image.docker.test.ts` and `live-desktop.spec.ts` against the Part 4b image.

   Also unverified: the Dockerfile edit; `update-ca-certificates` on Ubuntu 26.04 keeping the
   `TRUSTED CERTIFICATE` (the checks above used the Mac's OpenSSL); and NSS's copy in Chromium.
2. **Part 3 is not on any branch yet**, so every edit to a Part 3 file is written against Part 3's
   plan text:
   - daemon: `gateway/live.ts`, `gateway/routes.ts` (`withReadyCell`, `GatewayRoutesDeps`), the
     desktopd registry, and `main.ts`'s gateway option;
   - desktopd: `DesktopdDeps`, `createDesktopdApp` and its test helpers;
   - the Chromium launcher, `localdot-chromium`;
   - web: `Hud.tsx`, `StageColumn.tsx`, `PlanRail.tsx`, `session-view.ts` (`mergeHud`,
     `stepRows`), and `useCell`'s run error;
   - stage: `model.ts` (`foldEvents`, `SessionModel`) and its test;
   - protocol: `clipText`.

   `kill-switch-routes.test.ts` ran against a stand-in shaped like Part 3's `gatewayRoutes`, with
   stub `Clock` and `DesktopdRegistry` objects. `stop-and-keys.spec.ts` and the stage model test
   never ran: they depend on Part 3's puppet, terminal launch, step list and event schema.
3. **Part 2 after `1ba1659`.** Its Tasks 13 to 15 are taken in their plan form: `App.tsx`'s
   `Theatre`, `TopBar.tsx`, `app.css`, `hud-state.ts`, `useCell.ts` and `e2e/daemon.ts`.
4. **Part 4a after `56990a5`.** `admin.go`'s status handler, `cmd/keyd/main.go` (its `Config`,
   flags and `Serve`), `egress`, `keys` and `llm` are taken from the Part 4a plan. keyd's admin API,
   ready line, flags, error codes, refusal reasons and event shapes matched that plan in every test
   that touched them.
5. **A router that speaks NAT-PMP.** NAT-PMP's answer path ran only against the tests' fake router.
6. **The CI job** has not run.
