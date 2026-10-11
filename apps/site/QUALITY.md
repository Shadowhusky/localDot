# Website verification — 11 October 2026

## Verified locally

`pnpm --dir apps/site check:browser` exercises the actual page in Chromium at 1440×900,
768×1024, 390×844, 320×640 and 844×390. It checks every chapter for horizontal overflow and
clipped controls, all replay selections, greeting, fullscreen entry/exit and JavaScript errors.
It also checks reduced motion, unavailable WebGL and JavaScript disabled. A WebKit touch/mobile
run verifies the greeting and captures the portrait layout. Axe WCAG 2 A/AA reported no violations.
Screenshots and JSON evidence are generated into ignored `qa/`; this is not a claim of complete
accessibility compliance or a substitute for testing a physical phone.

## Measured rendering budget

The capabilities scene measured 29 draw calls, 8,782 triangles, 2 textures and 13 geometries.
The final local automated run measured a median frame interval of 16.7 ms and p95 of 16.8 ms at
DPR 1. Earlier runs during concurrent Docker builds reached 33–66 ms p95. These are desktop
browser measurements, not a promise of 60 fps on phones. GPU timing and thermal behavior on
physical mobile hardware have not been measured.

DPR is capped at 1.5 on desktop and 1.25 on smaller layouts. One renderer shares materials and
geometry, with no shadow maps or postprocessing. Video pauses outside the first chapter or
when the tab is hidden. Reduced motion, user-paused motion and short landscape layouts avoid
the 3D world. A missing renderer leaves readable text and the mascot still. No external fonts
or analytics are loaded.

## Release checks

Build and Worker TypeScript checks pass. The deploy dry run validates the asset binding and
canonical domain configuration. Public install commands point at the signed packaged channel,
independent of access to the private source repository. Demos use actual agent recordings with invented task data and public sources.

Physical iPhone/Android graphics performance, screen-reader exploration and fresh native
Windows installation remain outside the verified coverage. The Windows installer is available
for alpha testing; its Linux package is tested separately in an isolated Ubuntu environment.

The public host initially returned complete MP4 responses for byte-range requests. The Worker now
adds bounded range handling only for the six owned demo clips (maximum 4 MiB). Prefix, suffix,
open-ended, invalid/unsatisfiable and If-Range cases are checked by `check-video-ranges.mjs`.

## Actual-task demos

Website demos now come from three completed agent runs on a separate demo computer, with
invented spreadsheet data, public research pages and a sample drawing. The capture pipeline
records the actual app replay at 1440×900 and 390×500; it trims selected excerpts and plays
them at a disclosed 2× speed. The old still-image stream is not used.

`node apps/site/scripts/check-demo-motion.mjs` checks visible pixel changes within the
computer-screen region of each encoded video, so animated outer controls alone cannot pass.
Raw recordings, excerpt timestamps, screen bounds and provenance receipts stay in ignored
`qa/`. The published output contains only reviewed MP4s and their posters.

All six encoded videos passed the screen-motion check. First, middle and final frames were
reviewed, and the responsive/browser checks above passed again with the real-task demos.
Desktop and mobile use the same excerpts with idle skipping disabled before recording.
