# Spike summary: decisions, spec amendments, remaining risks

Spikes S1–S7 (M0) ran on 2026-09-30 and 2026-10-01, all on one Apple M3 Ultra with Docker Desktop 4.60 (Engine
29.2). Parts 2+ of the core plan are written from section 1; the controller applies section 2 to the spec.

How sources are cited:

- **S1–S7:** `spikes/s1-stream`, `spikes/s2-perception`, `spikes/s3-network`, `spikes/s4-keyd`, `spikes/s5-models`,
  `spikes/s6-timing` and `spikes/s7-codex`, each `FINDINGS.md`. A quoted name after a spike is a heading in that file,
  or its bold "Result" paragraph.
- **Ledger:** the controller's progress ledger, `.superpowers/sdd/2026-09-30-localdot-core-part1/progress.md`
  (git-ignored). "Ruling N" is its numbered ruling, and only the latest applies: 8 supersedes 7, 24 supersedes 21 and
  23, 25 supersedes 22, and 26 amends the numbers of 24 and 25. Other entries are cited by their label. Where a ledger
  entry is the evidence the repo can't otherwise show (D15, D17, D18), the row quotes it.
- **Foundation ledger:** the Tasks 10–14 ledger in the `localdot-foundation` worktree (merged at `7bf918e`), cited as
  "foundation Ruling N".
- **Spec:** `docs/superpowers/specs/2026-09-30-localdot-core-design.md` in the umbrella docs repo. **UI decision:**
  `docs/superpowers/design/2026-09-30-localdot-ui-directions/README.md` there.

## 1. Decisions

