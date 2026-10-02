# localDot core platform — design spec (2026-09-30)

localDot is an open-source, localhost-first personal assistant. It works inside its own isolated
virtual computer, can do anything a PC can do, and shows exactly what it is doing, action by
action. Its keys are useless if they leak. This spec covers sub-project 1 of 3, the core
platform. The project will live in `Projects/localdot/` as its own git repo.

Research basis: seven reports in `docs/superpowers/research/2026-09-30-localdot/` — OpenAI dots
(`dot-openai.md`), xAI/Cursor Grok Bot (`grokbot-xai.md`), the Meta Muse key layer
(`security-key-layer.md`), sandbox environments (`environment-sandbox.md`), OpenClaw and
computer-use models (`openclaw-ecosystem-and-models.md`), visualization UX
(`visualization-ux.md`) and the avatar pipeline (`avatar-[avatar-name].md`). References like
"security §3.4" point into them. The M0 spikes (S1–S7, 2026-09-30 and 2026-10-01) then amended this
spec: each spike's findings are in the localdot repo's `spikes/<spike>/FINDINGS.md`, and
`docs/spikes/SUMMARY.md` there lists every amendment (A1–A34) with its evidence.

Sub-projects:
1. **Core platform** (this spec): virtual computer, agent, live view and replay, key layer.
2. **Avatar and themes:** the [avatar-name] pack (Spine 4.3 rig), voice in and out. Can start as soon
   as the avatar interface in this spec is agreed.
3. **Reach and routine:** chat channels (Telegram and others), schedules and proactive jobs,
   long-term memory.

## Intent

What the user asked for (2026-09-30):
- An open-source, localhost edition of what OpenAI's dots and xAI's Grok Bot do, "quite like
  OpenClaw but better at visualization": render a virtual computer with a macOS or Linux look and
  show in detail how the agent manipulates apps and UI.
- "Should do all sorts of things the PC can do — it's like a virtual assistant."
- Simple setup, robust at runtime, versatile, powerful at interacting with everything in its
  environment.
- A key layer like Meta Muse's: the bot holds a key that doesn't work without the key layer, so a
  leak is useless to anyone.
- A themeable, smoothly animated avatar; the first theme is [avatar-name] (sub-project 2).
- A real macOS guest is not required: "choose the most appropriate, suitable system for our app."
- Approach A: our own small core on the best open-source parts (not a fork of OpenClaw or Hermes,
  not a computer-only MCP service).
- Users choose the provider and model for the bot; all mainstream providers are supported through
  a mature open-source library. Claude Code or Codex subscription logins should work "if possible".
- UI and UX follow the apple-design skill.

What the research says the gap is:
- dots and Grok Bot both show a live cloud computer, but neither visualizes actions. Frame-by-frame
  analysis of their own videos shows the cursor teleporting, with no target highlights, click
  effects, typing display or replay (dot-openai "Where OpenAI is weak"; grokbot §2). Grok Bot
  de-emphasized watching on purpose: "The more prominent we made the computer, the more the
  product encouraged users to supervise it."
- Muse has the strongest key design — surrogate tokens that its Sentinel swaps for real credentials
  at the network boundary after authorizing each request — but it is closed (security §1).
- OpenClaw has the ideas users love, but its sandbox is off by default, it does not visualize
  actions, and it has a very poor security record (openclaw §1.5–1.7).

So localDot combines Muse-grade key isolation, truthful and cinematic action visualization, and a
fully local install, and it treats watching as optional: a glanceable status by default, a rich live
view when you look, a scrubbable replay afterwards.

Assumptions (stated to the user and not contested):
- The agent acts only inside its sandboxed computer, never on the user's real Mac, apart from an
  optional shared folder.
- Models are pluggable: cloud APIs protected by keyd, or local models through LM Studio.
- The code is public-ready open source. The [avatar-name]/[avatar-name] theme is a separate local pack that
  never enters the repo. The GitHub repo stays private until the user says otherwise.
- The main interface is a local web page.

### Success criteria
1. **Setup:** on a Mac with Docker Desktop running, `npx localdot` leads to an onboarding page and a
   first running task within 10 minutes, most of it image download.
2. **Capability:** completes multi-app tasks in its computer — research on the web and write the
   results into a LibreOffice document or sheet, organize files, work in a terminal — with the
   provider and model the user picks. Verified with Claude Sonnet 5.5, GPT-6.1 Sol, Gemini 3.6
   Flash, a ChatGPT plan through Codex, and Qwen3.8-27B locally.
3. **Truthful visualization:** every GUI action shows intent → cursor travel → effect → settle, in
   sync with the video. In recorded sessions the drawn cursor is within 2 px of every real input
   point, and no effect appears before the input is delivered or more than one frame before the
   frame that shows a press-acting control's change. Every shell command and file change appears
   in the terminal and diff panels.
4. **Replay:** any session replays with scrubbing, a step timeline and "jump to live", and exports
   to MP4.
5. **Keys:** no real secret exists anywhere inside a cell (canary test). Cells reach nothing — the
   internet, the host, the LAN — except through keyd, checked by a self-test at every cell boot that
   fails closed.
6. **Control:** risky steps wait for approval; the user can take over and hand back, pause, and
   stop everything with one button.

### Out of scope for the core
- A real macOS guest. Lume stays a possible later backend (environment §(a)).
- Acting on the host Mac.
- Chat channels, schedules and heartbeat, long-term memory beyond two Markdown files
  (sub-project 3).
- Avatar art, the [avatar-name] pack, voice in and out (sub-project 2). The core ships the avatar
  interface and a simple procedural default mascot.
- Multiple users, remote access, Windows hosts. Linux hosts should work but are not a v1 test
  target.

## Architecture

```
 YOUR MAC (trusted)                                   DOCKER VM (untrusted cells)
┌─────────────────────────────────────────┐          ┌──────────────────────────────┐
│ localdot daemon (TypeScript, Node 24)   │ tool API │ BRAIN                        │
│  orchestrator · ACTION GATEWAY          │◄────────►│ agent loop, model adapters,  │
│  event log + recorder                   │          │ skills; surrogate keys only  │
│  UI server + stream proxy (127.0.0.1)   │          └──────────────────────────────┘
│                                         │ desktopd + stream
│                                         │◄────────►┌──────────────────────────────┐
│ keyd (Go, LaunchAgent)                  │          │ DESKTOP                      │
│  Keychain vault · surrogate registry    │◄─────────│ Ubuntu 26.04 + XFCE with a   │
│  per-cell egress proxy · LLM gateway    │  egress  │ macOS look, apps, Chromium,  │
│  budgets · hash-chained audit log       │ (all     │ desktopd, Selkies stream     │
└─────────────────────────────────────────┘  cells)  ├──────────────────────────────┤
        ▲ you, in a browser tab                      │ SIGNED-IN BROWSER (M7)       │
                                                     │ Chromium + browserd; the only│
                                                     │ place login cookies live     │
                                                     └──────────────────────────────┘
 Each cell sits alone on an internal Docker network. A secret-free "gate" container per
 cell is its only door: inbound from the daemon, outbound to that cell's keyd listener.
```

### Components

