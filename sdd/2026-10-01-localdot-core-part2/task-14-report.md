# Task 14 report: the live desktop in the stage

**Status:** DONE_WITH_CONCERNS.
- Everything the brief and rulings A–F ask for is done and verified, including the real-cell proof in Chrome.
- The concerns are console noise from the policy (by design), residual availability risks from the audit, and one small, tested change of scope: the audit led me to add a Permissions-Policy and a CSP `sandbox` on the client page. See D9 and "Concerns".

## Commits (BASE `b97bc42`, branch `feat/core-part2`)

| Commit | What |
|---|---|
| `c879f59` fix(desktop): extract the Selkies client only into a missing folder or a previous extraction | Carry A(e). The guard plus `extract-selkies-client.test.mjs` (5 tests, docker stand-in). Adds `cells/*/scripts/**/*.test.mjs` to the vitest include. |
| `487eb7e` chore(web): vendor the Selkies web client | Step 1. `apps/web/vendor/selkies/` (index.html, 3 assets, icon.png, icon-512.png, LICENSE, NOTICE.md). |
| `354b699` fix(daemon): bound the stream dial and keep a closed relay from moving its cell's state | Rulings B1–B3, plus a test pinning that the daemon serves the vendored client from `webDir("vendor/selkies")` (C(i)). |
| `dd4dd67` feat(daemon): content security policies for the Theatre and the vendored client | Ruling C(ii). It also carries the client page's Permissions-Policy and `sandbox` (D9). |
| `b02765f` feat(web): live desktop in the stage | Steps 2–3, carries A(a)–(c), ruling D. |

- **No attribution:** a grep of the commit bodies `b97bc42..HEAD` finds 0 matches for co-authored, claude, anthropic or "generated with".
- **Clean tree:** the tree is clean after the last commit.
- **Ignored output:** screenshots (`apps/web/e2e/out/`) and `dist/` stay ignored.

## How each ruling is met

### A. S8 carries

- **(a) Seed at tap time.**
  - **Frame source:** `FrameSource` gains `first?: VideoFrame`. `tapVideoTrack(video)` takes the iframe's element (`VideoLike` gains `readyState?`). It clones the track first, then takes `new VideoFrame(video)` when `readyState >= 2`. If that throws, there is no seed. `DesktopFrame` passes the element itself, not a `{ srcObject }` copy.
  - **Handoff:** `StageCanvas.attach` posts `{ type: "frames", readable, first }` and transfers both.
  - **Pump:** `pumpFrames(…, { first })` presents `first` before the first read, with `close()` in a `finally`, and starts the read loop regardless.
  - **Unattached sources:** `FrameSource.stop()` closes `first` as well as stopping the clone. A holder that never hands a source on therefore releases its seed:
    - `StageCanvas.attach` with no worker, or a `postMessage` that throws;
    - `Stage.onSource` with no canvas;
    - the worker's "frames before init" path.

    After a transfer, `close()` on the main-thread frame is a no-op; the proof run logged no VideoFrame errors.
  - **Measured:** right after connect, on a still screen, `data-frames` read 1 at fps 0 with `data-size` 2560x1600. This held after each fresh client: E1, E2, the proof, after Stop/Start and after the daemon restart.
- **(b) Re-mint.**
  - **Socket reopen:** `useCell` counts reopens of the status socket after its first open (`reconnects`). The Theatre passes the count to `<Stage reconnects>`.
  - **Stale client:** `DesktopFrame` calls `onStale` after 10 s with no reachable `#videoStream` (`STALE_MS`), then again every further 10 s, so a failed mint is retried.
  - **Remount:** either signal re-runs the mint effect. A successful mint sets a new `key` (`<path>#<reconnects>.<stale>`), so the iframe remounts. Per F7, the frame is keyed on its src.
  - **Real cell:** after a daemon restart the page minted 0.5 s after the daemon came back. The HUD went `Connecting…` → `Live` without passing through a non-ready state, so the reconnect path did it, not a ready flip.
