# Task 11 report: desktop stream proxy with tickets and a stall watchdog

**Status: DONE_WITH_CONCERNS.** The concerns are additions beyond the brief that need a ruling (D1–D3 below). Nothing is blocked.

- **Branch:** `feat/core-part2`, BASE `4384f20`.
- **Commit:** `5253bd7 feat(daemon): desktop stream proxy with tickets and a stall watchdog`. Conventional, with no attribution line.
- **Files:**
  - created: `static-files.ts`, `static-ui.ts` (the `webDir` stub), `cells/watchdog.ts`, `cells/stream-proxy.ts`, and tests for the first three;
  - changed: `app.ts` (the `desktop?` option, routes registered after the Host/Origin guard and before the `/api/*` token middleware), `main.ts` (wiring), and `cells/readiness.ts` (`readCapped` exported for reuse).

## Verification

| Check | Result |
|---|---|
| Steps 1–2 (static 2, watchdog 1) | RED (module missing), then GREEN |
| Step 3/4 proxy suite | RED (module missing, as the brief expects), then 15/15 GREEN |
| The brief's verbatim Step 4 code against my suite | **9 of 14 fail**, each on its ruling (see the table). The other 5 pass on the brief's code and are pinned by mutation |
| Touched suites: proxy, static, watchdog, app, api, readiness, upgrade-router | 79/79, ×5 on the final code; the new suites ran ×10 earlier |
| `pnpm test` | 35 files / 361 tests (was 32 / 343: +2 static, +1 watchdog, +15 proxy) |
| `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm hygiene` | clean (exit 0) |
| Mutation round on the final code | **23 / 23 caught** (scratch runner; each file restored after its run) |
| Real cell (scratch smoke, `localdot-test-` names, port 4793) | 12/12 checks pass, see below |
| Real Selkies client in Chrome through the proxy | streams at 2560×1600; recovers after a Selkies restart |
| Real daemon (`node --import tsx src/main.ts`, scratch `LOCALDOT_HOME`, port 4794) | `/healthz` ok; desktop page with a bad ticket 403, POST 405, WS upgrade 403; `/api/cells` without a token 401; SIGTERM gives 143 and releases the lock |
| Docker hygiene | dangling volumes 25 (baseline 25); no `localdot-test-*` container, network or volume; no localdot container or network |

## Rulings and the tests that pin them

"RED" means the test fails on the brief's verbatim code. "Mutation" means the named change to the final code makes the test fail.

