# S6 findings: injection-to-frame latency

2026-09-30 · macOS 26.6.2, Apple M3 Ultra · Docker Desktop engine 29.2.0 (VM: 10 CPUs, 14.6 GB, kernel
6.12.67-linuxkit, `CONFIG_HZ=1000`) · desktop: `localdot-spike-s2` (`sha256:13390a704cdd…`, per Ruling 20): Selkies
2.0.0, pixelflux 2.1.0, Chromium 154.0.8037.57, Mousepad 0.7.0, xdotool 3.20160805.1, Cua Driver 0.30.4, plus xinput
1.6.4 installed at run time · viewer: Chrome 154.0.8037.92, 1300×813 CSS px at DPR 2 on a 144 Hz display · Node 25.6.0

**Result: GO-WITH-CHANGES.** Revised in fix round 1 (Ruling 23). The first version pooled all injectors, swapped early
and late for the ring, headlined a p50 constant, and favoured the driver with an unfair comparison.

- **The brief's lines** (`measure.mjs 50`: the host's write to a persistent `xdotool -`, then the first frame that
  shows the flip, with `tap.js` running):
  - 1×: `n=50/50 p50=11.4ms p95=18.9ms min=9.1ms`
  - 2×: `n=50/50 p50=17.5ms p95=27.3ms min=13.8ms`
  - Target p95 ≤ 80 ms at 1×: **met**. Without `tap.js`: 1× `n=50/50 p50=11.1ms p95=19.1ms min=6.4ms`, 2×
    `n=50/50 p50=16.7ms p95=23.2ms min=13.1ms`.
- **Press → frame depends on the injector and the scale.** Values are p50 / p99 in ms (n):

  | Injector | 1× | 2× |
  |---|---|---|
  | own XTest click, control acts on press | 9.6 / 19.6 (50) | 13.8 / 23.1 (50) |
  | driver click, control acts on press | 5.9 / 18.4 (110) | 14.2 / 26.4 (110) |
  | driver key or type | 8.0 / 17.4 (120) | 14.0 / 24.4 (120) |
  | bare XTest key (`xdotool key`, no activation) | 10.2 / 19.1 (100) | 16.3 / 29.3 (100) |
  | xdotool `--sync` recipe, click | 9.5 / 27.5 (30) | 19.9 / 43.8 (30) |
  | xdotool `--sync` recipe, key or type | 11.3 / 18.3 (60) | 16.1 / 26.3 (60) |

  - On a control that acts on release: own XTest 15.1 / 34.5 (1×) and 20.4 / 43.5 (2×); driver 50.8 / 65.0 (1×) and
    57.0 / 78.0 (2×).
  - Pooling the injectors is not valid. In the first session the driver reached the frame ~3 ms sooner at the median
    than the other injectors, at both scales. In the fix-round session it did only at 1×.
- **Ring onset: use each injector's p99 for C, not the p50.** The ring starts at press + C. It is *early* when it starts
  before the frame that shows the input.
  - **p50 breaks the spec.** It is early for about half of all dispatches, e.g. 54 of 110 driver clicks at 2×, by up
    to 23.0 ms. The spec requires that no effect appears before the frame on which the input lands.
  - **p99 nearly holds.**
    - C is 18.4–19.6 ms at 1× and 23.1–26.4 ms at 2× for own XTest and driver clicks, and 17.4 / 24.4 ms for driver
      keys.
    - At most 1 early ring per group of 50–120, by up to 10.8 ms.
    - For own XTest and the driver on press-acting controls and keys, no ring is more than a frame late. Bare XTest
      keys at 2× had 2 of 100; the xdotool `--sync` recipe's clicks had 16 of 30 (1×) and 25 of 30 (2×).
  - **No constant meets the rule for every target**, because a control that acts on release shows the click later.
    Strict compliance needs the ring to start on the frame that changes at the dispatch point, with C = p99 as the
    timeout.
