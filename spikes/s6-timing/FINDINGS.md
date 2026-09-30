# S6 findings: injection-to-frame latency

2026-09-30 · macOS 26.6.2, Apple M3 Ultra · Docker Desktop engine 29.2.0 (VM: 10 CPUs, 14.6 GB, kernel
6.12.67-linuxkit, `CONFIG_HZ=1000`) · desktop: `localdot-spike-s2` (`sha256:13390a704cdd…`, per Ruling 20): Selkies
2.0.0, pixelflux 2.1.0, Chromium 154.0.8037.57, Mousepad 0.7.0, xdotool 3.20160805.1, Cua Driver 0.30.4, plus xinput
1.6.4 installed at run time · viewer: Chrome 154.0.8037.92, 1300×813 CSS px at DPR 2 on a 144 Hz display · Node 25.6.0

**Result: GO-WITH-CHANGES.**

- **The frame showing an input reaches our page 9.5 ms (1×) and 15.4 ms (2×) after the X server sees the input.**
  These are p50s over 370 trials per scale: two apps, keys, clicks and typing, both injectors.
  - The brief's lines, from the host's write to the first frame that shows the flip, with `tap.js` running:
    - 1×: `n=50/50 p50=11.4ms p95=18.9ms min=9.1ms`
    - 2×: `n=50/50 p50=17.5ms p95=27.3ms min=13.8ms`
  - Target p95 ≤ 80 ms at 1×: **met**, and far under the brief's example (38/61 ms).
  - Without `tap.js`: 1× `n=50/50 p50=11.1ms p95=19.1ms min=6.4ms`, 2× `n=50/50 p50=16.7ms p95=23.2ms min=13.1ms`.
- **Compensation constant: 10 ms at 1×, 15 ms at 2×** (pooled p50s of 9.5 and 15.4 ms).
  - Count it from the X server's raw input event to the frame's arrival on the page.
  - The encoded chunk reaches the page 0.4–0.7 ms before its decoded frame (pooled raw → chunk p50: 9.1 and 14.7 ms).
  - The brief's p50s also include the host-to-container write (send → raw p50 0.7–1.3 ms), which `desktopd` won't
    have when it stamps injections itself.
- **Frame interval: 16.7 ms at the configured 60 fps.** In continuous typing, 1× ran at 61.4 fps (frame gap p50
  16.3 ms). 2× ran at 52.3 fps (gap p50 16.7 ms, p90 32.4 ms); Mousepad dropped frames under 200 keys/s, while S1's
  continuous scroll held 61 fps at 2×.
- **The drawn cursor lands within one frame of the frame showing the input: yes.** With the p50 as the constant, this
  held in 369 of 370 trials at 1× and 366 of 370 at 2×.
  - The ring is at most 4.7 ms (1×) or 5.8 ms (2×) early, and at most 18.0 ms or 28.4 ms late.
  - The five trials more than a frame late are all clicks: 27.5 ms at 1×; 32.9, 37.2, 42.7 and 43.8 ms at 2×.
  - The p5–p95 spread (12.1 ms at 1×, 13.4 ms at 2×) is under one frame. It is consistent with where the input lands
    in the 60 Hz render and capture cycles; that was not isolated.
- **Input path: keep Cua Driver.** Launch it with `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0` and take the injection
  time from XI2 raw events. This reverses S2's provisional plan to move pointer and keys to our own XTest.
  - **The driver injects sooner.** It presses 11–16 ms (p50) into a call; the brief's xdotool recipe presses at
    33–36 ms. From the send, the driver's effect frame arrives at 22–30 ms (p50) and xdotool's at 43–60 ms.
  - **S2's 843–893 ms calls are the driver's post-action window watch, not injection.** The watch is documented and
    lasts 800 ms by default on Linux X11. At 0, the same calls return in 30–36 ms (one character) and 62–68 ms (a
    click, including its ~37 ms press hold). The injection timing does not change.
  - **Neither path returns an injection timestamp.** An XI2 listener sees the X server's raw event for either
    injector, within ~2 ms.
- **Changes needed:**
  1. **Injection timestamp.** `desktopd` runs an XI2 raw-event listener (as `xilog.py` does). `input()` returns the
     first RawButtonPress or RawKeyPress after each call. The same events can drive `text.progress`, because every
     typed character's key press is observed.
  2. **Driver launch.** Start the driver with `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0`. This loses window-change
     evidence (`effect: confirmed` when an action opens a window); `settle()` and the fresh screenshot already cover
     it.
  3. **Constant per scale and per host.** 2× costs ~6 ms more here, and this M3 Ultra is faster than the spec's
     M1-class target. Re-measure on target hardware, or calibrate in the field with the content check under
     "Constant".
  4. **Clock mapping.** `desktopd`'s clock and the daemon's differ by about a millisecond, and the offset moved up to
     1 ms within a single 20–45 s run. Map them with a periodic lowest-RTT ping.

## Injection to frame: the brief's measurement

`measure.mjs 50` writes `key space` to one `xdotool -` process every 400–417 ms. `detector.js` reports each flip of
the flash page. Values are p50 / p95 (min–max) in ms.