| Component | Runs | Language | Holds | Job |
|---|---|---|---|---|
| `localdot` daemon | macOS process | TypeScript, Node 24 | install token, per-cell tokens | Orchestrates cells through the Docker Engine API; action gateway; event log and recorder; serves the UI; proxies the desktop stream |
| `keyd` | macOS LaunchAgent | Go | every real secret | Vault, surrogate registry, per-cell egress proxy, LLM gateway, budgets, audit |
| brain cell | container | TypeScript, Node 24 | its surrogates, proxy token and tool-API token | Agent loop, model adapters, skills |
| desktop cell | container | Ubuntu 26.04 arm64 | nothing secret | The virtual computer: XFCE desktop, apps, `desktopd`, Selkies |
| signed-in browser cell (M7) | container | Chromium | website cookies | Logged-in browsing, driven only through `browserd` |
| gate, one per cell | container | socat | nothing | The cell's only door: the relay to keyd listens only on the gate's internal-network address, and the inbound relay is reachable only through the port published on 127.0.0.1 |
| Codex harness (optional, M8) | macOS process in a Seatbelt sandbox | OpenAI's Codex app-server | the user's ChatGPT login, signed in separately for localDot and kept by Codex in `auth.json` inside a localDot-owned `CODEX_HOME` (S7 saw it only in the user's own `~/.codex`; M8 verifies a separate home) | Runs the agent loop on a ChatGPT plan; every tool it uses is localDot's |
| web UI | the user's browser | React 19 | the install token, in origin-scoped storage | Chat, stage, timeline, approvals, settings |

### Trust rules
1. **No cell has a route out.** Each cell sits alone on an internal Docker network created with
   `docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated`: no
   default route, no external DNS and no reachable gateway address (with plain `--internal`, Docker
   Desktop VM listeners answer on the bridge gateway). Its gate, which has its own egress bridge
   network, relays outbound TCP to one keyd listener reserved for that cell; that relay listens only
   on the gate's internal-network address, and the gate's inbound relay is reachable only through
   the port published on 127.0.0.1. Anything that ignores the proxy simply fails. Binding to
   127.0.0.1 is not access control on Docker Desktop: any container with egress reaches the Mac's
   127.0.0.1 through `host.docker.internal`. So the keyd listener's port identifies the cell and a
   per-cell `Proxy-Authorization` token proves it, and every inbound port published for a cell
   (`desktopd`'s API, the Selkies stream) requires a per-cell token: a bearer token for `desktopd`,
   Selkies' own auth for the stream.
2. **The brain never touches a screen.** It can only call the daemon's tool API. Every GUI, shell
   and file action runs through the action gateway, and the brain's network has no path to the
   desktop.
3. **Only keyd holds secrets.** It runs on macOS outside Docker's VM, so a container escape finds
   none. The daemon never sees a plaintext secret either: the key form in the UI seals the key to
   keyd's per-boot public key, bound to the secret's id and binding, and the daemon only relays the
   ciphertext to keyd's admin socket, which no browser can reach (amended 2026-10-01, Part 4a
   review).
4. **The host runs no model-generated code.** The daemon parses typed tool calls; code the model
   writes runs in the desktop cell.
5. **Enforcement lives outside the cells.** A prompt injection can make the brain want anything;
   only the gateway (actions) and keyd (network) decide what happens.
6. **The control surface is guarded.** The daemon binds 127.0.0.1 and requires a per-install token
   that never travels in a cookie (cookies are not port-isolated, so one would reach any localhost
   service, published cell ports included). HTTP accepts it only as `Authorization: Bearer <token>`.
   WebSocket clients always offer the subprotocols `localdot.v1` and `localdot.token.<token>`
   together, and the server selects only `localdot.v1`. The UI receives the token in a `#token=`
   URL fragment, keeps it in origin-scoped storage and then removes it from the address bar
   (`history.replaceState`). Against DNS rebinding the daemon checks Origin and both the raw Host
   header and the URL host. keyd's admin API is a 0600 Unix socket. From inside a cell, only that
   cell's keyd listener is reachable, plus the tool API for the brain.
7. **One documented exception: the Codex harness.** When the user picks a ChatGPT plan, OpenAI's
   Codex app-server runs the agent loop on the host, because Codex alone owns the ChatGPT login and
   its token refresh, and that login must never enter a cell. It runs inside Anthropic's
   `sandbox-runtime` (Seatbelt) with network access only to OpenAI and to localDot's MCP endpoint.
   Its file access is narrow: it writes only to its own localDot-owned Codex home and its out
   folder; under `~` it reads only that home and the Codex binary; and it cannot read `/Volumes` or
   any other non-home data mount, which the sandbox's rules would otherwise leave readable along with
   everything else outside `~` (project `.env` files on external disks, for example). Declining
   approvals is not enough, because Codex runs a model-chosen command in its own sandbox without
   asking. So localDot starts Codex with its command tools disabled (sub-agents included), declines
   every file change and accepts approval prompts only from its own MCP server. Codex's only hands
   are then localDot's MCP tools, which run through the action gateway like any other action. The
   harness requirements are listed under "Subscription sign-in".

Ports: UI and daemon API on 4750 (`LOCALDOT_PORT` overrides it), the brain's tool API on 4751, keyd
listeners 4760–4789.

### One click, end to end
1. The model streams a `computer` tool call. When each action's call completes, the brain forwards
   it to the gateway. Where the provider announces the call early (`tool-input-start`), an "aiming"
   state can start before any coordinates exist.
2. The gateway converts the coordinates to screen pixels and appends `action.intent`: the point, a
   short label and a planned cursor path (start time, duration, seed). In parallel it asks
   `desktopd` what is there — the accessibility tree, refined by Chromium's DevTools protocol for
   web pages — and appends `action.target` with the element's box, role and name. An accessibility
   lookup takes 0.55–2.3 s in LibreOffice and Chromium (83 ms in the terminal), usually longer than
   the cursor's travel, so `action.target` often arrives after the cursor unless CDP answers first.
3. The UI starts the cursor on the planned path and draws a crosshair that becomes the target box
   when `action.target` arrives. The avatar looks at the target. If the risk rules want approval, the
   cursor holds at the target and the gateway waits.
4. When the planned travel ends, the gateway tells `desktopd` to inject the input and appends
   `action.dispatch` with the XI2 raw-press time `desktopd` returns. The click ring starts at that
   time plus the injector's per-scale p99 press-to-frame latency (see Clock), so it means "input
   delivered".
5. `desktopd` reports when the screen settles and which regions changed. The gateway takes a fresh
   screenshot and returns it to the brain.

Timing is owned by the backend, not the viewer. It works with zero, one or many viewers, and a
replay renders exactly what the live view showed.

## The virtual computer (desktop cell)

- **Base:** linuxserver `baseimage-selkies` (Ubuntu 26.04, arm64 and amd64), pinned by digest. XFCE
  on X11, where XTest input and the AT-SPI accessibility tree are reliable.
- **Look:** a macOS-style theme (WhiteSur or MacTahoe GTK, MIT), WhiteSur icons, a Plank dock, a top
  panel styled as a menu bar, Inter and JetBrains Mono (OFL), and Noto CJK and emoji fonts so
  Chinese and Japanese pages render. No Apple fonts or artwork.
- **Apps:** Chromium, LibreOffice (Writer, Calc, Impress), VSCodium, xfce4-terminal, Thunar,
  Mousepad, GIMP; Python 3, Node, git, curl, jq, ffmpeg, ImageMagick and pandoc. The agent can
  install more at run time through the proxy.
- **Display:** logical 1280×800, where Claude and OpenAI coordinates map 1:1 and Qwen's image-patch
  grid divides evenly (openclaw §3.5). It renders at 2× (2560×1600) with HiDPI XFCE —
  `Gdk/WindowScalingFactor` 2 with `Xft/DPI` 96 and the `WhiteSur-Light-xhdpi` xfwm4 theme — and 1× stays
  a switchable fallback. The panel keeps its 1× size setting, because GTK window scaling already
  renders it at 54 px. Selkies writes XFCE's `Xft/DPI` itself (its `SELKIES_SCALING_DPI`, seen at
  192 with no viewer connected), so the image pins that setting to agree with the HiDPI settings
  (window scaling 2, `Xft/DPI` 96) and checks the resulting xsettings at startup. Model screenshots
  are always 1280×800.