- **Input path: our own XTest (as S2 proposed), not the driver's click.** Same session, 50 clicks per cell, p50 ms:

  | | own XTest 1× | own XTest 2× | driver 1× (watch 0) | driver 2× (watch 0) |
  |---|---|---|---|---|
  | send → press | 2.0 | 1.8 | 14.3 | 12.8 |
  | send → release | 2.7 | 2.4 | 51.1 | 49.7 |
  | send → frame, control acts on press | 11.7 | 15.6 | 20.5 | 28.6 |
  | send → frame, control acts on release | 17.2 | 21.7 | 65.4 | 68.3 |
  | call returns | 7.7 | 6.5 | 62.9 | 61.0 |

  - **The driver's hold makes the ring early on release.** It holds the button ~37 ms, so a control that acts on
    release shows the click ~37 ms later. With C taken from clicks on press-acting controls, every driver click on a
    release-acting control rang more than a frame early: 50/50 at both scales, by up to 46.6 / 51.6 ms. With own XTest
    that was 10/50 at 1× (by up to 14.9 ms) and 20/50 at 2× (by up to 20.4 ms; 2 of them more than a frame early).
  - **What own XTest costs.**
    - `desktopd` must activate windows and confirm focus itself; the driver's foreground call does that.
    - With its sub-millisecond release, a release-acting control's frame has a longer tail: press → frame p95 is 33.1 /
      39.7 ms against 16.3 / 21.7 on press-acting controls.
    - A 37 ms hold removed that tail (release → frame p95 23.6 vs 31.9 ms at 1×) but added the 37 ms.
  - **Neither path returns an injection timestamp.** `desktopd` takes it from XI2 raw events either way.
- **Frame interval: 16.7 ms at the configured 60 fps.** In continuous typing, 1× ran at 61.4 fps (frame gap p50
  16.3 ms). 2× ran at 52.3 fps (gap p50 16.7 ms, p90 32.4 ms); Mousepad dropped frames under 200 keys/s, while S1's
  continuous scroll held 61 fps at 2×.
- **Changes needed:**
  1. **Own injector.** `desktopd` injects pointer and keys through its own XTest client.
     - It activates windows with `_NET_ACTIVE_WINDOW` and waits for the active-window change as an event. xdotool's
       `--sync` instead polls, costing ~30 ms.
     - It sends press and release without xdotool's 100 ms click delay.
     - The click hold is open: ~1 ms is fastest, and a longer hold avoids Chromium's missed frame on release-acting
       controls. Holds between 1 and 37 ms were not tested.
  2. **Injection timestamp.** `input()` returns the XI2 raw press time from a listener in `desktopd` (as `xilog.py`
     does). The same events can drive `text.progress`.
  3. **Ring onset.** C per injector and scale at the p99: own XTest 19.6 ms at 1× and 23.1 ms at 2× (50 clicks each,
     so that is the sample maximum; re-measure on the target machine). Alternatively, start the ring on the first frame
     that changes at the dispatch point, which is what strict compliance needs.
  4. **Driver.** Keep Cua Driver for trees, windows and screenshots (S2). If its input calls serve as a fallback,
     launch it with `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0`; its default 800 ms post-action watch is why S2's calls
     took ~870 ms.
  5. **Clock mapping.** `desktopd`'s clock and the daemon's differ by about a millisecond and drifted up to 1 ms within
     a 20–45 s run. Map them with a periodic lowest-RTT ping.

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
- **Fastest arrival.** The chunk reached the page as early as 4.3 ms (1×) or 8.8 ms (2×) after the raw event: the
  minimum over all trials.

## Ring onset per injector

**Definitions.**

- L is the frame's arrival minus the raw press, and the ring starts at press + C.
- The ring is **early** when L > C: it starts before the frame that shows the input, by L − C.
- It is **late** when L < C, by C − L. One frame is 16.7 ms.
- All values come from `trials.csv` (every final trial, both sessions) through `node summary.mjs`.
  - `summary.mjs` reads the 2-decimal CSV, so a percentile can differ by 0.1 ms from a run's own printout.
  - With 50 trials, p99 is the sample maximum.

