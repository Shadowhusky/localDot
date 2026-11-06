# Browser environment and recovery

localDot runs a visible browser in a separate container with a persistent account profile: Chromium
from the release image, or Google Chrome once the user has chosen it (see "Google Chrome" below). The
desktop's development browser has a disposable per-task profile. Neither profile should be cleared
to repair graphics or a lost control connection. Below, "Chromium" also covers Chrome unless a section
tells them apart: they run with the same flags and the same supervision.

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
This prevents ordinary iframe and popup teardown from closing every other tab. Browser recovery
below handles crashed renderers and a stopped browser process, preserving the profile.

## Crash and hang recovery

A renderer crash revokes only its tab's documents and reloads that tab (three times a minute at
most); the rest of the browser keeps running. browserd supervises Chromium itself: a process exit,
a lost CDP pipe, a control request that times out, or two missed liveness checks (a harmless window
read every five seconds) retire the failed browser's authority, wait until its whole process group
has exited, clear stale `Singleton*` profile locks and start Chromium again on the same profile,
blank, keeping the display, stream, gate and keyd listener. It does so at most three times in five
minutes; then it fences everything as before and the daemon replaces the browser cell. While it
restarts, its HTTP service answers 503 with `Retry-After` and `GET /supervisor` reports
`restarting`, so the daemon waits instead of recreating the cell. `GET /supervisor` also names the
last failure (kind, exit status or crash status, and a new cgroup OOM kill), never page data.

The daemon probes each running browser every five seconds. A browser that stops answering twice,
or can no longer be controlled, is replaced; the reason from browserd, or from its container's exit
status and log, is logged and shown to the user and to dot. A keyd health change restarts browsers
only when keyd went offline, restarted or lost its audit log, not when its hairpin probe's error
text changes. keyd is offline only after three failed status reads in a row over at least 15
seconds, so a slow answer on a busy Mac keeps the browser and its pages; a keyd that comes back with
a new boot restarts browsers at once, however soon. A locked passphrase vault is not such a change: keyd opens the browser's listener
without it, so the browser runs and only hosts bound to saved keys and saved passwords wait for
the unlock.

`GET /api/cells/:id/browser` carries a machine-readable `reason` whenever the browser is not fully
usable: `keys-locked` (with state `ready`), `key-service-offline`, `computer-paused`,
`computer-stopped`, `recovering`, `starting`, `restarting`, `failed` or `shutting-down`, with
`problem` (the cause), `clears` (what makes it usable), `retryAt` (the next automatic start) and
`readyBy` (when a start under way is ready or has failed, at most 180 seconds). A failed start is
tried again after 2, 5, 15, 30 and 60 seconds, then given up until the computer, keyd or a restart
changes something; the running task gets a note when the browser is back or given up. A start
cancelled by a stop, its computer or keyd is not counted as a failure. A browser recovery or stop
that can't be confirmed because keyd or Docker didn't answer is tried again by itself (after 5
seconds, up to once a minute) rather than keeping browsers closed until the daemon restarts, and a
complete recovery also lifts the computers' own unconfirmed stops.

Stopping a pointer glide drains the single already-dispatched native motion before releasing a
held drag. It does not send another motion or replay input. The native command timeout remains
in force; an unacknowledged operation still retires the controller rather than guessing its state.
A stopped read, screenshot or input already sent is waited out, and its answer dropped, so that one
task's Stop costs no other task the browser; only a press that would stay down retires it.
This avoids treating an ordinary Stop between a motion and its acknowledgement as a browser crash.

## Several windows

Each task has its own window of the one browser. Chromium treats a window covered by another as a
background tab (`visibilityState` hidden, timers once a second, no animation frames), which
`--disable-backgrounding-occluded-windows` turns off, so a task's page keeps working behind another
task's. A background tab inside a window is still throttled. The display can show one window at a
time: a task's turn raises its window, and every read and input checks that the active X window is
the one first seen as that Chromium window, since two tasks' windows can show the same address. The
accessibility read of the active window works with several windows open, and a raise can leave it
busy for a moment, so the raise waits for a first good read. See
[the design](superpowers/specs/2026-11-04-parallel-browser-windows.md).

## Browser defaults and site compatibility