| | 1× with tap.js | 1× without | 2× with tap.js | 2× without |
|---|---|---|---|---|
| send → frame (the brief's line) | 11.4 / 18.9 (9.1–) | 11.1 / 19.1 (6.4–) | 17.5 / 27.3 (13.8–) | 16.7 / 23.2 (13.1–) |
| send → raw event | 1.3 / 1.9 (0.5–1.9) | 1.2 / 1.8 (0.8–2.1) | 1.0 / 1.7 (0.6–2.1) | 0.7 / 1.2 (0.5–1.3) |
| raw event → frame | 10.3 / 17.7 (8.5–18.2) | 9.8 / 17.3 (5.7–19.1) | 16.4 / 25.2 (13.1–29.3) | 15.9 / 22.5 (12.6–26.0) |
| raw event → chunk on the page | 9.8 / 17.3 | 9.4 / 17.0 | 15.8 / 24.6 | 15.2 / 21.9 |
| chunk → frame (decode) | 0.4 / 0.6 | 0.4 / 0.5 | 0.6 / 0.8 | 0.6 / 0.8 |
| frame → `<video>` expected display | 15.1 / 19.1 | 10.9 / 13.4 | 10.0 / 12.7 | 10.6 / 13.0 |
| X server's event time → logger stamp | 1.4 / 2.1 | 1.7 / 2.2 | 1.5 / 2.1 | 1.6 / 2.1 |

- **Matching.** Every key produced exactly one flip inside its own trial window (50/50 in all four runs).
- **`tap.js` does not change when frames arrive.** At 1× it delays the `<video>` element's own display by ~4 ms. That
  matters only for DOM overlays over the `<video>`; when the stage draws video and ring in one canvas, the display
  delay applies to both.
- **2× costs ~6 ms at the p50.** This fits S1's per-frame encode times: 2–4 ms at 1×, 8–14 ms at 2×.
- **Fastest arrival.** The chunk reached the page as early as 4.3 ms (1×) or 8.8 ms (2×) after the raw event (pooled
  minimums).

## Constant

Pooled per scale over the two runs above and the nine input-path runs below (370 trials), from the raw event to the
frame on the page (ms):

| | p5 | p25 | p50 | p75 | p95 | p99 | max | mean |
|---|---|---|---|---|---|---|---|---|
| 1× | 5.3 | 6.8 | **9.5** | 13.9 | 17.4 | 19.1 | 27.5 | 10.5 |
| 2× | 11.0 | 13.2 | **15.4** | 19.4 | 24.4 | 32.9 | 43.8 | 16.6 |

Counts in 2 ms bins:

- 1×: `4–6:72 6–8:42 8–10:86 10–12:31 12–14:52 14–16:56 16–18:20 18–20:8 20–22:2 26–28:1`
- 2×: `8–10:3 10–12:34 12–14:95 14–16:68 16–18:44 18–20:52 20–22:35 22–24:20 24–26:7 26–28:6 28–30:2 32–34:1 36–38:1
  42–44:2`

- **Use the p50: 10 ms at 1×, 15 ms at 2×.** The product streams at 2×. Stamp both ends the same way every time: the
  injection from the X server's raw event, and the frame from its arrival. Arrival as a chunk is ~0.5 ms earlier than
  as a decoded frame, which is negligible against a 16.7 ms frame.
- **Early or late.** The p50 centres the error.
  - The spec's pixel oracle says "no click ring appears before the dispatch frame". If that means before the frame
    that shows the input, the p50 breaks it by up to ~6 ms in about half of all dispatches.
  - The p99 (19 ms at 1×, 33 ms at 2×) satisfies it, but the ring then trails by up to a frame.
- **Field calibration needs a content check.** On a still screen, the first frame after an injection was its effect in
  all 560 flash-page trials. It was not in 96 of 180 Mousepad trials, because the stream sends extra frames after every
  change (see "Frame interval and the stream's own frames"). A calibrator must check that the frame changed where the
  input landed.

## Input paths (Ruling 19)

**Method.**

- **Runs.** Each path ran 30 trials (`inputs.mjs`) after one untimed warm-up.
- **Measured points.**
  - "send": the host writes the command to a persistent process, either `stdbuf -oL xdotool -` or the driver's
    `mcp --no-overlay`, both over `docker exec -i`.
  - "raw": the first raw press after the send.
  - "frame": the first frame showing the effect. The flash page toggles on `keydown` and `mousedown`; in Mousepad, the
    effect is the typed glyph appearing.
  - "return": the call's reply reaches the host. For xdotool, the reply is the output of a trailing `getmouselocation`.
- **Commands.**
  - xdotool: `windowactivate --sync <wid>`, then `mousemove --sync X Y click 1` (click) or `type x` (type).
  - Driver: `click {pid, window_id, x, y, coordinate_frame: "desktop", delivery_mode: "foreground"}` or
    `type_text {pid, window_id, text: "x", delivery_mode: "foreground"}`.
  - "watch 0" adds `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0` to the driver's environment.
- **Units.** p50 / p95 in ms. "Held" is the p50 of raw release minus raw press.

1× (1280×800):

| Action and target | Path | send → raw | raw → frame | send → frame | send → return | held | timestamp |
|---|---|---|---|---|---|---|---|
| click, flash page | xdotool | 35.2 / 42.7 | 9.5 / 21.2 | 48.5 / 57.2 | 144.0 / 152.7 | 0.8 | no |
| click, flash page | driver | 15.4 / 17.2 | 6.6 / 16.2 | 23.1 / 32.0 | 899.3 / 915.9 | 36.9 | no |
| click, flash page | driver, watch 0 | 15.8 / 17.2 | 6.6 / 18.4 | 22.9 / 35.6 | 67.5 / 71.6 | 37.4 | no |
| type, flash page | xdotool | 36.2 / 42.4 | 14.3 / 18.0 | 49.9 / 57.9 | 49.3 / 54.8 | 4.8 | no |
| type, flash page | driver | 15.4 / 17.1 | 6.2 / 15.8 | 22.4 / 31.7 | 867.3 / 888.5 | 0.1 | no |
| type, flash page | driver, watch 0 | 14.8 / 16.7 | 9.5 / 16.1 | 23.5 / 32.6 | 35.9 / 39.6 | 0.1 | no |
| type, Mousepad | xdotool | 33.1 / 37.2 | 10.9 / 14.2 | 43.5 / 50.2 | 47.5 / 50.9 | 7.6 | no |
| type, Mousepad | driver | 14.2 / 15.7 | 9.0 / 14.7 | 22.7 / 29.7 | 859.9 / 878.6 | 0.1 | no |
| type, Mousepad | driver, watch 0 | 14.2 / 15.1 | 9.2 / 14.2 | 23.2 / 28.9 | 34.7 / 36.9 | 0.1 | no |

2× (2560×1600):

| Action and target | Path | send → raw | raw → frame | send → frame | send → return | held | timestamp |
|---|---|---|---|---|---|---|---|
| click, flash page | xdotool | 36.3 / 43.3 | 19.9 / 42.7 | 59.6 / 77.9 | 143.6 / 155.7 | 0.8 | no |
| click, flash page | driver | 14.8 / 16.1 | 14.3 / 24.8 | 29.5 / 38.1 | 887.4 / 918.0 | 38.0 | no |
| click, flash page | driver, watch 0 | 13.4 / 14.8 | 12.7 / 21.5 | 26.6 / 34.8 | 61.6 / 67.1 | 36.7 | no |
| type, flash page | xdotool | 34.6 / 42.3 | 17.4 / 23.8 | 54.7 / 62.4 | 47.6 / 55.2 | 5.1 | no |
| type, flash page | driver | 14.0 / 16.1 | 14.2 / 23.6 | 28.6 / 38.7 | 849.2 / 871.1 | 0.1 | no |
| type, flash page | driver, watch 0 | 11.1 / 13.3 | 14.0 / 19.9 | 25.4 / 32.5 | 30.5 / 32.6 | 0.1 | no |
| type, Mousepad | xdotool | 33.0 / 36.6 | 13.5 / 20.0 | 46.1 / 54.7 | 45.0 / 50.2 | 4.9 | no |
| type, Mousepad | driver | 11.2 / 14.1 | 14.1 / 19.2 | 26.4 / 30.9 | 850.9 / 886.4 | 0.1 | no |
| type, Mousepad | driver, watch 0 | 11.4 / 14.9 | 13.8 / 19.9 | 25.5 / 34.8 | 30.7 / 35.5 | 0.1 | no |

For comparison, the brief's bare `key space` (no activation) reaches the X server 0.7–1.3 ms after the host's write.

- **Raw → frame is set by the app and the stream, not by the injector.** For each target the three paths agree
  within one frame: p50 6.2–14.3 ms at 1×, 12.7–19.9 ms at 2×. The differences probably come from where each path's
  press lands in the 60 Hz cycles. The xdotool click tail at 2× (42.7 and 43.8 ms) was the worst; the driver's clicks
  peaked at 26.3 and 37.2 ms.
- **Send → raw.**
  - The driver presses 11–16 ms into the call, after activating the target and confirming focus.
  - The xdotool recipe presses at 33–36 ms, and almost all of that is `windowactivate --sync`. The type path has no
    `mousemove` yet presses at the same time, and a bare XTest key lands ~1 ms after the write. So the `--sync` wait
    costs ~30 ms even when the window is already active, which fits one fixed polling sleep (inferred from the
    timings, not traced).
  - Timed alone in the container, `windowactivate --sync` on the active window took 49.3 ms, including one
    `getactivewindow` process.
- **Send → return.**
  - The driver's default 850–900 ms is the post-action watch (next section).
  - xdotool's `click 1` returns ~107 ms after the press. This build sleeps its default 100 ms click delay after the
    last click too: alone, `click 1` took 112.0 ms and `click --delay 0 1` 8.2 ms.
  - `type x` returns 12–15 ms after the key.
- **No injection timestamp from either path.**
  - Driver: none of the 360 results has a time-like field. `structuredContent` holds only `delivery {mode}`,
    `effect` ("unverifiable"), `route` ("global_input") and `summary`, and the text ends "not verified — confirm with a
    screenshot".
  - xdotool prints nothing.
- **Press hold.** The driver holds a click ~37 ms and a key 0.1 ms; xdotool holds a click 0.8 ms and a key 5–8 ms.
  With the driver, controls that act on release respond ~37 ms after the press.

### The driver's 800 ms post-action watch

- **Documented.** The binary's embedded documentation has a section "Bounding the post-action window observation":
  "After an input action, the driver watches the window list for a short time so it can report a menu, dialog, or new
  window that the action opened." It documents two variables:
  - `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS`, "Longest wait for a window change after each action": default "1000 on
    macOS, 800 on Linux X11", range 0–10000.
  - `CUA_DRIVER_WINDOW_CHANGE_POLL_MS`: default 50.

  It also says: "With `0`, foreground actions never report window-change evidence. Focus checks and `suspected_noop`
  detection are unchanged." The symbol `platform_linux::input::foreground::wait_for_window_change` is in the binary.
- **Honoured by `mcp`.** With the variable at 0 in the launch environment, calls returned in 30–68 ms (p50s; single
  calls 28–74 ms), and the injection timing did not change.
- **This answers S2's open question.** The long tail comes after injection, not before it. The press lands ~15 ms into
  a default call and its frame ~23 ms in (1×); the call then returns 820–870 ms after the frame.

### Focus

- **Foreground input leaves the target active.** The tool description says foreground delivery will "activate the
  target …, inject, then restore the prior active window", but this does not happen here.
- **The check (2×).** Mousepad was active, with Thunar beside it. A foreground `click` on Thunar at desktop (420, 600)
  and a foreground `type_text "a"` into Thunar both left Thunar active, with the watch at its default and at 0.
  `xdotool getactivewindow` was read right after each call, and `type_text` reported `focus_after=target`. An xdotool
  click on the same point also left Thunar active, so the driver behaves like a human click.

## Frame interval and the stream's own frames

- **Continuous change.** `xdotool key --delay 5 --repeat 400 x` into Mousepad (72 pt), every frame logged by the
  detector:
  - 1×: 214 frames at 61.4 fps while moving; gaps p10 / p50 / p90 13.2 / 16.3 / 18.6 ms, max 32.9; decode p50 0.5 ms.
  - 2×: 159 frames at 52.3 fps; gaps 13.5 / 16.7 / 32.4 ms, max 56.6; decode p50 0.7 ms, max 17.
- **A still screen sends nothing.** Selkies encodes on damage (S1).
- **Every change is followed by a few frames with the same content.**
  - Flash page: five frames 285–365 ms after the change.
  - Mousepad: one frame 87–106 ms after, then four or five from ~360 to ~450 ms after.
  - Frames in a run are 15–21 ms apart.
  - They are probably quality refinement; the mechanism was not traced.
  - They never fell between a flash-page input and its flip: in all 560 flash-page trials the flip was the first frame
    after the raw event. In Mousepad each trial ends with a BackSpace whose frame lands ~445 ms before the next key, and
    96 of 180 trials had one of these frames between the key and the glyph.
- **Diagnostic repeat (1×, xdotool, Mousepad, n=30).** Every frame was logged with the luma of four regions: the whole
  changed cell, the glyph's centre, and the old and new caret columns.
  - The in-between frames changed none of the four regions.
  - Every glyph was complete (luma 164) in its first frame.
  - Raw → frame was again 11.1 / 13.9 ms (5.0–14.2).

## Method

- **Desktop.** `run-desktop.sh 1|2` is S1's command on the S2 image (Ruling 20). The container is `ld-s6-desktop` on
  127.0.0.1:4791, with S1's Selkies environment and `--shm-size=1g`.
  - `setup.sh` is Step 1 plus: it installs xinput (the image lacks it), copies `flash.html` and `xilog.py`, and opens
    the flash page in a kiosk Chromium.
  - At 1× the same steps were run by hand before the script existed.
- **Viewer.** A separate Chrome with its own profile on 127.0.0.1:9222, driven by the DevTools MCP.
  - It ran with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
    --disable-background-timer-throttling`, so an occluded window could not throttle it. The page read `visible` at
    every check.
  - It loaded `http://127.0.0.1:4792` through S1's `proxy.mjs`.
  - The tap runs evaluated `tap.js`, then `detector.js`.
- **Frames (Ruling 20).** `detector.js` reads a `MediaStreamTrackProcessor` on a clone of `#videoStream`'s track.
  - **Sampling.** For each `VideoFrame` (I444 here) it `copyTo`s one rect of the luma plane and averages it: on the
    flash page 32×32 at the centre (0 black, 255 white); in Mousepad the middle half of the typed glyph's cell (241
    empty, 164 with the glyph).
  - **Flip.** The mean crossing `threshold` is a flip, which is POSTed to `collector.mjs` on 127.0.0.1:4795.
  - **"frame":** `performance.timeOrigin + performance.now()` when the reader returns the frame.
  - **"chunk on the page":** `timeOrigin + VideoFrame.timestamp / 1000`. Selkies' client code stamps each chunk with
    `performance.now() * 1e3` when it arrives, before its worker decodes it.
  - **Expected display:** `requestVideoFrameCallback`'s `expectedDisplayTime`, matched through `mediaTime` = timestamp.
  - **Clock check.** The page's clock agreed with `Date.now()` within 0.1 ms.