```
1x: press -> frame (ms), and p50 of the other spans
| injector | n | p5 | p25 | p50 | p75 | p95 | p99 | max | send→press | press→release | release→frame |
|---|---|---|---|---|---|---|---|---|---|---|---|
| driver click, mousedown | 110 | 5.1 | 5.4 | 5.9 | 11.6 | 16.1 | 18.4 | 20.5 | 14.9 | 37.0 | -30.5 |
| driver click, mouseup | 50 | 43.2 | 47.3 | 50.8 | 55.2 | 60.4 | 65.0 | 65.0 | 14.9 | 37.2 | 12.8 |
| driver key/type | 120 | 5.2 | 5.8 | 8.0 | 13.4 | 15.4 | 17.4 | 18.5 | 14.6 | 0.1 | 7.9 |
| xdotool --sync click, mousedown | 30 | 6.0 | 8.7 | 9.5 | 15.7 | 21.2 | 27.5 | 27.5 | 35.2 | 0.8 | 8.8 |
| xdotool --sync key/type | 60 | 6.4 | 8.3 | 11.3 | 14.3 | 17.9 | 18.3 | 18.3 | 34.1 | 5.6 | 5.0 |
| own XTest click, mousedown | 50 | 6.0 | 8.5 | 9.6 | 13.5 | 16.3 | 19.6 | 19.6 | 2.0 | 0.7 | 9.0 |
| own XTest click, mouseup | 50 | 8.4 | 9.9 | 15.1 | 19.3 | 33.1 | 34.5 | 34.5 | 2.0 | 0.8 | 14.1 |
| own XTest 37 ms hold click, mouseup | 50 | 46.8 | 50.0 | 53.7 | 56.9 | 65.9 | 71.3 | 71.3 | 2.0 | 40.6 | 12.2 |
| bare key | 100 | 8.6 | 9.1 | 10.2 | 14.3 | 17.7 | 19.1 | 19.1 | 1.2 | 7.8 | 3.0 |

1x: ring onset at press + C. Early = the ring starts before the frame showing the input (L > C); late = after it.
| injector | C | ms | early | max early | > 1 frame early | max late | > 1 frame late |
|---|---|---|---|---|---|---|---|
| driver click, mousedown | p50 | 5.9 | 54/110 | 14.6 | 0 | 0.9 | 0 |
| driver click, mousedown | p95 | 16.1 | 5/110 | 4.3 | 0 | 11.2 | 0 |
| driver click, mousedown | p99 | 18.4 | 1/110 | 2.1 | 0 | 13.4 | 0 |
| driver click, mousedown | max | 20.5 | 0/110 | 0 | 0 | 15.5 | 0 |
| driver click, mouseup | p50 | 50.8 | 24/50 | 14.2 | 0 | 8.5 | 0 |
| driver click, mouseup | p95 | 60.4 | 2/50 | 4.6 | 0 | 18.1 | 3 |
| driver click, mouseup | p99 | 65.0 | 0/50 | 0 | 0 | 22.7 | 16 |
| driver click, mouseup | max | 65.0 | 0/50 | 0 | 0 | 22.7 | 16 |
| driver key/type | p50 | 8.0 | 59/120 | 10.5 | 0 | 3.2 | 0 |
| driver key/type | p95 | 15.4 | 5/120 | 3.1 | 0 | 10.6 | 0 |
| driver key/type | p99 | 17.4 | 1/120 | 1.1 | 0 | 12.6 | 0 |
| driver key/type | max | 18.5 | 0/120 | 0 | 0 | 13.7 | 0 |
| xdotool --sync click, mousedown | p50 | 9.5 | 14/30 | 18.0 | 1 | 3.9 | 0 |
| xdotool --sync click, mousedown | p95 | 21.2 | 1/30 | 6.3 | 0 | 15.6 | 0 |
| xdotool --sync click, mousedown | p99 | 27.5 | 0/30 | 0 | 0 | 21.9 | 16 |
| xdotool --sync click, mousedown | max | 27.5 | 0/30 | 0 | 0 | 21.9 | 16 |
| xdotool --sync key/type | p50 | 11.3 | 29/60 | 7.0 | 0 | 6.4 | 0 |
| xdotool --sync key/type | p95 | 17.9 | 2/60 | 0.5 | 0 | 12.9 | 0 |
| xdotool --sync key/type | p99 | 18.3 | 0/60 | 0 | 0 | 13.4 | 0 |
| xdotool --sync key/type | max | 18.3 | 0/60 | 0 | 0 | 13.4 | 0 |
| own XTest click, mousedown | p50 | 9.6 | 24/50 | 10.0 | 0 | 4.3 | 0 |
| own XTest click, mousedown | p95 | 16.3 | 2/50 | 3.3 | 0 | 10.9 | 0 |
| own XTest click, mousedown | p99 | 19.6 | 0/50 | 0 | 0 | 14.3 | 0 |
| own XTest click, mousedown | max | 19.6 | 0/50 | 0 | 0 | 14.3 | 0 |
| own XTest click, mouseup | p50 | 15.1 | 24/50 | 19.4 | 3 | 6.6 | 0 |
| own XTest click, mouseup | p95 | 33.1 | 2/50 | 1.4 | 0 | 24.7 | 32 |
| own XTest click, mouseup | p99 | 34.5 | 0/50 | 0 | 0 | 26.0 | 36 |
| own XTest click, mouseup | max | 34.5 | 0/50 | 0 | 0 | 26.0 | 36 |
| own XTest 37 ms hold click, mouseup | p50 | 53.7 | 24/50 | 17.6 | 1 | 10.1 | 0 |
| own XTest 37 ms hold click, mouseup | p95 | 65.9 | 2/50 | 5.5 | 0 | 22.2 | 8 |
| own XTest 37 ms hold click, mouseup | p99 | 71.3 | 0/50 | 0 | 0 | 27.7 | 27 |
| own XTest 37 ms hold click, mouseup | max | 71.3 | 0/50 | 0 | 0 | 27.7 | 27 |
| bare key | p50 | 10.2 | 49/100 | 8.9 | 0 | 4.5 | 0 |
| bare key | p95 | 17.7 | 4/100 | 1.4 | 0 | 12.1 | 0 |
| bare key | p99 | 19.1 | 0/100 | 0 | 0 | 13.5 | 0 |
| bare key | max | 19.1 | 0/100 | 0 | 0 | 13.5 | 0 |

1x: a click on a control that acts on release, with C from the same injector's mousedown p99
| injector | C | early | max early | > 1 frame early | max late |
|---|---|---|---|---|---|
| driver click, mouseup | 18.4 | 50/50 | 46.6 | 50 | 0.0 |
| own XTest click, mouseup | 19.6 | 10/50 | 14.9 | 0 | 11.2 |

2x: press -> frame (ms), and p50 of the other spans
| injector | n | p5 | p25 | p50 | p75 | p95 | p99 | max | send→press | press→release | release→frame |
|---|---|---|---|---|---|---|---|---|---|---|---|
| driver click, mousedown | 110 | 12.0 | 12.7 | 14.2 | 19.8 | 23.8 | 26.4 | 37.2 | 13.4 | 36.8 | -22.9 |
| driver click, mouseup | 50 | 48.6 | 53.3 | 57.0 | 59.9 | 62.9 | 78.0 | 78.0 | 11.2 | 37.1 | 18.6 |
| driver key/type | 120 | 11.1 | 12.6 | 14.0 | 17.4 | 21.5 | 24.4 | 25.4 | 11.6 | 0.1 | 13.9 |
| xdotool --sync click, mousedown | 30 | 16.9 | 18.2 | 19.9 | 25.4 | 42.7 | 43.8 | 43.8 | 36.3 | 0.8 | 19.2 |
| xdotool --sync key/type | 60 | 10.1 | 13.4 | 16.1 | 19.8 | 23.7 | 26.3 | 26.3 | 33.7 | 4.9 | 10.8 |
| own XTest click, mousedown | 50 | 12.0 | 12.4 | 13.8 | 18.8 | 21.7 | 23.1 | 23.1 | 1.8 | 0.7 | 13.3 |
| own XTest click, mouseup | 50 | 12.5 | 14.7 | 20.4 | 29.4 | 39.7 | 43.5 | 43.5 | 1.4 | 0.7 | 19.6 |
| bare key | 100 | 13.0 | 14.3 | 16.3 | 20.1 | 24.0 | 29.3 | 29.3 | 0.9 | 7.3 | 9.1 |

2x: ring onset at press + C. Early = the ring starts before the frame showing the input (L > C); late = after it.
| injector | C | ms | early | max early | > 1 frame early | max late | > 1 frame late |
|---|---|---|---|---|---|---|---|
| driver click, mousedown | p50 | 14.2 | 54/110 | 23.0 | 1 | 2.4 | 0 |
| driver click, mousedown | p95 | 23.8 | 5/110 | 13.4 | 0 | 11.9 | 0 |
| driver click, mousedown | p99 | 26.4 | 1/110 | 10.8 | 0 | 14.5 | 0 |
| driver click, mousedown | max | 37.2 | 0/110 | 0 | 0 | 25.4 | 86 |
| driver click, mouseup | p50 | 57.0 | 24/50 | 21.0 | 1 | 9.0 | 0 |
| driver click, mouseup | p95 | 62.9 | 2/50 | 15.1 | 0 | 14.9 | 0 |
| driver click, mouseup | p99 | 78.0 | 0/50 | 0 | 0 | 29.9 | 43 |
| driver click, mouseup | max | 78.0 | 0/50 | 0 | 0 | 29.9 | 43 |
| driver key/type | p50 | 14.0 | 58/120 | 11.4 | 0 | 3.6 | 0 |
| driver key/type | p95 | 21.5 | 5/120 | 3.9 | 0 | 11.1 | 0 |
| driver key/type | p99 | 24.4 | 1/120 | 1.0 | 0 | 14.0 | 0 |
| driver key/type | max | 25.4 | 0/120 | 0 | 0 | 15.0 | 0 |
| xdotool --sync click, mousedown | p50 | 19.9 | 14/30 | 23.9 | 2 | 7.8 | 0 |
| xdotool --sync click, mousedown | p95 | 42.7 | 1/30 | 1.1 | 0 | 30.6 | 24 |
| xdotool --sync click, mousedown | p99 | 43.8 | 0/30 | 0 | 0 | 31.7 | 25 |
| xdotool --sync click, mousedown | max | 43.8 | 0/30 | 0 | 0 | 31.7 | 25 |
| xdotool --sync key/type | p50 | 16.1 | 29/60 | 10.2 | 0 | 6.5 | 0 |
| xdotool --sync key/type | p95 | 23.7 | 2/60 | 2.6 | 0 | 14.1 | 0 |
| xdotool --sync key/type | p99 | 26.3 | 0/60 | 0 | 0 | 16.7 | 1 |
| xdotool --sync key/type | max | 26.3 | 0/60 | 0 | 0 | 16.7 | 1 |
| own XTest click, mousedown | p50 | 13.8 | 24/50 | 9.3 | 0 | 2.0 | 0 |
| own XTest click, mousedown | p95 | 21.7 | 2/50 | 1.5 | 0 | 9.8 | 0 |
| own XTest click, mousedown | p99 | 23.1 | 0/50 | 0 | 0 | 11.3 | 0 |
| own XTest click, mousedown | max | 23.1 | 0/50 | 0 | 0 | 11.3 | 0 |
| own XTest click, mouseup | p50 | 20.4 | 24/50 | 23.1 | 5 | 8.2 | 0 |
| own XTest click, mouseup | p95 | 39.7 | 2/50 | 3.8 | 0 | 27.5 | 30 |
| own XTest click, mouseup | p99 | 43.5 | 0/50 | 0 | 0 | 31.3 | 34 |
| own XTest click, mouseup | max | 43.5 | 0/50 | 0 | 0 | 31.3 | 34 |
| bare key | p50 | 16.3 | 48/100 | 13.1 | 0 | 3.7 | 0 |
| bare key | p95 | 24.0 | 4/100 | 5.4 | 0 | 11.4 | 0 |
| bare key | p99 | 29.3 | 0/100 | 0 | 0 | 16.7 | 2 |
| bare key | max | 29.3 | 0/100 | 0 | 0 | 16.7 | 2 |

2x: a click on a control that acts on release, with C from the same injector's mousedown p99
| injector | C | early | max early | > 1 frame early | max late |
|---|---|---|---|---|---|
| driver click, mouseup | 26.4 | 50/50 | 51.6 | 50 | 0.0 |
| own XTest click, mouseup | 23.1 | 20/50 | 20.4 | 2 | 10.9 |
```