- **Accessibility on:** AT-SPI bus, `GTK_MODULES=gail:atk-bridge`, `QT_ACCESSIBILITY=1`, Chromium
  `--force-renderer-accessibility`, and exactly one session D-Bus, with AT-SPI pinned to the XFCE
  session's bus (the base image's second, autolaunched bus can take over the accessibility bus).
  Thunar opens in List View (its icon view has no items in the tree) and Chromium runs maximized.
- **Stream:** Selkies 2.0 in WebSocket mode — H.264 over one TCP port, decoded by Selkies' own
  client with WebCodecs — with `SELKIES_ENABLE_CURSORS=false` (no pointer in the frames at 1× or 2×)
  and a fixed resolution. The stage takes every decoded frame from a `MediaStreamTrackProcessor` on
  a clone of the client's `<video>` track; localDot has no decoder of its own. Selkies encodes only
  on damage, so a still screen sends no frames. The daemon proxies the WebSocket so the UI has a
  single origin, and taps the same stream for recording. The fallback is KasmVNC 1.5 or noVNC 1.7
  behind the same client interface.
- **`desktopd`:** our in-cell daemon (TypeScript) and the only thing the gateway talks to. It wraps
  Cua Driver (MIT, pinned, run as `cua-driver mcp --no-overlay` with telemetry and update checks
  off) for the accessibility tree, windows and screenshots, and maps every element frame into
  desktop device pixels with one transform per toolkit. Pointer and keys go through `desktopd`'s own
  XTest client, which activates windows itself, and an XI2 raw-event listener timestamps every
  injection. It adds a shell (pty), file access and CDP for Chromium, which also supplies web-page
  boxes. The API is ours and stable. Cua Driver's own input path is the input fallback (launched
  with `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=0`). If Cua Driver churns or fails, a fallback backend
  (pyatspi, `mss`) replaces its perception without changing the daemon.

  Frame mapping: the canonical space is desktop device pixels (the X root), and model coordinates
  are device pixels ÷ S, the desktop scale. With g = `Gdk/WindowScalingFactor` and c = Chromium's
  device scale factor:
  - GTK3 apps and LibreOffice's GTK-drawn parts:
    `device = windowOrigin + (frame − floor(windowOrigin / g)) × g`, never plain `frame × g`, which
    is off by 1 device px at odd origins;
  - LibreOffice's VCL-drawn parts: `(frame + (0, m)) × g`, with m its native menu-bar height in
    frame units — a per-role workaround; these frames stay unreliable;
  - Chromium's browser chrome: `frame × c`; web content: the CDP box (CSS px) × c plus the content
    area's device origin (unmeasured);
  - never the driver's `screenshot_frame`.

  | Call | Returns |
  |---|---|
  | `observe()` | screenshot (WebP, 1280×800) and its `frameId` |
  | `hitTest(point)` | `Target`: box, role, name, app, window, URL, `secret` flag |
  | `input(Input)` | the injection timestamp: the XI2 raw-event time of the press (the same listener can drive `text.progress`) |
  | `type(text)` | streamed `text.progress` chunks |
  | `settle()` | the changed regions, or "no visible change" |
  | `shell(cmd)` | streamed stdout and stderr, exit code |
  | `files.*` | read, write, edit (returns a patch), list — home folder only |
  | `browser.read()`, `browser.navigate(url)` | URL, title, text and accessibility snapshot of the desktop's Chromium |
  | `selfTest()` | the network lockdown checks |

- **Persistence:** the home folder is a named volume, so files, user-level installs and settings
  survive restarts and updates. System packages installed with `apt` last until the container is
  recreated. "Reset computer" deletes and recreates everything. The optional host folder
  `~/localDot/Shared` is mounted at `~/Shared`; nothing else from the host is mounted.
- **Hardening:** a non-root user with passwordless sudo inside the cell, so the agent can install
  software (this cell therefore does not use `no-new-privileges`). Default seccomp, `NET_RAW`
  dropped, no added capabilities, pids, memory and CPU limits, no `docker.sock`. The brain, gate and
  browser cells run read-only with `no-new-privileges` and all capabilities dropped. Proxy
  variables and the cell's CA are wired at boot, and the boot self-test must pass before the cell
  is marked ready.
- **Files between you and the computer:** drop files onto the chat to put them in the computer's
  `~/Downloads`; files the agent returns with `done` can be downloaded from the result card.

## The agent (brain cell)

- **Loop:** our own small TypeScript loop on the Vercel AI SDK v7 (Apache-2.0). It already speaks
  Anthropic's `computer_toolset_20260801`, OpenAI's `computer` tool, Gemini, and OpenAI-compatible
  endpoints such as LM Studio (openclaw §4.3). We copy pi-agent-core's event contract and hooks:
  `agent_start/end`, `turn_start/end`, `message_update`, `tool_execution_*`, before and after
  tool-call hooks, and steer and follow-up queues so the user can interject mid-task.
- **Models:** the user picks them (see "Providers and sign-in"). The suggested default is Claude
  Sonnet 5.5, moving to Opus 5.5 after two failed verifications of the same step or when the user
  asks it to think harder. The suggested local option is Qwen3.8-27B through LM Studio (already
  installed, about 16 GB at 4-bit). One coordinate module converts each provider's space —
  screenshot pixels, or the 0–1000 grid, which also serves Gemini's 0–999 — to screen pixels, with a
  probe-image test for every model that can drive the screen. Gemini and Qwen answer on the 0–1000
  grid even when told pixels, so the generic tool declares that grid for them.
- **Tools:**

  | Tool | What it does | How it shows |
  |---|---|---|
  | `computer` | the provider's native action set (click, type, key, scroll, drag, zoom, wait, screenshot); batched actions run in order and stop at the first failure | cursor, target box, click ring, typing display |
  | `shell` | runs a command in the desktop's terminal session | terminal panel, streamed |
  | `files` | read, write and edit in the desktop's home | diff panel |
  | `browser_read`, `browser_navigate` | a fast text and accessibility read of the current page; go to a URL | "Reading page" step; navigation is visible on screen |
  | `switch_screen` (M7) | desktop ↔ signed-in browser | the stage switches screens |
  | `update_plan` | the task checklist | plan panel |
  | `ask_user` | a question card with lettered options and free text | chat card; the avatar faces the user |
  | `request_takeover` | hands the screen to the user for a login, 2FA, CAPTCHA or payment | takeover banner |
  | `remember` | edits `USER.md` or `MEMORY.md` | memory diff card with undo |
  | `done` | the final answer, with files | result card |

