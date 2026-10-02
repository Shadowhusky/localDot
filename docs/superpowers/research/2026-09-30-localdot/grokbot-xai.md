# Grok Bot (SpaceXAI, formerly xAI): research notes for localDot

Research date: 2026-09-30. Scope: what "Grokbot" is, how it visualizes agent work, its architecture, security model, reception, its relation to Macrohard / Grok apps / Grok 4.x, and how Grok Companions (Ani, Rudi, Valentine, Mika) are rendered.

Evidence labels used throughout:
- **[P]** primary source (SpaceXAI/x.ai pages, Cursor docs, official guides, official videos)
- **[O]** my own observation from frames of official or hands-on videos and screenshots (frames saved under `scratchpad/research/video/frames/` and `media/`)
- **[RE]** credible reverse engineering (published teardown, or my own reading of shipped web bundles)
- **[S]** reputable secondary coverage
- **[I]** my inference
- **[U]** unverified claim or rumor

Method: the Cursor docs were read in full as Markdown (`cursor.com/docs/grok-bot*.md`, `cursor.com/help/grok-bot/*.md`). I fetched Cloudflare-gated x.ai pages and videos with TLS impersonation. I analyzed the official 106 s launch film, Matt Palmer's official 29-minute walkthrough, and two third-party hands-on videos frame by frame. I also read a binary-level teardown gist and SpaceXAI's own web bundle, which contains the production avatar animation engine.

---

## 0. TL;DR

- **"Grokbot" is officially "Grok Bot"**, stylized with a space. People say "Grokbot"/"GrokBot", including SpaceXAI's own DevRel on camera, and its X handle appears to be @bot [O]. It launched in **beta on 2026-08-11** [P]. It is a hosted **"AI teammates with their own computer"** product. You message persistent, named Bots. They share **one persistent cloud Linux computer per user** (a Firecracker microVM) with Chrome, a terminal and a filesystem. They work across apps through plugins/MCP and through computer use, run routines 24/7, coordinate in group chats, and hand you the screen for logins, 2FA and CAPTCHAs.
- **It is built by Cursor (Anysphere), which SpaceX acquired and closed on 2026-08-14.** You sign in with a Cursor account, the docs live on cursor.com, the download comes from cursor.sh, connectors authorize as the "Cursor" OAuth app, and the host's agent loop class is `AnysphereAgent` [P][RE]. It is **not the Grok app**; Cursor's FAQ says so explicitly [P].
- **The user's mental model needs one correction.** Grok Bot does render the Bot's computer live inside a macOS-style app window, and the guest desktop is Linux (XFCE-like). But it **deliberately does not showcase detailed action visualization.** In all the footage I reviewed, the live view is a plain scaled remote-desktop stream: no ghost cursor, click ripples, keystroke HUD or element-highlight boxes. SpaceXAI's design rationale says the more prominent the computer, the more users micromanage. So they reduced it to **three levels: a status icon, a pinned side-panel preview, and a full-screen take-over.** They put "what is it doing" into an **animated avatar state system** plus hover-to-see-current-action and compact tool-activity rows [P][O]. **This is exactly the gap localDot can own.**
- **Models:** Cursor manages model selection and there is no picker [P]. SpaceXAI marketed **Grok 4.6** (2026-08-12) and **Grok 4.7** (2026-09-21, "trained to natively understand the Grok Bot harness") [P]. The harness code has provider paths for Anthropic, OpenAI and xAI [RE], and delegated Cursor Cloud Agents were seen running "Fable 5" [O].
- **Macrohard is a separate, unshipped Tesla–xAI "Digital Optimus" effort.** It uses real-time screen-video control on the AI4 chip, was reported stalled in March 2026, and Musk said it was still "on track" for September 2026 with no public demo as of 2026-09-06 [S]. None of the Grok Bot sources mention Macrohard [O].
- **Companions** (Ani, Good/Bad Rudi, Valentine, Mika) are **mobile-app 3D voice avatars** that launched 2025-07-14 [S]. Their lips move with speech, they gesture, idle-sway, spin, dance, and change backgrounds and outfits, with relationship **levels** that unlock NSFW content (the first report said "after lvl 3") [S]. **The engine is not publicly confirmed.** A credible but unconfirmed link points to **Animation Inc.**, whose on-device "**Ani-2**" voice-to-full-body-3D-motion model runs at "2.5 ms/frame" and whose "Anichat" app had an "LV." level badge [S][RE][I]. I found no public teardown confirming Unity or any other engine [U].

---

## 1. Identity, corporate context, timeline