- **Raw events.** `xilog.py` runs in the desktop as `abc`. It reads `stdbuf -oL xinput test-xi2 --root` and stamps each
  raw event with `CLOCK_REALTIME` and `CLOCK_MONOTONIC`.
  - The X server's own event time (whole ms on the monotonic clock; the kernel's coarse clock ticks at 1 ms here) was
    0.7–2.3 ms earlier than the logger's stamp.
  - So raw-event times are up to ~2 ms late: raw → frame reads up to ~2 ms low, and send → raw up to ~2 ms high.
  - A `desktopd` listener built this way has the same bias, so the constant holds for it.
- **Clocks.** `xi.mjs` maps container time to the host clock. Before and after each run it sends 40 pings over the
  logger's `docker exec` pipe and uses the one with the lowest RTT.
  - Minimum RTT was 0.62–1.17 ms, and the ten fastest pings agreed within 0.05–0.23 ms.
  - The offset (container − host) was −1.49 to −0.32 ms and moved by up to 1.00 ms within a run.
  - The mean of the two estimates is used, so the send / raw / frame split carries about ±1 ms.
  - send → frame and all page-side spans use the host clock only.
- **Matching.** Each trial owns the window from its send to the next send. Its raw event is the first raw press of the
  expected kind in that window, and its frame is the first flip. A missed flip would count as missing instead of
  borrowing the next trial's; none was missed.