| # | Area | Decision | Evidence | Still unverified |
|---|---|---|---|---|
| D1 | Stream transport | **Selkies element tap.** Keep Selkies 2.0 (WebSocket, H.264). Frames come from its client's `<video id="videoStream">`: a `MediaStreamTrackProcessor` on a clone of that element's track yields every decoded frame as an I444 `VideoFrame` that can move to a worker. No decoder of our own, no VNC. `SELKIES_ENABLE_CURSORS=false` keeps the pointer out of the frames. | S1 "Result", "Step 6: frame tap" (the track saw every frame: 1389 decoded, 1388 presented at 2×), "Step 2 facts"; S6 "Method" (all 1190 trials read frames this way); Rulings 14, 15, 20 | VNC fallback (S1 "Step 7: VNC fallback": image pull denied); browsers other than Chrome 154; Selkies' client inside localDot's own page (S1 tapped Selkies' dashboard through the proxy); per-new-frame upload and worker-transfer cost; 4:2:0 hardware decode |
| D2 | Stream scale | **2×**: 2560×1600 device px for logical 1280×800, with HiDPI XFCE (`Gdk/WindowScalingFactor` 2, `Xft/DPI` 96, the `Default-xhdpi` xfwm4 theme, a doubled panel). 1× stays switchable. | S1 "Result" (only 2× is sharp on a DPR-2 viewer; both scales hold 62 fps in continuous motion; 2× costs 2.5–3× the container CPU, peak 251 % against the 400 % target, and 35 vs 14 Mbps), "2× rendering"; S2 "2× coordinate space (Ruling 16)"; S6 "Injection to frame: the brief's measurement" (2× adds ~6 ms at the p50); Ruling 14 | Cost on M1-class hardware; the full HiDPI fix on a running desktop; the GTK ×2 settings with a viewer connected (Selkies sets its own DPI); smoothness under partial damage |
| D3 | Perception backend | **Cua Driver 0.30.4, pinned, for perception only** (trees, windows, screenshots), not the xdotool + pyatspi fallback. Run the bundled binary as `cua-driver mcp --no-overlay` as the desktop user, with `DISPLAY=:1`, the XFCE session's `DBUS_SESSION_BUS_ADDRESS`, and `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` and `CUA_DRIVER_RS_UPDATE_CHECK=0` baked into the image; resolve the binary path at build time. Web-page boxes come from CDP. | S2 "Result" (raw AT-SPI is no more accurate for native apps), "Trees and frame accuracy per app", "Latency", "Setup that was needed"; S6 "Result" change 4; Rulings 18, 25; ledger "Part 2 design input (S2)" and the opt-out ENV input | VSCodium; Writer and Mousepad at 2×; Calc cells (absent from the tree); the update-check opt-out on the wire; hit-test latency (a tree-only snapshot takes 83 ms to 2.3 s) |
| D4 | Gate topology and keyd bind address | Each cell sits alone on an isolated-gateway internal network (D14). Its gate (socat as `nobody`) is on that network and on its own egress bridge. The relay to keyd listens only on the gate's internal-network address and forwards outbound TCP to `host.docker.internal:<the cell's keyd port>`; the inbound relay is reachable only through the port published on 127.0.0.1 (`-p 127.0.0.1:<port>:…` on the gate), which Docker delivers through the egress bridge. **keyd listeners bind `127.0.0.1`.** keyd knows the cell by listener port plus a per-cell `Proxy-Authorization` token: relayed traffic arrives from 127.0.0.1, and any container with egress can reach the listeners. | S3 "Result", "Run 2" (`cell -> gate -> host listener (127.0.0.1)` ok, failures 0), "Docker Desktop surprises" 3; `spikes/s3-network/run.sh` (the gate starts on its egress network with the published port, then joins the internal network); S4 "keyd requirements in iron-proxy 0.52.0" (Per-listener identity: the S4 desktop on the default bridge reached the listener with no gate); ledger "Task 2: design note for Part 2", "Part 3 (keyd) design inputs from S4" | Relay bind addresses (untested: S3's socat relays listened on every interface); cell DNS failures take ~10 s (musl); `host.docker.internal` resolves to an IPv6 ULA first; the VM-listener probe set was a lower bound |
| D5 | keyd data plane | **Our own on goproxy (`elazarl/goproxy`)**, not iron-proxy per cell: iron-proxy 0.52 lacks 4 of keyd's 7 requirements (selective MITM, response scrubbing, per-listener identity, unknown-surrogate block). Adapt from iron-proxy (Apache-2.0): the dial-time check in `net.Dialer.Control`, the Basic-auth-aware header swap, the SNI = Host check, the audit shape. Port S4's `run.sh` and `chromium.sh` probes as acceptance tests. | S4 "Result", "keyd requirements in iron-proxy 0.52.0", "Surprises"; Ruling 28; ledger "Part 3 (keyd) design inputs" from S4 and from S5 | goproxy's per-host MITM; the upstream-TLS verification rule; a decision hook |
| D6 | Response scrubbing needed | **Yes.** An echo service reflected the swapped real value (a dummy) back into the cell, and iron-proxy's response transform is a no-op. | S4 "keyd requirements in iron-proxy 0.52.0" (Response scrubbing), "Run 2", "Run 3" | The scrubber (plain, base64, URL-encoded, hex); a value split across streamed chunks; compressed bodies |
| D7 | Selective MITM available | **No in iron-proxy** (`tls.mode` is process-wide: `mitm` breaks every host outside the CA's name constraints, `sni-only` swaps nothing), **so keyd builds it**: terminate only hosts that need a swap or HTTP policy, with the per-cell name-constrained CA, and pass the rest through with an SNI check. Chromium 154 trusts the constrained CA once it is in NSS and enforces the constraints (`--proxy-server`, `--disable-quic`). | S4 "keyd requirements in iron-proxy 0.52.0" (Selective MITM), "Step 5: Chromium and the cell CA" (example.com: "Not permitted by name constraints") | goproxy's per-host MITM; clients other than Chromium and curl; `certutil` (libnss3-tools) is not in the image |
| D8 | Timing compensation constant | **No single constant.** The click ring means "input delivered" and starts at the XI2 raw-press time + C, the p99 raw-press → frame latency for that injector and scale. Own XTest: clicks **19.6 ms (1×) / 23.1 ms (2×)**, keys **19.1 / 29.3 ms**. Driver, fallback only: clicks 18.4 / 26.4 ms, keys 17.4 / 24.4 ms. The brief's line (xdotool key, send → frame, n = 50): p50 11.4 / 17.5 ms, p95 18.9 / 27.3 ms, so the 1× target p95 ≤ 80 ms is met. | S6 "Result", "Ring onset per injector", "Injection to frame: the brief's measurement"; Rulings 24, 26 | n = 50–120, so each p99 is the sample maximum and ~1–2 % of dispatches may ring early by an unbounded amount: re-measure ≥ 500 trials per injector and scale on target hardware; busy screens; other apps and input kinds |
| D9 | Coordinate space per model | Generic `computer` tool: **declare a 0–1000 grid for Gemini and Qwen**, which both answer on it even when told pixels, and send `coordinate` as a length-2 number array, not `z.tuple`. Native Anthropic and OpenAI tools: screenshot pixels at 1280×800, still an assumption. Codex through localDot's MCP `click`: screen pixels, as the tool declares. Model space = device px ÷ S. See the table below. | S5 "Coordinate space per model", "Results"; S7 "Click result"; S2 "Canonical space and one transform per toolkit"; foundation Ruling 15 (`per1000` also serves Gemini's 0–999, error ≤ 1.3 px) | Anthropic and OpenAI (no API credit); the production models of success criterion 2; Google's native computer tool |
| D10 | Streaming intent per provider | **Dispatch when each action's tool call completes**, for every provider: parsing partial input gained 0 ms on every measured route. `tool-input-start` (about 1.1 s early on LM Studio) may start an "aiming" state; it carries no coordinates. See the table below. | S5 "When the coordinates arrive", "Timing"; S7 "Images in MCP tool results", "Latency"; ledger "Spec/Part 2+4 design inputs (S5)" | Anthropic and OpenAI on the wire (SDK source only) |
| D11 | Codex harness | **Ship in M8** (GO-WITH-CHANGES), with the requirements in A16. Codex's app-server, inside srt and signed in with ChatGPT Plus, drove localDot's MCP `screenshot` and `click` and hit Gamma's centre in 2 of 2 turns; every model request went to `chatgpt.com:443`; the one file write was declined. | S7 "Result", "Approvals", "srt", "M8 design inputs"; Rulings 29, 30; ledger "M8" design inputs | Separate login and token refresh under srt; `apply_patch` and sub-agents can't be switched off in Codex 0.154; plan usage on localDot's own Codex home |
| D12 | Input injection path | **`desktopd`'s own XTest client** for pointer and keys. It activates windows with `_NET_ACTIVE_WINDOW` and waits for the change as an event (no `--sync` polling), sends press and release with no click delay, and takes each injection time from its own XI2 raw-event listener (`xinput` or python-xlib in the image). Cua Driver input is a fallback only, launched with `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0`. | S6 "Input paths (Ruling 19)", "Fair comparison (fix round 1)" (own XTest presses ~10–13 ms and releases ~48 ms sooner; the driver holds a click ~37 ms), "The driver's 800 ms post-action watch" (why S2's calls took ~870 ms); Rulings 25, 26 | Typing into a background window; click-hold length (1–37 ms untested); scroll, drag, double click; the client itself (S6 used xdotool without `--sync` as the stand-in) |
| D13 | Per-toolkit coordinate mapping | Canonical space = **desktop device px** (the X root); `desktopd` maps every frame with its toolkit's transform, then model = device ÷ S. GTK3 apps: device = windowOrigin + (frame − floor(windowOrigin / g)) × g. LibreOffice, GTK-drawn parts: frame × g. LibreOffice, VCL-drawn parts: (frame + (0, m)) × g, a per-role workaround; treat these frames as unreliable. Chromium browser chrome: frame × c. Chromium web content: CDP box (CSS px) × c + the content area's device origin. Never use the driver's `screenshot_frame`. On the product desktop (2×, g = 2, c = 2) native frames are already in model units. | S2 "Canonical space and one transform per toolkit", "2× coordinate space (Ruling 16)"; Ruling 19; ledger "Part 2 design input (S2): exact GTK-scaled mapping" | The CDP transform (unmeasured); `in_web_content` also appears on LibreOffice nodes; Electron apps (VSCodium) |
| D14 | Network creation flags | **`docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated`** for every sandbox network. With plain `--internal` the cell reached Docker Desktop VM listeners (ports 55139 and 111) through its bridge gateway. | S3 "Result", "Run 1" (failures 2), "Run 2" (failures 0); ledger "Carry to Task 6 and Part 2", "Spec amendment" (trust rule 1) | Engines other than 29.2; IPv6 (the sandbox networks were IPv4-only); UDP and `[::]` VM listeners |
| D15 | Cell capabilities (NET_RAW) | **Drop `NET_RAW` in every cell**, and all capabilities where possible (the spec already drops all for the brain, gate and browser cells). | ledger "Part 2 design input" (NET_RAW): "cells run with --cap-drop NET_RAW (or ALL where possible) — raw frames on the isolated bridge are unprobed; verify with arping from a cell in isolated mode" | Whether raw frames cross the isolated bridge (run arping from a cell); the desktop's minimal capability set |
| D16 | Auth model | **Cookie-free.** HTTP accepts the install token only as `Authorization: Bearer`. WebSockets offer `localdot.v1, localdot.token.<t>`, and the server selects only `localdot.v1`. The UI gets the token from a `#token=` fragment into origin-scoped storage. The Host guard checks the raw Host header and the URL host, plus Origin; an empty or short token never matches; the token file is 0600. | Foundation Rulings 19–22; ledger "Spec amendments (for T9, from the foundation rulings)"; `apps/daemon/src/guard.ts`, `apps/daemon/src/event-stream.ts` | The UI's `#token=` bootstrap (Part 2) |
| D17 | Default ports | **4750** daemon and UI (`LOCALDOT_PORT` overrides), **4751** brain tool API, **4760–4789** keyd listeners. Spikes use 4790–4799. | Foundation Ruling 18: "ports move to a free block — daemon/UI 4750, brain tool API 4751, keyd listeners 4760–4789 (4700 and 4734 are in use on this Mac)"; ledger "Spec amendment" (ports): "verified: 4700 and 4734 are taken by other local node servers; 4750–4789 free"; `apps/daemon/src/port.ts` | Free on other Macs (`doctor` checks); the avatar sub-project uses 4752–4753 during development |
| D18 | UI direction | **C: Theatre**, the user's pick on 2026-09-30. A near-black surround and a large lit stage; one accent, xenon `#3FB5DE`, only while the agent has control; the status HUD on the picture; a narration caption under the stage; chat and plan/steps in quiet side rails; the mascot bottom-left outside the stage; "looking at" as a neutral dashed outline; every colour a CSS token. | UI decision "Decision", "C: Theatre"; ledger "Part 2 design input (UI direction)": "decided 2026-09-30 per docs/superpowers/design/2026-09-30-localdot-ui-directions/README.md 'Decision': C: Theatre"; Ruling 17: "the foundation peer runs the spec's UI direction gate now (mockups in the umbrella repo docs + a private artifact for the user); Part 2 takes the user's pick as decided and drops its own direction task" | Rail readability over long sessions (the mockup's main weakness); the HUD's blur over video on M1-class hardware |