The account browser is headed Chromium or Chrome with a persistent profile, a native user agent, and
private-pipe CDP control. It does not add `--enable-automation`, headless mode, user-agent
spoofing or Blink automation concealment. CDP is still automation: `navigator.webdriver` reads true
while the pipe is open, in either browser, and false only in sign-in without agent control. These
defaults do not promise that a website will classify localDot as a human-operated browser.

Keep background networking and component updates at Chromium's defaults. The old
`--disable-background-networking` and `--disable-component-update` switches suppressed
normal browser services; removing them is a compatibility correction, not a verified fix for
any particular challenge. Requests still pass through the gate. Sync and extensions remain
disabled, keyd owns saved credentials, and the sandbox and certificate checks remain enabled.

[Chromium describes background-network suppression as a performance-testing option](https://chromium.googlesource.com/chromium/src/+/00b44ff60356aad499a2ee49d5b513cb98bb63e7/chrome/common/chrome_switches.cc).
[Cloudflare does not support automation frameworks for production challenges](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/).
[Google may reject automated browser sign-ins](https://support.google.com/accounts/answer/7675428?hl=en).
A legitimate task can still encounter these restrictions. Diagnose the visible error, page
loading, graphics and network separately; use a site's supported connector or OAuth flow when
available, and preserve the existing browser session when user verification is needed.

## Google Chrome

Released images contain only Chromium. Google's terms don't let us distribute Chrome, so it is
installed on each person's machine, from Google, after they accept Google's terms: in setup, or from
Settings → Accounts. Declining, or a failed install, leaves Chromium working, and the reason is shown
there and in `localdot doctor`.

**The local image.** Released images are pinned by digest, and that pin must keep meaning what was
released. So the daemon (`apps/daemon/src/cells/chrome-image.ts`) makes a second image from the pinned
one and leaves the pin alone. A throwaway container runs `cells/browser/install-chrome.sh` as root
with only the capabilities apt and dpkg need, on a network of its own that it shares with nothing; the
daemon commits it as `localdot/browser-chrome:<install>-<version>`. The script takes Google's key file
over HTTPS and accepts it only if its single primary key has the fingerprint Google publishes
(`EB4C1BFD…D38B4796`), since the file itself changes with each new signing subkey. It then runs apt
against that key alone, with an unverifiable repository as an error. Chrome's own package lives in
its one extra layer, about 700 MB on disk beside the shared release layers. An image that can take
Chrome carries the label `localdot.chrome-install=1`; the daemon offers nothing on an older one.

Before anything else uses the image, the daemon checks that it is exactly the pinned image, layer for
layer, with that one layer on top and the same user, entrypoint and environment, and runs Chrome
headless on a scratch profile, under the browser cell's own sandbox and with no network. Each browser
start repeats the layer check; an image that fails it isn't used. Chromium stays in the image, and
browserd opens `/opt/google/chrome/chrome` whenever it is there. An operator's own image built with
`INSTALL_CHROME=1` runs the same script; Settings then reports Chrome as built in, with nothing to
choose. Such an image must never be published (see `scripts/release/no-chrome.mjs`).

**Updates.** Chrome on Linux has no updater of its own and the cell's root is read-only. Once a day the
daemon reads Google's package list, and when stable is newer it builds a new local image in the
background, the running browser untouched. The next browser start opens it, and Settings says so
until then. A release that pins a new browser image needs a new Chrome image too: the daemon makes
one when it starts, and a browser start waits up to two minutes for it. Old Chrome images are removed
once no container uses them. The pinned image's digest check doesn't change, because the pinned image
doesn't; `localdot doctor` adds `browser-in-use`, advisory, naming the browser and version.

**The one-way profile.** Browsers migrate a profile forward and can't safely go back, so:

- browserd reads the profile's `Last Version` before it touches anything and refuses to start a
  browser of an older major version. The daemon shows why (`profile-version.ts`).
- An existing computer changes only when its user chooses; there is no automatic upgrade, and a person
  with no choice recorded stays on Chromium.
- Before Chrome first opens a profile that a browser has used, the daemon stops every browser and
  copies the profile to a second volume, `<accounts volume>-backup`, in a helper with no network or
  capabilities, leaving out caches. It checks there is room and compares the cookie and password
  databases afterwards. If it can't, Chrome isn't used and Chromium stays, with the reason shown.
- The backup stays until the user deletes it, restores it or signs out of every site, which removes it
  with the profile. Removing a dot removes it too. It stays a Docker volume and never reaches the host.
- **Go back to Chromium** stops the browsers and restores the backup; anything since then is lost, and
  the dialog says so. It's the way out if Chrome won't start. Plain Chromium is refused once Chrome
  has moved the profile past it. With no backup left, signing out of every site makes a fresh profile.

Sign-ins move with the profile because `--password-store=basic` gives both browsers the same key. A
hardware-bound or OS-keyring secret wouldn't move this way; the browser cell has neither.

**What doesn't change.** The cell's spec is the same for either image: the profile only in the browser
cell, the internal network and gate, the private CDP pipe (Chrome 136+ ignores debugging switches on
its default data directory; `/profile/chromium` isn't that, and the Docker test proves the pipe
works), `cdp-guard`, masks, `CapDrop: ALL`, read-only root, seccomp and per-computer keys. The fingerprint
work above holds: `browser-chrome.docker.test.ts` runs the same page on both browsers. What a site sees
differs only in the version, the `Google Chrome` entry in the brand list and Client Hints, and Widevine,
which Chromium doesn't have. Locale, timezone, fonts, WebGL, the codecs it reports and
`navigator.webdriver` match, and so do the flags, the listening ports and the renderer's sandbox.

**What it costs.** Measured on arm64 with one page open, three runs each, on a busy machine: browserd is
ready about 0.4 s later (4.7–4.9 s against 4.3–4.5 s), memory settles the same (about 450 MiB), and the
cell's peak during start is about 300 MiB higher (783–1069 MiB against 493–783 MiB). Chrome adds about
700 MB of Docker disk space, and the backup the size of the profile without its caches.

[Google's Linux repositories and signing key](https://www.google.com/linuxrepositories/).
[Debugging switches and the default data directory](https://developer.chrome.com/blog/remote-debugging-port).

## Verification pages

Keep JavaScript, cookies and working graphics available, and let an ordinary challenge finish
loading. Do not equate a transient frame replacement with a disconnected browser. The integration
suite uses synthetic cross-origin frames and sign-in popups; it does not solve real CAPTCHAs or
prove a particular site's challenge will accept an automated browser.

[Cloudflare lists network, browser configuration and bot detection as distinct causes of loops](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/).
If a site still requests verification, retain its page and report that observed state rather than
restarting repeatedly, clearing cookies or claiming a memory crash without evidence.

## Typing

Agent typing uses real key events from the native injector (XTest), one per character, so
autocomplete and key handlers behave as they do for a person. It uses neither the clipboard nor
CDP input. With someone watching, the first 60 characters of a text appear one by one at 12 ms a
key, about 70 characters a second; after them, and with nobody watching, keys go as fast as the
application takes them. Native terminal text uses zero artificial delay from its first character.
The terminal decision uses the observed desktop application class, not a model-supplied label or a
web page's title. Delivery stays cancellable, with the same authorization checks. `typingPaceMs`
in `packages/stage/src/travel.ts` sets the pace. No jitter or human-timing model is applied:
localDot has never promised human keystroke timing, and a site that measures it can tell.

The web browser reads the whole page (geometry, the DOM snapshot and the accessibility tree of each
frame) before typing, and again every 2 seconds. That read takes a page's size in time and can miss
its budget on a busy machine; once a character, it cost 150-600 ms each and failed typing partway
every few hundred characters. Between reads, each of a text's first 60 keys, and every eighth key
after them, first asks whether the node that had focus still has it
(`Accessibility.getPartialAXTree`), a single node's cost. A node that lost focus, Return, Tab and a
replaced document all bring a full read before the next key, so in a text's first 60 keys a protected
field that takes focus stops the next character, and after them within 8. A full read that fails while
the node still has focus doesn't stop the typing. Where the accessibility tree can't name the focused
node (an app that draws its own field), a full read comes every 8 keys. Focus that moves to browser UI
or another window without the page's node losing it is seen by the next full read. Masked text follows
the same rules, and saved passwords and codes keep their own per-character path.

## Regression checks

- Browser unit suites cover popup selection, held control, stale input, target retirement and
  pending initialization/reload replies.
- `browserd-drag.docker.test.ts` exercises WebGL pixels, cross-origin frame replacement, popup
  reads and the actual HTTP refusal classification alongside native input and private sign-in flows.
- `typing-speed.docker.test.ts` types into a page and a desktop app and compares what arrived: every
  key event, the exact text, and stops at a protected field or browser UI that takes focus.
- `cells/desktop/tests/test_desktop_profiles.py` verifies launch flags and profile preservation.
- `chrome-image.docker.test.ts` installs real Chrome from Google into a local image and refuses a
  repository signed by another key. `browser-chrome.docker.test.ts` compares both browsers in a real
  cell and takes a profile through the backup, the refusal of the older browser and the restore.
- `scripts/release/no-chrome.mjs` checks every layer of an image for Chrome. The release workflow runs
  it before publishing and `scripts/distribution/assemble.ts` refuses a release without its evidence.
- Run `pnpm check:codex-release` before activating changed daemon code.


## Interactive sign-in without an automation connection

Google can refuse sign-in before a password is submitted. Its public guidance includes
software-controlled browsers among reasons for rejection; the error does not identify
which signal triggered a particular decision. Retrying credentials or handing over the
same CDP-connected browser does not establish that the problem changed.

On `accounts.google.com` this is the default: when the user holds the browser there, the panel
starts sign-in mode once for that hold and says why in one line, and `ask_user` and page reads tell
dot to request a login takeover instead of typing. Other sites keep it as a choice.

The user can now choose **Sign in without agent control** while holding the web browser.
This gracefully closes only the browser, waits for its complete process group to exit, and
reopens the same isolated profile without a remote-debugging pipe/port or accessibility
forcing. The browser's sandbox, network gate, native display and visible stream remain.
No user-agent spoofing, webdriver overrides, CAPTCHA bypass or host-cookie copying is used.
Agent reads, recording and input stay fenced. Native input remains available to the user.
Hand back restores the managed browser before giving the agent a new grant; normal private
field cleanup and fresh observation still apply. Repeated start requests are idempotent.
Downloads are not collected while sign-in mode is active. An unsupported browser image
advertises no capability; the daemon does not try the new endpoint blindly.

A process that has not fully exited cannot be replaced on the same profile. A stale exit
callback cannot terminate the replacement browser. Failed or interrupted mode changes
must be inspected through health, not automatically retried. Sign-in mode is not a
claim that Google accepts the browser: provider policy, browser support, account and
network reputation can still prevent access. It cannot replace a supported OAuth flow
for an API and OAuth API access cannot be claimed as a website session.

Saved logins can't be filled in sign-in mode. A fill is bound to the page's origin, which only the
debugging connection can tell; with it gone, a window's title is what the page chooses to say.

## Passkeys and security keys

They can't finish in the browser cell. Measured in a real cell on the released Chromium flags
(`saved-login-fill.docker.test.ts`): `PublicKeyCredential.getClientCapabilities()` reports
`hybridTransport: false` and `passkeyPlatformAuthenticator: false`,
`isUserVerifyingPlatformAuthenticatorAvailable()` is false, and the cell has no `/sys/class/bluetooth`,
`/dev/bus/usb`, `/dev/hidraw*` or `bluetoothd`. A passkey QR flow needs Bluetooth for its proximity
check, so a code shown here can't complete. dot is told to pick a site's password and code option,
and the panel says the same while the user holds the browser. Not measured on Google Chrome.

References consulted (2026-10-17):
- [Google: sign in with a supported browser](https://support.google.com/accounts/answer/7675428?hl=en)
- [Browser Use: authentication and persistent profiles](https://docs.browser-use.com/open-source/customize/browser/authentication)
- [Browserbase: persistent contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)
- [Playwright: reuse authenticated state](https://playwright.dev/docs/auth)

These projects emphasize preserving an authenticated profile or state and using an
interactive login when needed. They do not provide a general guarantee of Google
acceptance. localDot applies this pattern to its own isolated profile rather than
borrowing the user's personal host browser profile.