| # | Ruling | Pinned by (in `stream-proxy.test.ts` unless noted) | Evidence |
|---|---|---|---|
| 1 | Dial the upstream first and complete the viewer's upgrade from its `open`; 502 on `error`/`unexpected-response` | "dials the cell first, so a message sent the moment the viewer's socket opens arrives": `SETTINGS,{}` is sent inside the viewer's `open` handler and echoed, and the cell already holds the socket at that moment. "answers 502 when the cell refuses the upgrade, can't be reached or never answers…" | Mutation "accept the viewer before the cell opens" fails 8 tests; "no 502 when the cell refuses" is caught. Real cell: a wrong credential gives `Unexpected server response: 502` |
| 2 | `cellFor`: a ticket resolves only on its own cell's path, and only while `cells.get(id)?.state === "ready"` | HTTP: "refuses wrong tickets, another cell's ticket, a cell that is not ready and traversal". WS: "refuses a bad ticket, another cell's ticket and a cell that is not ready before dialing". **Cell A's ticket on cell B's path gets 403** over both HTTP and WebSocket; B is ready and its own ticket works. A state change with no event keeps the ticket live (`resolve` still returns the id) and still gets 403. Neither upstream sees a request | RED (ready check; the WS test hangs on the brief's code). Mutations "any live ticket opens any cell" and "no ready check" are each caught by both tests |
| 3 | Proxy only GET `api/status` and `api/websockets`; everything else under the prefix that isn't a vendored file gets 404 | "proxies only GET api/status and api/websockets and answers 404 to the rest without dialing the cell": 12 paths get 404 (`api/screenshot`, `api/health`, `api/sessions`, `api/recording`, `api/files/x`, `api/print/x`, `api/turn`, `api/`, `api/status/`, `api/websockets/x`, `nope.js`, `assets/`); HEAD `api/status` gets 404; POST/PUT/DELETE get 405; the cell sees nothing until the plain GET of `api/websockets` | RED; mutations "proxy every api path" and "proxy HEAD too". Real cell: `api/health`, `api/screenshot` and `api/sessions` get 404 |
| 4 | Pin the Content-Type: `application/json` for `api/status`, a fixed type for the plain `api/websockets` GET, plus `nosniff` | "pins the media type of every cell answer…": the cell answers `text/html` with a `<script>` and the daemon serves `application/json` / `text/plain; charset=utf-8` with nosniff and no-store. The static files get nosniff too ("serves the vendored client…") | RED; mutations "pass the cell's type through" and "no nosniff". Real cell: `api/status` comes back `application/json`; the plain GET comes back 400 `text/plain` (aiohttp's "No WebSocket UPGRADE hdr"); the real client's JS and CSS load under nosniff |
| 5 | Upstream 401 becomes 502 | Same test: a wrong credential gives 502 with no `WWW-Authenticate` | RED; mutation "pass a 401 through". Real cell: 502 |
| 6 | Only the proxy's own basic-auth goes to the cell; never the client's Authorization, cookie or `?token=` | "forwards only its own credential: no client Authorization, cookie or query". Over both HTTP and WS, a `Bearer <token>`, a `cookie` and `?token=<token>&x=1` from the viewer: the cell sees only the basic auth, no cookie, and bare `/api/status` and `/api/websockets` | RED (the query was forwarded); four mutations caught (query or cookie over HTTP; query or Authorization on the dial) |
| 7 | Nothing logs request paths, tickets or tokens | "writes nothing to the console, so no path, ticket or token reaches a log": all six console methods are spied across 200, 404, 403, 502 (unreachable and 401), WS relay and close, WS 403 and WS 502 | Mutation "log the request path" is caught. The module has no log line at all |
| 8 | `STREAM_PING_MS = 500`, `STREAM_STALL_MS = 1500`; messages, pings and pongs all count | Defaults in `relay()`. "relays the WebSocket both ways, pings upstream, and reports stalled and live" (pongs); "counts the cell's own pings and messages as signs of life, not only pongs" (pongs off, then server pings, then messages: never stalled; silence: stalled); `watchdog.test.ts` | Mutations removing each of the three touches are caught. Real cell: an idle socket stays live for 6 s with no stall (A30); `docker pause` reads as stalled 1384 ms after the pause returned; unpause reads as live at once, on the same socket |
| 9 | Traversal tests reach the guard with `%2f` aimed at a real outside file; `StaticFile.body: Uint8Array<ArrayBuffer>` | `…/..%2fld-proxy-outside.txt` and `…/assets/..%2f..%2fld-proxy-outside.txt` get 404 (the file exists in `tmpdir()`); `static-files.test.ts` | Mutation "no traversal guard" fails both the unit test and the proxy test, so the requests do reach `readStatic`. `tsc` is clean with the F4 type |
| 10 | Docker tests | The brief lists none and I committed none. The real-cell smoke was a scratch script: `localdot-test-` prefix through the orchestrator's `namePrefix`; cleanup by `remove(purgeHome)` plus `docker rm -fv`, network rm and volume rm; async `execFile` for pause/unpause (no blocked thread); exit 0 | Hygiene: dangling volumes back to 25, no leftovers |
| 11 | Conventional commit, no attribution, repo only | `5253bd7` | Scratch work under the session scratchpad's `task11/` |

The brief's own tests: Step 1's 2 and Step 2's 1 are verbatim. Step 3's 5 are kept and adapted to the rulings:
- `api/health` becomes `api/status`;
- `seenAuth` becomes `seen` (url, authorization, cookie);
- "other cells' tickets" now uses a real ready cell B;
- the traversal follows ruling 9.

## Additions and deviations to rule on

- **D1 (interface).** `StreamProxyDeps` gains `upstreamTimeoutMs?` (default 10 s, module-private `UPSTREAM_TIMEOUT_MS`).
  - It is the WS dial's `handshakeTimeout`, and the `AbortSignal` for `api/*`.
  - The brief's relay had no handshake timeout, so a cell that accepts TCP and never answers would hold the viewer's upgrade forever.
  - Tested with a silent TCP cell at 300 ms, over both HTTP and WS. On the brief's code both tests hang.
- **D2 (multi-viewer).** The API hands every viewer of a cell the same ticket, so one cell can have several relays. `CellStreams` reports the healthiest relay's state (live > stalled > connecting), counts every relay including those still connecting, and writes `none`/`disconnected` only when the last relay goes.
  - With the brief's per-relay reports, a second viewer joining flipped a live cell to `connecting`.
  - One of two viewers leaving reported `none` with `viewers: 1`. `hudFor` would show "Connecting…" over a live picture.
  - Test: "keeps the cell live while any viewer's relay is…". RED on the brief's code.
  - Real cell: a refused second dial left the first viewer's `live` untouched (`live, viewers 2` then `live, viewers 1`).
- **D3 (close accounting).** A relay leaves the count when either side closes first, through a once-only `finish`.
  - With the brief's code, a viewer's close waits for the cell's close handshake (ws allows 30 s). Against a wedged cell (paused container), that read as `stalled` with a phantom viewer.
  - Test: "leaves the count as soon as the viewer goes, even when a wedged cell never finishes the close". Mutation caught.
- **D4.** The query is dropped entirely (HTTP and WS), not only `token`. Neither allowed endpoint takes a query, and the real client sends none. S8's suggested `api/status?x=1` passthrough is now asserted dropped.
- **D5.** Proxied answers are read whole, capped at 64 KiB through `readCapped` (now exported from `readiness.ts`, not duplicated), instead of streamed.
  - A hostile cell can't stream an unbounded body through the daemon.
  - A failing body stays in our `try` as a 502, instead of `@hono/node-server`'s `console.error` path.
  - An unusual status (204 with a body) also lands in that `catch` as a 502.
  - Test: an answer over 64 KiB gets 502.
- **D6.** `app.get(...)` replaces `app.on(["GET","HEAD"], ...)`. Hono 4.13 dispatches HEAD as GET (`hono-base.js:261`), so a HEAD registration never matches. The client's HEAD probe of its page is tested and gets 200 with no body.
- **D7.** A malformed escape gets 404, not the brief's 400 (ruling 3: everything that isn't a vendored file is 404). HEAD on `api/*` gets 404 (GET only). Other methods keep the brief's 405.
- **D8.** `rel` is taken from the raw pathname by a regex instead of being sliced by the length of the decoded id and ticket. Hono decodes params, so a percent-encoded ticket character would have shifted the slice.
- **D9.** The upstream socket is created before the viewer is counted, so a constructor that throws (caught by the router as a 500) can't leave a phantom viewer.
- **D10.** The constants' comment now states S8's finding: aiohttp's heartbeat resets on every received frame, and Selkies answers the pings itself (`autoping=False`). S8 measured 505 ms at most between signs of life.

