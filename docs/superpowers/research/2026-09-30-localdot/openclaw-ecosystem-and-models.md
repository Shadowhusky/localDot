# localDot research — OpenClaw ecosystem, alternatives, and computer-use "brains"

Research date: **2026-09-30**. Host context: Apple M3 Ultra / 96 GB / macOS 26 / Docker Desktop 29 / LM Studio.
Method: primary sources (GitHub repos + `gh` stats, official docs, model cards, papers, leaderboards), the user's local OpenClaw clone (`~/openclaw`, tag v2026.7.1-2) and running install (`ghcr.io/openclaw/openclaw:2026.9.5-browser`), plus release notes up to v2026.9.7.
Conventions: every factual claim has a source URL next to it; **[UNVERIFIED]** = could not confirm from a primary source; **[ESTIMATE]** = my own estimate. Star counts are exactly what `gh` returned on 2026-09-30.
Note on method: the session's shared WebSearch quota ran out mid-research; later checks used WebFetch on known URLs, `gh`, and HN/NVD/OSV/HF/arXiv APIs instead. Where that limited verification it is labelled.

---

## 0. Executive summary

- **OpenClaw is the category leader.** 390,856 stars, MIT, OpenClaw Foundation, releases several times a week (v2026.9.7 today).
  - Architecture: a TypeScript Gateway daemon with one WebSocket protocol, around 25 chat channels and 80 provider plugins, Markdown memory, heartbeat and cron, nodes, Canvas/A2UI, a managed browser, and optional sandboxes.
  - Its agent loop began on Mario Zechner's pi and was internalised on 2026-05-27 as `@openclaw/agent-core`. Runtimes are pluggable: `openclaw`, `codex`, `claude-cli`, `copilot`, ACP.
  - What users love: control from the chat apps they already use, proactivity, Markdown memory and self-written skills.
  - What they hate: security, token burn, silent failures, upgrades that break things, and setup.
- **Security record: the heaviest of any agent project reviewed here.**
  - 722 GitHub advisories and about 676 NVD CVEs, including one-click RCE via `gatewayUrl` (CVE-2026-25253), "ClawJacked", many pairing, scope and sandbox-escape criticals, and four criticals in the noVNC/CDP viewer surfaces.
  - 21k–63k gateways exposed to the internet, and 341 to 1,184 malicious ClawHub skills (AMOS stealer).
  - Prompt-injection backdoors via SOUL.md/HEARTBEAT.md, and infostealers targeting `~/.openclaw`.
  - Sandboxing is still **off by default**, and its secret egress proxy is in-process and opt-in.
- **Visualisation.** OpenClaw visualises at the level of text, tool cards and logs.
  - Since Aug–Sep 2026 it has a VNC Desktop panel, but only for managed Linux hosts (lab-gated) or Crabbox cloud machines.
  - There are no cursor or click overlays and no synced action timeline, and "screenshots are kept model-only". **That gap is localDot's opening.**
- **Alternatives.**
  - Among the alternatives, only Hermes Agent (250k stars; Linux hosts) and Agent Zero (Xpra) ship a viewable, takeover-able desktop.
  - IronClaw, NanoClaw+OneCLI and ZeroClaw improve isolation and secrets.
  - Meta Muse (Sentinel surrogate tokens) and OpenAI "dots" (2026-09-29, GPT-6 Astra on its own cloud computer) are the closed benchmarks. The "dots" name is close to "localDot".
  - Nobody ships a model-agnostic, action-annotated desktop view.
- **Brains.**
  - OSWorld-Verified is saturated: 90.19% for the best harness, claude-fable-5 at 85.96%, claude-opus-5 at 83.39%, and the open Holo3-35B-A3B at 82.56% verified. OSWorld 2.0/2.1 now separates models.
  - The best local model is **Qwen3.8-27B** (Apache-2.0, already installed; 84.3% self-reported), optionally with a Holo-3.1-35B-A3B grounder.
  - Every major API emits drawable coordinates, in different spaces: screenshot px, 0–999 or 0–1000, or smart-resized px.
- **Recommendation.**
  - Build a thin TypeScript loop we own, on **Vercel AI SDK v7**. It keeps the trained computer-use tools (Anthropic `computer_toolset_20260801`, OpenAI `computer`) plus LM Studio. Use **pi-agent-core's event contract**.
  - Use **Cua** (cua-driver/computer-server) inside an arm64 **webtop + Selkies** container on a Docker `internal` network.
  - Key broker: **OneCLI-style egress** with host-bound placeholders.
  - Models: **Claude Sonnet 5.5** as default brain, escalating to Opus 5.5; **Qwen3.8-27B** local fallback.
  - All providers normalise into one `ActionEnvelope` with `frameId`, which drives both the executor and the overlay.
  - Keep from OpenClaw: the gateway event protocol, Markdown memory and persona, heartbeat and cron, SKILL.md with review, `computer`/`frameId` semantics, trajectory capture and doctor.
  - Change: isolation by default, an out-of-process key layer, a visual-first UI, a local desktop, and a curated skill set.
