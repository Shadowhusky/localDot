# localDot — agent virtual computer + streaming: environment & sandbox survey

Date: 2026-09-30 · Host target: Apple M3 Ultra, 96 GB, macOS 26 Tahoe, Docker Desktop (Engine 29.2.0, `docker sandbox` plugin v0.11.0 present), VMware Fusion.

Method: GitHub primary sources (READMEs, source files, release notes, image manifests) queried live with `gh`/registry APIs today, plus official docs pages via fetch. The general web-search budget ran out partway through, so a few claims rely on project docs I could fetch directly or on prior knowledge. Those are labelled.

Labels used throughout:
- **[V]** verified today from a primary source (repo file, release note, registry manifest, official doc).
- **[R]** reported by a secondary source (blog/news) fetched today.
- **[U]** unverified: prior knowledge, inference, or estimate. Test before relying on it.

---

## 0. Executive summary

**Recommended primary stack (Linux-first, container-based):**
1. **Guest desktop image:** our own OCI image `FROM ghcr.io/linuxserver/baseimage-selkies:ubunturesolute` (Ubuntu 26.04, amd64 and arm64 [V]), running **XFCE on X11**, themed with **MacTahoe/WhiteSur GTK + WhiteSur icons + Plank Reloaded dock**, with Chromium, Firefox, LibreOffice, VS Code, a terminal, Thunar and GIMP/Pinta, and AT-SPI switched on for GTK, Qt, Chromium and Electron.
2. **Streaming:** **Selkies 2.0** (released 2026-09-23 [V]). By default it streams H.264 from `pixelflux` over one WebSocket port and decodes in the browser with WebCodecs. WebRTC is optional. It needs no STUN/TURN. The cursor is sent out of band and can be switched off with `SELKIES_ENABLE_CURSORS=false`. There is an H.264 recording tap. Our own dashboard drives it through the documented `selkies-web-core` postMessage API [V]. Our overlay canvas (agent cursor, click ripples, typing HUD, element highlight boxes) sits on top of the `<video>` sink.
3. **Actuation and perception inside the guest:** **Cua Driver** (Rust, MIT). On Linux X11 it provides AT-SPI trees with element `frame`s in screen coordinates, XTest input, EWMH window management, window/desktop screenshots, recording, and MCP, Python and TypeScript SDKs [V]. Pair it with **CDP/Playwright** against the in-guest Chromium for DOM-level boxes. The fallback is a thin in-house daemon using xdotool/XTest + AT-SPI + CDP. OSWorld's `desktop_env/server/main.py` is a good reference for that [V].
4. **Host runtime:** **Docker Desktop** (already installed, so a one-command `compose up`). Keep the image OCI-clean so it also runs on **Apple `container` 1.5**, which gives one lightweight VM per sandbox on macOS 26 [V], and on **microsandbox**, which adds live snapshot and branch support (beta) [V].

**Fallback / "real macOS" track:**
- **Lume (MIT, part of trycua/cua).** Run macOS Tahoe VMs on Virtualization.framework. `lume create … --unattended tahoe` does an offline, GUI-less first-boot setup [V]. Stream the host-side VZ VNC server into **noVNC 1.7** embedded in our UI. Run **Cua Driver inside the guest** (AX + ScreenCaptureKit + Quartz input), with TCC grants baked into a golden image. Reset by cloning with APFS copy-on-write. Hard limit: 2 concurrent macOS VMs [V/R].
- **Tart (now `openai/tart`, FSL-1.1-ALv2)** [V] is an alternative. It has suspend/resume and Softnet egress filtering [V]. **Lima ≥2.1** (Apache-2.0) now also does macOS guests [V].
- **Streaming fallback for Linux:** VNC. Use KasmVNC 1.5 (WebCodecs video mode) or TigerVNC/x11vnc with noVNC. **neko v3** (WebRTC) is also viable, but its UDP needs special handling under Docker Desktop.

**Landscape changes you should know about (all [V] unless noted):**
- **Bytebot is archived** (last commit 2025-09-11).
- **Daytona's open-source repo is unmaintained.** Development went private in June 2026.
- **Cirrus Labs joined OpenAI** (announced 2026-04-07 [R]). Tart now lives at `openai/tart` under FSL-1.1-ALv2.
- **cua pivoted** to Cua Driver (Rust), Cua Fleets (cloud) and Cua Bench. The legacy `computer-server`'s **Linux accessibility tree is a hard-coded dummy stub** [V].
- **Selkies 2.0 dropped GStreamer.** It now uses pixelflux (Rust), WebSockets and WebCodecs.
- **linuxserver webtop moved from KasmVNC to Selkies** and ships **Pelorus**, an AT-SPI-based agent API. Pelorus is only 6★ and has no license file.
- **macOS 27 "Golden Gate"** was released 2026-09-14 [R]. It adds the official `VZMacGuestProvisioningOptions` first-boot API, which needs host and guest both on macOS 27 [V].
- **Apple `container` reached 1.x** (1.5.0 on 2026-09-29).
- **microsandbox** added live **branch/snapshot**.
- **Microsoft Quicksand** is new: MIT, QEMU VMs with XFCE desktop images and checkpoint/revert.
- **E2B Embed** runs the full E2B/Firecracker stack on one machine, including arm64 and inside a Lima VM on M3+ Macs.
- **Docker Sandboxes** is proprietary, free for local use, and aimed at CLI agents. It gives each sandbox its own microVM and has an egress-policy proxy. The standalone `sbx` v0.46 has `--publish` and custom templates, so a streamed desktop is *possible*. The Docker Desktop plugin v0.11 on this Mac has no port publishing. Details in §2G.

---

## 1. Repo health snapshot (queried 2026-09-30 via `gh repo view` + REST)

"Commits 90d" counts default-branch commits since 2026-07-02, capped at 100. Contributors and open counts come from the REST API. The open count includes PRs.