g is `Gdk/WindowScalingFactor`, c is Chromium's device scale factor (X11 window width ÷ its root frame width), m is
LibreOffice's native menu-bar height in frame units, and S is the desktop scale (S2 "Canonical space and one transform
per toolkit").

### Per provider: coordinate space and when the coordinates arrive (D9, D10)

| Route (model, tool) | Coordinate space | When the coordinates arrive | Status |
|---|---|---|---|
| Gemini API, `gemini-3.1-flash-lite`, generic tool | 0–1000 in 8 of 8 calls, 4 of them told pixels | The whole `functionCall` in one SSE chunk: `tool-input-start`, the coordinate and `tool-call` within 1 ms, 0.62–1.92 s after the request | Measured (S5) |
| Gemini API, `gemini-3.5-flash-lite`, generic tool | 0–1000 in 2 of 2 | The same | Measured (S5) |
| LM Studio, `qwen/qwen3.8-27b`, generic tool | 0–1000 in 7 of 8; told pixels it once answered in pixels, so never say pixels | `tool-input-start` 1.04–1.13 s before the arguments, which arrive in one chunk with `tool-call`; a cold step (any new screenshot) takes 8.3–10.8 s to the tool call | Measured (S5) |
| Anthropic `computer_20250124` (Haiku 4.5, display 1280×800) | Screenshot px, assumed | The SDK forwards each `input_json_delta`, so the input streams | Unverified: no credit; SDK source |
| Anthropic `computerToolset_20260801` (5.x models such as Sonnet 5.5) | Screenshot px, assumed | The SDK buffers each action's input until `content_block_stop`; each action is its own `tool_use` block | Unverified: no credit; SDK source; @ai-sdk/anthropic 4.0.69 doesn't list Sonnet 5.5 yet |
| OpenAI Responses `computer` (`gpt-6-luna`) | Screenshot px, assumed | No argument deltas: the whole input, all batched actions included, at `response.output_item.done` | Unverified: no credit; SDK source |
| Codex on a ChatGPT plan (`gpt-6-astra`), localDot MCP `click` | Screen px as the tool declares (1280×800): exact centre in 2 of 2 | The arguments arrive whole in `item/started`; code mode runs the call 26–33 ms before the model response completes | Measured (S7) |
| Gemini on Vertex | Not tested | @ai-sdk/google streams partial arguments only on Vertex | Not tested |

## 2. Spec amendments

Quoted text is the spec's current wording, with line breaks joined. Amendments follow the spec's order, and each names
the decision it carries. **The user signed off A1 on 2026-10-01 ("keep").** A17's dwell clause and A30, A33 and
A34's `doctor` check are derived here from the findings rather than from a ruling: the controller accepts or drops them.

**A1. Success criterion 3, truthful visualization. Signed off by the user, 2026-10-01** (D8)

Now:
> In recorded sessions the drawn cursor is within 2 px of every real input point, and no effect appears before the
> frame on which the input lands.

New (Ruling 24's wording):
> In recorded sessions the drawn cursor is within 2 px of every real input point, and no effect appears before the
> input is delivered, and at most one frame before the frame that shows a press-acting control's change.

Why: raw press → frame latency varies per trial (own XTest clicks at 1×: p5 6.0 ms, max 19.6 ms), so no fixed onset
can promise "never before the frame". With C = p99, rings were early at most once per group of 50–120 trials, by up to
10.8 ms, and never more than a frame late on press-acting controls. Release-acting controls change at release, which
fits "delivered, not succeeded". This relaxes a criterion the user agreed to, and until Part 2's ≥ 500-trial
re-measure about 1–2 % of rings may be early by more. (S6 "Ring onset per injector"; Rulings 24, 26)

**A2. Components table: the gate and Codex rows** (D4, D11)

Now (gate row, Language column):
> socat or haproxy

New:
> socat; the relay to keyd listens only on the gate's internal-network address, and the inbound relay is reachable only
> through the port published on 127.0.0.1

Now (Codex harness row, Holds column):
> the user's ChatGPT login, owned by Codex in the Keychain

New:
> the user's ChatGPT login, signed in separately for localDot and kept by Codex in a localDot-owned `CODEX_HOME` (S7
> found the login in `auth.json` there; Keychain storage is untested)

