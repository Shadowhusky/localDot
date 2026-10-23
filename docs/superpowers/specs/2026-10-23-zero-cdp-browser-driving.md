# Zero-CDP browser driving — design and decision

Status: design note. Part of the "human browser environment" work (locale/timezone/fonts, opt-in
GPU, opt-in Google Chrome, egress advisory shipped alongside this on `feat/browser-realism`).

## Intent

The original proposal was to drive the account browser with **no CDP at all** by default — pure
screen capture plus native OS input — so a site can find no automation residue, reattaching CDP only
for privileged operations (downloads, the file chooser, cookie management).

## What the code actually does today

The account browser is already far stealthier on the CDP axis than typical Playwright/Puppeteer
setups. Verified in `cells/browser/browserd/src/runtime-config.ts` and `src/cdp-guard.ts`:

- **Control is over a private pipe, not a port.** The launch uses `--remote-debugging-pipe`, never
  `--remote-debugging-port`; `runtime-config.test.ts` asserts no `remote-debugging-port`. So there is
  **no `localhost:9222` for a page or a scanner to probe.**
- **The `Runtime` domain is never enabled.** `cdp-guard.ts` allowlists `Page.*`, `DOM.*`,
  `DOMSnapshot.captureSnapshot`, `Target.*`, `Storage.*`, downloads and the file chooser, and the
  tests assert `Runtime.enable`, `Runtime.evaluate` and `Page.addScriptToEvaluateOnNewDocument` are
  **rejected**. The single most-cited bot-detection signal — the `Runtime.enable` leak that
  Cloudflare/DataDome, patchright and rebrowser-patches all target — **is absent.**
- **No `--enable-automation`, no headless, no `navigator.webdriver` override, no UA spoofing.**

A CDP client attached over a pipe, with the `Runtime` domain never enabled, exposes **no
JavaScript-observable signal to the page.** `Page.enable`/`DOM.enable` are not visible to page JS, and
the pipe is a file descriptor the page cannot see. In practice the current posture is already
undetectable from page JavaScript on the CDP axis.

## Decision: do not make zero-CDP the default

A full zero-CDP default is **high cost for near-zero marginal benefit**:

- **Benefit is ~nil.** The detectable CDP signals (open port, `Runtime.enable`, `webdriver`) are
  already gone. Removing the invisible pipe closes nothing a site can currently observe.
- **Cost is high and regressive.** Perception relies on CDP `DOM.getNodeForLocation`,
  `DOM.getBoxModel` and `DOMSnapshot.captureSnapshot` for precise web-content geometry. Dropping CDP
  forces reliance on the AT-SPI tree (`browser_surface.py`) plus screenshots only, which is coarser
  for web content and would regress click/scroll accuracy — the agent's core competence.

So the blanket refactor is **not recommended.** The high-value anti-detection levers are the ones
shipped on this branch (egress reputation, real Chrome, locale/timezone/fonts, GPU), not CDP removal.

## Recommended increment (optional, scoped): CDP-detached sensitive-flow mode

There is one place a smaller change helps: the hardest sign-in walls (Google SSO), where provider
heuristics are opaque and conservative. localDot already has the detach plumbing — `browserSignInSpec(config, manual)`
relaunches the same profile with no `--remote-debugging-pipe` for a *user*-driven sign-in.

The increment is an **agent-operable** detached mode for the duration of a sensitive flow:

- Relaunch the account browser without `--remote-debugging-pipe` **but keep
  `--force-renderer-accessibility`** (today's manual mode strips both). The agent then perceives via
  AT-SPI (`browser_surface.py`, already CDP-free) plus screenshots, and acts via native input — zero
  CDP residue — then reattaches CDP for normal operation.
- Scope: opt-in per sensitive flow, not a global default; preserve the profile across the
  relaunch exactly as sign-in mode does; downloads/file-chooser/cookie ops remain CDP-only and are
  simply unavailable while detached (acceptable for a sign-in).

### Open questions for the owner

- Is AT-SPI-only perception accurate enough to complete a Google sign-in (entry/button geometry)
  without CDP box models? Needs a real-image trial before committing.
- Trigger: explicit user/agent request per flow vs. automatic on a detected hostile wall.
- Interaction with the existing user "sign in without agent control" mode (shared relaunch path).

### Verification approach

Real-image only: build the browser image, drive a Google sign-in in detached mode via AT-SPI +
native input, confirm the flow completes and that reattaching CDP restores normal reads. Unit-test
the spec that keeps accessibility while dropping the debugging pipe.