- **Pacing.** 400 ms between sends plus 0–16.7 ms of random jitter. On its own, 400 ms is exactly 24 frames at 60 Hz,
  which could keep every send at the same capture phase. Each run starts with one untimed input, because a still
  screen gives the detector no baseline.
- **Paths.** `inputs.mjs` alternates the click point between the window centre ± width/32, so the pointer always moves.
  In Mousepad it sends an untimed BackSpace after each glyph.
- **Typing target.** `mousepad.sh` closes the kiosk, turns caret blink off (`/Net/CursorBlink`), sets Mousepad to
  DejaVu Sans Mono 72 and opens it. It derives the region from a before/after screenshot diff of one typed `x`, and all
  180 matched frames showed the glyph (luma 164–165).
- **Pooling.** `node summary.mjs out/*-1280x800-*.json`, and the same with `2560x1600`. The dry run, the 3-trial checks
  and the diagnostic are kept in `out/checks/`; `out/` is git-ignored, so the per-trial values are under "Raw".
- **Telemetry.** Every driver launch carried `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` and `CUA_DRIVER_RS_UPDATE_CHECK=0` with
  `mcp --no-overlay`. The binary was also read with `strings`, which does not run it.

## Files and changes from the brief

- `flash.html`: the brief's page plus a `mousedown` toggle, so clicks flash too (Ruling 19).
- `collector.mjs`: the brief's, but it keeps each whole payload instead of only `at`.
- `detector.js`: replaced per Ruling 20; it no longer calls `readPixels` on `#ld-tap`. The optional `extra` regions
  were added for the diagnostic after the main runs; the flip logic is unchanged.