Why: S3 relays with socat, which otherwise listens on every interface, the egress side included (ledger "Task 2: design
note for Part 2"; `spikes/s3-network/gate/relay.sh`); the published inbound port arrives through the gate's egress
bridge (`spikes/s3-network/run.sh`). S7 "Sign-in mode", "Result" change 4.

**A3. Trust rule 1: isolated-gateway networks, gate relays, proxy token** (D4, D14)

Now:
> Each cell sits alone on an `--internal` Docker network: no default route and no external DNS. Its gate, which has its
> own egress bridge network, relays outbound TCP to one keyd listener reserved for that cell, so the port identifies the
> cell.

New:
> Each cell sits alone on an internal Docker network created with
> `docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated`: no default route, no
> external DNS and no reachable gateway address (with plain `--internal`, Docker Desktop VM listeners answer on the
> bridge gateway). Its gate, which has its own egress bridge network, relays outbound TCP to one keyd listener reserved
> for that cell; that relay listens only on the gate's internal-network address, and the gate's inbound relay is
> reachable only through the port published on 127.0.0.1. The port identifies the cell and a per-cell
> `Proxy-Authorization` token proves it, because any container with egress can reach keyd's 127.0.0.1 listeners through
> `host.docker.internal`.

Why: S3 "Run 1" against "Run 2", "Docker Desktop surprises" 1 and 3; `spikes/s3-network/run.sh` (the published inbound
port arrives through the gate's egress bridge); S4 "keyd requirements in iron-proxy 0.52.0" (Per-listener identity);
ledger "Spec amendment" (trust rule 1), "Task 2: design note for Part 2" (the relay to keyd), "Part 3 (keyd) design
inputs from S4".

**A4. Trust rule 6: cookie-free auth** (D16)

Now:
> The daemon binds 127.0.0.1, requires a per-install token and checks Host and Origin against DNS rebinding.

New:
> The daemon binds 127.0.0.1 and requires a per-install token that never travels in a cookie (cookies are not
> port-isolated, so one would reach any localhost service, published cell ports included). HTTP accepts it only as
> `Authorization: Bearer <token>`; WebSockets offer the subprotocols `localdot.v1, localdot.token.<token>` and the
> server selects only `localdot.v1`; the UI receives it in a `#token=` URL fragment and keeps it in origin-scoped
> storage. Against DNS rebinding the daemon checks Origin and both the raw Host header and the URL host.

Why: foundation Rulings 20 and 22; ledger "Spec amendments (for T9, from the foundation rulings)";
`apps/daemon/src/guard.ts`, `apps/daemon/src/event-stream.ts`.

**A5. Trust rule 7: what confines the Codex harness** (D11)

Now:
> It runs inside Anthropic's `sandbox-runtime` (Seatbelt) with network access only to OpenAI and to localDot's MCP
> endpoint and file access only to its own folder. localDot declines every approval request for Codex's built-in shell
> and patch tools, so its only hands are localDot's MCP tools, which run through the action gateway like any other
> action.

New:
> It runs inside Anthropic's `sandbox-runtime` (Seatbelt) with network access only to OpenAI and to localDot's MCP
> endpoint; it can write only to its own localDot-owned Codex home and out folder, and read under `~` only that home and
> the Codex binary. Declining approvals is not enough, because Codex runs a model-chosen command in its own sandbox
> without asking. So localDot starts Codex with its command tools disabled (sub-agents included), declines every file
> change and accepts approval prompts only from its own MCP server. Codex's only hands are then localDot's MCP tools,
> which run through the action gateway like any other action. The harness requirements are listed under "Subscription
> sign-in".

Why: S7 "Result" changes 1, 4 and 5, "srt" (file scope: the brief's settings could read the whole disk and write the
user's live `~/.codex`); Ruling 30; ledger "M8" design inputs.

**A6. Ports** (D17)

Now:
> Ports: UI and daemon API on 4700, the brain's tool API on 4701, keyd listeners from 4710.

New:
> Ports: UI and daemon API on 4750 (`LOCALDOT_PORT` overrides it), the brain's tool API on 4751, keyd listeners
> 4760–4789.

Why: foundation Ruling 18 (4700 and 4734 are used by other local servers on the development Mac; 4750–4789 were free);
`apps/daemon/src/port.ts`.

**A7. One click, step 1: dispatch on the completed call** (D10)

Now:
> The model streams a `computer` tool call. As soon as the coordinates parse, the brain forwards the call to the
> gateway, while the rest of the call is still streaming.

New:
> The model streams a `computer` tool call. When each action's call completes, the brain forwards it to the gateway.
> Where the provider announces the call early (`tool-input-start`), an "aiming" state can start before any coordinates
> exist.

Why: S5 "When the coordinates arrive" (on every measured route the coordinates arrive with the complete call; partial
input gained 0 ms); S7 "Images in MCP tool results" (Codex sends arguments whole); ledger "Spec/Part 2+4 design inputs
(S5)".

**A8. One click, step 4: the ring onset** (D8, D12)

Now:
> When the planned travel ends, the gateway tells `desktopd` to inject the input and appends `action.dispatch`. The
> click ring starts on the same frame.

New:
> When the planned travel ends, the gateway tells `desktopd` to inject the input and appends `action.dispatch` with the
> XI2 raw-press time `desktopd` returns. The click ring starts at that time plus the injector's per-scale p99
> press-to-frame latency (see Clock), so it means "input delivered".

Why: S6 "Ring onset per injector"; Rulings 24, 25, 26.

**A9. Display: 2× with HiDPI XFCE** (D2)

Now:
> It renders at 2× (2560×1600) for a crisp stream if spike S1 shows the encoding cost is acceptable, otherwise at 1×.

New:
> It renders at 2× (2560×1600) with HiDPI XFCE — `Gdk/WindowScalingFactor` 2 with `Xft/DPI` 96, the `Default-xhdpi`
> xfwm4 theme and a doubled panel — and 1× stays a switchable fallback.

Why: S1 "Result", "2× rendering" (XFCE does not scale by itself: the panel is half-height and title bars clip); S2 "2×
coordinate space (Ruling 16)"; ledger "Part 2 design input" (S1).

**A10. Accessibility on: one session bus** (D3)

Now:
> **Accessibility on:** AT-SPI bus, `GTK_MODULES=gail:atk-bridge`, `QT_ACCESSIBILITY=1`, Chromium
> `--force-renderer-accessibility`.

New:
> **Accessibility on:** AT-SPI bus, `GTK_MODULES=gail:atk-bridge`, `QT_ACCESSIBILITY=1`, Chromium
> `--force-renderer-accessibility`, and exactly one session D-Bus, with AT-SPI pinned to the XFCE session's bus (the base
> image's second, autolaunched bus can take over the accessibility bus). Thunar opens in List View (its icon view has no
> items in the tree) and Chromium runs maximized.

Why: S2 "Result" change 3, "Setup that was needed"; ledger "Part 2 design input (S2)".

**A11. Stream: Selkies' own client, frames from its track** (D1, D2)

Now:
> **Stream:** Selkies 2.0 in WebSocket mode — H.264 over one TCP port, decoded by WebCodecs in the browser — with
> `SELKIES_ENABLE_CURSORS=false` and a fixed resolution.

New:
> **Stream:** Selkies 2.0 in WebSocket mode — H.264 over one TCP port, decoded by Selkies' own client with WebCodecs —
> with `SELKIES_ENABLE_CURSORS=false` (no pointer in the frames at 1× or 2×) and a fixed resolution. The stage takes
> every decoded frame from a `MediaStreamTrackProcessor` on a clone of the client's `<video>` track; localDot has no
> decoder of its own. Selkies encodes only on damage, so a still screen sends no frames.

Why: S1 "Result", "Step 2 facts", "Step 6: frame tap", "fps: why the panel reads about 25 during `load.sh`"; Ruling 14.

**A12. `desktopd`: perception from Cua Driver, input from our own XTest** (D3, D12, D13)

Now:
> It wraps Cua Driver (MIT, pinned, its own synthetic cursor turned off) for the accessibility tree, XTest input,
> windows and screenshots, and adds a shell (pty), file access and CDP for Chromium.

New:
> It wraps Cua Driver (MIT, pinned, run as `cua-driver mcp --no-overlay` with telemetry and update checks off) for the
> accessibility tree, windows and screenshots, and maps every element frame into desktop device pixels with one
> transform per toolkit. Pointer and keys go through `desktopd`'s own XTest client, which activates windows itself, and
> an XI2 raw-event listener timestamps every injection. It adds a shell (pty), file access and CDP for Chromium, which
> also supplies web-page boxes.

Now (API table):
> | `input(Input)` | the injection timestamp |

New:
> | `input(Input)` | the injection timestamp: the XI2 raw-event time of the press (the same listener can drive `text.progress`) |

Why: S2 "Result" (only `mcp --no-overlay` keeps the driver's cursor out of the X root), "Canonical space and one
transform per toolkit"; S6 "Result" changes 1, 2 and 4 (neither path returns an injection timestamp); Rulings 25, 26.

**A13. Hardening: drop NET_RAW** (D15)

Now:
> Default seccomp, no added capabilities, pids, memory and CPU limits, no `docker.sock`.

New:
> Default seccomp, `NET_RAW` dropped, no added capabilities, pids, memory and CPU limits, no `docker.sock`.

Why: ledger "Part 2 design input" (raw frames on the isolated bridge are unprobed; verify with arping from a cell).

**A14. Models: the coordinate module** (D9)

Now:
> One coordinate module converts each provider's space — screenshot pixels, 0–999, 0–1000 — to screen pixels, with a
> probe-image test for every model that can drive the screen.

New:
> One coordinate module converts each provider's space — screenshot pixels, or the 0–1000 grid, which also serves
> Gemini's 0–999 — to screen pixels, with a probe-image test for every model that can drive the screen. Gemini and Qwen
> answer on the 0–1000 grid even when told pixels, so the generic tool declares that grid for them.

Why: S5 "Coordinate space per model"; foundation Ruling 15; `packages/providers/src/coordinates.ts` (`per1000`).

**A15. Catalog: the generic `computer` tool's schema** (D9)

Now:
> **vision and tool calling:** uses localDot's generic `computer` tool, with Anthropic-style actions and screenshots
> sent as images;

New:
> **vision and tool calling:** uses localDot's generic `computer` tool, with Anthropic-style actions, a `coordinate`
> that is a length-2 number array (`z.array(z.number()).length(2)`; Gemini rejects `z.tuple`), the 0–1000 grid for
> Gemini and Qwen, and screenshots sent as `file` parts (the `image` part is deprecated in AI SDK 7);

Why: S5 "Result", "Blocked", "Changes from the brief"; ledger "Spec/Part 2+4 design inputs (S5)".

**A16. Subscription sign-in: the Codex harness requirements** (D11)

Now:
> Codex keeps the login in the OS credential store and refreshes it itself (learn.chatgpt.com/docs/app-server and
> /docs/auth).

New:
> Codex keeps the login in its home and refreshes it itself (learn.chatgpt.com/docs/app-server and /docs/auth); in S7
> it lived in `CODEX_HOME/auth.json`. The harness gets its own localDot-owned `CODEX_HOME` and its own sign-in
> (`account/login/start`), never the user's `~/.codex`.

Now:
> Spike S7 proves the path.

New:
> Spike S7 proved the path (GO-WITH-CHANGES). The harness requirements:
> - **Process:** `srt --settings <localDot settings> -- codex app-server --listen stdio://`, spawned with `cwd` set to
>   the folder its settings' relative paths assume. The `--` is required: without it srt runs Codex's first `-c` value
>   as a shell command. Pin the Codex version and check `codex app-server generate-json-schema` on every upgrade.
> - **No command tools:** `--disable shell_tool --disable unified_exec --disable view_image` removes `exec_command`,
>   `write_stdin` and `view_image`, for sub-agents too. `apply_patch` and the `collaboration.*` sub-agent tools can't
>   be switched off in 0.154, so every file change is declined and sub-agents are capped or removed. `spawn_agent` takes
>   a model override: verify, or forbid, sub-agent tool sets under other models.
> - **TLS:** `CODEX_CA_CERTIFICATE=<PEM bundle>`, because srt blocks `com.apple.trustd.agent`. Never
>   `enableWeakerNetworkIsolation`, which re-opens trustd.
> - **Own home and login:** a localDot-owned `CODEX_HOME` with its own ChatGPT sign-in, never the user's `~/.codex`,
>   whose relay base URL, MCP servers, plugins, connectors, turn-end `notify` program, `approval_policy = "never"` with
>   `danger-full-access` and skills would leak into the harness. Disable `shell_snapshot`, which runs the user's login
>   shell at every thread start.
> - **Environment:** spawn Codex with a scrubbed environment; the daemon's may hold provider keys.
> - **Files:** srt `allowWrite` only that Codex home and its out folder; `denyRead: ["~"]` with `allowRead` for that
>   home and the Codex binary (re-allowed explicitly if the home is under `~/.localdot`).
> - **Network:** OpenAI (`chatgpt.com:443`, plus `auth.openai.com` for token refresh) and localDot's MCP endpoint only;
>   choose between a loopback port and a Unix socket allowlisted in srt.
> - **Thread:** `approvalsReviewer: "user"`, `sandbox: "read-only"`, `ephemeral: true`.
> - **Server requests:** accept `mcpServer/elicitation/request` only when `serverName` is exactly `localdot`, the mode
>   is not `url` and `_meta.codex_approval_kind` is absent or `mcp_tool_call`, replying with the schema's explicit
>   defaults only (never a boolean defaulted to true). Decline `item/fileChange/*` and `item/commandExecution/*`.
>   Answer every `item/tool/requestUserInput` with `[]` or an exact deny label, never a first-match label search (it
>   can pick "Allow (no further prompts)"). Keep `tool_call_mcp_elicitation` on.
> - **Usage:** a two-action turn used about 6 points of the Plus 5-hour window (about 16 turns or 65 model steps per
>   window); show `account/rateLimits/*` in the UI.
> - **Events:** map Codex's thread, turn and item events as in S7 "Mapping onto localDot's event log".
> - **Tests:** mock-provider probes use a throwaway `CODEX_HOME` and override `chatgpt_base_url` as well.

Why: S7 "Result", "Sign-in mode", "Approvals", "srt", "Cost", "M8 design inputs"; Rulings 29, 30; ledger "M8"
design inputs (all three entries).

**A17. Timing: dwell and when the intent is emitted** (D10)

Now:
> Travel is `T = clamp(150 + 100·log2(D/W + 1), 220, 700) ms ÷ speed` (D = distance; W = target width, 24 px when the
> target is unknown), then a 90 ms dwell, then the press.

New:
> Travel is `T = clamp(150 + 100·log2(D/W + 1), 220, 700) ms ÷ speed` (D = distance; W = target width, 24 px when the
> target is unknown), then a dwell of 90 ms ÷ speed (45 ms at Fast), then the press.

Now:
> Emitting the intent while the model is still streaming the rest of its tool call hides most of the travel inside
> model latency.

New:
> The intent is emitted when the action's tool call completes: on every measured route the coordinates arrive with the
> complete call, so cursor travel is not hidden inside model latency and adds its own time to each GUI action.

Why: foundation Ruling 17 and `packages/stage/src/travel.ts` (`dwellMs` divides by speed; derived: the spec should say
so); S5 "When the coordinates arrive".

**A18. Clock: per-injector p99 onset and clock mapping** (D8, D12)

Now:
> The roughly constant encoder delay between "input injected" and "the frame showing it arrives" is measured in spike S6
> and compensated, so the click ring lands on the right frame.

New:
> The delay between an input's XI2 raw press and the arrival of the frame that shows it varies per trial, injector and
> scale (own XTest clicks at 1×: p5 6.0 ms, p50 9.6 ms, max 19.6 ms). So the click ring means "input delivered" and
> starts at the raw-press time plus that injector's per-scale p99 (on the development Mac, own XTest: clicks 19.6 ms at
> 1× and 23.1 ms at 2×, keys 19.1 and 29.3 ms), re-measured with at least 500 trials per injector and scale on target
> hardware. `desktopd`'s clock is mapped to the daemon's with a periodic lowest-RTT ping: they differ by about a
> millisecond and drift up to 1 ms within 20–45 s.

Why: S6 "Result" changes 3 and 5, "Ring onset per injector", "Method"; Rulings 24, 26.

**A19. Event log: rebuildable index, one writer** (foundation)

Now:
> Append-only JSONL per session plus an SQLite index (`node:sqlite`).

New:
> Append-only JSONL per session plus an SQLite index (`node:sqlite`) that can be rebuilt from the session folders, so
> session metadata (title, start time) lives in the session folder, not only in the index. One daemon writes: it binds
> its port (or takes a lock) before opening the log. Appends are failure-atomic and survive a process crash, not a
> power loss (no fsync).

Why: ledger "Part 2 design inputs (foundation)"; foundation ledger "Part 2 design inputs (from T14 re-review)",
foundation Rulings 24–26.

**A20. Rendering: frames from the track, uploaded per new frame** (D1)

Now:
> WebCodecs decodes in a worker.

New:
> Selkies' client decodes with WebCodecs; a `MediaStreamTrackProcessor` on a clone of its video track hands each
> `VideoFrame` to the render worker, which uploads it once per new frame, never per `requestAnimationFrame` (at 2× a
> per-`requestAnimationFrame` upload took Chrome's GPU process from 7–9 % to 31–40 % of a core).

Why: S1 "Result" change 3, "Step 6: frame tap"; ledger "Part 2 design input" (S1).

**A21. keyd per-cell listener: token, per-host interception, inner-request policy** (D4, D7)

Now:
> **Per-cell listener:** an explicit HTTP proxy (CONNECT) on its own port. For hosts that need a swap or HTTP-level
> policy, keyd terminates TLS with a per-cell, name-constrained CA that exists only in memory. Other allowed hosts pass
> through with an SNI = CONNECT-host check. Everything else gets 403.

New:
> **Per-cell listener:** an explicit HTTP proxy (CONNECT) on its own port that requires the cell's
> `Proxy-Authorization` token. Interception is chosen per host: for hosts that need a swap or HTTP-level policy, keyd
> terminates TLS with a per-cell, name-constrained CA that exists only in memory (Chromium enforces its constraints);
> other allowed hosts pass through untouched with an SNI = CONNECT-host check. Policy follows the inner request, not the
> CONNECT, because a plain-HTTP request inside a tunnel can name another host. Everything else gets 403.

Why: S4 "keyd requirements in iron-proxy 0.52.0" (Selective MITM, Per-listener identity), "Step 5: Chromium and the
cell CA", "Surprises" 2; ledger "Part 3 (keyd) design inputs from S4".

**A22. keyd swap rules: https-only exact binding, exact header match** (D5)

Now:
> Exact host match, only after verified upstream TLS and a check of the connected IP. Header-only by default.

New:
> Each surrogate is bound to scheme `https`, port 443 and an exact host, so a plain `http://` request to a bound host
> never carries the real value; the swap happens only after verified upstream TLS and a check of the connected IP,
> whatever the request method. Header-only by default, and the surrogate must match its bound header exactly, not as a
> substring.

Why: S4 "keyd requirements in iron-proxy 0.52.0" (Exact-host swap: `http://` to the bound host sent the real value in
cleartext; an unlisted method skipped `require`); ledger "Part 3 (keyd) design inputs" from S4 and from S5.

**A23. keyd SSRF guard: unspecified addresses and the Mac's own addresses, tracked live** (D5)

Now:
> **SSRF guard:** keyd resolves DNS itself, dials the checked IP and re-checks the connected peer against a deny set:
> loopback, RFC 1918, 100.64/10, link-local, ULA, Docker's 192.168.65/24 and the Mac's own addresses.

New:
> **SSRF guard:** keyd resolves DNS itself, dials the checked IP and re-checks the connected peer at dial time against
> a deny set: loopback, `0.0.0.0/8` and `::/128` (a dial to the unspecified address lands on loopback), RFC 1918,
> 100.64/10, link-local, ULA, Docker's 192.168.65/24, every address of every interface on the Mac (IPv4 and IPv6,
> rotating temporary IPv6 addresses included, refreshed whenever they change) and the prefixes of directly connected
> networks. keyd dials upstream directly, never through another proxy.

Why: S4 "keyd requirement: the SSRF deny set" (the Mac's own global IPv6 addresses passed a static list), "Surprises" 1,
"Config differences from the brief and the docs" 7; Ruling 28; ledger "Part 3 (keyd) design inputs from S4".

**A24. keyd LLM gateway: upstream failures** (D5)

Now:
> keyd attaches the real key in that provider's auth style, enforces a model allowlist and budgets (defaults $5 per
> task and $20 per day, editable), and fronts LM Studio and Ollama so no cell ever reaches them directly.

New:
> keyd attaches the real key in that provider's auth style, enforces a model allowlist and budgets (defaults $5 per
> task and $20 per day, editable), and fronts LM Studio and Ollama so no cell ever reaches them directly. An upstream
> failure gets a 502 and keyd keeps serving; a mid-stream upstream error ends the client's stream cleanly; and when the
> client disconnects, keyd aborts the upstream request so the provider stops generating and billing.

Why: S5 "Gateway (`swap-gateway.mjs`, as in the brief)" (the spike gateway crashed on a failed fetch); ledger "Part 3
(keyd) design inputs from S5".

**A25. keyd audit: aborted handshakes and SNI mismatches** (D5)

Now:
> **Audit:** one hash-chained JSON line per decision — time, cell, surrogate id (never the value), host, method, path,
> status, bytes, decision — under `~/.localdot/keyd/`, never mounted into a cell.

New:
> **Audit:** one hash-chained JSON line per decision — time, cell, surrogate id (never the value), host, method, path,
> status, bytes, decision — under `~/.localdot/keyd/`, never mounted into a cell. A TLS handshake the client aborts and
> an SNI/Host mismatch are decisions too.

Why: S4 "keyd requirements in iron-proxy 0.52.0" (Audit format: neither left an audit record).

**A26. keyd data plane: goproxy** (D5)

Now:
> **Data plane:** iron-proxy (Apache-2.0, Go) embedded if spike S4 shows it supports per-listener identity and a
> decision hook; otherwise our own on `elazarl/goproxy`, porting the substitution tests from Anthropic's `srt`.

New:
> **Data plane:** our own on `elazarl/goproxy`, porting the substitution tests from Anthropic's `srt` and S4's `run.sh`
> and `chromium.sh` probes. iron-proxy 0.52 lacks selective MITM, response scrubbing, per-listener identity and
> unknown-surrogate blocking; keyd adapts its dial-time deny check (`net.Dialer.Control`), its Basic-auth-aware header
> swap, its SNI = Host check and its audit shape (Apache-2.0).

Why: S4 "Result", "keyd requirements in iron-proxy 0.52.0".

**A27. What a cell holds: its proxy token** (D4)

Now:
> What a cell holds, in full: its proxy endpoint, the public half of its CA, its surrogates, base URLs, and (brain only)
> its tool-API token.

New:
> What a cell holds, in full: its proxy endpoint and proxy token, the public half of its CA, its surrogates, base URLs,
> and (brain only) its tool-API token.

Why: follows from A3 and A21.

**A28. UI direction: decided, C: Theatre** (D18)

Now:
> **UI direction gate** (start of M2): two or three visual directions as static mockups; the user picks one before the
> chrome is built.

New:
> **UI direction** (decided 2026-09-30): C: Theatre
> (`docs/superpowers/design/2026-09-30-localdot-ui-directions/c-theatre.html`). A near-black surround (`--void`
> `#0A0B0D`) and a large lit stage. One accent, xenon `#3FB5DE`, used only while the agent has control (stage rim,
> target, cursor stroke, click ring, caret, current step); Stop and done states stay neutral. The status HUD floats on
> the picture (backdrop blur, solid under `prefers-reduced-transparency`), and narration plays as a caption under the
> stage. Chat and plan/steps sit in quiet side rails that stay comfortable for long reading; the mascot slot is
> bottom-left outside the stage; "looking at" is a neutral dashed outline; every colour is a CSS token so a theme can
> restyle it.

Now (Milestones, M2 "Done when"):
> UI direction picked;

New:
> Theatre chrome built;

Also: the Interface layout sketch shows the status in the top bar; Theatre floats it on the stage as a HUD.

Why: UI decision "Decision", "C: Theatre", "Shared decisions and notes"; ledger "Part 2 design input (UI
direction)"; Ruling 17.