## Known limits (not done, by design)

- **Backpressure stays the Part 3 obligation (P2-R15).** ws's default `maxPayload` (100 MiB) on the upstream belongs to the same item.
- *(Resolved in `b6880a1`, see "Fix round 1".)* **Open relays outlive a cell leaving `ready`.** In practice the cell's containers stopping or restarting drops them, and every new request or upgrade is refused (revoked ticket, plus the ready check). If wanted, `desktopStreamRoute` could subscribe and close a cell's relays when it leaves `ready`.
- *(Resolved in `b6880a1`: relays are unregistered on leaving `ready`, so a late close reports nothing.)* **A relay that closes after its cell left `ready` still writes its final state.** Example: `disconnected` on a stopping cell. `hudFor` reads the stream only for a ready cell, and the orchestrator resets the stream on the next start.
- **`probeStream` (readiness) still dials `api/health` directly.** It never goes through the proxy, so the allow-list doesn't affect it.

## Real-cell evidence (scratch `smoke.mts`, not committed)

Cell `01M3WK0758K1PFM0DR2B4N8WK6`, `localdot/desktop:dev` and `localdot/gate:dev`, scale 2, ready in 2.6 s.

- **HTTP**
  - Index 200, `text/html`, nosniff.
  - `api/status` 200 `application/json`: `{"current_mode": "websockets", …}`.
  - Plain GET of `api/websockets`: 400 `text/plain`.
  - Three other `api/*` paths: 404.
- **Relay**
  - States went `connecting`, then `live`.
  - On `_gz,1`, `SETTINGS,{}`, `cr`: 52 messages (375 KB: MODE, server_settings, stream_resolution 2560×1600, H.264 frames).
  - The stream stayed live while idle; pause and unpause behaved as described in the table.
  - A wrong credential gave 502 over both HTTP and WS.
  - Closing the viewer gave `none` with viewers 0.
- **Chrome (DevTools MCP, the real vendored client from `spikes/s8-hosted-client/client`)**
  - Loading and streaming:
    - page, JS, CSS and `icon.png`: 200;
    - `api/status`: 200, so the client logged "Received initial streaming mode: websockets";
    - `[websockets] Connection opened!` → "Sent initial settings" → "Stream started";
    - `#videoStream` at 2560×1600, `readyState` 4, playing; the screenshot shows the WhiteSur desktop.
    - The only console error is the expected `manifest.json` 404.
  - Recovery: `s6-svc -r svc-selkies` mid-stream gave `disconnected` (the viewer was closed with 1012). The client then sent HEAD on its page (200), reloaded, fetched `api/status` (200), and was back to `connecting` and `live` 5.2 s later, with video at 2560×1600 again.
  - One tooling note: the first Chrome tab closed by itself before my first restart. Selkies logged the client disconnecting and its 3 s grace period running out before the shutdown signal, and the relay recorded a viewer-first close (`none`). The rerun in a fresh tab gave the result above.