| Repo | ★ | Last push | Latest release | Commits 90d | Contribs | Open iss+PR | License |
|---|---|---|---|---|---|---|---|
| trycua/cua | 27,506 | 2026-09-29 | sandbox-v0.8.0 (09-15); cua-driver-rs v0.30.4 (09-28); nightly lume | 100+ | ~135 | 1,007 | MIT (optional perception ext. AGPL) |
| bytebot-ai/bytebot | 11,084 | 2025-09-12 | — | 0 | — | — | Apache-2.0, **ARCHIVED** |
| e2b-dev/E2B (SDKs) | 14,048 | 2026-09-30 | e2b 2.51.0 (09-18) | 100+ | — | — | Apache-2.0 |
| e2b-dev/runtime (ex-`infra`) | 1,644 | 2026-09-30 | 2026.30 (09-10) | 100+ | ~68 | 211 | Apache-2.0 |
| e2b-dev/desktop (template) | 1,500 | 2026-09-30 | desktop-python 2.4.2 (07-23) | 35 | ~16 | 12 | Apache-2.0 |
| e2b-dev/open-computer-use | 2,304 | 2026-07-09 | — | 1 | — | — | Apache-2.0 |
| e2b-dev/surf | 869 | 2026-09-09 | — | 4 | — | — | Apache-2.0 |
| anthropics/claude-quickstarts (computer-use-demo) | 17,770 | 2026-09-29 | — | 24 | — | — | MIT |
| openai/openai-cua-sample-app | 1,882 | 2026-09-04 | — | 23 | — | — | MIT |
| bytedance/UI-TARS-desktop | 39,169 | 2026-09-24 | v0.3.0 (2025-11-04) | 5 | — | — | Apache-2.0 |
| agent-infra/sandbox (AIO) | 6,043 | 2026-09-14 | v1.11.0 (06-23) | 8 | ~17 | 72 | Apache-2.0 |
| simular-ai/Agent-S | 12,449 | 2026-09-05 | v0.3.2 (2025-12-16) | 4 | — | — | Apache-2.0 |
| microsoft/magentic-ui (now "MagenticLite") | 10,090 | 2026-09-23 | v0.2.1 (05-21) | 5 | — | — | MIT |
| microsoft/quicksand | 55 | 2026-09-29 | quick-sandbox 0.12.0 (09-14); 30 component releases/90d | — | ~9 | 5 | MIT |
| OpenHands/OpenHands | 89,607 | 2026-09-30 | v1.24.0 (09-25) | 100+ | — | — | MIT |
| kortix-ai/suna (now "Kortix") | 20,238 | 2026-09-30 | v0.13.43 (09-30) | 100+ | — | — | other |
| FoundationAgents/OpenManus | 58,442 | 2026-09-30 | v0.3.0 (2025-04-10) | 9 | — | — | MIT |
| daytonaio/daytona | 71,680 | 2026-07-24 | v0.190.0 (06-23) | 0 | — | — | **unmaintained** (README notice) |
| docker/sbx-releases (Docker Sandboxes) | 412 | 2026-09-30 | v0.46.0 (09-28) | — | — | — | proprietary binaries |
| steel-dev/steel-browser | 7,712 | 2026-09-28 | v0.5.4-beta (08-25) | 10 | — | — | Apache-2.0 |
| browser-use/browser-use | 116,799 | 2026-09-30 | 0.13.10 (09-04) | 100+ | — | — | MIT |
| microsoft/playwright-mcp | 37,714 | 2026-09-28 | v0.0.83 (09-28) | 35 | — | — | Apache-2.0 |
| m1k1o/neko | 22,416 | 2026-09-30 | v3.1.6 (09-30) | 49 | ~74 | 148 | Apache-2.0 |
| selkies-project/selkies | 2,244 | 2026-09-30 | **2.0.0 (09-23)** | 100+ | ~33 | 8 | MPL-2.0 |
| selkies-project/pixelflux | 35 | 2026-09-30 | 2.1.0 (09-23) | — | ~12 | 0 | MPL-2.0 (official wheels link GPL x264/x265) |
| linuxserver/docker-webtop | 4,415 | 2026-09-29 | rolling (100 ls releases/90d) | 21 | ~7 | 0 | GPL-3.0 |
| linuxserver/docker-baseimage-selkies | 228 | 2026-09-29 | rolling, no `latest` by design | 32 | ~6 | 5 | GPL-3.0 |
| linuxserver/docker-baseimage-kasmvnc | 569 | 2025-07-12 | — | 0 | — | — | GPL-3.0 (superseded by Selkies) |
| linuxserver/pelorus | 6 | 2026-07-29 | 0.2.3 (07-28) | — | — | — | no license file |
| kasmtech/KasmVNC | 5,286 | 2026-09-23 | v1.5.0 (07-29) | 100+ | ~48 | 117 | GPL-2.0 |
| novnc/noVNC | 14,059 | 2026-09-07 | v1.7.0 (04-28) | 4 | ~178 | 111 | MPL-2.0 (mixed) |
| novnc/websockify | 4,464 | 2026-05-24 | v0.13.0 (2025-02-12) | — | — | — | LGPL-3.0 |
| apache/guacamole-server | 3,994 | 2026-09-14 | tag 1.6.0 | 64 | — | — | Apache-2.0 |
| Xpra-org/xpra / xpra-html5 | 2,996 / 340 | 2026-09-30 | v6.5.4 / v20 | 100+ / 16 | — | — | GPL-2.0 / MPL-2.0 |
| xlang-ai/OSWorld | 3,165 | 2026-09-14 | v0.1.16 (2024-06) | 17 | ~103 | 211 | Apache-2.0 |
| openai/tart (ex-cirruslabs) | 7,253 | 2026-09-30 | 2.40.1 (09-30), 10 rel/90d | 34 | ~52 | 74 | **FSL-1.1-ALv2** |
| cirruslabs/macos-image-templates | 378 | 2026-09-22 | "Xcode 27" (09-22) | 27 | — | — | MIT |
| lima-vm/lima | 21,992 | 2026-09-30 | v2.2.0 (07-21), v2.3.0-beta.0 (09-01) | 100+ | ~229 | 544 | Apache-2.0 |
| apple/container | 50,417 | 2026-09-30 | 1.5.0 (09-29) | 100+ | ~117 | 547 | Apache-2.0 |
| apple/containerization | 8,949 | 2026-09-29 | (0.45.x via container) | 56 | — | — | Apache-2.0 |
| superradcompany/microsandbox (ex-zerocore-ai) | 8,489 | 2026-09-30 | v0.7.4 (09-29), 20 rel/90d | 100+ | ~62 | 106 | Apache-2.0 |
| libkrun/libkrun | 2,734 | 2026-09-30 | v1.19.6 (09-29) | 100+ | — | — | Apache-2.0 |
| orbstack/orbstack (issue tracker only) | 9,376 | 2025-08-15 | — | 0 | — | — | proprietary (free personal use) |
| firecracker-microvm/firecracker | 37,063 | 2026-09-30 | v1.17.0 (09-10) | 100+ | — | — | Apache-2.0 |
| google/gvisor | 19,464 | 2026-09-30 | release-20260921.0 | 100+ | — | — | Apache-2.0 |
| kata-containers/kata-containers | 8,842 | 2026-09-30 | 4.2.0 (09-15) | 100+ | — | — | Apache-2.0 |
| utmapp/UTM | 35,694 | 2026-09-25 | v4.7.5 (2026-01-03) | 100+ | — | — | Apache-2.0 |
| openclaw/Peekaboo (ex-steipete) | 5,229 | 2026-09-30 | v4.6.0 (09-26) | 100+ | ~44 | 5 | MIT |
| microsoft/OmniParser | 25,478 | 2026-07-20 | v2.0.1 (2025-09-12) | 2 | — | — | CC-BY-4.0 repo; icon model AGPL |
| dockur/windows / dockur/macos | 53,444 / 21,590 | 2026-09 | v6.05 / v3.12 | 100+ | — | — | MIT (need x86 KVM, so not usable on this Mac) |
| microsoft/UFO (UFO³) | 9,881 | 2026-09-29 | v3.0.10 | 29 | — | — | MIT (Windows host automation) |
| mediar-ai/terminator | 1,645 | 2026-06-02 | v0.24.32 (04-05) | 0 | — | — | MIT (stalled) |
| browser-use/macOS-use | 2,000 | 2025-03-05 | — | 0 | — | — | MIT, **ARCHIVED** |
| OthersideAI/self-operating-computer | 10,295 | 2025-09-19 | v1.5.8 (2025-02) | 0 | — | — | MIT (stale) |
| showlab/computer_use_ootb | 1,967 | 2025-05-21 | — | 0 | — | — | Apache-2.0 (stale) |
| LizardByte/Sunshine | 41,709 | 2026-09-30 | v2026.914 | 100+ | — | — | GPL-3.0 |
| games-on-whales/wolf | 2,210 | 2026-09-29 | v2024.07 | 28 | — | — | MIT |
| Theme: vinceliuice/WhiteSur-gtk-theme / MacTahoe-gtk-theme | 9,311 / 1,621 | 2026-09 | — | — | — | — | MIT |
| Theme: WhiteSur-kde / MacTahoe-kde / WhiteSur-icon-theme | 1,283 / 279 / 2,078 | 2026-08/09 | — | — | — | — | GPL-3.0 / LGPL-3.0 / GPL-3.0 |
| Dock: zquestz/plank-reloaded | 442 | 2026-09-30 | — | — | — | — | GPL-3.0 |

Image availability, checked against registry manifests [V]:
- `ghcr.io/linuxserver/webtop:ubuntu-xfce` / `:ubuntu-kde` are amd64 + arm64. The arm64 dev tag is about 1.75 GB compressed.
- `ghcr.io/selkies-project/selkies/desktop:2.0.0-ubuntu26.04` is amd64 + arm64. Its desktop is LXQt.
- `ghcr.io/m1k1o/neko/{xfce,kde,chromium}:latest` are amd64 + arm64. The old Docker Hub `m1k1o/neko` is amd64-only v2.
- `kasmweb/ubuntu-noble-desktop:1.19.0-rolling-weekly` is amd64 (4.3 GB) + arm64 (2.57 GB).
- `trycua/xfce-cua` is amd64 + arm64, about 0.45 GB. `trycua/cua-xfce` is amd64 only, 7.4 GB. `trycua/cua-ubuntu` is amd64 (6.1 GB) + arm64 (1.9 GB).
- `ghcr.io/agent-infra/sandbox:latest` is amd64 + arm64.
- `ghcr.io/trycua/macos-tahoe-cua:26.5.2` is a Lume OCI image: 301 layers, **23.1 GB compressed**, **150 GiB logical sparse disk**, defaults of 4 vCPU / 8 GiB / 1024x768 / NAT. `macos-tahoe-vanilla` is 21.0 GB compressed on a 100 GiB disk.

---

## 2. Candidate notes

### 2A. Full "agent computer" platforms

**trycua/cua (Cua): Lume + Cua Driver + Sandbox SDK + Fleets + Bench** [V]
- **Purpose.** "Give AI agents computers they can use." It is now organised as Cua Fleets (paid cloud desktops), Cua Driver (open automation driver), Lume (local macOS/Linux VMs), CUA-S1 (small decision models), Cua Bench (tasks and trajectories) and `cuabot` (Docker + Xpra co-op sandbox).
- **Isolation.**
  - Lume: VZ VMs for macOS and Linux guests.
  - Docker: Linux container images.
  - QEMU: Linux and Windows VMs. The local Linux VM runtime requires `qemu-system-x86_64`, which means emulation on this Mac.
  - Hyper-V and Android emulator runtimes also exist.
  - The Sandbox SDK also supports a Tart runtime (`cua_sandbox/runtime/tart.py`).
- **Guest OSes.** macOS (Tahoe/Sequoia images), Linux (XFCE Docker images; Omarchy/Hyprland on Fleet), Windows (QEMU/Hyper-V), Android.
- **Streaming.** VNC/noVNC everywhere. For macOS, Lume runs Apple's private `_VZVNCServer` on the host [V, `libs/lume/src/VNC/VNCService.swift`]. Linux images serve noVNC on 6901/6080. Lumier is a Debian arm64 container that talks to host `lume serve` (port 7777) and serves a trycua noVNC fork.
- **Actions and perception.**
  - **Cua Driver** (Rust daemon with UniFFI Python/TS SDKs; MCP over stdio or HTTP with a bearer token; CLI `cua-driver call`) [V]:

    | Platform | Tree / window source | Capture | Input |
    |---|---|---|---|
    | macOS | AX | ScreenCaptureKit | Quartz/HID |
    | Windows | UIA | — | SendInput |
    | Linux X11 | AT-SPI over D-Bus via zbus (no pyatspi), EWMH windows | window/desktop screenshots | XTest; AT-SPI `do_action` for background actions |
    | Linux Wayland | AT-SPI | portal/libei | portal/libei |

    Chromium also gets typed browser actions. Elements come with `frame` in screen coordinates plus screenshot-scale metadata. Tools include `list_apps`, `list_windows`, `get_window_state`, `get_desktop_state`, `click`/`type_text` bound to `element_token`, `verify_state`, `start_recording`/`stop_recording` (per-turn folders; MP4 via SCRecordingOutput on macOS or ffmpeg `x11grab` on Linux), and an in-guest "agent cursor" overlay with dotLottie themes. It has permission modes (standard/bounded/unrestricted).
  - **Legacy `cua-computer-server`** (Python, HTTP/WS/MCP on port 8000): shell, files, windows, clipboard and screenshots, with an accessibility tree on macOS and Windows only. **On Linux, `get_accessibility_tree` returns a hard-coded dummy tree** (`handlers/linux.py`) [V]. It can also delegate to Cua Driver (`--backend cua-driver`) or drive a remote target over RFB (`--backend vnc`).
- **Recording/replay.** Cua Driver trajectory folders plus MP4; Cua Bench exports trajectories.
- **Setup.** One-line installers for the driver and Lume (`curl … | bash`); `docker run trycua/xfce-cua`; `pip install cua-sandbox`.
- **Apple Silicon.** Lume is Apple-Silicon native. `xfce-cua` and `cua-ubuntu` are multi-arch. `cua-xfce` is amd64-only.
- **Quality signals.** 173 CI workflows, a generated C ABI header checked in CI, hermetic Rust tests, a desktop E2E harness per OS, and daily nightlies. The flip side is **very high churn**: 1,007 open issues+PRs, frequent contract changes, and a complex permission/"proof" model.
- **Telemetry.** Lume telemetry is on by default and can be disabled (`lume config telemetry disable`) [V].
- **Security note.** **Lume's VNC listener binds all interfaces (`*:<port>`)**. Open RFC #3878 would add a bind address [V].
- **Verdict.** The best-engineered actuation/perception layer, and the best macOS-VM tooling. Their Linux containers use plain VNC, which is not a polished streaming path.