- **Harness rules:**
  - Every action names the `frameId` it was based on. Before a click, the gateway checks that the
    region around the target still matches that frame; if not, it returns a fresh screenshot
    instead of clicking.
  - The plan lives outside the model's context.
  - Only the latest three screenshots stay in context; older turns are summarized as text.
  - Mixing GUI, shell and file actions is encouraged; every top OSWorld entry does it
    (openclaw §3.4).
- **Skills:** `SKILL.md` folders, built in or in `~/.localdot/skills`, listed by name and
  description and loaded on demand. Their scripts run in the desktop. In v1 only the user adds
  skills: no registry and no agent-written skills.
- **Memory:** `USER.md` (who the user is, preferences) and `MEMORY.md` (facts worth keeping) live on
  the host in `~/.localdot/memory/`. The brain reads them through the tool API at task start, and
  every `remember` produces a visible diff that can be undone.
- **Stateless brain:** the daemon stores transcripts, so the brain can restart and resume a task.

## Providers and sign-in

In onboarding and settings, the user picks a provider and model for each role:
- **main:** drives the computer, so it needs vision and tool calling;
- **fast:** summaries, titles and step verification;
- **local:** an optional offline fallback.

**Library.** The Vercel AI SDK v7 and its official provider packages, all Apache-2.0: Anthropic,
OpenAI, Google Gemini and Vertex, Azure OpenAI, Amazon Bedrock, xAI, Mistral, DeepSeek, Groq,
Together, Fireworks, Cerebras, Perplexity, Cohere, DeepInfra, Moonshot (Kimi) and Alibaba (Qwen).
Add to that the OpenRouter and Ollama providers, and the generic OpenAI-compatible provider for
anything else: LM Studio, vLLM, Zhipu, MiniMax, self-hosted gateways.

**Catalog.** The picker reads the models.dev catalog (about 225 providers, with context sizes,
prices, vision and tool-calling flags), cached locally and refreshable, and marks what each model
can do:
- **native computer use** (Anthropic, OpenAI, Google): uses the provider's own computer tool;
- **vision and tool calling:** uses localDot's generic `computer` tool, with Anthropic-style actions,
  a `coordinate` that is a length-2 number array (`z.array(z.number()).length(2)`; Gemini rejects
  `z.tuple`), the 0–1000 grid for Gemini and Qwen, and screenshots sent as `file` parts (the `image`
  part is deprecated in AI SDK 7);
- **text only:** can use the shell, files and page reading but not the screen, and the picker says
  so.

**Keys.** Each provider gets its own route in keyd's LLM gateway, using that provider's auth style:
a bearer token for most, `x-api-key` for Anthropic, `x-goog-api-key` for Gemini, `api-key` for
Azure. keyd adds SigV4 signing for Bedrock and service-account token minting for Vertex in M8.
Local servers (LM Studio, Ollama) are reached through keyd's host-loopback route, so no cell can
call them directly.

**Subscription sign-in.**
- **ChatGPT plan: supported (M8).** OpenAI documents the Codex app-server for "embedding Codex into
  custom products", with "Sign in with ChatGPT for subscription access"; Codex keeps the login in
  its home and refreshes it itself (learn.chatgpt.com/docs/app-server and /docs/auth). The harness
  gets its own localDot-owned `CODEX_HOME`, which holds the login as `auth.json`, and its own
  sign-in (`account/login/start`), never the user's `~/.codex`. S7 saw `auth.json` only in the
  user's own `~/.codex`, so M8 verifies that a separate home, its sign-in and its token refresh
  work. localDot runs the app-server as the Codex harness (trust rule 7). Codex runs the loop, and
  localDot supplies every tool through an MCP server that routes into the action gateway, so
  visualization, approvals and replay work the same. As on every measured route, Codex's tool calls
  arrive whole, so in Watch mode cursor travel adds its own time to each GUI action. Spike S7
  proved the path (GO-WITH-CHANGES). The harness requirements:
  - **Process:** `srt --settings <localDot settings> -- codex app-server --listen stdio://`, spawned
    with `cwd` set to the folder its settings' relative paths assume. The `--` is required: without
    it srt runs Codex's first `-c` value as a shell command. Pin the Codex version and check
    `codex app-server generate-json-schema` on every upgrade.
  - **No command tools:** `--disable shell_tool --disable unified_exec --disable view_image` removes
    `exec_command`, `write_stdin` and `view_image`, for sub-agents too. `apply_patch` and the
    `collaboration.*` sub-agent tools can't be switched off in 0.154, so every file change is
    declined and sub-agents are capped or removed. `spawn_agent` takes a model override: verify, or
    forbid, sub-agent tool sets under other models.
  - **TLS:** `CODEX_CA_CERTIFICATE=<PEM bundle>`, because srt blocks `com.apple.trustd.agent`. Never
    `enableWeakerNetworkIsolation`, which re-opens trustd.
  - **Own home and login:** a localDot-owned `CODEX_HOME` with its own ChatGPT sign-in, never the
    user's `~/.codex`, whose settings — a custom base URL, MCP servers, plugins, connectors, a
    turn-end `notify` program, a permissive approval and sandbox policy, skills — would leak into
    the harness. Disable `shell_snapshot`, which runs the user's login shell at every thread start.
  - **Environment:** spawn Codex with a scrubbed environment; the daemon's may hold provider keys.
  - **Files:** srt `allowWrite` only that Codex home and its out folder; `denyRead` covers `~`,
    `/Volumes` and every other non-home data mount, with `allowRead` for that home and the Codex
    binary (re-allowed explicitly if the home is under `~/.localdot`).
  - **Network:** OpenAI (`chatgpt.com:443`, plus `auth.openai.com` for token refresh) and localDot's
    MCP endpoint only; choose between a loopback port and a Unix socket allowlisted in srt.
  - **Thread:** `approvalsReviewer: "user"`, `sandbox: "read-only"`, `ephemeral: true`.
  - **Server requests:** accept `mcpServer/elicitation/request` only when `serverName` is exactly
    `localdot`, the mode is not `url` and `_meta.codex_approval_kind` is absent or `mcp_tool_call`,
    replying with the schema's explicit defaults only (never a boolean defaulted to true). Decline
    `item/fileChange/*` and `item/commandExecution/*`. Answer every `item/tool/requestUserInput`
    with `[]` or an exact deny label, never a first-match label search (it can pick "Allow (no
    further prompts)"). Keep `tool_call_mcp_elicitation` on.
  - **Usage:** a two-action turn used about 6 points of the Plus 5-hour window (about 16 turns or 65
    model steps per window), measured with a personal Codex config, so it is re-measured on
    localDot's own home; show `account/rateLimits/*` in the UI.
  - **Events:** map Codex's thread, turn and item events as in S7 "Mapping onto localDot's event
    log".
  - **Tests:** mock-provider probes use a throwaway `CODEX_HOME` and override `chatgpt_base_url` as
    well.
- **Claude plan: not offered.** Anthropic's Agent SDK docs say: "Unless previously approved,
  Anthropic does not allow third party developers to offer claude.ai login or rate limits for their
  products, including agents built on the Claude Agent SDK." Claude is available with an API key.

## Action gateway and live view

