# S1 findings: Selkies stream into our own page

2026-09-30 · macOS 26.6.2, Apple M3 Ultra · Docker Desktop 4.60.0 (Engine 29.2.0, VM 10 CPUs / 14.6 GB) ·
`lscr.io/linuxserver/webtop:ubuntu-xfce` `53afe260-ls3` (`sha256:73f966bd414c…`): Ubuntu 26.04.1, Selkies 2.0.0,
pixelflux 2.1.0, XFCE 4.20, Chromium 154.0.8037.57 · viewer: Chrome 154.0.8037.92, 1280×800 CSS px at DPR 2 on a
144 Hz display · Node 25.6.0

**Result: GO-WITH-CHANGES.**

- **Stream at 2×.** Only 2× is sharp on a DPR-2 (Retina) viewer, and it keeps the frame rate: both scales hold
  62 fps in continuous motion. It costs 2.5–3× the container CPU of 1× (`load.sh` median 107 % vs 42 %,
  continuous 234 % vs 75 %, peak 251 % against the ≤ 400 % target), 2.5–4× the bitrate (35 vs 14 Mbps on
  `load.sh`) and roughly 1.7× the viewer's CPU. XFCE itself does not scale at 2× (see 2× rendering).
- **Take frames from Selkies' element: no decoder of our own, no VNC.** In Chrome the frames land in
  `<video id="videoStream">`, fed by a `MediaStreamTrackGenerator` (a video element, not a 2D canvas). Uploading it
  into WebGL costs ≤ 0.1 ms of main-thread time. With a forced GPU sync the p50 is 1.7 ms (1×) and 2.3 ms (2×).
  Better still for Part 2: a `MediaStreamTrackProcessor` on a clone of that element's track yields every decoded
  frame as an `I444` `VideoFrame`, which can be transferred to a worker.
- **Changes needed:**
  1. The plan's `tap.js` draws nothing on this machine. The committed one adds `{ antialias: false }`
     (see Step 6).
  2. The desktop image needs HiDPI XFCE settings for 2× (panel, xfwm4 theme, GTK scaling).
  3. Upload a frame when a new one arrives (`requestVideoFrameCallback` or the track), not on every
     `requestAnimationFrame`. At 2× the tap re-uploads at the display rate and took Chrome's GPU process from
     7–9 % to 31–40 % of a core.
  4. As worded, the fps targets read Selkies' per-second fps during a Page_Down cadence. That counts how often the
     page moves, not what the stream can deliver (see "fps"). Judge smoothness by fps while moving or in
     continuous motion.
- **Remote cursor in the frames: no**, at 1× and 2×.
- **VNC fallback: not measured.** The brief's image cannot be pulled (see Step 7).

## Measurements

These runs use the direct dashboard (`https://127.0.0.1:4791`) with the STATS panel open. "`load.sh`" is the
brief's Page_Down scroll. "continuous" is `load-continuous.sh`, which presses Down every 40 ms for 20 s so the
page moves every frame. Values are medians (min–max) over the scroll window.

| | 1× `load.sh` | 2× `load.sh` | 1× continuous | 2× continuous |
|---|---|---|---|---|
| Selkies fps/s, server / client | 24 (18–58) / 25; run 2: 26 (19.9–51.8) / 27 | 24.9 (4–58.9) / 26 | 61.9 (59.9–62) / 62 | 61.9 (60.6–62.9) / 62 |
| fps while moving, gap p50 / p90 ms (`probe.js`) | 47.4, 17.3 / 27.3 (run 2) | 47.9, 17.6 / 30.2 | 61.2, 16.2 / 18.0 | 61.1, 16.2 / 19.0 |
| container CPU % (`docker stats`) | 43.1 (33.9–47.7); run 2: 40.5 (31.9–55.1) | 106.7 (91.0–154.1) | 74.7 (64.5–78.0) | 233.8 (149.5–250.1) |
| Mbps: Selkies / eth0 tx average | 13.8 (1.7–22.7) / 13.75; run 2: 13.8 / 13.99 | 32.8 (8.2–51.4) / 35.16 | 3.7 (1.7–7.1) / 4.05 | 13.9 (5.3–31.3) / 15.34 |
| encode ms / capture → encoded ms | 3.38 (2.24–4.16) / 3.46 | 9.97 (8.06–13.74) / 10.19 | 2.17 / 2.20 | 7.90 / 8.01 |
| viewer decode ms (software) | 1.34 | 2.34 | 0.54 | 1.14 |
| % of a core in the container | selkies 23–29, chromium 9–11 | selkies 62–103, chromium 21–36, Xvfb 6 | selkies 36–38, chromium 25–33, Xvfb 3 | selkies 128–140, chromium 72–88, Xvfb 9–10 |
| viewer Chrome, all processes % | 18–29 | 39–45 | 24–28 | 38–49 |