- **Side finding (user's own install).** The user's Telegram bot is configured as public (`dmPolicy/groupPolicy: open` with `*` allowlists), with the sandbox off and the whole `~/.openclaw` directory (credentials, config backups) mounted rw into the agent's container. Worth locking down now (section 1.8).

---

## 1. TASK 1 — OpenClaw deep-dive (formerly Warelay → Clawdbot → Moltbot)

### 1.1 Identity, history, project health

- **What it is:** "The AI that actually does things. It runs on your devices, in your channels, with your rules." A self-hosted, TypeScript personal-agent *gateway* that connects LLMs to chat apps, tools, devices and schedules. Name lineage per the project itself: "Warelay -> Clawdbot -> Moltbot -> OpenClaw". Source: https://github.com/openclaw/openclaw/blob/main/VISION.md
- **People / governance:** creator Peter Steinberger joined OpenAI on 2026-02-15; Sam Altman said OpenClaw will "live in a foundation as an open source project that OpenAI will continue to support". https://techcrunch.com/2026/02/15/openclaw-creator-peter-steinberger-joins-openai/ , https://www.cnbc.com/2026/02/15/openclaw-creator-peter-steinberger-joining-openai-altman-says.html , https://steipete.me/posts/2026/openclaw . LICENSE is MIT, "Copyright (c) 2026 OpenClaw Foundation" (GitHub's license detector shows "Other") https://github.com/openclaw/openclaw/blob/main/LICENSE
- **Health (`gh repo view openclaw/openclaw`, 2026-09-30):** 390,856 stars, 82,209 forks, created 2025-11-24, last push 2026-09-30, latest release **v2026.9.7 (2026-09-30)**. Release cadence is extreme: calendar versions several times a week plus backport trains (v2026.8.33 on 09-29, v2026.7.35 on 09-21, v2026.6.35 on 09-10). Every release publishes an evidence ledger (CI proof, npm integrity, ClawHub plugin submission). https://github.com/openclaw/openclaw/releases , https://github.com/openclaw/releases
- More health data: 249 GitHub releases in total (peak 66 in May 2026; 9–12/month since July); ~9,089 open issues+PRs; ~3,443 contributors (contributors API incl. anonymous). On 2026-02-01 maintainers declared "Stabilisation Mode" ("a PR roughly every two minutes") https://github.com/openclaw/openclaw/issues/5799 . **OpenClaw 2.0** = v2026.8.1 (announced 2026-08-30: 933 contributors, 16,000+ PRs, subscription reuse + local models at install, first-class browser app, shared cloud sessions) https://openclaw.ai/blog/openclaw-2-accidentally . Passed React as most-starred software project on 2026-03-02 https://www.star-history.com/blog/openclaw-surpasses-react-most-starred-software . Enterprise edition in the works with Red Hat + NVIDIA ("Kubernetes for agents", repo openclaw/openclaw-enterprise, 177 stars) https://www.theregister.com/ai-and-ml/2026/09/30/openclaw-slips-on-a-suit-to-evade-widespread-business-bans/5299962 . NVIDIA **NemoClaw** runs OpenClaw/Hermes inside NVIDIA OpenShell (22,605 stars, Apache-2.0).
- Rename timeline: first published 2025-11-24 as Warelay, then Clawdis/Clawdbot; renamed **Moltbot on 2026-01-27** after an Anthropic trademark complaint; **OpenClaw on 2026-01-30** https://en.wikipedia.org/wiki/OpenClaw , https://openclaw.ai/blog/introducing-openclaw
- Sibling repos: **ClawHub** (skill + plugin registry) 9,470 stars, v0.23.3 (2026-08-04) https://github.com/openclaw/clawhub ; **Crabbox** ("warm a box, sync the diff, run the suite" — leased cloud machines, VNC; now also cloud desktops) 1,440 stars, v0.69.0 (2026-09-30) https://github.com/openclaw/crabbox
- **Self-declared maturity** (docs/maturity scorecard, July 2026 clone): CLI and Gateway runtime **M4 Stable**; Agent runtime, session/memory/context engine, channel framework, observability, Web app, plugins, "security, auth, pairing, and secrets", automation **M3 Beta**; ClawHub, TUI, voice, media **M2 Alpha**; Discord M4; Telegram/WhatsApp/Slack/iMessage M3; Docker/Podman hosting M3; Linux companion M0 (since shipped). Most readiness areas are marked "Needs review" with 0–35% taxonomy validation. https://docs.openclaw.ai/maturity/scorecard (local: `~/openclaw/docs/maturity/`)
- Stated priorities: "Security and safe defaults; Bug fixes and stability; Setup reliability and first-run UX", next "Better computer-use and agent harness capabilities". Explicit non-goals: manager-of-managers agent hierarchies as default, heavy orchestration layers, new core skills (go to ClawHub). OpenClaw is "terminal-first by design" and refuses "convenience wrappers that hide critical security decisions". https://github.com/openclaw/openclaw/blob/main/VISION.md

### 1.2 Architecture (current, v2026.7–v2026.9)

**Gateway (the hub).** One long-lived Node/TypeScript daemon per host (default `127.0.0.1:18789`) "owns all messaging surfaces"; control-plane clients (CLI, TUI, web Control UI, macOS/iOS/Android/Linux/Windows apps, automations) and *nodes* connect over one typed WebSocket protocol (JSON frames, first frame must be `connect`; `req/res` + server-push events `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`; frames validated against JSON Schema). The Gateway HTTP server also hosts the Control UI (Vite + Lit SPA), WebChat, the canvas host (`/__openclaw__/canvas/`, `/__openclaw__/a2ui/`), OpenAI-compatible `/v1/chat/completions` + OpenResponses endpoints, and a tools-invoke API. It is the only process that opens a WhatsApp session. https://docs.openclaw.ai/concepts/architecture , https://docs.openclaw.ai/web/control-ui , https://docs.openclaw.ai/gateway/openai-http-api
- `chat.send` is non-blocking: ack `{runId, status:"started"}` then streamed `chat`/`agent` events — a good pattern for any UI that must visualise a live run. https://docs.openclaw.ai/web/control-ui
- State lives in `~/.openclaw`: `openclaw.json` (strict current schema; every breaking change ships an `openclaw doctor --fix` migration), `state/openclaw.sqlite` (shared runtime DB — sessions, cron, pairing, tasks, audit, secret store, worker placements…), `agents/<id>/agent/openclaw-agent.sqlite` (model auth profiles), `credentials/`, `agents/<id>/sessions/` transcripts, `workspace/`. https://docs.openclaw.ai/openclaw-agent-runtime , https://github.com/openclaw/openclaw/blob/main/VISION.md

**Agent runtime / core.** OpenClaw was built on Mario Zechner's **pi** toolkit: its `package.json` depended on `@mariozechner/pi-agent-core`, `pi-ai`, `pi-coding-agent` (^0.21.0 early on), renamed `@earendil-works/pi-*` 0.74.0 on 2026-05-11 (repo `badlogic/pi-mono` → **earendil-works/pi**, 110,659 stars, MIT, v0.99.1 2026-09-29 https://github.com/earendil-works/pi). Commit `bb46b79` "refactor: internalize OpenClaw agent runtime (#85341)" (2026-05-27) replaced them with in-repo packages (`@openclaw/agent-core`, `@openclaw/ai`); only `@earendil-works/pi-tui` remains [verified in the local git history of `~/openclaw`; PR https://github.com/openclaw/openclaw/pull/85341]. Today OpenClaw "owns the built-in agent runtime": the loop lives in `packages/agent-core/` (`@openclaw/agent-core`: agent loop, harness types, messages, compaction, prompt templates, skills, session storage) wired through `src/agents/` and a provider layer in `src/llm/`; "no external agent framework packages remain" except `@earendil-works/pi-tui` for the terminal UI; the legacy runtime id `pi` now normalises to `openclaw`. https://docs.openclaw.ai/agent-runtime-architecture
- **Pluggable runtimes ("harnesses")**, selected per provider/model via `agentRuntime.id`: `openclaw` (embedded default), `codex` (OpenAI Codex app-server — default for `openai/*` models on the official endpoint, i.e. ChatGPT/Codex subscription), `copilot` (GitHub Copilot CLI), CLI backends such as `claude-cli` ("select the Anthropic model, execute through Claude CLI"), and **ACP/acpx** for external coding harnesses (Claude Code, Gemini CLI, OpenCode, Cursor, Droid). Runtime ownership table: with Codex, Codex owns the loop/thread/compaction and OpenClaw mirrors the transcript and bridges its tools. https://docs.openclaw.ai/concepts/agent-runtimes . v2026.9.7 adds an **OpenAI Agents API** plugin ("run agents on OpenAI-hosted or self-hosted environments") and "Sign in with ChatGPT". https://github.com/openclaw/openclaw/releases/tag/v2026.9.7
- **Providers are plugins** (~80 bundled extensions: anthropic, openai, google, xai, openrouter, bedrock, vertex, lmstudio, ollama, llama-cpp, vllm, deepseek, moonshot, qwen, minimax, zai, groq, …), with auth profiles (API key / OAuth / setup-token), model failover, usage + cost tracking. Local dir `~/openclaw/extensions/`; https://docs.openclaw.ai/concepts/model-providers
- Loop features: compaction (+ safeguard mode, mid-turn precheck), context engine (pluggable context assembly), session pruning, queue/steering, `/goal` durable objectives with token budgets, loop detection, tool search for large tool catalogs, progress drafts (one WIP chat message updated live), subagents (background runs that announce back), Task Flow + **Lobster** (typed workflows with resumable approval gates), parallel specialist lanes. https://docs.openclaw.ai/tools/subagents , https://docs.openclaw.ai/tools/lobster , https://docs.openclaw.ai/concepts/progress-drafts

**Channels.** WhatsApp (WhatsApp Web via **Baileys**, "production-ready"), Telegram (**grammY**), Slack, Discord, Signal, iMessage (native + BlueBubbles), Google Chat, MS Teams, Matrix, Mattermost, IRC, LINE, Feishu, QQ, WeChat, Yuanbao, Zalo, Nostr, Twitch, Nextcloud Talk, Synology Chat, SMS, Tlon, plus voice (Talk realtime in browser, Twilio/FaceTime/Discord voice, Google Meet). Routing via `bindings` (channel/account → agent), `dmPolicy` (`pairing` / `allowlist` / `open` / `disabled`), group policies, mention gating, `session.dmScope` (e.g. per-channel-peer), access groups, bot-loop protection. `dmPolicy:"open"` + `allowFrom:["*"]` "lets any Telegram account that finds or guesses the bot username command the bot". https://docs.openclaw.ai/channels , https://docs.openclaw.ai/channels/whatsapp , https://docs.openclaw.ai/channels/telegram , https://docs.openclaw.ai/channels/pairing

**Multi-agent.** Several isolated agents per Gateway, each with its own workspace, model, tool policy and sandbox; `bindings` route inbound traffic. https://docs.openclaw.ai/concepts/multi-agent

**Skills + ClawHub.** A skill = folder with `SKILL.md` (YAML frontmatter + markdown instructions; AgentSkills-style). Precedence: `<workspace>/skills` > `<workspace>/.agents/skills` > `~/.agents/skills` > `~/.openclaw/skills` > bundled > extra dirs/plugin skills; load-time gating on binaries/env/config; per-skill `env`/`apiKey` injected **into the host process for that turn** (not the sandbox). Docs: "Treat third-party skills as untrusted code. Read them before enabling." `security.installPolicy` can run an operator policy command before any install (fails closed). **ClawHub** (clawhub.ai) is the public registry for skills *and* plugins (publisher status, provenance, security review). **Skill Workshop**: agent-drafted skills are stored as `PROPOSAL.md` with scanner state, hashes, rollback, and go live only when a human applies them. https://docs.openclaw.ai/tools/skills , https://docs.openclaw.ai/tools/skill-workshop , https://clawhub.ai/

**Memory.** "OpenClaw remembers things by writing plain Markdown files in your agent's workspace… there is no hidden state": `MEMORY.md` (curated long-term, loaded each session), `memory/YYYY-MM-DD.md` daily notes (indexed, not injected), `DREAMS.md`. Default backend: SQLite index with keyword + vector + hybrid search (`memory_search`/`memory_get`); alternative memory plugins (one slot active): LanceDB, QMD, Honcho, memory-wiki. Extras: **Active Memory** (blocking memory sub-agent that injects relevant memory), **Dreaming** (background consolidation in light/deep/REM phases + Dream Diary), **Commitments** (inferred follow-ups delivered via heartbeat). Workspace bootstrap files: `AGENTS.md`, `SOUL.md` (voice/persona), `USER.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`. https://docs.openclaw.ai/concepts/memory , https://docs.openclaw.ai/concepts/dreaming , https://docs.openclaw.ai/concepts/active-memory , https://docs.openclaw.ai/concepts/soul

**Proactivity: heartbeat, cron, hooks.** *Heartbeat* = periodic main-session turn (default 30 min; 1 h with Anthropic OAuth/token auth) that batches checks from `HEARTBEAT.md`; no task records; target `none` (default) or `last`. *Cron* ("Scheduled Tasks") = exact schedules, isolated or main session, delivery `announce`/`webhook`/`none`. Plus a background task ledger, hooks (event-driven), standing orders, webhooks, Gmail Pub/Sub, polling. https://docs.openclaw.ai/automation , https://docs.openclaw.ai/gateway/heartbeat , https://docs.openclaw.ai/automation/cron-jobs

**Nodes.** Companion devices (macOS app, iOS, Android, headless node host) connect with `role:"node"` after **device pairing**, exposing `canvas.*`, `camera.*`, `screen.*` (record/snapshot), `location.*`, `notifications.*`, `talk.*`, and `system.run` (remote exec, approvals enforced on the node). Nodes are peripherals; channels always land on the Gateway. https://docs.openclaw.ai/nodes

**Canvas + A2UI.** The macOS app embeds an agent-controlled Canvas panel (WKWebView, custom `openclaw-canvas://` scheme; also iOS/Android) for agent-authored HTML/CSS/JS; the agent can present/navigate/`eval` JS/`snapshot`. **A2UI v0.8** (Google's declarative agent-to-UI JSON protocol: `surfaceUpdate`, `dataModelUpdate`, `beginRendering`, `deleteSurface`; v0.9 `createSurface` not yet) is served by the Gateway canvas host and rendered in Canvas; Canvas can trigger agent runs through `openclaw://agent?...` deep links (confirmation unless keyed). https://docs.openclaw.ai/platforms/mac/canvas

**Browser control.** A dedicated, isolated Chrome/Brave/Edge/Chromium profile (`openclaw`, orange accent) driven over CDP/Playwright through a loopback control service; `user` profile attaches to your real signed-in Chrome via Chrome DevTools MCP; `chrome` extension profile; remote CDP profiles. Actions: click/type/drag/select, ref-based snapshots, screenshots, PDFs, managed downloads; SSRF policy; screenshot-to-text fallback for text-only models; opt-in Lightpanda (v2026.9.7). https://docs.openclaw.ai/tools/browser

**Sandboxing (off by default).** `agents.defaults.sandbox.mode` = `off` (default) / `non-main` / `all`; scope `agent`/`session`/`shared`; backends **docker** (default image `openclaw-sandbox:bookworm-slim`, `network:"none"`, read-only root, `capDrop:["ALL"]`), **ssh**, **openshell** (managed remote sandboxes), and since v2026.9.5 **crabbox** (cloud machine, "agent and model credentials stay on the host"; initial support via Daytona). The Gateway itself is never sandboxed; `tools.elevated` is an explicit escape hatch; the sandboxed *browser* runs in its own container with a password-protected **noVNC observer** URL. Docs: "This is not a perfect security boundary". Complemented by tool policy (allow/deny, profiles), exec approvals (allowlist/ask; "YOLO/strict"), permission modes, and `openclaw security audit --deep --fix`. https://docs.openclaw.ai/gateway/sandboxing , https://docs.openclaw.ai/tools/exec-approvals , https://docs.openclaw.ai/gateway/sandboxing/crabbox-backend , https://github.com/openclaw/openclaw/blob/main/SECURITY.md

**Secrets.** Opt-in **SecretRefs** (env/file/exec/store sources) resolved into an in-memory snapshot; model-provider credentials travel as opaque **sentinels** (`oc-sent-v1-…`) until the final adapter; since ~v2026.9.4 a **shared secret store + secret egress proxy**: a TLS-intercepting proxy in a dedicated Gateway worker (per-start CA, 1-day leaf certs) swaps `oc-sent-v2…` sentinels in URLs/headers/bodies "immediately before egress", only toward hosts the secret is explicitly bound to ("wildcards, suffix matching, and ports are not supported"). Limits stated by the docs: off by default; store "not encrypted at rest" (plain SQLite, 0600); applies "only to Gateway-hosted exec" (sandbox and remote node exec get no secrets); subprocesses "can ignore those variables and open raw sockets"; a bound service that reflects credentials leaks them; and "Plaintext credentials remain agent-readable if they sit in files the agent can inspect, including `openclaw.json`, `auth-profiles.json`, `.env`…". Sentinels "are not process isolation. The real value still exists in same-process memory". https://docs.openclaw.ai/gateway/secrets , https://docs.openclaw.ai/gateway/secrets/secret-store-and-egress . v2026.9.7: `openclaw crabbox run --model` uses "a protected model credential that never leaves its original host". https://github.com/openclaw/openclaw/releases/tag/v2026.9.7

**Security model (official).** "Personal assistant (one trusted operator, potentially many agents), not shared multi-tenant bus." Prompt injection alone is out of scope for vulnerability reports unless it crosses a policy/auth/approval/sandbox/tool boundary; exec approvals are "operator guardrails… not a multi-tenant authorization boundary"; memory poisoning via `memory/*.md` is explicitly out of scope. https://github.com/openclaw/openclaw/blob/main/SECURITY.md

**Computer use (desktop GUI).** A first-party **`computer` tool** (Anthropic-style action set: `screenshot` → `frameId`; `left_click`/`double_click`/`left_click_drag`/`scroll`/`type`/`key`/`hold_key`/`wait`; a v2 window/element family `list_apps`, `list_windows`, `get_accessibility_tree`, `launch_app`, `set_value`, `zoom`, `invoke_menu`…; CUA-only browser and recording actions `start_recording`/`stop_recording`/`replay_trajectory`). "Coordinates are non-negative integer pixels in the most recent screenshot; the provider maps them to display points", and every action must echo the screenshot's `frameId` — "a display reconnect or geometry change fails closed instead of silently retargeting". Backends: macOS app node via **Peekaboo** (default) or an embedded **CUA driver** (TryCua) inheriting the app's Accessibility/Screen-Recording grants; experimental Windows/Linux via the `cua-computer` plugin; managed Linux desktop; cloud workers. "Screenshots are kept model-only: they are never auto-delivered to the chat channel." Separately, Codex-mode agents can use **Codex Computer Use** (Codex app-server's native MCP plugin, macOS). https://docs.openclaw.ai/nodes/computer-use , https://docs.openclaw.ai/plugins/codex-computer-use , https://docs.openclaw.ai/platforms/mac/peekaboo

**Managed desktop + cloud desktops (new, Aug–Sep 2026).**
- v2026.8.1 (2026-08-31): "Cloud desktop control: enable Cloud Worker Desktop and a desktop-enabled Crabbox profile to control the session-bound desktop in its Desktop panel. A vision model and explicit tool access are required." https://raw.githubusercontent.com/openclaw/openclaw/main/CHANGELOG/2026.8.1.md
- v2026.9.5: a **Systems workspace** with machines, resource readings and a remote desktop; "Desktop viewing starts in view-only mode; taking control remains an explicit action". v2026.9.6: native macOS and Windows cloud desktops, "open Crabbox apps beside the conversation". v2026.9.7: per-application desktop **audio**, "Computer use shelf" in the plugin browser. https://raw.githubusercontent.com/openclaw/openclaw/main/CHANGELOG/2026.9.5.md , …/2026.9.6.md , https://github.com/openclaw/openclaw/releases/tag/v2026.9.7
- **Managed Linux desktop** = "gateway-supervised, loopback-only TigerVNC/XFCE desktop" started lazily; RFB streamed to the browser over an authenticated WebSocket into a docked **Desktop panel** or standalone desktop view; audio via PulseAudio as 48 kHz PCM over a second WebSocket; to let the agent act you "explicitly enable `cua-computer`… and expose the `computer` tool". Config `desktop.host.{enabled,managed,port:5900}`. macOS/Windows hosts need their own VNC (Screen Sharing). https://docs.openclaw.ai/gateway/config-browser-ui-desktop
- **Cloud Worker Desktop** (lab flag): Crabbox leases on AWS/Azure/Hetzner (direct or coordinator); Linux XFCE on `:99`, native Windows launcher, macOS 15+ signed "OpenClaw Cloud Worker" app; RFB on worker `127.0.0.1:5900` tunnelled through the authenticated node connection; "The desktop never gains public ingress"; user can "Take control" (agent input pauses) and hand back. Desktop settings "do not sandbox authorized shell code". https://docs.openclaw.ai/gateway/cloud-workers/desktop

**Observability surfaces.** Control UI chat streams live tool-call cards; an **Activity tab** ("ephemeral browser-local observer… redaction-first"; tool *argument values are not stored*, resets on reload); Tasks ledger; Logs live tail; usage/cost cards; split panes; operator terminal; **trajectory capture** "per-session flight recorder" on by default with `/export-trajectory` redacted bundles; OpenTelemetry + Prometheus exporters; "working status" live line (v2026.9.7); **Logbook** plugin = Dayflow-style timeline built from periodic screen snapshots (disabled by default). https://docs.openclaw.ai/web/control-ui , https://docs.openclaw.ai/tools/trajectory , https://docs.openclaw.ai/gateway/opentelemetry , https://docs.openclaw.ai/plugins/logbook

### 1.3 Setup flow

1. Prereqs: Node **22.22.3+ / 24.15+ / 25.9+** (24 recommended) and a provider key/subscription. https://docs.openclaw.ai/start/getting-started
2. Install: `curl -fsSL https://openclaw.ai/install.sh | bash` (Windows: `iwr -useb https://openclaw.ai/install.ps1 | iex` or the Windows Hub app); alternatives Docker/Podman (M3 Beta), npm, Nix (M1). https://docs.openclaw.ai/install
3. `openclaw onboard --install-daemon` — wizard: provider + auth (API key, OAuth, Anthropic setup-token, Codex/ChatGPT sign-in), Gateway bind/auth token, launchd/systemd daemon, optional channels (Telegram BotFather token, WhatsApp QR link, Slack socket mode…), skills and plugins. "QuickStart is usually only a few minutes"; `openclaw configure` later. https://docs.openclaw.ai/start/wizard
4. Verify `openclaw gateway status`; open `openclaw dashboard` (Control UI on :18789; non-loopback browsers must be device-paired: `openclaw devices list/approve`). https://docs.openclaw.ai/web/dashboard
5. Hardening/maintenance: `openclaw doctor --fix` (config migrations — config compatibility is deliberately not preserved), `openclaw security audit --deep --fix`, `openclaw secrets audit --check`, channel pairing approvals, optional sandbox (`scripts/sandbox-setup.sh`, Docker socket). https://docs.openclaw.ai/gateway/doctor , https://docs.openclaw.ai/gateway/secrets
- Docker path used by this user: `docker-compose.yml` with gateway + CLI services, `cap_drop: [NET_RAW, NET_ADMIN]`, `no-new-privileges`, ports 18789/18790/3978 published, `~/.openclaw` bind-mounted; the sandbox needs the host Docker socket (Docker-out-of-Docker path mapping caveats). Local file `~/openclaw/docker-compose.yml`; https://docs.openclaw.ai/gateway/sandboxing

### 1.4 What users love most (primary threads/posts; individual comments are anecdotal)

1. **It lives in the chat apps you already use.** Federico Viticci: "instead of having to install yet another app… I could use it in an app I was already familiar with" https://www.macstories.net/stories/clawdbot-showed-me-what-the-future-of-personal-ai-assistants-looks-like/ (2026-01-20); Siri → iMessage → agent errands called "the product that Apple and Google were unable to build" https://news.ycombinator.com/item?id=46838946 ; "OpenClaw is what Apple intelligence should have been" (518 HN points) https://www.jakequist.com/thoughts/openclaw-is-what-apple-intelligence-should-have-been
2. **Proactivity (heartbeats + cron), overnight work.** "Overnight autonomous work is the killer feature" (same HN thread); 30+ price alerts, meeting prep, restaurant booking https://brandon.wang/2026/clawdbot ; Claire Vo: it "feels alive… heartbeat but not a brain" https://x.com/clairevo/status/2017741569521271175
3. **Memory as portable Markdown** — "Everything's just .md files underneath… No lock-in"; "When a better LLM comes along, I can just switch" https://news.ycombinator.com/item?id=47783940
4. **Self-extending skills** — "you can just ask it to do so, and it'll do it for you" (Viticci); "When you give it feedback it updates its skill files".
5. **Remote control for coding agents from a phone** — "handle an entire project's development, testing, deployment… all through chatting on my phone" https://reorx.com/blog/openclaw-is-changing-my-life/ ; "my remote control for claude code".
6. **Any model, self-hosted; now multiplayer** (2.0: reuse subscriptions/API keys/local models; shared cloud sessions) https://openclaw.ai/blog/openclaw-2-accidentally

### 1.5 Weaknesses and complaints

1. **Security posture** — "that hot mess of a walking, talking CVE"; "You are not supposed to install OpenClaw on your personal computer" https://news.ycombinator.com/item?id=47129647 ; "Sandboxes won't save you" (the danger is legitimate delegated authority → need granular permissions) https://tachyon.so/blog/sandboxes-wont-save-you
2. **Token burn** — "$40-50 in one week" for a morning briefing; Viticci burned 180M tokens; heartbeats resend whole context; 2M+ tokens/day even with heartbeat disabled https://github.com/openclaw/openclaw/issues/64293 ; creator reported $1.3M of OpenAI tokens in 30 days https://news.ycombinator.com/item?id=48159227
3. **Reliability / silent failures** — "I typically have to follow up 2 or 3 times"; WhatsApp "super janky"; silent reply failures (#116277, 196 comments; #121058); gateway memory leak to 15.5 GB with "Crashes Produce No Error Logs" (#91588); SQLite WAL 1.4–2.8 GB (#143524); CPU spin stalls Telegram (#72338); WebUI performance umbrella (#149361). https://github.com/openclaw/openclaw/issues/116277 , https://github.com/openclaw/openclaw/issues/91588
4. **Upgrades break things** — "2026.9.5 Turned a Stable Environment Into an 8-Hour Failure Recovery Session" https://github.com/openclaw/openclaw/issues/153257 ; Control UI missing from an npm build (#52808); Node-version install failures in Sept (#145658, #141816, #144019, #142208). Config compatibility is intentionally *not* preserved (doctor migrations instead) https://github.com/openclaw/openclaw/blob/main/VISION.md
5. **Setup** — "Installation on a clean Ubuntu 24.04 system was messy. I eventually had codex do it"; "configuration seems bloated and finicky… local model… clearly an afterthought"; "a solid afternoon" to configure. (HN, anecdotal)
6. **Memory/context quality** — "An autonomous agent that you have to verify every time is just a chatbot with extra steps" (from ~1,000 deployments) https://blog.nishantsoni.com/p/ive-seen-a-thousand-openclaw-deploys ; compaction dropped a "don't action until I tell you" instruction → mass email deletion (Summer Yue, 2026-02-23) https://twitter.com/summeryue0/status/2025774069124399363
7. **Observability** — "Diagnostic vacuum — no error info" (#116277); narration/heartbeat output leaking into user chats (#25592, #143278); no working stop from a phone in the Summer Yue incident. Third-party "mission control" dashboards filled the gap (see 1.6.8).
8. **Churn to alternatives** — "the first one where it didn't feel like I was constantly needing to fix it" (moving to Hermes Agent); Hermes ships a "Migrate from OpenClaw" guide https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw ; some find "long-running Claude Code + a Telegram bot" enough.
9. **Provider ToS friction** — Google restricted AI Pro/Ultra accounts using Antigravity OAuth via OpenClaw (2026-02-22) https://discuss.ai.google.dev/t/account-restricted-without-warning-google-ai-ultra-oauth-via-openclaw/122778 ; Anthropic subscription/third-party-harness policy changed repeatedly (Apr 4 email https://news.ycombinator.com/item?id=47633396 ; OpenClaw docs: "Anthropic's June 15, 2026 support update paused the previously announced separate Agent SDK credit plan… third-party app usage still draw[s] from the signed-in subscription's usage limits"; for automation "use an Anthropic API key instead of Claude CLI") https://docs.openclaw.ai/providers/anthropic

### 1.6 Security incidents (Jan–Sep 2026)

**1.6.1 Scale (primary data).** 722 published GHSAs on openclaw/openclaw (14 critical, 249 high, 390 medium, 69 low; by month Jan 3, Feb 220, Mar 204, Apr 108, May 67, Jun 45, Sep 75) via `gh api repos/openclaw/openclaw/security-advisories --paginate`. Title keyword classes: pairing/device/scope/token auth 177; exec allowlist/approval bypass 158; per-channel sender auth 146; browser/CDP/SSRF 68; sandbox 40; skills/plugins 38; memory 13; MCP 12; Canvas/A2UI 7. NVD keyword "openclaw": 676 CVEs Feb–Sep 2026 (54 critical, 297 high; ~19 are forks/third-party tools) https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=openclaw . Top credited reporters: tdjackey (137), KeenSecurityLab (90), qclawer (60), zsxsoft (56), zpbrent (52), AntAISecurityLab (31). Early audit "512 vulnerabilities, eight… critical" https://www.kaspersky.com/blog/openclaw-vulnerabilities-exposed/55263/ [auditor unnamed, UNVERIFIED].

**1.6.2 Landmark CVEs/GHSAs** (ID — CVSS — issue — fixed in):
- **CVE-2026-25253 / GHSA-g8p2-7wf7-98mq** — 8.8 — one-click RCE: Control UI trusted `?gatewayUrl=` and auto-connected with the stored token; no WS Origin validation; attacker used the token to set `tools.exec.host="gateway"` (escaping Docker) — exploitable "even on instances configured to listen on loopback only" — fixed v2026.1.29 (found by Mav Levin, depthfirst) https://github.com/advisories/GHSA-g8p2-7wf7-98mq , https://thehackernews.com/2026/02/openclaw-bug-enables-one-click-remote.html
- CVE-2026-25593 (8.4, unauth local RCE via WS `config.apply`, fixed 2026.1.20); CVE-2026-24763 (8.8, Docker exec PATH injection, 2026.1.29); CVE-2026-25157 (7.7, `sshNodeCommand` injection, 2026.1.29).
- 2026.2.14 batch: CVE-2026-26322 (`gatewayUrl` override), CVE-2026-26324 (SSRF bypass via IPv4-mapped IPv6 → loopback/metadata), CVE-2026-26317 (CSRF via loopback browser endpoints), CVE-2026-26329 (upload path traversal), CVE-2026-26326 (`skills.status` leaked secrets to read-scoped clients).
- **"ClawJacked" / GHSA-jmmg-jqc7-5qf4** (Oasis Security) — any website could open a WS to localhost; loopback exempt from rate limits → password brute force "hundreds of guesses per second"; local pairing auto-approved → admin — fixed 2026.2.25 https://thehackernews.com/2026/02/clawjacked-flaw-lets-malicious-sites.html , https://www.bleepingcomputer.com/news/security/clawjacked-attack-let-malicious-websites-hijack-openclaw-to-steal-data/
- Pairing/scope escalation criticals (CVSS 9.8–9.9): CVE-2026-22172 (self-declared scopes, fixed 2026.3.12), CVE-2026-32922 (`device.token.rotate` minting broader scopes, 2026.3.11), **CVE-2026-33579** (`/pair approve` without caller-scope checks, 2026.3.28) https://nvd.nist.gov/vuln/detail/CVE-2026-33579 , CVE-2026-41386 (setup codes not role-bound, 2026.3.22), CVE-2026-53838 (node re-pair scope confusion, 2026.5.27).
- Sandbox escapes: CVE-2026-27002 (9.8, sandbox config injection → bind mounts/host network, 2026.2.15), CVE-2026-32048 (9.9, cross-agent `sessions_spawn`, 2026.3.1), CVE-2026-41329 (9.9, heartbeat owner-context inheritance, 2026.3.31), CVE-2026-41397 (9.6, symlink traversal in sync, 2026.3.31), CVE-2026-32038 (9.0, `docker.network=container:` join, 2026.2.24).
- Untrusted-event → trusted-context (May): CVE-2026-43534 (hook metadata as trusted system events, 2026.4.10), CVE-2026-43566 (webhook wake skipped owner downgrade, 2026.4.14), CVE-2026-43578 (async exec completions misclassified, 2026.4.10).
- **Viewer / remote-control surfaces (directly relevant to localDot):** CVE-2026-32064 (9.1, sandbox browser x11vnc with **no auth** for noVNC observers, fixed 2026.2.21); CVE-2026-43575 (9.8, noVNC helper route auth bypass exposing browser-session credentials, fixed 2026.4.10); CVE-2026-43581 (9.6, sandbox-browser CDP relay bound to 0.0.0.0, 2026.4.10); CVE-2026-27009 (stored XSS in Control UI via assistant name/avatar, 2026.2.15); GHSA-vr7j-7684-7gm5 (8.0, Canvas HTTP responses forging trusted A2UI actions, 2026.6.5); GHSA-pjjr-5qhr-5w6r (8.8, Codex computer-use install skipped owner auth, 2026.7.1); GHSA-9x88-f7rh-4c83 (8.3, browser node targets bypassed sandbox host control, 2026.7.1).
- Exec-allowlist parsing is cat-and-mouse (158 advisories): heredocs (CVE-2026-27209), argv carriers (CVE-2026-32052), HOME/ZDOTDIR env injection (CVE-2026-32056), glob over-match (CVE-2026-32973, 9.8), reusable approvals authorising changed args (GHSA-74gc-hg2m-79p9, Sep).
- Disputed: CVE-2026-30741 ("RCE via request-side prompt injection", third-party filing; prompt-injection-only chains are out of scope per SECURITY.md).

**1.6.3 Exposed gateways.** Jan 25–27: Jamieson O'Reilly (Dvuln) found hundreds of "Clawdbot Control" panels on Shodan (port 18789), 8 fully open with command execution; root cause = localhost auto-trust behind reverse proxies; leaked API keys, bot tokens, chat history https://github.com/openclaw/openclaw/issues/2245 , https://www.theregister.com/special-features/2026/01/27/clawdbot-becomes-moltbot-but-cant-shed-security-concerns/5190124 . Jan 31 Censys: 21,639 exposed (≥30% on Alibaba Cloud) https://censys.com/blog/openclaw-in-the-wild-mapping-the-public-exposure-of-a-viral-ai-assistant/ . Feb 9 SecurityScorecard STRIKE: 40,214 instances, 63% vulnerable, 12,812 RCE-exploitable https://www.infosecurity-magazine.com/news/researchers-40000-exposed-openclaw/ . Mar 31: Censys 63,070 live; GreyNoise 9,993 IPs scanning 18789 https://blog.cyberdesserts.com/openclaw-exposure-numbers-explained/ [secondary aggregation].

**1.6.4 Malicious ClawHub skills.** Cisco (Jan 28): #1-ranked skill "What Would Elon Do?" silently exfiltrated via curl; Cisco released Skill Scanner — "Security for OpenClaw is an option, but it is not built in" https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare . **ClawHavoc** (Koi Security, Feb 1–2): 341 malicious of 2,857 skills, 335 delivering **Atomic macOS Stealer (AMOS)** via fake "prerequisites", password-protected zips, exfil of `~/.clawdbot/.env` https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html . Snyk "ToxicSkills" (Feb 5): 3,984 skills scanned, 13.4% critical, 76 confirmed malicious https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/ . Bitdefender (Feb 5): 900+ malicious (~20%) — "do not run OpenClaw on a company device" https://businessinsights.bitdefender.com/technical-advisory-openclaw-exploitation-enterprise-networks . Antiy CERT (Feb 19): 1,184 malicious https://cyberpress.org/clawhavoc-poisons-openclaws-clawhub-with-1184-malicious-skills/ . Unit 42 (Jun 23): skills evading ClawScan + VirusTotal for months (22 MB README padding; "semantic instruction hijacking" in plain Markdown) https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/ . **Response:** report button + auto-hide after >3 reports, GitHub-account-age gate, **VirusTotal partnership** (2026-02-07, hash + Code Insight, daily rescans; "not a silver bullet") https://openclaw.ai/blog/virustotal-partnership , openclaw/clawscan scanner; ClawHub itself later had CVE-2026-100600..100604 (e.g. four accounts could auto-hide any skill).

**1.6.5 Prompt injection / agent misbehaviour.** Email injection made an agent return `~/.ssh/id_rsa` (Archestra.AI demo, Kaspersky above). Zenity Labs (Feb 4): a Google Doc injection added an attacker Telegram bot, a scheduled task rewrote `SOUL.md` every 2 min, and a Sliver C2 implant was deployed — "No software vulnerability is required" https://labs.zenity.io/p/openclaw-or-opendoor-indirect-prompt-injection-makes-openclaw-vulnerable-to-backdoors-and-much-more ; HiddenLayer: `HEARTBEAT.md` as C2 https://www.hiddenlayer.com/research/exploring-the-security-risks-of-ai-assistants-like-openclaw . PromptArmor: zero-click exfil through Telegram/Discord **link previews** https://www.promptarmor.com/resources/llm-data-exfiltration-via-url-previews-(with-openclaw-example-and-test) . Log poisoning via WS headers (GHSA-g27f-9qjv-22pm). matplotlib maintainer "hit piece" by an agent https://www.fastcompany.com/91492228/matplotlib-scott-shambaugh-opencla-ai-agent . **"Clinejection"** (Feb 17): prompt injection against Cline's triage bot → stolen npm token → `cline@2.3.0` silently installed `openclaw@latest` as a daemon (~4,000 downloads) https://www.stepsecurity.io/blog/cline-supply-chain-attack-detected-cline-2-3-0-silently-installs-openclaw

**1.6.6 Credential leaks.** Keys in `openclaw.json`/`auth-profiles.json`/`.env`/`models.json` are agent-readable; SecretRefs are opt-in https://github.com/openclaw/openclaw/blob/main/docs/gateway/secrets.md . First infostealer in the wild (Hudson Rock, ~Feb 13–16; probable Vidar) grabbed `openclaw.json`, `device.json`, `soul.md`, memory files https://thehackernews.com/2026/02/infostealer-steals-openclaw-ai-agent.html . Other: Telegram bot token in logs (CVE-2026-27003), trajectory export skipping redaction (GHSA-j4cx-jvq7-79vm), revoked tokens valid after SecretRef rotation (CVE-2026-43585, 9.8), provider keys sent to the wrong endpoint / wrong vendor (GHSA-vhpg-cq3w-v8p9, GHSA-66hm-hxq3-5pfh, Sep).

**1.6.7 Moltbook, rename scams, advisories/bans.** Moltbook (agents' social network, launched 2026-01-28): unsecured Supabase (key in front-end JS, no RLS) exposed 1.5M agent API tokens, 35k emails, 4,060 DMs and was writable (prompt-injection vector); disclosed by Wiz Jan 31, fixed by Feb 1 https://www.wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys ; Meta acquired Moltbook 2026-03-10 https://en.wikipedia.org/wiki/Moltbook . Rename (Jan 27): old GitHub org/X handle grabbed "within seconds"; fake $CLAWD token ~$16M cap [secondary] https://dev.to/sivarampg/from-clawdbot-to-moltbot-how-a-cd-crypto-scammers-and-10-seconds-of-chaos-took-down-the-4eck ; typosquats https://www.malwarebytes.com/blog/threat-intel/2026/01/clawdbots-rename-to-moltbot-sparks-impersonation-campaign . Advisories: Gartner "insecure by default"/"unacceptable cybersecurity risk" (Feb, paywalled; secondary https://securityboulevard.com/2026/02/the-absolute-nightmare-in-your-dms-openclaw-marries-extreme-utility-with-unacceptable-risk/); 1Password https://1password.com/blog/from-magic-to-malware-how-openclaws-agent-skills-become-an-attack-surface ; Kakao/Naver/Karrot bans https://www.koreatimes.co.kr/business/tech-science/20260208/top-tech-firms-ban-openclaw-over-security-breach-fears ; **Microsoft** (Feb 19): "treat as untrusted code execution with persistent credentials… not appropriate to run on a standard personal or enterprise workstation" https://www.microsoft.com/en-us/security/blog/2026/02/19/running-openclaw-safely-identity-isolation-runtime-risk/ ; China CNCERT warning + bank/government restrictions (Mar) https://www.theregister.com/2026/03/12/china_cert_openclaw_security_warning ; CrowdStrike guidance (Apr 16) https://www.crowdstrike.com/en-us/blog/what-security-teams-need-to-know-about-openclaw-ai-super-agent/

**1.6.8 What OpenClaw shipped in response** (release notes via `gh api …/releases`): 2026.1.8 DMs `pairing` by default; 2026.1.14 expanded `security audit --fix`, detect-secrets CI, SECURITY.md; 2026.1.15 node tokens in Keychain; 2026.1.20 exec-approvals + UI; **2026.1.29 removed gateway auth "none"** + `gatewayUrl` fix; 2026.2.6 skill/plugin code-safety scanner, credentials redacted from `config.get`; 2026.2.12 browser/web content wrapped as untrusted; 2026.2.14 recalled memories untrusted; 2026.2.19 plaintext `ws://` blocked to non-loopback; 2026.2.21 noVNC password + short-lived observer tokens; 2026.2.25 Origin checks, loopback brute-force throttling, no silent auto-pairing; ~2026.3.1 SecretRefs + `secrets audit/configure/apply/reload` [exact version UNVERIFIED]; 2026.3.22 pluggable sandbox backends (OpenShell, SSH) → later Crabbox; Jun 23 ClawScan; ~2026.9.4 shared secret store + egress proxy (see 1.2). **Unchanged posture:** sandbox off by default; "one trust boundary per gateway"; prompt injection without a boundary bypass is out of scope; malicious plugin after operator install is not a bug; **no paid bug bounty** https://github.com/openclaw/openclaw/blob/main/SECURITY.md , https://docs.openclaw.ai/gateway/security

**1.6.9 Community observability tools** (they exist because the built-in view is thin): **ClawMetry** (vivekchand/clawmetry, 423 stars, MIT) — live "Flow" diagram, "Brain" stream of reasoning + tool calls, tool-by-tool replay, cost/context tracking, phone approvals ("An agent can make a hundred tool calls without making progress"); builderz-labs/mission-control (6,289 stars, MIT, alpha); abhi1693/openclaw-mission-control (4,104 stars); robsannaa/openclaw-mission-control (622); tugcantopaloglu/openclaw-dashboard (702 stars, no license) — itself hit by two unauthenticated stored-XSS CVEs (CVE-2026-66418, CVE-2026-66421: markup inside an agent transcript message rendered with `innerHTML` can steal session tokens). Built-in: `diagnostics-otel` → Grafana/Datadog/Honeycomb/Tempo; Prometheus plugin. https://docs.openclaw.ai/gateway/opentelemetry , https://openclaw.ai/podcast/episode-10

**Security lessons for localDot (from 1.6):** (1) never trust localhost — auth + Origin allowlist + rate limits on loopback WebSockets, no auto-pairing, never take endpoints from URL params (CVE-2026-25253, ClawJacked); (2) make the VM the boundary, not shell-allowlist parsing (158 bypass advisories); capability-scoped tokens, no self-declared scopes (177 auth advisories); (3) no agent-readable secrets — broker/proxy injection; treat SOUL/HEARTBEAT/memory files as a persistence attack surface (Zenity, HiddenLayer, infostealers) with visible diffs + approval; (4) the *viewer is an attack surface* — VNC/noVNC/CDP loopback-only with per-session tokens (four criticals in OpenClaw), sanitise every rendered transcript (XSS via agent messages); (5) a kill switch that works from every surface + pinned constraints that survive compaction; disable/sanitise link unfurls (zero-click exfil); (6) no open skill marketplace at launch — signed, pinned, reviewed, permission-declared skills (scanners are bypassable).

### 1.7 Does OpenClaw visualise actions? — verdict

- **Yes, at the text/event level; partially at the pixel level (new); not at the "watch the agent's hands" level.**
  - Live: chat tool cards, Activity tab (argument values hidden by design), working-status line, Tasks, Logs, progress drafts. Post-hoc: trajectory bundles, OTel traces. https://docs.openclaw.ai/web/control-ui , https://docs.openclaw.ai/tools/trajectory
  - Pixels: sandboxed-browser noVNC observer (off by default); since Aug–Sep 2026 a VNC **Desktop panel** for a managed Linux desktop or Crabbox cloud desktops with view-only/Take-control. https://docs.openclaw.ai/gateway/sandboxing , https://docs.openclaw.ai/gateway/config-browser-ui-desktop
  - The chat Browser panel gained a live repaint view in v2026.9.3 (per release notes, via the security/sentiment sub-study). The managed desktop is a *Linux gateway-host* feature: the user's `2026.9.5-browser` container has only `Xvfb` — `Xtigervnc`, `startxfce4`, `dbus-daemon` are absent — so it is not available out of the box in the standard Docker image [checked with `command -v` inside the container].
  - Missing (per docs): no cursor/click overlay, no bounding-box/element highlight, no per-step before/after frames in the UI, no scrubbable action timeline synchronised with the video; "Screenshots are kept model-only". The desktop features are lab-gated, Linux-managed or cloud (Crabbox) — on a Mac host the "computer" is your real desktop via Peekaboo/CUA (not isolated). https://docs.openclaw.ai/nodes/computer-use , https://docs.openclaw.ai/gateway/cloud-workers/desktop
- **Implication for localDot:** OpenClaw has closed part of the gap (a streamed desktop exists), so localDot's differentiation must be the *quality of explanation*: an always-on, local, isolated desktop with a synchronised action layer (ghost cursor, click ripples, target boxes, typed-text captions, intent/"why" captions, step timeline + replay, diff of before/after frames), plus the avatar companion and a stronger key layer.

### 1.8 The user's own OpenClaw install (structure only; all secrets, IDs and tokens redacted/unread)

What was inspected: file/dir names under `~/.openclaw`, key structure of `openclaw.json` (values only where non-secret), cron job names/schedules, state-DB table names, container image/mounts, `~/openclaw/docker-compose.yml` with env values redacted. `credentials/`, `identity/`, `.env` files, backups and workspace file contents were **not** opened.

- **Deployment:** Docker, image `ghcr.io/openclaw/openclaw:2026.9.5-browser` (`OpenClaw 2026.9.5 (ec9c1a1)`), healthy for 7 days; compose from `~/openclaw` (a clone at tag v2026.7.1-2). Ports 18789–18790 and 3978 published on `0.0.0.0`; `gateway.bind:"lan"` with token auth; Control UI origins limited to localhost; OTel exporter env vars wired. Config last written by the 2026.8.2 wizard (`doctor`). Host `~/.openclaw` → `/home/node/.openclaw` (rw), workspace (rw), and `~/.openclaw-auth-profile-secrets` → `/home/node/.config/openclaw` (rw).
- **Agents:** `main` (workspace `~/.openclaw/workspace`, model `anthropic/claude-opus-5` through an Anthropic **setup-token** auth profile, runtime `openclaw`) and `slack-agent` (own workspace). Bindings: CLI, Telegram, WhatsApp → `main`; Slack → `slack-agent`.
- **Models:** default primary = LM Studio `qwen3.8-27b` (uncensored fine-tune, text+image) via `host.docker.internal:1234`; compaction model `google/gemma-4-26b-a4b-qat` (LM Studio); image/PDF model = the same Qwen; also Kimi Coding / Moonshot (Kimi K2.5) and OpenRouter (Kimi Code, Gemini 2.5 Flash). Memory search embeddings via LM Studio (nomic-embed-text v1.5 is the only embedding model installed). `lms ls` today: gemma-4-26b-a4b-qat (15.6 GB), qwen3.8-27b (17.7 GB), qwen3.6-35b-a3b fine-tune (44.5 GB), qwen3.8-27b fine-tune MTP (26.9 GB).
- **Channels:** Telegram (enabled, streaming, 👀 ack), WhatsApp (enabled), Slack (socket mode, disabled).
- **Skills/plugins:** 37 `skills.entries`, only 3 enabled (`voice-reply`, `update-voice-clone`, `qwen-image`); ~35 skill folders in `~/.openclaw/skills` (Cloudflare, HyperFrames video, sandbox SDK…); plugin skills `browser-automation`, `canvas`; Skill Workshop proposals dir present. Plugins enabled: telegram, kimi, moonshot, lmstudio, browser, duckduckgo, anthropic.
- **Tools:** deny `view_image`, `tts`, `cron`, `image`; exec timeout 24 h; web search via DuckDuckGo; browser headless with `noSandbox:true`, SSRF allowlist = localhost.
- **Automation:** heartbeat disabled (`every:"0m"`); 5 cron jobs, all isolated `agentTurn` announced to Telegram: `frontend-daily` 08:00 UTC, "Tech Morning/Afternoon/Evening Brief" 09:00/14:00/20:00 Europe/London, plus a personal daily-news brief 09:00.
- **Sessions/memory:** `dmScope:"per-channel-peer"`, idle resets 120 min (DM) / 240 min (group); compaction `safeguard`; memory is the builtin SQLite index (legacy vector DB files migrated into `state/openclaw.sqlite`, whose tables include `capture_*`, `sandbox_registry_entries`, `secret_store_entries`, `worker_environments`, `skill_workshop_proposals`, `audit_events`, `operator_approvals`).
- **Secrets:** migrated to SecretRefs on 2026-09-21 (provider `apiKey`s are `{source, provider, id}` refs to a `teamstore` provider with `source:"store"` = the shared secret store). Secret egress proxy **not** enabled; no `proxy` block.
- **Sandbox:** not configured (default `off`) → every tool runs inside the gateway container.

**Security observations worth acting on (independent of localDot):**
1. **The Telegram bot is public.** `dmPolicy:"open"` with `allowFrom` containing `"*"`, and `groupPolicy:"open"` with `groupAllowFrom` containing `"*"` (groups need a mention). OpenClaw's docs: this "lets any Telegram account that finds or guesses the bot username command the bot. Use it only for intentionally public bots with tightly restricted tools" https://docs.openclaw.ai/channels/telegram . Here tools are not restricted, the sandbox is off, and the rw mount exposes `credentials/`, `identity/`, the auth-profile secrets dir and many config backups (`*.bak*`, `openclaw.json.pre-secretref-*`, `clawdbot.json.bak*`) that pre-date the SecretRef migration and so may still contain plaintext keys [not opened; inferred from the docs' warning that backups "stay production secrets until deleted"] https://docs.openclaw.ai/gateway/secrets . Suggested: switch to `allowlist`/`pairing`, run `openclaw security audit --deep` and `openclaw secrets audit --check`, move backups out of the mounted directory, and turn on `sandbox.mode:"non-main"` or `"all"` for anything reachable by others.
2. Gateway ports are published on all interfaces (token-protected). Mapping them as `127.0.0.1:18789:18789` would keep the Control UI off the LAN.
3. This setup shows the exact problem localDot's key layer is meant to solve: even with SecretRefs, anything the agent can read in its filesystem stays exposed.

---

## 2. TASK 2 — Alternatives and forks that improve on OpenClaw (2026)

All star counts / push dates / releases from `gh repo view` on 2026-09-30 (~14:00 UTC); dates without a year are 2026. Claw-family index: https://github.com/machinae/awesome-claws

### 2.1 Open-source alternatives — health + capability

| Project | Repo | Lang | License | Stars | Last push | Latest release | Isolation / secrets | Visual desktop / live action view |
|---|---|---|---|---|---|---|---|---|
| **Hermes Agent** (Nous Research) | NousResearch/hermes-agent | Python + TS desktop | MIT | **250,250** | 09-30 | v0.21.5 (09-24) | 7 terminal backends, env-var stripping, approval modes (LLM-judged "smart" approvals + hardline blocklist, `--cap-drop ALL`); keys still on host | **Yes (Linux hosts):** "Bot Desktop" (Xfce + TigerVNC over RFB on a private Unix socket) viewed in Hermes Desktop with a takeover lease; `computer_use` via cua-driver |
| **nanobot** (HKUDS) | HKUDS/nanobot | Python | MIT | 48,698 | 09-30 | v0.3.5 (09-15) | workspace access modes | WebUI shows reasoning, tool calls, diffs, command output |
| **ZeroClaw** | zeroclaw-labs/zeroclaw | Rust | Apache-2.0 (README: MIT OR Apache) | 32,916 | 09-30 | v0.8.5 (09-05) | `supervised` autonomy; Landlock/Bubblewrap/Seatbelt/Docker; HMAC-signed "tool receipts" | dashboard with tool inspection; Xvfb+noVNC helper for the browser |
| **NanoClaw** | nanocoai/nanoclaw (ex gavrielc/, qwibitai/) | TS | MIT | 30,863 | 09-29 | v2.4.0 (09-23) | per-session Docker container; credential gateway (OneCLI Agent Vault) so agents "never hold raw API keys" | none (by design) |
| **PicoClaw** (Sipeed) | sipeed/picoclaw | Go | MIT | 30,022 | 09-24 | v0.3.1 (07-03) | `.security.yml`, sensitive-data filter; "don't use in production before v1.0" | web launcher; tool-feedback animation |
| **Agent Zero** | agent0ai/agent-zero | Python | MIT (gh: "Other") | 19,357 | 09-30 | v2.13 (09-23) | Docker (Kali) container; `§§secret(alias)` placeholders + streaming output masking | **Yes:** XFCE desktop via **Xpra HTML5** in a right-side Canvas; live browser surface with element refs, per-step screenshots, annotation mode |
| **IronClaw** (NEAR AI) | nearai/ironclaw | Rust | Apache-2.0 (README: MIT OR Apache) | 12,637 | 09-30 | 1.4.1 (09-29) | **WASM capability sandbox**; pipeline WASM → endpoint allowlist → leak scan → **credential injection at host boundary** → execute → leak scan; AES-256-GCM secrets; Docker job sandbox; audit log | web chat (SSE/WS) only |
| Moltis | moltis-org/moltis | Rust | MIT | 2,878 | 09-22 | 20260913.02 | Docker/Podman, Apple Container, WASM | no |
| **Moltworker** (Cloudflare) | cloudflare/moltworker | TS | Apache-2.0 | 9,958 | 05-09 | none | OpenClaw in a Cloudflare Sandbox container behind Access — "Proof of concept, not a Cloudflare product" (~$34.50/mo 24/7) https://blog.cloudflare.com/moltworker-self-hosted-ai-agent/ | no (headless CDP browser); stale |
| Letta Code / Letta | letta-ai/letta-code; letta-ai/letta | TS; Py | Apache-2.0 | 3,484; 24,982 | 09-30; 09-10 | v0.34.0 (09-30); 0.16.8 (05-14) | secrets hidden from context (needs Letta sign-in) | desktop/web chat only |
| memU | NevaMind-AI/memU | Python | Apache-2.0 (gh: "Other") | 14,495 | 09-21 | v1.5.1 (03-23) | memory sidecar (defaults to hosted API key) | n/a |
| **OneCLI** | onecli/onecli | TS + Rust gateway | Apache-2.0 (+ ee/) | 3,532 | 09-14 | v2.6.0 (09-08) | MITM HTTPS gateway that "intercepts outbound requests (HTTPS included, via MITM) and injects credentials"; host+path matching; Bitwarden/1Password | n/a |
| Kortix (ex Suna) | kortix-ai/suna | TS | **Elastic-2.0 (not OSI)** | 20,238 | 09-30 | v0.13.43 | cloud sandbox per session | cloud computers |
| goose | aaif-goose/goose | Rust | Apache-2.0 | 54,806 | 09-30 | v1.52.0 | — | desktop app, no VM |
| Open Interpreter | openinterpreter/openinterpreter | Rust | Apache-2.0 | 68,478 | 09-30 | rust-v0.0.45 | pivoted to coding agent for open models | — |
| OpenManus | FoundationAgents/OpenManus | Python | MIT | 58,442 | 09-30 | v0.3.0 (**2025-04**) | stale releases | — |
| Bytebot | bytebot-ai/bytebot | TS | Apache-2.0 | 11,084 | **2025-09-12** | none | container desktop | yes, but stale for a year |
| Others | nullclaw (Zig, 8,103), TinyAGI (ex TinyClaw, 3,618, last push 03-30), AstrBot (**AGPL**, 41,257), OpenFang (18,206, last push 07-02), MimiClaw (ESP32, 5,771) | | | | | | | none |

### 2.2 Notes per project

- **Hermes Agent** — learning loop (auto-created skills, FTS5 session recall, Honcho user modelling); channels Telegram/Discord/Slack/WhatsApp/Signal/email; `hermes claw migrate` imports `~/.openclaw` (SOUL.md, memories, skills, allowlists, keys) and a "Migrate from OpenClaw" guide https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw ; security doc https://hermes-agent.nousresearch.com/docs/user-guide/security . From source: `tools/computer_use_tool.py` "Universal desktop control via cua-driver… Works with any tool-capable model… does NOT steal the user's cursor"; `tools/bot_desktop/runtime.py` "one headless Xfce desktop per Hermes profile, served over RFB on a private Unix socket, viewed and driven from Hermes Desktop" (Linux only); `rfb_filter.py` gates noVNC input so only the lease holder controls the screen (noVNC `viewOnly` "is a UI hint"); cua-driver's cursor overlay is **off by default on macOS ("can peg a core", #47032) and on X11**; Hermes Desktop ships a transparent always-on-top **"pet overlay"** (prior art for localDot's avatar). Controversy: plagiarism claims edited out of issue #10232 https://news.ycombinator.com/item?id=48187581 . https://github.com/NousResearch/hermes-agent
- **NanoClaw** — critique of OpenClaw: "nearly half a million lines of code, 53 config files… security is at the application level… rather than true OS-level isolation". Architecture: channels → host router → per-session `inbound.db` → container (Bun + **Claude Agent SDK**) → `outbound.db`; channels added per fork via skills (`/add-telegram`); Codex/OpenCode/Ollama drop-ins. Show HN 02-01 (Apple container isolation) https://news.ycombinator.com/item?id=46850205 → Docker 02-22 https://news.ycombinator.com/item?id=47113731 . Weakness: Claude-centric; setup leans on Claude Code. https://github.com/nanocoai/nanoclaw
- **IronClaw** — strongest *open* security design among claws (WASM tools, allowlists, Block/Warn/Review/Sanitize injection policy, request/response leak scans, host-boundary credential injection, hybrid FTS+vector memory); no published advisories; no desktop. https://github.com/nearai/ironclaw
- **ZeroClaw** — HMAC-SHA256 tool receipts detect fabricated tool results (docs/book/src/security/tool-receipts.md); HIGH advisory 09-05 (plugin `wasm_path` traversal). https://github.com/zeroclaw-labs/zeroclaw
- **nanobot** — 5 high/critical advisories: CVE-2026-31977 (auth bypass), CVE-2026-33654 (zero-click prompt injection via email), CVE-2026-35589 (CSWSH), CVE-2026-48716 (path traversal), ZDI-CAN-29369 (SSRF). https://github.com/HKUDS/nanobot/security/advisories
- **Agent Zero** — closest open analogue to the localDot UI: "Agent Zero has its own Linux desktop inside the right-side Canvas… you can take over at any time" (Xpra HTML5 over WebSocket; docs/guides/desktop.md); browser surface with per-step history screenshots and annotation mode (docs/guides/browser.md); secrets as `§§secret(name)`, injected at execution and re-masked in output (helpers/secrets.py). https://github.com/agent0ai/agent-zero
- **Moltis** — advisories 09-02: critical node-host RCE, high sandbox-session collision. https://github.com/moltis-org/moltis
- **Letta Code** — MemFS (context tracked in git), sleeptime "dreaming", crons, channels; LettaBot archived in its favour; Letta Cloud default backend. **memU** — cross-agent memory "wiki" + skill extractor (500-line core). https://github.com/letta-ai/letta-code , https://github.com/NevaMind-AI/memU
- **Gondolin** (earendil-works, 2,200 stars, Apache-2.0, 0.12.0 on 05-19, last push 07-06) — Linux micro-VM sandbox with a TypeScript control plane; **runs on Apple Silicon** (QEMU via Homebrew, or experimental libkrun with the hypervisor entitlement; "ARM64 is the most tested runtime path"); programmable HTTP/TLS egress allowlists and **secret placeholders** — "The guest only sees a placeholder token. The real secret is injected by the host only for allowed destinations"; snapshots, VFS mounts, a pi extension; no GUI. https://github.com/earendil-works/gondolin
- **Meta "Muse"** — *no open-source harness*. Muse (consumer agent, Sept 2026): per-user cloud VM with a `systemd-nspawn` cell; a **Sentinel** gateway approves every action and "replaces surrogate tokens with real credentials" at the network boundary; credentials live outside the cell (`hatch-authd`); approvals scoped per destination/use case; browser sub-agent gets an **a11y-tree snapshot, no raw DOM, no JS**; users can watch and take over. https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse (09-08). Meta admits it was "heavily inspired… by OpenClaw" (uses SOUL.md) https://techcrunch.com/2026/09/22/meta-admits-muses-likeness-to-openclaw-isnt-a-coincidence/ . Incident: synced "187,000 lines from his Messages database, despite Full Disk Access being off" https://appleinsider.com/articles/26/09/28/metas-new-ai-agent-blatantly-ignores-users-permissions . Muse Code (08-05) = proprietary terminal harness, Muse Spark only ("MCP tools bypass sandboxing") https://innfactory.ai/en/ai-harness/muse/ . Open weights: **Muse Glimmer-30B** (08-10, Apache-2.0; OSWorld-Verified 65.9 self-reported — see 3.3). Community clones: CopilotKit/openmuse (3,410 stars, MIT, AG-UI streaming; desktops "future work").

### 2.3 Closed agents with computer use (reference designs)

- **OpenAI "dots"** (launched **2026-09-29**): "always-on" agents powered by GPT-6 Astra, "they have their own cloud computer, learn from feedback over time, and can work towards your goals 24/7", 4,000+ apps via plugins, ChatGPT/Slack/Teams, explicit consent for sensitive tasks (e.g. password changes); a separate reviewer agent checks risky actions [reviewer detail from coordinator context, not verified by me]; rolling out to Pro and Business Premium. https://openai.com/index/introducing-dots/ , https://www.reuters.com/business/openai-takes-meta-with-always-on-dots-agent-enterprise-ai-push-2026-09-29/ , https://www.marktechpost.com/2026/09/29/openai-launches-dots-always-on-gpt-6-astra-agents-that-work-from-their-own-cloud-computers/ . **Naming note:** "localDot" sits right next to OpenAI's new "dots" brand — worth a trademark/positioning check before launch.
- **OpenAI Codex app → merged into ChatGPT desktop (07-09)** https://en.wikipedia.org/wiki/Codex_(AI_agent) ; computer use since 04-16 ("its own cursor", parallel agents, memory, scheduling, 90+ plugins) https://www.macrumors.com/2026/04/16/openai-codex-mac-update/ ; locked-Mac use 05-21 with a "Codex is Using Your Mac" overlay and per-app "Always allow" https://www.macrumors.com/2026/05/22/codex-use-mac-apps-when-locked/ ; limits: Windows foreground only, "can't automate terminal apps or ChatGPT itself"; GPT-6 Astra recommended for vision-heavy tasks https://learn.chatgpt.com/docs/computer-use . No documented action log/replay. Desktop app proprietary; CLI openai/codex 127,375 stars, Apache-2.0, embeddable **app-server**, `--oss` via LM Studio.
- **Claude Cowork** (launched 01-12): local sessions run code in a Virtualization.framework Linux VM; cloud sessions use a mandatory egress proxy and "Connector authorization tokens never enter the sandbox" https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview ; computer use beta on Pro/Max (not Linux); PromptArmor "Cowork exfiltrates files" (01-14) https://www.promptarmor.com/resources/claude-cowork-exfiltrates-files . **Claude Code computer use** = built-in `computer-use` MCP, interactive-only (not in `-p`), per-app tiers (browsers view-only, terminals click-only), hides other apps, one session at a time https://code.claude.com/docs/en/computer-use.md
- **Manus "My Computer"** (03-16): runs on the host, not sandboxed, Allow Once/Always approvals https://manus.im/blog/manus-my-computer-desktop . **Perplexity Personal Computer** (04-16, $200/mo): "actions are visible… auditable and reversible… kill switch" https://www.macrumors.com/2026/04/16/perplexity-personal-computer-for-mac/
- Policy: from 04-04 Claude subscription limits no longer cover third-party harnesses like OpenClaw https://news.ycombinator.com/item?id=47633396 ; Agent SDK docs: "Anthropic does not allow third party developers to offer claude.ai login or rate limits" https://code.claude.com/docs/en/agent-sdk/overview

### 2.4 Who improves on OpenClaw, and on what

- **Security:** IronClaw (WASM + host-boundary injection + leak scans), NanoClaw + OneCLI (container per session + credential gateway), ZeroClaw (OS sandboxes + tool receipts), Moltis, Agent Zero (secret aliases). Strongest *published* design is closed: Meta Muse's Sentinel.
- **Visual desktop (open source):** only Hermes (Linux hosts) and Agent Zero (Xpra); Bytebot stale. **Nobody ships a model-agnostic, action-annotated desktop view** (cursor trail, click ripples, timeline synced to the stream) — localDot's gap.
- **Setup/UX:** Hermes, nanobot, IronClaw (`onboard`), NanoClaw (hands off to Claude Code when setup fails). **Footprint:** PicoClaw, NullClaw, ZeroClaw.

### 2.5 Visual computer-use sandbox infrastructure

| Component | Desktop streaming | Action visualisation | License | Health (gh) | Apple Silicon |
|---|---|---|---|---|---|
| **Cua** (trycua/cua: cua-driver, computer-server, Lume, containers, Agent SDK) | containers expose `computer-server` (:8000); **Lume** = macOS/Linux VMs on Virtualization.framework | **cua-driver native agent cursor**: session-coloured pointer, semantic action marks, badge chips, drag trails, dotLottie themes (docs/cursor-themes.md); encrypted "Computer History" | MIT (perception extension **AGPL**) | 27,508 stars, pushed 09-29; `@trycua/cua-driver` 0.30.4 (npm, MIT) | `trycua/cua-xfce` amd64-only; `cua-ubuntu` amd64+arm64; Lume makes unattended macOS Tahoe VMs |
| **Selkies v2 + Pelorus** (linuxserver webtop) | **WebSocket + WebCodecs** (H.264…), optional WebRTC, CPU-only OK | Pelorus REST: state, screenshot, control, **a11y tree with absolute coordinates** (no auth of its own) https://docs.linuxserver.io/selkies/components/pelorus/ | MPL-2.0 / GPL-3.0 | Selkies 2,244 stars, 2.0.0 (09-23) | webtop + kasmweb images **amd64+arm64** |
| noVNC / KasmVNC / TigerVNC / Xpra | classic VNC-style web streaming | none | MPL / GPL-2.0 | noVNC 14,059 (1.7.0); KasmVNC 5,286 (1.5.0); Xpra 2,996 | — |
| **neko** (m1k1o/neko) | **WebRTC** | multi-user control hand-off | Apache-2.0 | 22,416, v3.1.6 (09-30) | arm64 [UNVERIFIED] |
| Bytebot | noVNC + REST computer-use API with coordinates | live view, takeover | Apache-2.0 | stale since 2025-09 | — |
| E2B Desktop / Surf | x11vnc + forked noVNC; stream URL with auth/view-only | Surf streams actions over SSE | Apache-2.0 | 1,500 / 869 | cloud only, amd64 |
| UI-TARS-desktop / Agent TARS + AIO Sandbox | local/remote operators; AIO Sandbox = browser + VNC + shell + MCP in one container | "Event Stream Viewer" | Apache-2.0 | 39,169; last release 2025-11; AIO Sandbox 6,043 | — |
| Agent S3 | real OS | research framework | Apache-2.0 | 12,449 | — |
| **Anthropic computer-use-demo** | Docker X11 + noVNC (:6080/:8080) | best-practices quickstart runs natively on macOS with **trajectory recording + viewer**, `computer_toolset_20260801` | MIT | 17,770 | — |
| OpenAI CUA sample app | Playwright/PyAutoGUI, code-as-action | **replay JSON + screenshot timeline** | MIT | 1,882 | no OS sandbox |
| HF Open Computer Agent | smolagents + E2B + Qwen2.5-VL | — | — | Space **paused**, last change 2025-11 | stale |

Host isolation options: **apple/container** (50,417 stars, 1.5.0 on 09-29, macOS 26; one lightweight VM per container with its own IP; GUI images [UNVERIFIED]); **Docker Sandboxes** (`sbx`, microVM per sandbox; host proxy handles all egress; "The agent sees a sentinel value instead of the real API credential"; no GUI mentioned) https://docs.docker.com/ai/sandboxes/architecture/ ; Gondolin; Lume. GPL streaming components are fine as separate processes; avoid redistributing Cua's AGPL perception extension.

### 2.6 Agent runtime options (build on vs. build our own)

| Runtime | License | Providers (incl. LM Studio) | Computer use | Tool-event streaming (for visualisation) | Health |
|---|---|---|---|---|---|
| **pi** (`@earendil-works/pi-agent-core` + `pi-ai`, 0.99.1) | MIT (verified npm) | Anthropic, OpenAI, Google, Bedrock, "Any OpenAI-compatible API: Ollama, vLLM, LM Studio"; cross-provider hand-offs | bring your own tool; provider-defined tool pass-through [UNVERIFIED] | **best:** `agent_start/end`, `turn_start/end`, `message_update` deltas, `tool_execution_start/update/end`, `beforeToolCall`/`afterToolCall` hooks, steer + follow-up queues (verified by grepping the 0.99.1 dist) | 110,657 stars; 0.x API churn; 4 CVEs on 06-08 (per sub-study) https://github.com/earendil-works/pi , https://lucumr.pocoo.org/2026/1/31/pi/ |
| **Vercel AI SDK** (`ai` 7.0.123, `@ai-sdk/anthropic` 4.0.69) | Apache-2.0 (verified npm) | 20+ providers + openai-compatible | **provider-defined tools:** Anthropic `computer_20250124/20251124` + `computerToolset_20260801` (verified in dist), OpenAI `openai.tools.computer()`, Google thin | `fullStream`: `tool-input-start/delta/end`, `tool-call`, `tool-result`, steps | 27,051 stars; daily releases |
| **Claude Agent SDK** (0.3.285) | **Proprietary**: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements" (verified LICENSE.md) | Claude only (Anthropic/Bedrock/Vertex/Foundry) | bring your own via MCP (built-in CU is interactive-only) | 12 hook events; partial stream events | active |
| **OpenAI Agents SDK** (`@openai/agents` 0.18.0) | MIT | LiteLLM, any-llm, custom base_url | `ComputerTool` — **OpenAI models only** | item-level events; tool args don't stream | Python 29,784 / JS 3,881 stars |
| **Codex app-server** | Apache-2.0 | OpenAI + LM Studio/Ollama via `--oss` | via MCP | JSON-RPC thread/turn notifications; sandboxing + network proxy built in | openai/codex 127,375 stars (OpenClaw's `codex` runtime) |
| **Cua Agent SDK** (`cua-agent` 0.8.4, Python) | MIT | LiteLLM | **~20 model-specific loops**: Claude, gpt-5.4, Gemini 2.5/3.x CU, UI-TARS 1.5/2, OpenCUA, GLM-4.5V, Holo1.5, Qwen3-VL/3.5, Fara, InternVL, GTA1…; `grounder+planner` composition; MLX extra | callbacks: trajectory saver, OTel, budget, PII anonymisation | in trycua/cua |
| Mastra | Apache-2.0 (except ee/) | 212 providers incl. `lmstudio/…` | via AI SDK [UNVERIFIED] | yes | 28,451 stars |
| LangGraph / Pydantic AI / Google ADK | MIT / MIT / Apache-2.0 | broad / broad / Gemini-first | separate repo / none / Gemini-only `ComputerUseToolset` | yes | 42,512 / 20,286 / 21,686 stars |
| **AG-UI protocol** (UI transport, not a runtime) | MIT | — | — | standard agent→frontend event stream | 16,125 stars |

---

## 3. TASK 3 — The computer-use "brain" (models, benchmarks, harness patterns, coordinates)

Tags: **[2nd]** = secondary report citing the vendor (openai.com returned HTTP 403 to our fetcher, so all OpenAI numbers are [2nd]); **[UNVERIFIED]**; **[EST]** = estimate. Independently re-checked by me on 2026-09-30: the official OSWorld-Verified spreadsheet (parsed locally — top rows match the table in 3.2), the Qwen3.8-27B model card, and the Claude computer-use tool doc.

### 3.0 Headline findings

1. **OSWorld-Verified is saturated at the top.** Official best: Intelligence-Indeed Agent (harness on Claude Opus 4.7) **90.19%** (2026-07-25); best plain models `claude-fable-5` **85.96%** and `claude-opus-5` **83.39%** (both dated 2026-08-01); human ≈72.36%. https://osworld-v1.xlang.ai/static/data/osworld_verified_results.xlsx (linked from https://os-world.github.io/). Discriminative benchmark now = **OSWorld 2.0/2.1** (108 long workflows, ~1.6 human-hours, ~318 tool calls each), where frontier *strict* success is only ~13–44%. https://arxiv.org/abs/2606.29537 , https://github.com/xlang-ai/OSWorld-V2 , https://snorkel.ai/leaderboard/os-world-2-0/
2. **Frontier cloud models ground natively** (emit coordinates themselves) — no separate grounder needed; zoom/crop refinement still helps.
3. **Open weights caught up on short tasks, not long ones.** Qwen3.8-27B (Apache-2.0, already in the user's LM Studio) self-reports **84.3%** OSWorld-Verified; Holo3-35B-A3B is **officially verified 82.56%**. On OSWorld 2.0 most small models collapse to ~0–3% strict; Qwen3.8-27B self-reports 19.4% strict / 48.0% partial.
4. **Winning harnesses** = native screenshot loop + mixed GUI/code/shell actions + batching + external task state/verifier + skills with read-only probing (+ optional best-of-N). Every top agentic entry has "coding-based action = Yes"; none uses the accessibility tree.
5. **Every serious API returns drawable coordinates**, but in different spaces (screenshot px, 0–999, 0–1000, smart-resized px) → localDot needs one normalisation layer.

### 3.1 Cloud models (as of 2026-09-30)

| Model (vendor, date) | Scope | Key scores (source, date) | API / coordinates | Price in/out per MTok |
|---|---|---|---|---|
| **Claude Fable 5** (2026-06-09); Fable 5.1 (Sep 2026) | desktop + browser | OSWorld-Verified **85.96%** official; Fable 5.1 OSWorld 2.1 partial **80.7%** (Anthropic, 2026-09-22) | `computer_toolset_20260801` | $10/$50 https://www.anthropic.com/news/claude-fable-5-mythos-5 |
| **Claude Opus 5.5** (2026-09-22) `claude-opus-5-5` | desktop | OSWorld 2.1 partial **81.8%** (Opus 5: 74.0%) https://www.anthropic.com/claude-opus-5-5 | same | $4/$20 |
| **Claude Sonnet 5.5** (2026-09-28) `claude-sonnet-5-5` | desktop | OSWorld 2.1 partial **80.1%** (Sonnet 5: 57.0%) [2nd: MarkTechPost 2026-09-28] | same | $2/$10 https://www.anthropic.com/claude/sonnet |
| Claude Opus 5 (2026-07-24) | desktop | Verified **83.39%**; Snorkel OSWorld 2.0 **44.33% strict / 77.67% partial** (max effort, 500 steps) https://snorkel.ai/leaderboard/os-world-2-0/ | same | $5/$25 |
| Claude Opus 4.8 (2026-05-28) | desktop | Verified 83.4 (as cited in Kimi K3/UI-Venus-2 cards); OSWorld 2.0 paper 20.6% strict / 54.8% batched https://arxiv.org/abs/2606.29537 | | $5/$25 |
| Claude Opus 4.7 / Sonnet 4.6 | desktop | Sonnet 4.6 official verified 72.11% (2026-03-08) | `computer_20251124` (beta) | |
| **GPT-5.4** (2026-03-05) | desktop + browser | Verified 75.0% (vendor) — first "native computer use" GPT [2nd] | Responses `computer` tool | |
| GPT-5.5 (2026-04-23) | desktop + browser | 78.7% [2nd]; OSWorld 2.0 paper 13.0% / 49.5% | same | |
| GPT-5.6 Sol (Jul 2026) | desktop | ~83.0–83.2 [2nd]; Snorkel OSWorld 2.0 27.34% / 62.72% | same | |
| **GPT-6 Astra** (2026-09-03/04) | desktop + browser | OSWorld 2.0 offline ~72.6–73.5% partial; ScreenSpot-Pro **92.7%** [2nd: DataCamp/Vellum/MindStudio] | `computer` tool: `computer_call` with ordered `actions[]` batch, pixel x,y, `detail:"original"`, code-execution alternative https://developers.openai.com/api/docs/guides/tools-computer-use | $10/$50 |
| **GPT-6.1 Sol** (2026-09-29); GPT-6 Sol/Luna (09-22) | desktop + browser (hosted-browser CU added to Agents API 2026-09-29) | 6.1 Sol OSWorld 2.0 offline 71.4% (max) [2nd] | same https://developers.openai.com/api/docs/changelog | $2/$10 |
| **Gemini 3.6 Flash** (2026-07-21) | browser, desktop, mobile | Verified **83.0%** (vendor); 3.5 Flash 78.4, 3.5 Flash-Lite 74.0, 3 Flash 65.1 https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-6-flash-3-5-flash-lite-3-5-flash-cyber/ | built-in `computer_use` tool, `environment` browser/desktop/mobile, **0–999 grid**, `safety_decision: require_confirmation`; still "Preview" https://ai.google.dev/gemini-api/docs/computer-use | $1.50/$7.50 (Flash-Lite $0.30/$2.50) |
| Qwen3.8-Max (2026-08-03, 2.4T-A95B) | desktop | 86.1 self-reported [2nd: DataCamp] — not local | 0–1000 | |
| Qwen3.7-Plus (API) | desktop | Verified 73.30% (2026-05-25); OSWorld 2.0 2.8% / 21.5% | | |
| Meta Muse Spark 1.1 (API) | desktop | Verified **80.67%** (2026-07-09) | | |
| Kimi K3 (Jun 2026) / K2.6 | desktop | K3 84.8 self-reported https://huggingface.co/moonshotai/Kimi-K3 ; K2.6 verified 73.06% | | |
| MiniMax M3 (open weights, huge) | desktop | Verified 75.19%; OSWorld 2.0 4.6% / 22.3% | | |
| Holo3-122B-A10B (API only) | desktop | 78.85% https://hcompany.ai/holo3 | | |
| ByteDance UI-TARS-2-2509 / Seed-1.8 | desktop | Verified 53.1% / 61.87%; UI-TARS-2 **weights never released** | | |
| Simular **Sai** (hosted, 2026-08-28) | desktop | OSWorld 2.0 **73.0% partial / 28.25% binary**, $15.70/task https://www.simular.ai/articles/sai-tops-osworld-2-0 | | |
| xAI Grok Bot (2026-08-11) | cloud virtual-computer product | no public CU API or OSWorld numbers [UNVERIFIED] | | |
| Amazon Nova Act | browser workflows only | no OSWorld claims found | | |

**Claude computer-use tool (verified from docs):** `computer_toolset_20260801` is GA on the Claude API/Google Cloud for Fable 5/5.1, Mythos 5/5.1, Opus 5/5.5, Sonnet 5/5.5 ("Claude 5.5 and later models support computer use only through the `computer_toolset_20260801` toolset"); `computer_20251124` remains beta for Opus 4.5–4.7/Sonnet 4.6. 17 members: `screenshot`, `zoom{region}`, left/right/middle/double/triple click (+modifier `text`), `left_click_drag{start_coordinate,coordinate}`, `mouse_move`, `left_mouse_down/up`, `cursor_position`, `scroll{scroll_direction,scroll_amount,coordinate?}`, `type`, `key{repeat}`, `hold_key{duration}`, `wait`. "Coordinates are in screenshot pixels… after a `zoom`, Claude still expresses coordinates in the full screenshot's space"; `display_width_px/height_px` are rejected; "If you scale screenshots down before returning them, scale Claude's coordinates back up". Limits: 2576 px long edge / ~3.75 MP (4784 visual tokens) for 4.7+/toolset models; 1568 px / ~1.15 MP earlier. Recommended "1024x768 or 1280x720 [desktop]; … 1280x800 or 1366x768 [web]. Avoid resolutions above 1920x1080". **Batch actions**: run in order, stop at first failure, return halt text for skipped actions, include `toolset_name:"computer"`; keep ≤20 images per request. https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool

### 3.2 Official OSWorld-Verified top entries (spreadsheet parsed 2026-09-30)

| % | Entry | Type | Steps | Code actions | a11y tree | Rollouts | Date |
|---|---|---|---|---|---|---|---|
| 90.19 | Intelligence-Indeed Agent (core claude-opus-4-7) | agentic | 100 | Yes | No | 1 | 2026-07-25 |
| 85.96 | claude-fable-5 | model | 100 | No | No | 1 | 2026-08-01 |
| 83.64 | Pointer Agent w/ Opus 4.7 | agentic | 100 | Yes | No | 1 | 2026-05-21 |
| 83.39 | claude-opus-5 | model | 100 | No | No | 1 | 2026-08-01 |
| 82.81 | Coasty CUA v1 | model | 100 | Yes | No | 1 | 2026-07-01 |
| **82.56** | **Holo3-35B-A3B (open, Apache-2.0)** | specialized | 100 | No | No | 1 | 2026-04-20 |
| 80.67 | Muse Spark 1.1 (Meta) | model | 100 | No | No | 1 | 2026-07-09 |
| 78.34 | OpenAPA w/ gemini-3.1-pro | agentic | 100 | Yes | No | 1 | 2026-04-17 |
| 75.19 | MiniMax M3 | model | 100 | No | No | 1 | 2026-06-08 |
| 73.30 | Qwen 3.7 Plus | model | 100 | No | No | 1 | 2026-05-25 |
| 73.06 | Kimi K2.6 | model | 100 | No | No | 1 | 2026-04-20 |
| 72.58 | Agent S3 w/ Opus 4.5 + GPT-5, bBoN N=10 | agentic | 100 | Yes | No | 10 | 2025-12-11 |
| 72.11 | claude-sonnet-4-6 | model | 100 | No | No | 1 | 2026-03-08 |
| 65.77 | OS-Symphony w/ GPT-5 | agentic | 50 | Yes | No | 1 | 2026-01-04 |
| 63.41 | GTA1 w/ GPT-5 (planner+grounder) | agentic | 100 | Yes | No | 1 | 2025-10-03 |
| 56.73 | EvoCUA-20260105 | model | 50 | No | No | 1 | 2026-01-06 |
| 55.44 | GUI-Owl-1.5 32B | specialized | 50 | No | No | 1 | 2026-03-27 |
| 53.10 | UI-TARS-2-2509 | specialized | 100 | No | No | 1 | 2025-10-14 |
| 46.10 | opencua-72b-preview | specialized | 100 | No | No | 1 | 2025-10-01 |
| 41.57 | qwen3-vl-flash-2025-10-25 | model | 100 | No | No | 1 | 2025-10-23 |
| 29.60 | uitars-1.5-7b | specialized | 100 | No | No | 1 | 2025-07-28 |

Architecture of the 90.19% entry: static on-demand skills + "dynamic skills" from read-only environment probes and web research, feeding multi-agent plan-and-execute https://github.com/intelligence-indeed/intelligence-indeed . GPT-5.x/6.x, Gemini 3.x, Qwen3.8, Holo3.1, Fable 5.1, Opus/Sonnet 5.5 are **self-reported only** (not on the verified board). Caveats: vendors re-scored their own models (Opus 4.7 78.0→82.3; Sonnet 4.6 72.5→78.5); an audit found **15.3% of FAIL verdicts wrong** (10.7% evaluator false negatives, 4.7% broken tasks) https://arxiv.org/abs/2607.28367 . Decide on OSWorld 2.0/2.1 + our own task suite.

### 3.3 Local models for the 96 GB M3 Ultra (LM Studio / MLX)

User already has (`lms ls`): `qwen/qwen3.8-27b` (17.7 GB), `google/gemma-4-26b-a4b-qat` (15.6 GB), a Qwen3.6-35B-A3B fine-tune (44.5 GB), a Qwen3.8-27B-MTP fine-tune (26.9 GB). User note: never co-load another big model with the 44.5 GB one (swap crash 2026-08-10). Practical model budget ≈60 GB after macOS + Docker + the VM [EST].

| Model | Params / license | Role | OSWorld-Verified | Other | MLX/GGUF | Fit / speed |
|---|---|---|---|---|---|---|
| **Qwen3.8-27B** (2026-08-05) | dense 27B, **Apache-2.0**, native vision, thinking default | **full agent (plan + ground)** | **84.3** self-reported (card: vs Qwen3.6-27B 63.9, Qwen3.7-Plus 73.3, Muse Glimmer-30B 65.9, Opus 4.6 Max 72.7) https://huggingface.co/Qwen/Qwen3.8-27B | AndroidWorld 81.9; WebArena-Verified 64.8; OSWorld 2.0 **19.4 / 48.0** (table in https://huggingface.co/Qwen/Qwen3.8-Flash-Next) | mlx-community 4-bit (~16 GB), 8-bit, bf16, MTP; GGUF installed | fits; ~31 tok/s @8K, ~20 @128K [2nd: https://news.ycombinator.com/item?id=49787783]; ~8–30 s/step with thinking [EST] |
| **Holo3-35B-A3B / Holo-3.1-35B-A3B** (03-31 / 06-02) | 3B-active MoE (Qwen3.5-35B-A3B base), Apache-2.0 | fast agent or grounder | Holo3 **82.56 official**; Holo3.1 80.0 BF16 (~77.8 FP8/NVFP4) https://hcompany.ai/holo3.1 | AndroidWorld 79.3 | Holo3 MLX 8-bit (~41 GB); Holo3.1 Q4 GGUF | fits; ~60–90 tok/s [EST] |
| Muse Glimmer-30B (Meta, Aug 2026) | 29.6B dense, Apache-2.0 | agent (stronger at tools) | 65.9 https://huggingface.co/meta-models/Muse-Glimmer-30B | ScreenSpot-Pro 75.4 | MLX/GGUF | trails Qwen3.8 |
| Qwen3.6-27B / 35B-A3B (Apr 2026) | Apache-2.0 | agent | conflicting 62.0–75.6 across cards | SS-Pro 65.2–76.1 | MLX | superseded |
| Qwen3.5-122B-A10B / 27B / 35B-A3B (Feb 2026) | Apache-2.0 | agent | 58.0 / 56.2 / 54.5 https://huggingface.co/Qwen/Qwen3.5-122B-A10B | SS-Pro 70.4 / 70.3 / 68.6 | 122B 4-bit ≈69.6 GB (too tight) | superseded |
| Gemma 4 31B / 26B-A4B (2026-07-02) | Apache-2.0 | weak GUI agent | 31B 58.5 (third-party) | SS-Pro 75.9 (third-party) | MLX | not a brain |
| UI-Venus-2-9B (2026-08-26) | Qwen3.5-9B base, **license pending** | agent/grounder | 70.8 (27B 80.5, weights not public) | SS-Pro 73.0; OSWorld 2.0 0.0 strict | — | wait |
| Fara1.5-4B/9B/27B (Microsoft) | MIT | **browser-only** agent | — | Online-Mind2Web 63.4 / 72.3 (9B/27B) https://github.com/microsoft/fara | MLX 4-bit | optional web specialist |
| GUI-Owl-1.5 / MAI-UI / UI-TARS-1.5-7B / OpenCUA / GTA1 / Jedi | various open | legacy agents/grounders | 29.6 (UI-TARS-1.5-7B) … 55.44 (GUI-Owl-1.5-32B) | GTA1-32B SS-Pro 63.6 | mostly no MLX | obsolete as brains |
| Qwen3.8-Flash-Next (125B total / 6B active) | — | agent | — | AndroidWorld 84.5; OSWorld 2.0 19.4 / 52.3 | ≈88 GB+ at 4-bit [EST] | does not fit |
| GLM-4.6V / 4.6V-Flash | MIT | — | no GUI benchmarks on card | — | — | skip |

**ScreenSpot-Pro grounding leaderboard** (updated 2026-09-10; no frontier API entries): Indeed-UI-32B + zoom **82.7**; Indeed-UI-8B + zoom 81.0 (73.4 without); KV-Ground-8B + Qwen3.5-27B router 80.9; Holo2-235B-A22B 78.5; MAI-UI-32B 77.5; Holo2-30B-A3B 75.2; UI-Venus-1.5-30B-A3B 69.6; GTA1-32B 63.6; UI-TARS-1.5 61.6. Zoom refinement ≈ +7–9 points. https://gui-agent.github.io/grounding-leaderboard/ , https://github.com/GUI-Agent/grounding-leaderboard

**Verdict (local):** Qwen3.8-27B = best local brain (one Apache-2.0 model, already installed, the only small model with meaningful OSWorld 2.0 numbers); Holo3/3.1-35B-A3B = best fast grounder/executor; 2025-era dedicated grounders (UI-TARS-1.5, OpenCUA, GTA1, Jedi) are now dominated; Gemma 4 26B-A4B is not a computer-use pick.

### 3.4 Harness patterns — what the evidence says

- **Native screenshot → action loop** is now top-tier by itself (Fable 5 85.96, Opus 5 83.39, Holo3 82.56) → localDot's default loop.
- **Set-of-Marks / accessibility tree:** helped weak 2024 models (GPT-4V 5.26% screenshot-only → 12.17% with a11y tree, 11.77% with SoM; effectiveness "varies by models") https://arxiv.org/abs/2404.07972 ; no 2025–26 top entry uses them. Keep AT-SPI (Linux) / AX (macOS) anyway for overlay labels, click snapping, local fallback, text extraction.
- **Hybrid GUI + code/shell/API actions:** every top agentic entry uses code actions; CoAct-1 60.76 with ~10 vs ~15 steps; in OSWorld 2.0 terminal commands are 24.7% of low-level actions; UFO²/UFO³ and Qwen-UI-Agent follow the same idea. Expose shell/code/MCP and render them as cards.
- **MCP tools:** help but are under-used — OSWorld-MCP: Claude 4 Sonnet 38.9 → 45.0 (50 steps), tool invocation ≤36.6% https://arxiv.org/abs/2510.24563 , https://osworld-mcp.github.io/ ; keep GUI as fallback.
- **Planner + grounder split** (Agent S2/S3, GTA1 w/ GPT-5 63.41, Jedi-7B w/ o3 51.0): mattered in 2025; now only worth it for local/cheap brains. https://github.com/simular-ai/Agent-S
- **Batched actions:** ~+2 strict points on OSWorld 2.0 and Opus 4.8 steps 190.5 → 103.
- **Behaviour best-of-N (bBoN):** Agent S3 66.5 → 72.58 at N=10 for ~N× cost https://arxiv.org/abs/2510.02250 — background runs only.
- **External task state + auditor/verifier:** LongHorizon-Harness Opus 20.0% → 34.3% on an OSWorld 2.0 subset https://arxiv.org/abs/2608.01964 ; agents spend <7% of budget on recovery and fail on hidden state, mid-task info, guessing instead of asking, skipped verification.
- **Skills + read-only probing:** the 90.19% recipe.
- **Stale screens:** streaming UIs cause stale coordinates → freshness check (compare live frame vs the frame the model saw around the target) before clicking.

### 3.5 Coordinates for the cursor overlay

| Source | Output space | → normalised 0–1 | Notes |
|---|---|---|---|
| Claude | pixels of the screenshot you sent | x / screenshotWidth | scale back if downscaled; zoom keeps full-screenshot coords; Retina = 2× DPR |
| OpenAI `computer` | pixels inside `actions[]` | x / screenshotWidth | use `detail:"original"` |
| Gemini | 0–999 grid | x / 1000 | "actual = value / 1000 × dimension" https://ai.google.dev/gemini-api/docs/computer-use |
| Qwen3-VL / Qwen3.5–3.8 / Holo2–3 | relative 0–1000 | x / 1000 | confirmed in Qwen3-VL computer-use cookbook (declares a 1000×1000 display) https://github.com/QwenLM/Qwen3-VL/blob/main/cookbooks/computer_use.ipynb and Holo2 cookbook; **assumed** for Qwen3.8/Holo3 — verify with a probe image |
| UI-TARS-1.5 / Qwen2.5-VL | pixels in the smart-resized image (factor 28) | x / resizedWidth | must reproduce `smart_resize` exactly https://github.com/bytedance/UI-TARS/blob/main/README_coordinates.md |
| OpenClaw `computer` tool | integer px of last screenshot + `frameId`; CUA backend = image pixels, Peekaboo = global logical points | per backend | https://docs.openclaw.ai/nodes/computer-use |

Pitfalls: VM framebuffer vs web-canvas scaling; `smart_resize` rounding; stale frames; keyboard actions have no coordinates (draw at caret/a11y focus); drags are paths; clamp to [0,1); force JSON-schema output from local models. **Recommended VM resolution: 1280×800 @1× DPI** — within even old Claude limits (1:1 mapping for Claude/OpenAI), divisible by 32 for the Qwen3.5+ family (~1,000 visual tokens), ~1,334 Claude visual tokens per screenshot.

**Relevant repo health (gh, 2026-09-30):** bytedance/UI-TARS-desktop 39.2k (Apache, pushed 09-24); trycua/cua 27.5k (MIT, 09-29); simular-ai/Agent-S 12.4k (Apache, 09-05); microsoft/magentic-ui 10.1k (MIT, 09-23); microsoft/UFO 9.9k (MIT, 09-29); microsoft/fara 6.2k (MIT, 09-22); xlang-ai/OSWorld 3.2k (Apache, 09-14); xlang-ai/OpenCUA 0.85k (MIT, 05-25).

---

## 4. Recommendations for localDot

### 4.1 Keep from OpenClaw (proven, loved, cheap to copy)

| Keep | Why | OpenClaw reference |
|---|---|---|
| **Gateway hub + one typed WebSocket event protocol** (req/res + streamed `agent`/`chat`/`tool` events keyed by `runId`; non-blocking send) | Every surface (web UI, avatar, phone, chat channel) renders the same event stream — the backbone of visualisation | https://docs.openclaw.ai/concepts/architecture |
| **Markdown-first persona + memory** (`SOUL.md`, `USER.md`, `MEMORY.md`, daily notes, `HEARTBEAT.md`) + SQLite hybrid search | Most-loved property ("no lock-in", switch models freely); human-auditable | https://docs.openclaw.ai/concepts/memory |
| **Heartbeat vs cron split** with announce delivery | Proactivity is the "killer feature" | https://docs.openclaw.ai/automation |
| **Chat channels as plugins**, DM `pairing`/allowlist by default, per-channel-peer sessions | Phone-first control; secure default | https://docs.openclaw.ai/channels/pairing |
| **SKILL.md skills** (AgentSkills-compatible) + a **proposal → review → apply** workflow (Skill Workshop) | Self-extension users love, with a human gate | https://docs.openclaw.ai/tools/skill-workshop |
| **`computer` tool semantics**: one action per call, coordinates in last-screenshot pixels, **echo `frameId`**, fail closed on geometry change, recording/replay actions | Makes every action attributable to an exact frame → perfect for overlays and replay | https://docs.openclaw.ai/nodes/computer-use |
| **Trajectory "flight recorder"** on by default, exportable + redacted | Debuggability; replay source | https://docs.openclaw.ai/tools/trajectory |
| **Provider plugins + auth profiles + failover; model-scoped runtime policy** (incl. optional external harnesses via ACP: Claude Code, Codex) | Provider-agnostic without lowest-common-denominator | https://docs.openclaw.ai/concepts/agent-runtimes |
| **`doctor` migrations + `security audit`**, device pairing for non-loopback clients | Operability; safe upgrades | https://docs.openclaw.ai/gateway/doctor |
| **Secret egress sentinel idea** (placeholder in agent env, substituted only toward bound hosts) | Right primitive — but move it out of process (4.2) | https://docs.openclaw.ai/gateway/secrets/secret-store-and-egress |

### 4.2 Change (where localDot should be structurally better)

1. **Isolation is the product, not an option.** OpenClaw's sandbox is off by default and the Gateway itself is never sandboxed; tools run on the host unless configured. localDot: the agent's hands exist *only* inside the virtual computer (container/VM); the host runs only the orchestrator, UI and key broker; no "elevated" escape hatch in v1. https://docs.openclaw.ai/gateway/sandboxing
2. **Out-of-process key layer with network enforcement** (4.5). OpenClaw's egress proxy lives in the Gateway process, is off by default, stores secrets unencrypted, covers only Gateway-hosted exec and can be bypassed by raw sockets. localDot: separate broker process; VM has *no route* to the internet except through it; secrets encrypted at rest (macOS Keychain); model API keys never enter the VM at all (the brain runs host-side). https://docs.openclaw.ai/gateway/secrets/secret-store-and-egress
3. **Visualisation-first UX instead of text cards.** A local, always-available desktop stream with a synchronised action layer (4.6), not a lab-gated cloud VNC panel with model-only screenshots.
4. **Local-first desktop.** No cloud lease needed: Linux arm64 desktop container on Docker Desktop (default) and optionally a macOS VM (Lume/Apple Virtualization) for Mac-only apps (see section 2).
5. **Smaller, curated surface.** 2–3 channels (web + Telegram, later WhatsApp/iMessage), curated signed skills with declared permissions, no open marketplace at launch (ClawHub malware history).
6. **Web-first onboarding that still shows the security decisions** (one `docker compose up` or a signed .app; loopback-only by default; explicit toggles for channels/keys) — fixes "messy install / Node-version churn" while respecting OpenClaw's "don't hide security decisions" principle.
7. **Prompt-injection posture:** content provenance/taint (text read from the web/desktop can't directly authorise key use toward a *new* host), approval gates for irreversible actions (send, pay, delete, post), pinned user constraints that survive compaction, working kill switch from every surface, link-unfurl sanitisation.
8. **Memory hygiene:** every write to persona/memory/heartbeat files is an event with a visible diff and optional approval (SOUL/HEARTBEAT persistence attacks).
9. **Cost guardrails:** per-run and per-day token/$ caps shown live in the UI; cheap pre-check before any heartbeat LLM call (OpenClaw heartbeat burn complaints).

### 4.3 Runtime: build a thin loop we own, on Vercel AI SDK v7, with pi's event contract

**Decision:** write localDot's own small TypeScript agent loop (orchestrator + a dedicated computer-use worker), use **Vercel AI SDK v7** (`ai` 7.0.123, Apache-2.0) as the provider layer, and copy **pi-agent-core's event contract and hooks** (`agent_start/end`, `turn_start/end`, `message_update`, `tool_execution_start/update/end`, `beforeToolCall`/`afterToolCall`, steer + follow-up queues). Put Cua on the computer side.

Why:
- **Provider-agnostic *and* keeps the trained computer-use tools.** `@ai-sdk/anthropic` 4.0.69 already ships `computer_toolset_20260801` (plus 20251124/20250124), OpenAI's `computer` tool is exposed too, and LM Studio works through the OpenAI-compatible provider [verified in the npm dist]. pi-ai supports LM Studio but pass-through of provider-defined computer tools is unverified.
- **We need to own the event contract**, because the visualisation *is* the product. OpenClaw reached the same conclusion: it ran on pi from Nov 2025 and internalised the loop on 2026-05-27 (#85341).
- **Claude Agent SDK is proprietary and Claude-only** ("© Anthropic PBC. All rights reserved"), and its built-in computer use is interactive-only. **OpenAI Agents SDK's `ComputerTool` works only with OpenAI models.** Both are fine as optional *external harness adapters* (ACP / Codex app-server), the way OpenClaw offers `claude-cli`/`codex`, but not as the core.
- **Fallback if we want a head start:** adopt `@earendil-works/pi-agent-core` + `pi-ai` 0.99.1 (MIT) directly for the orchestrator and budget for 0.x churn. The CU worker still uses AI SDK adapters.

Shape:
- `brain` (host process): orchestrator loop (chat, memory, skills, cron/heartbeat, channels) that delegates GUI work to a **computer-use worker loop** through a `use_computer(task)` tool. That keeps screenshots out of the main context and lets the CU worker run on a different (cheaper or local) model.
- `computer` (container/VM): arm64 **linuxserver webtop (XFCE) with Selkies v2** streaming, plus **cua-driver / computer-server** for input, screenshots and recording, plus **Pelorus/AT-SPI** for the a11y tree with coordinates. Optional **Lume** macOS VM later for Mac-only apps.
- For experimenting with many local GUI models, run the **Cua Agent SDK** (Python, MIT, ~20 model loops, planner+grounder composition) as an optional sidecar instead of re-implementing each model's coordinate format.
- UI transport: one authenticated WebSocket carrying an **AG-UI-compatible** event schema (OpenClaw-style `runId`/`req`/`res`/`event` framing); the avatar, timeline, overlay and chat channels all subscribe to it.
- Borrow freely: OpenClaw's gateway protocol and `computer` tool/`frameId` semantics; Hermes' RFB input gate + takeover lease; Agent Zero's desktop/browser canvas + per-step screenshots; the OpenAI CUA sample's replay JSON + screenshot timeline; Claude Code's per-app approval tiers; a Hermes-style `~/.openclaw` importer (SOUL/USER/MEMORY/skills/cron) for migration.

### 4.4 Model setup (default cloud + local fallback, provider-agnostic)

| Role | Default | Escalation / alternates | Local fallback (M3 Ultra 96 GB) |
|---|---|---|---|
| Computer-use brain | **Claude Sonnet 5.5** (`claude-sonnet-5-5`, `computer_toolset_20260801`, $2/$10 per MTok; OSWorld 2.1 partial 80.1% [2nd]) | **Claude Opus 5.5** ($4/$20; 81.8%) for long tasks or after verifier failures; swap-ins GPT-6.1 Sol (Responses `computer`, $2/$10 [2nd]) and Gemini 3.6 Flash (`computer_use`, 83.0% vendor-reported, preview) | **Qwen3.8-27B** via LM Studio (Apache-2.0, installed; MLX 4-bit ≈16 GB; 84.3% self-reported OSWorld-Verified; OSWorld 2.0 19.4 strict / 48.0 partial). Thinking on to plan, off for grounding calls |
| Grounder (only when needed) | none (frontier models ground natively; use `zoom` on dense UIs) | — | **Holo-3.1-35B-A3B** Q4 (≈20 GB [EST]; Holo3 82.56% *verified*) when Qwen's confidence is low or the target is tiny |
| Orchestrator / chat / memory | same Claude model (or Sonnet for chat, Opus for planning) | GPT-6.x / Gemini 3.x through the same adapter | Qwen3.8-27B (same loaded weights) |
| Verifier / auditor | Gemini 3.5 Flash-Lite ($0.30/$2.50) or Claude Haiku-class [EST pricing] | — | Qwen3.8-27B without thinking |
| Web-only specialist (optional) | — | — | Fara1.5-9B (MIT, browser-only) |

- **Memory budget:** keep local models ≤ ~60 GB total (Qwen3.8-27B + Holo-3.1 Q4 ≈ 36 GB [EST]) and never co-load the 44.5 GB Qwen3.6 fine-tune (it caused the 2026-08-10 swap crash).
- **Harness defaults:** native screenshot loop; **batched actions** (stop at first failure); mixed GUI + shell/code/MCP actions rendered as cards; external task state + verifier each subtask; skills with read-only probing; `ask_user` as a first-class action; best-of-N only for background jobs; a freshness check before each click; **VM at 1280×800 @1×** (1:1 coordinates for Claude/OpenAI; divisible by 32 for Qwen).
- **Auth:** API keys held by `keyd`, not subscription OAuth/setup-tokens (Anthropic policy churn; Google account restrictions).
- **Evaluate** on OSWorld 2.0/2.1 slices plus a localDot task suite (the OSWorld-Verified audit found 15.3% of FAIL verdicts wrong).

**Provider-agnostic interface (sketch):**

```ts
type Norm = { x: number; y: number };                 // 0..1 of the VM framebuffer
type CoordSpace =
  | { kind: "pixels"; w: number; h: number }          // Claude, OpenAI (screenshot px)
  | { kind: "per1000" }                                // Gemini 0–999 grid, Qwen3.x/Holo relative 0–1000
  | { kind: "resizedPixels"; w: number; h: number };  // UI-TARS-1.5 / Qwen2.5-VL smart_resize

type Action =
  | { kind: "click"; at: Norm; button?: "left" | "right" | "middle"; count?: 1 | 2 | 3; mods?: string[] }
  | { kind: "move"; at: Norm }
  | { kind: "drag"; path: Norm[]; mods?: string[] }
  | { kind: "scroll"; at?: Norm; dx: number; dy: number }
  | { kind: "type"; text: string }                     // secrets appear only as {{ld:name}} placeholders
  | { kind: "key"; combo: string; repeat?: number }
  | { kind: "holdKey"; combo: string; ms: number }
  | { kind: "mouseDown" } | { kind: "mouseUp" }
  | { kind: "wait"; ms: number } | { kind: "screenshot" }
  | { kind: "zoom"; region: [Norm, Norm] }
  | { kind: "shell"; cmd: string } | { kind: "code"; lang: "python" | "js"; src: string }
  | { kind: "mcp"; server: string; tool: string; args: unknown }
  | { kind: "askUser"; question: string }
  | { kind: "done"; ok: boolean; summary: string };

interface ActionEnvelope {
  id: string; runId: string; stepId: string;
  frameId: string;                                    // exact screenshot the model saw
  action: Action;
  intent?: string; rationale?: string; confidence?: number;
  risk?: "low" | "confirm" | "block";
  target?: { role?: string; name?: string; bbox?: [Norm, Norm]; source: "model" | "grounder" | "a11y" };
  provenance: { provider: string; model: string; coordSpace: CoordSpace; raw: unknown };
}

interface Brain {
  id: string;
  caps: { nativeComputerUse: boolean; batch: boolean; zoom: boolean; code: boolean; maxImagePx: number };
  step(ctx: StepContext): AsyncIterable<{ thought?: string; actions?: ActionEnvelope[] }>;
}
interface Grounder {
  locate(frameId: string, png: Uint8Array, instruction: string): Promise<{ at: Norm; bbox?: [Norm, Norm]; confidence?: number }>;
}

const toNorm = (x: number, y: number, s: CoordSpace): Norm =>
  s.kind === "per1000" ? { x: x / 1000, y: y / 1000 } : { x: x / s.w, y: y / s.h };
```

Both Gemini ("value / 1000 × dimension") and Qwen3-VL-style models divide by 1000. For `pixels`, `w`/`h` are the dimensions of the screenshot actually sent (after any downscale); for `resizedPixels`, they are the `smart_resize` output. The executor rounds and clamps `Norm` to VM pixels. The overlay draws the intent marker on the *frame the model saw* (`frameId`), then animates the live cursor; if the live frame differs around the target, it re-screenshots instead of clicking. Each adapter keeps `raw` so the timeline can show exactly what the model emitted.

### 4.5 Key layer design ("the bot never holds usable secrets")

- **Topology:** `localdot-brain` (orchestrator + model calls, host side) ⟷ `localdot-keyd` (secret broker + egress proxy, host side, separate process/container) ⟷ `localdot-computer` (desktop VM/container with *no* direct egress). Docker: put the computer on an `internal: true` network whose only peer is `keyd`; the proxy is the only dual-homed service, so raw sockets from the VM simply have no route (closes OpenClaw's "subprocess can ignore proxy variables" gap). https://docs.docker.com/reference/compose-file/networks/#internal
- **Secrets at rest:** macOS Keychain (or an age-encrypted file whose key lives in Keychain); never in any file the VM can read; never in chat (masked input only, as OpenClaw's `secrets` tool does).
- **Use without possession:** the VM sees placeholders (`{{ld:github}}`) or sealed tokens; `keyd` terminates TLS (CA trusted only inside the VM), substitutes only for **exact bound hosts** + optional method/path scopes, and scrubs exact secret values from responses (reflection defence, IronClaw-style request/response leak scans).
- **Prior art to borrow from (best first):**
  - **OneCLI** (Apache-2.0, 3,532 stars, v2.6.0): the closest open implementation. A Rust MITM HTTPS gateway that injects credentials matched by host+path via `Proxy-Authorization` tokens; Bitwarden/1Password backends; used by NanoClaw. https://github.com/onecli/onecli
  - **Meta Muse "Sentinel"** (closed; design published): surrogate tokens replaced with real credentials at the network boundary, credentials outside the cell, approvals scoped per destination/use case, a11y-only browser views. https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
  - **Gondolin** placeholders ("The guest only sees a placeholder token. The real secret is injected by the host only for allowed destinations"). https://github.com/earendil-works/gondolin
  - **Docker Sandboxes** ("The agent sees a sentinel value instead of the real API credential"). https://docs.docker.com/ai/sandboxes/architecture/
  - **Claude Cowork** cloud ("Connector authorization tokens never enter the sandbox"). https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview
  - **OpenClaw** sentinels + exact host binding (in-process, off by default). https://docs.openclaw.ai/gateway/secrets/secret-store-and-egress
  - Fly.io **tokenizer** (Apache-2.0, 499 stars): "Clients encrypt third party secrets using the proxy's public key", so even the placeholder is a sealed blob. https://github.com/superfly/tokenizer
  - Agent Zero `§§secret(alias)` + streaming output masking; ZeroClaw HMAC **tool receipts**, so the model can't fabricate tool results. https://github.com/agent0ai/agent-zero , https://github.com/zeroclaw-labs/zeroclaw
  - Anthropic **sandbox-runtime** (Apache-2.0, 5,400 stars, v0.0.78) for OS-level fs/network allowlists on host-side helper processes. https://github.com/anthropics/sandbox-runtime
- **Build vs. adopt:** start by running **OneCLI as `keyd`** (or fork it) behind the `internal` network, and add Keychain storage, response scrubbing and UI events; write our own only if its policy model can't express per-step approvals.
- **Model keys:** used only by `localdot-brain` on the host; the VM never calls model APIs. Local models via LM Studio are reached from the host, not from the VM.
- **Browser sessions (the hard part):** cookies inside the VM *are* usable secrets. Options: per-task disposable profiles; "take control to log in" through the stream with the session living only in that VM snapshot; or a cookie vault that injects cookies via CDP for allowed domains at task start and wipes on end. Show a "logged-in as" badge per site in the UI.
- **Every substitution is an event** (secret name, host, method, path, decision, requester step) rendered in the timeline ("used GitHub token → api.github.com POST /repos/…"); policy: allow / ask-once / always-ask / deny; per-secret spend/rate caps.

### 4.6 Visualisation contract (what the UI needs from the runtime)

- **Stream:** Selkies v2 (WebSocket + WebCodecs, optional WebRTC; arm64 webtop images) as default, noVNC/RFB fallback; server-side recording for replay. Render the overlay **in the browser** from normalised events rather than in the VM: Hermes found the in-VM cua-driver cursor overlay "can peg a core" on macOS and is flaky on X11. Viewers are view-only unless they hold a **takeover lease** enforced at the RFB/input layer (Hermes `rfb_filter.py`: noVNC `viewOnly` "is a UI hint"). https://github.com/NousResearch/hermes-agent , https://docs.linuxserver.io/selkies/components/pelorus/
- **Per-step event** (emitted *before* execution for preview, then *after* with result):
  `{runId, stepId, phase: "planned"|"executing"|"done"|"failed", frameIdBefore, frameIdAfter, screen: {w,h,dpr}, action: {kind, x, y, x2?, y2?, text?, keys?, scroll?}, coordSpace: "screen_px", normalized: {x: 0..1, y: 0..1}, target?: {bbox, role, name, source: "ax"|"grounder"|"som"}, intent: "Click 'Sign in'", rationale?: string, model: {provider, id}, latencyMs, approval?: {...}}`
- **Overlay primitives:** ghost cursor with eased path from the previous point; click ripple (single/double/right distinguished); drag path; scroll arrow with magnitude; typed-text caption (secrets shown as placeholders); key-chord chips; target bounding box + label; "about to act" preview with a short hold-to-cancel for risky actions; error badges.
- **Timeline:** filmstrip of before/after frames per step, synchronised with the recording; click a step to seek; diff overlay (changed pixels); cost/token meter per step; key-use events inline; memory-write diffs inline.
- **Avatar companion:** subscribes to the same event stream (idle / thinking / reading screen / acting / waiting for approval / error) — no private channel.
- **Security of the viewer itself:** loopback-only, per-session tokens, Origin checks, CSP, sanitised transcript rendering (OpenClaw CVE-2026-32064/43575/43581, dashboard XSS CVEs).

### 4.7 Build order (suggested)

1. `computer` container (webtop + Selkies + cua-driver/computer-server) on an `internal` network + `keyd` proxy; stream visible in a bare web page.
2. CU worker with the Claude adapter + normalised actions + overlay (ghost cursor, ripples, typed-text captions) + step timeline/replay. Measure on 20–30 real tasks.
3. Orchestrator (Markdown memory, SOUL/USER, cron/heartbeat, Telegram), then the avatar on the same event stream.
4. Local fallback (Qwen3.8-27B, then Holo-3.1 grounder), OpenAI/Gemini adapters, `~/.openclaw` importer.
5. Hardening: viewer auth/Origin/CSP, approval tiers, kill switch, memory-write diffs, security audit command; then optional macOS VM (Lume).

---

## 5. Open questions to verify before building

- Does `pi-ai` pass through provider-defined tools (Anthropic `computer_toolset_20260801`)? If yes, pi-agent-core becomes a stronger "start here" option (section 4.3).
- Confirm the coordinate convention of Qwen3.8-27B and Holo3/3.1 with a probe image (assumed relative 0–1000).
- Selkies v2 webtop latency/CPU on Docker Desktop (Apple Silicon, arm64 image) vs. KasmVNC/noVNC; whether cua-driver's Linux backend runs inside the arm64 webtop image.
- OneCLI's policy model: can it do per-step approvals, response scrubbing, and emit events to our UI?
- apple/container (macOS 26) as a lighter VM boundary for GUI containers [UNVERIFIED], and Lume macOS VMs for Mac-only apps.
- OpenAI GPT-5.x/6.x computer-use numbers are secondary-sourced (openai.com returned 403 to fetchers); re-check on the vendor pages.
- Trademark/positioning check for "localDot" vs OpenAI "dots" (launched 2026-09-29).

## 6. Key sources (most load-bearing)

- OpenClaw repo, VISION, SECURITY, releases: https://github.com/openclaw/openclaw , https://github.com/openclaw/openclaw/blob/main/VISION.md , https://github.com/openclaw/openclaw/blob/main/SECURITY.md , https://github.com/openclaw/openclaw/releases/tag/v2026.9.7
- OpenClaw docs: architecture https://docs.openclaw.ai/concepts/architecture · runtimes https://docs.openclaw.ai/concepts/agent-runtimes · runtime architecture https://docs.openclaw.ai/agent-runtime-architecture · sandboxing https://docs.openclaw.ai/gateway/sandboxing · secrets/egress https://docs.openclaw.ai/gateway/secrets/secret-store-and-egress · computer use https://docs.openclaw.ai/nodes/computer-use · managed desktop https://docs.openclaw.ai/gateway/config-browser-ui-desktop · cloud desktops https://docs.openclaw.ai/gateway/cloud-workers/desktop · Control UI https://docs.openclaw.ai/web/control-ui · Canvas/A2UI https://docs.openclaw.ai/platforms/mac/canvas
- Security: https://github.com/advisories/GHSA-g8p2-7wf7-98mq · https://thehackernews.com/2026/02/clawjacked-flaw-lets-malicious-sites.html · https://censys.com/blog/openclaw-in-the-wild-mapping-the-public-exposure-of-a-viral-ai-assistant/ · https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html · https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/ · https://www.wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys · https://www.microsoft.com/en-us/security/blog/2026/02/19/running-openclaw-safely-identity-isolation-runtime-risk/ · https://labs.zenity.io/p/openclaw-or-opendoor-indirect-prompt-injection-makes-openclaw-vulnerable-to-backdoors-and-much-more
- Alternatives: https://github.com/NousResearch/hermes-agent · https://github.com/agent0ai/agent-zero · https://github.com/nearai/ironclaw · https://github.com/nanocoai/nanoclaw · https://github.com/onecli/onecli · https://github.com/zeroclaw-labs/zeroclaw · https://github.com/HKUDS/nanobot · https://github.com/earendil-works/pi · https://github.com/earendil-works/gondolin · https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse · https://openai.com/index/introducing-dots/
- Sandbox/stream infra: https://github.com/trycua/cua · https://docs.linuxserver.io/selkies/components/pelorus/ · https://docs.docker.com/ai/sandboxes/architecture/ · https://github.com/superfly/tokenizer · https://github.com/anthropics/sandbox-runtime
- Models/benchmarks: https://osworld-v1.xlang.ai/static/data/osworld_verified_results.xlsx · https://arxiv.org/abs/2606.29537 · https://snorkel.ai/leaderboard/os-world-2-0/ · https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool · https://developers.openai.com/api/docs/guides/tools-computer-use · https://ai.google.dev/gemini-api/docs/computer-use · https://huggingface.co/Qwen/Qwen3.8-27B · https://hcompany.ai/holo3 · https://gui-agent.github.io/grounding-leaderboard/ · https://arxiv.org/abs/2607.28367 · https://arxiv.org/abs/2510.24563 · https://arxiv.org/abs/2510.02250
