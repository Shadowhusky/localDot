# S8 findings: Selkies' client hosted in our own page

2026-10-01 · macOS 26.6.2, Apple M3 Ultra · Docker Desktop engine 29.2.0 (VM 10 CPUs, 14.6 GiB) · image
`localdot/desktop:dev` `sha256:c1522d532570…` (b7ee200: Selkies 2.0.0, xfwm4 4.20.0 with its compositor on,
Chromium 154.0.8037.57) · viewer: Google Chrome 154.0.8037.92 (the DevTools MCP's own instance and profile),
1312×880 CSS px at DPR 2 · `host.mjs` on Node 25.6.0, ws 8.22.0

**Result: GO-WITH-CHANGES.** The architecture holds:
- The vendored dashboard runs from our server under `/d/t1/`, in a 1×1 inert same-origin iframe.
- The parent clones its `<video>` track into a `MediaStreamTrackProcessor`, and a worker paints every frame.
- None of Step 2's fallbacks was needed.

Tasks 11 and 14 need the changes listed below. The main one: Task 14 must seed the stage from the `<video>`'s
current frame, or it stays black after every connect. Watchdog constants for Task 11: **`STREAM_PING_MS = 500`,
`STREAM_STALL_MS = 1500`**. **For Part 3:** the compositor adds 26–30 ms to input-to-frame latency with xfwm4's XPresent vsync
(the image's default), and about 4 ms with vsync off.

- **Extractor.** It produces `index.html` without the manifest link, `assets/` (`index-CPWh3fQ6.js`,
  `selkies-core-BbKps5RD.js`, `index-D97fjY6g.css`, 1.1 MB), `icon.png`, `icon-512.png` and `LICENSE` (MPL-2.0, 373
  lines).
  - It refuses to replace an empty path, `/`, `$HOME`, the repo root or anything outside the repo. It creates nothing
    before that check.
  - Tested on a copy with `rm` and `docker build` neutered. Missing parents (`apps/web/vendor/selkies`) are allowed:
    BuildKit creates them.
- **Step 2, as the brief has it.**
  - Console: `[Selkies] video sink: MediaStreamTrackGenerator on the page — this browser exposes no
    VideoTrackGenerator to a worker.` and one `tapped …`.
  - `presented` stayed 0 on a still screen until a window opened. Then it read
    `{"presented":61,"fps":43,"size":"2560x1600","format":"I444"}`, and the canvas showed the desktop, sharp at DPR 2.
- **Seeded (the change to the spike's `page.html` and `worker.js`).**
  - The client's first frames reach its `<video>` before the 250 ms poll taps (the tap logged `readyState 4`). A
    clone only sees later frames, and a still screen sends none.
  - The fix: after cloning, the page takes `new VideoFrame(video)`. This works across realms; the frame is I444
    2560x1600, so it is the decoded frame itself, not a re-render.
  - It transfers that frame with the readable, and the worker presents it before reading.
  - On a still screen, one `evaluate_script` right after connect read `{"presented":1,"seeded":1,"fps":0}`. The canvas
    showed the whole desktop, and the relay carried 0 msgs/s after the connect burst.
  - After a self-reload, on a new document and track: `{"presented":2,"seeded":2,"fps":0}`.
  - The keyframe fallback (`REQUEST_KEYFRAME` on the iframe's `selkiesTransport`) wasn't needed.

| Step 3, compositor on (as built) | Value |
|---|---|
| fps at rest | 0: a still screen sends nothing, except a clock repaint (6 messages) once a minute |
| fps during the scroll (`#stats`, per second) | 59–62 (run A1), 61–62 (run A2); expected 45–62 |
| fps while moving; frame gap p50 / p90 / p99 / max | 61.1; 16 / 19 / 25 / 38 ms (A1) · 61.2; 16 / 19 / 24 / 28 ms (A2) |
| container CPU while moving (`docker stats`) | 181–194 % (A1), 182–198 % (A2); at rest with Chromium open, 12–17 % |
| viewer Chrome CPU (renderer + GPU + browser) | 25–42 %: the two valid `top` samples differ about 2× in every run (23–28 vs 41–42); at rest, 1.7–3.3 % |
| relay while moving | upstream 60–70 msgs/s, 1.1–2.2 MB/s; client 20 msgs/s (its 50 ms acks) |
| idle cadence (still screen, 110 s) | upstream msgs/s 0.0, pongs/s 2.0, **pings/s 0.0**, client msgs/s 0.8–1.0 |
| longest silence, live upstream | 505 ms over connect, run A1 and the still screen. The host keeps one global maximum, so the runs after the pause have no figure of their own |
| `docker pause`, 6 s | `silence now 5120 ms`, `pongs/s 0.0`; after unpause `pongs/s 4.0` (queued pings answered); same socket, same track, no reload |

GPL-3 reaches its end about 11 s into the 20 s of presses. The fps, gap and CPU figures cover only the moving part: a
frame gap under 100 ms counts as moving, and CPU samples are those taken before the last moving frame.

## Compositor (for Part 3)

**Motion.** Each run is four CPU samples while moving.

| | on, XPresent: A1 / A2 | on, vsync off: C | off: B |
|---|---|---|---|
| fps while moving | 61.1 / 61.2 | 61.2 | 61.4 |
| frame gap p50 / p90 / p99 / max, ms | 16/19/25/38 · 16/19/24/28 | 16/19/23/38 | 16/19/23/29 |
| container CPU while moving, median (range) | 190 (181–194) · 196 (182–198) | 190 (184–193) | 182 (174–183) |

Cadence is identical. The compositor's CPU cost of about 10 points is soft: it rests on 4 samples per run, and the
relay's bitrate varied between runs of the same scroll (1.05–2.2 MB/s), which x264's cost follows.

**Latency.** The method is S6's:
- S6's flash page in a normal window (`unredirect_overlays` is on, so fullscreen would bypass the compositor);
- `latency-send.mjs` pressing `key space` every ~600 ms through a persistent `docker exec -i … xdotool -`;
- `recorder.js`, which takes the first frame after each send from its own clone, with `Date.now()` on both sides.

Each block had 60 presses, and every press got its frame. The raw values are in `latency-raw.json`.

| Send → frame, ms | p50 | p95 | max |
|---|---|---|---|
| on, XPresent vsync: flash L1, L3, L5, L8; terminal T1 | 46, 47, 49, 51; 47 | 57, 63, 64, 60; 60 | 58, 67, 68, 60; 62 |
| on, vsync off: flash L6, L7 | 25, 25 | 32, 31 | 33, 35 |
| off: flash L2, L4, L9; terminal T2 | 20, 21, 21; 19 | 29, 30, 30; 27 | 31, 31, 30; 30 |

**How each vsync state was confirmed.**
- xfwm4 reads `vblank_mode` only when it starts.
- The image's xfwm4 starts with `auto`. An instance started that way with `G_MESSAGES_DEBUG=all` logged
  `Unsupported GL renderer (llvmpipe …)` and then `Compositor using XPresent for vsync` (L8).
- L5 set `vblank_mode=off` through xfconf before a live compositor toggle. xfwm4 ignores that: the same toggle re-logged
  XPresent. So L5 is an XPresent block, and this file's earlier claim that "`vblank_mode=off` doesn't help" was wrong.
- `xfwm4 --replace --vblank=off`, or a start while the xfconf value is `off`, logged `No vsync support in compositor`
  (L6, L7).

**Reading.**
- Against no compositor, the compositor costs 26–30 ms at p50 with XPresent. Without vsync it costs about 4 ms at p50
  and 3–5 ms at the max, and leaves motion fps and CPU unchanged (run C).
- The off rows reproduce S6's 2× line (p50 17.5, p95 27.3) to within about 3 ms.
- As built, Part 3's gate (p50 ±3 ms against S6) fails. With `vblank_mode` off in the image's xfwm4 defaults, the p50
  is 1 ms over and the p99 rule passes.
- Tearing in captured frames without vsync was not checked.

## Changes for Tasks 11 and 14

- **Task 14: seed the stage.**
  - `FrameSource` gains `first?: VideoFrame`.
  - `tapVideoTrack(video)` takes the iframe's element (`VideoLike` gains `readyState`). It clones first, then sets
    `first = new VideoFrame(video)` when `readyState >= 2`, or `undefined` if that throws.
  - `DesktopFrame` passes the element, not `{ srcObject }`.
  - `StageCanvas.attach` posts `{ type: "frames", readable, first }` and transfers both.
  - `WorkerIn`'s `frames` gains `first?`, and `pumpFrames(…, { first })` presents and closes it before the first read,
    so `data-frames` is above 0 at once.
  - Tests: the pump presents and closes `first`; `tapVideoTrack` returns it only when `readyState >= 2` (stub
    `VideoFrame`).
- **Task 14: re-mint the ticket.**
  - The client's self-reload reuses the iframe's URL, ticket included. After a daemon restart (tickets die with it),
    the reload gets a 403, or Chrome's cross-origin error page while the daemon is down, and no client code runs again.
  - `Stage` mints only when `[api, cellId, ready, support.ok]` changes.
  - Fix: mint a new ticket and remount the iframe (new `key`) when the daemon socket reconnects, and also when the
    iframe has had no reachable `#videoStream` for 10 s.
- **Task 14: delete stale storage.**
  - The client keys `localStorage` by `(origin + pathname).replace(/[^a-zA-Z0-9._-]/g, "_")` + `_<name>`. S8 got
    `http___127.0.0.1_4792_d_t1__stream_mode` and `…__storage_key_migrated`.
  - Every ticket path leaves such keys in localDot's origin. Before setting a new `src`, delete the keys starting with
    `…_cells_<id>_desktop_`.
- **Task 14 Step 4 wording.** A pause reconnects nothing: the same socket resumes, and the watchdog returns to live on
  the pongs.
  - The client reloads itself only after a close: `s6-svc -r /run/service/svc-selkies` gave 1012, then
    `WebSocket disconnected, reloading page to reconnect.`, a reload within 5 s, and the new track re-tapped.
- **Task 11: allow-list `api/*`.** The client needs only two paths:
  - `GET api/status` at start (2 s timeout);
  - `api/websockets`: the upgrade, plus a plain GET before each self-reload. That GET got 400; a 409 would flip the
    client to WebRTC.

  Proxy those two (GET only), answer 404 to everything else without dialing the cell, and add
  `X-Content-Type-Options: nosniff`. The surface it refuses:
  - in the client: `POST switch`, `GET files/…`, `POST upload`, `GET print/<name>`, `GET turn`, the
    `<app>/signaling/` WebSocket;
  - registered by the server only: `GET health`, `GET|DELETE sessions[/<id>]`, `GET|POST|DELETE recording`,
    `GET screenshot`, `GET metrics` (if enabled), `POST tokens`, `webrtc/signaling`, `ws`.

  Task 11's test then proxies `api/status?x=1` instead of `api/health`, and checks that `api/screenshot` gets 404
  with no request upstream. The core's `manifest.json` fetch only sets its title, so its 404 is harmless.
- **Task 11 comment.** While the daemon pings, Selkies sends no protocol pings at all: aiohttp 3.14.3 resets its 30 s
  heartbeat on every received frame. Selkies' own receive loop answers the pings (`autoping=False`), so each pong proves
  its handler is alive.

**Measurement code.** This folder has `recorder.js` (paste it into the page), `latency-send.mjs`, `motion.sh` (Step 3
with timestamps) and `latency-raw.json` (each block's send times, per-press latencies, and how its state was
confirmed).

**Method.** The Chrome CPU is `top -l 3 -s 2` summed over the MCP Chrome's process tree; the user's own Chrome is
excluded. The MCP Chrome runs with Puppeteer's no-throttling flags, so a hidden tab in a normal Chrome is untested.
Cleanup after both sessions: `docker rm -fv ld-s8-desktop`, `host.mjs` stopped, the pages closed.