Frame upload, measured through the proxy:

| | 1× | 2× |
|---|---|---|
| source element | `VIDEO 1280x800` | `VIDEO 2560x1600` |
| `ldTapStats().uploadMsP50` (committed `tap.js`, sampled every 2 s through `load.sh`) | 0.100 in 30/30 samples | 0.100 in 29/29 samples |
| synced upload p50 / p90 / p99 / max ms (`probe.js` `ldProbeSyncUpload`, alone, continuous) | 1.7 / 2.0 / 2.2 / 2.4 | 2.3 / 3.2 / 3.6 / 4.0 |

Targets:

- 1× ≥ 50 fps while scrolling: **missed** as the panel reads it during `load.sh` (per-second median 24–26). Also
  just missed while moving (47.4–48.9). **Met** in continuous motion (62).
- 1× CPU ≤ 200 %: **met**. Direct runs peaked at 55 % (78 % continuous); no 1× run exceeded 85 %.
- 2× ≥ 30 fps: **missed** as the panel reads it (median 24.9). **Met** while moving (46.4–47.9) and in continuous
  motion (62).
- 2× CPU ≤ 400 %: **met**. Direct runs peaked at 154 % (250 % continuous); no 2× run exceeded 252 %.
- Upload p50 ≤ 2 ms at 1× and ≤ 4 ms at 2×: **met** (0.1 ms main thread; 1.7 / 2.3 ms synced).

### fps: why the panel reads about 25 during `load.sh`

The image sets `SELKIES_VIDEO_STREAMING_MODE=false`, so pixelflux encodes only when the screen changes: 0 fps and
0 Mbps while it is still. `load.sh` presses Page_Down every ~0.55 s, and the page is moving for only 17–20 s of each
~33 s run (`probe.js` motion time). No stage is near its limit. Encode takes 2–4 ms per frame at 1× and 8–14 ms at
2×, `throttled` is never true, and RTT is 1.2–5.0 ms. The same pipeline holds 61–62 fps as soon as the page moves
every frame. During a Page_Down animation the stream shows 46–49 fps. The likely cause is Chromium rendering in
software inside the container; this is inferred from the headroom above, not measured in the container.

## Step 2 facts

- Display `:1`, socket `/tmp/.X11-unix/X1`. The X server is `Xvfb :1 -dpi 96 … -shmem` at both scales, but at 2×
  `xdpyinfo` reports 2560x1600 at 192×192 dpi and `xrdb` has `Xft.dpi: 192` (1×: 1280x800, 96 dpi).
- Desktop user: `uid=1000(abc) gid=1000(abc) groups=1000(abc),27(sudo),100(users),990(docker)`.
- Browsers: `command -v chromium chromium-browser firefox` prints only `/usr/bin/chromium`; dash's `command -v`
  reported just that one name. `/usr/bin/chromium-browser` also exists; there is no Firefox. `/usr/bin/chromium` is a
  linuxserver wrapper that runs `chromium-browser --no-first-run --password-store=basic`, adding
  `--no-sandbox --test-type` in unprivileged containers. Chromium 154.0.8037.57.
- `xdotool` is preinstalled, so the `apt-get` in `load.sh` never runs. `load.sh`'s `DISPLAY=:1` matches, so it
  runs unchanged.