- **What the first version got wrong.** It pooled every injector and read the sign backwards. For that pooled data
  with C = p50, rings were early in 184/370 (1×) and 183/370 (2×) trials, by up to 18.0 / 28.4 ms, and late by at most
  4.7 / 5.8 ms. The first version said the reverse.
- **Field calibration needs a content check.** On a still screen, the first frame after an injection was its effect in
  all 1010 flash-page trials of both sessions. It was not in 96 of 180 Mousepad trials, because the stream sends extra
  frames after every change (see "Frame interval and the stream's own frames"). A calibrator, or a ring that
  waits for its frame, must check that the frame changed where the input landed.

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

First session, 30 trials per path. 1× (1280×800):

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

- **Raw → frame also depends on the injector, by a few ms.** In this session the driver's p50 was about 3 ms lower
  than xdotool's or the bare keys' at both scales (a permutation test in review gave p < 0.0001). In the same-session
  comparison below it was 4 ms lower at 1× and 2 ms higher at 2× than a bare XTest click. The cause was not isolated.
  The xdotool click tail at 2× (42.7 and 43.8 ms) was the worst; the driver's clicks peaked at 26.3 and 37.2 ms.
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

### Fair comparison (fix round 1)

**Method.**

- **Why.** The first session compared the driver with an xdotool recipe that loses ~30 ms to xdotool's own `--sync`
  poll. Its flash page also acted on press only, which hides the driver's ~37 ms hold.