- `measure.mjs`: the brief's loop, plus:
  - one warm-up key;
  - 0–16.7 ms of jitter;
  - a window per trial;
  - the raw-event split;
  - a JSON record in `out/`;
  - the container name from `LD_DESKTOP`, default `ld-s6-desktop`.
- Added:
  - `run-desktop.sh`: S1's command on the S2 image. It removes the container with `-v`, because the image's `/config`
    volume would otherwise be left behind.
  - `setup.sh`: Step 1.
  - `xilog.py` and `xi.mjs`: raw events and clock mapping.
  - `inputs.mjs`: the Ruling 19 comparison.
  - `mousepad.sh`: the typing target.
  - `summary.mjs`: pooling.
- The brief's `docker rm -f ld-s1-desktop` became `docker rm -fv ld-s6-desktop`.

## Not covered

- **Target hardware.** The spec targets M1-class laptops; this host is an M3 Ultra. At 2× encoding dominates the
  constant.
- **A busy screen** (video, animation), where an input's frame competes with other damage.
- **Other apps.** Only Chromium and Mousepad were measured; Calc was not used.
- **Other input.** Scroll, drag, double click, and the cadence of multi-character typing.
- **The daemon's own chunk stamps.** The page's receive stamp stood in for them; the proxy hop is loopback.

## Raw