- Remote cursor in the frames: **no**. Evidence:
  - At 1×, `xdotool mousemove 800 150` put the X pointer on plain sky. The 200×200 device-px crop spans only
    R 54–72, G 52–66, B 93–102, so there is no arrow.
  - A dashboard hover moved the X pointer to (640,400) (`xdotool getmouselocation`). No arrow shows over the dark
    tree there (grey max 108).
  - At 2×, `mousemove 1600 300` onto a link: the link's hover effects show, but no pointer.
  - Selkies composes the cursor into the video only after `SET_NATIVE_CURSOR_RENDERING,1` (`capture_cursor`
    defaults off). With `SELKIES_ENABLE_CURSORS=false` it sends no cursor images, and the page shows its own CSS
    arrow on `#overlayInput`.

### How the launcher settings landed

The startup log reads `Selkies 2.0.0 starting: websockets transport, X11 (:1) capture, encoder h264enc at 8-240
fps, fixed 1280x800, audio off` (`fixed 2560x1600` at 2×).

- `SELKIES_FRAMERATE=60` sets the initial rate inside the allowed 8–240 range; the client reports 60.
- `SELKIES_VIDEO_FULLCOLOR=true` gives H.264 4:4:4 (panel: `x264 · H.264 4:4:4`). Chrome has no hardware decoder
  for that (panel: `DECODER software`, "no hardware decoder for this stream"). 4:2:0 might decode in hardware;
  not measured.
- Encoding is x264 in software with XShm capture and no GPU (`NvFBC: the X server offers no NV-GLX; DRI3: encode
  node 0 has no readable render node`).

### 2× rendering

Chromium follows `Xft.dpi` 192 and renders at scale 2. Comparing the same text from the 1× and 2× streams, both
shown at DPR 2, it is soft at 1× and sharp at 2×. XFCE does not scale:

- `Gdk/WindowScalingFactor` stays 1.
- xfwm4 uses `Greybird-dark`, not an `-hdpi` or `-xhdpi` theme.
- The panel stays 26 px with 16 px icons.

At 2× the panel is half-height and its two-line clock overflows it. xfwm4 title bars are 1× high, so the 2× title
text is clipped (xfce4-terminal). An untested fix for the Part 2 image: window scaling 2 with `Xft/DPI` 96, the
`Default-xhdpi` xfwm4 theme (already in the image), and a doubled panel size.

## Step 5: proxy

`pnpm install` adds `http-proxy` 1.18.1 plus eventemitter3 4.0.7, follow-redirects 1.16.0 and requires-port 1.0.0.
`node spikes/s1-stream/proxy.mjs` listens only on `127.0.0.1:4792`. Checks through it:

- `isSecureContext` is true and `VideoDecoder` is present.
- `lsof` shows the WebSocket as browser → `127.0.0.1:4792` plus node → `127.0.0.1:4791`.
- Mouse: a dashboard hover put the X pointer at (1280,800) on the 2× desktop.
- Keyboard: click, Ctrl+L, typing `example.com` and Enter navigated the remote Chromium (`Example Domain -
  Chromium`).

`secure: false` also skips the certificate click-through after the container is recreated. The proxy used
0.7–2.2 % of a core. Fps and CPU match the direct path; with `load.sh` and the tap running:

- 2×: CPU 107.0 (85.0–139.7) %, 46.4 fps while moving.
- 1×: CPU 42.1 (31.3–56.5) %, 48.9 fps while moving.

## Step 6: frame tap

- **Largest element:** `VIDEO#videoStream` (1280x800 at 1×, 2560x1600 at 2×). Selkies logs
  `video sink: MediaStreamTrackGenerator on the page — this browser exposes no VideoTrackGenerator to a worker`.
  `canvas#videoCanvas` and `canvas#videoWorkerCanvas` are hidden.
- **The plan's `tap.js` draws nothing.** `getContext("webgl2")` is antialiased, with `SAMPLES` 4 on the drawing
  buffer, and `blitFramebuffer` into a multisampled draw framebuffer is `INVALID_OPERATION`. `getError` returns
  1282 after the blit, while `texImage2D` and the attach return 0. With `{ antialias: false }` the blit succeeds;
  the committed `tap.js` has that one change. The copy is upright, not upside-down.
- **`uploadMsP50` reads 0.100** because `performance.now()` steps in 0.1 ms here (`crossOriginIsolated` is false).
  The real work happens in Chrome's GPU process: 7–9 % → 31–40 % of a core at 2× while the tap runs at 144 Hz.
  `probe.js`'s `ldProbeSyncUpload` does the same upload plus a 1-px `readPixels` and measured the full cost in the
  table. Run it on its own: next to the tap it read 2.2 ms at 1× and 3.7 ms at 2×.