**Bytebot** [V] is **archived** (last commit 2025-09-11).
- Architecture, useful as a reference: supervisord runs `Xvfb :0 1280x960` → XFCE → `x11vnc` → `websockify 6080`. The `bytebotd` NestJS daemon uses `@nut-tree-fork/nut-js` (XTest) for input and screenshots. There is a Next.js UI with takeover.
- No accessibility tree.
- Verdict: reference only.

**E2B Desktop / open-computer-use / Surf / E2B runtime (Embed)** [V]
- **Desktop template.** Ubuntu 22.04 with Xvfb, XFCE, xdotool, scrot, ffmpeg, x11vnc and an e2b fork of noVNC. Apps: LibreOffice, gedit, xpaint, pcmanfm, plus `google-chrome-stable` and `code` from **amd64-only apt repos**. The SDK has `stream.start(window_id=…)` for single-window streams, view-only URLs and auth keys.
- **Isolation.** Firecracker microVMs, snapshot-resumed.
- **E2B Embed** is "the whole stack, real Firecracker sandboxes included, on a single Linux host with KVM". It is a docker-compose "evaluation package". On a Mac it runs "inside a Linux virtual machine (Apple silicon M3 or newer, macOS 15 or newer)" with nested virtualisation, for example Lima. arm64 was verified end-to-end on bare metal on 2026-09-14. Features: pause/resume, fork of up to 100 per request, templates from Docker images.
- **open-computer-use.** 1 commit in 90 days; depends on E2B cloud.
- **Verdict.** Excellent snapshot/fork semantics, but the local story is heavy: PostgreSQL, Redis, ClickHouse, a nested-virt Linux VM, and amd64-centric desktop apps. Not for a one-command localhost install. The fork/pause design is worth borrowing.

**Anthropic computer-use-demo** (anthropics/claude-quickstarts) [V]
- Ubuntu 22.04 with Xvfb, mutter, tint2, x11vnc and noVNC 1.5.0. xdotool does the input; `gnome-screenshot`/`scrot` plus ImageMagick resize do the screenshots.
- Streamlit UI. Latest tool version is `computer_toolset_20260801` (GA, no beta header). No a11y tree, no recording.
- Verdict: the canonical minimal reference for the tool contract, not a foundation.

**OpenAI CUA sample app** [V]
- Now two "code-writing" agents: JavaScript + Playwright controlling a browser, and Python + a persistent PyAutoGUI worker controlling **your real desktop**.
- It has a shared console, replay JSON and a screenshot timeline.
- It explicitly provides **no OS sandbox**. Verdict: a useful pattern (code as action plus a replay timeline), not an environment.

**UI-TARS-desktop / Agent TARS** [V]
- Electron app plus CLI. Local operators use nut-js on the host. Remote operators use ByteDance cloud VMs. Agent TARS uses the **AIO Sandbox** (below).
- Activity slowed: last release v0.3.0 in 2025-11 and 5 commits in 90 days.

**AIO Sandbox (agent-infra/sandbox)** [V]
- One Docker container (amd64 + arm64) serving on port 8080. It bundles a Chromium you watch over VNC and drive over **CDP**, a shell/file API, Jupyter, code-server, and MCP hub servers (browser/file/shell/markitdown). It supports an API key. SDKs exist for Python, TypeScript and Go.
- It is browser-centric rather than a full desktop. No releases in the last 90 days.
- Verdict: a good model for the "code and API plus GUI" (Computer-Use 2.0) side of the environment. Its desktop is not rich enough to be the base.

**Agent S (Simular)** [V] is an agent framework (S2/S3) using pyautogui on the host plus grounding models. It has no environment. Not a foundation.

**Magentic-UI → MagenticLite + Microsoft Quicksand** [V]
- MagenticLite runs browser sessions "inside a lightweight VM sandbox (Quicksand)".
- **Quicksand** (MIT, created 2026-04) is an async Python API for QEMU VMs. It supports x86_64 and ARM64 on macOS, Linux and Windows, with no root and no Docker needed.
  - Prebuilt images: `ubuntu-desktop` (Ubuntu 24.04 + Xfce4 + Firefox, about 280 MB overlay), `alpine-desktop` (Xfce4 + Chromium), and `quicksand-cua` (Xvfb, x11vnc, noVNC, Playwright, Chromium).
  - `screenshot()`, `mouse_move/click`, `type_text` via QMP input injection plus VNC.
  - `checkpoint()`/`revert()` (qcow2 overlays, `savevm`) and `save()`/load.
  - Network-isolated by default.
- Verdict: a young but credible VM-per-sandbox option with snapshots. Watch it. On macOS it uses QEMU with HVF acceleration [U].

**OpenHands** [V/U] is a coding-agent platform with a Docker or remote runtime. A code search of `OpenHands/OpenHands` and `OpenHands/software-agent-sdk` for `novnc`, `vnc` and `Xvfb` found no desktop-streaming code. The browser is headless automation [U]. Not a desktop foundation.

**Kortix (ex-Suna)** [V] repositioned as an "AI Management System". Sessions run on disposable "cloud computers", with a self-host path. License is "other". Not a local desktop foundation.

**OpenManus** [V] is a framework. Browser automation comes from the Browser Use CLI via MCP, and there is no desktop environment. Last release 2025-04.

**Daytona** [V] carries a README notice: "As of June 2026, Daytona's core development has moved to a private codebase. This repository will receive no further updates". Avoid it.

**Docker Sandboxes (`docker sandbox` / `sbx`)** [V]
- MicroVM sandboxes for **coding CLI agents** (claude, codex, copilot, gemini, kiro, cagent). Each has its own Docker daemon. Outbound TCP goes through a host proxy with network policies and credential injection. `save` stores a snapshot as a template.
- Proprietary binaries (`docker/sbx-releases`). Free for local use; cloud is pay-as-you-go.
- Full evaluation for hosting a GUI desktop is in **§2G**. In short: technically possible with the **standalone `sbx` CLI** (custom template plus `--publish`), but **not with the Docker Desktop-bundled plugin v0.11.0** on this Mac, which has no port publishing. It is also proprietary and fast-moving, so at most an optional backend.

### 2B. Browser-only layers (complements, not foundations)
- **browser-use** (116.8k★, MIT): CDP-based DOM extraction with indexed elements and bounding boxes, highlight overlays, cloud browsers [U on internals].
- **Playwright MCP** (37.7k★, Apache-2.0): accessibility-snapshot (aria) based refs, with optional vision/coordinate mode, trace and video saving [U on flags].
- **Steel browser** (7.7k★, Apache-2.0): headful Chrome API over CDP, Puppeteer/Playwright/Selenium, sessions, a debug UI [V from README].

Use CDP/Playwright *inside* our sandbox for DOM-accurate perception. Don't make the sandbox browser-only.

### 2C. Desktop streaming stacks

**Selkies 2.0** (selkies-project/selkies, MPL-2.0; release 2.0.0 on 2026-09-23) [V]
- **Architecture.** A single Python app on one port with the HTML5 client bundled. **GStreamer is gone.** Capture and encode are done by `pixelflux` (Rust), audio by `pcmflux` (Opus).
- **Transport.**
  - **WebSockets by default**, on a single TCP port carrying video, audio, input, clipboard and files. Decoded via **WebCodecs**, with a striped-JPEG fallback. **No STUN/TURN.**
  - WebRTC is opt-in (`--mode=webrtc`, vendored aiortc fork, single-port UDP/TCP mux or ICE-lite). Dual-mode switching is available.
- **Codecs.** H.264 (default), H.265, VP8, VP9 and AV1 on NVENC/VA-API, falling back to software: x264/OpenH264, x265/kvazaar, libvpx, SVT-AV1. Striped H.264 and JPEG are also available. There is a codec ladder per client.
- **Backends.** X11 by default (patched Xvfb, DRI3 zero-copy when on a GPU); Wayland optional.
- **Cursor.** Delivered out of band (XFixes). Settings:
  - `--enable-cursors` (default true) — "Enable passing remote cursors to client"
  - `--use-browser-cursors` (CSS cursors)
  - `--cursor-size`
- **Resolution.** `--manual-resolution/width/height`, `--scaling-dpi`.
- **Frame rate.** `--framerate` 8–240, default 60.
- **Recording.** `--recording-socket`: "Unix socket path for the out-of-band H.264 recording tap".
- **Access control.** Secure mode (`--master-token`), view-only passwords, session sharing with viewer and player roles enforced server-side, and an audit webhook.
- **Client.** `selkies-web-core` exposes a **postMessage API for external dashboards**, for example `setManualResolution`. It renders via `VideoTrackGenerator` (Safari 18+), `MediaStreamTrackGenerator` (Chromium) or an OffscreenCanvas worker (Firefox) into a `<video>` sink.
- **Platforms.** Hosts are "Linux only; macOS and Windows support is not implemented". Packages: pip wheel, deb/rpm/apk/Arch, AppImage, multi-arch images.
- **Health.** 1,268 commits since v1.6.2, but **bus factor ≈2** (@ehfd 802, @thelamer 411). The release notes say "We are in need of maintainers".
- Verdict: the **best fit for streaming** a Linux sandbox into a custom web UI.