`measure.mjs` result lines:
```
1x tap:    n=50/50 p50=11.4ms p95=18.9ms min=9.1ms
1x no tap: n=50/50 p50=11.1ms p95=19.1ms min=6.4ms
2x tap:    n=50/50 p50=17.5ms p95=27.3ms min=13.8ms
2x no tap: n=50/50 p50=16.7ms p95=23.2ms min=13.1ms
```
`summary.mjs`:
```
1x pooled raw->frame    n=370 p50=9.5ms p95=17.4ms min=4.8ms max=27.5ms
1x pooled raw->received n=370 p50=9.1ms p95=17.0ms min=4.3ms max=27.1ms
1x C = p50 = 9.5 ms: 369/370 trials within one 60 Hz frame (±16.7 ms); error -4.7 to +18.0 ms
2x pooled raw->frame    n=370 p50=15.4ms p95=24.4ms min=9.6ms max=43.8ms
2x pooled raw->received n=370 p50=14.7ms p95=23.6ms min=8.8ms max=43.2ms
2x C = p50 = 15.4 ms: 366/370 trials within one 60 Hz frame (±16.7 ms); error -5.8 to +28.4 ms
```
Per trial, in trial order (ms): raw → frame, then send → raw. Headers carry the screen and, for input paths, the p50
press hold. `cua` is the driver and `xdo` is xdotool:
```
[1280x800] cua click flash (press->release p50 36.9 ms)
  raw->frame: 15.0 5.5 9.5 10.8 5.3 5.6 17.7 7.7 13.9 12.4 6.0 5.8 11.6 5.6 11.9 5.7 5.5 16.2 6.6 10.2 16.1 5.6 6.4 5.9 5.6 5.9 14.9 13.3 5.1 5.3
  send->raw:  15.6 15.8 16.4 15.2 13.6 10.5 14.2 13.5 15.4 15.0 12.6 15.6 15.1 14.0 14.8 15.0 15.0 15.9 15.8 15.1 15.4 15.8 16.5 14.8 17.5 17.2 17.0 17.0 16.1 15.4
[1280x800] cua click flash watch=0 (press->release p50 37.4 ms)
  raw->frame: 4.9 7.0 5.1 5.9 5.4 5.1 14.2 13.0 6.6 12.4 15.8 5.1 7.1 5.5 5.0 5.5 13.0 5.3 5.6 5.2 20.5 14.3 5.4 5.4 18.4 10.1 8.9 5.1 14.6 7.0
  send->raw:  11.4 16.7 15.9 14.8 21.0 11.6 16.1 16.4 16.0 15.0 15.3 14.6 16.2 15.5 14.0 14.8 14.2 16.1 15.8 10.1 15.7 17.1 15.3 16.8 17.2 16.5 16.4 11.6 15.5 16.0
[1280x800] cua type flash (press->release p50 0.1 ms)
  raw->frame: 15.8 6.0 6.9 14.0 5.7 6.1 5.3 5.6 14.6 6.2 5.9 10.0 5.4 10.0 5.5 18.5 14.3 10.2 5.6 5.9 12.8 11.2 6.6 5.8 5.5 13.0 5.4 5.9 7.8 5.2
  send->raw:  15.1 14.5 15.5 13.1 14.3 16.4 16.5 17.3 17.1 13.2 16.1 14.5 12.0 14.8 14.7 16.4 15.1 14.8 14.6 16.9 16.0 15.4 15.8 16.7 16.4 15.7 15.8 14.9 14.5 13.1
[1280x800] cua type flash watch=0 (press->release p50 0.1 ms)
  raw->frame: 16.1 5.4 12.5 4.8 5.7 6.2 13.8 5.4 7.4 5.2 13.6 10.6 17.4 5.2 5.8 15.8 5.1 10.9 5.0 14.1 9.5 14.8 7.5 5.2 5.5 14.1 13.9 5.4 15.3 14.3
  send->raw:  16.8 13.6 14.0 12.7 12.8 15.2 9.8 14.8 14.1 15.2 16.3 13.9 15.2 14.0 16.7 15.0 14.0 14.6 14.8 14.8 15.0 15.7 12.3 15.4 14.2 14.0 16.5 14.6 15.3 14.5
[1280x800] cua type mousepad (press->release p50 0.1 ms)
  raw->frame: 6.7 11.5 13.8 6.1 14.4 14.7 9.2 6.0 5.7 6.1 9.0 9.3 7.6 5.9 6.2 14.9 5.8 14.6 13.4 5.8 13.4 14.5 9.5 8.0 8.0 5.3 10.5 7.7 8.3 14.0
  send->raw:  14.1 13.2 15.6 14.3 13.7 15.7 12.5 14.8 15.3 14.2 15.4 12.6 13.5 13.4 13.9 10.7 13.8 11.0 14.4 14.6 13.5 14.0 17.0 13.9 14.7 15.0 13.5 15.0 15.0 15.7
[1280x800] cua type mousepad watch=0 (press->release p50 0.1 ms)
  raw->frame: 5.7 12.3 6.6 15.4 12.8 7.7 10.5 9.0 7.2 10.2 8.4 6.6 5.6 13.9 5.1 12.3 5.5 13.7 13.9 5.8 5.8 12.8 5.8 5.6 9.2 9.2 10.2 14.2 13.5 8.0
  send->raw:  14.2 12.1 13.9 14.4 14.0 14.2 15.1 11.2 16.0 14.2 13.7 14.5 11.6 12.1 14.2 13.6 13.4 14.6 14.7 12.2 14.9 14.4 15.0 14.6 13.6 14.4 13.6 14.7 13.5 14.1
[1280x800] xdo click flash (press->release p50 0.8 ms)
  raw->frame: 13.7 13.8 8.7 9.1 8.7 16.3 9.4 8.9 6.0 9.1 15.7 14.1 9.3 27.5 5.6 8.5 14.9 16.4 17.8 8.1 8.3 17.4 21.2 9.5 18.1 9.3 8.4 9.5 14.3 15.5
  send->raw:  39.7 42.7 34.8 35.2 35.7 34.1 36.8 33.9 32.9 37.4 36.7 36.7 34.3 38.5 38.1 33.9 35.4 35.0 35.2 33.1 36.4 39.9 34.2 33.6 34.3 33.4 33.8 43.0 34.7 33.0
[1280x800] xdo type flash (press->release p50 4.8 ms)
  raw->frame: 8.8 9.6 14.3 11.0 15.7 13.6 15.8 9.4 16.8 5.3 8.6 18.0 14.3 11.8 14.5 8.5 17.8 14.9 8.3 15.7 8.7 14.7 9.4 16.8 8.3 15.0 16.6 18.3 13.6 10.4
  send->raw:  42.0 42.4 34.7 32.6 32.8 36.4 40.5 37.4 33.4 33.6 34.0 34.4 35.8 35.5 37.5 34.2 40.0 36.6 40.7 34.1 33.3 43.4 37.4 35.0 36.4 36.3 36.2 38.8 32.5 32.9
[1280x800] xdo type mousepad (press->release p50 7.6 ms)
  raw->frame: 12.4 6.5 12.7 10.4 13.5 4.9 13.9 6.8 12.0 6.5 6.8 6.6 7.4 6.4 7.2 14.7 10.9 11.3 12.3 6.9 11.1 11.3 13.0 5.0 7.6 10.6 14.2 13.5 7.1 13.1
  send->raw:  39.1 33.1 33.3 33.0 33.9 32.3 35.7 33.1 33.7 34.1 33.8 32.9 32.4 33.2 32.9 33.0 32.8 32.5 35.1 33.8 32.3 33.0 37.2 32.8 34.4 32.9 34.2 32.4 33.0 35.3
[2560x1600] cua click flash (press->release p50 38.0 ms)
  raw->frame: 20.7 14.2 16.9 21.9 17.8 20.2 13.7 13.4 13.5 12.9 12.9 22.8 26.3 24.8 14.4 14.3 20.7 12.7 13.4 23.8 11.8 18.9 13.6 13.4 13.4 15.6 13.7 24.0 14.3 12.9
  send->raw:  13.9 15.3 14.8 13.5 14.4 15.1 15.5 15.2 14.6 14.9 13.6 13.1 15.2 13.3 14.2 14.7 14.2 16.1 15.3 13.6 16.6 14.6 15.8 14.6 14.5 15.8 15.5 14.0 15.6 15.3
[2560x1600] cua click flash watch=0 (press->release p50 36.7 ms)
  raw->frame: 12.8 12.3 12.0 12.9 12.1 12.1 11.9 12.7 12.5 17.3 12.1 12.7 12.6 17.9 21.3 12.7 19.9 17.8 21.3 12.2 12.6 21.5 12.8 15.1 16.4 11.9 12.8 12.3 37.2 11.8
  send->raw:  14.4 13.8 12.5 13.8 14.8 10.9 13.6 13.4 13.1 14.0 12.5 12.3 13.6 13.2 13.4 13.5 14.8 13.5 13.1 13.5 12.7 12.9 9.9 13.5 13.0 14.6 12.7 14.8 12.2 12.0
[2560x1600] cua type flash (press->release p50 0.1 ms)
  raw->frame: 13.3 13.4 13.5 18.8 18.7 12.8 12.2 12.8 25.4 14.8 22.0 14.2 19.9 23.6 19.5 16.8 12.6 12.4 21.3 12.7 13.0 14.9 13.4 12.7 21.5 15.1 13.2 14.0 22.7 13.7
  send->raw:  14.5 15.9 13.0 15.4 14.6 14.2 14.0 14.9 13.6 11.2 14.7 16.1 11.0 15.2 14.0 15.4 16.7 14.9 13.7 13.8 13.9 13.7 14.5 11.0 12.5 13.5 13.6 13.8 14.3 11.0
[2560x1600] cua type flash watch=0 (press->release p50 0.1 ms)
  raw->frame: 13.3 14.8 13.8 14.0 18.8 13.4 15.2 17.1 13.7 14.3 20.2 14.0 11.4 12.6 12.1 18.5 13.1 19.9 19.6 17.4 11.8 12.4 12.5 17.4 11.8 15.2 12.7 19.6 18.2 11.9
  send->raw:  13.1 8.2 10.3 10.2 9.3 9.7 10.2 9.2 11.2 10.1 13.3 12.9 10.7 14.1 9.6 10.2 10.4 10.5 11.2 13.3 8.6 11.3 12.1 11.2 11.4 12.1 12.3 13.0 11.1 10.5
[2560x1600] cua type mousepad (press->release p50 0.1 ms)
  raw->frame: 13.3 11.9 18.1 13.1 19.0 14.4 15.3 13.3 14.2 11.1 13.7 13.3 14.1 11.1 15.6 12.2 15.5 19.2 11.8 12.6 16.4 18.9 12.1 13.0 11.0 15.4 14.9 10.8 24.4 18.5
  send->raw:  13.2 12.6 11.0 13.9 11.0 11.4 11.1 14.1 11.8 10.9 13.8 11.2 10.3 13.1 11.1 10.5 11.2 11.8 12.8 11.8 11.7 11.1 10.7 15.1 10.5 10.8 14.1 10.6 9.4 10.0
[2560x1600] cua type mousepad watch=0 (press->release p50 0.1 ms)
  raw->frame: 12.4 18.8 15.6 13.7 17.9 10.4 11.9 12.0 10.9 15.1 13.5 14.0 19.9 19.9 15.4 15.0 19.2 11.2 13.8 11.1 10.8 11.4 14.6 16.2 10.8 13.8 12.4 11.8 16.4 20.6
  send->raw:  24.0 10.4 11.5 10.6 11.3 10.5 13.5 11.4 11.4 12.1 11.6 11.8 11.0 14.9 10.1 10.1 10.4 10.8 12.5 10.2 12.0 10.6 12.8 11.0 10.8 10.9 11.6 11.9 11.0 12.3
[2560x1600] xdo click flash (press->release p50 0.8 ms)
  raw->frame: 28.8 19.0 26.6 22.5 19.1 18.5 25.6 17.3 22.5 19.4 17.7 20.6 24.7 19.9 16.9 25.4 17.5 42.7 43.8 22.3 12.1 18.2 32.9 17.8 23.0 17.9 19.0 18.5 27.9 18.3
  send->raw:  35.3 34.7 35.6 36.4 40.5 34.7 38.4 33.3 37.1 35.9 33.4 40.0 42.2 36.1 43.3 36.6 37.5 35.2 39.4 35.7 36.3 36.2 36.6 41.9 32.6 36.3 34.1 43.9 38.6 33.6
[2560x1600] xdo type flash (press->release p50 5.1 ms)
  raw->frame: 26.3 20.4 18.8 23.7 16.3 14.2 15.0 15.8 20.4 13.9 15.5 14.1 14.0 21.9 13.4 21.8 17.4 15.3 23.8 19.8 16.7 20.2 15.2 22.7 21.2 16.3 16.9 18.6 14.4 23.2
  send->raw:  41.4 34.6 34.7 34.6 38.5 33.7 32.2 42.1 32.7 34.6 37.3 42.6 32.7 33.7 33.9 32.9 35.7 33.4 32.7 31.9 42.1 35.8 32.9 39.6 41.1 32.2 32.7 42.3 35.0 33.8
[2560x1600] xdo type mousepad (press->release p50 4.9 ms)
  raw->frame: 16.1 18.7 10.6 18.2 19.4 20.5 15.6 17.8 13.5 9.6 10.5 11.0 10.7 10.4 10.1 9.7 14.3 19.3 10.6 16.5 14.7 9.8 10.3 10.1 11.3 10.5 17.2 12.6 19.7 20.0
  send->raw:  36.6 36.5 32.1 36.6 33.0 33.7 31.8 33.5 32.9 32.1 32.4 33.2 34.6 31.7 32.9 32.7 31.8 34.8 32.2 36.6 35.0 34.5 32.2 33.7 32.6 33.7 32.3 33.0 34.7 32.5
[1280x800] measure 1x-notap
  raw->frame: 9.0 7.9 8.6 8.3 14.7 9.0 14.3 11.0 9.5 8.9 8.6 8.7 9.0 17.9 9.6 9.4 8.9 14.3 15.9 13.6 8.9 19.1 14.2 9.1 9.5 9.5 14.4 12.8 8.9 9.5 11.8 9.4 9.6 13.1 8.6 15.0 11.9 13.6 17.3 9.1 8.6 15.9 14.3 13.1 9.8 16.1 5.7 12.4 13.2 13.7
  send->raw:  0.9 0.9 1.0 1.1 1.4 1.2 2.1 0.9 1.1 1.3 1.1 1.0 1.3 1.3 1.2 1.0 1.2 0.9 1.3 1.0 1.2 1.2 1.1 1.0 1.0 1.5 1.0 1.3 1.2 1.4 1.1 1.6 1.4 1.7 1.2 1.0 1.4 1.4 1.8 1.7 1.1 1.5 2.1 1.6 1.2 1.7 0.8 1.1 1.0 1.0
[1280x800] measure 1x-tap
  raw->frame: 14.0 9.3 9.7 14.6 13.8 15.4 8.8 16.9 12.8 12.8 9.1 10.2 16.1 9.6 15.7 17.7 8.7 9.1 15.0 9.7 13.7 14.3 11.3 9.1 9.5 9.6 14.0 18.2 9.8 9.9 18.1 9.2 10.3 8.8 9.7 10.3 8.5 9.4 9.2 8.5 14.1 9.7 13.8 15.8 17.5 9.4 9.1 15.2 13.2 9.1
  send->raw:  1.8 1.3 1.4 1.3 1.8 1.9 1.8 1.3 1.6 1.4 1.6 1.5 1.3 1.3 1.5 1.6 1.5 1.5 1.9 1.5 1.9 1.5 1.6 1.4 1.0 1.0 1.0 0.9 1.0 1.1 0.8 1.1 0.8 1.1 1.6 1.0 0.8 1.2 0.9 0.5 1.2 1.0 0.8 1.0 1.4 0.8 1.1 1.4 1.4 1.0
[2560x1600] measure 2x-notap
  raw->frame: 26.0 21.3 13.9 13.0 19.1 13.8 14.3 21.8 18.0 14.6 13.8 20.0 12.6 21.7 14.7 14.6 19.0 14.3 16.4 14.3 15.7 22.5 14.7 19.8 15.9 21.4 16.2 19.2 15.7 21.3 14.5 13.8 20.0 14.7 17.0 16.1 12.6 14.1 18.3 19.9 15.8 13.0 13.0 13.5 12.8 17.9 21.0 16.3 24.0 12.8
  send->raw:  0.6 0.6 0.8 0.6 0.7 0.7 0.7 0.9 0.7 0.7 0.6 0.7 0.6 0.7 0.7 0.6 0.7 0.8 0.8 0.6 0.7 0.7 0.7 0.7 0.6 1.1 0.6 1.3 0.7 0.6 0.6 0.7 0.7 0.8 0.7 0.6 0.5 0.7 0.9 0.8 1.0 1.2 1.1 1.2 1.0 1.2 1.0 0.9 1.0 1.0
[2560x1600] measure 2x-tap
  raw->frame: 25.2 15.5 14.3 20.1 20.8 23.5 23.4 13.8 13.1 22.5 13.2 14.7 13.4 21.7 17.6 19.1 13.3 13.2 19.6 13.1 13.3 20.7 16.2 19.2 16.4 16.3 15.4 21.3 20.0 14.9 21.4 26.9 29.3 16.0 19.7 13.6 21.0 15.2 17.6 16.4 16.4 16.3 22.1 14.6 15.4 15.0 15.4 21.2 21.2 16.0
  send->raw:  2.1 1.1 1.1 0.9 1.3 1.1 1.2 1.1 1.2 1.1 1.1 1.0 1.0 1.1 1.5 1.3 1.1 0.8 0.9 0.7 1.0 1.3 0.9 0.9 0.6 1.4 1.0 0.7 1.3 0.7 1.3 1.7 1.7 0.9 0.6 0.6 1.5 0.8 1.0 1.1 1.0 1.2 1.0 0.8 0.8 0.8 0.9 0.7 1.0 0.9
```
Mousepad diagnostic (1×, xdotool): every frame from 460 ms before a key to 40 ms after it, as ms from the raw key
event:glyph-centre luma (241 empty, 164 glyph). Four consecutive trials; the previous trial's BackSpace lands near
−445:
```
-458.8:164 -441.9:241 -335.7:241 -48.0:241 -32.7:241 -14.0:241 4.9:241 13.0:164 27.6:164
-445.6:241 -358.9:241 -82.2:241 -65.3:241 -47.6:241 -29.0:241 -11.5:241 13.9:164 30.6:241
-456.8:164 -440.1:241 -334.2:241 -52.4:241 -37.3:241 -16.9:241 0.8:241 10.2:164 25.2:241
-452.5:241 -346.1:241 -62.0:241 -47.1:241 -28.4:241 -9.8:241 7.6:164 14.8:164 33.8:241
```
Focus check (2×; window 48234499 is Mousepad, 25165831 is Thunar):
```
before: active=48234499 [Untitled 1 - Mousepad]
  cua (watch default): Clicked at (319.0, 376.0) × 1 (delivery_mode=foreground, path=x11_xtest_fg); not verified — confirm with a screenshot. [window_point=(319, 376) screen_point=(420, 600)]
  after cua click on Thunar: active=25165831 [tmp - Thunar]
  cua (watch 0): (same reply)
  after cua click on Thunar: active=25165831 [tmp - Thunar]
  after xdotool click on Thunar: active=25165831 [tmp - Thunar]
before: active [Untitled 1 - Mousepad]
  cua type_text (watch default): Typed 1 character(s) as real key events (delivery_mode=foreground, focus_after=target); not verified — confirm with a screenshot.
  after: active [tmp - Thunar]
  (watch 0: the same)
```
xdotool alone, timed in the container with `date +%s%N`:
```
click  1: 112047 us
click --delay 0 1: 8179 us
windowactivate --sync on the active window: 49336 us
```
After the runs, `docker rm -fv ld-s6-desktop` removed the desktop, and the proxy and the viewer Chrome were stopped.
`docker ps -a` shows no `ld-*` container, and nothing listens on 4790–4799 or 9222.