- **Paths.**
  - Own XTest: `windowactivate <wid>` without `--sync`, then `mousemove X Y click --delay 0 1`, as one chain.
  - Driver: the foreground `click` with watch 0; the watch does not change injection.
- **Pages.** Both paths ran against the flash page twice:
  - as before (flips on `mousedown`);
  - as `flash.html#up` (flips on `mouseup`, titled "flash up", opened with `setup.sh up`).
- **Session.** 50 clicks per cell, at 2× and then at 1×, in a fresh viewer session.

Values are p50 / p95 in ms. "press → frame" is L for the onset tables.

| Scale, page | Path | send → press | send → release | press → frame | release → frame | send → frame | returns |
|---|---|---|---|---|---|---|---|
| 2×, mousedown | own XTest | 1.8 / 2.2 | 2.4 / 3.6 | 13.8 / 21.7 | 13.3 / 21.0 | 15.6 / 23.6 | 6.5 / 7.8 |
| 2×, mousedown | driver | 12.8 / 14.6 | 49.7 / 58.1 | 15.6 / 22.3 | −21.7 / −14.3 | 28.6 / 35.5 | 61.0 / 69.4 |
| 2×, mouseup | own XTest | 1.4 / 1.8 | 2.0 / 2.5 | 20.4 / 39.7 | 19.6 / 39.0 | 21.7 / 41.1 | 6.2 / 7.1 |
| 2×, mouseup | driver | 11.2 / 13.2 | 48.6 / 55.6 | 57.0 / 62.9 | 18.6 / 26.3 | 68.3 / 75.5 | 61.0 / 68.9 |
| 1×, mousedown | own XTest | 2.0 / 3.0 | 2.7 / 4.1 | 9.6 / 16.3 | 9.0 / 15.7 | 11.7 / 19.0 | 7.7 / 8.4 |
| 1×, mousedown | driver | 14.3 / 15.5 | 51.1 / 57.9 | 5.6 / 15.6 | −30.7 / −21.6 | 20.5 / 29.4 | 62.9 / 69.9 |
| 1×, mouseup | own XTest | 2.1 / 2.9 | 2.8 / 3.7 | 15.0 / 33.1 | 14.1 / 31.9 | 17.2 / 34.5 | 7.4 / 8.5 |
| 1×, mouseup | driver | 14.9 / 16.3 | 52.3 / 58.8 | 50.8 / 60.4 | 12.9 / 22.5 | 65.4 / 75.4 | 64.6 / 71.6 |
| 1×, mouseup | own XTest, 37 ms hold | 2.0 / 2.9 | 42.9 / 50.4 | 53.7 / 65.9 | 12.2 / 23.6 | 56.0 / 67.7 | 47.5 / 55.1 |