The gateway turns tool calls into one ordered stream of actions. The picture is a pure function of
that stream: `render(eventLog, videoTime, view)`. The full visualization spec — layers, parameters,
event schema, timing table, camera and avatar rules — is visualization §4. This section fixes the
decisions.

**Truthfulness contract**
- Intent → travel → dispatch → effect → settle → verify, in that order, always.
- An effect means "delivered", never "succeeded". Success marks wait for settle and verify.
- Overlays exist only in the viewer, never in the VM or in the model's screenshots.
- Replays are deterministic: cursor paths and springs are closed-form functions of time with
  seeded randomness.

**Timing.** The gateway owns it. Travel is `T = clamp(150 + 100·log2(D/W + 1), 220, 700) ms ÷ speed`
(D = distance; W = target width, 24 px when the target is unknown), then a dwell of 90 ms ÷ speed
(45 ms at Fast), then the press. Presentation speed:
- **Watch** (1.0) while anyone has the stage visible;
- **Fast** (2.0) when nobody is watching;
- **Instant** on request: the cursor fades to the target and dispatch waits 60 ms.

Watching costs time only while someone watches. The intent is emitted when the action's tool call
completes: on every measured route the coordinates arrive with the complete call, so cursor travel
is not hidden inside model latency and adds its own time to each GUI action.

**Clock.** The daemon stamps every event and every incoming video chunk with its own monotonic
clock. The delay between an input's XI2 raw press and the arrival of the frame that shows it varies
per trial, injector and scale (own XTest clicks at 1×: p5 6.0 ms, p50 9.6 ms, max 19.6 ms). So the
click ring means "input delivered" and starts at the raw-press time plus that injector's per-scale
p99, re-measured with at least 500 trials per injector and scale on target hardware. The
development Mac's first, small samples put that onset for own XTest at 19.6 ms (1×) and 23.1 ms
(2×) for clicks, and 19.1 and 29.3 ms for keys. `desktopd`'s clock is mapped to the daemon's with a
periodic lowest-RTT ping: they differ by about a millisecond and drift up to 1 ms within 20–45 s.

**Event log.** Append-only JSONL per session plus an SQLite index (`node:sqlite`) that can be
rebuilt from the session folders, so session metadata (title, start time) lives in the session
folder, not only in the index. One daemon writes per localDot home: before opening the log it
takes an exclusive lock file (`<home>/daemon.lock`, such as `~/.localdot/daemon.lock`, with its pid
inside and a stale-pid check). Appends are failure-atomic and survive a process crash, not a power
loss (no fsync). `observe` screenshots are stored as files keyed by `frameId`, never inline as
base64 in the JSONL. The envelope is `{v, id, seq, t, agent, step, type, data}`. Types:
`session.*`, `agent.state`, `heartbeat`, `thought.delta`, `plan.*`, `step.start/end`,
`action.intent/target/cancel/dispatch/result`, `text.progress`, `screen.settle`, `observe`,
`step.verify`, `tool.start/output/end`, `file.change`, `approval.request/resolve`,
`control.change`, `pause.change`, `memory.change`, `key.use` (from keyd's audit) and `camera.hint`.
Typed text is masked at the source when the target is a secret field. The schemas live in
`@localdot/protocol` (zod) and are exported as JSON Schema for keyd.

**Overlays,** built in this order:
- **P0 (M2):** agent cursor with a name chip and halo; target box with a role and name chip, or a
  crosshair when only coordinates are known; click ring; typing display that never runs ahead of
  real typing and masks secrets; keycap chips for shortcuts; status pill with Take over and Stop;
  an "agent has control" frame; step timeline with thumbnails.
- **P1 (M4 and M8):** terminal and diff panels (M4); auto-camera — a gentle follow-zoom live,
  cinematic in replay; a "what changed" flash; scroll and drag visuals; "agent vision", showing what
  the model saw (M8).
- **P2 (later):** multiple agent cursors, a countdown before medium-risk steps, a provenance
  inspector.

**Rendering.** Selkies' client decodes with WebCodecs; a `MediaStreamTrackProcessor` on a clone of
its video track hands each `VideoFrame` to the render worker, which uploads it once per new frame,
never per `requestAnimationFrame` (at 2× a per-`requestAnimationFrame` upload took Chrome's GPU
process from 7–9 % to 31–40 % of a core). PixiJS v8 draws the video texture and world-space
overlays under one camera matrix in an OffscreenCanvas; the HUD is DOM positioned from the same
matrix. One `requestAnimationFrame` loop drives everything, and React state updates at most 10 times
a second. Budget: under 4 ms per frame on an M1-class laptop.

**Sound.** Off by default except soft attention cues for approval, done and error. Every sound is
soft and warm; nothing sharp.

## Key layer (keyd)

keyd is a Go daemon on macOS and the only holder of real secrets. It follows Muse's split — one
component mints surrogates, another authorizes each request and swaps at the boundary — and the
design in security §3.

- **Vault:** macOS Keychain items owned by keyd.
- **Surrogates:** `ld_<kind>_<≥128-bit random>_<checksum>`, minted per cell at boot and bound to that
  cell's listener, exact hosts, one header location and a policy. They die with the cell.
- **Per-cell listener:** an explicit HTTP proxy (CONNECT) on its own port that requires the cell's
  `Proxy-Authorization` token. Interception is chosen per host: for hosts that need a swap or
  HTTP-level policy, keyd terminates TLS with a per-cell, name-constrained CA that exists only in
  memory (Chromium enforces its constraints); other allowed hosts pass through untouched with an
  SNI = CONNECT-host check. Policy follows the inner request, not the CONNECT, because a plain-HTTP
  request inside a tunnel can name another host. Everything else gets 403.
- **Swap rules:** authorize first, then swap. Each surrogate is bound to scheme `https`, port 443
  and an exact host, so a plain `http://` request to a bound host never carries the real value; the
  swap happens only after verified upstream TLS and a check of the connected IP. Every binding and
  rejection rule applies to every request method. Header-only by default, and the surrogate must
  match its bound header exactly, not as a substring. An unknown or misplaced surrogate in the
  request line or headers of traffic keyd terminates (plain HTTP, intercepted hosts, the LLM gateway
  and the CONNECT request itself) is blocked and alerted, never passed through. Request bodies are
  not scanned, because prompts may quote surrogates, and keyd cannot see inside a passthrough
  tunnel; a surrogate in either leaves unswapped and is worthless off the Mac. Residual risk:
  responses on passthrough names are never scrubbed, so if a service stores a header keyd sent to a
  bound host and shows it under another, unbound name, keyd cannot remove it (amended 2026-10-01,
  Part 4a review). The real secret is scrubbed from responses in plain, base64, URL-encoded and hex
  forms.
- **SSRF guard:** keyd resolves DNS itself, dials the checked IP and re-checks the connected peer at
  dial time against a deny set: loopback, `0.0.0.0/8` and `::/128` (a dial to the unspecified
  address lands on loopback), RFC 1918, 100.64/10, link-local, ULA, Docker's 192.168.65/24, every
  address of every interface on the Mac (IPv4 and IPv6, rotating temporary IPv6 addresses included,
  refreshed whenever they change) and the prefixes of directly connected networks. keyd dials
  upstream directly, never through another proxy. Each redirect hop is evaluated again.
- **LLM gateway:** the brain's providers use base URLs that point at keyd
  (`http://llm.ldot/<provider>`), so no TLS interception is needed there. keyd attaches the real key
  in that provider's auth style, enforces a model allowlist and budgets (defaults $5 per task and $20
  per day, editable), and fronts LM Studio and Ollama so no cell ever reaches them directly. An
  upstream failure gets a 502 and keyd keeps serving; a mid-stream upstream error ends the client's
  stream cleanly; and when the client disconnects, keyd aborts the upstream request so the provider
  stops generating and billing.
