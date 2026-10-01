# S8 findings: Selkies' client hosted in our own page

2026-10-01 · macOS 26.6.2, Apple M3 Ultra · Docker Desktop engine 29.2.0 (VM 10 CPUs, 14.6 GiB) · image
`localdot/desktop:dev` `sha256:c1522d532570…` (b7ee200: Selkies 2.0.0, xfwm4 4.20.0 with its compositor on, Chromium
154.0.8037.57) · viewer: Google Chrome 154.0.8037.92 (the DevTools MCP's own instance and profile), 1312×880 CSS px at
DPR 2 · `host.mjs` on Node 25.6.0, ws 8.22.0

**Result: GO.** The vendored dashboard runs from our server under `/d/t1/`, in a 1×1 inert same-origin iframe. The
parent clones its `<video>` track into a `MediaStreamTrackProcessor` and the worker paints every frame. Step 2 worked
first time; none of its fallbacks was needed. Watchdog constants for Task 11: **`STREAM_PING_MS = 500`,
`STREAM_STALL_MS = 1500`**. The longest silence on a live upstream was 505 ms, on a still screen and in motion.
**Separate finding for Part 3:** the xfwm4 compositor adds about 27 ms to input-to-frame latency (below).

- **Extractor.** `index.html` without the manifest link, `assets/` (`index-CPWh3fQ6.js`, `selkies-core-BbKps5RD.js`,
  `index-D97fjY6g.css`, 1.1 MB), `icon.png`, `icon-512.png` and `LICENSE` (MPL-2.0, 373 lines).
- **Step 2.**
  - The host logged `upstream open`.
  - Console: `[Selkies] video sink: MediaStreamTrackGenerator on the page — this browser exposes no
    VideoTrackGenerator to a worker.`, then one `tapped 88ea1889-… {…"height":1600,"width":2560}`. `ldReady()` was true.
  - A still screen sends nothing, so `presented` stayed 0 until a window opened. Then `#stats` read
    `{"presented":61,"fps":43,"size":"2560x1600","format":"I444"}`.
  - The canvas showed the WhiteSur light desktop with its dock, sharp at DPR 2.

| Step 3, compositor on (as built) | Value |
|---|---|
| fps at rest | 0: a still screen sends nothing, except a clock repaint (6 messages) once a minute |
| fps during the scroll (`#stats`, per second) | 59–62 (run A1), 61–62 (run A2); expected 45–62 |
| fps while moving; frame gap p50 / p90 / p99 / max | 61.1; 16 / 19 / 25 / 38 ms (A1) · 61.2; 16 / 19 / 24 / 28 ms (A2) |
| container CPU while moving (`docker stats`) | 181–194 % (A1), 182–198 % (A2); at rest with Chromium open, 12–17 % |
| viewer Chrome CPU (renderer + GPU + browser) | 23–28 % and 41–42 % (the two valid `top` samples while moving); at rest, 1.7–3.3 % |
| relay while moving | upstream 60–70 msgs/s, 1.1–2.2 MB/s; client 20 msgs/s (its 50 ms acks) |
| idle cadence (still screen, 110 s) | upstream msgs/s 0.0, pongs/s 2.0, **pings/s 0.0**, client msgs/s 0.8–1.0, longest silence 505 ms |
| `docker pause`, 6 s | `silence now 5120 ms`, `pongs/s 0.0`; after unpause `pongs/s 4.0` (queued pings answered), longest silence 6201 ms |
| after unpause | same socket, same track, no reload; the next motion arrived at 62 fps |

GPL-3 reaches its end about 11 s into the 20 s of presses. The fps, gap and CPU figures cover only the moving part: a
frame gap under 100 ms counts as moving, and CPU samples are those taken before the last moving frame.

## Compositor on vs off (for Part 3)

Toggled live as `abc` (`xfconf-query -c xfwm4 -p /general/use_compositing -s false|true`), each change confirmed by the
owner of `_NET_WM_CM_S0`. **Motion:** fps while moving 61.1 / 61.2 with it on (A1 / A2) vs 61.4 off (B). Frame gaps
match: p50 16 and p90 19 ms in every run; p99 25 / 24 vs 23. Container CPU median is 190 / 196 % on vs 182 % off. So
cadence is unchanged and the compositor costs about 10 CPU points.

**Latency is not unchanged.** It was measured with S6's method: its flash page in a normal window (fullscreen windows
bypass the compositor, because `unredirect_overlays` is on), and a persistent `docker exec -i … xdotool -` pressing
`key space` every ~600 ms. Latency runs from the host's send to the first frame at the tap. That tap is a second
`MediaStreamTrackProcessor` on another clone, read with `Date.now()`. Each block had 60 presses, and every press got
its frame.

| Send → frame, ms | p50 | p90 | p95 | max |
|---|---|---|---|---|
| on, flash page (two blocks) | 46, 47 | 55, 59 | 57, 63 | 58, 67 |
| off, flash page (two blocks) | 20, 21 | 27, 28 | 29, 30 | 31, 31 |
| on, `vblank_mode=off` | 49 | 59 | 64 | 68 |
| xfce4-terminal, on / off | 47 / 19 | 57 / 26 | 60 / 27 | 62 / 30 |

- The off rows reproduce S6's 2× line (p50 17.5, p95 27.3) to within 3 ms.
- The compositor adds about 27 ms at the median (about 1.6 frames) and about 30 ms at the top. The terminal shows the
  same, so the delay is xfwm4's, not Chromium's. `vblank_mode=off` doesn't remove it.
- With the compositor on, Part 3's calibration gate (p50 ±3 ms, p99 ≤ S6 p99 + one frame) cannot pass against S6.

## For Tasks 11–14 (no code change needed)

- **Relay ordering** (dial first, upgrade from the upstream's open) works with the real client.
- **The client's GETs under `api/`.** Task 11's GET/HEAD proxy covers both:
  - `api/status` at start, with a 2 s timeout;
  - a plain `api/websockets` before each self-reload. It returned 400 here; a 409 would switch the client to WebRTC.

  The core also fetches `manifest.json`, only to set its title, so that 404 is harmless.
- **Heartbeat.** Selkies sends no protocol pings while the host pings: aiohttp 3.14.3 resets its 30 s heartbeat on every
  received frame. Selkies' own receive loop answers the pings (`autoping=False`), so each pong proves its handler is
  alive.
- **Reconnects.** A pause reconnects nothing: the same socket resumes. Task 14 Step 4's "the client reconnects by itself"
  holds only after a close.
  - After `s6-svc -r /run/service/svc-selkies`, the relay logged `upstream close 4000 server shutting down` and closed
    the viewer with 1012.
  - The client logged `WebSocket disconnected, reloading page to reconnect.` and reloaded within 5 s.
  - The parent then tapped the new track (`c6460483-…`).
  - The reload reuses the iframe's URL, so it recovers only while that URL's ticket is valid.

**Method.** The Chrome CPU is the brief's `top -l 3 -s 2`, summed over the MCP Chrome's process tree; the user's own
Chrome is excluded, and `top`'s first sample is always 0. The MCP Chrome runs with Puppeteer's no-throttling flags, so a
hidden tab in a normal Chrome is untested. Cleanup: `docker rm -fv ld-s8-desktop` and `host.mjs` stopped.