- **Own XTest presses 11–13 ms and releases ~48 ms sooner than the driver.** End to end it is faster at both scales on
  both pages: send → frame p50 is 9–13 ms lower on the mousedown page and 47–48 ms lower on the mouseup page.
- **Press → frame on the mousedown page: no consistent winner.** The driver was faster at 1× (5.6 vs 9.6 ms) and
  slower at 2× (15.6 vs 13.8 ms). The first session's driver advantage therefore did not hold against an injector
  without `--sync`.
- **The mouseup page shows the hold.**
  - The driver's frame waits for its release: press → frame is 50.8 / 57.0 ms, while release → frame is 12.9 / 18.6
    ms.
  - Own XTest releases ~0.7 ms after the press, and its frame then has a longer tail: press → frame p95 is 33.1 / 39.7
    ms, against 16.3 / 21.7 on the mousedown page.
  - The exploratory 37 ms hold (1×, `LD_HOLD_MS=37`) brought own XTest's release → frame to 12.2 / 23.6 ms, the
    driver's level (12.9 / 22.5). So the extra tail comes from the sub-millisecond release, not from the injector.
- **Clock checks this session.** The viewer's `ldClockSkew()` read +0.03 to +0.06 ms at the start of the 2× session
  and −0.13 to −0.15 at its end; −0.07 to −0.10 at the start of 1× and −0.26 to −0.27 at its end. The host's read
  −0.03 to +0.02 ms throughout. Each flip carries the viewer's value from detector start (`viewer_skew` in
  `trials.csv`).

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
  - They never fell between a flash-page input and its flip: in all 1010 flash-page trials of both sessions the flip
    was the first frame after the raw press. In Mousepad each trial ends with a BackSpace whose frame lands ~445 ms before the next key, and
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
  - `setup.sh up` reopens the page as `flash.html#up`.
  - In the first 1× session the same steps were run by hand, before the script existed.
- **Viewer.** A separate Chrome with its own profile on 127.0.0.1:9222, driven by the DevTools MCP.
  - It ran with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
    --disable-background-timer-throttling`, so an occluded window could not throttle it. The page read `visible` at
    every check.
  - It loaded `http://127.0.0.1:4792` through S1's `proxy.mjs`.
  - The brief's tap runs evaluated `tap.js`, then `detector.js`; every other run used the detector alone.
