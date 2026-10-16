# Browser environment and recovery

localDot runs a visible Chromium browser in a separate container with a persistent account
profile. The desktop's development browser has a disposable per-task profile. Neither profile
should be cleared to repair graphics or a lost control connection.

## Graphics

The shipped Xvfb containers have no GPU device. Both browser launchers select ANGLE's OpenGL
backend with Mesa software rendering (`LIBGL_ALWAYS_SOFTWARE=1`, `--use-gl=angle`,
`--use-angle=gl`, `--ignore-gpu-blocklist`). This provides WebGL 1 and 2 on the CPU; it is not
hardware GPU acceleration. Chromium's GPU sandbox, site isolation, proxy and certificate checks
remain enabled. No `--no-sandbox`, `--disable-gpu-sandbox` or unsafe SwiftShader fallback is used.

[Chromium documents the removal of automatic software WebGL fallback](https://github.com/chromium/chromium/blob/main/docs/gpu/swiftshader.md).
Checking that Mesa is installed is insufficient: the Docker browser test creates both context
versions, renders a green pixel and reads it back through the production sandbox.

Electron applications manage their own Chromium switches. These launcher settings apply to
localDot's managed browsers, not every third-party Electron app installed by a task.

## Sign-in popups and frame replacement

A background tab fails native geometry admission with HTTP 409 (`refused`). That is a tab
selection result, not evidence that the browser crashed. Read-only foreground discovery checks
the other tabs and waits within a six-second deadline for attaching or navigating tabs. It never
activates a background tab or replays a click. An input lease stays bound to its original tab;
only fresh observations can follow the visible popup. User takeover and Stop cancel discovery.

When a target closes, browserd retires that target's pending requests before aborting its reload
or chooser. Late events from recently retired sessions are dropped. New/foreign session IDs,
malformed replies and uncertain writes to live targets still retain their existing containment.
This prevents ordinary iframe and popup teardown from closing every other tab. Existing browser
health recovery remains responsible for an actual stopped browser process, preserving its profile.

Stopping a pointer glide drains the single already-dispatched native motion before releasing a
held drag. It does not send another motion or replay input. The native command timeout remains
in force; an unacknowledged operation still retires the controller rather than guessing its state.
This avoids treating an ordinary Stop between a motion and its acknowledgement as a browser crash.

## Verification pages

Keep JavaScript, cookies and working graphics available, and let an ordinary challenge finish
loading. Do not equate a transient frame replacement with a disconnected browser. The integration
suite uses synthetic cross-origin frames and sign-in popups; it does not solve real CAPTCHAs or
prove a particular site's challenge will accept an automated browser.

[Cloudflare lists network, browser configuration and bot detection as distinct causes of loops](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/).
If a site still requests verification, retain its page and report that observed state rather than
restarting repeatedly, clearing cookies or claiming a memory crash without evidence.

## Terminal input

Native terminal text uses zero artificial per-character delay and batched progress updates. The
decision uses the observed desktop application class, not a model-supplied label or a web page's
title. Delivery remains native and cancellable, with the same authorization and focus checks.
Ordinary fields and masked input retain their existing pace. This does not use the shared clipboard.

## Regression checks

- Browser unit suites cover popup selection, held control, stale input, target retirement and
  pending initialization/reload replies.
- `browserd-drag.docker.test.ts` exercises WebGL pixels, cross-origin frame replacement, popup
  reads and the actual HTTP refusal classification alongside native input and private sign-in flows.
- `cells/desktop/tests/test_desktop_profiles.py` verifies launch flags and profile preservation.
- Run `pnpm check:codex-release` before activating changed daemon code.