- **Product:** "Grok Bot, your team of always-on agents. They have their own computer, work inside tools and apps like you do, and keep working 24/7." [P: https://x.ai/news/introducing-grok-bot]
- **Built on Cursor infrastructure** [P]:
  - The macOS download link is `https://api2.cursor.sh/updates/download/stable/darwin-arm64/grok-bot-…` (in the x.ai page HTML).
  - The docs are at https://cursor.com/docs/grok-bot and https://cursor.com/help/grok-bot/*.
  - Sign-in uses a Cursor account; status is on status.cursor.com.
  - Connector OAuth consent reads "Cursor would like access to your Stripe accounts" (support-guide screenshot) [P/O].
  - The teardown finds `AnysphereAgent`, `SandAgentRunner` and `sand-host`, so **"Sand" is the internal codename** [RE]. The design-guide videos are named "baby-sand-demo", and the notch prototype lists "Sand Experiments / Baby Sand Ops / Baby Sand UX" [O].
- **Corporate:**
  - SpaceX acquired xAI in an all-stock deal on 2026-02-02 (xAI valued at $250B) [S: CNBC https://www.cnbc.com/2026/03/11/musk-unveils-joint-tesla-xai-project-macrohard.html].
  - xAI rebranded as **SpaceXAI** in July 2026 [S: Wikipedia https://en.wikipedia.org/wiki/SpaceXAI]; the infobox lists Cursor as a subsidiary and Grok Bot as a product.
  - SpaceX exercised its right to buy **Cursor/Anysphere for ~$60B** (announced 2026-06-16, **closed 2026-08-14**) [S: CNBC https://www.cnbc.com/2026/06/16/spacex-spcx-cursor-acquisition-ipo.html; satnews; via search snippets].
- **Timeline** [P unless noted]:

| Date | Event |
|---|---|
| 2026-05-15 / 05-19 | Grok subscriptions usable inside **Hermes Agent** and **OpenClaw** (local-first open-source agents) — https://x.ai/news/grok-hermes, https://x.ai/news/grok-openclaw |
| 2026-06-15 / 07-23 | Grok Build (coding CLI) gets Agent Dashboard and Workflows (unrelated to Grok Bot) |
| **2026-08-11** | **Grok Bot beta launch**. Contemporaneous coverage says it was gated to SuperGrok Heavy, Cursor Ultra and Cursor Teams Premium; the launch post now lists all tiers, which appears to be an edit [S/I]. Desktop + iOS. |
| 2026-08-12 | Grok 4.6 released (https://x.ai/news/grok-4-6) |
| 2026-08-14 | SpaceX–Cursor acquisition closes [S] |
| 2026-08-26 | Included with all SuperGrok, Cursor Pro/Pro+/Ultra and Teams plans (https://x.ai/news/grok-bot-more-plans) |
| 2026-08-29 | X integration: X connector, auto-created dev account, free X API credits (https://x.ai/news/grok-bot-and-x) |
| 2026-09-03 | Enterprise GA with network/audit controls (https://x.ai/news/grok-bot-for-enterprise); **"Designing Grok Bot" essay** (https://x.ai/news/designing-grok-bot) |
| 2026-09-21 | Grok 4.7 released, "trained to natively understand the Grok Bot harness" (https://x.ai/news/grok-4-7) |
| 2026-09-28 | **Team Bots**: shared Bots with per-user private chats and Slack handles (https://x.ai/news/team-bots) |

- **Adoption claims** (SpaceXAI, not independently verified): "Thousands of organizations have adopted Grok Bot since launch, including customers like Legora, Supermicro, and ServiceTitan … the heaviest use is outside engineering" [P, enterprise post].

## 2. Availability, platforms, pricing

- **Platforms:** desktop app for macOS (Apple silicon and Intel), Windows (x64 and Arm64) and Linux (x64 and Arm64; apt/dnf package `grok-bot`), plus an iPhone app. The help center now also lists Android [P: docs + help/mobile.md]. The desktop is an **Electron** app [RE]. The mobile app can open the Bot's computer and **take over from the phone** [O: Lipsky 9:07].
- **Access** [P: https://cursor.com/help/grok-bot/plans.md]:
  - Included with Cursor Pro, Pro+, Ultra and self-serve Teams.
  - Alternatively, link an individual SuperGrok, SuperGrok Plus, SuperGrok Heavy or X Premium+ account as a "usage grant".
  - Links are permanent. Plans do not stack. SuperGrok Lite/Team/Enterprise cannot link.
  - Enterprise: through your account team.
- **Metering:** a weekly included usage bucket, then optional on-demand usage billed through Cursor with a monthly cap. The cap "does not stop a Bot in the middle of a run". The free trial is a usage credit plus a 7-day window. Usage is measured by agent steps and tokens, and routines burn usage [P].
- **List prices seen on x.ai/bot:** Cursor Pro $20/mo, SuperGrok $30/mo, Cursor Teams Standard $40/seat/mo. Other tiers sit in animated widgets I couldn't read statically [P/O]. A reviewer called it "$200 a month to get in" at launch, i.e. the Ultra gate [S: Brock Mesarich video]. Wired paid $300 for SuperGrok Heavy to try companions in 2025 [S].
- **Limits** [P]:
  - About 50 Bots per account and 2–6 Bots per group chat (design essay + docs).
  - 6 attachments per message on desktop; 25 MB for docs, images and audio; 200 MB for video.
  - One computer-use task per Bot screen at a time.
  - An app update is required after 14 days.
  - Routines are "capped at fifty per Bot" [S: michaelbennett.co, citing docs; not seen by me].

## 3. Models and agent stack

- "Cursor manages model selection. There is no customer-facing model picker, and the serving mix can change over time with no fixed vendor set guaranteed. Usage analytics show the model that served each request, including failovers." [P: https://cursor.com/docs/grok-bot/security.md]
- Grok 4.6 focuses on "long-running agents and more ambitious interactive and visual work" [P]. Grok 4.7 has a "new, larger base … longer RL … trained … to natively understand the Grok Bot harness", priced at $2/M input and $6/M output [P]. The x.ai/bot SuperGrok Plus/Heavy tier lists the "Grok 4.6 model" [P].
- The teardown shows provider-specific paths for **Anthropic, OpenAI and xAI**, and an xAI-specific compaction handler [RE]. A Tech Demos Bot "launching Fable 5 into apps/shader-lab" via a Cursor Cloud Agent was seen on screen [O: 101 guide screenshot]. "Fable 5/5.1" appears as a competitor model in SpaceXAI's own benchmark charts [P]. **So the "Grok" in Grok Bot is branding; the stack is multi-model** [I].
- **Agent stack** [P/RE]:
  - One main agent loop per Bot, `AnysphereAgent` in the "box host".
  - Task subagents, and a dedicated **computer-use subagent** (OTel `computer_use_session`, `initiated_by=subagent`).
  - Peer Bot messaging with wake prompts.
  - Summary sessions for compaction.
  - Learned-memory extraction and synthesis ("dreaming" gate `sand_memory_dreaming`).
  - An independent **Auto Review** classifier model.
  - Delegation to **Cursor Cloud Agents**, which can run on your own "private worker" machines.
  - The user-visible reply goes through a `SendToUser` tool, so narration is an explicit, sparse act rather than a stream of consciousness [RE].
- **The "outer loop / inner loop" pattern** used internally: Grok Bot gathers context from Slack, Notion and GitHub and writes clean prompts for Cursor cloud agents, which do the coding. "Grok Bot is not writing the code" [P: 101 guide]. One engineer says the fleet manages "more than 200 [cloud agents] simultaneously" versus 15 by hand [P: engineering guide].

## 4. Architecture (as documented or reverse-engineered)

**Compute** [P: https://cursor.com/docs/grok-bot/teams.md, security.md, private-networks.md, identity.md]
- "Each user's work runs in a dedicated **Firecracker microVM** … with its own kernel, memory, and virtual devices." It is **one persistent VM per user, shared by all of that user's Bots.**
- It runs only on Cursor-hosted cloud in the US. There is no on-prem or bring-your-own-image option.
- It is **Debian-based Linux**; setup scripts run as the computer user with `sudo`.
- Idle computers hibernate. A durable disk keeps `/workspace`, browser sessions and logins across hibernation, updates and resets. Installed apps and packages (including `node_modules`) are lost on computer update, Recover or Reset.
- Chats are stored outside the VM. Egress uses shared static IPs.
- Optionally, "Route traffic through this computer" tunnels the VM's web traffic through your desktop so sites see your home IP.
- Enterprise "Team Setup" installs VPN clients such as Tailscale or Cloudflare Tunnel into every computer.

**Guest desktop** [O: Matt Palmer walkthrough 1:15–1:50, Lipsky 5:13, Brock 9:20]
- An XFCE-style Linux desktop: `Terminal - box@cursor: /workspace` (xfce4-terminal with "File Edit View Terminal Tabs Help"), Thunar file manager ("workspace - Thunar", Places: box, Devices: File System), and Linux Google Chrome with minimize/maximize/close on the right.
- A centered bottom dock with three icons: Chrome, a small device/toolbox icon, and a terminal. The dock shows a "Google Chrome" tooltip on hover.
- The user is `box` and the hostname is `cursor`.
- The design essay says the VM has **dynamic wallpapers that get lighter in the morning and darker at night**, "giving the Bot's computer its own sense of time" [P].
- "Each Bot gets its own screen on the shared computer" [P]. Per-Bot X displays and a "window router" (`sand-window-router.mjs`) are implied [RE/I].

**How actions execute** [P/RE]
1. **Plugins, MCP and skills.** These are "the same MCP servers, plugins, and skills as Cursor", with multiple accounts per service (e.g. four Gmail accounts). OAuth tokens live on Cursor's connector backend, and the "Bot invokes tools without receiving them".
2. **Browser automation.** The teardown shows `withPlaywrightSnapshotFallback`: "scoped snapshot fallback can remove both target and depth … a narrow request can become a whole-page snapshot". That points to Playwright/CDP with accessibility-tree snapshots, plus "browser prewarming" and "stale-seat recovery" [RE].
3. **Pixel computer use** through a computer-use subagent. OTel action kinds are `click, drag, key, mouse_move, screenshot, scroll, type, wait`, and sessions record action and screenshot counts plus duration [P: https://cursor.com/docs/enterprise/opentelemetry-export/wire.md]. This is the classic screenshot-plus-mouse/keyboard loop, not video streaming (contrast with Tesla's "Digital Optimus" in §9).
4. **Shell and filesystem** in the VM.
5. **Delegation** to Cursor Cloud Agents (separate VMs), which can take screenshots and videos as "proof".
6. **Local execution** on the user's own machine through the desktop app's daemon: commands, file reads and file transfers. It uses a separate policy with **per-command approval by default** (ask / always / never).

**Service topology** [RE: gist https://gist.github.com/gfsaaser24/9f785c0c095b693b31b5efbcbae7bcd0, "How the Grok Bot harness works", by @gabefletcher, built from captured host and desktop builds .47–.57.1, created 2026-09-16 and updated 2026-09-28]
- Electron renderer → preload IPC → Electron main (accounts, gateways, voice, egress policy `getGrokBotEgressPolicy`) → gateway → **box host** (transcript manager, per-agent scheduler `SandRunScheduler` with user/agent/background lanes, runner, `AnysphereAgent` loop).
- The host connects to separate stores: roster/transcripts, conversation blobs and checkpoints, and memory shards for user/project/agent. It also reaches the box execution daemon and hosted services (identity, automation sync, search, media, voice, MCP, catalogs).
- The system prompt is assembled from sections, in this order:
  - `base`, `spotlight`, `voice_channel`
  - `profile`, `user_identity`, `team_bot`, `multitask`
  - `internal_details_boundary`, `mcp_multi_account`, **`user_form`** (the secure form), `draft_external_message`, `timezone`
  - `memory`, `current_session`, `active_sessions`
  - `automations`, `skills`, **`stripe_link_purchasing`**, `channels`
  - `agent_directory`, `group_chat_turns`, `mcp_instructions`, `mcp_status`, `remote_box`, **`bot_secrets`**, `computer`
- Sections are hashed and pinned for prompt-cache stability.
- Desktop preload exposes `createGrokBotEmailInbox` and `addGrokBotRoomPeople`, which suggests Bots can own email inboxes; the design essay's email card shows `peng@grokbot.app` [RE/P/I].
- **Voice calls** run as a separate "VoiceCallHarnessSession" [RE].

## 5. Visualization and UX (main focus)

### 5.1 Design philosophy [P: https://x.ai/news/designing-grok-bot, 2026-09-03]
- **The primitives are Bots, Chats, Prompts** (once, saved as Skills, or triggered as Routines), **Tools and Artifacts**. Everything else stays beneath the interface.
- **The sidebar is a roster of Bots, not a chat history.** "Chats are disposable … the main objects in Grok Bot are Bots, not conversations."
- **"Presence as interface"** answers three questions: *Who is this? What are they doing? How much do I need to know?*
- **Status comes from the avatar's motion, and detail is available on hover.** They rejected "three animated dots" because it showed too little, and a one-line current-action description because "once people could see one step, they wanted to see the rest". Research showed users wanted detail mainly "for reassurance that the Bot was still working and on the right track". Final design: "the avatar's motion provides the first bit of reassurance … If someone wants to check what it is doing, they can hover to see its current action."
- **They explored four computer placements and rejected all of them.** Floating window, side-by-side, modal and full screen were tried; "The more prominent we made the computer, the more the product encouraged users to supervise it."
- **The final design has three levels of access:**
  1. **Status:** "the title-bar icon turns purple while the computer is active".
  2. **Preview:** "a pinned side panel where the user can follow the work without leaving the conversation".
  3. **Takeover:** "open the computer full screen, take control, and then hand it back".
  "It is closer to working with a coworker than operating a remote machine."
- **"The shape of information":** Bots answer with **inline cards and widgets** (forecasts, boards, an email draft card with Send/Discard) instead of prose. System events such as "Created Routine · Morning Briefing" and "6 messages with Kenny, Tyler and Jenny" sit in the same transcript: "a heterogeneous transcript".
- **"The disappearing interface":** "We removed window and panel controls, computer-view options, and agent metadata."

### 5.2 App chrome and layout [O: 101-guide screenshots, Matt Palmer and Lipsky videos]
- A native-feeling macOS window with traffic lights, light and dark themes, and 31 UI languages [P].
- **Three panes:**
  - **Left:** search, a roster grouped into user-made sections ("Cursor", "Ops", "Unassigned"), "Hidden Bots (n)", Plugins, and the account menu (Get Grok Bot for iOS, Settings, About, Help Center, Send Feedback, Log out).
  - **Center:** the chat, with the avatar and name in the header, a composer with "+", `/` for skills, `@` mentions, a mic (voice typing, Cmd+D) and a waveform button (voice chat when the box is empty).
  - **Right** (toggle `>>`, gear): a **"<Bot>'s screen"** live thumbnail of the VM (a desktop icon placeholder when idle) and **Routines** with "+".
- **Row design:** avatar, name, time, and a one-line status or preview such as "Cursor agent: Build apps/shad…" or "Need your yes on the Friday all-hands deck."

### 5.3 Avatars = identity + state [P + RE + O]
- **Picker** [P, docs image `avatar-picker-light.png`]:
  - 8 character shapes (circle, blob, rounded square, pill, triangle/wedge, hexagon, cloud, teardrop) × 11 colors (black, brown, red, orange, amber, green, teal, blue, purple, pink, gray).
  - Each is a flat blob with **two short tilted eye strokes**.
  - Tabs: **Bot / Generate** (AI-generated avatar from a text prompt) **/ Upload**. The phone offers Gallery/Generate/Remove.
  - The code also lists "pebble", "bean" and "squircle" shapes [RE].
- **Style rationale** [P]: they studied initials, emojis, pixel art, watercolor, claymorphism, Noritake-style line art, silhouettes and identicons. They chose "simple shapes and expressive eyes, then … controlled variations and accessories" so each Bot is recognizable peripherally at sidebar scale.
- **States in the essay** [P]: Idle, Thinking, Working, Waiting, Blocked, Done. An auto-playing "lifecycle tour" with tab progress bars and a "Pause the lifecycle tour" button illustrates them. "At rest, the Bot is calm and slightly curious. When work arrives, it acknowledges the task. As work begins, it kicks into gear. Its motion changes again when it is waiting or needs help, then settles once the work is done."
- **In the product** [O: Matt Palmer 3:13–3:26, 6 fps crops]:
  - While a Bot works, **its avatar sits alone in the reply slot** of the chat, replacing "…".
  - The eye strokes jump between gaze directions (down, down-left, sideways), squint or blink, and briefly **turn away**: the eyes slide off the head's edge as if it rotated.
  - An **iridescent rainbow swoosh trail** flashes during quick spins.
  - The Bot's name fades in beside it before the message lands.
  - In the sidebar, a **green dot badge** on the avatar means working.
- **Engine** [RE: SpaceXAI's own web bundle `https://x.ai/_next/static/chunks/2d8wko04g-csr.js`, which powers the essay's interactive figure]. The designer says their motion tooling used "the same asset that already lived and moved in the product … the actual animation spec file", so I infer parity with the app.
  - **It is pure SVG plus `requestAnimationFrame`.** There is no Lottie, Rive or sprites. One head path, two **eye paths clipped to the head path** (which is why the eyes vanish off the edge during "turns"), 5 ripple-ring circles, 5 "part" circles (the head can split into parts, e.g. **three dots for "thinking"**), 3 glyph paths, and a badge circle.
  - **3D-ish pose from 2D** via CSS `perspective(720px) rotateX(tilt) rotateY(turn) rotateZ(roll) scale()`.
  - **Physics:** a damped spring integrator `v += (−2ζω·v − ω²·(x − target))·dt`, with a fixed step `dt = 1/120 s`. Easings: easeInOutCubic, easeOutCubic, easeOutBack (1.70158) and smoothstep.
  - **A seeded PRNG** (mulberry32) per avatar `seed` makes each Bot's idle behavior unique but deterministic. `prefers-reduced-motion` is respected.
  - **Imperative API:** `spin(n)`, `bounce()`, `burst()` (particle burst of 22), `snapshot()` (SVG export). **Props:** `state`, `shape`, **`gazeTarget`** (the eyes look at a point), `pose {turn, tilt, roll, scale}`, `expression`, `badgeColor`, `ink`/`inkGradient`, and `trailTune` (multi-lane color trail with hue drift, palette #f9705c #5b95f0 #3fbe86 #f5b13f #9a72ee #35c3bd).
  - **State catalog, grouped in code:**
    - **Lifecycle:** sleeping, waking, idle, listening, thinking, searching, working.
    - **Reactions:** excited, surprised, suspicious, angry, drowsy, happy, curious, confused, bored, proud, shy, sad, laughing, scared, playful, celebrate.
    - **Agent morphs:** orbit, radar, progress.
    - **Product lifecycle:** spawning, humming, loading, dictating, writing, sending, receiving, uploading, notifying, alerting, dragging, bouncing, powering-down.
  - **Body-morph overlays per state:** thinking→"dots", spawning→"gather", dictating→"wave", sending→"send", receiving→"receive", uploading→"dock", bouncing→"ball", loading→"whirl", writing→"pencil", alerting→"bang", powering-down→"standby". Each state picks among an allowed set of ~25 eye glyphs; for example idle uses {0, 8} and searching uses {15, 9, 3, 20, 12, 18}.
  - **Dwell per expression (ms):** idle 9000–16000, thinking 2000–3600, searching 1000–1800, working 1800–3200, sleeping 6000–10000, excited 1100–2000.
  - **Secondary glance/blink cadence (ms):** idle 6000–14000, listening 3000–7000, thinking 3500–7000, searching 1600–4000, working 2800–5500.
- **Character entrance / brand motion** [O: official "updated-email-asset" and design-guide video]:
  - A **"•••" typing indicator merges into a blob**, which grows into the eyed character.
  - It **looks down at the app window sliding up**, blinks, then does a **spin with an iridescent flash** and **bounces into place** in the sidebar as that Bot's avatar.
  - The designer tuned "timing, springs, distance, scale, and easing" in a localhost playground built around the production animation spec. Example feedback: "hold the look down-left longer", "bounce is too exaggerated".
  - The launch film uses **scrambling text** ("Meet ▯▯▯" decoding into "Meet Yodo / Ms. Detective / HanSodo … / Meet Grok Bot").

### 5.4 Transcript, narration and step detail [P + O]
- **Tool activity rows** (essay figure): "Searching the web", "Environment ready · 387ms", "Edited math.ts +14 −10", "Ran focused tests · npm test", "Ran type-check · npm run", "Thought · briefly", "Searched code · 'toFixed'", "Read · AGENTS.md", "Edited math.test.ts +6 −2", "Ran full suite · 212 passed", "Committed · fix: clamp NaN". Each row pairs a **verb phrase, target, and compact metric** (duration, diff stat or test count).
- "The transcript shows tool activity, computer use, created files, questions, and approval requests alongside normal messages." [P: work.md]
- **Inline screenshots:** the Bot drops small screenshots of its screen, with the dock visible, into the chat as evidence (Amazon cart, Facebook Marketplace listing) [O].
- **Question cards:** a title plus an optional subtitle ("I won't send anything until you pick."), **lettered options A/B/C** that act as keyboard hints, option subtitles ("Italy — Cities + food + coast"), a "Type your own answer" field, and a close ×. Once answered, the card collapses to the chosen option with a ✓ [O].
- **Task cards:** "Build apps/shader-lab preset-swapper" with a **"Running" spinner chip** and an **"Open in Cursor"** button [O].
- **Artifact cards:** files and links "appear as cards you can preview, save, or answer with feedback" [P].
- **Hover actions on messages:** react, reply-in-thread, and more (Copy request ID) [O/P].
- **Product-page mocks** [P, x.ai/bot]:
  - A **"Computer · You're in control"** mock over "Working · Sign in to Zendesk so I can work the support queue."
  - Handoff chips "**Asking Research… / Looping in Comms… / Sending to Chief… / Pinging Travel…**".
  - A memory toast "**Updated memory for Account Manager**".
  - "**Weekly Reporting is watching and learning · 0:04**".

### 5.5 The computer view [P + O]
- **Open:** click the right-panel preview ("<Bot>'s screen"). On hover, the preview shows a centered "⤢ Open" pill. The view then takes over the app window: **a dark frame over the dimmed app, with the VM framebuffer scaled inside**, "**Teach a task**" (record icon) at top-right, and a collapse (↙↗) control [O].
- Per the docs, "watch clicks, typing, navigation, and current status" [P].
- **What I observed:** the page content changes, tabs open (including about:blank), the Chrome status bar shows hovered link URLs, and multiple overlapping windows are visible (Chrome, xfce4-terminal, Thunar) [O].
- **No synthetic overlays** (ghost cursor, click ripple, typed-text HUD, target highlight, step captions) were visible in any reviewed footage. Paul Lipsky: "In this case, the bot is just on the desktop." [O]
  - Caveat: VNC-style streams often omit the remote cursor, and the three videos are from the first weeks after launch [I].
- You can "interact with it like a remote desktop"; from the walkthrough, "If I click the bot's window, I can use that machine like a remote desktop." [P]
- The phone can show the computer and take it over [O/P].

### 5.6 Take-over flow (step by step, with UI copy) [O: Lipsky 4:55–5:40; P: how-to.md]
1. The Bot narrates: "Checking whether LinkedIn is already signed in there. If not, I'll hand you the screen to log in once." → "LinkedIn needs a sign-in on my computer. Handing you the screen now — log in however you normally do, then hand it back."
2. A **"Computer" card** appears with a green **"Action needed"** badge (spinner icon), the instruction "Sign in to LinkedIn, then hand it back", a **live thumbnail**, and buttons **Take over** (primary) / **I'm done** (outline) / **Skip** (text).
3. Take over → a full-window "**Connecting…**" state → the full-screen computer with an **amber banner strip**: the Bot's ask in amber on the left ("Sign in to LinkedIn, then hand it back") and "**Skip this step**" / "**I'm done, continue**" on the right. A small pill at top-left looks like a screen selector [O/I].
4. After "I'm done", the card flips to "**Done**" (green) with "Open computer", and the Bot continues ("You're in — LinkedIn is signed in as you on my computer…").
- **Sidebar attention:** an orange dot plus orange preview text, e.g. "**Waiting for you: Solve the Goo[gle CAPTCHA]…**" [O].
- **Hardware security keys** (e.g. YubiKey plugged into your Mac or PC) can be used on the Bot's computer with per-use approval. Laptop passkeys, Face ID and Windows Hello do not work in the VM [P].

### 5.7 Teach a task [O: launch film 29–36 s; P: work.md]
1. From a 1:1 chat with the computer view open: "Teach a task", then describe the result ("Watch me respond to emails and mimic my taste").
2. **A red recording border** outlines the VM screen, with a **red "■ 0:00" timer chip and a × cancel** at top-right.
3. Stop → a **"Learn from demonstration" pill** (sparkle icon) → the Bot replies "Got it — watching the demo and turning it into a skill."
- The recording is **visible computer interaction only, up to 10 minutes, no mic**. The output is a **draft skill** to which you add decision rules, failure handling and approval boundaries. It is rolling out gradually.
- The product page shows "<Bot> **is watching and learning** · 0:04" [P].

### 5.8 Approvals and permission prompts [P: security.md, how-to.md, settings; O]
- **"Review an action" card** (from Auto Review): shows the proposed operation and its inputs, with **Allow once / Always allow** (which adds a rule) **/ Deny**. The phone has the same controls.
  - Cards from unattended work (routines, triggers, other Bots) **expire after ~10 minutes** and then show "Expired" / "Always allow this in the future". Cards in a chat you're in wait for you.
- **Local-execution card** shows the exact command. The policy is ask every time / always / never, set per desktop.
- **Settings → Bot → Auto-review:** "Grok Bot checks each action before it runs and asks you first when needed." Rules use a form: "**When Grok Bot wants to:** [e.g. reply to emails for me] **It should:** [Allow automatically | Ask first]". "Ask first" wins. Team rules appear as locked rows. "Built-in safety checks always apply." [P, screenshot]
- **Connect card** for plugins shows Authorize / Reopen / Retry and "Waiting for authorization". Sign-in happens in your own browser within about 10 minutes [P].
- **Pending approvals surface in three places:** the chat card, a sidebar attention state, and a system notification (suppressed while the app is focused; dock badge instead) [P].
- **Stopping and redirecting:** "A direct message from you takes priority over background work and can redirect the current turn. Send 'Stop now' … stopping doesn't undo actions the Bot already completed." [P]

### 5.9 Secure secrets UX [P: help/secrets.md]
- **Secure secret card:** masked field → "**Save securely**" → "**Saved** · Saved securely and kept private". The footer reads "**Stored securely, never shown to your Bot**". The value is excluded from the transcript and not shown to the model.
- **Page fill:** when a page needs the secret, the card reports "**Filled into the page. Secret values were never shown to your Bot.**" or "Could not fill into the page". This is a fill-without-reveal path [P]; the mechanism is not public [U].
- **Per-Bot "Secrets"** are environment-variable name, description and value. "The description is visible to the Bot. The value is not." Values are write-only (Replace, never read back) and "never shows the value again, including in Shell". This suggests output redaction [I].
- Enterprise "Team Secrets" feed setup scripts and "never reach your Bots directly" [P].

### 5.10 Progress, attention and multi-Bot views [P + O]
- **Sidebar states** [O, confirmed at full resolution]: a **green dot badge on the avatar** means working; a **blue dot** at row end means unread; an **orange dot plus orange "Waiting for you: …" preview** means needs you. "The sidebar distinguishes Bots that need attention (a question, approval, or handoff), unread activity (a new result), and working status." [P]
- **Group chats** (2–6 Bots): write normally or use `@Bot` / `@everyone`. Bot-to-group handoffs are text-only, and handoffs are visible in the conversation [P]. Guide videos also show **project channels** with a Members panel [O].
- **Routines panel:** Active toggle, Delete, **Test run**, Name, Instruction (the prompt), **When to run** ("On weekdays at 9:00 AM", "+ Add another"), and **Run history** with ✓ per run [O].
  - Triggers: On a schedule, Slack message, Git event, Teams message, Linear issue, Sentry alert, PagerDuty incident, plus email and **webhook** (POST URL plus Bearer key) [O/P].
  - Editing a routine pre-fills the composer with "Edit your routine: …" [P].

### 5.11 Voice [P: help/voice-chat.md]
- **Voice chat** with a single Bot: "Connecting…" / "Calling…", then Mute, Hang up, Show transcript, and settings for Voice, Speed and Language (auto-detect). You can browse other chats and "Return to the voice chat".
- After hang-up, a **"Voice chat" card with duration and transcript** appears, then "How was the call? Good/Bad". The Bot follows up in chat with unfinished work.
- Voice typing (Cmd+D) is separate.

### 5.12 Replay and history
- There is **no user-facing screen-session replay** that I could find [O/I]. History consists of the persistent transcript, inline screenshots and clips the Bot chooses to send, routine Run history, voice-call transcripts, and teach-a-task recordings.
- Enterprise **Action Recording** is metadata-only. For computer-use sessions it stores "action and screenshot counts and the session duration, **without the screenshots, clicks, or typed text**". Shell commands are secret-scrubbed, and URLs are stripped to scheme://host/path. It exports as OTel `cursor.surface=grok_bot` with 90-day retention [P].

### 5.13 Sound design
- **No public documentation of UI sound design was found.** The docs mention only system and mobile notifications and dock badges. The launch film has music; app audio wasn't discernible in narrated walkthroughs [O/U].

### 5.14 Ambient presence prototypes, not shipped as-is [P+O: https://x.ai/bot/guides/designing-grok-bot-with-grok-bot]
- **Notch:** click the MacBook notch and a dark panel drops down. The Bot's glowing eyes sit center, orbited by app icons (Slack, Calendar, Chrome, Figma, Messages, Cursor…). "Ready to work in Slack." follows the frontmost app, with an input "ask about Slack…". Hovering Figma shows "Capturing…", then a window thumbnail with Open/Dismiss. Typing "clean up my layers" turns the panel into a chat, which collapses into a task list ("Ask about Figma · Working…") and retracts into the notch.
- **Corner peek:** hover the screen corner and a **fanned stack of notification cards** springs out (Figma review, Slack unreads, "Calendar: Standup in 10 minutes") with the Bot's eyes, expanding into an "Ask a question" bar.
- **Cursor buddy:** a tiny eyed pill follows your pointer, **labels the app under it** ("Calendar", "Google Chrome", "Slack"), **outlines the hovered window in blue**, and opens an inline command pill ("Reply to my unreads") → "On it." → "Send a follow-up…".
- "None of these concepts shipped exactly as explored." [P]

## 6. Memory, proactivity, integrations
- **Memory** [P]: "Stable preferences, role context, and summaries of prior work", kept separately per Bot. Capabilities (tools, skills, plugins) are account-wide; memory and routines belong to the Bot. The teardown adds user, project and agent memory shards, evidence-cited background synthesis, and protection of explicit user entries [RE].
- **Internal "Jenny" ops-bot pattern:** 5 a.m. 1:1s with each Bot, postmortems, playbook updates, and onboarding new Bots [P: engineering guide].
- **Proactivity** [P]: "follow up on threads you dropped, nudge a stalled handoff … picking up work before you need to ask". Routines run on schedules and events. Bots can create helper Bots and message each other. After long absences, Grok Bot may ask whether to keep routines running.
- **Integrations** [P]:
  - Gmail, Google Calendar and Drive, Notion, Slack, GitHub, Linear, Sentry, PagerDuty, Teams, Stripe, Salesforce, X (with an auto-created dev account and credits), and Cursor Cloud Agents. Marketplace plugins and skills are the same as Cursor's.
  - A Bot marketplace and **templates** share a Bot "as a recipe, not a clone" (identity, description, skills, routines; never your computer, logins or history).
  - **Team Bots** are shared per team, with private per-user chats and Slack handles.

## 7. Security and permission model [P unless noted]
- **Between users:** strong hardware isolation (one Firecracker microVM each).
- **Between Bots:** none. "**Do not use separate Bots as a security boundary.**" Files, cookies, sessions and CLI credentials are shared across all of a user's Bots, including Bots created later. Deleting a Bot leaves files and logins behind.
- **No machine identity.** "Bots act as the signed-in member." Connector tokens stay on Cursor's backend. For logins, 2FA and payment, the Bot **hands over the computer**; for supported connections it uses the **secure secret card**. "The Bot doesn't type credentials and doesn't see your password."
- **Auto Review** is an independent review model over shell commands, plugin calls, computer use, automation writes and delegation (cloud agents, subagents). It can allow, require approval, or deny.
  - It "doesn't review every side effect" (memory writes and most settings changes are not reviewed).
  - Outside content is marked untrusted, and prompt injection is "reduced, not eliminated".
  - **OTel escalation surfaces:** `host_shell, box_shell, mcp, computer, automation_write, cloud_agent, subagent, feedback, bot_share`.
  - **Runtime guardrails:** a **loop detector** (repeated output or tool calls) and a **bot-block detector** (`cloudflare_challenge, recaptcha, datadome, akamai`) [P: OTel wire reference].
- **Enterprise:** network allowlists (domains and CIDR/ports; no DLP hooks), SSO/SCIM, audit logs, Action Recording, enforced Auto-review with team rules, Team Setup/Secrets, model allowlist ("enforcement is not guaranteed"), computer termination, and auto-terminate after 30 days inactive. Certified under ISO 27001/42001 via Anysphere.
- **Critiques** [S]:
  - Michael Bennett (2026-08-29): the roster "looks like separation of duties" but is "four personas on one workstation that holds all of them". "Approvals are a stop button, not an undo button." "A stuck computer takes down every Bot on the account at once." https://michaelbennett.co/blog/grok-bot-shared-computer
  - Nervegna review: "no model picker", "no Grok Bot spend cap", files and logins survive deletion. https://nervegna.substack.com/p/grok-bot-for-designers-and-product
  - Towards AI: "Grok Bot's Shared Computer is Not secure" (title only; body paywalled).

## 8. Limitations and reception
- **Praise** [S]:
  - "Dead simple / Feels like a teammate / Bot group chats" (Brock Mesarich, https://www.youtube.com/watch?v=j2WiGVqMczw).
  - "Simple, Powerful … just works", with multi-account connectors as the standout (ChatPRD "How I AI", https://www.chatprd.ai/how-i-ai/how-i-ai-my-hands-on-review-of-grokbot-cursor-origin-and-the-grok-46-model).
  - "The most interesting agent product to ship this year" (Bennett).
  - Paul Lipsky praised the mobile experience (https://www.youtube.com/watch?v=QTcZPI-g7is).
- **Criticism** [S]:
  - "Feels like a beta / $200 a month to get in / chasing the buzz / almost too simple?" (Brock).
  - Less control than OpenClaw, and no model choice (ChatPRD).
  - "Too new to have proved itself on messy, real-world tasks" (Layer3Labs, https://www.layer3labs.io/guides/grok-bot-review).
  - Branding confusion between SpaceXAI, Cursor and Grok (Eli the Computer Guy video title, https://www.youtube.com/watch?v=yRyMN2WQ3Ok). Cursor's FAQ must clarify "Is Grok Bot the same as the Grok app? No."
  - Lipsky wanted a "live mode"; voice chat has since shipped.
- **Operational limits** [P]:
  - Sites can block cloud IPs.
  - Okta FastPass and device-trust rules fail on the unmanaged Linux VM (admins must add a "Grok Bot computer (Linux)" rule).
  - Recover and Reset lose installed packages and possibly very recent changes.
  - Usage burn from frequent routines and Slack triggers; the on-demand cap doesn't stop a run mid-flight.
  - US-only compute; no on-prem.

## 9. Relation to Macrohard, Grok apps and Grok 4.x

**Macrohard / Digital Optimus.** This is **not Grok Bot**, and no Grok Bot source mentions it (I grepped all fetched Grok Bot pages and docs).
- Musk teased a "multi-agent AI software company" in July 2025, and the trademark was filed in August 2025 [S].
- On 2026-03-11 Musk called "Macrohard or Digital Optimus" "a joint xAI-Tesla project". In it, "**Grok is the master conductor/navigator**" directing a Tesla agent that processes "the past 5 secs of real-time computer screen video and keyboard/mouse actions", on **Tesla AI4 + xAI Nvidia** servers [S: CNBC above; BI https://www.businessinsider.com/xai-macrohard-project-tesla-ai-agent-stalls-2026-3].
- BI reported the project **stalled**: leaders departed, cofounder Toby Pohlen lasted 16 days, and a 600-contractor screen-recording data project was paused. Tesla's approach is real-time **video** control, versus xAI's static-screenshot training [S].
- As of 2026-09-06, Musk said it was "on track" for September 2026, with no public demo. xAI hired two senior Cursor engineers in March, and Musk said it "wasn't built right the first time" [S: https://www.mylivingai.com/elon-musks-macrohard-is-supposed-to-launch-this-month/].
- **Inference:** Grok Bot is the Cursor-lineage hosted agent that actually shipped, using a screenshot/Playwright approach. Macrohard is a parallel Tesla-lineage effort. Treat any "Grok Bot = Macrohard" claim as **unverified** [I/U].

**Grok apps.** Grok Bot is a separate app and account (a Cursor account), with its own usage meter. Grok subscribers link their plan for a usage grant. There is an X connector and plugin.
- Other Grok products are separate: **@grok** on X, the Grok app's Automations/Workflows/Goal features, **Grok Build** (coding CLI with Agent Dashboard and Workflows), and Grok-in-OpenClaw/Hermes subscriptions [P].
- **Grok 5** does not appear on x.ai/news as of 2026-09-30. The latest models are Grok 4.5 → 4.6 (Aug 12) → 4.7 (Sep 21) [P].

## 10. Grok Companions: rendering and animation

**What's established** [S unless noted]:
- **Launch:** 2025-07-14 in the **iOS** Grok app for paid subscribers: **Ani** (goth anime girl: blonde pigtails, black corset dress, thigh-highs, lace collar) and **Rudi**, a red panda with a "**Bad Rudi**" toggle whose insults were later toned down.
  - A male companion was "coming soon", and a male "Chad" and an unnamed female were teased in-app (TestingCatalog: https://www.testingcatalog.com/grok-debuts-interactive-ai-companions-on-ios-with-anime-avatars/).
  - **Valentine** is reportedly inspired by Edward Cullen and Christian Grey (Business Insider, not fetched).
  - As of late February 2026 there were **five companions: Good Rudi, Bad Rudi, Ani, Mika, Valentine** (Wikipedia, https://en.wikipedia.org/wiki/Grok_(chatbot)#Companions).
- **Presentation:** "**fully 3D animated characters** that can interact with users via voice", "integrated within the voice mode". They "change their backgrounds" and "progress through levels" (TestingCatalog).
  - "As they answer, their **lips move** and they make **realistic gestures**." Bugs included voices changing mid-stream and processing delays (NBC, https://www.nbcnews.com/tech/internet/grok-companions-include-flirty-anime-waifu-anti-religion-panda-rcna218797).
  - Ani "**sways back and forth**… every so often, the character **spins coyly**", with preset conversation starters and a button "**We need to reach level 3**" (Wired, https://www.wired.com/story/elon-musk-xai-ai-companion-ani/).
  - Ani's official bio: "I might **dance**, tease, or just watch you figure me out" (Engadget).
  - New **virtual outfits** arrived in August 2025, and she "**leans into the frame** … sways gently" (hands-on: https://www.vinitnair.com/post/my-date-with-ani-xai-s-companion-is-flirty-flawed-and-surprisingly-human).
- **Affection / levels:** relationship levels unlock content; "Ani has NSFW mode after lvl 3" (TestingCatalog tweet, launch day). Ani "will strip down to lingerie if users keep engaging" (BI). The exact point values, UI and heart-meter mechanics were **not verified** in this session [U].
- **Platform facts from grok.com's shipped config** [RE]:
  - Companions are app-only; the web config has `companion_mobile_app_link` pointing to the iOS app.
  - The paywall copy says "Higher usage on Voice Mode and Companions".
  - A hidden model id **`grok-3-mini-companion`** exists, suggesting a dedicated companion LLM variant at some point [I].
  - Per-companion memory endpoints: `/rest/app-chat/memories_v2/{companionId}`.
- **Team:** xAI's July 2025 posting "**Fullstack Engineer – Waifus**" sought "exceptional multimedia engineers" to make "**Grok's realtime avatar products** fast, scalable, and reliable" in Palo Alto for $180k–$440k (BI, https://www.businessinsider.com/xai-pay-you-440k-make-anime-girl-ai-elon-musk-2025-7).

**Renderer and engine: credible but unconfirmed** [S/RE/I]:
- TestingCatalog noted the companions' official X accounts (e.g. `@AniAnichat`, now 404) "appear to be linked to an **Animation Inc.** company, although it remains unconfirmed whether xAI has acquired this company or is simply collaborating". It embedded a 2025-02-03 tweet by **Sergey Gonchar** (CEO, Animation Inc.): "Our **proprietary AI model delivers animated characters on-device in real time**, allowing any conversation with LLM-powered chatbots to be easily visualised."
- **The Animation Inc. site** (https://www.animation.inc) says:
  - "**Ani-2 Model** — Our proprietary on-device AI model generates **full-body 3D motion in real-time**. No motion capture, no cloud, no delay. **Inference speed: 2.5 ms/frame**. Animates Companions … Real-time voice, emotional range and presence. iOS · Android · Mac · Windows."
  - The team is "the original crew behind **MSQRD, Meta Spark, Meta Face Tracker and Loóna**": 13 people across Warsaw, Limassol and Palo Alto. Backers: Elefund, DVC, Haystack.
  - Their SwiftUI **AnimationSDK** sample: `CharacterView(character){ loadEnvironment("modern_kitchen") } update:{ conversationState, view in if emotion.primary == .confused && confidence > 0.5 { view.switchEnvironment(...) } if conversationState.hasKeyword("dessert") {...} }`, plus `saySimilar(...)`, `goTo("prep_station")`, `onTapGesture { showTechnique() }`.
  - In other words: **emotion- and keyword-driven environment switching, locomotion targets, and a voice-to-motion model.**
- **The Anichat app** (Animation Inc.'s consumer app) showed a 3D stylized-realistic character ("Joi") with push-to-talk, Mute, waveform and Text controls, gesturing while speaking (demo video). The site anichat.ai shows an "**LV. 0**" badge and "Anichat will be shutting down on Nov 30th" [O].
- **Assessment:** the "Ani" naming, the "Ani-2" model name, "Animates Companions", identical platforms and the level badge make an Animation Inc. link plausible. It is **not officially confirmed by xAI** [I/U].
- **Unity / Live2D / VRM:** I found **no credible public teardown** confirming any engine. Companions are 3D (full-body turns, spins, dancing), so Live2D is unlikely [I]. The APK mirror was bot-blocked, so no binary check was possible [U].
- **Open-source analogue for localDot:** **moeru-ai/AIRI** ("Self hosted, you-owned Grok Companion"; ~49.9k★, MIT) supports **VRM and Live2D** on Three.js/WebGPU, with realtime voice, on Web, macOS and Windows (https://github.com/moeru-ai/airi).

## 11. What localDot should borrow, and where to beat Grok Bot

**Borrow:**
1. **Avatar-as-status.** One character carries identity and lifecycle, with hover for the current action. Map [avatar-name]/[avatar-name] to Grok Bot's state vocabulary:
   - sleeping/waking/idle/listening/thinking/searching/working
   - waiting/blocked/done
   - reactions (curious, proud, confused, etc.)
   - Add seeded idle variation, spring physics at a fixed 120 Hz step, dwell and blink ranges like the ones above, `gazeTarget`, and reduced-motion support. Even for a 3D/VRM [avatar-name], keep the **2D "status glyph" version** for sidebars and tray icons.
2. **Three levels of access to the VM:** a status glyph (purple when active), a pinned side preview, and full-screen take-over. Conversation stays primary.
3. **A heterogeneous transcript:** compact tool rows (verb + target + metric), inline widgets, system-event rows, and lettered question cards with "type your own answer".
4. **The take-over protocol:** an Action-needed card with a live thumbnail and Take over / I'm done / Skip, then an in-view amber banner with the Bot's ask plus "Skip this step" / "I'm done, continue". Also persistent sessions and hardware-key passthrough.
5. **A secure secret card** that never reveals the value (to the transcript or the model), including "fill into page without reveal".
6. **Teach-a-task:** a red border plus timer, 10-minute cap, no mic, output a *draft* skill that needs rules and approvals.
7. **Independent Auto-Review model:** natural-language Ask-first/Allow rules where Ask-first wins, per-surface escalation, approvals that expire for unattended runs, and a separate local-exec policy showing the exact command.
8. **OTel-style action events:** tool_call ids as join keys, per-kind action counts, and guardrail rows (loop detection, anti-bot walls).
9. **Presence ideas:** a notch or menu-bar drop-down, corner peek, and a cursor buddy with an app-under-cursor label and window outline. Also the entrance animation ("•••" → character) and a time-of-day wallpaper in the VM.

**Improve on (localDot's differentiators):**
1. **Actually visualize actions**, which Grok Bot deliberately doesn't:
   - a synthetic, eased **ghost cursor** with trails, **click ripples** and press states, a **keystroke HUD** (auto-masked for secret fields), **target highlighting** from DOM/accessibility-tree bounding boxes, scroll and drag indicators, and **per-step captions** synced to the stream;
   - a **scrubbable replay timeline** aligned with transcript rows. Grok Bot has no user replay, and its audit log deliberately drops screenshots, clicks and typed text.
2. **Per-agent isolation.** Grok Bot's single shared VM with all logins is its most-criticized design. Give each persona or bot its own VM, browser profile and credential scope, and avoid one stuck VM killing everything.
3. **"Runtime never holds usable secrets"** goes further than Grok Bot:
   - Grok Bot keeps Bot secrets as env vars on the VM (hidden from UI and model, but present in the runtime [I]) and keeps browser cookies on the VM disk.
   - localDot can instead use an egress credential broker or proxy (header/token injection outside the VM), fill-without-reveal via a trusted browser extension or CDP layer, short-lived capability tokens, and cookie vaulting.
4. **Undo, not just stop.** Snapshot the VM (qcow2 or APFS) before risky steps so actions can truly roll back.
5. **Local-first transparency:** local models, a visible prompt and tool catalog, a model picker, and no cloud IP blocking (residential IP by default on the user's own machine).
6. **Companion fusion.** Make [avatar-name] *look at* the ghost cursor's target (`gazeTarget`), react to outcomes (proud/confused/alerting), and lip-sync TTS. Consider the Animation Inc. idea of environment/state switching driven by conversation emotion, and use AIRI (VRM/Live2D, WebGPU) as a reference implementation.

## 12. Sources

**Primary (SpaceXAI / x.ai):**
- Launch post (2026-08-11): https://x.ai/news/introducing-grok-bot
- Product page: https://x.ai/bot ; Guides index: https://x.ai/bot/guides ; Marketplace: https://x.ai/bot/marketplace ; Use cases: https://x.ai/bot/use-cases
- Design essay (2026-09-03): https://x.ai/news/designing-grok-bot
- Guides:
  - Grok Bot 101 (Matt Palmer, Sep 11): https://x.ai/bot/guides/grok-bot-101
  - Designing Grok Bot with Grok Bot (John Bai, Aug 24): https://x.ai/bot/guides/designing-grok-bot-with-grok-bot
  - Engineering (Lingxi Li, Sep 10): https://x.ai/bot/guides/grok-bot-for-engineering
  - Support (David Gan, Sep 9): https://x.ai/bot/guides/grok-bot-for-support
  - Multiple teams (Aug 27): https://x.ai/bot/guides/how-i-run-multiple-teams-of-grok-bots
  - Templates (Sep 8): https://x.ai/bot/guides/templates-for-grok-bot
- News:
  - https://x.ai/news/grok-bot-more-plans
  - https://x.ai/news/grok-bot-and-x
  - https://x.ai/news/grok-bot-for-enterprise
  - https://x.ai/news/team-bots
  - https://x.ai/news/grok-4-6
  - https://x.ai/news/grok-4-7
  - https://x.ai/news/grok-openclaw
  - https://x.ai/news/grok-hermes
- Launch film: https://media.x.ai/v1/website/260810_2245_bw_dr_cursor_bot_edit_v8-60724aba.mp4
- Design-guide prototype videos:
  - https://media.x.ai/v1/website/grok-bot-guides-designing-grok-bot-with-grok-bot-baby-sand-demo-22c1ed27.mp4 (notch)
  - https://media.x.ai/v1/website/grok-bot-guides-designing-grok-bot-with-grok-bot-corner-peek-e2e844ce.mp4
  - https://media.x.ai/v1/website/grok-bot-guides-designing-grok-bot-with-grok-bot-cursor-buddy-96bdc164.mp4
  - https://media.x.ai/v1/website/grok-bot-guides-designing-grok-bot-with-grok-bot-updated-email-asset-1d7b6109.mp4 (entrance)
- Avatar engine bundle (the design essay's figure): https://x.ai/_next/static/chunks/2d8wko04g-csr.js
- Official walkthrough video (Matt Palmer, SpaceXAI DevRel): https://x.com/mattyp/status/2092286281266962681

**Primary (Cursor docs):**
- https://cursor.com/docs/grok-bot.md
- https://cursor.com/docs/grok-bot/work.md
- https://cursor.com/docs/grok-bot/security.md
- https://cursor.com/docs/grok-bot/security-faq.md
- https://cursor.com/docs/grok-bot/teams.md
- https://cursor.com/docs/grok-bot/settings.md
- https://cursor.com/docs/grok-bot/computers.md
- https://cursor.com/docs/grok-bot/identity.md
- https://cursor.com/docs/grok-bot/private-networks.md
- https://cursor.com/help/grok-bot/how-to.md
- https://cursor.com/help/grok-bot/faqs.md
- https://cursor.com/help/grok-bot/plans.md
- https://cursor.com/help/grok-bot/secrets.md
- https://cursor.com/help/grok-bot/voice-chat.md
- https://cursor.com/help/grok-bot/routines.md
- https://cursor.com/help/grok-bot/computer-recovery.md
- https://cursor.com/help/grok-bot/mobile.md
- https://cursor.com/help/grok-bot/onboarding.md
- https://cursor.com/help/grok-bot/group-chats.md
- https://cursor.com/help/grok-bot/edit-bot.md
- OTel wire reference: https://cursor.com/docs/enterprise/opentelemetry-export/wire.md
- Docs images: https://cursor.com/docs-static/images/grok-bot/avatar-picker-light.png, …/settings-bot-section-light.png, …/onboarding-landing-light.png
- Grok 4.x in Cursor: https://cursor.com/grok

**Reverse engineering:**
- Harness teardown gist: https://gist.github.com/gfsaaser24/9f785c0c095b693b31b5efbcbae7bcd0
- grok.com shipped web config (companion link, `grok-3-mini-companion`): https://grok.com/release-notes (Next.js flight data)

**Hands-on videos:**
- Paul Lipsky: https://www.youtube.com/watch?v=QTcZPI-g7is
- Brock Mesarich: https://www.youtube.com/watch?v=j2WiGVqMczw
- Eli the Computer Guy (title only): https://www.youtube.com/watch?v=yRyMN2WQ3Ok

**Reviews and analysis:**
- https://nervegna.substack.com/p/grok-bot-for-designers-and-product
- https://www.chatprd.ai/how-i-ai/how-i-ai-my-hands-on-review-of-grokbot-cursor-origin-and-the-grok-46-model
- https://www.layer3labs.io/guides/grok-bot-review
- https://michaelbennett.co/blog/grok-bot-shared-computer
- https://pub.towardsai.net/grok-bots-shared-computer-is-not-asecure-1caaecda71eb
- https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/ (search snippet)
- https://interestingengineering.com/ai-robotics/xai-grok-bot-computer-agent (search snippet)

**Corporate / Macrohard:**
- https://en.wikipedia.org/wiki/SpaceXAI
- https://www.cnbc.com/2026/03/11/musk-unveils-joint-tesla-xai-project-macrohard.html
- https://www.businessinsider.com/xai-macrohard-project-tesla-ai-agent-stalls-2026-3
- https://www.mylivingai.com/elon-musks-macrohard-is-supposed-to-launch-this-month/
- https://www.cnbc.com/2026/06/16/spacex-spcx-cursor-acquisition-ipo.html (snippet)
- https://satnews.com/2026/08/13/spacex-finalizes-regulatory-procedures-to-close-60-billion-acquisition-of-ai-platform-cursor/ (snippet)

**Companions:**
- https://en.wikipedia.org/wiki/Grok_(chatbot)
- https://www.testingcatalog.com/grok-debuts-interactive-ai-companions-on-ios-with-anime-avatars/
- https://www.nbcnews.com/tech/internet/grok-companions-include-flirty-anime-waifu-anti-religion-panda-rcna218797
- https://www.engadget.com/ai/groks-ai-chatbot-now-includes-companions-for-you-to-romance-133017601.html
- https://www.wired.com/story/elon-musk-xai-ai-companion-ani/
- https://www.businessinsider.com/xai-pay-you-440k-make-anime-girl-ai-elon-musk-2025-7
- https://www.vinitnair.com/post/my-date-with-ani-xai-s-companion-is-flirty-flawed-and-surprisingly-human
- https://www.animation.inc
- https://x.com/gonchar/status/1886467677658738797 (demo video https://video.twimg.com/amplify_video/1886467592417853440/vid/avc1/1080x1920/SiAZj9h96XHid6Ac.mp4)
- https://www.anichat.ai
- https://github.com/moeru-ai/airi

## Appendix: local artifacts (scratchpad)

Everything is under `/private/tmp/claude-501/-Volumes-Husky-s-SSD-4T-Projects/a10ec47c-ac12-4d82-a4d9-95c7d9d15207/scratchpad/research/`:
- `docs/` — all Cursor Grok Bot docs as .md, plus the OTel wire reference.
- `guides/`, `news/` — x.ai HTML.
- `gist-harness.md` — the full teardown.
- `media/` — guide screenshots, docs images, launch film, prototype videos.
- `video/` — Matt Palmer, Lipsky and Brock videos, transcripts (`mattyp.txt`, `lipsky.txt`), and `frames/` contact sheets:
  - `mp_sheet_0114.jpg` — computer view and desktop
  - `mp_avatar_anim2.png` — working avatar
  - `lp_sheet_0455.jpg`, `lp_takeover_0513.png`, `lp_card_0504.png` — take-over
  - `launch_teach.jpg` — teach-a-task
  - `proto_notch.jpg`, `proto_corner.jpg`, `proto_cursor.jpg`, `proto_entrance.jpg`
- `xaijs/2d8wko04g-csr.js` — avatar engine (extracted segment in `xaijs/avatar_segment.js`).
- `companions/` — companion articles, the animation.inc page, and the Gonchar demo.