- **Frames (Ruling 20).** `detector.js` reads a `MediaStreamTrackProcessor` on a clone of `#videoStream`'s track.
  - **Sampling.** For each `VideoFrame` (I444 here) it `copyTo`s one rect of the luma plane and averages it: on the
    flash page 32×32 at the centre (0 black, 255 white); in Mousepad the middle half of the typed glyph's cell (241
    empty, 164 with the glyph).
  - **Flip.** The mean crossing `threshold` is a flip, which is POSTed to `collector.mjs` on 127.0.0.1:4795.
  - **"frame":** `performance.timeOrigin + performance.now()` when the reader returns the frame.
  - **"chunk on the page":** `timeOrigin + VideoFrame.timestamp / 1000`. Selkies' client code stamps each chunk with
    `performance.now() * 1e3` when it arrives, before its worker decodes it.
  - **Expected display:** `requestVideoFrameCallback`'s `expectedDisplayTime`, matched through `mediaTime` = timestamp.
- **Clock skew.** `ldClockSkew()` (page) and `inputs.mjs` (host) compare the `performance.now()` wall clock with
  `Date.now()` at each `Date.now()` tick edge for 20 ms. Values are under "Fair comparison".
  - The first session used a 2000-read average instead. That fits in well under a millisecond, so it only bounded the
    skew to ±0.5 ms; the round-0 claim "within 0.1 ms" was not supported.
- **Raw events.** `xilog.py` runs in the desktop as `abc`. It reads `stdbuf -oL xinput test-xi2 --root` and stamps
  each raw event with `CLOCK_REALTIME` and `CLOCK_MONOTONIC`.
  - The X server's own event time (whole ms on the monotonic clock; the kernel's coarse clock ticks at 1 ms here) was
    0.7–2.3 ms earlier than the logger's stamp.
  - So raw-event times are up to ~2 ms late: press → frame reads up to ~2 ms low, and send → press up to ~2 ms high.
  - A `desktopd` listener built this way has the same bias, so the onsets hold for it.
- **Clocks.** `xi.mjs` maps container time to the host clock. Before and after each run it sends 40 pings over the
  logger's `docker exec` pipe and uses the one with the lowest RTT.
  - Minimum RTT was 0.55–1.17 ms, and the offset (container − host) was −1.49 to −0.32 ms.
  - The offset moved by up to 1 ms within a run, so the send / press / frame split carries about ±1 ms.
  - send → frame and all page-side spans use the host clock only.
- **Matching.** Each trial owns the window from its send to the next send. Its press is the first raw press of the
  expected kind in that window. Its release is the next raw release with the same detail. Its frame is the first flip
  in the window. None was missed.
- **Pacing.** 400 ms between sends plus 0–16.7 ms of random jitter. On its own, 400 ms is exactly 24 frames at 60 Hz,
  which could keep every send at the same capture phase. Each run starts with one untimed input, because a still
  screen gives the detector no baseline.
- **Paths.** `inputs.mjs` alternates the click point between the window centre ± width/32, so the pointer always moves.
  In Mousepad it sends an untimed BackSpace after each glyph.
- **Typing target.** `mousepad.sh` closes the kiosk, turns caret blink off (`/Net/CursorBlink`), sets Mousepad to
  DejaVu Sans Mono 72 and opens it. It derives the region from a before/after screenshot diff of one typed `x`, and all
  180 matched frames showed the glyph (luma 164–165).
- **Tables.** `node summary.mjs export out/*.json > trials.csv` writes one row per final trial: 1190 rows. The dry run,
  the 3-trial checks and the diagnostic stay in the git-ignored `out/checks/`. `node summary.mjs` prints every table
  above from `trials.csv`.
- **Telemetry.** Every driver launch carried `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` and `CUA_DRIVER_RS_UPDATE_CHECK=0` with
  `mcp --no-overlay`. The binary was also read with `strings`, which does not run it.

## Files and changes from the brief

- `flash.html`: the brief's page plus a click toggle. `mousedown` flips it, or `mouseup` for `flash.html#up`, which is
  also titled "flash up".
- `collector.mjs`: the brief's, but it keeps each whole payload instead of only `at`.
- `detector.js`: replaced per Ruling 20; it no longer calls `readPixels` on `#ld-tap`.
  - Optional `extra` regions were added for the Mousepad diagnostic.
  - `skew` was added to each flip in fix round 1.
  - The flip logic is unchanged.
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
  - `setup.sh`: Step 1; `setup.sh up` opens the mouseup page.
  - `xilog.py` and `xi.mjs`: raw events and clock mapping.
  - `inputs.mjs`: the Ruling 19 comparison, with release times, the `xtest` path, `LD_HOLD_MS` and the host's clock
    skew.
  - `mousepad.sh`: the typing target.
  - `summary.mjs`: export, per-injector latency and the onset tables.
  - `trials.csv`: every final trial.
