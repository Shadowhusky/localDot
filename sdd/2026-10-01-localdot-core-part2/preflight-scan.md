# Pre-flight conflict scan: localDot core Part 2 plan

Plan: `docs/superpowers/plans/2026-10-01-localdot-core-part2.md` (8,792 lines, all read). Spec:
`docs/superpowers/specs/2026-09-30-localdot-core-design.md` (all read). Carry-forward:
`docs/superpowers/plans/2026-09-30-localdot-core-part1-carry-forward.md` (all read). Repo:
`localdot` on `feat/core-part2` at `b778394` (= `992e82d` + one SUMMARY.md docs commit). Scan date
2026-10-01. Line numbers below are plan lines unless a file is named.

## What was checked, and how

- The whole plan, task by task, against itself (tests against code, test counts, Files blocks against
  steps, Interfaces against code) and against every later task that consumes its output.
- The repo at HEAD: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`,
  `biome.json`, `.gitignore`, `ci.yml`, `README.md`, every `apps/daemon/src` file the plan modifies or
  imports from (`app.ts`, `main.ts`, `lock.ts`, `event-log.ts`, `event-stream.ts`, `guard.ts`,
  `token.ts`, `port.ts`, `paths.ts` and their tests), `packages/protocol/src/{ids,index}.ts`,
  `scripts/check-hygiene.mjs`, the S1/S2/S3/S6 spike scripts and FINDINGS, and the pnpm store
  (esbuild 0.28.2, tsx 4.23.15, vite 8.3.1, hono 4.13.12, ws 8.22.0, TypeScript 7.0.2, Biome 2.5.15,
  Vitest 5.0.3 are all present).
- Part 1 test count: 106 `it(...)` lines plus 37 `it.each` rows = 143, matching the plan's figure
  (546).
- Static checks on a scratch copy (outside the repo, nothing in the repo was changed). I applied every
  full-file code block in task order and hand-applied the partial edits (Tasks 6a, 6b, 10, 11, 12,
  13, 14, 15). Then I ran the repo's own `tsc` 7.0.2 on `apps/daemon`, `cells/desktop/desktopd`,
  `packages/protocol` and the non-RTL web sources (with React 19.3 types borrowed read-only from
  another local project), and the repo's own `biome check` with HEAD's config plus Task 12's
  `files.includes`.
- Two standalone repros in the scratchpad: the Task 11 relay ordering, and the Task 14 endless
  ReadableStream loop. I didn't run the repo's test suite or Docker.
- Upstream sources for the base-image "facts" the plan relies on: linuxserver
  `docker-baseimage-selkies` (Dockerfile, `init-nginx`, `svc-de`, nginx `default.conf`),
  `docker-webtop` ubuntu-xfce (Dockerfile, `startwm.sh`, `/defaults/xfce/*`), selkies
  (`selkies-ws-core.js`, `websockets_mode.py`, `stream_server.py`), and moby `validateEndpointSettings`
  at `v28.0.0` and `docker-v29.2.0` (static IPs on a Docker-assigned subnet).

Counts: **8 Critical, 4 Important, 18 Minor** (30 findings).

---

## Table A: task pairs that share a file or an interface

| Tasks | Shared file/interface | Produces (earlier) | Consumes (later) | Finding |
|---|---|---|---|---|
| 1 → 2, 3, 3b, 5 | `apps/daemon/src/cells/testing/docker-cli.ts` | `docker`, `dockerOk`, `dockerExec`, `dockerExecAs(container,user,...cmd)`, `publishedPort(container,port)`, `subnetOf`, `removeAll`, `sleepSync`, `waitFor(label,pred,ms,everyMs=1000)` (303–359) | T2 imports docker/dockerExec/dockerExecAs/dockerOk/removeAll (692–699). T3 adds publishedPort/sleepSync/waitFor and calls `waitFor("xfce4-panel", pred, 180_000)` (1058, 1155). | OK against the code. Interfaces text says `waitFor(pred, ms)` and omits `dockerExecAs` (188–190) → F26. `removeAll` uses `docker rm -f` without `-v` (343) → F10. |
| 1 → 6, 8, 9 | `DOCKER_TESTS` | `LOCALDOT_DOCKER_TESTS === "1"` (306) | `describe.skipIf(!DOCKER_TESTS)` (2436, 4550, 4874) | OK |
| 1 → 2, 3, 3b, 5, 6, 8, 9 | `vitest.docker.config.ts` + root `test:docker` | `"test:docker": "vitest run --config vitest.docker.config.ts"` (236) | `pnpm test:docker -- <file>` (761, 1162, 1421, 2201, 2449, 4627, 4885) | Mismatch: the `--` disables the file filter → F9 |
| 1 → 5, 12, 13, 14 | root `vitest.config.ts` | includes `apps/*/src/**/*.test.tsx`, `cells/*/desktopd/src/**/*.test.ts`, excludes `**/*.docker.test.ts`, keeps HEAD's three globs (221–230) | desktopd `app.test.ts` (1910), web tests (6259–6786, 6972, 7792, 7917) | OK. There's no `globals: true`, so RTL auto-cleanup is off → F20. |
| 1 → 8 | `hostAddress(cidr, offset)` | ipv4.ts (280–300) | `hostAddress(internalSubnet, GATE_OFFSET)`, `(egressSubnet, GATE_OFFSET)`, `(internalSubnet, DESKTOP_OFFSET)` (4296–4298) | OK (argument order and offsets 10/11 are consistent) |
| 1 → 8 | Gate env and relay ports | `LD_INTERNAL_ADDR/LD_EGRESS_ADDR/LD_DESKTOP_ADDR/LD_KEYD_PORT`; egress:8081→desktop:7700, egress:8082→desktop:3000; waits ≤15 s for the internal address (379–410) | `gateSpec` Env, `GATE_PORTS` `8081/tcp`/`8082/tcp`, egress network first, then `POST /networks/{internal}/connect` (3481–3509, 4369–4379) | OK. Static IPs on Docker-assigned subnets aren't proven by S3 (it used dynamic IPs and names), but moby `v28.0.0` and `docker-v29.2.0` `validateEndpointSettings` only range-check them on user-defined networks, so it is OK for Engine ≥28 (the doctor minimum). |
| 1 → 3b, 12–15 | `.gitignore` | desktopd dist, web dist, `apps/web/e2e/out/`, s8 client, test-results (240–246) | T3b appends `apps/daemon/src/cells/testing/out/` (1419); e2e writes `e2e/out/*` (8464, 8577) | OK. Two lines are redundant with HEAD's `dist/`. Shot outputs land outside the ignore → F12. |
| 2 → 3 → 3b → 5 | `cells/desktop/Dockerfile` | `base` + `selkies-client` + `FROM base AS desktop` (583–663); T3 `COPY root/ /` and `RUN chmod 755 …` (1009–1010) + ENV; T3b ARGs/RUNs before `COPY root/` and "add `/usr/local/bin/localdot-plank` to the chmod line" (1230–1266) | T5 rewrites the chmod line without localdot-plank (2151–2152) and the final stage (2153–2160) | **Mismatch → F8** |
| 2 → 5 | `cells/desktop/build.sh`, `.dockerignore` | build.sh `--target desktop` (674–680); `.dockerignore` keeps `desktopd/dist` (666–671) | T5 replaces build.sh (2163–2170); `COPY desktopd/dist/desktopd.mjs` (2157) | OK |
| 2 → 4 → 14 | `selkies-client` stage, `extract-selkies-client.sh <dest>` | COPY `/usr/share/selkies/selkies-dashboard/{index.html,assets,icon.png,icon-512.png}` + `/usr/share/common-licenses/MPL-2.0` (652–660); script (1478–1495) | `spikes/s8-hosted-client/extract.sh` (1508–1513); T14 vendors into `apps/web/vendor/selkies` (7749) | OK. Upstream copies `/buildout/selkies-dashboard` to `/usr/share/selkies/`, and `init-nginx` copies it to `/usr/share/selkies/web` at runtime, so the Dockerfile path and the Task 4 prose path (1443–1444) are both right. The dashboard's `public/` has `icon.png`, `icon-512.png` and `manifest.json`. |
| 2 → 3 → 3b → 5 | `desktop-image.docker.test.ts` | T2: 5 tests (690–757) | T3 appends 8 (1048–1154); T3b changes 2 expectations and adds 2 tests (1389–1419); T5 changes `startDesktop`'s return value and adds 1 test (2177–2199) | Counts 5→13→15→16 OK. T5 doesn't widen the declared return type (1051) → F19. |
| 3 → 3b | `startwm.sh`, `xsettings.xml.in`, `xfwm4.xml.in` | scale→xfwm4 theme `Default`/`Default-xhdpi` (844–849); `@SCALE@`/`@THEME@` templates (862–981) | T3b swaps in `WhiteSur-Light`/`-xhdpi` (1299–1305), Net names, `button_layout` (1288–1297), and updates the two test expectations (1389–1392) | OK. Spec text drift → F28. |
| 3 → 4 | Selkies auth and port | `CUSTOM_USER=localdot`, `PASSWORD`, nginx :3000, `/api/websockets` (1014–1040, 799–803) | S8 `run-desktop.sh` `-p 127.0.0.1:4791:3000 -e PASSWORD=s8password`; `host.mjs` `AUTH = localdot:s8password` (1516–1544) | OK (upstream `init-nginx`: `PASSWORD` + `CUSTOM_USER` → htpasswd, port 3000, `/api` → Selkies) |
| 3 → 8 | Desktop env and stream credential | `LOCALDOT_SCALE`, `SELKIES_MANUAL_WIDTH/HEIGHT`, nginx user `localdot`, `/api/health` behind basic auth (799–803, 1115–1117) | `desktopEnv` (3511–3523); `endpointsFor` `Basic localdot:<stream token>` (4158–4164); `probeStream` `GET /api/health` (4062–4072) | OK (Selkies `stream_server.py` `GET /api/health` always 200) |
| 3 → 15 | `SELKIES_VIDEO_FULLCOLOR` | baked `true` (1024) | `desktopEnv(record, {fullcolor})` appends `SELKIES_VIDEO_FULLCOLOR=…` (8330–8333) | OK (container env overrides image ENV) |
| 3b → 5 | Mode of `/usr/local/bin/localdot-plank` | Only made executable by the chmod line (1265–1266); autostart `Exec=` (1365) | T5's chmod line (2152) | **F8** |
| 4 → 11 | S8 cadence and relay design | FINDINGS sets `STREAM_PING_MS`/`STREAM_STALL_MS` (1799–1802); `host.mjs` relay (1595–1638) | `STREAM_PING_MS = 500`, `STREAM_STALL_MS = 1500` (5941–5942); `relay()` (6031–6074) | Constants OK. Both relays accept the viewer before dialing upstream and drop viewer messages until the upstream opens → **F1** |
| 4 → 14 | Tap path | page.html: `contentDocument.getElementById("videoStream")`, `track.clone()`, MSTP (1679–1687) | `DesktopFrame` + `tapVideoTrack` (7990–7998, 8154–8176) | OK |
| 5 → 7 | `DesktopdHealth` | desktopd `app.ts` (2054–2067) | daemon `cells/types.ts` copy (2991–3003) | OK (identical shape) |
| 5 → 8 | desktopd health contract | `GET /healthz` + `Bearer <LOCALDOT_DESKTOPD_TOKEN>`, port 7700 (2085–2097, 2110–2127) | `probeDesktopd` (4049–4060); `desktopEnv` `LOCALDOT_DESKTOPD_TOKEN=` (3520); gate 8081→7700 | OK |
| 5 → root | `pnpm-workspace.yaml`, `pnpm typecheck` | adds `cells/desktop/desktopd` (1846–1852) | `pnpm -r --if-present typecheck` (HEAD) | OK (desktopd typechecks clean in scratch) |
| 6 → 8, 9 | `DockerClient`, `DockerError`, `DockerVersion` | rejects only for status ≥400, so 304 resolves `undefined` (2393–2405); `socketPath` public (2374) | `isStatus(err, 304, 404)` (4335): 304 never rejects, harmless; doctor `err.status === 404` (4824), `docker.socketPath` (4773), `v.Version` major (4774) | OK |
| 6a ↔ 10 | `apps/daemon/src/main.ts` | 6a: SIGHUP and `DaemonLockError` branch (2677–2695) | 10 replaces the token/app/server block (5495–5528) | Lock and signals OK. HEAD's `server.on("error")` is dropped → F14. Import order → F5. |
| 6b ↔ Part 1 | `event-log.ts` | `createSession` writes `session.json` first; `#stateOf` re-inserts the row; `ORDER BY …, s.id DESC` (2821–2888) | Part 1 `event-log.test.ts` (16 tests) | OK. `#stateOf` runs per folder from `#recoverAll()` at construction and on cache misses only. The locked-index test uses cached state, so the new un-wrapped INSERT isn't hit. |
| 7 → 8 | `CellStore`, `newCellToken`, `allocateKeydPort`, types | (3147–3266, 2931–3004) | orchestrator (4076–4104, 4287–4311) | OK. Allocation race → F24. |
| 7 → 10, 11 | `TicketRegistry` | `issue`/`resolve`/`revoke`, `TICKET_PATTERN` (3222–3251) | `cellRoutes` (5398–5400, 5446–5455), `cellFor` (5952–5955) | OK |
| 7 → 13 | Cell types | daemon `CellSummary`/`StreamState`/`CellState` (2932–2953) | web copy (6950–6969) | OK (identical) |
| 8 → 9 | Fake Docker + network spec | `startFakeDocker({gatewayOnInternal, version})`, `state.images`, `internalNetworkSpec`, `ISOLATED_GATEWAY_OPTION` (3583–3734, 3438, 3463–3471) | doctor tests and impl (4659–4845) | OK. The probe network carries the `localdot.cell` label → F10. |
| 8 → 10 | `CellApi`, `CellListener`, `UnknownCellError` | orchestrator exports (4118–4123, 4151–4156) | fake-orchestrator (5098–5164), `api.ts` (5383–5473), `status-stream.ts` (5345–5380) | OK (typechecks, including `FakeOrchestrator implements CellApi`) |
| 8 → 11 | `endpoints(id)`, `updateStream(id, patch)` | (4212–4229) | stream proxy (5979–5991, 6010–6018, 6033–6034) | OK |
| 8 → 15 | `desktopSpec`/`desktopEnv`, `OrchestratorDeps` | (3511–3548, 4106–4116) | `opts: DesktopOptions`, `streamFullcolor` (8324–8343) | OK (applied in scratch; typechecks) |
| 10 → 11 | Upgrade router, `AppOptions`, routes array, fake-orchestrator | `UpgradeRoute{auth: "token" \| "ticket"}`, `refuse` (4949–4960); `AppOptions.cells` (5479–5484); routes (5527); `endpointsById`/`streamUpdates` (5105–5107) | `desktopStreamRoute` with `auth: "ticket"` (5997–6020); `AppOptions.desktop` (6082–6091); routes (6101–6105); proxy tests (5810–5839) | OK |
| 10 → 12 | `app.ts`, `main.ts` | `createApp({…, cells})` (5486–5490) | `ui?: {dir}`, `serveUi` after the guard (6870–6872) | OK |
| 10 → 13 | REST + status socket | `GET /api/cells`; `POST /api/cells {scale?}`→202 JSON; start/stop→202; the socket sends a `CellSummary` on connect and on every change and closes 1000 after `removed` (5402–5455, 5350–5379) | `useCell` (7077–7139); `socketProtocols()` (6508) | OK |
| 10 → 14 | Stream ticket | `{ticket, path: "/cells/:id/desktop/:ticket/"}`, 409 unless ready (5446–5455) | `Stage` asks only when ready and uses `path` (8195–8211) | OK |
| 11 → 12 | `static-ui.ts`, `readStatic` | stub `webDir` (6107–6117); `StaticFile {body: Buffer}` (5624–5639) | `serveUi` (6837–6868) | `webDir` OK. `c.body(Buffer)` doesn't typecheck in either task → **F4** |
| 11 → 14 | Vendored client + WS path | `desktopRoutes` serves `webDir("vendor/selkies")` (5957–5976, 6098); WS pattern `^/cells/:id/desktop/:ticket/api/websockets$` (6001) | Vendored files (7749); Selkies derives `<prefix>/api/websockets` (1452–1453; `selkies-ws-core.js`: `pathname += 'api/websockets'`) | Paths OK. Relay drop → **F1** |
| 11 → 13, 14, 15 | Stream connection states | `connecting`→`live`/`stalled`→`disconnected`/`none` (6046–6064) | `hudFor` (7044–7052), veil (8214), e2e `Live` (8468) | Mapping OK. The crash path shows "Starting…" where the spec says "Reconnecting…" → F28. |
| 12 → 13 | `App.tsx`, `App.test.tsx`, `ApiClient`, `openSocket` | (6452–6570, 6691–6786) | T13 replaces the connected branch and test 2 (7312–7379, 7663–7684) | OK (12 → 15 tests) |
| 12 → 14 | `biome.json` excludes, hygiene allowlist | `!apps/web/vendor`, `!apps/web/dist` (6248) | Vendored assets (7749–7774) | OK (hygiene scans only `git ls-files --cached --others --exclude-standard`; `ALLOWLIST` is a `Set`) |
| 12 → 15 | Web scripts and daemon harness | `e2e: playwright test`, `shot` (6168–6174); `/healthz` and `<home>/daemon-token` (HEAD, 5507) | `e2e/daemon.ts` (8383–8435), specs | OK |
| 13 → 14 | `StageColumn` children, `.stage` CSS, `app.css`, `App.tsx` | children inside `.stage` (7299–7309); `.stage > canvas` (7559–7575) | `<Stage>` inside the column (8235–8241); `canvas.stage-canvas` (8122–8130); `app.css` append (8243–8279) | OK |
| 14 → 15 | Stage DOM contract | `data-frames/fps/size`, `.stage.lit`, `.stage-veil.on`, `data-testid="hud-status"`, button names | e2e (8463–8502), measure (8548–8572) | OK. "Starting…" uses the default 5 s timeout → F23. |
| 3b → 15 | Desktop look | WhiteSur light, Plank, menu bar | e2e screenshot review (8507–8509) | OK, once F8 is fixed |

## Table B: each task

| Task | Tests vs code | Files block vs steps | Repo assumptions at HEAD | Finding |
|---|---|---|---|---|
| 1 | ipv4: 2 tests; every case checked (`/16`+300 → `.1.44`; 255, 0, no prefix, octet 300, IPv6 → RangeError). Gate test: 6 tests, matching "6 tests pass". `pnpm test` = 143 + 2 confirmed. | OK. Interfaces drift (`waitFor`, `dockerExecAs`) → F26 | `package.json` scripts exist; HEAD `vitest.config.ts` has the three globs the replacement keeps; `.gitignore` already has `dist/`. Branch step contradicts the repo → F21. S3: `host.docker.internal` → 127.0.0.1 listener OK. BusyBox `ip -4 -o`/`sleep 0.1` OK. | F9 (from Task 2 on), F21, F26 |
| 2 | 5 tests match "5 tests pass". Tool checks match upstream: webtop installs chromium (wrapper `chromium` + `chromium-browser`, S1 FINDINGS 81–83), mousepad, xfce4-terminal, xfce4 (Thunar wrapper); base has git, curl, jq, python3, xdotool. | OK | `.dockerignore` keeps `desktopd/dist`; `selkies-client` paths match upstream layout; `MPL-2.0` is in Ubuntu `base-files`. Base also ships Node 22 (NodeSource) in `/usr/bin`; `/usr/local/bin/node` wins. | F11 (pip unhashed), F10 (anonymous `/config` volume), F9 (runs 11 tests, not 5) |
| 3 | 8 tests; 13 total matches. Facts checked upstream: `svc-de` runs `/defaults/startwm.sh` as abc after `xrandr --dpi 96`; webtop `startwm.sh` uses `dbus-launch --exit-with-session`; `/defaults/xfce/{xfce4-panel,xfwm4,xsettings}.xml` exist (panel size 26); s6 names `svc-de`, `svc-selkies`, `init-services` exist; log strings `fixed 2560x1600`/`audio off` (S1 FINDINGS 100). | OK | none | F9 |
| 3b | +2 tests; 15 matches. xfwm4 expectations updated in step. | `.gitignore` edited (1419, 1434) but not listed → F26 | `import` from ImageMagick installed in T2 | F26, F30 (cwd-relative paths); breaks later via F8 |
| 4 | Spike: no unit tests; expected outputs consistent with the dashboard layout | `package.json` listed in Files but missing from the File map (149) → F26 | `spikes/*` is a workspace glob; Biome excludes `spikes`; `ws@8.22.0` in store | **F1** (`host.mjs` relay has the same drop; S8 can misread a black stage), F26 |
| 5 | Unit: 5 tests, each checked against `hidpiReport`/`bearerMatches`. Docker: 16. | OK | Workspace and tsconfig paths resolve; tsx/esbuild versions in the store; desktopd typechecks clean (tsc 7.0.2). | **F8**, F19 |
| 6 | 5 unit + 1 Docker; messages match the assertions (`docker 404 on …: No such container`, `…; is Docker Desktop running?`) | OK | none | F9, F25 |
| 6a | 10 tests, each traced through link/rename/finally-rm; "own pid" fails at HEAD (`isAlive(self)` → `DaemonLockedError`), as Step 2 says | OK | `main.ts` has `constants`, `lockHome`, `fail`, `process.on("exit", releaseLock)`; HEAD lock.test has 7 tests | F5 (`lock.test.ts`, `main.ts` imports), F22 |
| 6b | ids +2, event-log +3. `ulid(now)` exists; `CROCKFORD`/`ULID_PATTERN` in-module; ULID vector 1469918176385 and `2025-10-01T10:00:00.000Z` correct. | OK | `home()`, `thinking`, `idle`, fs/path/protocol imports exist (only `rmSync` missing, as stated); `vi.mock("node:fs")` passes through; protocol `schema` script exists | none |
| 7 | 7 tests; flipped-ticket and traversal cases traced | OK | `@localdot/protocol` exports `ulid`, `ULID_PATTERN`; daemon depends on it | none (F24 is in T8) |
| 8 | spec 6 + orchestrator 11 = 17 matches. Subnets 172.21/172.22 and ports 50000/50001 consistent. The restart test fails. | OK | `[role, info]` destructure and `as {Internal?: boolean}` cast typecheck | **F2**, **F5** (`spec.test.ts`), **F6**, F10, F13, F24 |
| 9 | 6 unit + 1 Docker; fake covers every route used | OK | `parsePort` exists (`port.ts`); daemon has tsx for the `doctor` script | **F5** (`doctor.ts`), F15, F10 |
| 10 | api 5 + status 2. All 10 Part 1 event-stream tests re-traced against the router: 400 unparsable, 403 host/origin/token, 404 unknown session, 403 bad id, absolute-form foreign host 403. | OK | `WS_TOKEN_PREFIX`, `isAllowedHost/Origin(…, port)`, `tokenFromHeaders`, `tokensMatch` match their HEAD signatures; guard → `/api/*` order matches the API tests (401 without bearer) | **F5** (`status-stream.test.ts`, `main.ts`), F14 |
| 11 | static 2 + watchdog 1 (timeline traced: 6 pings, stalled at t=500). Proxy 5, but 2 fail on the relay race. | `static-ui.ts` stub created (6107–6117) but not listed → F26 | HEAD guard lets an Origin-less POST through, so the 405 expectation holds | **F1**, **F4**, F16, F26 |
| 12 | 9 lib + 3 App = 12 matches; static-ui 2 | OK | Keeps HEAD `biome.json` includes; jsdom at root; web sources typecheck under React 19.3 types; Vite 8 oxc picks `jsx: react-jsx` from the tsconfig | **F4**, F12, F20 |
| 13 | hud 3 + App 3 + lib 9 = 15 matches | `cells/types.ts` and `shell/Mascot.tsx` missing from the File map → F26 | none | F12, F20, F28 |
| 14 | Stage tests total 5, plan says 4. `pump` "stops reading" hangs. | `scripts/check-hygiene.mjs` committed (8304) but not listed → F26 | `MediaStreamTrackProcessor` isn't in TS 7's DOM lib (no clash, verified); vendored dir matches `webDir("vendor/selkies")` | **F3**, **F5** (`pump.test.ts`, `render-worker.ts`), **F7**, F12, F17, F18 |
| 15 | e2e 1 + measure 1; harness spawns node directly in its own process group; token file and `/healthz` match | `main.ts`, `spec.test.ts` edits not listed → F26 | README has `## Development`; `ci.yml` exists on Node 24 | F10, F23 |

---

## Findings

### F1 (Critical): the stream relay drops the viewer's messages until the upstream opens

**Where:** Task 11 `relay()` (6016–6018, 6035, 6066–6068), its tests (5871–5906), and the S8 `host.mjs`
relay (1601–1628).

**Plan:** `wss.handleUpgrade(req, socket, head, (client) => relay(client, …))` (6016), then inside
`relay()`: `const upstream = new WebSocket(upstreamUrl, …)` (6035) and
`client.on("message", … if (upstream.readyState === WebSocket.OPEN) upstream.send(…))` (6066–6068).
The tests send right after the viewer's `open`: `await …ws.once("open"…); … ws.send("hello"); expect(await echoed)…`
(5875–5878). The 1012 test does `await open; for (const s of selkies.state.sockets) s.terminate();`
(5901–5903). `host.mjs` uses the same pattern (1601–1627).

**Evidence:**
- A scratch repro of this exact ordering (ws 8.22.0, loopback) gives
  `{"trials":50,"echoed":0,"dropped":50,"upstreamConnectedWhenViewerOpened":0}`. The upstream has
  never connected when the viewer's `open` fires.
- So "relays the WebSocket both ways" waits forever for `echo:hello`. "closes the viewer with 1012"
  finds `selkies.state.sockets` empty and waits forever for `close`. That's 2 of the 5 tests in
  "Expected: 5 proxy tests pass" (6122).
- It also matters live. Selkies' client (`selkies-ws-core.js` `onSocketOpen`) sends
  `websocket.send('_gz,1')`, then `` `SETTINGS,${settingsJson}` ``, then `'cr'` as soon as the socket
  opens. The server (`websockets_mode.py`) gates per-connection work on `client_settings_received`
  ("Blocks on client_settings_received, which may never be set").
- S1 never saw this because its `http-proxy` forwarded the upgrade first. S8 can show a black stage
  and work down a troubleshooting list (1756–1777) that doesn't name this cause.

**Fix:** dial the upstream first and complete the viewer's upgrade from the upstream's `open`. On
upstream `error` or `unexpected-response`, `refuse(socket, "502 Bad Gateway")`. Alternatively, queue
viewer messages until `open`. Make the same change in `host.mjs`. In the tests, wait for
`connections().at(-1) === "live"` before sending or terminating.

### F2 (Critical): the restart test expects new ports after a restart that never touches the gate

**Where:** Task 8 test "restarts an exited desktop with backoff and reads the new ports" (3930–3954).

**Plan:** `const before = orchestrator.endpoints(cell.id)?.desktopd.baseUrl;` (3934), the desktop is
killed (3937–3940), then `expect(orchestrator.endpoints(cell.id)?.desktopd.baseUrl).not.toBe(before);`
(3952).

**Why it fails:** the endpoints are the gate's published ports (`#readPorts(d.gate)`, 4382). The
restart path `#startContainers` (4365–4388) starts the gate first. The fake answers a running gate
with `if (c.running) return { status: 304 };` and only reassigns `c.ports` on a real start
(3686–3693). The client resolves 304 (only ≥400 rejects, 2399). So the gate keeps 50000/50001, `after
=== before`, and the assertion fails with the plan's own implementation. Real Docker behaves the same:
the desktop publishes no ports. Review Focus 2 (116–121) depends on this test.

**Fix:** kill the gate in this test (or add a gate case) and assert the new endpoints. For the
desktop-only case, assert `desktop.starts === 2` and unchanged endpoints.

### F3 (Critical): the pump test "stops reading when stopped" hangs the Vitest worker

**Where:** Task 14 test (7826–7840) and the pump loop (7880–7905).

**Plan:** an endless source `pull(controller) { pulls += 1; controller.enqueue(fakeFrame()); }`, a loop
whose only await is `await reader.read()`, and then `await new Promise((r) => setTimeout(r, 20));`.

**Why it hangs:** each `read()` resolves through microtasks only, so the loop never yields to
timers. A scratch repro of the same source and loop never fired its 20 ms timer and had to be killed
by a 6 s alarm (exit 142). Vitest's own per-test timeout is a timer too, so the worker hangs.
`pnpm test` hangs locally, and CI's `pnpm test` hangs until the job limit.

**Fix:** make the test source yield to the macrotask queue
(`async pull(c) { await new Promise((r) => setTimeout(r, 1)); c.enqueue(fakeFrame()); }`), or have
`pumpFrames` yield.

### F4 (Critical): `c.body(Buffer)` doesn't typecheck in Tasks 11 and 12

**Plan:** `export interface StaticFile { body: Buffer; type: string; }` (5624–5627), used as
`return c.body(file.body, 200, {…})` at 5973, 6854 and 6865. Tasks 11 and 12 both commit with
`pnpm typecheck` (6129, 6916).

**Evidence:** Hono 4.13.12 declares `export type Data = string | ArrayBuffer | Blob | ReadableStream | Uint8Array<ArrayBuffer>`
(`context.d.ts:13`), and `Buffer` is `Buffer<ArrayBufferLike>`. tsc 7.0.2 on the assembled daemon:

```
src/cells/stream-proxy.ts(47,19): error TS2769: No overload matches this call. … Argument of type 'Buffer<ArrayBufferLike>' is not assignable to parameter of type 'null'.
src/static-ui.ts(17,19) / (28,19): same
```

Those are the only daemon type errors in the whole plan (plus F19 if its instruction is taken
literally).

**Fix:** declare `body: Uint8Array<ArrayBuffer>`. `readFileSync` returns `NonSharedBuffer`, which
assigns to it. With that change the daemon typechecks clean (verified). Update the Interfaces line
too (5568).

### F5 (Critical): `pnpm lint` fails on unsorted imports in six tasks

**Why:** the plan's per-task command is `pnpm format && pnpm lint` (Global Constraint, 96).
`pnpm format` is `biome format --write .`, which doesn't organize imports. `pnpm lint` is
`biome check .`, which reports Biome's `assist/source/organizeImports` as an error. I verified both on
scratch copies.

**Flagged lines.** Biome sorts names uppercase-first when two names differ only in case, and orders
packages `@hono/node-server`, `hono`, `vitest`, `ws`.

| Task | Line | Plan code | Biome wants |
|---|---|---|---|
| 6a | 2497 (`lock.test.ts`), 2678 (`main.ts`) | `{ acquireDaemonLock, DaemonLockedError, DaemonLockError }` | `{ acquireDaemonLock, DaemonLockError, DaemonLockedError }` |
| 8 | 3310–3318 (`spec.test.ts`) | `… internalNetworkSpec, ISOLATED_GATEWAY_OPTION` | `ISOLATED_GATEWAY_OPTION` before `internalNetworkSpec` |
| 9 | 4743 (`doctor.ts`) | `{ internalNetworkSpec, ISOLATED_GATEWAY_OPTION }` | `{ ISOLATED_GATEWAY_OPTION, internalNetworkSpec }` |
| 10 | 5264–5269 (`status-stream.test.ts`) | `vitest` before `@hono/node-server` and `hono` | `@hono/node-server`, `hono`, `vitest`, `ws` |
| 10 | 5497–5505 (`main.ts` snippet) | `./cells/status-stream.ts` listed first | alphabetical by path |
| 14 | 7794 (`pump.test.ts`), 8029 (`render-worker.ts`) | `{ type Presenter, pumpFrames, type PumpStats }` | `{ type Presenter, type PumpStats, pumpFrames }` |

**Fix:** make the per-task command `pnpm exec biome check --write . && pnpm lint` (or add a `fix`
script), or correct the lines above.

### F6 (Critical): `noAssignInExpressions` fails Task 8's lint six times

**Plan:** `fake-docker.ts` matches routes with `(m = /…/.exec(path))` inside the conditions at 3635,
3646, 3657, 3670, 3682 and 3701. Task 8 commits with `pnpm lint` (4634).

**Evidence:** `biome explain noAssignInExpressions` → "Default severity: error … This rule is
recommended". `biome check` on the file reports 6 × `lint/suspicious/noAssignInExpressions`, and no
fix is available.

**Fix:** compute `const m = RE.exec(path)` before each branch, or use a small `route(method, re)`
helper.

### F7 (Critical): `useExhaustiveDependencies` fails Task 14's lint

**Plan:** `DesktopFrame.tsx` has `useEffect(() => { tapped.current = null; … }, [src, onSource]);`
(8158–8173), and the effect body never reads `src`. Task 14 commits with `pnpm lint` (8303).

**Evidence:** Biome enables its React domain from `apps/web/package.json`; I reproduced this in a
monorepo layout. `biome lint`: "× This hook specifies more dependencies than necessary: src."
(`lint/correctness/useExhaustiveDependencies`, default severity error).

**Fix:** drop `src` from the deps. A new `src` loads a new document whose new track id re-arms the
tap, so behaviour doesn't change. Alternatively, read `src` in the effect.

### F8 (Critical): Task 5's chmod line drops `localdot-plank`, so Plank never starts

**Plan:**
- Task 3b: "Also add `/usr/local/bin/localdot-plank` to the `RUN chmod 755 …` line of the `base`
  stage" (1265–1266). The file is created with no `chmod +x` (1370–1380), and autostart runs
  `Exec=/usr/local/bin/localdot-plank` (1365).
- Task 5: "extend the … line … to `RUN chmod 755 /defaults/startwm.sh /etc/s6-overlay/s6-rc.d/svc-session-bus/run /etc/s6-overlay/s6-rc.d/svc-desktopd/run`"
  (2151–2152).

**Why it fails:** written as given, the script stays 0644 (`COPY` keeps the source mode), XFCE
autostart can't exec it, and Plank never runs. Task 3b's
`expect(dockerExecAs(C2, "abc", "pgrep", "-x", "plank").status).toBe(0)` (1403) then fails inside
Task 5's "16 tests pass" run (2202), and the dock is missing from every later screenshot.

**Fix:** Task 5's line must keep `/usr/local/bin/localdot-plank`, or Task 3b should
`git update-index --chmod=+x` the script.

### F9 (Important): `pnpm test:docker -- <file>` runs every Docker suite, not the named file

**Evidence:**
- pnpm 10.29.3 forwards the `--`. A scratch script run as `pnpm run show -- a/b.ts` executed
  `node -e … -- a/b.ts`.
- Vitest 5.0.3's cac moves everything after `--` into `options["--"]` (`chunks/cac.DfDGTQ9W.js`
  559–574). `run`/`start` use only the positional `cliFilters` (2343–2370).
- So every Docker step from Task 2 on runs all accumulated `*.docker.test.ts`. The expected counts
  are then wrong: Task 2's "5" (762) becomes 11, Task 3's "13" (1163) becomes 19, Task 3b's "15"
  (1422) becomes 21, Task 5's "16" (2202) becomes 22, Task 6's "1" (2450) becomes 23 with two desktop
  starts, Task 8's "2 … 2–4 minutes" (4628) becomes 25, and Task 9 (4886) becomes 26.
- Each run also rebuilds the gate and starts desktops and real cells, and an unrelated flaky suite
  fails the step.

**Fix:** drop the `--`: `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/x.docker.test.ts`.

### F10 (Important): the Docker test naming and cleanup constraint is violated

**Constraint:** "Tests that need Docker live in `*.docker.test.ts` files … They name every container,
network and volume they create `localdot-test-*` and remove them in `afterAll`" (98–101).

**Violations:**
- **Orchestrator Docker test (4537–4624):** creates `localdot-cell-<id>`, `localdot-egress-<id>`,
  `localdot-home-<id>`, `localdot-gate-<id>` and `localdot-desktop-<id>` (`cellNames`, 3452–3460).
  Its Step 7 check, "`docker ps -a --filter label=localdot.cell` … empty afterwards" (4628–4629), also
  matches any real cell.
- **Doctor:** the probe network `localdot-doctor-probe-<hex>` (4764, 4799) is built with
  `internalNetworkSpec`, so it carries `Labels: {"localdot.cell": "1"}` (3450, 3469).
- **Playwright e2e:** needs Docker outside `*.docker.test.ts` and picks the first
  `label=localdot.role=desktop` container (8496, 8550), which can be the user's real cell.
- **Tasks 2/3:** `docker run` the webtop image, which declares `VOLUME /config` (upstream
  Dockerfile). `removeAll` runs `docker rm -f` without `-v` (343), so every desktop test run leaks an
  anonymous home volume, and F9 multiplies the runs.

**Fix:** add a `namePrefix` orchestrator dep (default `localdot-`; tests `localdot-test-`) and filter
on it. Give the doctor probe network no cell label. Use `docker rm -fv` in `removeAll`.

### F11 (Important): the Cua Driver download isn't hash-verified

**Constraint:** "Every downloaded binary is verified against a sha256 written in the Dockerfile"
(91–92).

**Plan:** `/opt/cua/bin/pip install --no-cache-dir "cua-driver==${CUA_DRIVER_VERSION}"` (638–639).
There's no `--hash` or `--require-hashes`, the wheel bundles the native `cua-driver` binary, and its
dependencies resolve unpinned. Node (612–614) and VSCodium (629–631) are verified; this isn't.

**Fix:** add a requirements file with `cua-driver==0.30.4 --hash=sha256:<per-arch wheel>` plus pinned
dependencies, and install with `pip install --require-hashes -r …`.

### F12 (Important): screenshots land in `apps/web/apps/web/e2e/out` and get committed

**Plan:** `pnpm --filter @localdot/web shot … apps/web/e2e/out/no-token.png` (6906–6907), also
`theatre-empty.png` (7695) and `theatre-live.png` (8294).

**Why:** pnpm runs package scripts in the package directory, so the relative path resolves to
`apps/web/apps/web/e2e/out/…` (Playwright creates it). The `.gitignore` entry `apps/web/e2e/out/`
(243) has a slash in the middle, so it is anchored at the repo root and doesn't cover the nested
path. `git add apps/web` (6917, 7712, 8304) then commits the PNGs, and the "look at the PNG" checks
look in the wrong place.

**Fix:** pass `e2e/out/<name>.png`, or resolve the argument against `process.env.INIT_CWD` in
`shot.ts`.

### F13 (Minor): orchestrator state races and an incomplete `dispose()`

**Plan:**
- `#watch` reads `live`, awaits `#exitedContainer`, then writes
  `this.#set(record.id, { ...live, state: "starting", … })` without re-reading state (4429–4440). A
  stop or remove that lands during the awaits is overwritten, and the cell can be restarted.
- `#waitReady` awaits both probes, then sets `ready` and starts `#watch` (4397–4404) without
  re-checking. A `remove()` during the probes re-adds a `#live` entry and leaves a watch loop polling
  a removed cell.
- `dispose()` only stops `#watch` (4231–4234); `#waitReady` ignores `#disposed`.

The plan's Part 3 obligations note only the double-`#watch` case (8736–8737).

**Fix:** after every await, bail unless `this.#live.get(id)` is still the same object in the expected
state. Check `#disposed` in `#waitReady`.

### F14 (Minor): Task 10's `main.ts` block drops the port-in-use handler

**Plan:** "replace the token/app/server block (keep the lock, port and home code)" (5495), and the new
block ends at `attachUpgradeRouter(...)` (5527).

**Repo:** HEAD `main.ts` 30–32 has
`server.on("error", … fail(err.code === "EADDRINUSE" ? \`port ${port} is already in use\` : err.message))`.
Dropped, a busy port becomes an uncaught `error` with a stack trace.

**Fix:** keep the handler in the replacement block.

### F15 (Minor): a doctor unit test needs port 4750 to be free

**Plan:** "passes on a healthy engine…" calls `runDoctor({ …, port: 4750 })` and asserts
`expect(report.ok).toBe(true)` (4677–4680). Any listener on 127.0.0.1:4750 fails it, and the plan
itself expects a daemon may be running there (4888).

**Fix:** use a free port (a `listen(0)` probe) in the unit tests.

### F16 (Minor): the traversal assertions never reach the traversal guard

**Plan:** `d.fetch(\`${d.prefix}/%2e%2e/%2e%2e/daemon-token\`)` and `/../../` (5864–5865), and
`app.request(url("/assets/../daemon-token"))` and `%2e%2e` (6824–6825).

**Evidence:** the WHATWG URL parser collapses these on the client:
`/cells/A/desktop/T/%2e%2e/%2e%2e/daemon-token -> /cells/A/daemon-token` and
`/assets/%2e%2e/daemon-token -> /daemon-token` (node). The 404s come from "no route", so the tests
would pass with no guard at all. The real guard is only covered by `static-files.test.ts`.

**Fix:** use `%2f`-encoded separators (`..%2f..%2fdaemon-token`), or send a raw `http.request` path.

### F17 (Minor): two Review Focus claims point at tests that don't exist

- **Review Focus 4** (125–127): "Test: Task 14 (`frameTapSupport()` in jsdom reports `{ ok: false }`
  …; `Stage` renders the notice)". Task 14's tests (7917–7955) never render `Stage`.
- **Review Focus 3** (122–124): cites "Task 14 (UI state)". The "Reconnecting…" mapping is tested in
  Task 13 (7003–7008); Task 14 has no such test.

**Fix:** add a jsdom `Stage` render test that asserts the alert text, and correct the Review Focus 3
reference.

### F18 (Minor): Task 14's expected test count is 4; the stage folder has 5

"Run: `pnpm exec vitest run apps/web/src/stage` Expected: 4 tests pass" (8001–8002). `pump.test.ts`
has 2 tests and `frame-source.test.ts` has 3.

### F19 (Minor): Task 5 changes `startDesktop`'s return value but not its declared type

Task 5 says the function "returns `{ port: …, desktopd: … }`" (2181–2183), but the declaration stays
`function startDesktop(name: string, scale: 1 | 2): { port: number }` (1051). tsc reports TS2353 and
TS2339 (verified), so Task 5's `pnpm typecheck` fails unless the annotation is also widened.

**Fix:** state the new signature `): { port: number; desktopd: number }`.

### F20 (Minor): App tests are never unmounted

Vitest runs without `globals`, so RTL's auto-cleanup, which needs a global `afterEach`, never runs.
Task 13's note "the reconnect timer is cleared on unmount" (7685–7687) is therefore false: the Theatre
from the Start test stays mounted and keeps reconnecting jsdom WebSockets to `ws://localhost:3000`
during later tests and after the file. Rendered trees also accumulate across tests (6762–6786,
7664–7684); the current queries are unique, so it is latent today.

**Fix:** add `afterEach(cleanup)` in `App.test.tsx`.

### F21 (Minor): the branch step contradicts the repo

**Plan:** "Work on branch `feat/core-part2`, created from `feat/core-part1` (`git switch -c feat/core-part2 feat/core-part1`)"
(48–49, 194–196).

**Repo:** `git branch -a` shows no `feat/core-part1` (merged into `main` 992e82d and deleted), and
`feat/core-part2` is already checked out at `b778394`. The controller note in `global-constraints.md`
covers this; the plan and the Task 1 brief still contain the command.

### F22 (Minor): Task 6a's manual SIGHUP check is unreliable

**Plan:** `cd … && LOCALDOT_HOME="$(mktemp -d)/h" node --import tsx src/main.ts &` then
`kill -HUP $!; wait $!` (2703–2707).

**Problems:**
- `$!` is the subshell running the `&&` list. Under bash it isn't node, so the signal can miss the
  daemon.
- The daemon binds 4750, so it exits 1 rather than 129 if anything holds the port.
- The temp home isn't captured, so "no daemon.lock left" can't be checked.

**Fix:** `h=$(mktemp -d)/h; (cd …; exec env LOCALDOT_PORT=4795 LOCALDOT_HOME="$h" node --import tsx src/main.ts) &`,
then check `ls "$h"`.

### F23 (Minor): the e2e "Starting…" assertion uses Playwright's default 5 s

`await expect(page.getByTestId("hud-status")).toHaveText("Starting…");` (8467) has no timeout, but
`create()` awaits two network creates, a volume create, two container creates and the starts before
the POST returns (4264–4314). It is flaky on a slow Docker Desktop.

**Fix:** give it `{ timeout: 30_000 }`.

### F24 (Minor): two concurrent creates can get the same keyd port

`keydPort: allocateKeydPort(this.#store.list().map((r) => r.keydPort))` (4292) runs after several
awaits, and the record is saved only at 4310. Two concurrent `POST /api/cells` can both get 4760.
That's latent for M3: "keyd identifies cells by listener port" (carry-forward line 7).

**Fix:** reserve the port in memory before the first await.

### F25 (Minor): a hung Docker socket blocks daemon startup

`DockerClient.request` has no timeout (2376–2413), and `main.ts` awaits
`orchestrator.reconcile()` before `serve()` (5519–5522). A wedged Docker Desktop socket therefore
blocks startup, contradicting the plan's own comment "The daemon serves the UI without Docker"
(5518).

**Fix:** a per-request `AbortSignal` timeout, or serve first and reconcile in the background.

### F26 (Minor): Files blocks, File map and Interfaces drift

- **Files blocks:**
  - Task 3b edits `.gitignore` (1419, 1434) but its Files block omits it (1192–1197).
  - Task 11 creates the `static-ui.ts` stub (6107–6117), not listed (5560–5565).
  - Task 14 may commit `scripts/check-hygiene.mjs` (7772–7774, 8304), not listed (7726–7732).
  - Task 15 edits `apps/daemon/src/main.ts` and `spec.test.ts` (8341–8343), not listed (8311–8315).
- **File map (132–166)** omits:
  - `spikes/s8-hosted-client/package.json`
  - `apps/web/src/cells/types.ts`
  - `apps/web/src/shell/Mascot.tsx`
  - `apps/web/e2e/daemon.ts`
  - `apps/daemon/package.json`
  - `.github/workflows/ci.yml`
  - `scripts/check-hygiene.mjs`
- **Interfaces:**
  - Task 1 lists `waitFor(pred, ms)`, but the code is `waitFor(label, pred, ms, everyMs)` (352), and
    `dockerExecAs` (321) is missing (188–190).
  - Task 11 gives `readStatic(...): { body: Buffer; … }` (5568); see F4.

### F27 (Minor): `theme.css` isn't directly consumable by Tailwind 4

**Constraint:** P2-R4 says tokens are named "in Tailwind 4's `@theme` namespaces (… `--ease-*`,
`--duration-*`) so Tailwind can consume the file unchanged" (88–90; Interfaces 6157–6158).

**Plan:** the file declares them in `:root { … }` (6581–6611). Tailwind 4 only generates utilities
from variables inside `@theme`, and `--duration-*` isn't a Tailwind 4 theme namespace (durations use
`--default-transition-duration` or arbitrary values).

**Fix:** note that M4 moves the block into `@theme`, and drop `--duration-*` from the namespace claim.

### F28 (Minor): two spec lines no longer match the plan

- **Display:** spec 217 says "`Gdk/WindowScalingFactor` 2 with `Xft/DPI` 96 and the `Default-xhdpi`
  xfwm4 theme". Task 3b uses `WhiteSur-Light-xhdpi`/`WhiteSur-Light` (1300–1304).
- **Error handling:** spec 661 says "A cell crashes | The orchestrator restarts it with backoff; the
  UI shows 'Reconnecting…'". The orchestrator marks the cell `starting` with "…; restarting (attempt n
  of 5)" (4439–4440), and `hudFor` shows that as "Starting…" (7032–7033). "Reconnecting…" only shows
  in the ≤5 s before the watch notices.

**Fix:** update the two spec lines (as P2-R13 already plans for the license line), or map a restart
note to "Reconnecting…".

### F29 (Minor): two Ruling 36 trivia items are neither done nor carried

Carry-forward line 109: "SUMMARY D18's quote drops a ')'; `DEFAULT_PORT` in `port.ts` needn't be
exported". At HEAD the D18 quote still lacks the ")" (SUMMARY.md line 41) and `export const DEFAULT_PORT`
is still in `port.ts:1`. The plan says the remaining carries are listed as Part 3 obligations
(8788–8789); these two aren't.

### F30 (Minor): smaller items

- **cwd-relative paths:** Task 3b's Docker test writes with cwd-relative paths (`mkdirSync("apps/daemon/src/cells/testing/out")`,
  `docker cp … apps/daemon/…`, 1409, 1416, 1418), against "Build paths from
  `fileURLToPath(import.meta.url)`" (57).
- **Unused import:** `apps/web/e2e/daemon.ts` imports `dirname` but never uses it (8370; Biome
  warning).
- **No removal check:** `extract-selkies-client.sh` doesn't verify that its `sed` removed the
  manifest link (1491). A different attribute order passes silently.
- **NOTICE.md commit:** it says the source is "at the commit the linuxserver build … packaged"
  (7767–7769) without naming it; the base Dockerfile pins `SELKIES_RELEASE`. Naming the commit keeps
  the MPL-2.0 source pointer exact (P2-R13).
- **Redundant ignores:** the `.gitignore` lines `cells/desktop/desktopd/dist/` and `apps/web/dist/`
  (241–242) are already covered by HEAD's `dist/`.
- **Biome warnings:** non-blocking `noNonNullAssertion` (4594), `useOptionalChain` (`orchestrator.ts`
  ×2, `DesktopFrame.tsx`), and `noDescendingSpecificity` (the `app.css` append, 8269–8272).