- **Audit:** one hash-chained JSON line per decision — time, cell, surrogate id (never the value),
  host, method, path, status, bytes, decision — under `~/.localdot/keyd/`, never mounted into a
  cell. A TLS handshake the client aborts and an SNI/Host mismatch are decisions too. The timeline
  shows key use inline ("used Anthropic key → api.anthropic.com").
- **Kill switch:** on Stop, drop the cell's surrogates and close its upstream connections.
- **Default egress:** brain → the LLM gateway only. Desktop → the web and package registries, minus
  a deny list and the SSRF set. Signed-in browser → the web. Every cell reaches hosts by name only:
  no IP literals or addresses spelled as names (`127.1`), CONNECT only to port 443 and plain HTTP
  only to port 80, so odd ports, IP-literal URLs and `ws://` fail (amended 2026-10-01, Part 4a
  review).
- **Secret classes in v1:** LLM provider keys and generic HTTP API keys. OAuth accounts, git, SSH and
  databases come later, following security §3.5.
- **Data plane:** our own on `elazarl/goproxy`, porting the substitution tests from Anthropic's
  `srt` and S4's `run.sh` and `chromium.sh` probes. iron-proxy 0.52 lacks selective MITM, response
  scrubbing, per-listener identity and unknown-surrogate blocking; keyd adapts its dial-time deny
  check (`net.Dialer.Control`), its Basic-auth-aware header swap, its SNI = Host check and its
  audit shape (Apache-2.0).

What a cell holds, in full: its proxy endpoint and proxy token, the public half of its CA, its
surrogates, base URLs, and (brain only) its tool-API token. All of it is worthless off the Mac
(security §3.3 and §3.12).

## Safety and control

- **Autonomy levels** per action class: act, ask, or hand off. Defaults:
  - ask: purchases, sending, posting, deleting, running downloaded programs, changing system
    settings;
  - hand off: logins, 2FA, CAPTCHAs, payment fields;
  - act: reading and browsing.
- **Risk rules** use the action kind, the target's role and name ("Buy", "Send", "Delete", "Pay",
  "Place order"…), the page URL and shell patterns. A reviewer model comes later; dots and Grok Bot
  both use one.
- **Approvals** are drawn by the UI from structured data, never the model's prose: what, where, and a
  preview such as recipients, items or totals. Buttons: Approve once, Deny, Take control. High-risk
  kinds have no "approve similar". An approval left unanswered for 10 minutes is denied, and every
  request raises a browser notification.
- **Takeover:** one controller at a time. The agent stops at a safe point, its cursor fades, the frame
  says "You're in control", and the user's input goes to the VM. No screenshots reach the model
  during takeover. Hand-back takes an optional note, and the agent receives the note, a before/after
  summary and a fresh screenshot. The agent never types credentials.
- **Pause** stops at the next step boundary, never mid-typing. **Stop** — the button, an in-app
  hotkey, or `localdot stop` — aborts the model turn, cancels queued actions and tells keyd to drop
  the cells' surrogates, all at once.
- **Guards:** the same action on the same target three times in a row pauses the task and asks the
  user. The brain sends a heartbeat every second while a model call or tool runs; after 1.5 s
  without one, the UI shows the task as stalled.

## Signed-in browser (M7)

Cookies are bearer tokens, and any process that can read a Chromium profile owns every logged-in
session (security §3.6). So logged-in browsing moves to its own cell:
- Chromium with its own display and Selkies stream; the profile volume is mounted only here.
- `browserd` drives it with a narrow set of verbs: navigate, accessibility snapshot, screenshot,
  click, type, scroll and key at coordinates or element refs, upload from the desktop, and download
  into a quarantine that the user releases. It refuses JavaScript evaluation, cookie and storage
  access, and request interception.
- Logins happen by takeover: the agent is paused and receives nothing while the user types.
- The stage shows the browser as a second screen, and `switch_screen` moves the agent between
  screens.
- Once this ships, the desktop's own Chromium keeps no cookies between tasks, and signed-in work
  happens only here. Until then, logins in the desktop's Chromium work through takeover and the UI
  marks them "not isolated".

## Interface

Three modes:
- **Glance:** chat first. A live thumbnail and the avatar carry the status; the gateway runs at
  Fast. For tasks the user doesn't want to watch.
- **Watch:** the stage takes the center, with chat on the left and plan and steps on the right.
- **Replay:** the stage plus a scrubber with step chapters, speeds up to 8×, skip idle, before/after
  compare, and jump to live.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ localDot   Compare flights to Tokyo       ● Clicking "Search" · 12 s   ⏸  ■  │
├───────────────────┬──────────────────────────────────────────┬───────────────┤
│ Conversation      │  ╭────────────────────────────────────╮  │ Plan          │
│                   │  │ the virtual computer, live         │  │ ✓ Open site   │
│ you: …            │  │ cursor · target box · click ring · │  │ ◉ Compare     │
│ localDot: …       │  │ typing display · camera            │  │ ○ Write sheet │
│ [approval sheet]  │  ╰────────────────────────────────────╯  │ Steps         │
│ ┌──────┐          │  Take over   Watch ▾   Agent vision      │ ▢ ▢ ▢ thumbs  │
│ │avatar│ message… │                                          │               │
└───────────────────┴──────────────────────────────────────────┴───────────────┘
```

The sketch shows the arrangement only. In the chosen direction, Theatre (below), the status shown
here in the top bar floats on the stage as a HUD instead.

- **Stack:** React 19, Vite, TypeScript, Tailwind 4, shadcn/ui, Biome, Vitest, Playwright. Vite
  rather than Next.js, because this is a single-page app served by the daemon on localhost and
  server rendering would add nothing.
- **Look:** neutral chrome that lets the desktop and the avatar carry the character. Colors, fonts
  and the "agent has control" accent come from theme tokens (CSS variables), so a theme pack can
  restyle the chrome. No purple gradients and no blur-everything glass.
- **Feel:** all UI work follows the apple-design skill (`~/.agents/skills/apple-design`):
  - respond on pointer-down;
  - track drags 1:1 from where they were grabbed;
  - every animation is interruptible and starts from the current on-screen value;
  - springs described by damping and response — critically damped (1.0) by default, about 0.8 only
    after a gesture that carried momentum — with velocity handed off at release;
  - enter and exit along the same path, anchored to the element that triggered them;
  - restrained materials, optical typography, and a real reduced-motion mode.

  The stage renderer uses the same damping/response springs, evaluated in closed form so replays
  stay deterministic. Motion work is reviewed with the `review-animations` and
  `animation-vocabulary` skills from the same folder.
- **UI direction** (decided 2026-09-30): C: Theatre
  (`docs/superpowers/design/2026-09-30-localdot-ui-directions/c-theatre.html`). A near-black
  surround (`--void` `#0A0B0D`) and a large lit stage. One accent, xenon `#3FB5DE`, used only while
  the agent has control (stage rim, target, cursor stroke, click ring, caret, current step); Stop
  and done states stay neutral. The status HUD floats on the picture (backdrop blur, solid under
  `prefers-reduced-transparency`), and narration plays as a caption under the stage. Chat and
  plan/steps sit in quiet side rails that stay comfortable for long reading; the mascot slot is
  bottom-left outside the stage; "looking at" is a neutral dashed outline; every color is a CSS
  token so a theme can restyle it.