- The brief's `docker rm -f ld-s1-desktop` became `docker rm -fv ld-s6-desktop`.

## Not covered

- **Target hardware.** The spec targets M1-class laptops; this host is an M3 Ultra. At 2× encoding dominates the
  constant.
- **A busy screen** (video, animation), where an input's frame competes with other damage.
- **Other apps.** Only Chromium and Mousepad were measured; Calc was not used.
- **Other input.** Scroll, drag, double click, and the cadence of multi-character typing.
- **Own XTest's focus handling.** Activation without `--sync` was only exercised on an already-active window. Clicking
  a background window activated it through the window manager (see "Focus"); typing into one was not tested without
  the driver.
- **Click holds between 1 and 37 ms.**
- **Why the driver's press → frame was shorter at 1× and in the first session.**
- **The daemon's own chunk stamps.** The page's receive stamp stood in for them; the proxy hop is loopback.

## Raw

`measure.mjs` result lines:
```
1x tap:    n=50/50 p50=11.4ms p95=18.9ms min=9.1ms
1x no tap: n=50/50 p50=11.1ms p95=19.1ms min=6.4ms
2x tap:    n=50/50 p50=17.5ms p95=27.3ms min=13.8ms
2x no tap: n=50/50 p50=16.7ms p95=23.2ms min=13.1ms
```
Per-trial values for all 1190 final trials are in `trials.csv`: send → press, send → release, press → frame, release
→ frame, press → chunk, send → return, and both clock skews. The first version listed the first session's raw → frame
and send → raw here; `trials.csv` holds the same values to two decimals.

Fix-round runs, `inputs.mjs` output lines. The driver runs had `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0`.
```
2x mousedown, xtest: send->raw p50=1.8 p95=2.2 | send->release 2.4/3.6 | raw->frame 13.8/21.7 (11.8-23.2) | release->frame 13.3/21.0 | send->frame 15.6/23.6 | send->return 6.5/7.8
2x mousedown, cua:   send->raw 12.8/14.6 | send->release 49.7/58.1 | raw->frame 15.6/22.3 (11.9-25.8) | release->frame -21.7/-14.3 | send->frame 28.6/35.5 | send->return 61.0/69.4
2x mouseup, xtest:   send->raw 1.4/1.8 | send->release 2.0/2.5 | raw->frame 20.4/39.7 (12.2-43.5) | release->frame 19.6/39.0 | send->frame 21.7/41.1 | send->return 6.2/7.1
2x mouseup, cua:     send->raw 11.2/13.2 | send->release 48.6/55.6 | raw->frame 57.0/62.9 (48.1-78.0) | release->frame 18.6/26.3 | send->frame 68.3/75.5 | send->return 61.0/68.9
1x mousedown, xtest: send->raw 2.0/3.0 | send->release 2.7/4.1 | raw->frame 9.6/16.3 (5.3-19.6) | release->frame 9.0/15.7 | send->frame 11.7/19.0 | send->return 7.7/8.4
1x mousedown, cua:   send->raw 14.3/15.5 | send->release 51.1/57.9 | raw->frame 5.6/15.6 (5.0-16.6) | release->frame -30.7/-21.6 | send->frame 20.5/29.4 | send->return 62.9/69.9
1x mouseup, xtest:   send->raw 2.1/2.9 | send->release 2.8/3.7 | raw->frame 15.0/33.1 (8.4-34.5) | release->frame 14.1/31.9 | send->frame 17.2/34.5 | send->return 7.4/8.5
1x mouseup, cua:     send->raw 14.9/16.3 | send->release 52.3/58.8 | raw->frame 50.8/60.4 (42.3-65.0) | release->frame 12.9/22.5 | send->frame 65.4/75.4 | send->return 64.6/71.6
1x mouseup, xtest, LD_HOLD_MS=37: send->raw 2.0/2.9 | send->release 42.9/50.4 | raw->frame 53.7/65.9 (43.6-71.3) | release->frame 12.2/23.6 | send->frame 56.0/67.7 | send->return 47.5/55.1
viewer ldClockSkew(): 2x start 0.060 0.045 0.025, 2x end -0.125 -0.145 -0.145, 1x start -0.095 -0.070 -0.085, 1x end -0.260 -0.260 -0.270 ms
host skew per run (start -> end): 0.00..0.02 -> -0.03..-0.02 ms
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
