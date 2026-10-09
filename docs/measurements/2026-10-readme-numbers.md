# The README's numbers — October 9, 2026

Every number in the README's charts and tables, with how it was measured. All runs were on a
Mac Studio (Apple M3 Ultra) with sample data. Treat them as the direction of a change on one
machine, not as a promise for yours.

## Fewer screenshots (oracle eval)

The oracle suite runs scripted desktop tasks against a real desktop cell at scale 2 and counts
what reaches the model. Turns are model answers in the brain transcript, calls are tool calls,
screenshots are full frames sent to the model, inputs are dispatched gateway inputs. "Before" is
an image built from the commit before batched actions and element references; "after" includes
them.

| Task | Turns | Calls | Screenshots before | Screenshots after |
| --- | --- | --- | --- | --- |
| calc-fill | 5 | 6 | 6 | 5 |
| files-drag-drop | 2 | 2 | 2 | 2 |
| files-multi-select | 7 | 7 | 7 | 7 |
| gimp-draw-shape | 9 | 52 | 52 | 8 |
| gimp-pick-colour | 10 | 12 | 12 | 10 |
| text-keyboard | 10 | 14 | 14 | 10 |
| web-form | 8 | 14 | 14 | 8 |
| **Total** | **51** | **107** | **107** | **50** |

Turns and calls are the same before and after; only the pictures changed. A stroke's calls in
one turn now return one screenshot, and a result frame identical to the one the model already
has is not sent again. With the new tools, the same web form takes 3 turns and 3 calls
(`web-form-batch`) instead of 8 turns and 14 calls. All ten tasks in the final run passed with
no approvals and no hand-offs.

## Exporting a recording

A 2-minute range (0:45–2:45) of a 2560×1600 H.264 fixture recording, captions and pointer on,
skip idle off, in Chrome with ANGLE Metal and VideoToolbox H.264.

| Export | Frames | Time | File |
| --- | --- | --- | --- |
| Old exporter, 1080p 30 fps | 3600 | 25.7 s | 7.5 MB |
| Old exporter, 720p 30 fps | 3600 | 20.8 s | 2.8 MB |
| Quality: 2560×1600, 60 fps, high | 7200 | 5.9 s | 13.1 MB |
| Fast: 1280×800, 15 fps, low | 1800 | 1.4 s | 1.7 MB |
| Quality at 3× (40 s video) | 2400 | 2.3 s | 8.8 MB |
| Fast at 3× (40 s video) | 600 | 0.7 s | 0.7 MB |

Each distinct picture is rendered and encoded once, with its duration, so Quality's 7200 output
frames needed 1408 encodes. Exports made on the host (a headless system Chrome the daemon
drives, so closing the page doesn't stop them) took 6.7–6.8 s for Quality and 2.3 s for Fast on
another seed, including launching the browser; their decoded frames matched the in-page export
exactly.

## The live picture

A real desktop cell streamed a scrolling 2560×1600 page through the real relay to desktop
Chrome, behind a throttling proxy at 5 Mbps and 80 ms round trip. "Key press to screen" is the
time from a key sent to the desktop until the change shows on the stage, while the page scrolls.

| Measure | Fixed quality (before) | Adaptive quality (after) |
| --- | --- | --- |
| New (decoded) frames per second | 10.9 | 57.3 |
| Frames on the stage per second | 38.8 | 62.7 |
| Key press to screen, median | 1371 ms | 116 ms |
| Key presses over 2 s | 9 of 10 | 0 |
| Bit rate | 5.22 Mbps (saturated) | 3.74 Mbps |

On a slow link the adaptive controller raises compression (CRF 25 to 41 here, in 14 s) instead
of dropping frames, since fewer frames of a moving screen cost as many bits or more. After a
page reload, the first new frame reached the stage in 214 ms in Chrome and 209 ms in WebKit.