- **Avatar slot:** `@localdot/avatar` defines the renderer interface — `mount`, `setState`,
  `setAttention(point)`, `react(kind)`, and `speak(track)` reserved for sub-project 2 — plus the
  engine that derives state and gaze from events:
  - attention priority: approval → the user's pointer → the current target → the travelling cursor →
    what changed → the chat input → idle;
  - the eyes lead the cursor;
  - reactions come only from meaningful events (verify, cancel, approval, done);
  - each state holds at least 250 ms, so bursts of tool calls don't make it flicker.

  The core ships one renderer: a procedural SVG mascot with springs, seeded idle, blink ranges and
  reduced-motion support; Grok Bot's engine is the reference (grokbot §2). Theme packs are data only
  (`theme.json` plus assets), never code.

## Setup and operations

- **Needs:** macOS 14+ on Apple silicon (Linux hosts later), Docker Desktop running with at least 8 GB
  for its VM, Node 24+, about 12 GB of disk.
- **Install:** `npx localdot` installs to `~/.localdot/`, starts keyd (as a LaunchAgent) and the
  daemon, pulls pinned images with progress shown in the browser, and opens
  `http://127.0.0.1:4750/#token=<install token>`. Onboarding: pick model providers and paste keys
  (sent to keyd only), choose a theme, set autonomy defaults, run a first task.
- **CLI:** `localdot up | down | stop | reset-computer | logs | doctor | update`. `doctor` checks
  Docker and its resources (including that the engine honors isolated gateway mode for internal
  networks), ports, image digests and the cell self-tests, and runs the canary test.
- **Data:** `~/.localdot/` holds config, sessions (events, `observe` screenshots, video,
  thumbnails), memory, skills and logs; keyd's state is in `~/.localdot/keyd/` (mode 0700). Secrets
  live only in the Keychain, except the Codex harness's ChatGPT login, which Codex keeps as
  `auth.json` in its localDot-owned home (trust rule 7). The optional shared folder is
  `~/localDot/Shared`.
- **Updates:** images are pinned by digest per localdot version. `update` pulls them and recreates
  the cells; the home volume survives.

## Error handling

| Failure | Behavior |
|---|---|
| A cell crashes | The orchestrator restarts it with backoff; the UI shows "Reconnecting…"; the brain resumes from the stored transcript; the desktop's home survives |
| The stream connection stalls: it delivers nothing (no frame and no Selkies keep-alive or ping) for longer than the keep-alive interval plus a margin; the number comes from Selkies' ping interval. A still screen on a live connection is not a stall | Overlays freeze and show "Reconnecting…"; the stream reconnects automatically; the gateway holds dispatch until the connection is back |
| Model error or rate limit | Retry with backoff, then the optional fallback model; shown in the status pill |
| Target changed since the model looked | Re-observe instead of clicking (freshness check) |
| Driver error or target vanished | `action.cancel` with a reason; the brain sees the error; the step is marked failed |
| Screen never settles | Continue after 3 s, marked "page still changing" |
| keyd down | Cells have no egress; the UI shows "Key layer offline"; the task pauses |
| Budget reached | keyd refuses; the task stops; the UI offers to raise the budget |
| Approval unanswered for 10 minutes | Denied, with a notification |
| Self-test fails at boot | The cell is not marked ready; the UI says which check failed |

## Testing

- **Unit** (Vitest, Go test): protocol schemas; the coordinate module, the most common bug class in
  this space; the timing formula; risk rules; surrogate binding and every swap rule, with tests
  ported from `srt`; the SSRF guard; the audit hash chain.
- **Integration:** the daemon and a real desktop cell driven by a scripted "puppet" with no LLM —
  events, driver effects, settle — and deterministic replay: rendering the same log twice produces
  identical frames.
- **Pixel oracle:** for every dispatch in a recorded session, the composited frame puts the cursor
  hotspot within 2 px of the dispatch point at 1×, at 2× zoom and on HiDPI; no click ring starts
  before the input's raw press, or more than one frame before the frame that shows a press-acting
  control's change; the typing display never shows more characters than were typed; model
  screenshots contain no overlay pixels.
- **Security:** a canary secret planted in keyd never appears in any cell's environment, files,
  process list or memory dump. Cells cannot reach the internet, the host, the LAN or LM Studio except
  through keyd. Surrogate misuse (wrong host, wrong header) is blocked and alerted. keyd's listeners
  and every inbound cell port refuse requests without the cell's token. The daemon's Host/Origin
  checks stop DNS rebinding. The Codex harness can reach only OpenAI and localDot's MCP endpoint,
  can't write outside its own Codex home and out folder or read the rest of `~`, `/Volumes` or any
  other non-home data mount, has no command tools (sub-agents included), never gets a patch
  approved, and accepts approval prompts only from the MCP server named exactly `localdot`.
- **End to end** (Playwright): onboarding → a mock-model task → overlays render; approval; takeover
  and hand-back; replay scrubbing; MP4 export. UI changes are also checked with screenshots.
- **Agent evals,** tracked but not gating: a small suite of real tasks (research into a document, a
  spreadsheet, file chores) on Claude Sonnet 5.5 and Qwen3.8-27B.

## Repository

```
localdot/
  apps/daemon/         control plane (TypeScript)
  apps/web/            UI (React)
  apps/cli/            npx entry point
  cells/brain/         agent loop + Dockerfile
  cells/desktop/       image: theme, apps, desktopd, Selkies config
  cells/browser/       signed-in browser + browserd (M7)
  cells/gate/          forwarder image
  harness/codex/       Codex app-server bridge and its sandbox profile (M8)
  keyd/                Go
  packages/protocol/   event and tool schemas (zod, exported to JSON Schema)
  packages/providers/  provider registry, models.dev catalog cache, coordinate module
  packages/stage/      overlay renderer: render(log, t, view)
  packages/avatar/     renderer interface, attention engine, default mascot
  spikes/              M0 throwaway probes
  docs/
```

- pnpm workspace on Node 24 with Biome; a Go module for keyd; Docker Bake for multi-arch images,
  arm64 first; GitHub Actions on arm64 runners.
- **License:** MIT. Third-party pieces keep their own licenses: Selkies (MPL-2.0) and the linuxserver
  base (GPL-3.0) ship as separate programs inside the image; goproxy (its own license, checked when
  it is pinned); code adapted from iron-proxy keeps its Apache-2.0 notice; mediabunny (MPL-2.0);
  PixiJS (MIT); Cua Driver (MIT; its optional AGPL perception extension is not used).
- **Publishing hygiene:** the GitHub repo stays private until the user says otherwise. Before any
  publish, run a full-history secret scan. A CI check fails on [avatar-name] or [avatar-name] names or theme-pack
  files anywhere in the repo.
- **Name:** "localDot" deliberately echoes OpenAI's "dots" (launched 2026-09-29). Fine for now;
  revisit before a public launch.

## Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Spikes S1–S7 (throwaway code) | Each has a findings note and a go or fallback decision |
| M1 | Foundation | Monorepo, protocol package, daemon skeleton with token auth, desktop and gate images, internal networks; the live desktop appears in the UI |
| M2 | Visual core | Theatre chrome built; gateway with the timing contract; `desktopd` observe, hitTest, input, type and settle; event log; P0 overlays driven by the puppet; pixel-oracle tests pass |
| M3 | Key layer | keyd vault, surrogates, per-cell listeners, egress policy, SSRF guard, LLM gateway, budgets, audit, admin socket; key form; self-tests and canary test pass |
| M4 | Agent | Brain image and loop; provider registry and picker for every API-key provider and local server, with the models.dev catalog; Anthropic's native computer tool and the generic `computer` tool; all v1 tools; chat, plan and step timeline; terminal and diff panels; memory files; skills loader; a first real multi-app task succeeds |
| M5 | Control and safety | Autonomy levels, risk rules, approvals, takeover and hand-back, pause, Stop and the kill switch, guards, budget UI |
| M6 | Replay | Recorder (fMP4 via mediabunny), thumbnails, session index, replay UI, MP4 export |
| M7 | Signed-in browser | `browserd`, second screen, `switch_screen`, takeover logins, download quarantine; the desktop's Chromium stops keeping cookies |
| M8 | Premium feel and more providers | Auto-camera, what-changed flash, agent vision, scroll and drag visuals, avatar host and default mascot, soft sounds; OpenAI and Google native computer tools; the Codex harness for ChatGPT plans, with its own Codex home, sign-in and token refresh verified; Bedrock and Vertex signing in keyd |
| M9 | Ship | `npx localdot`, onboarding, `doctor`, `update`, docs, arm64 CI, publishing hygiene |

**Order (user, 2026-10-02):** M9 ships before M8. M8 (premium feel and more providers) follows the first release, so nothing in M5–M7 depends on it.

**Spikes (M0),** as briefed. They ran on 2026-09-30 and 2026-10-01, and each has a `FINDINGS.md`
under `spikes/`. Where an outcome differs from its brief — S1's decoder in our own page, S2's
xdotool fallback, S6's single compensation constant — the rest of this spec carries the outcome.
S6's check that the drawn cursor lands on the dispatch frame moved to the pixel oracle.
- **S1 Stream:** a Selkies 2.0 WebSocket stream from an arm64 desktop container on Docker Desktop,
  proxied through a Node process and decoded with WebCodecs in our own page. Measure latency and CPU
  at 1× and 2×, at 30 and 60 fps, and confirm the pointer is absent from frames. Fallback:
  KasmVNC or noVNC.
- **S2 Perception:** Cua Driver on Linux X11 arm64 in that image. Accessibility tree with frames for
  Chromium, LibreOffice Calc and Writer, Thunar, the terminal and VSCodium; frame accuracy against
  screenshots at 1× and 2×; XTest input; its cursor overlay off. Fallback: an xdotool and pyatspi
  backend.
- **S3 Network:** internal networks and gates; `host.docker.internal` reaching a keyd bound to
  127.0.0.1; containers on internal networks unable to reach the host, the internet or DNS; inbound
  ports through the gate bound to 127.0.0.1 only.
- **S4 keyd data plane:** whether iron-proxy can be embedded with per-listener identity and a
  decision hook; whether Chromium trusts a name-constrained per-cell CA with `--proxy-server` and
  `--disable-quic`. Fallback: goproxy.
- **S5 Models:** Claude Sonnet 5.5's computer toolset through AI SDK v7 and keyd with a surrogate,
  end to end; Qwen3.8-27B through LM Studio and keyd; coordinate probe images for both.
- **S6 Timing:** measure injection-to-frame latency, set the compensation constant, and verify that
  the cursor lands on the dispatch frame.
- **S7 Codex harness:** the Codex app-server signed in with ChatGPT, running inside
  `sandbox-runtime`, calling localDot's MCP tools, including tool results that carry screenshots; its
  built-in shell and patch approvals declined; its thread, turn and item events mapped onto the event
  log. Fallback: ChatGPT plans stay unsupported and OpenAI is used with an API key.

## Risks and open questions

- keyd's SSRF guard denies private, loopback, link-local and Docker-VM addresses, but it allows
  the home network's own public address: with hairpin NAT a cell could reach the router's own
  services through it. Some non-global IPv6 ranges, VPN routes and other VLANs are also outside
  the deny set. Part 4b learns the host's public address(es) at keyd start and denies them
  (Part 4a Task 4 review, 2026-10-01).
- keyd keeps real secrets as login-Keychain items that any process running as the user can
  read (`security find-generic-password -w`), the daemon included. Until M9's signed keyd binary
  owns the items with an access list, trust rule 3 holds against accidental exposure, not
  against a compromised daemon or a malicious local process (Part 4a review M7, P4a-R3).
- The install link (`#token=`) stays in the browser's history, and synced history copies it to the cloud. The browser records the visit when the navigation commits, before any page script can run `replaceState`, and the token is reused across daemon restarts.
  - **Why it's accepted:** the token is a localhost-only credential. Host and Origin are checked, there is no CORS, and browsers block public pages from private-network requests. Reading the user's history is therefore no more than reading the user's 0600 token file.
  - **Later hardening (M9):** a single-use, short-lived `#code=` link that the UI exchanges for the token, so history keeps only a dead code.
  - (Part 2 Task 12 review, 2026-10-01.)
- Selkies 2.0 is a week old and has effectively two maintainers. The stream client sits behind our
  own interface with a VNC fallback, which S1 could not measure (its image pull was denied).
- Hosting Selkies' client inside localDot's own page is untested: S1 tapped the frames inside
  Selkies' own dashboard page, served through the proxy.
- Cua Driver changes fast. It is pinned, wrapped by `desktopd` and used for perception only; input
  goes through our own XTest client.
- `desktopd`'s own XTest client is unmeasured: S6 used xdotool as a stand-in (`windowactivate`
  without `--sync`, `click --delay 0`), and the real client has to reproduce those timings.
- Accessibility hit tests are slower than the cursor: 0.55–2.3 s in LibreOffice and Chromium,
  usually longer than cursor travel, so `action.target` will often trail the cursor unless CDP,
  which is unmeasured, answers first.
- Software H.264 at 2× costs 2.5–3× the container CPU of 1× (peak 251 % of a 400 % budget on an M3
  Ultra); its cost on M1-class hardware is unmeasured, and 1× stays switchable.
- The gate design needs Docker's isolated gateway mode for internal networks, verified on Engine
  29.2 only; `doctor` checks that the engine honors it. Apple `container` is the later backend for
  one VM per cell.
- The gate relays' bind addresses are untested: S3's socat relays listened on every interface.
  Binding the keyd relay only to the gate's internal-network address, while the inbound relay still
  accepts Docker's published-port traffic (which arrives through the egress bridge), needs its own
  check.
- Anthropic's and OpenAI's computer tools are unverified (S5 had no API credit): their coordinate
  space and streaming are assumed until `PROBE_CASES=anthropic,openai node probe.mjs` runs. Qwen's
  0–1000 grid is confirmed.
- Sub-project 2 ([avatar-name]) can start in parallel once the avatar interface above is agreed; it needs
  only `@localdot/avatar` and the event stream.