- **The track carries every frame.** A `MediaStreamTrackProcessor` on a clone of the `<video>`'s track saw every
  frame (decoded / presented via rVFC / ≈ encoded):
  - 2× continuous: 1389 / 1388 / ≈1388.
  - 1× continuous: 1432 / 1431 / ≈1430.

  Frames are `VideoFrame`s in CPU memory: `2560x1602 I444` and `1280x802 I444`.
- **The sink depends on the browser** (from Selkies' client code):
  - `VideoTrackGenerator` in its video worker → `<video>`, where the browser offers it.
  - `MediaStreamTrackGenerator` on the page → `<video>` (Chrome).
  - Otherwise an `OffscreenCanvas` in the worker behind a placeholder `<canvas>`.

  Only Chrome 154 was measured.
- **For Task 5:** `tap.js` leaves `READ_FRAMEBUFFER` bound to its texture framebuffer. So `detector.js`'s
  `readPixels(tap.width / 2, tap.height / 2)` reads the full-size frame at pixel (320,200) from the top-left, not
  the canvas centre. It returned 41,41,41, which matches the video's own pixel there; a full-screen kiosk page
  should cover that point at both scales. Reading the displayed `#ld-tap` canvas's own buffer returned 0,0,0,0, even
  straight after a blit (a canvas that isn't on the page read back fine).

## Step 7: VNC fallback

The condition applies: the panel's fps readings miss both targets. The brief's command fails:

```
$ docker run -d --name ld-s1-vnc -p 127.0.0.1:4793:6901 ghcr.io/trycua/xfce-cua:latest
docker: Error response from daemon: error from registry: denied   (exit 125)
```

`docker manifest inspect` also returns `denied`. Skipped as the brief says. Docker Hub lists `trycua/xfce-cua` and
`trycua/cua-xfce` (not tried).

## Method

- **Container CPU:** `load.sh`'s own `docker stats` loop, using the samples taken while the keys ran (raw below).
- **Selkies numbers:** the STATS panel's per-second samples (`window.stream_stats.history`; `probe.js`
  `ldSelkiesStats`). They flow only while the panel is open, because the page sends `_stats,1`. Encoded fps and
  encode/pipeline ms come from the server; client fps, Mbps and decode ms from the page.
- **eth0 tx:** `docker exec ld-s1-desktop sh -c 'while :; do echo $(date +%s.%N) $(cat
  /sys/class/net/eth0/statistics/tx_bytes); sleep 1; done'`, averaged over the scroll.
- **Per-process CPU:** `docker exec ld-s1-desktop top -b -n 5 -d 5`; for the viewer Chrome,
  `top -l 5 -s 5 -pid …`.
- **Fps while moving:** `probe.js` logs every presented frame (`requestVideoFrameCallback`); gaps under 100 ms
  count as motion.
- **Viewer:** a separate Chrome with its own profile, driven by the DevTools MCP. On 4791 the self-signed
  certificate was accepted through the interstitial's Proceed link, again after every container recreation because
  each container makes a new certificate.
- **Hardware caveat:** this host is far faster than the spec's M1-class laptop, so decode and upload will cost more
  there.
- **Idle container:** 6.4 % CPU and 597 MiB at 1× before any load; 7–8 % (1×) and 18–19 % (2×) with Chromium left
  open.

## Raw

`docker stats` CPU % while the keys ran:
```
1x load.sh run 1:     45.44 45.59 34.95 33.93 36.95 43.43 40.46 44.76 42.11 43.06 47.71
1x load.sh run 2:     44.76 39.26 35.15 38.59 41.22 43.06 37.78 43.53 31.93 40.48 55.12
2x load.sh:           153.98 106.70 102.28 92.02 154.14 102.50 120.58 115.98 106.95 90.98 105.99
1x continuous:        76.44 74.65 78.02 73.85 64.49 72.85 77.72
2x continuous:        234.38 234.91 250.06 233.75 184.77 213.51 249.59 149.50
1x load.sh proxy+tap: 56.52 41.75 43.30 43.60 39.04 42.12 42.78 40.31 34.45 42.79 56.17 31.27
2x load.sh proxy+tap: 130.77 136.70 97.99 94.56 107.00 132.64 139.65 102.82 90.67 84.99 133.15
1x continuous proxy+tap+sync:   77.35 84.77 82.86 80.95 69.52 76.78 82.27
2x continuous proxy+tap+track:  224.91 233.25 239.98 235.92 200.20 218.67 223.55 177.35
2x continuous proxy+tap+sync:   228.53 241.74 248.14 251.48 213.28 238.71 244.83 148.08
```
Selkies per-second fps, server/client:
```
1x load.sh run 1: 23.9/7 23/27 27.9/27 35/21 24/42 28/25 21/21 24/21 27/28 24/20 58/43 44.8/43 28/43 20/24 24/29 28/29 22/21 24/26 26/24 23.9/23 22.9/25 24/25 29/25 18/22 24/26 29/25 23/23 39/34 26.8/34 27/24 38/34 23/34 31/34 23.9/32
1x load.sh run 2: 26/17 19.9/25 24/25 27/24 26/24 23/28 25/22 28.9/22 21/24 24/27 26.9/27 25/22 21/26 23.9/23 29.9/25 21/29 39/29 43/43 23/23 21/23 40/35 43.9/37 21/28 37/34 28.9/22 38/50 39.9/35 25.9/35 28/22 37/44 51.8/43 46.9/39 20/29
2x load.sh:       4/11 39.9/47 40.9/47 23/20 21/26 21.9/26 27/21 21/26 24/23 28.9/23 19/31 58.9/59 58.9/57 55/50 38.9/50 41.9/34 26/23 21/26 23/26 26/20 20/26 25/25 28/25 24/23 21/27 24.9/20 28/24 20/27 22/27 27.9/22 23/24 23.9/29 24.9/21
1x continuous:    61.9/26 61.8/62 62/61 61.9/62 61.9/62 60.9/62 61.9/61 61.9/61 61.9/62 61.9/62 61.9/61 61/62 62/62 61.9/62 61.9/62 62/62 61.9/61 61.9/62 60.9/62 61.9/61 59.9/61
2x continuous:    60.9/39 62/62 61.9/61 61.9/62 60.9/61 61.9/62 61.9/62 61/62 61.9/61 61.6/62 61.8/62 61.9/62 61.9/61 61.9/62 61.9/62 61/61 61.9/62 60.6/62 62.9/61 62/61 61/62
```
Selkies per-second Mbps and encode ms, `load.sh`:
```
1x Mbps:      11.68 10.58 14.32 11.22 10.53 12.31 16.96 13.83 15.34 18.55 5.17 5.88 8.91 6.64 8.56 11.47 16.9 13.03 14.69 13.81 10.78 14.97 14.37 12.6 11.68 17.28 22.72 14.88 19.48 22.53 15.5 19.06 16.09 1.67
1x encode ms: 3.42 3.19 3.32 2.69 2.83 3.13 3.63 3.67 3.52 3.49 2.24 2.27 3.11 3.32 3.12 3.12 3.45 3.51 3.27 3.54 2.98 3.87 4.06 4.02 3.83 4.16 3.38 3.37 3.54 3.57 2.78 3.44 3.4 2.55
2x Mbps:      44.63 26.69 31.23 28.86 33.72 32.6 32.53 50.28 32.52 43.21 26.78 8.18 21.48 17.75 20.65 26.6 34.83 42.3 31.9 27.61 40.11 32.83 35.29 32.59 37.3 33.21 47.08 51.35 40.49 47.02 51.27 43.53 24.97
2x encode ms: 13.15 11.54 8.27 9.08 9.25 12.62 13.74 10.32 11.25 11.94 11.64 9.85 8.99 8.26 10.15 10.19 8.33 8.94 9.86 9.05 8.06 10.01 11.58 9.68 9.17 11.83 11.92 9.08 11.11 12.87 9.97 9.48 9.3
```

After the runs: `docker rm -f ld-s1-desktop ld-s1-vnc` removed the desktop (`ld-s1-vnc` never existed). No `ld-s1-*`
container is left, and nothing listens on 4790–4799.