**linuxserver Selkies baseimages + webtop** (GPL-3.0) [V]
- These "replace our old base images at KasmVNC for greatly increased performance, fidelity, and feature set".
- Distros: Alpine 3.24, Arch, Debian trixie, Fedora 44, Kali, Ubuntu "resolute" (26.04). All are x86_64 + aarch64.
- Webtop flavours: XFCE, KDE, MATE, i3 and LXQt, on Ubuntu, Debian, Fedora, Arch and Alpine. Updated for Selkies v2 on 21.09.26.
- Ports: 3001 serves HTTPS directly. 3000 is HTTP "for use behind a reverse proxy, do not browse to it directly". "HTTPS is required … (WebCodecs) only work in a secure context".
- **Security defaults:** "By default there is **no authentication**"; "the web interface includes a terminal with passwordless `sudo`".
- `--shm-size=1gb` is recommended. Includes proot-apps and Docker-in-Docker options (don't enable the docker.sock mount for agents).
- Add-ons:
  - **Pelorus** (`PELORUS=true`): FastAPI agent plus a Computer Use API over **AT-SPI**. It starts the AT-SPI registry and forces the GTK/Qt a11y bridges on. Endpoints include `GET /api/windows`, `GET /api/desktop/explore/{pid}` (tree with absolute screen coordinates), `POST /api/desktop/control` and `GET /api/desktop/screenshot`. "The API has no authentication of its own". 6★, no license file.
  - **pixelflux Computer Use** (`PIXELFLUX_CU=<port>`): `POST /computer-use` with Anthropic-style actions (screenshot, left_click, type, key, scroll, zoom).
- The ubuntu-xfce arm64 image installs Chromium from the xtradeb PPA (non-snap), XFCE, mousepad and xfce4-terminal. Apps are minimal; extend it yourself.

**neko v3** (m1k1o/neko, Apache-2.0) [V/U]
- Purpose: a self-hosted virtual browser/desktop streamed over **WebRTC**. Server in Go with Pion; GStreamer capture and encode [U].
- Multi-user control handover. REST API: screenshot `/screen-shot-image`, screencast, screen config, control request/take/give, clipboard, sessions, RTMP broadcast.
- arm64 images: xfce, kde, chromium, firefox (browsers "require extra DRM steps on ARM64").
- WebRTC config: `NEKO_WEBRTC_EPR` (must map UDP ports **without remapping**), `udpmux`/`tcpmux` single-port, `nat1to1`, `icelite`. "not possible to use nginx or other reverse proxies to forward the WebRTC traffic".
- Recording is only via RTMP broadcast into nginx-rtmp.
- Verdict: a solid WebRTC fallback. Docker Desktop-on-Mac networking makes it fiddlier than Selkies WebSockets.

**KasmVNC 1.5.0** (GPL-2.0) [V]
- A modern Xvnc (X server with a built-in VNC server) plus a web client forked from noVNC.
- Encodings: JPEG/WebP/QOI with dynamic quality, multi-threaded encode, **WebCodecs video streaming (H.264/H.265/AV1) new in 1.5.0**, WebRTC UDP transit, DLP clipboard controls, a `get_screenshot` API.
- arm64 packages and images are available (Kasm ubuntu-noble-desktop arm64 is 2.57 GB).
- Kasm Workspaces, the orchestration platform, is commercial (Community Edition free) [U].
- Verdict: the best **VNC-family** option if Selkies fails.

**noVNC 1.7.0 + websockify** [V]
- An embeddable RFB client library (`@novnc/novnc`, now ESM). **H.264 support added in 1.6.0** (WebCodecs).
- Cursor: the server cursor (Cursor pseudo-encoding) is applied as `target.style.cursor = url(data…)`, or an emulated canvas on touch devices (`core/util/cursor.js`). This is easy to override. `showDotCursor` was removed in 1.7.
- websockify has `--record` for session traffic recording.
- Verdict: the universal fallback and the **only practical path for macOS VMs** (VZ VNC or guest Screen Sharing).

**Apache Guacamole 1.6.0** [V/U] uses a `guacd` proxy (VNC/RDP/SSH) and the Guacamole protocol over WebSocket. The JS client renders layered canvases. Built-in session recording and `guacenc` [U]. Heavy (Java webapp) and adds a hop. Not needed.

**Xpra** (v6.5.4) [V/U] offers per-window "seamless" streaming with an H.264/VP9 HTML5 client. Cua's `cuabot` uses it. Interesting for single-app streaming, but not needed.

**Sunshine / Wolf (Moonlight)** [U] are game-streaming protocols that need GPUs and native clients. Not browser-native, so skip.

### 2D. Benchmarks / environments
**OSWorld** [V]
- Providers: VMware (**VMware Fusion on Apple chips**), VirtualBox, Docker (QEMU+KVM; "macOS hosts generally do not support KVM"), AWS, Azure, Modal and Daytona.
- In-guest Flask server (`desktop_env/server/main.py`):
  - pyautogui actions.
  - `/accessibility`: pyatspi tree with `component.getExtents(pyatspi.XY_SCREEN)` bounding boxes on Linux; pywinauto on Windows; `AXUIElementCopyAttributeValue(..., "AXFrame")` on macOS.
  - `/start_recording`: `ffmpeg -f x11grab -draw_mouse 1 … libx264`.
  - Window activate/close, file and setup endpoints.
- Verdict: **the best reference implementation** for a perception API across OSes.

### 2E. Isolation / VM runtimes on this Mac

| Runtime | Tech | Guests | Snapshots / clone | GUI / display | Notes |
|---|---|---|---|---|---|
| **Lume** (cua, MIT) | Virtualization.framework | macOS, Linux | `clone` (APFS CoW); no VZ save-state (code search found no `saveMachineStateTo`) | VZ VNC server (private `_VZVNCServer`), also a window | `--unattended tahoe` offline setup (creates `lume` user, marks Setup Assistant done, autologin, SSH, no sleep/lock; "Tahoe is E2E verified"). `lume serve` HTTP API on 7777. `lume sip` via vncdotool in Recovery. Default disk 100 GB (macOS). **VNC binds all interfaces** [V] |
| **Tart** (openai/tart, FSL-1.1-ALv2) | VZ | macOS, Linux | `clone` (APFS CoW); `--suspendable` + `tart suspend` (VZ save-state) [V] | built-in window, `--vnc` (guest Screen Sharing), `--vnc-experimental` (VZ VNC, "may be bugs") | Softnet egress allow/block CIDRs and port expose; `--nested` for Linux guests; `--provisioning-opts` (VZMacGuestProvisioningOptions; host and guest macOS 27) [V]. Images `ghcr.io/cirruslabs/macos-tahoe-base` (~25 GB, admin/admin). Relicensed after the OpenAI deal: **FSL = source-available, non-compete clause, converts to Apache-2.0 after 2 years** [V] |
| **Lima ≥2.1** (Apache-2.0, CNCF) | VZ / QEMU / krunkit | Linux, **macOS (templates macos-15/26/27)** [V] | — | `video.display`, VNC | macOS unattended via `guestpatch/macos` (raw APFS patching; issue #5516 plans VZMacGuestProvisioningOptions) [V]. `nestedVirtualization` with vz/krunkit on **M3+ and macOS 15+** [V] |
| **UTM** (Apache-2.0) | QEMU + VZ | macOS, Linux, Windows | QEMU snapshots | GUI app | Scripting via `utmctl`. PR #7881 adds macOS 27 provisioning [R]. Desktop app, not headless-first |
| **VMware Fusion** (installed) | own hypervisor | Linux/Windows arm64 | snapshots | GUI, `vmrun` | OSWorld's supported provider on Apple chips [V]. macOS guests on Apple Silicon **not supported** [U] |
| **Apple `container` 1.5** (Apache-2.0) | Containerization (VZ) | Linux (OCI) | `container export` of live containers (filesystem only) [V] | none (run Xvfb inside) | **One lightweight VM per container**. macOS 26 required for full networking. `-p`, `--shm-size`, `--volume`, `--virtualization` (expose KVM inside; M3+). Memory ballooning is partial: freed guest pages are not returned to macOS [V] |
| **Docker Desktop** (installed) | 1 shared Linux VM | Linux (OCI) | `docker commit` (filesystem) | none (Xvfb inside) | Host protected by the VM boundary; sandbox-to-sandbox separation is namespaces only [U]. One-command UX already on the machine |
| **Docker Sandboxes** (`sbx` v0.46 standalone; Desktop plugin v0.11 installed) | microVM per sandbox (hypervisor undisclosed) | Linux (custom template, UID 1000 `agent`) | `template save` (filesystem); live snapshot/fork **cloud-only** | `display` socket option (undocumented semantics); run Xvfb inside | `sbx ports --publish` (plugin v0.11 has none); host TCP egress proxy with allow/deny policies and JSON logs; proprietary, free locally. See §2G |
| **microsandbox 0.7** (Apache-2.0, beta) | libkrun (HVF on macOS) | Linux (OCI) | **live `branch` (fork running VM), `snap create/restore` full state** [V] | none (Xvfb inside) | <100 ms boot claimed (M1). Network policy, secrets that never enter the VM, MCP server. "still beta … breaking changes" |
| **Quicksand** (MIT, young) | QEMU | Linux (Ubuntu/Alpine; desktop images) | `checkpoint`/`revert`, `save` [V] | VNC + QMP input | Network-isolated by default |
| **OrbStack** | proprietary | Linux, Docker | — | — | Free personal, $8/user/mo commercial [V]. Closed source, so it doesn't fit an OSS foundation |
| **Firecracker / Kata / gVisor** | KVM microVM / KVM VM / user-space kernel | Linux | FC snapshots | none | Need Linux (KVM). On this Mac only **inside a nested-virt Linux VM** (Lima vz on M3+/macOS 15+ [V], or `container --virtualization` [V]). Only worth it if we adopt E2B Embed-style infra |
| **dockur/macos, dockur/windows, Docker-OSX** | QEMU+KVM x86 | macOS/Windows x86 | — | noVNC/web | **Not viable on Apple Silicon** (need x86 KVM) [U] |

### 2F. In-guest actuation / perception layers
- **Cua Driver** [V]. Summarised above. The richest cross-OS layer: AX, UIA and AT-SPI trees with screen-space frames, background (focus-free) delivery where possible, recording and MCP. Caveats: fast-moving; on macOS it needs a stable signed app identity for TCC (`CuaDriver.app` or an embedded host); its own synthetic cursor overlay should be disabled if we draw ours (`set_agent_cursor_enabled`).
- **pixelflux CU + Pelorus** [V]. Built into the Selkies images: raw input and screenshot endpoint plus an AT-SPI "text desktop". Immature and unauthenticated, but proves the AT-SPI-in-container recipe works with Selkies.
- **OSWorld server** [V]. A reference for pyatspi, pywinauto, AX and ffmpeg recording.
- **Peekaboo** (openclaw, MIT, macOS 15+) [V]. Swift CLI plus MCP: `see --app X --json` gives "a structured UI map with opaque element IDs"; background-delivered click/type/press; window, menu and dock control. A good alternative to Cua Driver inside macOS guests.
- **Raw building blocks** [U]:
  - xdotool / python-xlib XTest for input (what the Anthropic, E2B and Bytebot stacks use);
  - `mss`/XShm for screenshots;
  - pyatspi or the Rust `atspi` crate for trees;
  - `wmctrl`/EWMH for windows;
  - CDP for DOM.
  - uinput isn't normally available in Docker Desktop containers. Wayland needs libei or portals, so **prefer X11**.
- **Vision fallback.** OmniParser v2 (repo CC-BY-4.0; icon-detect model AGPL per Cua's notices [V]); Cua's optional `cua-perception` extension (AGPL component) [V]; grounding models such as UI-TARS [U].

### 2G. Can Docker Sandboxes host a GUI desktop sandbox for localDot? (coordinator request)

**What is on this Mac** [V: local `--help` output]:
- Docker Engine 29.2.0 ships the `docker sandbox` CLI plugin at **`github.com/docker/sandboxes/cli-plugin v0.11.0`**.
- Commands: `create <agent> WORKSPACE`, `run`, `exec` (`-d`, `-e`, `-u`, `-w`, `--privileged`), `ls` ("List all VMs managed by sandboxd"), `save SANDBOX TAG [-o tar]` ("Save a snapshot of the sandbox as a template"), `stop`, `rm`, `reset`, `network proxy <sb>` (`--allow/--block/--bypass-host|cidr`, `--policy allow|deny`) and `network log --json`.
- `create`/`run` accept `-t/--template <image>`. Built-in agents: cagent, claude, codex, copilot, gemini, kiro.
- **No port-publishing flag anywhere in the plugin's help.**
- State lives in `~/.docker/sandboxes/vm/`. The Docker Desktop VM currently has 10 CPUs and 15.7 GB (`docker info`). The sandbox microVMs appear to be separate VMs managed by `sandboxd`, so their resources are not necessarily drawn from that allocation [U].

**Standalone `sbx` CLI** (docs.docker.com/ai/sandboxes; releases in `docker/sbx-releases`, latest v0.46.0 on 2026-09-28) [V]:
- Install with `brew install docker/tap/sbx`. It needs **macOS 14+ on Apple silicon**, and "You don't need Docker Desktop or Docker Engine to use `sbx`".
- **Ports.** `sbx run --publish 8080:3000 --name my-sandbox claude`, `sbx ports my-sandbox --publish 8080:3000`, `--unpublish`, list. Since v0.42.0 published ports default to `tcp4`, and an explicit protocol and host-interface binding are available. `ports:` can also be declared in `.sbxenv.yaml` (auto-ephemeral host port if omitted).
- **Custom templates.** Any image works. It needs "a non-root `agent` account with UID 1000 and home directory `/home/agent`", `ENTRYPOINT`/`CMD` set to "the agent or shell you want the sandbox to launch", `curl`, `git`, CA certs, `/bin/sh` and `/bin/bash`. Use `sbx run -t my-template:v1 …` or `sbx template load/save/ls`. There is also a `shell` agent that runs arbitrary commands.
- **Display.** `.sbxenv.yaml` `sandboxOptions.display` = "Provision a display socket for graphical applications", added in v0.43. There are also `gpu` and `usb` options, the latter experimental and "Linux x86_64/ARM64 only". Which host OSes support `display` and how (Wayland/X11 socket forwarding) is **not documented**. For localDot this doesn't matter: we render headless (Xvfb) inside and stream out over a published TCP port.
- **Resources.** `cpus` and `memory` per sandbox, minimum 512 MiB; the per-sandbox Docker volume is 10 GB.
- **Isolation.** "Every sandbox runs inside a lightweight microVM with its own Linux kernel". Sandboxes "cannot communicate directly with each other or share a network with your host". "All outbound TCP traffic passes through a proxy on your host that enforces the network access policy". The hypervisor on macOS is not named.
- **Snapshots.** Local `template save` produces a filesystem image. Live **snapshot/fork/restore exists only in the cloud Sandboxes API** (`createSnapshot`, `restoreSnapshot`, "clone a cloud sandbox").
- **Licence.** "The `sbx` CLI and local sandbox compute are free to use, including for commercial and professional work"; cloud is pay-as-you-go; governance features are paid. **The source is closed** (the `docker/sandboxes` repo is not public).

**Assessment for a GUI desktop sandbox:**
1. **Port exposure and streaming.**
   - With `sbx` (not the v0.11 plugin), yes: publish the Selkies WebSocket port (TCP) with `--publish 127.0.0.1:…`.
   - **WebRTC is a poor fit.** Outbound traffic is proxied as TCP, and UDP egress or inbound UDP is undocumented [U]. That strongly favours Selkies' single-TCP-port WebSocket mode, which is our primary choice anyway.
   - VNC/noVNC over a published TCP port also works in principle [U].
2. **arm64 templates.** The sandboxes run on Apple silicon and need an image for the VM's architecture. Our multi-arch image (linuxserver Selkies base is aarch64 [V]) should work. Whether `sbx` falls back to amd64 via emulation or Rosetta is **undocumented** [U].
3. **Template-contract friction.**
   - linuxserver images use s6-overlay as PID 1 with user `abc` (PUID/PGID remap) and home in `/config`. sbx wants UID 1000 `agent` with `/home/agent`, and ENTRYPOINT as "the agent or shell".
   - We'd need a purpose-built template: create `agent` (1000), set HOME, and launch Xvfb, XFCE, Selkies and Cua Driver from our own entrypoint or supervisor, or from `sbx exec -d …` after start.
   - Caveats:
     - `exec -d` exists in the old plugin, but v0.46 notes say "Unsupported detached execution with `sbx exec -d` … now fails immediately" in some contexts [V].
     - The DE needs `/dev/shm` sizing (unknown whether it's configurable) [U].
     - The workspace mount semantics are designed for code repositories.
4. **Pluses.** Per-sandbox microVM (stronger than Docker Desktop's shared VM); a built-in egress policy proxy with allow/deny host/CIDR lists and JSON network logs (great for agent safety and audit); credential injection outside the VM; one-command install; free for local use.
5. **Minuses.**
   - Proprietary and closed.
   - The CLI surface churns weekly (v0.39 → v0.46 in six weeks, with breaking changes).
   - Two divergent frontends: the Desktop plugin v0.11 versus `sbx` v0.46.
   - The agent-centric model (workspace, kits, agent entrypoint).
   - No local live snapshot or fork.
   - Undocumented GUI/UDP/arch behaviour.
   - Requiring users to install `sbx` breaks the "only Docker Desktop" story, though brew is one command.

**Verdict.** Don't use it as the primary runtime. Keep it as an **optional "hardened" backend** behind localDot's runtime abstraction, alongside Apple `container`. It needs a hands-on spike:
1. `brew install docker/tap/sbx`.
2. Build a `localdot/desktop-sbx` template (UID 1000 `agent`, entrypoint → supervisor starting Xvfb, XFCE and Selkies WS on :8080).
3. `sbx run -t localdot/desktop-sbx:dev --publish 127.0.0.1:18080:8080 shell`.
4. Open `http://127.0.0.1:18080`.
5. Check fps and latency, whether `/dev/shm` suffices for Chromium, whether AT-SPI's D-Bus works, whether published ports survive stop and restart, and whether network-policy logs capture the desktop's egress.

The old `docker sandbox` plugin (v0.11) cannot do step 3 because it has no `--publish`. The spike was not run: it would install software and create VM state outside the scratchpad.

---

## 3. Comparison table (environment + streaming)

| Candidate | Isolation | Guest OS | Streaming | Action exec | Structured UI state | Recording | Setup | Apple Silicon | License | ★ / last push |
|---|---|---|---|---|---|---|---|---|---|---|
| **Selkies 2.0 + linuxserver webtop** | container (any OCI runtime) | Linux (many distros/DEs) | **H.264/H.265/VP9/AV1 over WebSocket → WebCodecs**; opt. WebRTC | pixelflux injection (Selkies input); pixelflux CU API; add xdotool/Cua Driver | Pelorus (AT-SPI + windows) optional; add Cua Driver | H.264 recording socket | `docker run -p 3001:3001 --shm-size=1g` | arm64 ✅ | MPL-2.0 / GPL-3.0 | 2.2k / 4.4k, 2026-09-30 |
| neko v3 | container | Linux (xfce, kde, browsers) | **WebRTC** (Pion) | XTest (xorg dummy + neko driver) [U]; REST control | none | RTMP broadcast | docker run, UDP ports | arm64 ✅ | Apache-2.0 | 22.4k, 2026-09-30 |
| KasmVNC / Kasm images | container | Linux | VNC (JPEG/WebP/QOI) + **WebCodecs video mode** | XTest via Xvnc | none | (Workspaces enterprise) [U] | docker run | arm64 ✅ | GPL-2.0 | 5.3k, 2026-09-23 |
| trycua xfce-cua | container | Linux (Debian XFCE) | VNC/noVNC | Cua Driver (XTest/AT-SPI) | **AT-SPI tree + frames** (Cua Driver) | Cua Driver MP4 + turns | docker run | arm64 ✅ | MIT | 27.5k, 2026-09-29 |
| AIO Sandbox | container | Linux (browser-centric) | VNC | CDP + MCP | DOM via CDP | — | docker run | arm64 ✅ | Apache-2.0 | 6.0k, 2026-09-14 |
| E2B Desktop (+Embed) | Firecracker microVM | Linux | VNC/noVNC | xdotool | none | ffmpeg present | cloud, or Embed (heavy) | Embed arm64 ✅ via nested Lima; apps amd64 | Apache-2.0 | 1.5k/1.6k, 2026-09-30 |
| Anthropic demo | container | Ubuntu 22.04 | VNC/noVNC 1.5 | xdotool | none | — | docker run | builds multi-arch [U] | MIT | 17.8k, 2026-09-29 |
| Bytebot | container | Ubuntu 22.04 XFCE | VNC/noVNC | nut-js (XTest) | none | task screenshots | compose | — | Apache-2.0 | **archived** |
| Quicksand | QEMU VM | Ubuntu/Alpine XFCE | VNC | QMP input | none | — | `pip install` | arm64 ✅ | MIT | 55, 2026-09-29 |
| **Lume macOS VM** | VZ VM | **macOS** (Tahoe/Sequoia), Linux | VZ VNC → noVNC | Cua Driver (Quartz) in guest | **AX tree + frames** | SCK MP4 (Cua Driver) | one-line install + 21–23 GB image | native | MIT | (cua) |
| Tart macOS VM | VZ VM | macOS, Linux | VZ VNC / Screen Sharing | (bring your own) | (bring your own) | — | brew + 25 GB image | native | FSL-1.1-ALv2 | 7.3k, 2026-09-30 |
| OSWorld env | VMware/VBox/QEMU/cloud | Ubuntu, Windows, macOS | VNC (VM tool) | pyautogui | **pyatspi / pywinauto / AX** | ffmpeg x11grab | heavy | VMware Fusion arm image | Apache-2.0 | 3.2k, 2026-09-14 |

---

## 4. Answers

### (a) A realistic macOS guest on this Mac

- **Feasible: yes.** Virtualization.framework runs macOS guests at near-native CPU speed, with a paravirtualised Metal GPU [V: Tart README links Geekbench comparisons; U on exact numbers]. On an M3 Ultra with 96 GB, two 8 GB macOS guests plus many Linux sandboxes fit comfortably [U].
- **Licence and concurrency limit: 2 concurrent macOS VMs per Mac.** The EULA allows "up to two (2) additional copies or instances … within virtual operating system environments", and the limit is enforced inside the kernel/hypervisor quota [R: Eclectic Light, khronokernel, Tart discussion #1054]. The limit does not apply to Linux guests. Nested virtualisation is **not available to macOS guests**, only to Linux guests (`VZGenericPlatformConfiguration`) [V: Tart issue #1231 resolution].
- **Getting images:**
  - `lume pull macos-tahoe-cua:26.5.2`: **23.1 GB compressed**, 150 GiB sparse logical disk; SIP disabled, Xcode CLT, autologin, SSH; **no TCC grants** [V: manifest + Cua runner README].
  - `macos-tahoe-vanilla`: 21 GB compressed, 100 GiB disk [V].
  - Tart `macos-tahoe-base`: about 25 GB, admin/admin [V].
  - Clones are APFS copy-on-write, so N clones cost roughly nothing until they diverge [V for clone semantics in both tools; U for exact on-disk numbers]. Budget about 30–60 GB real disk per active macOS lineage [U].
- **First-boot automation, best to worst:**
  1. **Lume `create --ipsw … --unattended tahoe`.** Offline patching of the Data volume: creates the `lume` admin user, marks Setup Assistant complete, enables autologin and SSH, disables sleep and lock. "Tahoe is E2E verified from a local IPSW"; Sequoia can still show an Accessibility step [V].
  2. **macOS 27 `VZMacGuestProvisioningOptions`.** Official, but needs the **host on macOS 27 as well as the guest**. Tart supports it through `--provisioning-opts` [V]. The user's host is on 26, and macOS 27 "Golden Gate" shipped 2026-09-14 [R].
  3. **Lima 2.1+ `guestpatch/macos`** (LaunchDaemon plus markers written by raw APFS patching) [V].
  4. **Tart Packer `boot_command`.** A long keystroke/OCR choreography replayed over VNC [V: `vanilla-tahoe.pkr.hcl`]. Brittle across macOS point releases.
- **In-guest automation through Accessibility APIs.** Works well with the **Cua Driver** (AX tree plus `frame`s, ScreenCaptureKit window capture, Quartz input, SCK recording on macOS 15+ [V]), with **Peekaboo** [V], or with pyobjc AX calls like OSWorld's [V]. The blocker is **TCC**: Accessibility and Screen Recording must be granted to a **stable, certificate-signed app identity**. Options:
  - Grant once in a golden image through the normal prompt, then clone. Grants survive clones as long as the signature stays stable.
  - On a SIP-disabled guest, seed the *system* TCC.db with Cua's `seed-tcc-guest.sh`. It "refuses to run outside VirtualMac or with SIP enabled"; ad-hoc signatures are rejected [V].
- **Performance and ergonomics.** 4 vCPU / 8 GB is the default. Display defaults to 1024x768 in Cua's images [V]; set a non-Retina 1280x800 or 1440x900 for model-friendly screenshots and cheaper streaming [U]. Apple ID/iCloud in VMs is improved in macOS 27 ("iCloud support in virtual machines") [V: WWDC26].
- **Streaming to a browser: works, VNC-grade.**
  - Lume, Tart `--vnc-experimental` and Lumier use Apple's **private `_VZVNCServer`** on the host. It needs no guest cooperation and works even during install and Recovery. Bridge it to the browser with websockify and noVNC [V: VNCService.swift, Lumier Dockerfile].
  - Alternatively use the guest's own **Screen Sharing** VNC (Tart `--vnc`; needs Remote Management/Screen Sharing enabled). noVNC supports ARD auth [U].
  - Expect lossless, crisp text and adequate responsiveness for watching an agent, but lower frame rates and tearing on full-screen motion compared with Selkies H.264 [U: no public benchmark found].
  - Security: **Lume's VNC currently listens on all interfaces** [V]. Firewall it or patch the bind address.
  - For a video-grade stream you would build a small **in-guest Swift streamer**: ScreenCaptureKit → VideoToolbox H.264 → WebSocket → WebCodecs, ideally speaking the same wire protocol as the Linux path. A GitHub search found only toy projects (0–51★) [V]. Whether hardware encode is available in a VZ guest is **unknown** [U].
- **Verdict.** Viable as a premium "real macOS" mode (max 2 concurrent). Use Lume, Cua Driver in the guest, and noVNC. Don't make it the default path.

### (b) Best arm64 Linux desktop container with a polished look and rich apps

- **Pick: `linuxserver/webtop` / `baseimage-selkies`**, Ubuntu 26.04 "resolute". Use **XFCE on X11** for automation robustness, or **KDE Plasma** if looks matter more.
  - Multi-arch [V].
  - Actively rebased: Ubuntu Resolute (04-2026), Selkies v2 (09-2026) [V].
  - Selkies streaming built in; many DEs; an AT-SPI recipe exists (Pelorus) [V].
- **Build a `localdot/desktop` image `FROM ghcr.io/linuxserver/baseimage-selkies:ubunturesolute`** (or `FROM webtop:ubuntu-xfce`) and add:
  - **Look.** `MacTahoe-gtk-theme` (MIT, 1.6k★, pushed 2026-09-28) or `WhiteSur-gtk-theme` (MIT, 9.3k★), `WhiteSur`/`MacTahoe` icon themes, WhiteSur cursors, and **Plank Reloaded** dock (GPL-3.0, pushed 2026-09-30). Put the XFCE panel at the top as a menubar. Use a macOS-like font such as Inter [U]. For KDE, use `WhiteSur-kde`/`MacTahoe-kde` with a Plasma floating dock panel. Latte Dock is stale-ish [U].
  - **Apps.**
    - Chromium: the webtop arm64 image already uses the xtradeb PPA (non-snap) [V].
    - Firefox: Mozilla APT repo; arm64 builds exist [U].
    - LibreOffice, VS Code (arm64 .deb) [U], xfce4-terminal or kitty, Thunar, GIMP or Pinta, Evince, file-roller.
  - **Accessibility on** [U, standard recipe]:
    - dbus session plus `at-spi2-core`;
    - `gsettings … toolkit-accessibility true`;
    - `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`;
    - Chromium and Electron launched with `--force-renderer-accessibility`;
    - LibreOffice on the gtk3 VCL plugin.
- **Expected size.** About 1.75 GB compressed for the base webtop arm64 [V]. Plus roughly 1–1.5 GB for LibreOffice, VS Code, GIMP and themes [U].
- **Alternatives:**
  - `kasmweb/ubuntu-noble-desktop`: arm64 2.57 GB, rich apps, KasmVNC streaming.
  - neko `xfce`/`kde` (WebRTC).
  - `trycua/xfce-cua`: lean 0.45 GB, Firefox ESR, Cua Driver preinstalled, plain VNC.
  - Selkies' own `desktop` image: LXQt; Chrome only on amd64 [V].

### (c) Best low-latency streaming path into a custom web canvas

- **Recommendation: Selkies 2.0 in WebSocket mode.**
  - pixelflux's damage-aware capture and x264 on arm64 CPU (there is no GPU inside the Docker Desktop VM [U]) → one WebSocket → **WebCodecs** → `<video>` sink.
  - One TCP port works through Docker Desktop port publishing and through our own localhost gateway or reverse proxy. **No ICE/STUN/TURN or UDP port-range mapping**, which is exactly where WebRTC hurts on Docker Desktop for Mac. neko's docs require unremapped UDP EPR ports or a mux, plus NAT1TO1, and forbid reverse-proxying media [V].
  - Built-in fallbacks (striped H.264, JPEG), input, clipboard, resize and DPI, keyframe requests, viewer and player roles, and an H.264 recording tap [V].
  - For a custom UI, use `selkies-web-core` and drive it through postMessage, or fork the dashboard. Selkies supports multiple dashboards under `addons/` [V].
- **WebRTC** (neko, or Selkies `--mode=webrtc`) only wins on lossy or remote networks. On localhost, TCP WebSockets are effectively lossless with near-zero RTT [U]. Keep it as an option for a later remote-access feature.
- **VNC via noVNC/KasmVNC.** Universal, pixel-exact and simple, and the only practical choice for macOS VMs. noVNC ≥1.6 decodes RFB H.264 through WebCodecs, and KasmVNC 1.5 has a WebCodecs video mode [V], so the quality gap is narrowing.
- **A fully custom H.264-over-WS pipeline**, for example pixelflux or ffmpeg with `x264 -tune zerolatency` → WebCodecs, would mean re-implementing input, clipboard, backpressure and keyframes, which Selkies already solves. **Reuse Selkies' protocol.** Only write custom code for the macOS-guest streamer, ideally wire-compatible.
- **Secure context.** WebCodecs requires a secure context. The linuxserver images serve HTTPS on 3001 with a self-signed certificate [V]. `http://localhost`/`127.0.0.1` also counts as a secure context per the W3C Secure Contexts spec [U, standard]. So a localDot gateway bound to `127.0.0.1` can serve the UI over plain HTTP and proxy the container's WebSocket.
- **Cursor handling** (hide the real cursor, draw our own):
  - Selkies: `SELKIES_ENABLE_CURSORS=false` stops the server sending cursor images. Also set `cursor:none` on the video element while the agent is driving. During human takeover, show the local pointer [V settings].
  - Captured frames shouldn't contain the pointer. X11 GetImage/XShm excludes the sprite cursor; Selkies ships the cursor separately through XFixes [V for XFixes delivery; U for the frame-exclusion detail]. For recordings, use ffmpeg `-draw_mouse 0`. OSWorld uses `-draw_mouse 1` [V].
  - noVNC sets `canvas.style.cursor = url(...)` from the cursor pseudo-encoding [V]. Override it with a stylesheet `cursor:none !important`.
  - For the VZ VNC server, test whether the guest pointer is composited into the frame [U].
  - Overlay transform. The overlay is a canvas absolutely positioned over the `<video>`:
    - `s = min(W/w, H/h)`
    - `ox = (W − w·s)/2`, `oy = (H − h·s)/2`
    - `X = ox + x·s`, `Y = oy + y·s`
    - Multiply by `devicePixelRatio` for canvas pixels.
    - Fix the remote resolution (`SELKIES_MANUAL_RESOLUTION=true`, for example 1280x800 or 1440x900 at 96 DPI) so model coordinates, screenshot coordinates and stream coordinates are identical [U design].
  - Drive the overlay from the **action executor's events**: animate the cursor to the target, then dispatch, then show the ripple. Don't infer the cursor from video. Time-stamp events for replay against the recording tap [U design].
  - If you use Cua Driver on Linux, disable its synthetic in-guest cursor overlay (`set_agent_cursor_enabled`) [V: RUNTIME.md]. Otherwise both cursors will show.

### (d) Best actuation and perception API inside the guest

- **Primary: Cua Driver** (MIT; Rust daemon; MCP, SDK and CLI) running inside the Linux container against `DISPLAY=:1`, the way `trycua/xfce-cua` does it [V]. What it gives you:
  - AT-SPI trees with element **`frame` in screen coordinates**;
  - `element_token`-bound click and type (background via AT-SPI actions where possible, XTest otherwise);
  - EWMH window list and geometry, and `set_window_frame`;
  - window or desktop screenshots with explicit scale metadata;
  - `verify_state`;
  - recording (per-turn folders plus ffmpeg MP4);
  - typed Chromium browser actions [V].

  The same API also works inside a macOS guest (AX, SCK, Quartz), so there is one perception contract for both tracks.

  Caveats: fast-moving contracts (pin versions); a complex permission and "proof" model; Linux needs the a11y bus and `toolkit-accessibility` on or the tree is empty [V: LINUX.md]; the legacy `computer-server` Linux tree is a stub, so **don't use computer-server for Linux a11y** [V].
- **Complement: CDP/Playwright** against the in-guest Chromium, started with `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`, for DOM-precise targets and text:
  - Element box: `DOM.getContentQuads` or `getBoundingClientRect()`.
  - Convert to screen coordinates by adding the viewport origin. Either run Chromium in `--kiosk`/app mode at (0,0), compute `screenX + (outerWidth−innerWidth)` and `screenY + (outerHeight−innerHeight)`, or take the AT-SPI extents of the document-web node [U design].
- **Bounding boxes for highlighting:**
  - AT-SPI: `Component.GetExtents(ATSPI_COORD_TYPE_SCREEN)`. OSWorld uses `getExtents(pyatspi.XY_SCREEN)` [V]. On Xvfb the root sits at (0,0), so these are framebuffer pixels.
  - Text caret and range boxes: `Text.GetCharacterExtents`/`GetRangeExtents`, for the typing HUD [U].
  - macOS: `AXFrame` (points; multiply by the backing scale) [V: OSWorld macOS code].
  - Windows: UIA `BoundingRectangle` [U].
  - Vision fallback for canvas, OpenGL or a11y-less apps: OmniParser v2 or grounding models. Mind the AGPL model licences [V].
- **Minimal fallback daemon** (if Cua Driver proves too heavy or unstable): Python or Rust with xdotool/python-xlib XTest for input, `mss` for XShm screenshots, pyatspi or the `atspi` crate for trees plus extents, `wmctrl`/EWMH for windows, and CDP. Keep the Anthropic `computer_toolset_20260801` action vocabulary for model compatibility [V: quickstart tool groups]. pixelflux's `PIXELFLUX_CU` endpoint already implements an Anthropic-style action surface inside Selkies images [V]. Pelorus shows AT-SPI plus window geometry inside Selkies containers [V], but it is immature and unlicensed.
- **Not recommended:**
  - Bytebot daemon: archived; nut-js only; no a11y.
  - E2B, Anthropic or OpenAI samples: xdotool or pyautogui only; no a11y.
  - Wayland: input and capture need portals or libei and are compositor-specific [V: Cua platform matrix]. Stay on X11.

### (e) Multi-session: parallel sandboxes, snapshots/resets, persistent profile

- **Parallel.** One container per session, each with its own Selkies port (or a Unix socket behind the localDot gateway). Budget roughly 1.5–3 GB RAM per desktop with Chromium and about 0.2–1 CPU core of x264 per actively changing 1280x800@30 stream; near zero when idle, thanks to damage detection [U estimates]. 8–15 concurrent Linux desktops on 96 GB is realistic [U]. Selkies viewer links and tokens also let one session appear in several UI places, for example a thumbnail grid plus the main view [V: session sharing].
- **Isolation tiers:**
  - Docker Desktop: one shared VM; OK for personal use.
  - Apple `container`: one VM per sandbox; better. It runs the same OCI image [V features; U that linuxserver's s6 init runs unmodified there].
  - microsandbox or Quicksand: a VM per sandbox plus snapshots.
- **Reset.** Treat the image as golden and the container layer as disposable (`rm` plus recreate takes seconds [U]).
- **Snapshots:**

  | Runtime | Snapshot | Notes |
  |---|---|---|
  | Docker | `commit` | Filesystem only; no memory state |
  | microsandbox | `msb branch` / `msb snap` | Full live state; beta [V] |
  | Quicksand | `checkpoint`/`revert` | [V] |
  | Tart | `--suspendable` + `suspend` | macOS VM save-state [V] |
  | Lume | `clone` only | [V] |
  | E2B Embed | pause/resume/fork | Firecracker; needs nested-virt Lima [V] |

- **Persistent user profile.** Keep `/config` (the linuxserver home: browser profile, app settings, proot-apps) on a **named volume per profile**. For per-task isolation, clone the profile volume into a task volume before starting. For bind mounts on the host, `cp -c` (APFS clonefile) is instant. Merge back only on explicit "save profile" [U design].
- **macOS track.** At most 2 running VMs. Golden VM (TCC grants, apps, login) → `lume clone` per task → delete. Keep a long-lived "profile" VM for persistent logins [V: clone; U: workflow].

---

## 5. Recommendation

### Primary stack (ship this first)
```
Browser UI (localDot web app, 127.0.0.1)
 ├─ <video> sink from selkies-web-core (WebSocket, H.264 → WebCodecs)
 ├─ overlay <canvas>: agent cursor, click ripples, typing HUD, element boxes (AT-SPI/CDP frames)
 └─ timeline/replay: action events + recorded H.264 (Selkies recording socket)
localDot gateway (Node/Rust, binds 127.0.0.1)
 ├─ session manager → Docker Desktop (default) | Apple `container` (opt-in, VM-per-sandbox) | microsandbox (opt-in, snapshots)
 ├─ WS proxy → container:selkies ; tokens via Selkies secure mode (--master-token)
 └─ agent loop ↔ in-guest Cua Driver (MCP/HTTP+bearer) + CDP (Chromium) + shell/files API
Guest image: localdot/desktop (FROM linuxserver/baseimage-selkies:ubunturesolute, X11)
 ├─ XFCE + MacTahoe/WhiteSur + Plank Reloaded; Chromium, Firefox, LibreOffice, VS Code, GIMP/Pinta, terminal, Thunar
 ├─ AT-SPI bus on; Chromium --force-renderer-accessibility --remote-debugging-port (loopback)
 └─ Cua Driver serve (pinned version) ; Selkies with ENABLE_CURSORS=false, manual 1280x800/1440x900
```

**Why this stack:**
- **Native arm64 end to end** [V images].
- **One-command setup** on an already-installed Docker Desktop.
- **The smoothest browser stream available** without GPUs (H.264 and WebCodecs, 60 fps capable [V default]).
- **One TCP port**, with no WebRTC NAT pain.
- **A documented client API** for a custom UI.
- **Cursor out of band**, so it's trivial to hide.
- **An accessibility-grade perception layer** that is the same on Linux and a future macOS guest.
- Everything is OSS (MIT, MPL and GPL). The GPL images and x264 are fine for an OSS product; keep source offers.

**Risks and mitigations:**
- **Selkies has a bus factor of about 2** and 2.0 is brand new. Pin 2.0.x, and keep a VNC fallback (KasmVNC or noVNC) behind the same UI abstraction (`StreamClient` interface: attach, resolution, input, cursor on/off).
- **Cua Driver churns fast.** Pin versions. Wrap it behind our own `Perception`/`Actuation` interface so the thin xdotool, AT-SPI and CDP fallback can replace it.
- **linuxserver defaults are insecure for agents:** no auth, passwordless sudo, an optional docker.sock mount. Fix this in our image: tokens, no docker.sock, and egress policy through a proxy container.
- **Docker Desktop shares one VM** across all sandboxes. Offer Apple `container` as the "strict isolation" mode.

### Fallbacks
1. **Streaming fallback.** KasmVNC 1.5 (Xvnc plus WebCodecs video mode) or TigerVNC/x11vnc with **noVNC 1.7** embedded (`@novnc/novnc` RFB into our container element, CSS `cursor:none`). **neko v3** if WebRTC is wanted later.
2. **macOS track.** **Lume** macOS Tahoe VM (MIT). Use `--unattended tahoe` or `macos-tahoe-cua:26.5.2`. Run **Cua Driver in the guest**, with TCC in a golden image. Stream VZ VNC through **noVNC** after locking the listener to loopback. Reset with APFS clones. Consider **Tart** (FSL) for save-state and Softnet egress control. **Lima** is the Apache-2.0 alternative. Upgrading the host to macOS 27 unlocks official `VZMacGuestProvisioningOptions` for macOS 27 guests [V].
3. **Strong-isolation / snapshot track.** microsandbox (Apache-2.0, beta) or Quicksand (MIT, young) for VM-per-sandbox with checkpoint and branch; this would enable "time travel" UX. E2B Embed only if Firecracker-grade fork and pause at scale is ever needed.
4. **Optional hardened backend: Docker Sandboxes (`sbx`).** A microVM per sandbox plus a host egress-policy proxy with logs. It needs a purpose-built template (UID 1000 `agent`) and `sbx ports --publish` for the Selkies WebSocket port. It is proprietary and churns fast, and the Desktop-bundled plugin v0.11 can't publish ports. Spike it before committing (§2G).

### Suggested 1–2 week spike (acceptance tests)
1. `docker run ghcr.io/linuxserver/webtop:ubuntu-xfce` on arm64 with `SELKIES_ENABLE_CURSORS=false`, `SELKIES_MANUAL_RESOLUTION=true` and 1280x800. Measure glass-to-glass latency (the frame-counter trick) and CPU per stream at 30 and 60 fps [U until measured].
2. Build a minimal page with `selkies-web-core` plus an overlay canvas. Verify the coordinate mapping with a click-target grid app.
3. Install the Cua Driver in the image. Check `get_window_state` on Chromium (with `--force-renderer-accessibility`), LibreOffice Calc, VS Code and Thunar, and check frame accuracy against screenshots.
4. Run the same image under Apple `container` 1.5 (`-p`, `--shm-size`) and under microsandbox. Record which features break.
5. Lume: `lume pull macos-tahoe-cua:26.5.2`. Bind VNC to loopback (or firewall it), connect noVNC, and measure fps. Seed TCC and run Cua Driver `list_windows` and `get_window_state` on Safari and Finder.

---

## 6. Open questions / not verified
- Real glass-to-glass latency and CPU of Selkies x264 on arm64 inside Docker Desktop, and the same for noVNC against the VZ VNC server. No public benchmarks were found.
- Whether VideoToolbox hardware encode is available inside a macOS VZ guest (for a custom macOS streamer).
- Whether linuxserver images (s6-overlay) run unmodified under Apple `container` and microsandbox.
- VMware Fusion macOS-guest support on Apple Silicon (believed unsupported).
- Whether a macOS 26 host can run a macOS 27 guest. The general rule is host ≥ guest [U].
- Firefox arm64 APT availability and VS Code arm64 packaging details (believed yes).

---

## 7. Sources (primary unless noted)
- Cua: https://github.com/trycua/cua ; libs/cua-driver/README.md ; libs/cua-driver/rust/Skills/cua-driver/{SKILL,LINUX,RECORDING,RUNTIME,VISUAL}.md ; libs/lume/README.md ; libs/lume/src/VNC/VNCService.swift ; libs/lume/src/Unattended/MacOSOfflineSetupPatcher.swift ; libs/lumier/Dockerfile ; libs/xfce-cua/README.md ; libs/python/computer-server/README.md ; libs/python/computer-server/computer_server/handlers/linux.py ; libs/python/cua-sandbox/README.md ; libs/python/cua-sandbox/cua_sandbox/runtime/{images,tart}.py ; libs/cua-driver/tests/runners/macos-lume/{README.md,seed-tcc-guest.sh} ; issue #3878 (https://github.com/trycua/cua/issues/3878)
- Cua docs: https://cua.ai/docs/reference/cua-driver/platform-support ; https://cua.ai/docs/reference/cua-driver/cli-reference ; https://cua.ai/docs/reference/lume/cli-reference ; https://cua.ai/docs/reference/sandbox-sdk/runtime-support ; https://cua.ai/docs/how-to-guides/sandbox/manage-local-lifecycle ; https://cua.ai/docs/tutorials/create-your-first-lume-vm
- Registry manifests queried: ghcr.io/trycua/macos-tahoe-cua:{latest,26.5.2}, ghcr.io/trycua/macos-tahoe-vanilla, ghcr.io/m1k1o/neko/*, ghcr.io/selkies-project/selkies/desktop:2.0.0-ubuntu26.04, ghcr.io/linuxserver/webtop:*, ghcr.io/agent-infra/sandbox; Docker Hub trycua/*, kasmweb/*
- Tart: https://github.com/openai/tart (README, LICENSE, Sources/tart/Commands/Run.swift) ; https://github.com/openai/tart/issues/1231 ; https://tart.run/quick-start/ ; https://tart.run/faq/ ; https://github.com/cirruslabs/macos-image-templates (templates/vanilla-tahoe.pkr.hcl, release "Xcode 27")
- Cirrus→OpenAI: https://cirruslabs.org/ ; [R] https://macstadium.com/blog/cirrus-labs-is-joining-openai
- Apple VZ / macOS 27: https://developer.apple.com/videos/play/wwdc2026/224/ ; [R] https://bitrise.io/blog/post/wwdc26-the-virtualization-framework-updates-that-matter-for-large-mac-fleets ; [R] https://www.macrumors.com/2026/09/10/macos-27-golden-gate-release-date/
- 2-VM limit: [R] https://eclecticlight.co/2022/08/04/virtualisation-on-apple-silicon-macs-8-how-apple-limits-vms/ ; [R] https://khronokernel.com/macos/2023/08/08/AS-VM.html ; https://github.com/cirruslabs/tart/discussions/1054
- Lima: https://github.com/lima-vm/lima (templates/default.yaml, templates/macos-26.yaml, templates/macos.yaml) ; https://github.com/lima-vm/lima/issues/5516
- Apple container: https://github.com/apple/container (README, docs/technical-overview.md, docs/command-reference.md, releases 1.2.1–1.5.0) ; https://github.com/apple/containerization
- microsandbox: https://github.com/superradcompany/microsandbox ; https://github.com/superradcompany/mario-never-dies
- Quicksand / MagenticLite: https://github.com/microsoft/quicksand ; https://github.com/microsoft/magentic-ui
- E2B: https://github.com/e2b-dev/runtime (README, embed/README.md, embed/compose/README.md) ; https://github.com/e2b-dev/desktop (README, template/template.py) ; https://github.com/e2b-dev/open-computer-use ; https://github.com/e2b-dev/surf
- Anthropic: https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo (Dockerfile, computer_use_demo/tools/{groups,computer}.py)
- OpenAI: https://github.com/openai/openai-cua-sample-app
- Bytebot: https://github.com/bytebot-ai/bytebot (archived; packages/bytebotd/package.json, supervisord.conf)
- UI-TARS / AIO: https://github.com/bytedance/UI-TARS-desktop ; https://github.com/agent-infra/sandbox
- Others: https://github.com/simular-ai/Agent-S ; https://github.com/OpenHands/OpenHands ; https://github.com/OpenHands/software-agent-sdk ; https://github.com/kortix-ai/suna ; https://github.com/FoundationAgents/OpenManus ; https://github.com/daytonaio/daytona
- Docker Sandboxes: https://docs.docker.com/ai/sandboxes/ ; https://docs.docker.com/ai/sandboxes/architecture/ ; https://docs.docker.com/ai/sandboxes/usage/ ; https://docs.docker.com/ai/sandboxes/install/ ; https://docs.docker.com/ai/sandboxes/security/isolation/ ; https://docs.docker.com/ai/sandboxes/customize/author/base-images/ ; https://docs.docker.com/ai/sandboxes/configuration/environment-files/ ; https://docs.docker.com/ai/sandboxes/agents/shell/ ; https://docs.docker.com/ai/sandboxes/faq/ ; https://docs.docker.com/ai/sandboxes/release-notes/ ; https://docs.docker.com/reference/api/sandboxes/latest/ ; https://github.com/docker/sbx-releases (release notes v0.39–v0.46) ; local `docker sandbox … --help` (plugin v0.11.0) and `docker info`
- Browser layers: https://github.com/steel-dev/steel-browser ; https://github.com/browser-use/browser-use ; https://github.com/microsoft/playwright-mcp
- Selkies: https://github.com/selkies-project/selkies (release 2.0.0 notes; addons/selkies-web-core/README.md; addons/desktop/Dockerfile) ; https://docs.selkies.io/latest/settings ; https://github.com/selkies-project/pixelflux ; https://github.com/selkies-project/pcmflux
- linuxserver: https://github.com/linuxserver/docker-webtop (README; Dockerfile.aarch64 @ubuntu-xfce) ; https://github.com/linuxserver/docker-baseimage-selkies ; https://docs.linuxserver.io/selkies/user-guide/quickstart/ ; https://docs.linuxserver.io/selkies/components/pelorus/ ; https://docs.linuxserver.io/selkies/components/pixelflux/ ; https://github.com/linuxserver/pelorus
- neko: https://github.com/m1k1o/neko ; https://neko.m1k1o.net/docs/v3/installation/docker-images ; https://neko.m1k1o.net/docs/v3/configuration/webrtc ; https://neko.m1k1o.net/docs/v3/api
- KasmVNC: https://github.com/kasmtech/KasmVNC (README, v1.5.0/v1.4.0 notes)
- noVNC: https://github.com/novnc/noVNC (releases v1.6.0/v1.7.0; core/util/cursor.js; core/rfb.js) ; https://github.com/novnc/websockify
- Guacamole / Xpra: https://github.com/apache/guacamole-server ; https://github.com/Xpra-org/xpra-html5
- OSWorld: https://github.com/xlang-ai/OSWorld (README; desktop_env/server/main.py)
- OrbStack: https://orbstack.dev/pricing
- Runtimes: https://github.com/firecracker-microvm/firecracker ; https://github.com/google/gvisor ; https://github.com/kata-containers/kata-containers ; https://github.com/libkrun/libkrun ; https://github.com/utmapp/UTM
- macOS automation: https://github.com/openclaw/Peekaboo ; https://github.com/microsoft/OmniParser
- Themes: https://github.com/vinceliuice/WhiteSur-gtk-theme ; https://github.com/vinceliuice/MacTahoe-gtk-theme ; https://github.com/vinceliuice/WhiteSur-kde ; https://github.com/vinceliuice/MacTahoe-kde ; https://github.com/vinceliuice/WhiteSur-icon-theme ; https://github.com/zquestz/plank-reloaded