**A29. Setup: the URL the installer opens** (D16, D17)

Now:
> **Install:** `npx localdot` installs to `~/.localdot/`, starts keyd (as a LaunchAgent) and the daemon, pulls pinned
> images with progress shown in the browser, and opens `http://127.0.0.1:4700`.

New:
> **Install:** `npx localdot` installs to `~/.localdot/`, starts keyd (as a LaunchAgent) and the daemon, pulls pinned
> images with progress shown in the browser, and opens `http://127.0.0.1:4750/#token=<install token>`.

Why: A4 and A6.

**A30. Error handling: a still screen is not a stall** (D1; derived)

Now:
> | Video stalls for more than 500 ms | Overlays freeze and show "Reconnecting…"; the stream reconnects automatically; the gateway holds dispatch until frames flow again |

New:
> | The stream connection stalls for more than 500 ms | Overlays freeze and show "Reconnecting…"; the stream reconnects automatically; the gateway holds dispatch until the connection is back |

Why: Selkies encodes only on damage, so a still screen sends 0 fps and 0 Mbps; stall detection must watch the
connection, not frame gaps (S1 "fps: why the panel reads about 25 during `load.sh`"; S6 "Frame interval and the
stream's own frames"). No ruling covers this yet.

**A31. Pixel oracle: the ring test** (D8; follows A1)

Now:
> no click ring appears before the dispatch frame;

New:
> no click ring starts before the input's raw press, or more than one frame before the frame that shows a press-acting
> control's change;

Why: Ruling 26 (the pixel-oracle test allows at most one frame early); A1 is signed off (2026-10-01).

**A32. Security tests: the Codex harness** (D11)

Now:
> The Codex harness can reach only OpenAI and localDot's MCP endpoint, can't write outside its own folder, and never
> gets a built-in shell or patch approved.

New:
> The Codex harness can reach only OpenAI and localDot's MCP endpoint, can't write outside its own Codex home and out
> folder or read the rest of `~`, has no command tools (sub-agents included), never gets a patch approved, and accepts
> approval prompts only from the MCP server named exactly `localdot`.

Why: S7 "Result", "Approvals", "srt"; Ruling 30.

**A33. Licenses: the keyd data plane** (D5; derived)

Now:
> iron-proxy (Apache-2.0);

New:
> goproxy (its own license, checked when it is pinned); code adapted from iron-proxy keeps its Apache-2.0 notice;

Why: D5.

**A34. Risks and open questions: what the spikes settled** (D2, D3, D9, D14)

Now:
> Cua Driver changes fast. It is pinned and wrapped by `desktopd`.

New:
> Cua Driver changes fast. It is pinned, wrapped by `desktopd` and used for perception only; input goes through our
> own XTest client.

Now:
> Software H.264 at 2× on arm64 may be too heavy; 1× is the fallback.

New:
> Software H.264 at 2× costs 2.5–3× the container CPU of 1× (peak 251 % of a 400 % budget on an M3 Ultra); its cost on
> M1-class hardware is unmeasured, and 1× stays switchable.

Now:
> Docker Desktop's networking details (S3) decide the gate design.

New:
> The gate design needs Docker's isolated gateway mode for internal networks, verified on Engine 29.2 only; `doctor`
> checks that the engine honours it.

Now:
> Qwen's coordinate space is assumed to be 0–1000 until the S5 probe confirms it.

New:
> Anthropic's and OpenAI's computer tools are unverified (S5 had no API credit): their coordinate space and streaming
> are assumed until `PROBE_CASES=anthropic,openai node probe.mjs` runs. Qwen's 0–1000 grid is confirmed.

Why: S1 "Result"; S3 "Result"; S5 "Result", "Coordinate space per model"; Rulings 25, 26.

## 3. Risks that remain

### Models and providers

- **Anthropic and OpenAI computer use are unverified.** Both API accounts were out of credit (400 "credit balance is
  too low", 429 `insufficient_quota`), so their coordinate spaces, their streaming and the spec's default model (Sonnet
  5.5) are untested. Settle: after a top-up, in `spikes/s5-models` run `PROBE_CASES=anthropic,openai node probe.mjs`,
  then `ANTHROPIC_CU_MODEL=claude-sonnet-5-5 PROBE_CASES=anthropic node probe.mjs` for the toolset path. First make
  the probe's wire detector test each whole raw event (Anthropic `content_block_start.input`, OpenAI
  `response.output_item.added`), or it reports coordinates late; one zero-cost control request with an invalid tool
  type would show whether tools are validated before billing. (S5 "Result", "Blocked"; ledger "Carry to Task 9",
  "Note for the S5 re-run after a top-up")