- **(c) Storage cleanup.**
  - `stage/client-storage.ts` `forgetOldTickets(cellId, livePath, host = window)` runs on every mint, before the new src.
  - It removes the keys starting with `<origin>/cells/<id>/desktop/` (sanitised the client's way), except the live ticket's. It ignores storage errors.
  - **Real Chrome:** six tickets were minted across the session. Afterwards `localStorage` held only `…_desktop_<live>__storage_key_migrated`, `…__stream_mode` and `localdot.token`.
- **(d) HEAD.**
  - Task 11's route already answers HEAD, and its test pins 200 with an empty body. I added a check that HEAD carries the client CSP.
  - The client's `__selkiesAuthProbe` only reloads on a 401. Our route answers 200 or 403, never 401.
- **(e) Extractor guard.**
  - It refuses unless `$root/cells/desktop/Dockerfile` exists.
  - An existing `$dest` must hold `index.html` and `assets/`. A file, a dangling symlink or another folder is refused before anything is removed.
  - RED: the two new guard tests failed on the old script (`red-1-extractor.txt`). Three mutations were caught.

### B. Stream-proxy minors

- **(1) Late updates.**
  - `CellStreams.update` returns unless the relay is still registered.
  - The D3 test gained `unwedge`: after the viewer left, resuming the fake cell's sockets produced no stream update, and the connection stays `none`.
  - RED on `b97bc42`: one `connecting` update after recovery.
- **(2) Dial timer.**
  - An absolute `setTimeout(() => upstream.terminate(), upstreamTimeoutMs ?? 10 s)` replaces ws's idle `handshakeTimeout` (D8). It is cleared on `open` and on `close`.
  - Terminating while connecting emits `close`, which refuses the viewer with 502.
  - **Test** ("cuts a dial that drips its upgrade answer at the timeout, and never an open relay"): a dripping cell writes the start of a 101 and then one byte per 100 ms. The viewer gets 502 within 1.5 s, and the stream reads `disconnected`, 0 viewers. Then a real relay on the same daemon stays open past the timeout and echoes.
  - RED: the dial was still pending at 1.5 s. Mutations caught: "no timer", "timer kept after open".
- **(3) Temp files.**
  - The daemon helper removes its vendor and event-log folders, and the traversal test removes `ld-proxy-outside.txt`.
  - **Verified:** four consecutive runs left no `local dot's vendor-*` or `local dot's proxy-*` folder in `$TMPDIR`, and no outside file.
  - **Old leftovers:** I deleted the 4,476 folders that earlier runs (Tasks 11–14, all today) had left. Only this test file uses those prefixes.
  - **Not reproduced:** the one run made right after that bulk deletion left 36 folders born during it. I could not reproduce that in four further runs; they are deleted too.

### C(i). Audit of the vendored client against cell-controlled data

**How I audited it:**
- **Code:** I read Selkies 2.0.0's `selkies-core-BbKps5RD.js` and `index-CPWh3fQ6.js`, formatted with Biome (16,861 + 24,606 lines). I traced every WebSocket text message type the core handles, every `message` listener, and every sink.
- **Sinks searched:** `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`, `eval`/`Function`/string timers, `setAttribute`/`href`/`src`, `style.cursor` and CSS `url()`, `window.open`/`location`/`top`/`parent`/`opener`, `postMessage`, storage, workers and worklets, and the clipboard, media and permission APIs.
- **Rendering:** the core writes text only with `textContent`; it has no `innerHTML` at all. The dashboard is React 19.3.0, which blocks `javascript:` URLs, and has no `dangerouslySetInnerHTML` in its own code.

| # | Cell-controlled input → path | Sink | Verdict |
|---|---|---|---|
| 1 | `cursor,<json>` → `updateServerCursor` → `_updateBrowserCursor` | `style.setProperty("cursor", 'url("data:image/png;base64,' + curdata + '") …')`: string interpolation, so `curdata` containing `")` can append other `url()`s | **Contained.** It is confined to the `cursor` property, so the only effect is an image load. CSP `img-src 'self' data: blob:` refuses any other origin. Same-origin GETs carry no token and change nothing. The bitmap path (`createImageBitmap(Blob)`) is safe. |
| 2 | `clipboard,` / `clipboard_binary,` / `clipboard_start/data/finish` | `navigator.clipboard.writeText`, and `clipboard.write` with an HTML `ClipboardItem` (cell markup into the user's clipboard) | **Blocked twice.** It needs the iframe document focused, and the frame is inert and never focused. `clipboard-write=()` now denies it outright (Chrome: all 7 features `allowsFeature` false). The displayed text goes through React, as text. |
| 3 | The client reading the user's clipboard (`clipboard.readText`/`read` on focus or paste, sent to the cell) | the cell receives host data | **Blocked.** It runs only on the frame's focus or paste events (inert), and `clipboard-read=()` denies it. |
| 4 | `CAPTURE_DEMAND webcam 1` / `microphone 1` → `Oo(true)` / `To(true)` → `getUserMedia`; the defaults `Ne = Me = true` make it reachable | a camera or mic prompt for localDot's origin; if allowed, frames and audio sent to the cell | **Was reachable; now denied.** It needs no user gesture: the legitimate Selkies sends this whenever an app in the desktop opens the virtual camera or mic. `camera=(), microphone=()` now apply. Real Chrome: `NotAllowedError: Permission denied` and "Permissions policy violation: camera is not allowed in this document", with no prompt. |
| 5 | `print_document {name,size}` → `announce` → fetch `api/print/<encodeURIComponent(name)>` | a blob URL, `window.open`, a print iframe, a dashboard notification | **Inert.** The proxy answers 404, so `announce` logs a warning and returns: no `printDocument` message, no notification, no popup, no blob. Nothing visible breaks. The name is URI-encoded, so it can't leave `api/print/`. `window.open` would also be refused by the sandbox (no `allow-popups`). |
| 6 | `system,{"action":"reload"}` | `window.location.reload()` of the client page | **Self-DoS only.** It reloads our vendored page under the same ticket path. |
| 7 | `system,…command_error,<text>`, `command_done,<cmd>`, `apps_installed,<json>` | dashboard notifications (React text). `apps_installed` writes the unprefixed `prootInstalledApps` key | **Safe.** Text only. The storage write happens only while the apps panel is open (`Qn && <Po>`), which needs a user's click and is unreachable in the inert frame. |
| 8 | `server_apps` → `systemApps` | apps panel. Icons come from `https://raw.githubusercontent.com/…/img/<icon>`; the host is fixed and only the path comes from the cell | **Unreachable and blocked.** The panel only opens on a user's click, and CSP `img-src`/`connect-src` refuse GitHub. |
| 9 | `stream_info` / `stream_stats` | `window.stream_info`, the stats panel (React text), and `window.parent.postMessage({type:"stats", data:{info,…}}, origin)` **to the Theatre** | **Safe today.** The Theatre has no `message` listener. Any future Theatre listener must check `e.source`, not only `e.origin` (concern 5). |
| 10 | `server_settings` | client settings, persisted under the ticket-prefixed keys; sanitised values are sent back; `postMessage` to the dashboard | **Safe.** Logic and text only. Keys are prefixed by the ticket path and dropped at the next mint. Large values can only press on storage quota (an availability matter). |
| 11 | `api/status` `{current_mode}`, or a 409 on the plain GET of `api/websockets` | the client's streaming mode; WebRTC stored as `stream_mode` | **Self-DoS only.** WebRTC can't connect through the proxy: the signaling upgrade gets 404, `api/turn` gets 404, and `iceServers` is `[]`. The stream stays dead until the ticket changes. |
| 12 | `KILL <text>` | `textContent` "Connection Terminated: …", the socket closed and reconnect disabled | **Self-DoS only.** Text only. `#videoStream` stays, so the 10 s watchdog doesn't fire. The next socket reconnect or ready flip re-mints. |
| 13 | `AUTH_SUCCESS` / `ROLE_UPDATE` / `MK_ACCESS` / `MODE` / `PIPELINE_*` / `AUDIO_*` / `VIDEO_*` / `WEBCAM_KEYFRAME` / `DISPLAY_CONFIG_UPDATE` / `stream_resolution` / `pipeline_status` | role and slot, attaching input listeners in the frame, decoder resets, layout | **Safe.** Logic only. Input listeners live in the inert, never-focused frame. Unknown messages go to `webrtcInput.on_message`, which is never defined, so they are dropped. |
| 14 | `_gz,1` then gzip control frames (byte 0x05) | an unbounded `DecompressionStream("gzip")` into an `arrayBuffer()` | **Residual: availability.** A gzip bomb (or oversized messages) can exhaust the renderer, which the iframe shares with the Theatre. Confidentiality is unaffected (concern 4). |
| 15 | Binary video, audio and JPEG stripes | WebCodecs `VideoDecoder` (in a worker), `ImageDecoder`, `createImageBitmap`, a JPEG `<img src=blob:>` | **Inherent to streaming.** Chrome's media and image decoders parse cell bytes inside the renderer sandbox. |
| 16 | The page title (`document.title = e.name`) | the iframe's own document | **Safe.** It never reaches the Theatre's title. |
| 17 | `postMessage` listeners | `co`, `ar`, `In` (core) and the dashboard listeners check `e.origin === location.origin`; the `commandDone` one also checks `e.source === window`. The touch-gamepad listener checks no origin | **Safe.** Only same-origin pages pass the checked listeners. The gamepad listener only toggles a built-in overlay (constant SVG labels) inside a hidden, inert frame. The cell itself cannot post messages. |
| 18 | `HEAD <page>` probe, 401-reload wrapper | page reload chains | **Safe.** The route answers 200 or 403, and the proxy maps a cell's 401 to 502 (Task 11). |
| 19 | User-only paths: upload (`POST api/upload`), files (`api/files/`), fullscreen, pointer lock, gamepads, mode switch, apps panel | — | **Unreachable.** The frame is inert and 2×2 px off-stage; the routes answer 405 or 404. The sandbox also drops pointer lock and downloads, and the permissions deny fullscreen and gamepads. |
| 20 | Wake lock | `navigator.wakeLock.request("screen")` when the stream plays | **Denied** (`screen-wake-lock=()`). Keeping the Mac awake is not Selkies' call. |

- **The vendored client is served:**
  - The `354b699` test runs the daemon with `vendorDir: webDir("vendor/selkies")`. `index.html` comes back 200, and every shipped asset under `assets/` (both linked files and the dynamically imported `selkies-core-*.js`) is 200.
  - In real Chrome the client loaded from the ticket path, ran, and streamed. Chrome saw the page's CSP and Permissions-Policy headers.
- **`api/print/*` answering 404:** see row 5. Code-level evidence plus Task 11's proxy test. The real Selkies never sent `print_document` during the run (nothing printed).
- **404s seen in the real run:** only `<ticket path>/manifest.json`. The core fetches it for its title; S8 found this harmless.

### C(ii). Content Security Policy

**The Theatre** (`static-ui.ts`, on `/` and on every `/assets/*` response). The render worker takes its policy from its own response, so the assets carry it too. It is the starting policy with no widening:
```
default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'
```
The Theatre's `index.html` has no inline script or style. Its render worker started, and its status socket connected, under this policy with no violation.

**The vendored client** (`stream-proxy.ts`, on every vendored file: page, HEAD and assets):
```
default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'; worker-src blob:; sandbox allow-scripts allow-same-origin
Permissions-Policy: camera=(), microphone=(), clipboard-read=(), clipboard-write=(), fullscreen=(), gamepad=(), screen-wake-lock=()
```

**Widenings, each proven against the real client:**

| Directive | Why |
|---|---|
| `worker-src blob:` (the only widening) | The client runs its WebSocket transport, its decoders and its H.264 probe in workers built from blob: URLs. **Without it (E0), the client never connects:** the HUD stays `Connecting…` and 0 frames arrive. Chrome's exact message: `Creating a worker from 'blob:http://127.0.0.1:4795/<uuid>' violates the following Content Security Policy directive: "default-src 'self'". Note that 'worker-src' was not explicitly set, so 'default-src' is used as a fallback. The action has been blocked.` It fired 4 times, from `index-CPWh3fQ6.js:9` and from `selkies-core-BbKps5RD.js` lines 1, 1579 and 1847, and the client logged `video worker error: undefined`. |

**Not widened (deliberately):**

| Refused | What happens |
|---|---|
| `style-src` inline | The core's injected `<style>` (`selkies-core:1673`, `style-src-elem`) is refused. It only lays out the client's own UI in the hidden frame, and the stream works without it (E1/E2). |
| `script-src blob:` | The playback AudioWorklet's blob: module fails: `Error initializing Playback AudioWorklet: AbortError: Failed to load worklet module script: blob:… (a dependency or cross-origin script failed to load)`. A standalone Chrome check reproduced exactly that message with `worker-src blob:` alone, and loaded the module once `script-src 'self' blob:` was added, so the CSP is the cause. The stage is video-only, so no audio plays. |
| `connect-src` | `'self'` covers the client's `ws://127.0.0.1:<port>` socket, opened from a blob: worker. No violation was logged. |
| `img-src` | No violation was logged. |

**Additions (tightening, D9):**

- **`sandbox allow-scripts allow-same-origin`.**
  - **Drops:** dialogs, popups, downloads, pointer lock, forms and navigating the Theatre. Chrome logged "Ignored call to 'alert()'. The document is sandboxed, and the 'allow-modals' keyword is not set." for a probe `alert()`, and no dialog appeared.
  - **Keeps:** the origin (the WS `Origin` header, storage, and the parent's `contentDocument` access).
  - **Console warning:** Chrome prints "An iframe which has both allow-scripts and allow-same-origin … can escape its sandboxing" on each load. An escape needs script in the client's realm, which the CSP refuses: a probe's injected inline script was blocked (`script-src-elem`), and `eval` in the frame threw `EvalError`.
- **Permissions-Policy.** It denies what the audit found the client calls: rows 2–4, 19 and 20. Chrome 154 recognised all seven names, with no parse error.

**Experiments** (`experiments.json`, `experiments.out`). One cell; the scratch daemon restarted per variant with `T14_CLIENT_CSP` overriding the client page's header:

| | Policy | HUD | Frames before motion → after | fps | Violations |
|---|---|---|---|---|---|
| E0 | the starting policy | Connecting… (26 s) | 0 → 0 | 0 | 4× worker-src blob:, 1× style-src-elem |
| E1 | + `worker-src blob:` | Live | 1 → 115 | 44 | style-src-elem only (plus the AudioWorklet AbortError) |
| E2 | as shipped (+ sandbox) | Live | 1 → 107 | 44 | the same as E1, plus the sandbox warning |

**Pinned by tests:**
- `stream-proxy.test.ts`: the exact CSP and Permissions-Policy on GET `/`, HEAD `/` and an asset.
- `static-ui.test.ts`: the exact Theatre CSP on `/` and on an asset.

Mutations "no client policy" and "Theatre assets without CSP" are caught.

### D. Tests and UI

- **F17:** `Stage.test.tsx` "says a Chromium browser is needed where frames cannot be tapped". The brief's exact text is asserted, plus no iframe.
- **Cleanup:** `afterEach(cleanup)` is in `Stage.test.tsx` and stays in `App.test.tsx`.
- **Design (apple-design):**
  - **Tokens:** every new value is a token (`--spacing-client-frame`, `--spacing-client-frame-off`, `--duration-veil`, `--ease-veil`). The veil uses `--color-hud-solid` and `--color-text-2`. In the built CSS every colour literal sits in the `:root` token block, and no rule references `--color-xenon*`.
  - **No gradients:** 0 in the built CSS. No purple, no emoji.
  - **Reduced motion (Chrome emulation):** the veil's `opacity 0.24s` becomes `none 0s`, and the canvas's 0.4 s becomes 0 s.
  - **Reduced transparency (CDP emulation):** the HUD's `backdrop-filter` becomes `none`. The veil is always the solid `rgba(14, 15, 18, 0.92)` with no blur.

### E. Real-cell proof

**Setup:**
- **Daemon:** `scratchpad/t14-stage/daemon.mts`, a copy of `main.ts` whose only change is `namePrefix: "localdot-test-"` (the Docker naming rule; Task 11 did the same). Optionally, `T14_CLIENT_CSP` overrides the client page's header, for the experiments only. It ran with `node --import tsx` from `apps/daemon`, on port **4795**, with `LOCALDOT_HOME` = `scratchpad/t14-stage/home dot's` (space and apostrophe).
- **Images:** `localdot/desktop:dev`, built 9 s after the last `cells/` commit.
- **Browser:** Google Chrome 154.0.8037.92 driven by Playwright 1.63 (`flow.mjs`), at 1440×900 and DPR 2.

**Timeline** (`flow.log`, proof phase):

| Step | Result |
|---|---|
| Start | Live 1.2 s after load (the cell was already up from the experiments). |
| Seed | First frames with no motion: `frames 1, fps 0, size 2560x1600`. |
| Motion | `xfce4-terminal` opened in the cell: frames 1 → 58 in 4.6 s, then 113, at 44–45 fps. |
| Pause | `docker pause`: the veil appeared after 1,511 ms (HUD `Reconnecting…`, bar `Offline`). |
| Unpause | `docker unpause`: Live at once, on the same socket. |
| Stop | `Stopped` with no iframe. |
| Start | Live with a **new ticket** (`gNwE…` → `Ksmt…`), one mint, and frames 1 at once. |
| Daemon restart | Down 3 s. The ticket was minted 0.5 s after the daemon came back (the socket-reconnect path). A new ticket (`Ksmt…` → `sRtk…`), Live, and frames 1 → 52 with motion. |

**Client protections probe:**
- 7/7 features denied;
- camera `NotAllowedError`, no prompt;
- injected inline script refused;
- `eval` gives `EvalError`;
- no dialogs and no popups;
- the parent still reads `#videoStream`.

**Screenshots** (2880×1800, in `/Volumes/Husky's SSD 4T/Projects/localdot/apps/web/e2e/out/`). I opened each one.

- **`theatre-live.png`** (the brief's shot command, fresh Chrome profile, 8 s settle):
  - **Desktop:** the WhiteSur light desktop fills the stage. It has the Mojave-style dune wallpaper, a light top panel styled as a menu bar (apps grid at left; volume and "Thu 01 Oct 22:30" at right), Home and File System icons, and the Plank dock: Files, Chromium, Terminal, VSCodium, an editor, Writer, Calc, Impress and GIMP.
  - **Chrome:** the HUD pill on the picture reads "Live" with "■ Stop computer", the top bar's lamp reads "Live", and the caption reads "Your computer is live." Rails and top bar as in Task 13. It is sharp at 2×.
- **`t14-live-motion.png`:** as above, plus a terminal window with WhiteSur light chrome and traffic lights, a crisp prompt, and the dock's Terminal item marked as running.
- **`t14-live.png`, `t14-restarted.png` (after Stop/Start), `t14-reconnected.png` (after the daemon restart):** the same live desktop, HUD Live, lamp Live.
- **`t14-paused.png`:** the veil dims the stage to near-black, with faint dune shapes beneath and "Reconnecting…" centred in grey. The HUD reads "Reconnecting…" with "Stop computer", the lamp reads "Offline", and the caption reads "The stream paused. Reconnecting."
- **`t14-stopped.png`:** a flat, empty stage with no stale frame. HUD "Stopped" with "Start computer", caption "Your computer is off."
- **`t14-csp-e0.png`:** the starting policy alone. Empty stage, HUD "Connecting…", caption "Connecting to the stream."
- **`t14-csp-e1.png`, `t14-csp-e2.png`:** the live desktop.

**Pixel scan** (`scan.mjs`):
- **Outside the stage:** in all 10 PNGs, **0 chromatic pixels** (max − min channel > 12) and 0 xenon-like pixels.
- **Inside the stage:** colour comes only from the desktop picture: 92.7 % of the stage when live, 0 % when stopped or paused.

**Cleanup:**
- **Shutdown:** I stopped the computer from the HUD; `DELETE …?purge=1` answered 204 and the list is `[]`. The daemon stopped on SIGTERM, leaving no `daemon.lock`; ports 4795 and 4796 are free, and the scratch homes (with their tokens) are deleted.
- **Docker:** container, network and volume names `diff` identical to the baseline taken before the run (checked at 23:31 BST, after the cleanup). Nothing was pruned or restarted, and nothing under `/Volumes` was mounted.
- **Not mine:** a container `localdot-test-p7-rec` appeared later (`docker run` from `localdot/desktop:dev`, created 23:38:36 BST).
  - It has no `localdot.cell` labels, and it uses a name my harness never creates (the orchestrator names cells `localdot-test-desktop-<ULID>`/`localdot-test-gate-<ULID>`).
  - It looks like another lane's work in progress, so I left it running.
  - With it, the container list is baseline + `localdot-test-p7-rec`, and the volume list is baseline + that container's anonymous volume (`a13fbe18…`, created the same second). Networks are at baseline.
- **Build cache:** the extractor's `docker build --output` creates no image. Its `selkies-client` COPY steps were all `CACHED` in the part of the log I kept (its tail).

## TDD evidence (RED before GREEN; logs in `scratchpad/t14-stage/`)

| Area | RED | GREEN |
|---|---|---|
| Extractor | 2 failed, 3 passed (the new guards) | 5/5 |
| Daemon | 4 failed: Theatre CSP, client CSP, late update (B1), dripping 101 (B2) | 22/22 |
| Pump | module missing, then the brief's `pump.ts` verbatim: 2 seed tests failed, 2 passed | 4/4 |
| Frame source | the brief's verbatim file: the seed test failed | 9/9 together with the pump |
| Client storage | module missing | 2/2 |
| Stage | the brief's components verbatim: 4 failed (storage, reconnect, 10 s re-mint, seed), 4 passed | 19 stage tests |
| App | the wiring test failed | 40 web tests |

**Mutations: 20 of 20 caught.** Each was restored and checked byte for byte with `mutate.mjs`.
- **Extractor (3):** no Dockerfile check; no extraction check; `index.html` alone counts.
- **Proxy and policy (5):** `update` ignores registration; no dial timer; timer kept after open; no client policy; Theatre assets without CSP.
- **Web (12):**
  - re-minting: no re-mint on reconnect; never stale; first open counts as a reconnect;
  - the seed: a copy tapped instead of the element; seed not handed to the worker; pump skips the seed; seed regardless of `readyState`; `stop` keeps the seed;
  - storage: no cleanup; cleanup takes the live ticket;
  - lifecycle: no detach on leaving ready; Stage ignores `frameTapSupport`.

## Verification

| Check | Result |
|---|---|
| `pnpm format` | No fixes. |
| `pnpm lint` | 157 files, 0 diagnostics (after moving the veil rule ahead of `.stage > .stage-veil` for Biome's noDescendingSpecificity). |
| `pnpm typecheck` | Exit 0 for all six packages. |
| `pnpm hygiene` | Exit 0. No vendored file trips a pattern, so `check-hygiene.mjs` is unchanged. |
| `pnpm test` | **46 files, 414 tests pass**, with no stderr and no `act()` warnings (Task 13: 41 / 387). |
| `pnpm --filter @localdot/web build` | `dist/assets/render-worker-B3TpmZkB.js` sits next to `index-Chyu7RSs.js` and `index-Cvqqu34Z.css`. These are the same hashes the proof ran on. |
| Docker suites | No `*.docker.test.ts` covers the changed code (git grep), so none was touched. The real-cell run is the integration check. |

## Deviations from the brief (each tested or measured; rule on them)

- **D1, seed plumbing (carry A(a)).**
  - `FrameSource.first`; `stop()` also closes `first`; `tapVideoTrack` reads `readyState`.
  - `PumpOptions.first`, with the seed's present wrapped so a failure still starts the pump.
  - `WorkerIn.frames.first`.
  - The worker handles messages one at a time (a promise queue), so a pump has stopped before the next one paints. The brief's `async onmessage` could interleave two `frames` messages.
- **D2, re-mint interfaces (carry A(b)).**
  - `Stage { cell; api; reconnects }`; `useCell` returns `reconnects`; `DesktopFrame { src; onSource; onStale }`.
  - The iframe is keyed per mint (F7: key on src), so a new src or attempt remounts it with a fresh poll.
  - `STALE_MS` = 10 s; the poll stays at 250 ms.
- **D3, `StageCanvas` has no `onStats` prop.** Nothing used it, and the brief's `onStatsRef.current = onStats` was a ref write during render (Task 13's D5(a)). The stats still reach `data-frames`/`data-fps`/`data-size`.
- **D4, new file** `stage/client-storage.ts` (+ test) for carry A(c), with a `host = window` parameter like `token.ts`.
- **D5, CSS.**
  - The brief's literals became tokens (`--spacing-client-frame` 2px, `--spacing-client-frame-off` -20px, `--duration-veil` 240ms, `--ease-veil` ease-out).
  - The veil gained `padding: 0 var(--spacing-gutter); text-align: center` for the long Chromium notice.
  - The reduced-motion rule targets `.stage > .stage-veil`, and the veil rule moved above `.stage > canvas, .stage > .stage-veil` to satisfy Biome.
- **D6, test counts.** The brief expected 5 stage tests plus 1 Stage render (22 web tests). There are 19 stage tests (pump 4, frame source 5, client storage 2, Stage 8) plus 1 App wiring test, so **40 web tests**. The extra tests pin the carries.
- **D7, vitest include.** `cells/*/scripts/**/*.test.mjs` was added for the extractor test, co-located with the script. `.dockerignore` already keeps `scripts/` out of the image context.
- **D8, dial timer.** The absolute timer replaces ws's `handshakeTimeout`, keeping one mechanism and the same 10 s.
- **D9, beyond the CSP ruling, audit-driven.**
  - **The change:** a Permissions-Policy and a CSP `sandbox allow-scripts allow-same-origin` on the client page only. The Theatre gets no Permissions-Policy, so later mic or voice features stay possible there.
  - **Why:** row 4 (the camera or mic prompt the cell can trigger) is the one audit finding that mattered without them.
  - **If you rule against them:** two lines come out.
- **D10, real-cell harness.** A scratch copy of `main.ts` with `namePrefix: "localdot-test-"` and an env-gated header override for the experiments. Neither is in the repo.
- **D11, port.** The proof ran on 4795 (the test range per ruling E), not 4750. The brief's `shot` command was run as written apart from the port.
- **D12, Step 4 wording** (per S8): a pause reconnects nothing. The same socket resumed, and Live came back at once on unpause.

## Concerns and notes

1. **Console noise by design.** Each client load logs:
   - the refused `<style>`, as a CSP error;
   - two AudioWorklet errors and "[Main] Cannot initialize decoder audio …";
   - the sandbox-escape warning;
   - a 404 for `manifest.json`.

   **If the Theatre should ever play the desktop's sound,** the widening is `script-src 'self' blob:`. I measured that it loads the worklet, but did not add it.
2. **The sandbox warning** is inherent to `allow-scripts` + `allow-same-origin`. The sandbox holds only while no script can enter the client's realm, and today the CSP ensures that.
3. **StrictMode in development.** A React StrictMode *development* render would call `transferControlToOffscreen` twice and throw. The daemon only serves the production build, which doesn't double-invoke effects, and the brief's code had the same property.
4. **Residual availability risks** (a hostile cell; no confidentiality impact):
   - a gzip bomb or huge messages can crash the renderer the iframe shares with the Theatre (row 14);
   - the cell can pin the client into WebRTC, KILL it, or reload it (rows 6, 11 and 12);
   - settings values can press on the origin's storage quota.

   Fixing the first two needs a relay-side filter or a modified client; both are out of scope.
5. **The client posts cell data to the Theatre** (`window.parent.postMessage({type:"stats", …}, origin)`). Any future `message` listener in the Theatre must check `e.source` (the iframe) or ignore same-origin messages.
6. **Unprefixed client storage keys** survive the per-ticket cleanup. They are written only by user actions in the client UI, which the inert frame can't receive: `theme`, `universalTouchGamepad_currentProfile`, `prootInstalledApps`. The exceptions are the sessionStorage keys `selkies_mode_flip` and `__selkiesAuthReloadChain`.
7. **Possible hardening, not done:** `Cross-Origin-Opener-Policy: same-origin` on the Theatre would cut cross-origin openers off from reaching the iframe's window (row 17's gamepad listener). Not asked for, and harmless today.
8. **Unexplained temp folders:** one batch of 36 proxy-test folders, born during the run right after my bulk deletion, couldn't be reproduced (B3 above).