## For Task 14

- The real client works through this proxy unchanged: the allow-list, pinned types, nosniff and the dropped query broke nothing.
- After a cell restart, the client's own reload loop works through the proxy while the ticket stays live. A daemon restart (tickets die) still needs S8's re-mint; that is Task 14's carry.

## Fix round 1: close open relays when the cell leaves `ready` (`b6880a1`)

**Controller rulings applied.** D1, D2, D3, dropping the whole query and the 64 KiB cap were accepted, so nothing changed for them. The one new requirement: a revoked ticket must not keep a live stream.

**Commit:** `b6880a1 fix(daemon): close a cell's stream relays when it leaves ready`. Conventional, with no attribution line. Files: `cells/stream-proxy.ts` (+40/−8) and its test (+73).

### What changed

- **The subscription.** `desktopStreamRoute` subscribes to the cell API. On any state other than `ready` (stopping, stopped, failed, removed, or starting for a restart) it calls `CellStreams.drop(id)`.
- **What `drop` does.** It unregisters all of the cell's relays first, then stops each one, then reports the cell's stream once: `connection: "none"`, `viewers: 0`, and the last sign of life. Because the relays are already unregistered, their own closes find nothing to report. `close()` now ignores a viewer that is no longer registered.
- **How each relay stops, on both sides at once.** `finish` stops the watchdog. Then the viewer is handled, and `upstream.terminate()` cuts the cell's side immediately:
  - a connected viewer gets `close(1012, "cell left ready")`;
  - a viewer still waiting on its dial gets `503 Service Unavailable`, the same status as a cell without endpoints.
- **Old tickets.** A new connection with the old ticket gets 403: the cell API revoked it on the same event, and `cellFor`'s ready check refuses it anyway.

### Evidence

- **RED on `5253bd7`.** I put the committed `stream-proxy.ts` back and ran the new suite: the three new tests failed and the 15 old ones passed. Output is in `red-fix-on-5253bd7.txt` in the scratchpad.

  | Test | Failure on `5253bd7` |
  |---|---|
  | "closes every relay with 1012 when the cell leaves ready, and the old ticket opens nothing" | "the viewers' close: nothing after 1000 ms" |
  | "cuts the cell's side at once when the cell leaves ready, even if a viewer never answers the close" | timed out waiting for the cell's side to close |
  | "refuses a viewer still waiting on its cell with 503 when the cell leaves ready" | "the refusal: nothing after 1000 ms" |

- **What the new tests check.**
  - The first test uses two connected viewers and the `stopping` event emitted the way the orchestrator emits it (the cell API revokes the ticket on it). It checks:
    - both viewers get 1012;
    - exactly one stream update follows, `none` with 0 viewers;
    - the cell's sockets close;
    - the old ticket gets 403 over both WS and HTTP.
  - The second test uses a raw viewer that completes the upgrade and then stops reading, so it never answers the close frame. The cell's side must close within 1 s anyway. Without the explicit terminate, it would wait for ws's 30 s close timer.
  - The third test sends `starting` (a restart) while the viewer's dial is still pending against a silent cell, and expects 503.
- **Mutations: 29 of 29 caught.** That is the 23 from before, plus 6 for the drop:
  - no subscription;
  - relays stopped before they are unregistered (caught by the "reported once" assertion);
  - 1000 instead of 1012;
  - a waiting viewer not refused;
  - the cell's side left to the viewer's close (caught by the deaf-viewer test);
  - `drop` reporting nothing.
- **Real cell** (scratch `smoke-drop.mts`, `localdot-test-` names, 5/5 pass):
  - `orchestrator.stop()` closed the live viewer with 1012 within 1 ms, while the cell was `stopping` and 4.3 s before the containers had stopped;
  - the stream went to `none` with 0 viewers;
  - the old ticket got 403;
  - after `start()` and ready, the next minted ticket was new and streamed `live`.
- **Verification.**
  - `pnpm format` / `pnpm lint` clean; `pnpm typecheck` and `pnpm hygiene` exit 0.
  - The touched suites (proxy 18, watchdog, static, app, api, upgrade-router, status-stream) pass 75/75 five times.
  - `pnpm test`: 35 files / 364 tests (+3).
- **Docker hygiene.** Dangling volumes 25 (the baseline); no `localdot-test-*` container, network or volume; port 4793 free.

### Note for Task 14

When a cell leaves `ready`, its client now gets 1012. The client reloads, its HEAD probe and page load get 403 on the revoked ticket, and it stays there until Task 14 re-mints a ticket. That matches the S8 re-mint carry (mint on daemon-socket reconnect, and after 10 s without a reachable `#videoStream`).