- **Only the cheapest models were probed** (Ruling 8). The production models of success criterion 2 (Sonnet 5.5,
  GPT-6.1 Sol, Gemini 3.6 Flash) need their own probe-image check in Part 4. (S5 "Model choice (Ruling 8: cheapest
  model per provider)")
- **Google's native computer tool was not tested**; Gemini ran only through the generic tool. (S5 "Results")
- **Cold local steps are slow:** Qwen3.8-27B took 8.3–10.8 s to a tool call for every new screenshot on the M3 Ultra.
  (S5 "When the coordinates arrive")
- **Listed models can be retired:** `gemini-2.5-flash-lite` answers 404 for new users although models.dev lists it, so
  the picker must handle that. (S5 "Blocked")

### Hardware and timing

- **Everything was measured on an M3 Ultra**, far faster than the spec's M1-class target. Encode, decode, frame
  upload, raw press → frame latency and the 4 ms render budget all need re-measuring there. (S1 "Method"; S6 "Not
  covered")
- **The p99 onsets rest on small samples.** Own XTest has 50 clicks and 100 keys per scale (the driver 110 and 120), so
  each p99 is the sample maximum and about 1–2 % of future dispatches may ring early by an unbounded amount. Settle:
  Part 2 re-measures every injector and scale with ≥ 500 trials on target hardware, and the pixel oracle allows at most
  one frame early. (S6 "Ring onset per injector"; Ruling 26)
- **"Own XTest" was emulated** with xdotool (`windowactivate` without `--sync`, `click --delay 0`) and bare
  `xdotool key`; `desktopd`'s real client has to reproduce those timings. (S6 "Fair comparison (fix round 1)")
- **Not covered by S6:** busy screens (video, animation); apps other than Chromium and Mousepad; scroll, drag, double
  click and multi-character typing cadence; click holds between 1 and 37 ms; own XTest typing into a background window;
  why the driver's press → frame was shorter at 1×; the daemon's own chunk stamps (the page's receive stamp stood in).
  (S6 "Not covered")
- **Raw-event stamps run up to ~2 ms late:** the X server's own event time is 0.7–2.3 ms earlier than the logger's
  stamp, and a `desktopd` listener built the same way has the same bias. (S6 "Method")
- **Selkies sends extra same-content frames** 87–450 ms after each change. Anything that infers a change from stream
  frames (field calibration, a ring that waits for its frame) must check the content at the input point. (S6 "Frame
  interval and the stream's own frames")
- **The drawn cursor landing on the dispatch frame was not checked** (the spec's S6 asked for it; no stage existed
  yet). The Part 2 pixel oracle covers it. (spec "Spikes (M0)"; S6)

### Stream

- **The VNC fallback is unmeasured:** the brief's image was denied by its registry. (S1 "Step 7: VNC fallback")
- **Only Chrome 154 was measured.** There, Selkies' client feeds `<video>` from a `MediaStreamTrackGenerator`; other
  browsers get a `VideoTrackGenerator` in its worker or an `OffscreenCanvas`, so the frame tap differs per browser. (S1
  "Step 6: frame tap")
- **The tap ran inside Selkies' own dashboard page**, served through the proxy, not in a localDot page. Hosting
  Selkies' client in the stage (or in a same-origin frame) is untested. (S1 "Step 5: proxy", "Step 6: frame tap")
- **4:4:4 decodes in software** in Chrome (`SELKIES_VIDEO_FULLCOLOR=true`); 4:2:0 might decode in hardware, but that
  was not measured. (S1 "How the launcher settings landed"; ledger "Part 2 design input" (S1))
- **Per-new-frame upload and track-to-worker transfer costs were never isolated** (S1 sampled per
  `requestAnimationFrame` at 144 Hz), and the spec's 30 vs 60 fps runs were not done. (ledger Task 3 minors)
- **HiDPI settings against Selkies' own DPI:** Selkies set `Xft/DPI` to 192 when a viewer connected, and S2 measured
  the GTK ×2 desktop with no viewer connected. Check that the HiDPI settings survive a viewer connecting. (S2 "2×
  coordinate space (Ruling 16)", "Not covered")
- **A still screen sends no frames**, so stall detection cannot rely on frame gaps (A30). (S1 "fps: why the panel
  reads about 25 during `load.sh`")

### Desktop and perception

- **LibreOffice frames are unreliable.** VCL-drawn parts (toolbars, the sheet table, sheet tabs, document text) sit
  one menu-bar height too high, and no attribute marks them; Calc cells are not in the tree (`huge_container`); Calc
  and Writer windows with the same geometry return each other's elements. A Qt VCL build might report correct frames
  (untested). Settle: locate LibreOffice content from screenshots, or test the Qt plugin. (S2 "Trees and frame accuracy
  per app", "Not covered")
- **Hit tests can be slower than the cursor.** A tree-only snapshot takes 83 ms (terminal), 552–1181 ms (Calc, Writer)
  and 2.1–2.3 s (Chromium; a full Wikipedia tree 12 s). The spec's "`action.target` usually before the cursor arrives"
  holds only for small apps unless CDP, which is unmeasured, is fast. (S2 "Latency", "Trees and frame accuracy per app")
- **Not covered by S2:** VSCodium, Writer and Mousepad at 2×, background input through uinput. (S2 "Not covered")
- **Cua Driver quirks:** its wheel's README lists Linux x86_64 only, though the `aarch64-linux` binary works; telemetry
  is on by default and the update-check opt-out was not observed on the wire; `set_agent_cursor_enabled` does not keep
  its cursor off (only `mcp --no-overlay` does); LibreOffice's first-run dialogs are modal and must be dismissed in the
  image. (S2 "Result", "Input and the driver's cursor (Step 6)", "Setup that was needed")
- **Raw frames on the isolated bridge are unprobed** (D15). (ledger "Part 2 design input" (NET_RAW))

### Network and keyd

- **keyd's own data plane is untested:** goproxy's per-host MITM, the scrubber, the live own-address deny set and the
  upstream-TLS verification rule. S4's `run.sh` and `chromium.sh` probes are the acceptance tests to port. (S4
  "Result"; ledger Task 6 minors)
- **Only Chromium and curl were shown to trust the cell CA.** Node, Python, apt and git in the desktop are untested, and
  Chromium needs the CA in NSS through `certutil` (libnss3-tools), which the image lacks. (S4 "Step 5: Chromium and the
  cell CA")
- **Bound hosts and plain browsing:** with requests that lack the surrogate refused, a bound host can't be browsed
  normally (Chromium got 403). keyd must decide what a request to a bound host without a surrogate gets. (S4 "Step 5:
  Chromium and the cell CA")
- **Chromium's own background traffic** (Google update, accounts and connectivity checks: 61 allowlist rejections in 7
  headless starts) goes through the proxy; switch it off in the image or allow it. (S4 "Surprises" 4)
- **Cell DNS failures take ~10 s** (musl), which the boot self-test and its error messages must expect. (ledger "Task
  2: design note for Part 2")
- **The S3 probes are a lower bound:** VM listeners were probed on TCP `0.0.0.0` only (no `[::]`, single-address or UDP
  listeners), and isolated gateway mode was verified on Engine 29.2 only. (S3 "Result"; ledger Task 2 minors)

### Codex harness

- **The separate login and token refresh are untested.** Signing in through `account/login/start` into a
  localDot-owned `CODEX_HOME` needs a browser. The spike reused an existing login whose token stayed valid, so a
  refresh, which rewrites `auth.json` and calls `auth.openai.com`, never ran under srt. (S7 "Result" change 4, "Sign-in
  mode")
- **Some Codex tools can't be switched off** in 0.154: `apply_patch` and the `collaboration.*` sub-agent tools.
  Grandchild agents and `spawn_agent`'s model override were not probed. (S7 "Codex's built-in tools: what the model can
  call"; ledger "M8 design inputs (S7 re-review minors)")
- **Untested options:** `mcp_servers.<id>.default_tools_approval_mode` (to skip the prompts) and
  `sandboxPolicy: {type: "externalSandbox"}`. (S7 "M8 design inputs")
- **Usage was measured with a personal Codex config:** priority tier, and about 21k characters of personal skills in
  every request. Re-measure on localDot's own home with the default tier. (S7 "Cost")
- **The route from sandboxed Codex to the daemon's MCP endpoint** (a loopback port or a Unix socket allowlisted in srt)
  is undecided. (ledger "M8 design inputs (S7 minors)")
- **`codex app-server` is experimental** and its protocol is versioned by the CLI (the spike ran 0.154; the desktop app
  was already on 0.155). (S7 "M8 design inputs")

### Upstream churn

- **Selkies 2.0 is new and has effectively two maintainers, and Cua Driver changes fast.** Pin both, record full image
  digests (S1 and S2 recorded short ones), keep the stream client behind our own interface and Cua Driver behind
  `desktopd`, used for perception only. (spec "Risks and open questions"; ledger "Part 2 design input" (digests), Task
  3 minors)

### UI

- **Theatre's side rails** were the mockup's main weakness (slim grey type) and need a design that stays comfortable
  for long reading. The HUD's backdrop blur over live video is unmeasured on M1-class hardware. (UI decision
  "Decision", "Shared decisions and notes")

## 4. Notes for the user

- **Signed off 2026-10-01 ("keep"):** A1 changes success criterion 3. The click ring can start up to one frame before
  the frame that shows a press-acting control's change, because no fixed delay matches a latency that varies per trial.
- **Cua Driver telemetry:** Cua Driver sends content-free product telemetry by default (to a PostHog endpoint) and
  checks GitHub for updates. In S2's first container, `config` and `doctor` ran before telemetry was off, so one
  install-registration ping probably left that container; later containers disabled it first. Part 2 bakes the opt-outs
  into the image and confirms them on the wire. (S2 "Setup that was needed")
- **API credit:** the Anthropic and OpenAI API keys used for S5 are both out of credit, so the cloud computer-use paths
  for both stay unverified until they are topped up (the re-run commands are in section 3). S5 spent about $0.004 of
  Gemini credit. (S5 "Cost")
- **Codex config on the development Mac:** `~/.codex/config.toml` sets `openai_base_url` to a third-party relay, not
  OpenAI. In S7, Codex tried to reach it and srt blocked it. If that is not intentional, everyday Codex traffic, and
  probably its sign-in, goes through that relay. The host name is left out of this repo on purpose. (S7 "Result"
  change 4; ledger "Note for the user")
- **Plan usage:** S7's three real turns used 18 % of one ChatGPT Plus 5-hour window and 3 % of the weekly window. (S7
  "Cost")
