# localDot visualization UX: how the best agents show their work, and what to build

*Research notes, 2026-09-30. They cover three questions:*
- *Task 1: how leading agent products visualize an agent operating a computer or browser.*
- *Task 2: which open-source building blocks can do this at 60 fps in a web UI.*
- *A recommended visualization spec and event schema for localDot.*

**How this was produced.** Seven parallel research threads covered:
- (A) OpenAI / Anthropic / Google
- (B) agentic browsers and browser infrastructure
- (C1) Manus, Genspark, Kimi, MiniMax
- (C2) UI-TARS, Agent TARS, AutoGLM and other Chinese GUI agents
- (D) a source dive into open-source computer-use UIs
- (E1) streaming, compositing, recording and export
- (E2) motion, zoom, overlays, avatar and sound

The lead researcher separately covered newer standouts, the Sept 2026 open-source "agent cursor" wave and HCI studies (§2.6–2.7), and wrote the spec (§4).

Sources used:
- official docs, blogs, help centres and changelogs;
- GitHub source read through the API, with file links;
- official screenshots and GIF frames, inspected directly;
- hands-on reviews.

The session's WebSearch quota ran out midway. Search-engine scraping was deliberately *not* used as a workaround, so later facts come from direct fetches of known URLs and from GitHub. Stars, licenses and push dates come from the GitHub API on 2026-09-30.

**Labels:**
- **[UNVERIFIED]**: not confirmed from a primary or reliable source (the reason is given inline).
- **[inferred]**: the researcher's deduction.
- **[estimate]**: a rough figure.
- UI strings are quoted verbatim.

Sections 2 and 3 reproduce each research thread's report nearly verbatim (headings demoted), so every source URL is kept.

> **Naming alert.** On 2026-09-29 OpenAI launched **"dots"**: always-on agents, each with its own cloud computer and a customizable character, addressed as `@name-dot` (https://learn.chatgpt.com/docs/dots, https://learn.chatgpt.com/docs/whats-new/devday-2026). This overlaps localDot in both name and concept, so check trademark and positioning.
>
> The coordinator's separate OpenAI track did a frame-by-frame analysis. It found **no action overlay**:
> - the cursor teleports;
> - no click ripple;
> - no target boxes;
> - no typing HUD;
> - no replay.
>
> What dots does show:
> - the agent's cloud Linux desktop in a "Computer" tab, framed in the dot's colour;
> - a pill reading "{name} has control · **Take over** / **Return control**";
> - an avatar header with a live status caption;
> - an activity list whose subtitles change tense.
>
> Truthful, element-level action visualization is therefore still open ground, and localDot's opportunity.

## Contents
- 0. Executive summary
- 1. Pattern matrix: who does what best
- 2. Product and project teardowns (Task 1)
  - 2.1 OpenAI, Anthropic, Google
  - 2.2 Agentic browsers and browser infrastructure
  - 2.3 Manus, Genspark, Kimi, MiniMax
  - 2.4 UI-TARS, Agent TARS, AutoGLM and other Chinese GUI agents
  - 2.5 Open-source computer-use UIs (source dive)
  - 2.6 Newer standouts and the Sept 2026 agent-cursor wave
  - 2.7 HCI research on oversight
- 3. Open-source building blocks and techniques (Task 2)
  - 3.1 Streaming, compositing, recording/replay, export
  - 3.2 Motion, auto-zoom, overlays, avatar, sound
- 4. Recommended visualization spec for localDot: overlays, event schema, timing rules, avatar sync, smoothness
- 5. Source index

# 0. Executive summary

## 0.1 Standout patterns and who does them best

1. **Ambient "the agent has control" state**
   - **Best: Edge "Browse with Copilot".**
     - A ~2 px indigo border and a lavender tint on the page.
     - A pill at the top centre reading "**Copilot is browsing**".
     - A large white virtual cursor with a dark tooltip, "**Copilot is working**".
   - **Brave:** a magenta page frame with a floating "**Take over task**" pill.
   - **Claude in Chrome:** a colour-coded tab group with a faint orange hue, and a banner "**Claude is active in this tab group**".
   - **Antigravity:** a blue "Agent Control" border.
   - **UI-TARS:** a blue edge "waterflow" glow (`rgba(30,144,255,.4)`, 5 s breathing, 8 px blur).
2. **The agent cursor as a character**
   - **Best: Codex Computer Use (2026).** Per its designer:
     - a playful curved path;
     - it wiggles while the model thinks;
     - its colour is sampled from whatever is behind it;
     - a soft "fog" halo keeps it legible.
   - **Open-source equivalents:**
     - **cua-driver (MIT):**
       - a Dubins-arc path with speed profile `16u²(1−u)²` and a spring settle;
       - an idle float and a session pill;
       - 12 semantic Lottie states.
     - **lahfir/agent-desktop (Apache-2.0):**
       - a minimum-jerk glide with a slight human swing;
       - a ripple fired only after dispatch;
       - a caller-written label of at most 6 words.
   - **Many products still teleport the pointer:** the Anthropic reference demo (`xdotool mousemove --sync`), Bytebot (nut-js `setPosition`) and OpenAI dots (per the frame-by-frame analysis). UI-TARS-desktop moves the real OS cursor in a fast straight line (NutJS, 3600 px/s) with no easing.
   - **Shipped agent cursors in Chinese products (Aug 2026):**
     - MiniMax Code's built-in browser shows "a visible cursor and movement trail" (v3.0.58).
     - Kimi CU draws an independent overlay cursor and never moves the user's real mouse. It aborts if the user's cursor enters the target window.
3. **Truthful timing.**
   - Hosted products barely document it.
   - The open-source drivers have converged on the same rules (agent-desktop, cua-driver, Codewhale, axscope, sim-mirror):
     - move the drawn cursor first, and dispatch the real input when it lands;
     - fire click effects only after dispatch, and treat them as "delivered", not "succeeded";
     - never let the overlay appear in the agent's own screenshots.
4. **Target marking**
   - **Browser Use:** orange corner brackets (slide in 0.15 s, hold 1.0 s, fade 0.3 s) plus a click ring.
   - **Midscene / UI-TARS report player:** orange `#fd5907` target, teal search area, auto-zoom to the target with 10/20/30% padding tiers.
   - **Anthropic's localization marker:** a 36 px ring in rgb(179,58,50) with a crosshair, centre dot and coordinate chip.
   - **No hosted product shows element boxes to end users.**
5. **Step narration and plans**
   - **Windows Copilot Actions:** a live step chip ("Selecting 8pm as the time slot"), plus "**Working for you**" and "**Take control**".
   - **Opera Neon:**
     - "Here's my plan";
     - a ✦ step log;
     - "Neon's Computer" with an agenda and a 5/5 counter.
   - **Also:** Cowork's Progress checklist, Gemini's progress chip, and dots' tense-changing activity rows.
   - **Manus:**
     - a "{name}'s computer" panel whose subtitle names the active tool ("Manus is using **Terminal**");
     - shimmering action chips such as "Executing command · `mkdir -p …`" (parameter in monospace);
     - a "Task progress · Step 3/7" bar;
     - a 72×48 live thumbnail of the computer.
6. **Handoff**
   - **Named verb pairs:**
     - dots: **Take over** / **Return control**;
     - Gemini: **Take over task** / **Go back to Gemini**;
     - Brave: **Take over task** / **Resume** / **Stop**.
   - **Magentic-UI's three states:**
     1. agent in control;
     2. user pending: "Waiting for the agent to stop...";
     3. user in control: "You are in control of the browser. The agent is paused and won't observe these actions."
   - **Kernel** switches read-only/interactive without reloading the stream.
   - **Replit** shows "**Begin take over**" with a 10-minute skip timeout.
   - **AutoGLM** has an amber `need_takeover` state with a 200 s auto-skip.
   - **Bytebot** converts human takeover input into the agent's own action vocabulary.
   - **Best handoff flow: Genspark GenTeam.**
     - Reason-coded requests: CAPTCHA, sign-in, one-time code, payment step.
     - "**Keyboard captured — what you type goes to the agent's browser.**"
     - An anti-phishing warning: "This request comes from a turn you did not start. Check the address bar before you sign in anywhere."
     - "**Hand back to agent**" with an optional note.
7. **Confirmations**
   - **Best: Anthropic.**
     - Per-app access tiers: view / click / full.
     - Per-site prompt: "**Allow this action / Always allow actions on this site / Decline**".
     - Always asks before permanent deletion or a purchase.
   - **Edge relevance check:** "This page might not be relevant … Should I continue?"
   - **Windows:** "Always allow / Allow once / Not now".
   - **Brave's principle:** avoid prompt fatigue; ask only when a checker model flags an action.
   - **Opera:** stops just before the final checkout click.
   - **Operator:** an injection pause with "Keep paused / Mark safe and resume".
   - **Manus:** scoped grants ("Allow once / for this task / for today / for this page") and a "**Let Manus explain**" button.
   - **MiniMax:** an LLM-written review rationale on every permission card (Ask First → Smart Authorize → Always Authorize).
8. **Replay**
   - **Best: Steel Agent Traces.**
     - Rows read like sentences ("click on Sign in").
     - Typing is grouped and idle gaps are marked.
     - Click a row to seek the video; markers sit on the progress bar.
     - Traces export as markdown for another agent.
   - **Browserbase Agents inspector:** colour-coded event ticks, typed step chips, 1×/2×/4×.
   - **Devin:** future steps grey out when you scrub back.
   - **Kortix follow rule:** stepping back pins the view; reaching the end resumes live.
   - **Manus** is the reference for live-edge scrubbing and for replay as theatre.
     - `ManusComputerTimeline`: Prev/Next and arrow keys, a timestamp tooltip, a green "Live" dot, and a floating "**Jump to live**" pill.
     - Event-sourced share replays: auto-start after a 3 s countdown, events re-fed every 100 ms, "**Skip to results**" and "**Watch again**".
   - **Agent TARS:** a single-file HTML replay with `?replay=1` autoplay.
   - **Claude in Chrome GIF export:** orange click circles, red drag arrows, black action labels, an orange progress bar.
   - **Hosted browser platforms have all moved to video (MP4/HLS) plus an event timeline.** Browserbase deprecated rrweb.
   - **Reviewers found raw replay video dull** (ChatGPT agent), so compress idle time and add chapters.
9. **Companion**
   - **OpenAI Pets** is the only shipped example.
     - Four states, prioritised: needs-input > blocked > ready > running.
     - A sprite-atlas contract, and a still frame under reduced motion.
   - **dots** adds customizable characters.
   - **Kimi Work** (Aug–Sep 2026) has a desktop pet with quick replies in its speech bubble, and Kimi Claw's "give it a name and personality, then wake it up" onboarding.
10. **Nobody ships these yet:**
    - element boxes shown to users;
    - a keystroke HUD;
    - a live auto-zoom camera;
    - live before/after diffs;
    - sound design (Edge even mutes the agent's tab).

    **Slowness is the top complaint everywhere:** Mariner took about 5 s per cursor move, and Claude in Chrome took 10–15 min for a 2–3 min task. Watchable motion and honest waiting states make the wait feel purposeful.

## 0.2 Open-source building blocks (license-clean for an MIT/Apache project)

- **Stream**
  - **pixelflux / Selkies 2.0** (MPL-2.0, released 2026-09-23):
    - WebSocket + WebCodecs, Annex-B H.264;
    - a recording tap and a crash-safe fMP4 recorder;
    - a computer-use HTTP API with `cursor_position`.
  - **Or** `ffmpeg x11grab -draw_mouse 0` with x264 `zerolatency`: about 0.3 core at 1080p60 (measured on an M3 Ultra).
  - **Timing:** put the capture time in µs into `EncodedVideoChunk.timestamp`. It comes back unchanged on `VideoFrame.timestamp`, which gives exact event-to-frame sync.
  - **Pointer:** position and shape from XFixes.
  - **macOS guests:** Lume (MIT) → `_VZVNCServer` → host RFB bridge → VideoToolbox. Apple's licence allows 2 extra VMs per Mac.
  - **Avoid noVNC as the main path:** it never receives the remote pointer position.
- **Composite**
  - WebCodecs decoding in a worker, drawing with WebGL2 (WebGPU optional) on an OffscreenCanvas.
  - **PixiJS v8** (MIT) draws the video and every time-critical overlay with **one camera matrix** in a single requestAnimationFrame loop.
  - DOM is only for chrome anchored to the screen.
- **Record and replay**
  - fMP4 with a 1–2 s GOP and `-write_prft wallclock`.
  - Action markers written as MP4 chapters (Kernel's pattern).
  - Events in JSONL on the same host clock.
  - **mediabunny** (MPL-2.0) for frame-accurate scrubbing and thumbnails.
  - rrweb only as an optional source of DOM semantics.
- **Export**
  - The same compositor → `VideoEncoder` → mediabunny MP4, as OpenScreen (MIT) does.
  - **HyperFrames** (Apache-2.0) as an optional cinematic renderer.
  - **Avoid** Remotion (company licence, telemetry) and ffmpeg.wasm (GPL, 0.04–0.08× real-time).
- **Motion**
  - **Motion** (MIT) physics springs, which keep velocity across retargets, plus **bezier-js** (MIT).
  - Ideas and constants to port:
    - matinee (MIT): seeded minimum-jerk motion, identical live and in replay;
    - the cua-driver cursor (MIT);
    - agent-desktop (Apache-2.0);
    - Screenize's intent-driven camera (Apache-2.0);
    - OpenScreen's zoom and export (MIT).
  - **Numbers and ideas only, no code** (AGPL/GPL): Cap, Recordly, Screenity, Keyviz.
- **Overlays and HUD**
  - Browser Use highlight constants (MIT).
  - Magnitude's typing HUD (Apache-2.0).
  - KeyCastr's semantics (BSD-3).
  - Tarko's MouseCursor, replay and event types (Apache-2.0).
  - Midscene's player and camera maths (MIT).
- **Avatar**
  - **Default:** a code-driven SVG/Canvas avatar that any contributor can edit.
  - **Optional skins:**
    - **Rive:** runtime is MIT, but the free editor cannot export `.riv`, and Inputs are deprecated in favour of Data Binding;
    - **dotLottie:** MIT, ThorVG, can render in a worker;
    - **three-vrm:** MIT, `VRMLookAt`.
  - Keep **Live2D** (proprietary SDK licence) and **Spline** (no licence) out of the core.
- **Sound:** Web Audio or ZzFX (MIT, about 1 KB); Howler for sample playback.

## 0.3 The recommended spec in brief (details in §4)

- **The core loop:**
  1. `intent`: target bbox, role, name, and a label of at most 6 words, shown *before* acting.
  2. A deterministic pointer path.
  3. `dispatch`: the real input, injected the moment the drawn cursor lands.
  4. The effect, which means "delivered", not "succeeded".
  5. `settle`: the regions that changed.
  6. `verify`: success or failure.
- **One host clock.** Overlays render at the *capture time of the frame on screen*, never at event-arrival time, and never more than one frame ahead of the newest decoded frame.
- **Overlays never enter the VM or the model's screenshots.**
- **P0 (build first):**
  - **Agent cursor:** coloured fill, white rim, fog halo, name chip.
  - **Target highlight:** corner brackets or a box, with a role/name chip, morphing from target to target.
  - **Click effect:** a press and a ring.
  - **Status pill** containing **Take over** and **Stop**, plus an agent-control frame and tint.
  - **Step timeline** in Steel's style, with thumbnails.
  - **Typing HUD** with KeyCastr semantics and masked secrets.
  - **Approval sheets** anchored to the target.
  - **Basic replay:** skip idle, jump to live, follow rule.
- **P1:**
  - An intent-driven auto camera: gentle in live view, cinematic in replay.
  - A flash on changed regions, and a before/after compare.
  - Terminal and diff panels that follow the agent.
  - "Agent vision": what the model saw.
  - Avatar gaze sync.
  - Exports: MP4 reel, GIF, single-file HTML, markdown trace.
- **P2:**
  - Cursors for multiple agents.
  - A sound pack.
  - A provenance inspector and a summary of persistent changes.
  - An intent-preview countdown for medium-risk steps.
- **Timing:**
  - Travel `T = clamp(150 + 100·log2(D/W + 1), 220, 700) ms ÷ speed`.
  - Highlight, label, camera and avatar gaze start at intent; the cursor departs 120 ms later.
  - A 90 ms dwell before the press.
  - In Watch mode, at most 800 ms of blocking presentation per action.
- **Avatar:**
  - One "attention point" with a fixed priority order drives its gaze.
  - At intent, the eyes saccade to the target. This leads the hand by about 0.35–0.8 s, matching the ~0.56 s eye-hand lead measured in humans.
  - Reactions come only from semantic events.

# 1. Pattern matrix: who does what best

| Pattern | Best in class | Strong runners-up | Gap / note |
|---|---|---|---|
| Ambient "agent has control" | Edge (indigo border + tint + "Copilot is browsing" pill + cursor tooltip) | Brave magenta frame + "Take over task"; Claude orange tab group; Antigravity "Agent Control" border; UI-TARS edge glow | — |
| Agent cursor motion | Codex Computer Use (curved path, thinking wiggle, adaptive colour, fog halo) | cua-driver (Dubins path + speed profile + spring settle); agent-desktop (minimum-jerk + swing); Tarko replay cursor (0.5 s, ease `[0.16,1,0.3,1]`); MiniMax Code browser cursor + movement trail; Kimi CU overlay cursor | Many hosted agents teleport the pointer |
| Cursor label / identity | Edge ("Copilot is working" tooltip) | agent-desktop label card (≤6 words); cua session pill (name, delivery and target chips); sim-mirror name chip | — |
| Truthful timing (arrive, then act) | agent-desktop (travel acknowledged before dispatch; ripple only after dispatch) | cua-driver; axscope (glide returns its duration); Codewhale | Not documented in hosted products |
| Target highlight | Browser Use corner brackets (0.15 s / 1.0 s / 0.3 s) | Midscene orange target + teal search area; Anthropic crosshair marker; Stagehand `Overlay.highlightNode` | No hosted product shows boxes to users |
| Click marker | agent-desktop (neutral ripple, after dispatch) | Browser Use ring (0.3 → 1 → 1.5); Claude GIF orange circles; Tarko indigo double ripple | — |
| Typing / keystroke HUD | Magnitude keycaps (open source; ≤5 keys, 2 s) | KeyCastr / Screen Studio "show shortcuts" semantics; Steel groups typing in its trace | No agent product has one |
| Auto-zoom / camera | Screenize intent-driven camera (open-source recorder) | Midscene / UI-TARS report-player auto-zoom; cua `render --scale 2.5`; Cap / OpenScreen | No live agent product has one |
| Live step narration | Windows Copilot Actions step chip + "Working for you" | Edge status dot + reasoning line; Neon ✦ log; dots' tense-changing subtitles | — |
| Plan / progress | Opera Neon (plan first; "Neon's Computer" agenda 5/5) | Cowork Progress checklist; Chrome "review plan → Start Task"; Gemini progress chip; Perplexity Computer checklists | — |
| Terminal / file / tool panels | Manus ("{name}'s computer" panel naming the active tool; terminal, Monaco editor/diff, per-action browser screenshots, search cards) | Kortix (Suna) tool-view registry; Kimi OK Computer (terminal, iPython, diff, files, todo); Devin's unified Progress timeline | — |
| Before / after | Agent TARS Before / After / Both switch | UI-TARS markers baked into stored screenshots | No live product |
| Take control | Genspark GenTeam (reason codes, "Keyboard captured" banner, anti-phishing warning, "Hand back to agent" + note) | dots / Gemini / Brave named verb pairs; Magentic three-state handshake; Kernel read-only toggle without reload; Replit timeout | — |
| Sensitive-action confirmation | Anthropic (tiers + Allow / Always / Decline) | Edge relevance check; Windows 3-way prompt; Operator injection pause; AutoGLM "sensitive operation" card; Manus scopes + "Let Manus explain"; MiniMax LLM rationale | — |
| Replay | Steel Agent Traces (video + sentence rows + click-to-seek) | Manus live-edge timeline + event-sourced share replay (3 s auto-start, Skip to results); Browserbase Agents inspector; Devin time-travel greying; Kortix follow rule; Tarko HTML replay | Raw video alone is dull (ChatGPT agent review) |
| Share / export | Claude in Chrome GIF with overlays | Tarko single-file HTML (`?replay=1`); cua zoom-on-click MP4; Midscene branded WebM | — |
| Companion avatar | OpenAI Pets (4 states, priority order, reduced-motion still) | Kimi Work desktop pet (quick replies in its bubble); AIRI / Open-LLM-VTuber emotion tags mapped to expressions; Clippy.js gesture vocabulary | — |
| Parallel sub-agents | Kimi Agent Swarm (staged "recruiting" copy, per-agent status incl. "clocked off", computer view ↔ activity trail toggle) | Manus Wide Research (subtask list, skip incomplete, per-subtask replays) | — |
| Boot / waiting copy | Genspark ("Starting the browser… this can take up to ~10 s") | Kimi "is booting up…"; Z.ai "Agent is putting on safety helmet" | — |
| Sound | — | Screen Studio click sound (a recorder, not an agent) | Nobody (Edge mutes the agent's tab) |

# 2. Product and project teardowns (Task 1)

## 2.1 OpenAI, Anthropic, Google

*Research thread A (OpenAI kept brief by request; a separate OpenAI track exists). Report reproduced with headings demoted.*

**How this was researched.** The session's WebSearch budget ran out early. After that I used only WebFetch and curl on primary docs, blogs, help centres and GitHub source, YouTube oEmbed and description metadata, and hands-on reviews I had already found. No search-engine pages were scraped. Anything I couldn't confirm is marked **[UNVERIFIED]** or "not found". Article prose is paraphrased; UI strings and control labels are given verbatim in **bold** or `code`. After your scope change, OpenAI is kept brief. Housekeeping: I wrote one temp file (`operator.html`) to the scratchpad by mistake and deleted it right away. No other files were created.

---

### 0. 2026 changes that matter for localDot

- **OpenAI**
  - Atlas was deprecated on 2026-07-09 and stopped working on 2026-08-09 ([ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)).
  - The new ChatGPT desktop app (2026-07-09) combines Chat, Work and Codex. Computer Use lives there.
  - At DevDay on **2026-09-29** OpenAI launched **dots**: always-on agents that have their own cloud computer and browser and a **customisable character** (shape, colour, eyes, glasses, accessories). The handle format is `@name-dot` ([dots docs](https://learn.chatgpt.com/docs/dots), [DevDay 2026](https://learn.chatgpt.com/docs/whats-new/devday-2026)). **This overlaps localDot in both name and concept. Flag it.**
  - OpenAI also ships **Pets**: animated desktop companions mapped to agent state (see §1).
- **Anthropic**
  - Claude can now use the real desktop in Cowork and Claude Code (research preview, 2026-03-23).
  - Claude in Chrome became generally available on 2026-08-26, with a classifier that auto-approves actions.
  - Cowork merged into the main Claude app on 2026-09-16 ([blog](https://claude.com/blog/cowork-is-now-claude)).
- **Google**
  - Project Mariner shut down on **2026-05-04** ([labs.google.com/mariner](https://labs.google.com/mariner/)). Its work moved into **Gemini Spark** (2026-05-19).
  - Chrome **auto browse** (2026-01-28) is Google's in-browser agent.

---

### 1. OpenAI (brief; another track covers this)

- **Operator** (2025-01-23; since folded into ChatGPT agent, and the Operator site is gone per [help](https://help.openai.com/en/articles/11752874-chatgpt-agent))
  - Layout: chat on the left, a cloud-hosted Chrome on the right ([Simon Willison](https://simonwillison.net/2025/Jan/23/introducing-operator/)).
  - Takeover: the user can take the remote browser at any time. While they do, Operator neither records nor screenshots what they enter ([OpenAI](https://openai.com/index/introducing-operator/)).
  - Watch mode on sensitive sites such as Gmail: the task pauses if the user goes idle or leaves the page. The dialog offers **Keep paused** / **Monitor task** ([system card](https://openai.com/index/operator-system-card/)).
  - Prompt-injection monitor: pauses with a "Review potential risk to resume task" dialog offering **Keep paused** / **Mark safe and resume** (Simon).
  - Reviewer complaints ([Zvi roundup](https://thezvi.wordpress.com/2025/01/28/operator/)):
    - misclicks by a few pixels;
    - takeover felt clunky because users had to switch back and forth between screens;
    - demo videos were sped up 4×.
  - Scale of the demos: CUA demos ran to 146–152 steps ([Sherwood](https://sherwood.news/tech/openais-operator-slowly-take-over-your-computer-mess-up-your-life/)).
- **ChatGPT agent** (2025-07-17)
  - During a run: on-screen narration of each step, plus interrupt and take-over controls, and a phone notification when it finishes ([OpenAI](https://openai.com/index/introducing-chatgpt-agent/)).
  - Login handoff is **… → Take over browser**. No screenshots are taken while the user controls it, and the agent then tries to resume from where it was ([help](https://help.openai.com/en/articles/11752874-chatgpt-agent)).
  - After a run: a pausable video replay plus a text timeline of reasoning, commands and file operations. The reviewer found the video dull once the novelty wore off ([DataCamp](https://www.datacamp.com/tutorial/chatgpt-agent)).
  - The virtual cursor is visible while it navigates. Small tasks often took 15–20 minutes ([hands-on](https://aiblewmymind.substack.com/p/i-tested-chatgpt-agent-on-real-work)); OpenAI's own average is 10–15 minutes ([Wired](https://www.wired.com/story/openai-chatgpt-agent-launch/)).
  - The MIT index describes two switchable views: an Activity view (reasoning plus actions) and a Desktop view with abstracted windows ([MIT AI Agent Index](https://aiagentindex.mit.edu/2025/chatgpt-agent)).
- **Atlas agent mode** (2025-10-21 → shut down 2026-08-09)
  - Browser chrome highlighted blue ([Wikipedia](https://en.wikipedia.org/wiki/ChatGPT_Atlas)).
  - A sparkle overlay, tooltip-style narration (for example **Opening the first result**), and a bottom bar with **Take control** and **Stop** ([Simon](https://simonwillison.net/2025/Oct/21/introducing-chatgpt-atlas/); [PCMag via Yahoo](https://tech.yahoo.com/ai/chatgpt/articles/chatgpts-atlas-browser-shows-potential-120000650.html)).
  - The 2025-10-28 release notes added animated agent scrolling and a separate agent clipboard ([release notes](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes)).
  - Simon likened watching it to a first-time user learning the mouse.
- **Codex / ChatGPT Computer Use** (Codex on macOS 2026-04-16; Windows 2026-05-29; ChatGPT Work 2026-07-09)
  - Runs in the background with "its own cursor". Parallel cursors don't bring apps to the foreground. It reads the accessibility tree as well as screenshots ([MacStories](https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested/)).
  - **Cursor spec, from the designer** ([Kieraj Mumick on X](https://x.com/kierajmumick/status/2044835383981269430)):
    - it takes a playful, curved path between points;
    - it wiggles while the model is thinking;
    - its colour is sampled from the wallpaper directly behind it;
    - a soft "fog" halo keeps the small cursor visible.
  - App approval prompt: `Allow Codex to use Calculator?` with **Always allow** ([docs](https://learn.chatgpt.com/docs/computer-use)).
  - On Windows it runs in the foreground and takes over the pointer; OpenAI suggests using a VM.
  - "Locked use" covers every display while the Mac is temporarily unlocked, and relocks as soon as it detects local keyboard or mouse input.
  - A Computer Use picture-in-picture window can dock to the pet ([pets docs](https://learn.chatgpt.com/docs/pets)).
- **Pets** — the closest existing analogue to localDot's avatar
  - A floating companion showing **Running / Needs input / Ready / Blocked**.
  - When several chats are active it prioritises needs-input, then blocked, then ready, then running.
  - Reduced-motion setting shows a still frame instead.
  - Sprite atlas contract ([hatch-pet skill](https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet)):
    - 1536×1872 pixels, 8×9 grid of 192×208 cells;
    - rows are idle, running-right, running-left, waving, jumping, failed, waiting, running, review.
  - Example frame timings:

| Row | Frame timings |
|---|---|
| idle | 280/110/110/140/140/320 ms |
| running (the "working" state, not literal running) | 120 ms ×5, then 220 ms |
| waiting (asking for input) | 150 ms ×5, then 260 ms |
| failed | 140 ms ×7, then 240 ms |

- **dots**
  - The computer panel is titled **{name}'s computer** and shows the status **{name} has control**.
  - Controls are **Take over** and then **Return control**. Simply opening the computer does not give you control ([docs](https://learn.chatgpt.com/docs/dots/computers-and-apps)).
- **API**
  - The live computer-use guide now recommends code execution (PyAutoGUI or Playwright) for GPT-6 Astra. The structured `computer` tool is still supported ([guide](https://platform.openai.com/docs/guides/tools-computer-use)).
  - `openai-cua-sample-app` has been rewritten as a console with **Start Run** / **Stop**, a screenshot timeline and a replay JSON ([repo](https://github.com/openai/openai-cua-sample-app)).

---

### 2. Anthropic

#### 2.1 Computer use API and reference demo (2024-10-22 → 2026)

- **Launch**
  - Public beta with Claude 3.5 Sonnet via the API, Bedrock and Vertex. It scored 14.9% on OSWorld (screenshot-only) against 7.8% for the next best system.
  - Anthropic called it cumbersome and error-prone; scrolling, dragging and zooming were hard ([announcement](https://www.anthropic.com/news/3-5-models-and-computer-use)).
- **How it perceives the screen**
  - Screenshots only; the model counts pixels to aim the cursor.
  - Anthropic calls this a "flipbook" limitation: short-lived notifications can be missed between frames ([developing computer use](https://www.anthropic.com/news/developing-computer-use)).
  - Known mishaps: it stopped a long screen recording by accident, and it wandered off to look at Yellowstone photos.
- **Launch videos** (all 2024-10-22):
  - [Computer use for automating operations](https://www.youtube.com/watch?v=ODaHJzOyVCQ) (2:03; search tabs, then fill a form);
  - [Computer use for orchestrating tasks](https://www.youtube.com/watch?v=jqx18KgIzAE) (2:04);
  - [Computer use for coding](https://www.youtube.com/watch?v=vH2f7cjXjKI) (3:03).
  - Each description says Claude generated every action shown, and that the environment was controlled with some infrastructure simplified.
- **Reference demo layout** ([computer-use-demo](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo))
  - Stack: Xvfb, mutter, tint2 taskbar, x11vnc, noVNC.
  - `localhost:8080` is a flex row: the Streamlit chat iframe (flex 1) beside the noVNC iframe (flex 2).
  - noVNC is loaded with `resize=scale&view_only=1&reconnect=1&reconnect_delay=2000`, so it is scaled to fit (letterboxed) and view-only by default.
  - A floating top-right button switches **Toggle Screen Control (Off)** ↔ **(On)** by reloading the iframe with `view_only=0` ([index.html](https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/image/static_content/index.html)).
- **Reference demo chat panel** ([streamlit.py](https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/computer_use_demo/streamlit.py))
  - Every tool call appears as a code block (`Tool Use: computer` / `Input: {...}`), with screenshots inline and an optional `[Thinking]` block.
  - Sidebar: **Only send N most recent images** (default 3) and **Hide screenshots**.
  - Tabs: **Chat** / **HTTP Exchange Logs**. The stop button is styled red.
  - An interruption is recorded in the transcript as the user having stopped and written a follow-up.
- **Reference demo motion** ([computer.py](https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/computer_use_demo/tools/computer.py))
  - **The cursor teleports**: `xdotool mousemove --sync x y`.
  - Typing is `xdotool type --delay 12` in 50-character chunks.
  - It waits 2.0 s after an action before taking a screenshot, and screenshots include the pointer (`scrot -p`).
  - Scaling targets: XGA 1024×768, WXGA 1280×800, FWXGA 1366×768. The README recommends XGA, with black padding for small screens.
- **2026 state**
  - The README now defaults to Claude Opus 4.8. The newest tool shape is `computer_toolset_20260801`.
  - A new macOS-native [computer-use-best-practices](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-best-practices) repo adds batched actions and trajectory recording.
  - Its Streamlit trajectory viewer has a **Show through turn** slider, `turn i / n` captions and thinking in expanders.
  - It also has a **localization demo** with a ready-made click-marker spec (per [index.html](https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-best-practices/dev_ui/localization_demo/static/index.html), which says it matches Anthropic's eval-tool style):
    - a 36 px translucent ring in rgb(179,58,50) at 10% fill, with a 1.5 px border at 80%;
    - crosshair lines extending 6 px past the ring, and a 4 px centre dot;
    - a monospace coordinate chip above the ring (11 px white on rgba(0,0,0,.6));
    - side-by-side panes for the downscaled image sent to the model and the original.
  - The [best-practices post](https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude) (2026-05-13) says to start at 1280×720 (1080p for Opus 4.7), pre-downscale screenshots, and use `enable_zoom` on dense UIs.
- **Browser demo**: [browser-use-demo](https://github.com/anthropics/anthropic-quickstarts/tree/main/browser-use-demo) keeps a DOM element map (`window.__claudeElementMap`, with `ref_N` role/name references) and a `find` action that highlights matches. This is the same ref vocabulary Claude in Chrome uses.

#### 2.2 Claude in Chrome (pilot 2025-08-25 → GA 2026-08-26)

- **Timeline** ([blog](https://claude.com/blog/claude-for-chrome) with dated updates)
  - 2025-08-25: pilot with 1,000 Max users.
  - 2025-11-24: beta for all Max users, adding scheduled tasks and multi-tab workflows.
  - 2025-12-18: all paid plans, plus the Claude Code integration.
  - 2026-08-12: the side panel became a full Cowork session; **Switch back to classic** is in the ⋯ menu ([blog](https://claude.com/blog/cowork-chrome-side-panel)).
  - 2026-08-26: generally available. Actions are auto-approved when a classifier judges them safe and on-task; this can be turned off ([GA post](https://claude.com/blog/claude-in-chrome-generally-available)).
- **Ambient cues**
  - Claude's tabs go into their own colour-coded tab group ([help](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)). Users can drag more tabs into that group so Claude works across them ([product page](https://claude.com/claude-in-chrome)).
  - Per a DataCamp hands-on, the tab borders take on a faint orange hue while Claude works, and a green bottom banner says **Claude is active in this tab group** ([DataCamp](https://www.datacamp.com/tutorial/claude-for-chrome-ai-powered-browser-assistance-automation)).
  - Actions happen live in a visible Chrome window. The tab group is tied to the session, and `/clear` closes it ([Claude Code docs](https://code.claude.com/docs/en/chrome)).
  - No agent cursor overlay is documented (not found).
- **Permissions**
  - Three modes ([permissions guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)):
    - **Manually approve** (formerly **Ask before acting**);
    - **Automatically approve** (the Cowork default);
    - **Skip all approvals** (formerly **Act without asking**).
  - Per-site prompt: **New permissions required**, shown in the side panel, with **Allow this action** / **Always allow actions on this site** / **Decline**.
  - Claude Code's version of the dialog begins `Claude in Chrome wants to`.
  - Purchases and other irreversible actions always wait for the user. At pilot, finance, adult and piracy sites were blocked outright.
  - Claude pauses on logins and CAPTCHAs for the user to handle.
- **Replay**
  - GIF export. Per the extension's `gif_creator` tool definition (seen in this session's Claude-in-Chrome MCP schema, not a public web page), it draws:
    - **orange circles** at click locations;
    - **red arrows** for drags;
    - **black action labels**;
    - an **orange progress bar** along the bottom;
    - a Claude **logo watermark**.
  - GIF quality ranges 1–30 (default 10).
  - Other features: a **record** icon to teach a workflow (classic panel only), `/` shortcuts, a clock icon for scheduled tasks, and notifications when Claude needs permission or finishes.
- **Safety numbers**
  - 2025: attack success fell from 23.6% to 11.2%, and browser-specific attacks from 35.7% to 0%.
  - 2026 GA: 0% against Sonnet 5 and Opus 5 when probes and the classifier are both on.
- **Where it feels janky**
  - A task that takes 2–3 minutes by hand took 10–15 minutes. Claude also renamed the user's tab groups and closed tabs without asking ([Ernest Chiang](https://www.ernestchiang.com/en/posts/2025/claude-for-chrome/)).
  - Five form submissions took about 50 minutes versus about 10 for a person, because every interaction needs a fresh screenshot (DataCamp).

#### 2.3 Claude Cowork (2026-01-12 → merged into Claude 2026-09-16)

- **Launch UI** ([Simon Willison](https://simonwillison.net/2026/Jan/12/claude-cowork/); [video](https://www.youtube.com/watch?v=UAmKyyZ-b9E))
  - A Cowork tab next to Chat and Code, with **+ New task**.
  - Right sidebar: a **Progress** section with circular checked/pending indicators and a "steps will appear" placeholder; steps expand to show command details.
  - **Context** section listing **Selected folders** and **Working files**.
  - Work runs in a Linux VM (Apple Virtualization, `VZVirtualMachine`).
  - A bug at launch squeezed artifact previews into a thin column.
- **Modes and prompts**
  - **Manual / Auto / Skip**, set from a mode selector in the chat box.
  - There is always a prompt before permanently deleting files ([help](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)).
  - The product page promises visibility into each file opened, tool used and choice made, and says Claude takes over the screen only when it must ([product](https://claude.com/product/cowork)).
- **Built-in browser** (2026-08-26): opens in the side panel next to the task, uses a separate profile, supports cookie import, and asks before first acting on a site ([blog](https://claude.com/blog/cowork-built-in-browser); [help](https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork)).
- **Web and mobile** (2026-07-07): scheduled tasks run with no device online, decision prompts go to the phone, and nothing ships until the user approves ([blog](https://claude.com/blog/cowork-web-mobile)).

#### 2.4 Claude on the user's real desktop (2026-03-23)

- **Launch**
  - Research preview in Cowork and Claude Code on macOS and Windows for Pro and Max, paired with Dispatch (tasks sent from the phone) ([blog](https://claude.com/blog/dispatch-and-computer-use)).
  - Claude tries connectors, then Bash, then Chrome, and uses the screen only as a last resort. Some apps are off-limits by default.
- **Background mode**: on macOS 15+ Claude works in background windows. It doesn't take the user's pointer or keyboard and generally waits while they are typing. A **Full control** setting lets it take over the screen instead ([safety guide](https://support.claude.com/en/articles/14128542)).
- **Foreground mode**: other apps are hidden while Claude works and restored afterwards (the **Unhide apps when Claude finishes** setting).
- **Per-app approvals** ([desktop docs](https://code.claude.com/docs/en/desktop))
  - **Allow for this session** / **Deny**; in Dispatch sessions an approval lasts 30 minutes.
  - Access tiers: view-only for browsers and trading apps, click-only for terminals and IDEs, full control for everything else.
  - Extra warnings on risky apps: `Equivalent to shell access`, `Can read or write any file`, `Can change system settings`.
- **CLI version** ([docs](https://code.claude.com/docs/en/computer-use))
  - A macOS notification reads `Claude is using your computer · press Esc to stop`.
  - **Esc** aborts from anywhere, and the key press is consumed so injected content can't use it to dismiss dialogs. A second notification appears when Claude finishes.
  - The terminal is excluded from screenshots, only one session can hold the lock, and screenshots are downscaled (3456×2234 → about 1372×887).

---

### 3. Google

#### 3.1 Project Mariner (2024-12-11 → shut down 2026-05-04)

- **Launch**
  - A Gemini 2.0 prototype running as a Chrome extension.
  - It could only type, scroll and click in the active tab, and asked for final confirmation before sensitive actions such as purchases. WebVoyager score 83.5%; Google admitted it was slow ([blog](https://blog.google/technology/google-deepmind/google-gemini-ai-update-december-2024/)).
- **Hands-on**
  - A chat window opened to the right of the page, with about **5 s between cursor moves**.
  - The user couldn't do other work meanwhile, and it couldn't check out. Making users watch was a deliberate design choice ([TechCrunch](https://techcrunch.com/2024/12/11/google-unveils-project-mariner-ai-agents-to-use-the-web-for-you/)).
- **Demo honesty**: the [demo video](https://www.youtube.com/watch?v=2XJqLPqHtyo) says it was sped up and links to the full unedited run.
- **I/O 2025 update**
  - Moved to cloud VMs, with up to **10 simultaneous background tasks** ([TechCrunch](https://techcrunch.com/2025/05/20/google-rolls-out-project-mariner-its-web-browsing-ai-agent/)).
  - **Teach & Repeat**: show a task once and it learns a plan for similar tasks.
  - Available on AI Ultra ($249.99/month) ([keynote](https://blog.google/technology/ai/io-2025-keynote/); [Verge](https://www.theverge.com/news/670848/google-agent-mode-gemini-app-project-mariner-i-o-2025)).
- **Not found**: Mariner's cursor styling and the layout of the multi-task dashboard.

#### 3.2 Gemini Agent (2025-11-18) → Gemini Spark (2026-05-19; macOS 2026-06-30)

- **Gemini Agent** launched on the web for Ultra subscribers in the US. It confirmed before critical actions and could be paused or taken over at any time ([blog](https://blog.google/products/gemini/gemini-3-gemini-app/); [release notes](https://gemini.google/release-notes/)).
- **Gemini Spark** is a 24/7 agent that keeps working with the user's devices off. Its status strings are **Spark is working...** and **Thinking through it...** ([overview](https://gemini.google/overview/agent/spark)).
- **Handoff flow** ([help](https://support.google.com/gemini/answer/17094507))
  - A **Remote computer** icon at the top of the task thread opens Gemini's browser.
  - Taking over is two steps: **Take over task**, then confirm **Take over task**.
  - Handing back is **Go back to Gemini**; stopping is **Stop response**.
- **Progress**
  - A **progress chip** at the top of the thread opens the list of completed steps.
  - Unread threads are shown in bold ([tasks help](https://support.google.com/gemini/answer/17094196)).
- **Confirmations**: before sending messages, changing data, purchases, form submissions, and Sign in with Google.

#### 3.3 Gemini in Chrome agentic browsing and auto browse

- **Timeline**
  - 2025-09-18: announced ([blog](https://blog.google/products/chrome/chrome-reimagined-with-ai/)).
  - 2026-01-28: auto browse preview for AI Pro and Ultra in the US, alongside a side-panel redesign ([blog](https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/)).
  - 2026-08-18: Android ([blog](https://blog.google/products-and-platforms/products/chrome/gemini-in-chrome-android-auto-browse/)).
- **Flow** ([help](https://support.google.com/chrome/answer/16821166))
  - Ask in the side panel, review the plan, then **Start Task**.
  - An **auto browse icon** sits on the tab the agent is using.
  - When it needs the user, a notification appears at the top of the browser: **Check your task**, with **Switch tabs** to jump to it.
  - **Take over task** is on the task tab; **Resume** or **Give back task** hands control back; **Stop** is in the side panel.
- **Work log and guardrails** ([security architecture](https://blog.google/security/architecting-security-for-agentic/), 2025-12-08)
  - Each step goes into a work log the user can watch live; they can pause and take over at any point.
  - It must confirm before visiting sensitive sites from a fixed list (banking, medical), before signing in via Password Manager, and before purchases or messages. At checkout it stops and asks the user to finish.
  - A separate User Alignment Critic model vetoes off-task actions; after repeated vetoes, control returns to the user.
- **Limits**: 20 multi-step tasks a day on Pro, 200 on Ultra. **Not found**: any official glow or border colour.

#### 3.4 Gemini 2.5 Computer Use model (2025-10-07)

- **Model scope** ([blog](https://blog.google/technology/google-deepmind/gemini-computer-use-model/))
  - Optimised for browsers, promising on mobile, not yet for desktop OS control.
  - Demos are shown at **3× speed**: [Pet Spa](https://www.youtube.com/watch?v=_lu-FcPUIfM) (79 s) and [Sticky Notes](https://www.youtube.com/watch?v=slOLc1nkKY0) (35 s, drag-and-drop).
  - Each step sends a screenshot plus the current URL. A per-step safety service can demand user confirmation.
- **API details useful for overlays** ([docs](https://ai.google.dev/gemini-api/docs/computer-use))
  - Coordinates are normalised to 0–999 on both axes; the docs suggest a 1440×900 screen.
  - `safety_decision` is one of regular, `require_confirmation`, or blocked.
  - **Gemini 3.x returns a per-action reasoning "intent"**, which is ready-made caption text for each action.
- **Demo site**: [gemini.browserbase.com](https://gemini.browserbase.com) is now a "Gemini Browser" demo on gemini-3.5-flash via Browserbase and Stagehand, with preset tasks and a Run button. Browserbase's [eval post](https://www.browserbase.com/blog/evaluating-browser-agents) is more about evaluation infrastructure than UI.

---

### 4. Computer use on the user's real desktop (2026)

| | Name / launch | Visual presence | Stop and ownership |
|---|---|---|---|
| **OpenAI** | "Computer Use" plugin: Codex macOS 2026-04-16, Windows 2026-05-29, ChatGPT Work 2026-07-09 | macOS: its own animated cursor, runs in the background, parallel cursors, a PiP window that can dock to the pet | Windows: foreground, takes the pointer. Stop or take over from task controls. **No documented hotkey.** |
| **Anthropic** | "Computer use": Cowork and Claude Code desktop, 2026-03-23 (macOS and Windows; the CLI is macOS-only per its docs, launch date not found) | macOS 15+ background mode, no pointer takeover, waits while the user types; otherwise hides other apps | CLI: `Esc` notification and global Esc. **No documented cursor overlay or glow.** |
| **Google** | No official desktop-app control confirmed; Spark on Mac is documented only for files and folders ([help](https://support.google.com/gemini/answer/17208717)) | — | — |

The codenote article you forwarded says Gemini desktop computer use was a closed beta as of 2026-08 ([codenote](https://codenote.net/en/posts/computer-use-agents-macos-windows-selection-notes-2026/)). **[UNVERIFIED]**: single secondary source.

---

### 5. Cross-product takeaways

1. **Treat the agent cursor as a character, not a pointer.** Nobody else animates it; the Anthropic reference demo teleports it with xdotool. Codex does this best: curved path, a wiggle while the model thinks, colour sampled from what's behind it, and a fog halo for contrast. Animating between action points also hides screenshot latency.
2. **Show clearly who has control, and name both handoff verbs.** Good examples:
   - dots: **{name} has control** · **Take over** / **Return control**;
   - Gemini: **Take over task** / **Go back to Gemini**;
   - ChatGPT Work: **Sign in on web page instead** → **I'm done**.

   Keep viewing and controlling separate: Anthropic's noVNC is `view_only=1` by default behind **Toggle Screen Control**, and in dots opening the computer isn't taking control. Operator's rule of not screenshotting during takeover is worth copying.
3. **Use an ambient "agent is driving" frame, scoped to what the agent touches.** Examples: Claude's colour-coded tab group with orange border hue (the best-scoped), Atlas's blue tint plus sparkles, Chrome's per-tab auto-browse icon. For localDot, a coloured frame around the VM stream that changes when the user takes control.
4. **Plan first, then a live work log.** Chrome (review plan → **Start Task**, then work log), Cowork (Progress checklist with circles) and Spark (progress chip) all do this. Pair each log step with its screenshot thumbnail; no product does that yet.
5. **Use scoped, tiered permissions with plain wording.** Anthropic does this best: view / click / full tiers, sentinel warnings on risky apps, the **Allow this action / Always allow actions on this site / Decline** trio, and three named modes. Google adds a deterministic list of sensitive sites.
6. **Make safety pauses a visible state, not an error.** Operator's injection-pause dialog (**Keep paused / Mark safe and resume**) and watch-mode pause, Chrome's critic handing control back, and GPT-6 Astra's asynchronous monitor pauses (which can arrive after the triggering action) should appear on the timeline where they happened.
7. **Replays need compression and burned-in overlays.** Claude's GIF export (orange click circles, red drag arrows, black labels, orange progress bar) is the most shareable. ChatGPT agent pairs video with a text timeline, but reviewers found raw video dull. Add skip-idle, speed-up and chapters. Label honestly, as Google does (3× labels, a link to the unedited run).
8. **Slowness is the top complaint everywhere.** Mariner took about 5 s per move, Claude in Chrome 10–15 minutes for a 2–3 minute task, ChatGPT agent 15–20 minutes, and Operator's demos were 4× sped up. Tween motion, show thinking states, and show elapsed time and step count so waiting feels purposeful.
9. **A companion avatar mapped to agent state is proven, and so far only OpenAI has shipped it.** Pets use 4 states and 9 animation rows with exact frame timings and a reduced-motion still frame; the Computer Use PiP docks to the pet; dots add character customisation. localDot can go further with reactions tied to individual actions, but should stay clear of the "dots" naming.
10. **Element-level visuals are an open gap.** No product shows users bounding boxes, set-of-marks labels, a typing HUD or camera-follow zoom, and none documents sound design. Ingredients already exist:
    - Anthropic's crosshair-marker spec;
    - Claude and Chrome ref IDs from the DOM or accessibility tree;
    - Codex's accessibility-tree reading;
    - Gemini 3's per-action intents for captions.

    This is localDot's clearest chance to stand out.

### 6. Gaps / not found

- Official glow colours for Chrome auto browse and Claude desktop computer use.
- Mariner cursor and dashboard visuals.
- Stream frame rates for any hosted agent.
- ChatGPT agent's exact collapsed vs expanded computer-view layout, beyond MIT's "switchable views" description.
- Any sound design or haptics in any of these products.
- The Claude in Chrome release-notes page now returns 404.

## 2.2 Agentic browsers and browser infrastructure

*Research thread B: Perplexity Comet, Opera Neon, Microsoft (Edge, Windows Copilot Actions, Copilot Studio), Browserbase, Browser Use, Steel, Hyperbrowser, Kernel, Anchor, Airtop, Brave, Dia, Fellou.*

**How this was researched:** The session's WebSearch budget ran out partway through. After that I used only direct fetches: official docs, blogs and changelogs, GitHub source through `gh api`, and screenshots or GIF frames from official posts, which I viewed myself. Some sources could not be reached: The Verge is paywalled, and Neowin, WindowsForum and some Perplexity help-center pages blocked the fetch. **[UNVERIFIED]** marks claims that rest on secondary sources or inference. No files were created.

---

### 1. Perplexity Comet

**Timeline**
- **2025-07-09:** Launched for Max subscribers and a waitlist. [TechCrunch](https://techcrunch.com/2025/07/09/perplexity-launches-comet-an-ai-powered-web-browser/)
- **2025-10-02:** Free worldwide, and Max users get "Background Assistants". [changelog](https://www.perplexity.ai/changelog/what-we-shipped-october-3rd)
- **2025-11-06:** "The New Comet Assistant". Perplexity reports 23% better on internal tests, and the assistant now works across several tabs at once. [blog](https://www.perplexity.ai/hub/blog/the-new-comet-assistant)
- **2025-11-14:** Transparency and control upgrade. [blog](https://www.perplexity.ai/hub/blog/comet-assistant-puts-you-in-control)
- **2025-11-20:** Android. [blog](https://www.perplexity.ai/hub/blog/comet-for-android-is-here)
- **2026-03-18:** iOS, with voice mode and no extensions. [MacRumors](https://www.macrumors.com/2026/03/18/perplexity-comet-browser-iphone/)
- **2026:** Perplexity's changelog focus moves to "Computer", a cloud digital worker, including "Personal Computer for Windows" in August 2026. [changelog](https://www.perplexity.ai/changelog)

**Working and in-control indicators**
- Official wording (Nov 14, 2025): *"You can watch while Comet works or see its reasoning step-by-step in the Assistant sidecar… you'll see exactly where it's clicking, scrolling, or interacting with a site. And there are clear buttons to stop the Assistant or provide more guidance."* [blog](https://www.perplexity.ai/hub/blog/comet-assistant-puts-you-in-control)
- MIT AI Agent Index: *"Browser is tinted to indicate agent is working. Sidebar shows agent's action trace and has chatbox."* It also lists a "visible CoT and action trace" and "pause/stop at any time". [index](https://aiagentindex.mit.edu/2025/comet)
- A third-party write-up (Jan 2026) says *"A soft blue border signals that the agent is in control."* [TechTalks](https://techtalksnetwork.com/blog/let-perplexity-comet-browse-for-you). **[UNVERIFIED]**: secondary source only.
- Pre-launch review (Jun 2, 2025): Comet *"overlays an animation"*, *"walks through the actions step-by-step"* and *"disables manual interaction on the page"* while automating. [TestingCatalog](https://www.testingcatalog.com/exclusive-comrehansive-review-comet/)
- The exact cursor glyph, click marker and button labels could not be confirmed. **[UNVERIFIED]**

**How it drives the page (reverse-engineered)**
- A `comet-agent` extension has a service worker of about 700 KB that runs an RPC system taking commands from Perplexity's backend.
- It uses CDP through `chrome.debugger` (`Accessibility.getFullAXTree`) and sends the model a YAML accessibility tree with ref IDs for interactable elements.
- Actions include `ComputerBatch` (pixel-coordinate clicks, drags, scrolls and keystrokes), `FormInput`, `Navigate` and `ReadPage`, plus tab group and ungroup.
- Source: [Zenity Labs, Feb 2026](https://labs.zenity.io/post/perplexity-comet-a-reversing-story)
- This matters for localDot because a coordinate-level action stream is exactly what an overlay layer needs.

**Background work and handoff**
- *"You can freely browse other pages while Assistant is doing the work. And run as many errands in parallel as you want."* [help](https://www.perplexity.ai/help-center/comet/en/articles/11734688-assistant-panel)
- Background Assistants: Perplexity calls it a "mission control" dashboard. Users *"check the progress… and jump in to complete the tasks — like hitting send on the email, intervening, or taking over,"* and get a notification on completion. [TechCrunch](https://techcrunch.com/2025/10/02/perplexitys-comet-ai-browser-now-free-max-users-get-new-background-assistant/)
- Android: *"see exactly what actions your Comet Assistant is taking, and step in at any time."*

**Confirmations**
- Consent is a three-way choice: *"browse yourself, give Comet permission to browse on your behalf once, or let the Assistant automatically browse for you."* Since Nov 6, *"Comet will follow that preference throughout the entire task."*
- Sensitive steps such as *"logging in to a certain site or completing a purchase… it will pause and ask for permission before proceeding."* The exact dialog wording could not be confirmed. **[UNVERIFIED]**
- Brave's prompt-injection disclosure argued that *"sending an email should always prompt the user to confirm right before the email is sent."* [Brave](https://brave.com/blog/comet-prompt-injection/)

**Reviewer complaints**
- *"it takes a minute… I could've done some faster myself."* [Verge](https://www.theverge.com/news/709025/perplexity-comet-ai-browser-chrome-competitor)
- Parking booking *"hallucinated and entered completely wrong dates."* [TechCrunch](https://techcrunch.com/2025/07/09/perplexity-launches-comet-an-ai-powered-web-browser/)
- *"stuck in loops… taking so long that it would have been faster to do it yourself,"* plus about 20% CPU and more than 4 GB of memory. [eesel](https://www.eesel.ai/blog/perplexity-comet-reviews)

**Related 2026 pattern (Perplexity Computer)**
- The transcript shows collapsible step groups with checklists where finished items are struck through, and "Running bash command:" code blocks.
- Subagent cards show a model chip and elapsed time, for example *"Deploying website · 4:40 PM · 2hr 4m 33s"*.
- Source: image on the [product page](https://www.perplexity.ai/products/computer).

---

### 2. Opera Neon (Neon Do, Tasks, Cards) and Browser Operator

**Browser Operator (Mar 3, 2025)**
- It reads the *"DOM Tree and browser layout data"*. It uses no screenshots or video and no cloud VM, and runs on the device.
- It *"will pause and ask you to take action whenever it needs you to fill in a form, confirm an order."* The user types into the page or the chat, then clicks **"Continue"**.
- The user can cancel at any time, take over at any moment, and review *"all the steps it took."* [Opera blog](https://blogs.opera.com/news/2025/03/opera-browser-operator-ai-agentics/)
- In the live demo it *"stopped right before the very last click on the 'checkout' button"*, and a human clicked it. [Apr 14, 2025](https://blogs.opera.com/news/2025/04/opera-browser-operator-first-live-demo/)

**Neon (launched Sep 30, 2025, subscription at $19.90/month)**
- Tasks are *"self-contained workspaces"*, essentially tab groups with isolated context.
- Cards are prompt "power-ups".
- Do runs *"inside your actual browser… where you're already logged in."* Its *"actions are visible in real time, with the option to pause or take control at any moment."* [launch](https://blogs.opera.com/news/2025/09/opera-neon-agentic-ai-browser-release/), [pricing](https://www.operaneon.com/)
- FAQ wording: *"You can see Neon Do operate in real time. There are also buttons and visual cues, such as a subtle glow around active tasks and a side‑panel view showing the plan and next steps. You can pause, stop, or take over at any time."* [FAQ](https://www.operaneon.com/faq)
- MIT index: the user approves the plan before work starts, and must *"click a play button on some steps that require user input."* [index](https://aiagentindex.mit.edu/2025/opera-neon)

**Neon Do panel (screenshot, Dec 2025)**
- Opens with *"📋 Here's my plan to help you:"* followed by a numbered plan.
- Below the plan is a dark card with a teal-to-violet gradient glow. Each step is prefixed with a ✦ and has a title plus a one-line description, for example *"Write Text — The summary will be pasted…"*. The log ends with *"✦ Task is done!"*
- Context chips sit above the composer, for example *"robots_play_football.pdf Context"*.
- Composer placeholder: *"Ask Neon to perform a task in your browser…"*
- Source: [Opera blog](https://blogs.opera.com/news/2025/12/opera-neon-becomes-available-in-public-early-access/)

**"Neon's Computer" in Neon Make (Jul 2025)**
- A panel titled *"Neon's Computer"* shows the current tool as *"Neon is using Deploying application"* plus an argument chip (*"Deployment of an app index.html, /opt/neon/output/…"*).
- Below that is a traffic-light window streaming the VM output, and an "agenda" checklist with green check circles and a **"5/5"** counter.
- Pipelines could be shared as replays at `replay.operaneon.com/shared/…`, but those links return 404 now. [Opera blog](https://blogs.opera.com/news/2025/07/this-is-what-you-can-do-with-opera-neon/)

**2026 updates**
- **Feb 2:** Neon suggests an agent based on intent, with buttons *"Yes, use 1 Minute Research"* / *"No, keep chatting"*. Switching to Do reopens the chat in a new tab. [blog](https://blogs.opera.com/news/2026/02/opera-neon-ai-browser-intelligent-mode/)
- **Mar 31:** MCP server added. External agents are read-only by default, and *"clicking or filling in forms require your explicit permission."* [FAQ](https://www.operaneon.com/faq)
- **May 12:** Browser CLI.
- **Aug 14:** Neon is free when driven by your own agents over MCP or CLI with token compression. Opera's own agents still need the paid plan. [blog](https://blogs.opera.com/news/2026/08/your-ai-agents-can-use-opera-neon-free-of-charge/)

**Human-in-the-loop and security**
- Neon *"will generally pause and request user interaction when… completing a transaction or downloading a file."* [security blog](https://blogs.opera.com/security/2025/10/opera-neon-understanding-agentic-browser-security/)
- Brave found a prompt-injection flaw, which Opera fixed. [Brave](https://brave.com/blog/prompt-injection-flaw-opera-neon/)

**Reviewer notes**
- Chinchilla (Mar 2026) saw *"visual overlays on pages and status updates in the sidebar"*.
- Complaints from the same review:
  - A flight search took "several minutes" that a person could do in "30 seconds".
  - *"Sometimes the sidebar showed controls, other times a full-page interface appeared."*
  - The UI *"struggled to show clear progress"* when several operations ran at once.
  - Source: [review](https://chrischinchilla.com/blog/2026/opera-neon/)
- XDA found Neon reached checkout where Comet errored. [XDA](https://www.xda-developers.com/opera-neon-replacing-chrome-and-comet/)
- The style of on-page element highlights could not be confirmed. **[UNVERIFIED]**

---

### 3. Microsoft

#### A. Edge: Copilot Mode, then Actions, then Browse with Copilot

**History**
- **Jul 28, 2025:** Copilot Mode launched with a promise of clear visual cues when Copilot is *"viewing or listening."* [blog](https://blogs.windows.com/msedgedev/2025/07/28/introducing-copilot-mode-in-edge-a-new-way-to-browse-the-web/)
- **Oct 23, 2025:** Actions and Journeys arrive as a limited, free, US-only preview. *"When Copilot is active, you'll see clear visual cues, so you know when it's taking an action, listening or viewing."* [blog](https://blogs.windows.com/msedgedev/2025/10/23/meet-copilot-mode-in-edge-your-ai-browser/)
- **May 13, 2026:** Copilot Mode was retired. Actions became **"Browse with Copilot"** for Microsoft 365 Premium subscribers in the US. [blog](https://blogs.windows.com/msedgedev/2026/05/13/new-updates-to-edge-across-desktop-and-mobile/)
- **Edge for Business:** Agent Mode was announced Nov 18, 2025, and agentic browsing reached limited preview May 20, 2026. *"Clear visual indicators show when Copilot is taking action, and they can pause or stop it at any time. For sensitive actions such as entering passwords or credit card numbers, Copilot pauses for user input."* [Nov 2025](https://blogs.windows.com/msedgedev/2025/11/18/edge-for-business-presents-the-worlds-first-secure-enterprise-ai-browser/), [May 2026](https://blogs.windows.com/msedgedev/2026/05/20/new-in-edge-for-business-ai-for-work-safe-from-day-one/)

**What it looks like (admin-doc screenshot, taskbar dated 5/7/2026)**
- The page area has an indigo border about 2 px wide and a light lavender tint.
- A pill docked top-centre on the border reads **"Copilot is browsing"**, with a click-sparkle icon.
- A large white virtual cursor carries a dark tooltip, **"Copilot is working"**.
- The side pane shows a coloured status dot with *"Inspecting DOM elements."* and a sentence of reasoning.
- The composer has a mode chip **"Browse with Copilot"** and a blue stop square.
- The mode picker offers **"Browse with Copilot — Works on your behalf"** / **"Chat only — Copilot will respond in chat only"**.
- Copilot *"requests user input for steps requiring authentication, and final saving and submitting actions."*
- Source: [Learn doc](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-management-browsing-with-copilot)

**Confirmations and limits (Oct 2025)**
- "Balanced Mode" uses a curated site allow-list. "Strict Mode" asks the user to approve every site.
- Relevance-check dialog, verbatim from the screenshot:
  - Title: **"This page might not be relevant"**
  - Body: *"It looks like "en.wikipedia.org" might not be related to this action. Should I continue?"*
  - Buttons: **[Continue action]** and **[Cancel]**
- High-risk contexts (email, banking, health) stop and ask for permission.
- The agent cannot use form-fill data or passwords, open edge:// pages, download, open file pickers or context menus, or grant site permissions.
- *Tab audio is muted by default.*
- Source: [safety blog](https://blogs.windows.com/msedgedev/2025/10/23/considerations-for-safe-agentic-browsing/)

#### B. Windows 11: Copilot Actions in the Agent Workspace

**Rollout and entry**
- Announced Oct 16, 2025. Insider rollout Nov 17, 2025 in Copilot app 1.25112.74, excluding the EEA.
- The user picks **"Take Action"** in the composer and can use "Attach file" or "Attach folder". *"Copilot will then take a few moments to create a Desktop."*
- *"At any time, you can take over the task or check in on the progress… including reviewing what actions have been taken."* [Insider blog](https://blogs.windows.com/windows-insider/2025/11/17/copilot-on-windows-copilot-actions-begins-rolling-out-to-windows-insiders/)

**What it looks like (frames from the official GIF, 105 frames at about 9 fps)**
- The home composer, set to "Action", zooms out slightly and crossfades into a split window titled **"Restaurant Reservation"**.
- The left side is a rounded live view of the agent's own desktop, showing Edge with the agent's pointer.
- The right side is the chat:
  - The first reply: *"I'm on it! I'll ask you if I have any follow-ups…"*
  - A step chip, *"Selecting 8pm as the time slot"*. Its border shows an orange gradient in one frame and plain grey in another, so the border appears to animate.
  - A footer row with a sparkle glyph, **"Working for you"**, and a dark **"Take control"** pill with a monitor icon.
  - An orange stop button in the composer.
- Source: [GIF](https://winblogs.thesourcemediaassets.com/sites/44/2025/11/Copilot_Operator.gif)

**Architecture**
- The agent runs in a separate Windows session under its own standard agent account. Microsoft calls this *"more efficient than a full virtual machine such as Windows Sandbox."*
- Principles: *"All actions of an agent are observable and distinguishable from those taken by a user"*, a tamper-evident audit log, and *"review the steps and approve the plan and monitor the execution."*
- Source: [support doc](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features), [security blog](https://blogs.windows.com/windowsexperience/2025/10/16/securing-ai-agents-on-windows/)

**Consent wording**
- Enable dialog: **"Turn on experimental agentic features?"** … *"Agent workspaces enable agents to operate in a contained space. These features are still being tested and may impact the performance or security of your device."* Buttons: [Turn on] / [Cancel].
- File access: **"Copilot wants to access your files to complete your task. Allow access?"** It lists Desktop, Documents, Downloads, Music, Pictures and Videos. Buttons: [Always allow] / [Allow once] / [Not now] (primary).
- Each agent's settings page offers "Allow Always / Ask every time / Never allow".
- Source: [support doc](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features)

**Rough edges**
- The PC won't sleep during agent conversations.
- Shutdown warns *"Someone else is still using this PC…"*, which exposes the separate session.

**Taskbar (Ignite, Nov 18, 2025)**
- *"The agent will show as an icon with status badging and a hover card for progress and context."* Questions arrive as notifications.
- Windows 365 for Agents moves this setup to Cloud PCs.
- Source: [blog](https://blogs.windows.com/windowsexperience/2025/11/18/ignite-2025-windows-at-the-frontier-of-work/)

#### C. Copilot Studio "computer use"

- **Test panel:** the left panel shows *"a step-by-step log of the tool's reasoning and actions,"* and the right panel shows *"a preview of the actions on the machine."* It ends with **"Test completed"**, and **"Stop testing"** kills all actions. [doc](https://learn.microsoft.com/en-us/microsoft-copilot-studio/computer-use)
- **In chat:** it *"shares reasoning messages and screenshots."*
- **Run side panel:**
  - "Session replay" is a *"series of screenshots… with navigation controls."*
  - "Activity" lists action types, coordinates, timestamps and a screenshot per step.
  - "Summary" gives average time per action, screenshot count and human-escalation count.
  - Logs can be exported. Retention defaults to 7 days, and logging can drop screenshots. [doc](https://learn.microsoft.com/en-us/microsoft-copilot-studio/monitor-computer-use)
- **Supervision:** review requests go out by Outlook email or appear as an inline card. The reviewer types **Yes/No**. If the timeout passes, the run stops. [doc](https://learn.microsoft.com/en-us/microsoft-copilot-studio/human-supervision-computer-use)

---

### 4. Browserbase

**Live View** ([docs](https://docs.browserbase.com/platform/browser/observability/session-live-view))
- URL variants:
  - `debuggerFullscreenUrl` has no browser chrome.
  - `debuggerUrl` gives a "Browser with borders" frame.
  - `&navbar=false` hides the navbar.
  - Each tab gets its own URL in `pages[]`.
- An iframe becomes read-only with `pointer-events:none`.
- The live view shows a disconnect screen and posts `browserbase-disconnected`.
- For mobile, set a 360×800 viewport and forward keys from your own keyboard component.
- The live-view URLs point at a hosted Chrome DevTools frontend (`devtools-fullscreen/inspector.html`), so this is a CDP screencast. **[inferred]** from the [Open Operator source](https://github.com/browserbase/open-operator/blob/main/app/components/ChatFeed.tsx).

**Replay**
- Every session is recorded as video and streamed as **HLS**: fMP4 `.m4s` segments on 6-hour signed URLs, one playlist per tab with `startTimeMs`/`endTimeMs` offsets, and up to 10 tabs. [docs](https://docs.browserbase.com/platform/browser/observability/session-replay)
- MP4 downloads are available, one per page. Retention is 31 days, or 24 hours on BYOS.
- Session Inspector:
  - Playback at **0.5x, 1x, 2x or 4x**, timeline navigation, and pause/resume.
  - An Events view covering CDP `Runtime.*`, `Page.*`, `Input.*` and `Log.*`, plus network and console.
  - A Stagehand tab with tokens, execution time and schemas.
  - Source: [docs](https://docs.browserbase.com/platform/browser/observability/observability)
- **rrweb DOM replay was replaced by video.** The `/recording` endpoint is marked *"Deprecated. Returns raw rrweb DOM replay events. Use the Session Replay API for HLS video…"* in an SDK spec sync from Sep 2026. The HLS replay API arrived in SDK 2.11.0, May 2026. [SDK source](https://github.com/browserbase/sdk-node/blob/main/src/resources/sessions/recording/recording.ts)

**Director, now Browserbase Agents**
- Director launched Jun 18, 2025 and turned a natural-language prompt into a Stagehand script. [blog](https://www.browserbase.com/blog/introducing-director)
- By 2026, director.ai serves the landing page for **Browserbase Agents**, which reached general availability Jun 30, 2026: *"a live view… Session Replay to scrub back… traces across both model calls and tool calls… per-run cost breakdown… watch the frames it saw."* [blog](https://www.browserbase.com/blog/introducing-browserbase-agents), [director.ai](https://www.director.ai/)
- Run inspector (screenshot from the blog):
  - A header with a "Complete" pill, run ID, duration and date.
  - A **horizontal timeline strip with colour-coded tick marks per event** and a playhead from +0:00 to +1:54.
  - An indicator such as *"Event 5/43 screenshot…"*, a pause button, and **1x/2x/4x** speed.
  - A left list of typed chips (**Action** purple, **Reason** blue, **Bash** orange, **Prompt** green), each row with a timestamp and the current row highlighted.
  - A right-hand frame synced to the selected step, then the Result.
  - "Optimize" and "Build API in" buttons.
- Handoff:
  - `pauseWhen` puts a run into `PAUSED` with a `pause` tool message, and the browser session stays open (15 minutes on free, 60 on paid).
  - Resume with a reply.
  - Secrets pass as `%variable%` placeholders, so the value never enters the transcript.
  - Source: [docs](https://docs.browserbase.com/platform/agents/pausing-runs)

**Open Operator (template from Jan 2025, now archived)**
- A mac-style frame with red, yellow and green dots.
- A 16:9 live-view iframe on the right and a 400 px step feed on the left.
- The feed starts with a "Goal:" card (blue-50). Each step card shows "Step N", a tool tag (GOTO, ACT, EXTRACT, OBSERVE, CLOSE, WAIT, NAVBACK), the text and "Reasoning:".
- A pulsing "Processing..." card shows while the agent works, and cards fade in with framer-motion.
- When done, the iframe is replaced by "The agent has completed the task".
- Source: [source](https://github.com/browserbase/open-operator/blob/main/app/components/ChatFeed.tsx)

**Stagehand overlays**
- `locator.highlight()` calls CDP `Overlay.highlightNode` with a **red border (255,0,0,0.9) and yellow fill (255,200,0,0.2)**. The default duration is 800 ms (2 s in the CLI), and it is redrawn every 100–300 ms so repaints don't clear it. [source](https://github.com/browserbase/stagehand/blob/main/packages/extension/understudy/locator.ts)
- `highlightCursor` (v3 agent) shows a visual cursor in CUA and hybrid modes but not DOM mode.
- The cursor itself is a 16×24 SVG arrow, black with a 0.7 white stroke, fixed at the top z-index with `pointer-events:none`. It follows dispatched mousemove events. [source](https://github.com/browserbase/stagehand/blob/main/packages/extension/dom/locatorScripts/cursorOverlay.ts)
- v2 `observe({drawOverlay:true})` boxes the elements it found.

---

### 5. Other browser-agent infrastructure

**Browser Use (open source and Cloud)**

Open-source overlays ([session.py](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/session.py)):
- **Target highlight:** four corner brackets drawn inside the page, 3 px thick, orange `rgb(255,127,39)`.
  - Size is 35% of the element's shorter side, clamped to 8–20 px.
  - They start 10 px outside the element and slide in to −3 px over **0.15 s ease-out**, hold **1.0 s**, then fade over **0.3 s**.
- **Click marker (a ripple):** a 30 px ring with a 3 px stroke scales from 0.3 to 1 at 0.8 opacity over 0.2 s, with an 8 px centre dot. It then exits by scaling to 1.5 while fading.

Set-of-marks for the model ([python_highlights.py](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/python_highlights.py)):
- Drawn onto screenshots, not the page, as **dashed boxes** (4 px dashes, 2 px line) coloured by element type:

| Element | Colour |
|---|---|
| button | #FF6B6B |
| input | #4ECDC4 |
| select | #45B7D1 |
| link | #96CEB4 |
| textarea | #FF8C42 |
| other | #DDA0DD |

- The index label sits in a filled box with a white 2 px outline. It goes above elements smaller than 60×30 and inside the top edge of larger ones.

Other visual touches:
- **"Demo mode"** injects a 340 px dark (#05070d) log panel in JetBrains Mono. Each entry has a coloured left border by level (action #34d399, thought #f97316, error #f87171, and so on), slides in with a 0.25 s transform and survives navigation. [demo_mode.py](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/demo_mode.py)
- The boot screen is a black DVD-screensaver bouncing logo with *"Starting agent …"*. [watchdog](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/watchdogs/aboutblank_watchdog.py)

Cloud ([docs](https://docs.browser-use.com/cloud/browser/live-preview)):
- Live view is an iframe at `live.browser-use.com`. `ui=false` hides tabs and toolbar, and view-only mode means wrapping it in `inert` plus `pointer-events:none`.
- The viewer has *"connection and screencast Retry buttons,"* which points to a CDP screencast. **[inferred]**
- Recording is MP4 and off by default for API runs.
- Human in the loop: *"Open the live browser, take over, then continue the same session."* [docs](https://docs.browser-use.com/cloud/agent/human-in-the-loop)
- Share links give a public transcript with *"sensitive keys scrubbed"* plus the MP4. [index](https://docs.browser-use.com/llms.txt)

**Steel**
- Live view: headful sessions (the default) stream **WebRTC H.264 at 25 fps**, *"replacing Chrome's screencasting."* Legacy headless sessions still use a CDP screencast with theme, showControls and pageIndex options.
- `interactive=true/false` toggles control. Debug URLs are **unauthenticated**. [docs](https://docs.steel.dev/overview/sessions-api/embed-sessions/live-sessions)
- Replays are HLS/MP4, or rrweb `/events` for legacy sessions. [docs](https://docs.steel.dev/overview/sessions-api/embed-sessions/past-sessions)
- **Agent Traces** ([overview](https://docs.steel.dev/overview/agent-traces/overview), [timeline](https://docs.steel.dev/overview/agent-traces/timeline)):
  - Each row reads like a sentence: icon and verb, target label, page URL, then wall-clock time plus an offset. Examples: `click on Sign in`, `type into Email field`.
  - Bursts of typing collapse into one row, and idle markers appear between long pauses.
  - Clicking a row seeks the video. **Activity markers sit on the progress bar**, and the current row highlights during playback.
  - Expanding a row shows role, accessible name, selectors, pointer and keyboard details, and a thumbnail from the recording.
  - Exports: markdown written for another agent to replay, JSON, or a ZIP with screenshots.
  - Password and card fields become `<redacted>`.

**Hyperbrowser**
- `liveUrl` tokens expire after 12 hours, and `viewOnlyLiveView` makes the view read-only.
- Recordings are rrweb by default, with optional MP4. [live](https://hyperbrowser.ai/docs/sessions/live-view), [recordings](https://hyperbrowser.ai/docs/sessions/recordings)
- HyperAgent draws set-of-marks onto screenshots with Jimp: 2 px outlines in either a "red" or a 12-colour "rainbow" scheme, labelled with encoded IDs like "0-1234". [source](https://github.com/hyperbrowserai/HyperAgent/blob/main/src/context-providers/shared/highlight-colors.ts)
- The live-streaming method is not documented. **[UNVERIFIED]**

**Kernel (kernel.sh)**
- Live view is WebRTC, built on neko in [kernel-images](https://github.com/onkernel/kernel-images).
- The iframe posts `KERNEL_CONNECTED`, `KERNEL_PLAYING`, `KERNEL_PAUSED` and `KERNEL_CONNECTION_TIMEOUT` (with ICE state). It accepts **`KERNEL_SET_READ_ONLY` to toggle take-over without reloading**.
- Kiosk mode hides browser UI. The default viewport is 1920×1080 at 25 Hz. [live view](https://kernel.sh/docs/browsers/live-view), [viewport](https://kernel.sh/docs/browsers/viewport)
- Replays are MP4s made with explicit start/stop calls, several per session. [docs](https://kernel.sh/docs/browsers/replays)
- OS-level mouse movement follows **Bézier curves by default**, with `duration_ms` from 50 to 5000 ms, or set automatically by distance. [docs](https://kernel.sh/docs/browsers/computer-controls)

**Anchor Browser**
- Headful live view shows full Chrome including the address bar. Variants include fullscreen, `pointer-events:none`, and a single-use `one_time_url`.
- The doc image is named `vnc-live-view.png`, which suggests VNC. **[inferred]** [docs](https://docs.anchorbrowser.io/advanced/browser-live-view)
- Human-in-the-loop requests are queued. The `intervention.requested` webhook carries a `live_view_url` *"for one-click live takeover."* [docs](https://docs.anchorbrowser.io/agentic-browser-control/human-in-the-loop)
- Recordings are MP4, and the API can **pause and resume recording**, which is useful for sensitive steps. [index](https://docs.anchorbrowser.io/llms.txt)

**Airtop**
- Live view is per window, with an optional navigation bar. It either resizes to fit the iframe or uses a fixed `screenResolution` with `disableResize`, and it emits postMessage events such as URL changes. [docs](https://docs.airtop.ai/guides/how-to/creating-a-live-view)
- Recording is opt-in, one H.264 MP4 per window, deleted after 7 days. [docs](https://docs.airtop.ai/guides/how-to/recording-a-session)

---

### 6. Other agentic browsers

**Brave (Leo AI browsing)**
- In Nightly behind a flag from Dec 10, 2025, and in all release channels from May 5, 2026, still opt-in. [blog](https://brave.com/blog/ai-browsing/)
- It runs in an isolated profile that *"is styled differently from Leo, and has distinct action cues,"* and browsing *"happens in an open tab, rather than being hidden in a sidebar."* The user can inspect and pause sessions.
- Brave deliberately **rejects per-site prompts** because *"repeated, low-signal security prompts… train users to ignore warnings."* It only asks for permission when an alignment-checker model flags an action.
- Screenshots:
  - Pink-tinted window chrome and a **magenta border around the page**.
  - A floating top-centre pill, **"Take over task"**.
  - A side panel with **Progress / Steps** tabs and a **"User input"** card reading *"Continue to check out?"* with [Yes]/[No].
  - **Resume** and **Stop** buttons.
  - Profile banner: *"Enabling AI to browse automatically for you may cause harmful, unintended consequences for your privacy, finances, and online communications."*

**Dia (The Browser Company)**
- The Sep 2026 changelog and release notes cover "More Reliable AI Agent Sessions", "Upgrade Dia's Agent Systems", and Notion and Microsoft tool integrations. The notes mention BCNY using *"(and now Atlassian!)"*. [changelog](https://www.diabrowser.com/changelog), [notes](https://www.diabrowser.com/release-notes/1-49-0-microsoft-tools)
- I found no on-page action visualization. The Atlassian acquisition (Sep 2025) is from memory and was not confirmed in this session. **[UNVERIFIED]**

**Fellou**
- "Shadow Workspace": *"observe or intervene with an Agent's actions in real-time, just like participating in a Zoom meeting, without needing to take direct control."* Tasks run in the background. [blog source](https://github.com/FellouAI/fellou-blog/blob/main/src/content/blog/fellou-first-launch.mdx)
- The homepage says users can *"Visually inspect and edit the AI Browser's automatic workflow before it runs."* Deep Action spans web and desktop. [site](https://fellou.ai/)
- v2 (Jun 2025) added parallel tasks, in alpha. [source](https://github.com/FellouAI/fellou-blog/blob/main/src/content/blog/Fellou-v2-launch.mdx)

**Sigma**
- An agent chat on the left with the page on the right. Nothing notable. [site](https://sigmabrowser.com/)

**Norton Neo**
- Not covered; the domain was unreachable.

**Features no product documented**
- Auto-zoom or camera-follow. Windows only has a zoom-out transition when the workspace opens.
- A keystroke HUD. Steel only groups typing into one row.
- Before/after diffs.
- Any sound design. Edge actually mutes the agent's tab by default.

---

### Cross-product takeaways

1. **Frame, tint and status pill mean "the agent has the wheel".** A coloured border and page tint, plus a top-centre pill with a verb, make control state obvious at a glance. Edge does this best ("Copilot is browsing", indigo), followed by Brave (magenta frame with "Take over task"). For localDot, frame the streamed desktop and put **Take over** inside the pill.

2. **A labelled virtual cursor with natural motion.** Edge attaches a "Copilot is working" tooltip to its cursor. Kernel moves the pointer along Bézier paths timed by distance, and Stagehand draws a simple in-page arrow. Combine Edge's label with Kernel's motion.

3. **Short, animated markers on the target.** Browser Use has the best specified ones: corner brackets that slide in over 0.15 s, hold 1 s and fade over 0.3 s, plus a click ring that grows from 0.3 to 1 to 1.5. Keep set-of-marks, colour-coded by element type, as an optional debug layer, the way Browser Use and HyperAgent do.

4. **A live step chip with a short narrative, plus a persistent "Working for you" state.** Windows shows the current step ("Selecting 8pm as the time slot") with an animated border, next to "Working for you" and "Take control". Edge has a status dot with "Inspecting DOM elements." Neon has a ✦ step log with a glowing card.

5. **Show the plan first, then an agenda with a counter.** Neon's "Here's my plan", "Neon's Computer" with its current-tool chip and "5/5" agenda, Perplexity Computer's struck-through checklists, and Fellou's editable workflow all do this. Neon's Computer is closest to localDot's virtual-computer panel.

6. **Take-over as a stateful, one-click round trip.** The best examples:
   - Kernel switches between read-only and interactive without reloading the stream.
   - Brave pairs "Take over task" with **Resume/Stop**.
   - Browserbase keeps the browser open while a run is `PAUSED`, and resumes with a reply.
   - Anchor's webhook carries a one-click takeover URL.

7. **Few confirmations, each one specific.** Brave explains why it avoids prompt fatigue. Edge's relevance-check wording is a good template. Windows' "Always allow / Allow once / Not now" is a clean three-way choice. Opera stops just before the final checkout click. Keep secrets out of logs with Browserbase-style `%var%` placeholders and Steel-style redaction.

8. **Replay is video synchronized with an event timeline.** Steel's Agent Traces does this best: clicking a row seeks the video, markers sit on the progress bar, the active row highlights, typing is grouped, idle gaps are marked, and the whole trace exports as markdown for another agent. Browserbase Agents adds colour-coded tick marks, typed step chips and 1x/2x/4x speed. Copilot Studio falls back to screenshots with coordinates.

9. **Stream with WebRTC, and draw overlays outside the page.** The field has moved from rrweb and screencasting to WebRTC or H.264 video: Steel at 25 fps, Kernel via neko, and Browserbase's deprecation of rrweb. For a full desktop, composite the cursor and markers on the client from the action-event stream, as Windows and Edge do in their own UI. Browser Use and Stagehand inject into the page DOM instead, which does not work outside a browser.

10. **Make isolation visible, and let background tasks report through badges.** Windows gives the agent its own session and shows agents on the taskbar with badges and hover cards. Brave uses a distinct profile colour. Comet has a Background Assistants "mission control" page. No product documents auto-zoom, a keystroke HUD, before/after diffs or sound, so these are open ground for localDot.

## 2.3 Manus, Genspark, Kimi, MiniMax (and other Chinese super-agents)

*Research thread C1.*

**How this was researched.** WebSearch ran out early in the session. After that I relied on three kinds of primary source:
1. Official blogs, docs, help centers and changelogs.
2. Public replay data. Manus's public share API returns the recorded event stream.
3. UI strings and component code taken from each product's public production JS and i18n bundles.

Hashed bundle URLs change with every deploy. Bundle-derived facts are tagged **(bundle)** and reflect the build live on 2026-09-30. Tags used:
- **[UNVERIFIED]** marks anything I could not confirm.
- **[mktg]** marks vendor marketing copy that does not describe observed UI.

---

### 1. Manus

**Timeline**
- **2025**
  - Launched Mar 6, 2025 ([Wikipedia](https://en.wikipedia.org/wiki/Manus_(AI_agent))).
  - Wide Research: Jul 31, 2025. Manus 1.5: Oct 16, 2025. Manus 1.6 "Max, Mobile Dev, Design View": Dec 15, 2025. Browser Operator: Nov 18, 2025, all users from Nov 22. Dates are from the [Manus blog index](https://manus.im/blog) and [TestingCatalog](https://www.testingcatalog.com/manus-ai-launches-browser-operator-extension/).
  - Meta acquired Butterfly Effect (Manus's parent), announced Dec 30, 2025 ([CNBC](https://www.cnbc.com/2025/12/30/meta-acquires-singapore-ai-agent-firm-manus-china-butterfly-effect-monicai.html)).
- **2026**
  - China's MOFCOM opened a review in January. The NDRC blocked the deal on Apr 27 ([codersera](https://codersera.com/blog/manus-ai-2026-status-meta-block-desktop-app/)). Meta cut ties Jun 15 ([Wikipedia](https://en.wikipedia.org/wiki/Manus_(AI_agent))).
  - Independence: Wikipedia says Aug 11; [explainx](https://www.explainx.ai/blog/manus-2-0-studio-cue-cascade-cloud-computer-2026) says Sep 1 via an investor buyback. The sources disagree.
  - Desktop "My Computer": Mar 16, 2026 ([blog](https://manus.im/blog/manus-my-computer-desktop)).
  - Plan Mode (edit the plan before it runs): Jul 2026 ([Taskade](https://www.taskade.com/blog/manus-ai-review)).
  - **Manus 2.0, Sep 28, 2026** ([blog](https://manus.im/blog/introducing-manus-2-0), [help](https://help.manus.im/en/articles/17190150-what-is-new-in-manus-2-0), [Bloomberg](https://www.bloomberg.com/news/articles/2026-09-28/manus-expands-ai-tools-in-renewed-push-into-agent-market)). It adds:
    - Cascade harness, Cloud Computer, Automations.
    - Manus Studio (desktop) with a timeline Video Editor and Game Dev.
    - Remote Control: watch your desktop live on your phone.
    - Cue, a personal-agents app.

**Layout (all bundle, taken from the public share page [manus.im/share/…?replay=1](https://manus.im/share/xFgpHb15vKqfRPWIs3JJPJ?replay=1))**
- Chat on the left. A "workspace" sidebar on the right titled `{name}'s computer`, which becomes `…is inactive` when idle.
- The sidebar subtitle names the active tool: `{name} is using <b>Terminal</b>`, and likewise for Browser, Editor, Search, Image search, Media viewer, Scholar search, My Browser and Gmail Search/Read.
- The UI state includes `isSidebarFullscreen`, `isSidebarPreviewFullscreen` and `isSidebarVisibleInMobile` (a mobile overlay).
- It also stores an `initialComputerPosition {top,left,width,height}`, which I read as an expand-from-thumbnail animation [inferred].
- **Mini computer thumbnail.** A 72×48 px animated button (tooltip "View Manus's computer") sits in the task-progress bar and opens the sidebar. When the agent is stopped or errored it shrinks to 30×20 (bundle chunk [3y2uikqx3_1rt.js](https://files.manuscdn.com/webapp/_next/static/chunks/3y2uikqx3_1rt.js)).

**Tool-call chips and "thinking" indicators**
- The recorded events carry the chip text. Seen in the public replay API ([example](https://api.manus.im/api/chat/getSessionV2?sessionId=j7BUZNaC7vxEpqBU5GYQOR&type=shared&getFirstSegment=true)):
  - `message:{action:"Executing command", param:"mkdir -p …"}`
  - `{action:"Creating file", param:"tesla_analysis/todo.md"}`
- Other action verbs seen: "Editing file", "Browsing", "Scrolling down", "Clicking element" (description "Clicking element at index `9`"), "Running JavaScript", "Searching". Error recovery shows as "Handling browser issue" / "Handling terminal issue".
- Per-tool briefs: "Manus is using the browser", "Manus is searching the web", "Manus is using the text editor".
- Chip rendering: the action in normal text followed by the param in 12 px monospace, tertiary colour. While a step is running the chip gets a `shimmer-text` sweep. A timestamp appears on hover (bundle).
- Agent status events carry `brief:"Manus is working"` plus a description such as "Creating a plan for Tesla stock analysis".
- The live-status line uses a 110° gradient-sweep text (`animate-live-status-shimmer`) next to a spinner.
- Other strings: "Working for {duration}", "Working...", a collapsible "Thinking process".

**Plan checklist**
- `planUpdate` events carry tasks with `status: done|doing|todo` and `startedAt/endAt`.
- The UI shows "Task progress" with "Step {current}/{total}" and an up/down chevron; hovering opens a "To-do" popover.
- Status icons: green 12 px check (done), clock (todo), spinner (doing), and otherwise a 9 px blue rotated square with a glow.
- The collapsed bar shows the current task title, which slides up on change (0.24 s ease-in-out) (bundle).
- Manus also writes a literal `todo.md` with checkboxes that is visible in the editor (replay data).

**What the computer view shows, and how it is streamed**
- **Browser: per-action screenshots, not video.** Each browser event includes `detail.browser:{toolName:"browser_navigate"|…, url, screenshot}`. The screenshots are lossless WebP, about 1279×941 px and 170–290 KB each (checked from the public replay).
- Clicks target an element index ("at index `9`"), in the style of the browser-use library. Whether numbered overlays are drawn on the screenshots is [UNVERIFIED].
- A YouTube `browser_navigate` is swapped for a live YouTube embed (bundle).
- **Terminal:** output is appended with ANSI colour (green `ubuntu@sandbox:~ $` prompt).
- **Editor:** full file contents. The bundle ships Monaco with `DiffEditor`, and edits show "Editing files" with a "+N" count.
- **Search:** query plus result cards (title, link, snippet).
- **Live channels:** sandbox events expose `vncUrl` and `webRTCUrl` (masked in shares). Takeover opens a **VNC dialog** (URL param `?vnc=1`, `getVncOtp` API, a `/vncTest` route) (bundle).
- **Manus 2.0 Remote Control** uses a **LiveKit WebRTC screen-share track**. The client logs presentedFps, receivedFps, droppedFrames and kbps every second. Labels include "Loading remote screen…", "The network connection is unstable. The remote screen may lag." and "Control computer" / "Pause control" (chunk [31e1a9lw6pjcf.js](https://files.manuscdn.com/webapp/_next/static/chunks/31e1a9lw6pjcf.js)). No frame rate is set in the client; it is chosen server-side [UNVERIFIED].

**Timeline and "Jump to live" (the `ManusComputerTimeline` component, bundle)**
- A 45 px bar under the computer view, grey, with top and bottom borders.
- **Previous / Next** buttons (16 px chevrons that turn blue on hover). Arrow keys (←↑ / →↓) also step when focus is inside the workspace.
- A slider: 4 px track, blue fill, 14 px blue thumb with a 2 px white ring. Hovering shows a blue 28 px tooltip with the date-time of that point.
- A **"Live"** label (12 px, weight 500) with a 6 px dot. The dot is green when you are at the live edge and the agent is running or waiting, grey otherwise.
- After scrubbing back, a floating pill appears 10 px above the bar: rounded, 40 px tall, white, with a shadow, a Play icon and **"Jump to live"**.
- Events load in segments as you scrub.
- On shared (read-only) views the Live indicator and pill are hidden, but the scrubber remains.

**Replay (share page: chunk [1831ao3j7dat0.js](https://files.manuscdn.com/webapp/_next/static/chunks/1831ao3j7dat0.js))**
- An overlay reads "You are viewing a completed Manus task. Replay will start automatically in **3** seconds." with a pulsing replay button.
- **Replay is event-sourced.** The recorded events are fed back into the live UI **one every 100 ms**. Plan timers are re-based to "now" so durations look live. The next segment is prefetched when 5 or fewer events remain.
- **Wide Research is dramatised in replay:** the client synthesises each subtask flipping from pending to running to done, 300 ms apart.
- Bottom bar: while playing, "Skip to results"; when done, "Watch again". Also "Try it yourself" and "@ this task" (reference the task in a new chat).
- No playback-speed selector was found.
- Share settings include "Replay sharing" and "View, comment on, and download shared deliverables and replays."

**Take over and handoff**
- The agent can suggest a takeover. A chat card reads "You can choose to take over the browser to complete the operation" with a small black button, which opens the VNC dialog. For My Browser it switches to your local tab instead.
- After takeover: "When finished, please inform Manus of your changes to help it work effectively." (bundle).
- Docs describe it as "Take Over": you complete the check, then "hand control back". There is a **"Take Over Notifications"** setting ([cloud-browser docs](https://manus.im/docs/features/cloud-browser.md), [help](https://help.manus.im/en/articles/11711218-how-can-i-take-over-manus-browser-or-vs-code)).

**Browser Operator (local extension)**
- Opens a dedicated tab inside "a tab group named after your current task". One-time "Authorize" prompt. **Close the tab to stop**; click into the tab to take over. "Every action… logged" ([blog](https://manus.im/blog/manus-browser-operator), [docs](https://manus.im/docs/features/browser-operator)).
- Chrome's own debugger infobar appears, and it runs over CDP ([Mindgard](https://mindgard.ai/blog/manus-rubra-full-browser-remote-control)).
- Bundle strings: "Authorize a new tab in your browser to continue? (Asking because you enabled My Browser in connectors)", "Always authorize this browser".

**Wide Research**
- A subtask list with "Load more ({loaded} of {total})" and "View completed subtasks". Each subtask has its own replay link.
- "Taking too long? You can move on by skipping incomplete ones." with a Skip button, then the confirm "{name} is in progress. This action will finalize it with current results." (bundle).

**Confirmations for sensitive actions (bundle)**
- **"Confirm Sensitive Action"** dialog: "You will allow Manus to run similar commands automatically during this session without asking for confirmation again." plus the warning "This permission carries higher risk and may lead to data loss, information leaks, or unexpected behavior. Please continue only if you trust these actions." Buttons: **Confirm / Let Manus explain / Deny**.
- Command scopes: "Allow once", "Allow for this task", "Allow for today", "Allow for this page", "Allow any command in this task".
- Other prompts: "Allow these actions? The agent is requesting permission to:", "Allow {name} to deploy the website publicly?" (a `confirmDeploy` event appears in replays).
- Settings: "Auto-approve confirmations before sending or publishing." and "When enabled, Manus will auto-advance steps if confirmations time out."
- My Computer: "Allow Once" / "Always Allow" for every local command ([desktop docs](https://manus.im/docs/features/desktop.md)).
- Plan Mode: "Awaiting confirmation", "Plan executed on {timestamp}", "Plan rejected on {timestamp}".
- Loop guard: "We have detected that Manus may be stuck in a loop. Please confirm whether Manus is functioning normally."

**Notifications and sound (bundle)**
- "Get notified in your browser when there's new progress or a task is completed."
- **"Play a sound once when a task is completed while you are away."**
- "Sound alert can only be enabled after browser notifications are turned on."
- Mobile push via the app. "Remote control is not available in mobile browsers."

**Reviewer notes**
- Praised: [MIT Tech Review](https://www.technologyreview.com/2025/03/11/1113133/manus-ai-review/) called the "Manus's Computer" window a way "not only to observe… but also to intervene at any point", and liked that "each session is replayable and shareable".
- Janky:
  - MIT TR: "Manus's Computer froze on a certain page for a long period", plus high-load errors.
  - [TechCrunch](https://techcrunch.com/2025/03/09/manus-probably-isnt-chinas-second-deepseek-moment/): loops and crashes; one test "failed after 50 minutes at step 18/20".
  - [willo](https://www.willo.ai/blog/manus-review): "server busy" lags and freezes.

---

### 2. Genspark

**Timeline** ([blog index](https://www.genspark.ai/blog); posts read via Wayback because the live site sits behind Cloudflare)
- **2025**
  - Super Agent, Apr 2, 2025. Launch examples included "AI Call for Me to Make Restaurant Reservation" ([archived](https://web.archive.org/web/20260528180038/https://www.genspark.ai/blog/genspark-super-agent)).
  - AI Slides, Apr 22. AI Sheets, May 8.
  - **AI Browser, Jun 10, 2025**, with Autopilot Mode and an MCP Store ([archived](https://web.archive.org/web/20260829170736/https://www.genspark.ai/blog/genspark-ai-browser)).
  - AI Developer, Aug 14.
- **2026**
  - **Workspace 4.0, Apr 8, 2026**: Genspark Claw for Desktop with "Computer Use" and "Browser Use" ([archived](https://web.archive.org/web/20260910024237/https://www.genspark.ai/blog/genspark-ai-workspace-4)).
  - **Workspace 6.0, Jul 20, 2026**: SecondBrain, GenTeam, GenMail, Design, AgentBase ([archived](https://web.archive.org/web/20260830074603/https://www.genspark.ai/blog/genspark-ai-workspace-6)).
  - Gen-1 Slides, Sep 10.
  - The "New Super Agent" runs in a dedicated sandbox with "real browser, own filesystem" ([help center, archived](https://web.archive.org/web/20260918065025/https://www.genspark.ai/helpcenter)).

**How progress is shown: inline cards, not a big computer panel.** All strings below come from [en-US messages.json](https://www.genspark.ai/_i18n/639c394b/en-US/messages.json).
- **Status line:** "Starting Agent's computer", "Working on Agent's computer", "Installing {detail} on Agent's computer", "Copying project files to Agent's computer", "Running {detail} on Agent's computer".
- **Cards**
  - Search: "Searching the web…" becomes "Searched the web · {count} results".
  - Phone: "Calling {name}…" becomes "Called {name}" or "Call failed".
  - Question: "Genspark needs your input", "Answer this question", "Awaiting reply", "Superseded by a newer question".
  - Connector: "Recommended for this task", "Waiting for connection…".
- **Browser tool labels:**
  - Operations: "Prepare Browser Operation", "Navigate Operation", "Click Operation", "Input Operation", "Scroll Operation", "Hover Operation", "**Sync Page Visual**" (the screenshot), "Vision Detection", "Exit Browser Operation".
  - Computer actions: "Click / Double Click / Triple Click / Right Click / Drag / Type / Key Press / Scroll / Zoom Screenshot / Wait".
  - Parallel tools: "Parallel Search", "Parallel Read".
- **Live slide deck build:** "Page {n} · {title} · creating", "{done}/{total} pages".
- No virtual cursor, click ripple or typing HUD strings were found.

**GenTeam activity panel (2026)**
- States: "Agent is getting ready", then "Working" / "Thinking", "Ran {count} tool calls", "Tokens {in} in / {out} out", "Agent finished — latest activity shown above".
- **Stop** has the tooltip "Stop this task now. The task ends here — the agent starts fresh on your next message."
- "Live activity is available for cloud sandbox agents only."

**Browser handoff: the most detailed handoff UX found in this research**
- A "Browser handoff" card gives a reason code:
  - "The agent is stuck on a CAPTCHA only a person can solve."
  - "…needs you to sign in on this page."
  - "…needs a one-time code or a device confirmation only you can provide."
  - "…needs you to complete a payment step."
- Buttons: **"Take over browser"** and later **"Hand back to agent"** ("Handing back…", "Handed back by {name}").
- While starting: "Starting the browser… this can take up to ~10 s after a computer restart." Then "Ready — click the browser to type." and **"Keyboard captured — what you type goes to the agent's browser."**
- Banner: "You're controlling the agent's browser — everything you type or sign in to here is visible to the agent. GenTeam never asks for your Genspark password here."
- Anti-phishing warning: "This request comes from a turn you did not start. Check the address bar before you sign in anywhere."
- Extras: an optional note for the agent, a screenshot fallback, and a VNC-based error ("The browser didn't come up in time").
- **Claw:** a noVNC "Open Remote Desktop" into the Claw cloud computer ([Claw help, archived](https://web.archive.org/web/20260915124421/https://www.genspark.ai/helpcenter/genspark-claw)).

**Call For Me**
- After the call: a text transcript, a summary and possibly a recording, in Task List/History, plus an email summary.
- "cancel it before it connects; once connected, it's best to let the AI finish naturally" ([help, archived](https://web.archive.org/web/20260829185128/https://www.genspark.ai/helpcenter/call-for-me)).
- No string for live listen-in or a live transcript was found in the web bundle [UNVERIFIED / not found].

**Replay and audit**
- Business pages promise "a scrubbable trace of every click, every keystroke, every source", "Every browser task saves a full trace — screenshots, DOM state, the reasoning behind each action. Roll back a step…" and "Require human approval for destructive clicks. Halt on unexpected navigation." [mktg]
- Workflows gate steps with "A step ({action}) needs your confirmation before it acts. Turn on 'Always continue'…".
- AI Browser Autopilot's in-browser visuals (overlay, cursor): [UNVERIFIED].

---

### 3. Moonshot Kimi: OK Computer, Agent Swarm, Kimi Work, Kimi CU

**Timeline** ([Kimi Help: Agent overview](https://www.kimi.ai/help/agent/agent-overview))
- **"OK Computer" Agent mode launched Sep 26, 2025.**
- K2 Thinking: [blog](https://www.kimi.ai/blog/kimi-k2-thinking), exact date not captured.
- K2.5 and Agent Swarm: Jan 27, 2026. Claw beta: Feb 2026. K2.6: Apr 20, 2026. **K3: Jul 16, 2026** ([blog](https://www.kimi.ai/blog/kimi-k3)).
- Kimi Work desktop: Jun 3, 2026 ([overview](https://www.kimi.ai/help/kimi-work/overview)).
- The Agent uses "20+ tools". Swarm runs up to 300 sub-agents ([swarm help](https://www.kimi.ai/help/agent/agent-swarm)).

**OK Computer panel.** Strings are from the [zh-CN locale bundle](https://statics.moonshot.cn/kimi-web-seo/assets/zh-CN-CjcCBPuD.js); translations are mine.
- Panel title **"Kimi's Computer"** (or "Kimi Agent").
- Status: "Kimi 正在开机中..." (Kimi is booting up…), "执行任务中..." (running), "任务已暂停" (paused), "任务已结束" (done). At peak load: "正在高峰期，任务已暂停" (task paused due to peak demand).
- Views: Web search, Image search, **Terminal**, iPython (Request / Response), file **Diff / Modified**, All files (preview or download), and a todo panel showing "Current progress" with a "collapse window" control.
- Website artifacts have versions: preview, "restore to {version}", "published".
- Context compression is announced in the UI: "上下文超长，正在压缩..." (context too long, compressing…).
- Inline tool chips: "浏览网页" (browse page), "点击网页对象" (click page element), "搜索网页关键词" (search page), "滚动网页" (scroll page), "编写并执行代码" (write and run code), "Kimi 创建了文件" (Kimi created a file). The group collapses to "使用 {count} 个工具" (used N tools).
- Screenshots and diffs render in collapsible inline "ToolDetailFrame"s (bundle).
- Live video streaming: not found [UNVERIFIED].

**Agent Swarm visuals (bundle)**
- Staged loaders: "generating parallel tasks", then "matching assistants", then "assigning tasks"; "recruiting assistants…", then "Recruited {count} assistants".
- Per-agent status: waiting to boot / done / stopped / not started / **"已下班" (clocked off)**.
- Per-agent toggle between **"电脑视窗" (computer view)** and **"活动轨迹" (activity trail)**.
- Swarm panel: "{count} running" and Stop, with the confirm "stops all assistants; consumed credits are not refunded".

**Replay (chunk [Replay-BH5OAntv.js](https://statics.moonshot.cn/kimi-web-seo/assets/Replay-BH5OAntv.js))**
- The server re-streams the recorded chat (`replayChatShareStream`); the client applies it in 100 ms buffers.
- Auto-plays once per browser session.
- Bar reads "正在回放" (replaying) or "回放完成" (replay complete). Buttons: "看结果" (view result, aborts playback), "看回放" (watch replay), and "做同款" (make one like this).

**Human-in-the-loop**
- Ask-user cards auto-skip after inactivity ("{minutes} 分钟无操作自动跳过全部").
- Help text: if the page looks frozen, don't press Stop; the task keeps running in the background and notifies you ([features & limits](https://www.kimi.ai/help/agent/agent-features-and-limits)).
- Notification settings: in-app, "home-page realtime reminders", and browser notifications.

**Kimi Work desktop** ([release notes](https://www.kimi.ai/help/kimi-work/release-notes), [FAQ](https://www.kimi.ai/help/kimi-work/kimi-work-faq))
- 3.2.0 (Aug 19): **built-in agent browser**; tabs are bound to conversations and live in the preview pane.
- 3.2.2 (Aug 26): **desktop pet** ("Kimi accompanies and interacts with you as a desktop pet"). 3.2.9 (Sep 14) refreshed it with **quick replies in the pet's speech bubble**.
- Permission levels: "Default" (routine actions automatic, sensitive local writes or code need approval), "Manual approval", and "Fully automatic" (needs an explicit risk acknowledgement). Marketed as "Ask before acting".
- 3.2.5 (Sep 4): remote control from phone. 3.2.11 (Sep 18): sub-agent execution shown in the detail panel.
- 3.2.15 (Sep 30): agent process **collapsed by default, final reply only**.

**Kimi Claw**
- Onboarding: "你好，我是你的小龙虾" (hi, I'm your little crayfish), give it a personality, give it a name, then "唤醒" (wake up), then "{name} 正在醒来" (… is waking up) (bundle).

**Kimi CU (Kimi Computer Use)**
- A proprietary macOS app (**KimiCU.app**, plus a Windows build) that exposes MCP tools: list_apps, get_app_state, click, type_text, press_key, scroll, set_value, perform_secondary_action, select_text, drag, paste, drag_paths, js.
- Official README ([plugin zip](https://cdn.kimi.com/kimi-computer-use/latest/kimi-cu-plugin.zip), v0.6.1): it operates apps "quietly… **never moving your mouse, never bringing the target app to the front** — you can keep using your computer".
- The bundled skill:
  - Tells the agent to abort when the user touches the window (`abort_if_cursor_in_window`).
  - Reports each action's effect as `confirmed`, `suspected_noop` or `unverifiable`.
  - Limits send, submit, delete and pay actions to scope the user explicitly authorised.
- Visible pointer: a third-party reverse-engineering report of 0.5.4 found an "overlay process" and XPC methods `showCursorWithX:y:` / `hideCursor`, described as "an **independent visual cursor overlay**". It also found a stale element index that clicked the wrong target yet reported success ([report, Aug 10 2026](https://github.com/hqhq1025/kimi-computer-use-lab/blob/main/reports/kimi-cu-reverse-engineering-2026-08-10.md)).
- A Sep 25, 2026 open-source PR gives its agent "its own on-screen pointer, **like Kimi CU**" ([PR](https://github.com/Hmbown/codewhale-cu-plugin/pull/5)). Its implementation is a reference design: cyan arrow with a badge, 180 ms glide before each action, a short ring on click, fade after 8 s idle, and excluded from screen capture so the agent's screenshots don't show it.
- Kimi CU became a built-in marketplace entry in Kimi Code 0.33.0 (2026-08-05), with Windows x64 in 0.34.0 on 2026-08-06 ([changelog](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/release-notes/changelog.md)).
- Kimi CU's exact pointer look, labels and animation are [UNVERIFIED]. Its original launch date is [UNVERIFIED].
- Kimi Browser Extension (formerly WebBridge): CDP-based, sidebar, "web action recording" ([how it works](https://www.kimi.ai/help/kimi-webbridge/kimi-webbridge-how-it-works)).

---

### 4. MiniMax Agent, now "MiniMax Code"

**Timeline**
- MiniMax Agent launched Jun 19, 2025 ([news](https://www.minimax.io/news/minimax-agent)).
- With M2 on Oct 27, 2025 it gained **Lightning Mode** (fast) and **Pro Mode** (long tasks) ([news](https://www.minimax.io/news/minimax-m2)). M2.5 followed Feb 12, 2026 ([news](https://www.minimax.io/news/minimax-m25)).
- Desktop app rebuilt on a "next-generation architecture" v3.0.20 on May 1, 2026 ([changelog](https://agent.minimax.io/docs/changelog)). It is now documented as **MiniMax Code**, a desktop agent app with **Coding** and **Work** modes. Work mode "focuses on progress and deliverables" ([docs](https://agent.minimax.io/docs/code/welcome), [modes](https://agent.minimax.io/docs/code/workflows/modes)).
- The 2025 web "computer panel" visuals: not found [UNVERIFIED].

**Agent cursor: the clearest shipped example**
- v3.0.58 (Aug 5, 2026): the built-in Browser gained "a **visible cursor with movement tracking** during Agent operations" and a mobile preview mode ([changelog](https://agent.minimax.io/docs/changelog)). Docs: "Agent actions on web pages now show a visible cursor and movement trail, making execution easier to follow" ([browser docs](https://agent.minimax.io/docs/code/desktop/browser)).
- Browser Use 2.0, multi-tab: v3.0.63 (Aug 12).
- Setting: "Automatically open Browser panel — Open the right-side Browser panel when the agent operates a web page" (bundle [88822](https://cdn.hailuo.ai/mavis-chat/prod-web-va-0.1.196/_next/static/chunks/88822-2a89dcbe759b6ce5.js)).

**Computer Use**
- **Temporarily disabled Jul 13, 2026 "due to compatibility and user experience concerns"**; "Improved Computer Use" arrived in v3.1.0 (Sep 30, 2026).
- Banner: "Computer Use mode is on — the agent can control mouse, keyboard, and screen." with a **Stop** button, and "Computer Use interrupted".
- Preview toggles: Desktop / Application, Show / Hide, "Connecting preview…" (bundle).

**Panels and states (bundle)**
- Right panel holds files, terminals and browser; a bottom terminal can be toggled; diffs can be unified or side-by-side.
- Tool summary: "Running {n} / Done {n} / Failed {n}"; "Performed {n} session actions"; verbs such as "Clicking", "Scrolling", "Read / Write / Edit file".
- Status cards: "Waiting for your reply", "Bot paused" with Resume, "Conversation error" with Restore, "Out of credit" (resumes where it stopped), and "Waiting for browser takeover".
- Browser handoff is **not supported on desktop**: "open this conversation on the cloud platform to take over."

**Permissions**
- v3.0.28 (May 19): permission cards "display LLM review rationale". Modes: **Ask First → Smart Authorize → Always Authorize**.
- Prompts read "The agent needs to run a terminal command: …", with choices "Only this conversation" or "Always allow" ([permissions docs](https://agent.minimax.io/docs/code/workflows/permissions)).
- Desktop notifications when tasks complete, error, or need permission (v3.0.27).
- Remote Control (Jul 20, 2026) lets you approve permission requests from your phone.
- Goal mode (Jul 27) shows status and elapsed time. Fork & Rewind arrived Aug 19.
- Infinite Canvas with HTML-node annotation ([docs](https://agent.minimax.io/docs/code/desktop/infinite-canvas)).

---

### 5. Brief notes
- **Flowith (Neo / Canvas):** agent work appears as canvas nodes and branches (chain, branch, fork). Sub-agents fan out visibly; results appear in real time. "Canvas Cowork" (2026) bridges Claude Code, Codex and others onto the canvas over a WebSocket ([post](https://flowith.io/blog/canvas-evolved-habitat), [post](https://flowith.io/blog/canvas-cowork-skill)).
- **Lovart:** visible step labels ("Analyzing user intent", "Searched for high-quality references", "Researching brand information"); assets land as a grid on a single canvas; edit verbs "Touch Edit / Move object / Text Edit / Remix" ([site](https://www.lovart.ai/)).
- **Coze Space (ByteDance):** bundle shows a "cloud computer" (up to 32 cores / 64 GB) for 24/7 agents, a "built-in browser", a cloud phone, and task-replay APIs (`/api/coze_space/get_task_replay`) ([space.coze.cn](https://space.coze.cn/)). Its modes and panel visuals are [UNVERIFIED].
- **Z.ai:** the full-stack agent's loading copy includes "Environment preparation", "Scaffolding setup" and **"Agent is putting on safety helmet"** ([bundle](https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.98/assets/index-BEIsjDOv.js)).
- **Skywork:** has "SkyClaw" with a console for "Agent config, skills, permissions, logs"; no visualization details found.
- **Qwen, Tencent Yuanbao:** not researched in depth; nothing notable verified.

---

### Cross-product takeaways
1. **Record events, not video, and replay them as theatre.**
   - Manus feeds recorded events back at 100 ms each, with a 3 s auto-start, "Skip to results" and "Watch again", and it fakes parallel subtask progress for readability.
   - Kimi's server re-streams the session, with "view result" to skip.
   - Best: **Manus.** For localDot: record typed events plus keyframe screenshots, and add speed control, which neither product has.
2. **A scrubber with a live edge.** Manus has Prev/Next, arrow keys, a timestamp tooltip, a green "Live" dot and a floating "Jump to live" pill. **Manus is the reference.**
3. **A presence line that names the tool, plus shimmering action chips.** "{name} is using Terminal" with "Executing command · `cmd`" in monospace. Best: **Manus.** Genspark's "Running {detail} on Agent's computer" is similar.
4. **Specific, friendly boot and waiting copy.** Kimi "is booting up…", Genspark "Starting the browser… up to ~10 s", Z.ai "putting on safety helmet". Best: **Genspark** for honesty about duration, **Z.ai** for charm.
5. **Handoff as a first-class flow.** A reason code, a "Keyboard captured" banner, a security warning ("a turn you did not start"), "Hand back to agent" with an optional note, then resume. Best: **Genspark GenTeam.** Manus's VNC takeover is simpler; MiniMax restricts takeover to cloud.
6. **Graduated, explained permissions.** Best for explanations: **MiniMax** (LLM rationale on each card; Ask First → Smart → Always). Best for scope choices: **Manus** (once / task / today / page, plus "Let Manus explain"). Kimi Work pairs "Fully automatic" with an explicit risk acknowledgement.
7. **An agent cursor that is never the user's cursor.** MiniMax ships a visible cursor with a movement trail in its browser. Kimi CU draws an overlay cursor and never moves the real mouse, with a user-activity guard. The Codewhale PR is a copyable spec (180 ms glide, click ring, 8 s fade, hidden from capture). Nobody found ships click ripples or a typing HUD, which leaves room for localDot.
8. **Show parallel sub-agents.** Best: **Kimi Swarm**: staged "recruiting" copy, per-agent status (including "clocked off"), and a per-agent toggle between computer view and activity trail. Manus adds skip / wrap-up controls and per-subtask replays.
9. **Companion persona.** Best: **Kimi**: Work's desktop pet with quick replies in its bubble, and Claw's name-and-personality "wake up" onboarding. This is directly relevant to localDot's avatar.
10. **Collapse by default and notify smartly.** Kimi Work (3.2.15) and MiniMax's Work mode hide the trace by default. Manus plays a single "done" sound when you are away, only once browser notifications are on. Loop detection belongs in the UI (Manus's "stuck in a loop" prompt).

*Note: one temporary scratch file was created in the session scratchpad during research and deleted right away. No project files were touched.*

## 2.4 UI-TARS-desktop, Agent TARS, AutoGLM and other Chinese GUI agents

*Research thread C2 (product plus source-code dive).*

**How I got this.** I read the code at `main` HEAD without cloning. UI-TARS-desktop was last pushed 2026-09-24. I also fetched AutoGLM's live web bundle and its locale JSON on 2026-09-30. The shared WebSearch budget ran out partway through, so some product-history claims could not be checked; those are marked [UNVERIFIED] with the reason. Where I quote UI strings that contain emoji, I describe the emoji in words instead.

---

### 1. UI-TARS-desktop (github.com/bytedance/UI-TARS-desktop, Apache-2.0)

**Where the project stands**
- **v0.2.4 (2025-08-21)** retired the built-in free remote operators ("sunset UI-TARS-desktop remote operator", #1135). Users were sent to the operators hosted on Volcano Engine instead ([release](https://github.com/bytedance/UI-TARS-desktop/releases/tag/v0.2.4)).
- **v0.3.0 (2025-11-04)** is really an Agent TARS release ([release](https://github.com/bytedance/UI-TARS-desktop/releases/tag/v0.3.0)).
- **All 2026 commits are security or maintenance fixes** (see §2). The desktop app's visual design is effectively frozen at mid-2025.

**Local-computer choreography.** `beforeAgentRun(LocalComputer)` does three things: `showWidgetWindow(); showScreenWaterFlow(); hideMainWindow();`. `afterAgentRun` reverses them ([utils/agent.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/utils/agent.ts)).

- **Edge glow ("water flow")**
  - A full-screen, transparent, click-through Electron window (`type:'panel'`, `setIgnoreMouseEvents(true)`) ([ScreenMarker.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/window/ScreenMarker.ts)). The CSS comes from Midscene:
    ```css
    background: linear-gradient(to right, rgba(30,144,255,0.4), transparent 50%) left, …(4 edges);
    background-size: 10% 100%, 10% 100%, 100% 10%, 100% 10%;
    animation: waterflow 5s cubic-bezier(0.4,0,0.6,1) infinite; /* keyframes: alpha .40/.39/.38, stop 50/52/55%, scale 1→1.03→1.05 */
    filter: blur(8px);
    ```
  - This window uses `setContentProtection(false)`, so the glow can show up in the model's screenshots. The widget and markers below are protected.
- **Floating widget**
  - A 400×400 frameless, transparent window: `alwaysOnTop`, `focusable:false`, `type:'toolbar'`.
  - Placed at `(screenW−432, screenH−496)`, i.e. a 32px right gutter and 96px above the bottom.
  - `setContentProtection(true) // not show for vlm model`.
  - Contents ([widget/index.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/widget/index.tsx)):
    - logo;
    - a pill badge reading "Computer" or "Browser";
    - the last action: "Action" + lucide icon + `click (start_box: …)`;
    - "Reflection", "Thought" or "Human Query" sections.
  - Styling: `bg-white/90`, radius 10px.
  - Controls: two 32px buttons at the bottom right, Pause/Resume and a red Stop (Square).
  - Pause is cooperative. A spinner (`spin 2s linear`, `#9ca3af`, [widget.css](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/widget/widget.css)) shows until the agent reports `status==='pause'`.
- **Click-marker overlay**
  - One transient, click-through, content-protected BrowserWindow per predicted action, at the predicted coordinates. It closes after 5s or at the next action.
  - The SVG comes from [setOfMarks.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/shared/setOfMarks.ts):
    - **Click family:** a 250×100 box with a dashed red ring (`r=16`, stroke 3, `dasharray "80 20"`, rotating 360° per `dur="1s"`), a red centre dot (`r=3`), and a red 16px system-font label with the action type, 65px right of the ring.
    - **Type:** a 400×100 box with `Typing: "<content>"`.
    - **Hotkey:** a 200×100 box with `Hotkey: ctrl + c`.
    - **Scroll, drag, hover:** commented out and never implemented.
- **Baked-in annotation.** The same SVG is composited onto the screenshot with `sharp`, giving `screenshotBase64WithElementMarker` ([utils/image.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/utils/image.ts), [runAgent.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/services/runAgent.ts)).
- **Cursor.** It is the real OS cursor, moved by NutJS at `mouse.config.mouseSpeed = 3600` along a straight line, with a 100ms dwell before each click ([nut-js operator](https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/operators/nut-js/src/index.ts)).

**Main window**
- **Layout:** a chat card at `basis-2/5` and a screenshot card at `basis-3/5`. In remote mode the right card has tabs: "Cloud Computer" or "Cloud Browser", plus "ScreenShot" ([remote/free.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/remote/free.tsx)).
- **ThoughtChain** ([source](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/components/ThoughtChain/index.tsx)):
  - Reflection and thought render as markdown.
  - Each action is a rounded outline pill: "Action: click (start_box: …)".
  - For `call_user` the pill reads "Waiting for user to take control".
  - Clicking a pill jumps the gallery to that step's marked screenshot.
  - A "Thinking..." row shows while the model is working.
- **ImageGallery** ([source](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/components/ImageGallery/index.tsx)):
  - A horizontal action strip: 36px icon, type/input, and `ms(cost)`.
  - The screenshot opens in medium-zoom (backdrop `rgba(0,0,0,.7)`, margin 50).
  - SkipBack/SkipForward buttons plus a step slider; it snaps to the latest step.
  - Icon map ([actions.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/const/actions.tsx)): click MousePointerClick, type Type, hotkey Keyboard, scroll ScrollText, drag Hand, wait Hourglass, finished CheckSquare, call_user RotateCcw, error_env AlertCircle.

**Remote operators (now sunset)**
- **Cloud Computer:** the VNC URL is shown in an iframe rendered at 1280×960 and scaled with `transform: scale(min(w,h,1))`, re-measured with a 200ms throttle. The tab stays mounted with CSS `hidden`, because "if an iframe is destroyed, the WebSocket (WSS) reconnection fails" ([cast/vnc.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/remote/cast/vnc.tsx)).
- **Cloud Browser** ([cast/canvas.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/remote/cast/canvas.tsx)):
  - puppeteer-core runs in the renderer and calls `Page.startScreencast {format:'jpeg', quality:80, everyNthFrame:1}`. Each frame is drawn to a canvas and acked.
  - The user's mouse, wheel and key input is forwarded through `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, so the human drives the same browser.
  - It follows new tabs via `targetcreated`/`targetchanged`. Viewport 1280×800.
- **Connection card** ([cast/status.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/remote/cast/status.tsx)):
  - States: init, queuing ("Position in queue: #n"), connecting, connected, expired ("Please create a new chat."), error, unavailable (history).
  - Each has an emoji icon, a pastel background and a dashed border.
  - Sessions are capped at 30 minutes, with a countdown chip and a red "Terminate" button.

**Pause and handoff**
- `StatusEnum` has `init | running | pause | end | call_user | user_stopped | error` (`max_loop` is deprecated) ([types/agent.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/shared/src/types/agent.ts)).
- The model prompt defines `call_user() # Submit the task and call the user when the task is unsolvable, or when you need the user's help.` The 1.5 prompt adds "Then, user will see and answer your question in `user_resp`." ([prompts.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/agent/prompts.ts)).
- The desktop passes `isCallUser` into `DefaultBrowserOperator.getInstance(...)` so the same browser is reused after the user acts.
- There is no sensitive-action confirmation and no in-app "take control" button.

**Report and replay**
- **Export.** "Export as HTML" appears only when the agent is not running and there is more than one message. It downloads a template from ByteDance's CDN (`…/ui_tars_desktop/share/v011/index.html`) and injects `<script type="ui_tars_web_dump" type="application/json">{GUIAgentData}</script>`. `GUIAgentData` contains version, instruction, systemPrompt, modelName, logTime, status, and conversations with timing, screenshots and parsed predictions ([ShareOptions.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/components/RunMessages/ShareOptions.tsx), [utils/html.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/utils/html.ts)).
- **Optional upload** shows this consent dialog (emoji-prefixed): "Would you like to share your report to help us improve **UI-TARS**? This includes your screen recordings and actions. … We encourage you to create a clean and privacy-free desktop environment before each use." Buttons: "No, just download" and "Yes, continue!".
- An MP4 screen-recording export exists (`getDisplayMedia` at 60fps) but is commented out.
- **Report player.** It is a Midscene fork with MIT headers ([player.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/visualizer/src/component/player.tsx), [replay-scripts.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/visualizer/src/component/replay-scripts.tsx)):
  - A Pixi.js canvas plays scripts `img | insight | clear-insight | pointer | spinning-pointer | sleep`.
  - Durations: `stillDuration=900, actionSpinningPointerDuration=300, stillAfterInsightDuration=300, locateDuration=800, actionDuration=1000, clearInsightDuration=200` ms.
  - During a camera move the pointer travels first (0.375 of the duration), then the camera pans and zooms.
  - Auto-zoom fits the target rect with padding of 10%, 20% or 30% of image width, depending on whether the rect is wider than 400px, wider than 50px, or smaller.
  - Element boxes fade in one by one in random order (80ms each). The matched element is highlighted `#fd5907` at alpha 0.4; others use `#01204E`; boxes have a 1px stroke and a (4,4) drop shadow with blur 2 ([color.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/visualizer/src/component/color.tsx), [blackboard.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/visualizer/src/component/blackboard.tsx)).
  - A spinning pointer (sinusoidal ease) shows while an action runs.
  - A 4px progress bar (track `#666`, fill `#06b1ab`) sits above title/subtitle rows. Press Space to replay ([player.less](https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/visualizer/src/component/player.less)).

**In-page overlays for browser operators** (`@gui-agent/operator-browser` UIHelper, Apache-2.0; [ui-helper.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/gui-agent/operator-browser/src/ui-helper.ts))
- **Click indicator:** a 60px circle with a 4px `#00ff9d` border and `rgba(0,255,157,.3)` fill, plus a 12px solid core. It runs `click-pulse 1.2s ease-out` (scale .8 to 2.5 while fading) and is removed at 1.2s.
- **Drag:** a 40px start dot `#ff6b00`, a 40px end dot `#00c3ff`, and a 6px gradient path at opacity 0.7 with an arrowhead. Lasts 3s.
- **"Next Action" HUD**
  - Style: fixed 20px from the top right, `rgba(0,0,0,.85)`, `backdrop-filter: blur(8px)`, radius 12, max width 320.
  - Header: the title in `#00ff9d`, 14px, uppercase.
  - Labels: emoji-prefixed ("Single Click", `Type: "…"`, "Navigate to: …", "Scroll down").
  - Also shows the thought in italics and a line `Click at: (x, y)`.
- **Set-of-Marks highlights, shown before each screenshot:** buttons `rgba(255,64,129,.8)`, links `rgba(124,77,255,.8)`, inputs `rgba(0,230,118,.8)`, other clickables `rgba(255,171,0,.8)`. Each is a 3px outline, with a legend at the bottom left.
- **Screenshot sequence** ([browser-operator.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/gui-agent/operator-browser/src/browser-operator.ts)):
  1. Glow on, highlights on, wait 300ms.
  2. Remove the HUD so the model doesn't see it.
  3. Take the screenshot (JPEG q75).
  4. Remove the highlights and the glow.
- **Click sequence:** indicator, 300ms, move, 100ms, click, 800ms settle.
- Both UI-TARS-desktop and Agent TARS construct this helper with all three overlays turned off ([agent-tars browser-gui-agent.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/agent-tars/core/src/environments/local/browser/browser-gui-agent.ts)).

**Verdict: functional but inconsistent.** Three unrelated palettes (red SVG, neon green, indigo), no easing when markers appear, and a plain widget. The idea worth keeping is the separation into three layers: marks the model sees, human-only chrome excluded from capture, and annotations baked into stored screenshots.

---

### 2. Agent TARS / Tarko (same repo, `multimodal/`)

**Release.** CLI v0.3.0 was announced 2025-11-05 with "streaming support for multiple tools…, runtime settings with timing statistics…, Event Stream Viewer…, [and] AIO agent Sandbox" ([README](https://github.com/bytedance/UI-TARS-desktop/blob/main/README.md)). The Web UI defaults to dark mode ([web-ui docs](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/websites/docs/docs/en/guide/basic/web-ui.mdx)).

**Browser modes** ([browser docs](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/websites/docs/docs/en/guide/basic/browser.mdx)):
- `dom`: Browser Use, DOM tree plus numbered highlights, works with non-vision models.
- `visual-grounding`: UI-TARS or Doubao coordinates, e.g. `click(point='<point>383 502</point>')`.
- `hybrid`: both action spaces; DOM first, vision as fallback.

**GUI-agent workspace view** ([BrowserControlRenderer.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/standalone/workspace/renderers/BrowserControlRenderer.tsx))
- **Data.** Tool arguments are `{thought, step, action}`. The result carries normalized 0–1 coordinates ([gui-agent.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-interface/src/gui-agent.ts)):
  ```ts
  export type ClickAction = BaseAction<'click', { startX: number; startY: number }>; // 0-1
  export interface ToolResponse<T extends Action = Action> {
    success: boolean; action: string; normalizedAction: T; observation?: string; error?: string; }
  ```
- **Screenshots are events, not tool output.** They arrive as `environment_input` events (WebP q20, `metadata:{type:'screenshot', url}`) at each loop start. The UI pairs each tool call with the nearest screenshot before and after it ([useScreenshots.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/useScreenshots.ts)).
- **ScreenshotDisplay** ([source](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/ScreenshotDisplay.tsx)):
  - An optional BrowserShell frame: 12px traffic lights (red-400, yellow-400, green-400) and a URL pill with a green lock for https ([BrowserShell.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/ai/BrowserShell.tsx)).
  - In "Both" mode, a grid labelled "BEFORE ACTION / AFTER ACTION".
  - A segmented Before / After / Both switch ([StrategySwitch.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/StrategySwitch.tsx)).
  - Defaults: `defaultScreenshotRenderStrategy:'afterAction', enableScreenshotRenderStrategySwitch:false, renderGUIAction:true, renderBrowserShell:true` ([web-ui-config.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/config/web-ui-config.ts)).
  - The cursor is drawn only on the before-action image, "as it indicates where the action will be performed" ([web-ui-implementation.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/interface/src/web-ui-implementation.ts)).
- **Virtual cursor** ([MouseCursor.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/MouseCursor.tsx))
  - Drawing: a 36px SVG arrow `M5 3L19 12L12 13L9 20L5 3Z` with a white-to-`#f5f5f5` gradient, a `#000` 1.5 stroke, and `drop-shadow(0px 2px 4px rgba(0,0,0,0.3))`.
  - Movement: it animates from the previous position (in %) to the new one with `transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}`.
  - Click ripple:
    - ring 1: 24px, grows to ×2.5 over 1.5s ease-out, looping;
    - ring 2: 20px, grows to ×2 over 1.2s after a 0.2s delay;
    - both rings: radial `rgba(99,102,241,.6/.8)` with borders at .3/.5;
    - core: a 4px white dot with `box-shadow 0 0 10px 2px` that pulses on a 0.7s yoyo.
  - Scope: shown only for click, double_click, left_double, right_click, right_single, drag and scroll ([useMousePosition.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/useMousePosition.ts)).
- **OperationDetailsCard** ([source](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/OperationDetailsCard.tsx)):
  - Enters with `initial {opacity:0,y:8}`, `0.4s ease [0.22,1,0.36,1]`.
  - Header "GUI Operation" with a status pill: "Completed" (emerald) or "Failed" (rose).
  - Sections: Thought (blue), Step (indigo), Action (monospace code).
- **ThinkingAnimation** ([source](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/ai/ThinkingAnimation.tsx)): a loader rotating every 2s (linear), shimmer text with a gradient sweeping every 0.5s, and "•••" fading between opacity .3 and 1 over 1.5s.
- **Live VNC.** A workspace nav item with `behavior:'embed-frame'` embeds it. Omni-TARS uses `{title:'VNC', link: sandboxBaseUrl+'/vnc/index.html?autoconnect=true', icon:'monitor', behavior:'embed-frame', autoActive:true}` ([omni-agent](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/omni-tars/omni-agent/src/index.ts)).

**Event Stream schema** ([agent-event-stream.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-interface/src/agent-event-stream.ts)). All events are flat and share `BaseEvent {id: string; type: string; timestamp: number}`.
```ts
export type CoreEventType =
  | 'user_message' | 'assistant_message' | 'assistant_thinking_message'
  | 'assistant_streaming_message' | 'assistant_streaming_thinking_message' | 'assistant_streaming_tool_call'
  | 'tool_call' | 'tool_result'
  | 'system' | 'agent_run_start' | 'agent_run_end'
  | 'environment_input' | 'plan_start' | 'plan_update' | 'plan_finish'
  | 'final_answer' | 'final_answer_streaming';

interface UserMessageEvent { content: string | ChatCompletionContentPart[] }
interface AssistantMessageEvent { content: string; rawContent?: string; toolCalls?: ChatCompletionMessageToolCall[];
  finishReason?: string; ttftMs?: number; ttltMs?: number; messageId?: string }
interface AssistantThinkingMessageEvent { content: string; isComplete?: boolean; thinkingDurationMs?: number; messageId?: string }
interface AssistantStreamingToolCallEvent { toolCallId: string; toolName: string;
  arguments: string /* DELTA only; client accumulates */; isComplete: boolean; messageId?: string }
interface ToolCallEvent { toolCallId: string; name: string; arguments: Record<string, any>; startTime: number;
  tool: { name: string; description: string; schema: any } }
interface ToolResultEvent { toolCallId: string; name: string; content: any; processedContent?: ChatCompletionContentPart[];
  elapsedMs: number; error?: string; _extra?: any }
interface SystemEvent { level: 'info'|'warning'|'error'; message: string; details?: Record<string, any> }
interface AgentRunStartEvent { sessionId: string; runOptions: AgentRunObjectOptions; provider?; model?; modelDisplayName?; agentName? }
interface AgentRunEndEvent { sessionId: string; iterations: number; elapsedMs: number; status: AgentStatus }
interface EnvironmentInputEvent { content: string | ChatCompletionContentPart[];
  description?: string /* goes into context */; metadata?: { type: 'screenshot'; url?: string } | … /* NOT in context */ }
interface PlanUpdateEvent { sessionId: string; steps: { content: string; done: boolean }[] }
interface PlanFinishEvent { sessionId: string; summary: string }
interface FinalAnswerEvent { content: string; isDeepResearch: boolean; title?: string; format?: string; messageId?: string }
```
- The schema is extensible: third-party events plug in through `interface ExtendedEventMapping {}` (module augmentation).
- `AgentStatus` is `idle | executing | aborted | error` ([agent-instance.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-interface/src/agent-instance.ts)).
- **The docs disagree with the code.** The [event-stream](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/websites/tarko/docs/en/guide/basic/event-stream.mdx) and [agent-protocol](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/websites/tarko/docs/en/guide/advanced/agent-protocol.mdx) pages show a `{type, data:{…}}` envelope and names like `assistant_message_delta`. Treat the TypeScript as the source of truth.
- **Transport**
  - SSE on `POST /api/v1/sessions/query/stream`, one `data: ${JSON.stringify(event)}\n\n` per event.
  - `POST /api/v1/sessions/abort`.
  - The UI reads the stream with `fetch` plus `ReadableStream.getReader()`, not `EventSource` ([routes/queries.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-server/src/api/routes/queries.ts), [apiService.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/common/services/apiService.ts)).
- **Event Stream Viewer** ([EventStreamModal.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/standalone/modals/EventStreamModal.tsx)):
  - A full-screen black modal titled "Event Stream Debug", with "Session: … | Events: n/m" in the header.
  - Rows show the ISO timestamp (yellow-400, mono), the type (blue-400) and a summary.
  - Filter by type, expand a row to JSON, auto-scroll.

**Share and replay**
- **Single-file export.** agent-ui-builder injects state into the page ([builder.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui-builder/src/builder.ts)), and the same React app then replays offline:
  ```js
  window.AGENT_REPLAY_MODE = true; window.AGENT_SESSION_DATA = {...}; window.AGENT_EVENT_STREAM = [...];
  // optional: AGENT_VERSION_INFO, AGENT_WEB_UI_CONFIG
  ```
- **Upload.** With a share provider configured, the server generates a slug from the query with an LLM, uploads workspace images and rewrites their paths ([ShareService.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-server/src/services/ShareService.ts)). The modal offers "Upload and get a link to share" and "Download HTML".
- **Opening a replay.** `?replay=1` starts a 3-second countdown, then autoplays. Otherwise the page jumps to the final state. `?focus=<file>` opens a generated file in the workspace ([useReplayMode.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/common/hooks/useReplayMode.tsx)).
- **Controls** ([ReplayControlPanel.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/standalone/replay/ReplayControlPanel.tsx)):
  - a mono "i/N" counter;
  - a range slider from 0 to 1 in steps of 0.001, with a "%" readout;
  - Play/Pause, "Reset and play", "Jump to final state";
  - speed buttons 0.5×, 1×, 2×, 4×;
  - the panel slides up from y 20.
- **Engine** ([useReplay.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/common/hooks/useReplay.ts)): events play at `Math.max(200, 800/speed)` ms each. Scrubbing clears state and re-processes events 0 to i. Pacing is by event count, not by real timestamps.

**2026 security fixes (the baseline to copy for a localhost-first agent)**
- **#1853 (2026-03-27):** CORS allowlist, CSRF token on mutations, security headers ([PR](https://github.com/bytedance/UI-TARS-desktop/pull/1853)).
- **#1975 and #2026 (2026-09-24)** ([#1975](https://github.com/bytedance/UI-TARS-desktop/pull/1975), [#2026](https://github.com/bytedance/UI-TARS-desktop/pull/2026)):
  - `Host` header validation against DNS rebinding. Allowed: `localhost`, `127.0.0.1`, `[::1]`, `[::ffff:127.0.0.1]`, plus `TARKO_ALLOWED_HOSTS`.
  - Why it was needed: a same-origin GET carries no `Origin` header, so the origin allowlist let it through.
  - Once the server binds beyond loopback, a token is required: `--auth-token` or `TARKO_AUTH_TOKEN`, sent as Bearer or `?token=`.
  - The UI strips the token from the address bar and stores it.
  - Failed attempts are limited to 30 per minute; `/api/v1/health` stays open.
- **#1938 (2026-09-24):** HTML-preview iframes used `allow-scripts allow-same-origin`, which let them escape the sandbox. Previews now use `allow-scripts` only, with double-buffered `srcDoc` frames swapped on `load` and a 200ms throttle ([PR](https://github.com/bytedance/UI-TARS-desktop/pull/1938)).

---

### 3. Zhipu AutoGLM

**Timeline**
- **2024-10-28, first AutoGLM (phone and web).** The paper describes an Android client built on AccessibilityService, for invited testers, and web capabilities through the "Qingyan Browser Plugin" ([arXiv 2411.00820 HTML](https://arxiv.org/html/2411.00820v1), [project page](https://xiao9905.github.io/AutoGLM/)).
- **2025-08-19, ComputerRL paper:** "The algorithm and framework are adopted in building AutoGLM" ([arXiv 2508.14040](https://arxiv.org/abs/2508.14040)).
- **AutoGLM 2.0 with a cloud phone and cloud computer (August 2025): [UNVERIFIED]** as a launch date and framing; it rests on memory. The cloud computer and takeover flow themselves are confirmed in the live bundle below.
- **2025-12-08, Open-AutoGLM.** Code is Apache-2.0, with AutoGLM-Phone-9B and a Multilingual variant; last push 2026-03-06 ([repo](https://github.com/zai-org/Open-AutoGLM)).
- **2026 repositioning.** autoglm.zhipuai.cn is now titled "AutoGLM：你的超级报告助手" (AutoGLM: your super report assistant). Zhipu also ships **AutoClaw (澳龙)**, a one-click local OpenClaw client for Windows and macOS ("GLM-5.3-Flash 已上线", i.e. GLM-5.3-Flash is now live) that does browser automation (page meta on [autoglm.zhipuai.cn](https://autoglm.zhipuai.cn/) and [autoclaw.zhipuai.cn](https://autoclaw.zhipuai.cn/)).

**Live web app** (from [bundle index-B5g-Ih_A.js](https://autoglm.zhipuai.cn/assets/index-B5g-Ih_A.js), [zh locale](https://autoglm.zhipuai.cn/locales/zh/common.json), [en locale](https://autoglm.zhipuai.cn/locales/en/common.json))
- **Streaming.** The cloud computer is streamed with Alibaba Cloud's **Wuying Web SDK** (`<wuying-web-sdk id="sessionIframe">`, assets from `g.alicdn.com/aliyun-ecs/WuyingWebSdk-multi`). It is a rented cloud desktop, not VNC.
- **Right-hand panel**
  - Tabs, plus a switch "实时跟随进度" (en "Live"; toggle text "实时跟随开启/关闭", live follow on/off).
  - Panes: the cloud computer, an **OperationList** of steps (from `tool_result.meta_list`), an **ImagesList** of "网页预览图" (web page preview) thumbnails with skeleton placeholders, a code space, and a file previewer.
- **View-only by default.** A mask covers the live desktop. Clicking it shows the toast "操作需要接管电脑" (operation requires taking over the computer); in OpenClaw mode it says "当前状态不支持接管" (takeover not supported in this state).
- **Takeover mode.** The logo appears with a "退出接管" button (en "Exit control"). On mobile there are zoom in/out buttons (scale `1 + n*0.3`, n from −3 to 3), a rotate button, and a copy-link prompt "电脑端访问AutoGLM体验更佳" (better experience on a computer).
- **Machine-status dot**, labelled "状态：" (status):
  ```js
  {not_started:{color:"#9E9E9E",label:"未启动"}, starting:{color:"#9E9E9E",label:"启动中"},
   connected:{color:"#36B261",label:"已就绪"}, released:{color:"#9E9E9E",label:"已释放"},
   in_progress:{color:"#36B261",label:"工作中"}, error:{color:"#F05656",label:"启动失败"},
   need_takeover:{color:"#FA920A",label:"等待接管"}}
  ```
  (not started / starting / ready / released / working / failed to start / waiting for takeover)
- **Header status line:**
  - "AutoGLM 正在回复..." (replying)
  - "AutoGLM 正在沉思..." and "AutoGLM 沉思完成" (ruminating / rumination complete)
  - "AutoGLM 正在总结..." (summarising)
  - "AutoGLM 正在操作浏览器..." (operating the browser; subtitle is the task)
  - "AutoGLM 等待用户接管..." (waiting for the user to take over; status `warning`)
- **Other chrome:**
  - an mm:ss elapsed timer while streaming;
  - when the panel is closed, a floating "MiniComputer" card with the tooltip "查看 AutoGLM 的电脑" (en "View AutoGLM's computer") and a maximize icon on hover.
- **Takeover and sensitive-action card.** Its body reads "我正在访问网站，发现需要先进行操作才能搜索内容。网站要求用户必须进行操作才能使用这些功能。" (I'm visiting the website and found that an action is needed before I can search; the site requires the user to act to use these features.) Its title depends on the case:
  - **Sensitive** (argument contains "请确认" or `message_type==='sensitive_confirm'`): "当前操作属于敏感操作，为保障操作安全，请确认是否继续。" (This operation is sensitive; to keep it safe, please confirm whether to continue.)
  - **Local login:** "当前步骤需要您操作本地浏览器，完成账户登录后继续任务。" (This step needs you to use your local browser; the task continues after you log in.)
  - **Default:** "您可以选择是否接管电脑，手动完成本次操作。" (You can choose to take over the computer and do this step manually.)
  - **Buttons:** "查看" (view), "去登录" (go log in) or "去验证" (go verify); a mouse-icon button with a server-supplied label; and a skip link with a **200-second countdown that auto-skips**. A skip is logged into the step as "跳过 - 您已经跳过登录" (en "Skip – You have already skipped login").
  - **Locale variant:** "当前步骤需要您手动接管，请完成登录后继续任务" (en "Manual intervention required. Please log in to continue").
- **Local mode (runs in your own browser through an extension):**
  - "自动化调试模式 — AutoGLM 接管浏览器进行调试与操作，您可以随时点击取消以终止任务。" (Automation debugging mode: AutoGLM takes over the browser; you can click cancel at any time to end the task.)
  - "关闭敏感标签页撤销授权 — 当您对操作有疑问时，直接关闭对应的标签页即可立即停止任务并撤销授权。" (Close the sensitive tab to revoke authorization: if in doubt, closing the tab immediately stops the task and revokes authorization.) Closing the tab is the kill switch.
- **Not present:** no audio or Notification API usage in the bundle.

**Open-AutoGLM code** (a Python CLI with no GUI)
- **Handler.** `ActionHandler(confirmation_callback, takeover_callback)`. A Tap that carries a `message` is treated as sensitive. If the user declines, it finishes with "User cancelled sensitive operation" ([handler.py](https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/actions/handler.py)). Defaults:
  ```python
  response = input(f"Sensitive operation: {message}\nConfirm? (Y/N): ")
  input(f"{message}\nPress Enter after completing manual operation...")
  ```
- **Chinese prompt** ([prompts_zh.py](https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/config/prompts_zh.py)), coordinates 0–999:
  - `do(action="Tap", element=[x,y], message="重要操作")`: "点击涉及财产、支付、隐私等敏感按钮时触发。" (used when tapping buttons involving property, payments or privacy)
  - `do(action="Take_over", message="xxx")`: "在登录和验证阶段需要用户协助" (user help needed during login and verification)
  - `do(action="Interact")`: "当有多个满足条件的选项时…询问用户如何选择" (when several options qualify, ask the user to choose)
- **The English prompt lacks all of these** ([prompts_en.py](https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/config/prompts_en.py)). It defines only Tap, Type, Swipe, Long Press, Launch, Back and Finish, so the safety hooks are dormant in English runs.
- **Secure screens (FLAG_SECURE).** A failed `screencap` returns a black fallback image with `is_sensitive=True` ([adb/screenshot.py](https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/adb/screenshot.py)). The README says the agent "会自动检测并请求人工接管" (will detect this and request human takeover). I found no branch on `is_sensitive` in agent.py, so the takeover depends on the model choosing Take_over.
- **Console output:** a thought-bubble emoji with "思考过程" (thinking) and a target emoji with "执行动作" (action), followed by the action as JSON ([i18n.py](https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/config/i18n.py)).
- **Community Android port** ([Luokavin/AutoGLM-For-Android](https://github.com/Luokavin/AutoGLM-For-Android), MIT):
  - A floating window with a step list, colour-coded by status: waiting/paused `#FFB74D`, completed `#81C784`, failed `#EF5350`.
  - It **hides the overlay, waits 200ms, captures, waits 100ms, then shows it again**, so the model never sees it (`ScreenshotService.kt`).
  - Takeover strings: "需要手动操作 / 请完成以下操作 / 已完成，继续" (manual action needed / please complete the following / done, continue).
- **Not verified:** visual details of the 2024 Android client, such as a floating bubble. The paper and project page don't describe them.

---

### 4. Other Chinese GUI agents (visual UX only)

- **Alibaba Mobile-Agent / GUI-Owl** ([X-PLUG/MobileAgent](https://github.com/X-PLUG/MobileAgent), MIT)
  - Hosted demos run on Wuying cloud desktops and phones through ModelScope and Bailian (2025-09-24).
  - Mobile-Agent-v3.5 became available on the Wuying Cloud Phone "MobileClaw" (2026-03-31). Its layout is a live phone simulator on the left, chat on the right, and a Tasks page with status and failure reasons ([Aliyun doc](https://help.aliyun.com/zh/ecp/quickly-experience-and-create-cloud-phone-mobileclaw)).
  - GUI-Owl-1.5 released 2026-02-14.
  - The local PC runner is crude ([utils.py](https://github.com/X-PLUG/MobileAgent/blob/main/Mobile-Agent-v3.5/computer_use/utils.py), [runner](https://github.com/X-PLUG/MobileAgent/blob/main/Mobile-Agent-v3.5/computer_use/run_gui_owl_1_5_for_pc.py)):
    - `StepPopup.show_blocking` is an always-on-top Tk window: `#1f1f1f` background, 960×540, image 55% of the height, with "Auto-close in Ns (Esc/Enter to dismiss)".
    - `call_user` and `interact` open "User Interaction Required" for up to 120s.
    - `annotate_screenshot` draws a red dot (r=15) or a red arrow (width 2, head 10) and saves it to disk after each action.
- **ByteDance Doubao phone assistant** ([zh.wikipedia 豆包大模型](https://zh.wikipedia.org/wiki/豆包大模型))
  - 2025-12-01: a nubia M153 engineering sample shipped a "豆包手机助手技术预览版" (technical preview), described as a "系统级AI Agent，可跨APP自动操作、比价下单" (system-level agent that operates across apps, compares prices and places orders).
  - Users couldn't log into WeChat or were forced offline, and Doubao "已下线操作微信的能力" (withdrew the ability to operate WeChat).
  - 2026-07-08: model filing approved. 2026-09-16: the mass-production nubia NaviX Ultra launched.
  - How it looks on screen (indicators, background execution, payment confirmation): **[UNVERIFIED]**, not found in accessible sources.
  - Relevant to the avatar companion: on 2026-07-15 Doubao and Tongyi Qianwen removed "personified agent" features when China's AI anthropomorphism measures (AI拟人化管理办法) took effect. The only source is the citations on [en.wikipedia Doubao](https://en.wikipedia.org/wiki/Doubao), refs 15–16.
- **Volcengine Computer Use Agent demo** (Doubao-1.5-UI-TARS, [ai-app-lab/demohouse/computer_use](https://github.com/volcengine/ai-app-lab/tree/main/demohouse/computer_use)): a Next.js app showing Linux through a VNC iframe titled "远程桌面" (remote desktop) and Windows through a bundled Apache Guacamole. The file headers carry Volcengine's "原型应用软件自用许可协议" (a self-use-only licence), not Apache.
- **Midscene.js** (ByteDance web-infra, MIT, v1.14.0 released 2026-09-29; [repo](https://github.com/web-infra-dev/midscene)). It is where UI-TARS's report player and edge glow came from, and it has since been rebuilt around frames:
  - `FPS = 30` ([frame-calculator.ts](https://github.com/web-infra-dev/midscene/blob/main/packages/visualizer/src/component/player/scenes/frame-calculator.ts)).
  - Pointer sprite 44×56 with its hotspot at (6,4), scaled by `max(1, sqrt(imageWidth/1920))` ([pointer-layout.ts](https://github.com/web-infra-dev/midscene/blob/main/packages/visualizer/src/component/player/scenes/pointer-layout.ts)).
  - `POINTER_PHASE = 0.375`, `CROSSFADE_FRAMES = 10`.
  - **Video export:** 960×540 WebM through `canvas.captureStream(fps)` and `MediaRecorder` ([export-branded-video.ts](https://github.com/web-infra-dev/midscene/blob/main/packages/visualizer/src/component/player/scenes/export-branded-video.ts)).
  - Highlight `rgba(253,89,7,.4)` with a `#fd5907` border; search area `rgba(2,131,145,.4)` with `#028391`.
  - `actionDuration` is now 500ms.
  - The Chrome extension's live pointer is a 30px `rgba(0,0,255,.3)` circle with `transition: all 1s ease-in`. It fades after 3s, and the glow turns itself off after 30s idle ([water-flow.ts](https://github.com/web-infra-dev/midscene/blob/main/apps/chrome-extension/src/scripts/water-flow.ts)).
- **Tencent AppAgent** (MIT): numbered element labels on screenshots plus a grid mode (`rgb(255,116,113)`). Research-grade ([utils.py](https://github.com/TencentQQGYLab/AppAgent/blob/main/scripts/utils.py)).
- **Honor YOYO, Xiaomi, vivo:** not verified in this pass because the search budget was used up.

**Across all four subjects:** no product uses sound. Streaming latency is not published anywhere I looked.

---

### Cross-product takeaways

1. **Keep three overlay planes separate.**
   - Marks the model should see (Set-of-Marks highlights).
   - Chrome only the human sees (cursor, heads-up display, glow). The products exclude it from capture with Electron `setContentProtection`, by hiding it 200ms before capture and 100ms after, or by removing it from the DOM before `page.screenshot`.
   - Annotations baked into stored screenshots for replay.
   - Because localDot streams the VM into a web page, it can draw all human overlays in the browser layer. The model then never sees them. Store action geometry in events rather than baking it into pixels.
2. **Telegraph, act, settle.**
   - UI-TARS's browser operator: show the indicator, wait 300ms, move, wait 100ms, click, then settle for 800ms.
   - Midscene: the cursor travels in the first 37.5% of a step, then the camera moves.
   - Tarko: the cursor glides over 0.5s with ease `[0.16,1,0.3,1]`.
3. **Put normalized coordinates in the event** (0–1 in Tarko, 0–999 in AutoGLM) and position overlays in percent. This makes them independent of resolution and scaling.
4. **Event-sourced replay is the strongest design.** The same UI consumes live SSE and an embedded `AGENT_EVENT_STREAM`, screenshots travel as `environment_input` events, and scrubbing replays the reducer. Improve on Tarko by pacing replay by timestamp (compressing long gaps) rather than a fixed 800ms per event.
5. **Make handoff a first-class state**, as AutoGLM does:
   - an amber `need_takeover` dot (`#FA920A`) labelled "等待接管" (waiting for takeover);
   - a view-only mask with explicit "Take control" and "Exit control";
   - a 200s auto-skip countdown whose skip is recorded in the step;
   - "close the tab to stop and revoke" as a kill switch.
6. **Gate sensitive actions on two kinds of signal.** One is a flag the model emits (AutoGLM's `message` on Tap, `sensitive_confirm`). The other is an environment signal (FLAG_SECURE producing a black screenshot, login walls). Ship native wording, e.g. "当前操作属于敏感操作，为保障操作安全，请确认是否继续。" and make sure every prompt language defines these actions; Open-AutoGLM's English prompt does not.
7. **Show "agent is operating" peripherally.** An edge glow at `rgba(30,144,255,.4)`, 5s breathing, blur 8px, plus a verb-based status line ("正在操作浏览器…", "等待用户接管…", i.e. operating the browser / waiting for the user) and an elapsed timer.
8. **Framing aids:** a Before/After/Both toggle; a browser-chrome frame with the URL; auto-zoom to the target rect with padding tiers of 10%, 20% and 30%; element boxes fading in at 80ms each.
9. **Adopt the localhost security baseline from Tarko's 2026 fixes from day one:** a `Host` allowlist, a token whenever the bind is non-loopback, CSRF, and preview iframes that never combine `allow-scripts` with `allow-same-origin`.
10. **Ship a portable artifact:** single-file HTML with the embedded event JSON and a `?replay=1` autoplay, plus an optional WebM export through `captureStream` and `MediaRecorder`.

### Directly reusable OSS pieces

- **Midscene visualizer (MIT):** frame player, replay-scripts camera maths (`cameraStateForRect`), pointer layout, video export, water-flow CSS ([packages/visualizer](https://github.com/web-infra-dev/midscene/tree/main/packages/visualizer)).
- **@tarko/ui gui-agent components (Apache-2.0 per the repo licence; package.json declares none):** MouseCursor, ScreenshotDisplay, StrategySwitch, OperationDetailsCard, ThinkingAnimation, BrowserShell ([dir](https://github.com/bytedance/UI-TARS-desktop/tree/main/multimodal/tarko/ui/src/components/gui-agent)).
- **@tarko/agent-interface (Apache-2.0):** the `AgentEventStream` and `GUIAgent` types, a good starting schema.
- **@tarko/agent-ui (Apache-2.0):** replay code (ReplayControlPanel, useReplay, useReplayMode) and agent-ui-builder for the HTML dump.
- **@gui-agent/operator-browser UIHelper (Apache-2.0):** click, drag, heads-up display and Set-of-Marks CSS.
- **UI-TARS-desktop (Apache-2.0):**
  - `ScreenMarker`/`setOfMarks` (headers also credit Midscene MIT portions);
  - `cast/canvas.tsx`, a CDP screencast with input forwarding for a take-control browser view.
- **Tarko server middleware (Apache-2.0):** Host validation and auth token (PRs #1975 and #2026).
- **AIO Sandbox** ([agent-infra/sandbox](https://github.com/agent-infra/sandbox), Apache-2.0, v1.11.0 released 2026-06-23): one container with Chromium plus VNC at `/vnc/index.html?autoconnect=true`, CDP, code-server, Jupyter, shell and MCP; `SANDBOX_API_KEY`; bind to 127.0.0.1. A ready-made isolated Linux desktop for localDot.
- **Open-AutoGLM (Apache-2.0):** the confirmation/takeover callback pattern and the Chinese prompt wording.
- **AutoGLM-For-Android (MIT):** the hide-before-capture timing.
- **Do not reuse:** the AutoGLM web app and the Wuying SDK (proprietary), and the Volcengine demo frontend (self-use licence).

## 2.5 Open-source computer-use UIs (source dive)

*Research thread D: Bytebot, Cua (incl. the cua-driver agent cursor), Magentic-UI, E2B Surf, OpenAI/Anthropic samples, Kortix Suna, HF Open Computer Agent, Browser Use, Skyvern, Stagehand, Magnitude, matinee, and others.*

**How this was gathered:** I read the code on each repo's default branch through the GitHub API and raw files on 2026-09-30, unless a ref is named. Stars, licenses and last-push dates come from the GitHub API on the same day. I did not use WebSearch; the one web source is the Browserless docs page. Nothing was cloned and no files were written.

### At a glance

| Project | Stars / license / last push | Live view | How actions are shown | Takeover | Replay |
|---|---|---|---|---|---|
| Bytebot | 11.1k / Apache-2.0 / 2025-09-12, **archived** | react-vnc, websockify, x11vnc on Xvfb | Chat rows only, no on-screen overlay | Take Over / Proceed; human input is recorded | Screenshot follows the chat scroll position |
| Cua | 27.5k / MIT / 2026-09-29 | noVNC RFB; Lume uses a private VZ VNC server | **Native animated agent cursor with a session pill**; web replay cursor | Fleet view is interactive | Trajectory viewer; zoom-on-click MP4 render |
| Magentic-UI (now MagenticLite) | 10.1k / MIT / 2026-09-23 | react-vnc, per-slot noVNC inside a Quicksand VM | In-page red dot cursor and red border; frosted "thoughts" overlay | agent → user-pending → user | LIVE switch plus scrubber |
| E2B Surf / Desktop | 869 and 1.5k / Apache-2.0 | x11vnc + noVNC in an iframe | JSON action cards in chat | Iframe is interactive | None |
| OpenAI CUA sample | 1.9k / MIT / 2026-09 | Screenshots only | None | Stop only | Scrubber, filmstrip, "Replay JSON" |
| Anthropic computer-use demo | 17.8k (claude-quickstarts) / MIT | noVNC iframe | Streamlit code blocks | Toggles `view_only` | None |
| Kortix (Suna) | 20.2k / **Elastic-2.0 now** (Apache-2.0 in Dec 2025) | 2025: noVNC `vnc_lite` iframe | Tool-view registry | – | Step slider; Jump to Live / Latest |
| Browser Use | 116.8k / MIT | CDP (the cloud `liveUrl` viewer is closed-source) | Corner brackets and click ring in-page; numbered boxes | – | CDP screencast to MP4 |
| Skyvern | 23.1k / **AGPL-3.0** | noVNC, or CDP screencast `<img>` with CDP input | Blue hint boxes | take-control / cede-control | Action screenshots and recordings |

---

### 1. Bytebot (bytebot-ai/bytebot)

- **Status.** The repo is archived; the last commit was 2025-09-11. Use it as a reference, not a dependency.
- **Desktop stack** ([supervisord.conf](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebotd/root/etc/supervisor/conf.d/supervisord.conf)):
  - `Xvfb :0 -screen 0 1280x960x24`, then XFCE4.
  - `x11vnc -display :0 -N -forever -shared -rfbport 5900`.
  - `websockify 6080 localhost:5900`.
  - The NestJS daemon `bytebotd`.
- **Streaming in the UI** ([VncViewer.tsx](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/vnc/VncViewer.tsx)):
  - Dynamically imports `react-vnc`'s `VncScreen`, so it is SSR-safe.
  - Options: `rfbOptions={{secure:false, shared:true, wsProtocols:["binary"]}}` and `scaleViewport`.
  - It forces a remount when control changes, via `key={viewOnly ? "view-only" : "interactive"}`.
- **Proxy.** A custom Express `server.ts` proxies `/api/proxy/websockify` to the VNC target and `/api/proxy/tasks` to Socket.IO ([server.ts](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/server.ts)).
  - Socket events: `task_updated`, `new_message`, `task_created`, `task_deleted`, `join_task` / `leave_task` ([useWebSocket.ts](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/hooks/useWebSocket.ts)).
- **Layout.** A 1280:960 box, capped at 1280×960. Live VNC while the task is active; a static screenshot once it is completed, failed or cancelled ([desktop-container.tsx](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/ui/desktop-container.tsx)).
- **Status header** ([VirtualDesktopStatusHeader.tsx](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/VirtualDesktopStatusHeader.tsx)):
  - States: running, needs_attention, failed, canceled, pending, user_control, completed, live_view.
  - Each has an SVG dot and gradient text, e.g. user_control shows "Running / You took control" in `from-pink-500 to-fuchsia-700`.
- **Takeover** ([tasks/[id]/page.tsx](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/app/tasks/%5Bid%5D/page.tsx), [takeover-mode.mdx](https://github.com/bytebot-ai/bytebot/blob/main/docs/guides/takeover-mode.mdx)):
  - "Take Over" (waving-hand icon) appears when `control===ASSISTANT && status===RUNNING`. "Proceed" hands control back. Cancel sits in a kebab menu.
  - VNC stays `viewOnly` unless the user has control.
  - Takeover is automatic when the agent sets `NEEDS_HELP`.
  - A separate Desktop tab lets you use the machine freely; "Nothing is recorded" there.
- **Human input recording** (`uiohook-napi`, [input-tracking.service.ts](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebotd/src/input-tracking/input-tracking.service.ts)). Human actions are converted into the agent's own action space:
  - Clicks are debounced 250 ms and the largest `clickCount` wins (double/triple).
  - Drags are kept as a path if it has more than 3 points.
  - Wheel events become one scroll action per 4 same-direction ticks.
  - Printable keys are buffered into `type_text` after 500 ms idle.
  - A screenshot is taken 250 ms after the mouse settles.
  - The UI renders takeover actions in fuchsia ([ComputerToolContentTakeOver.tsx](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/messages/content/ComputerToolContentTakeOver.tsx)).
- **Action log** ([ComputerToolUtils.tsx](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/messages/content/ComputerToolUtils.tsx), [ComputerToolContentNormal.tsx](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/messages/content/ComputerToolContentNormal.tsx)):
  - Each row is icon + label + detail chip.
  - Labels include Click / Double Click / Triple Click / Right Click, "Type", "Keys", "Scroll down 3", "Drag From: x,y → To: x,y", "Wait 500ms", "Open Application".
  - Text marked sensitive is shown as `●` repeated for its length.
  - Screenshot tool calls are hidden.
- **Replay: "the chat is the scrubber"** ([useScrollScreenshot.ts](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/hooks/useScrollScreenshot.ts), [screenshotUtils.ts](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/utils/screenshotUtils.ts)).
  - The desktop pane shows the screenshot for the message nearest 350 px from the top of the chat viewport.
  - Scrolling is throttled to 100 ms and a MutationObserver re-checks when content changes; markers use `data-message-index` / `data-block-index`.
- **Cursor.** None. nut-js `mouse.setPosition` teleports the pointer, with `autoDelayMs=100` ([nut.service.ts](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebotd/src/nut/nut.service.ts)).

### 2. Cua (trycua/cua), including a close look at the cua-driver agent cursor

#### The agent cursor (the most complete open-source one I found)

- **Where it lives.** A Rust crate, `libs/cua-driver/rust/crates/cursor-overlay` (driver v0.30.4, MIT, [Cargo.toml](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Cargo.toml)).
  - It draws into click-through overlay windows on macOS, Windows, X11 and Wayland, rasterised with tiny-skia at the display's backing scale.
  - One overlay can composite several session cursors ([render_state.rs](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/render_state.rs)).
- **Look** ([theme.rs](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/theme.rs), [cursor-themes.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/cursor-themes.md)):
  - 42 pt pointer: session-coloured fill, white outline, cursor-shaped glow.
  - The default cursor is `#5EC0E8`. Named sessions hash into a 9-colour palette: (178,132,255), (247,132,170), (96,218,174), (244,178,66), (76,204,224), (221,113,236), (232,82,98), (184,220,54), (80,126,236).
- **Motion** ([motion.rs](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/motion.rs), [path_planner.rs](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/path_planner.rs), [bezier.rs](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/bezier.rs), `tick_motion` in render_state.rs):
  - Path: a Dubins arc–straight–arc path with an 80 pt turn radius, or a cubic Bezier (handles 0.3, arc 0.25).
  - Speed: `16·u²·(1−u)²` shapes the speed between a floor (300 pt/s in the first half, 200 pt/s in the second) and a 900 pt/s peak. An optional fixed `glide_duration_ms` overrides this.
  - The arrow's heading follows the path tangent.
  - On arrival a spring takes over. Windows/Linux: `k = spring·400`, `c = spring·20`, spring = 0.72. macOS: k = 400, c = 17. The spring gets an impulse of 0.5× the arrival speed and settles below 0.3 pt and 2 pt/s.
  - Click pulse lasts about 0.25 s; press visual 120 ms; post-click dwell 80 ms.
- **Idle behaviour:**
  - A shared 4 s float loop: x = `sin·5`, y = `6·cos − 5`, rotation 2.5°·cos.
  - Hidden after 20 s of inactivity, via a 180 ms alpha ramp.
  - Reduced-motion mode shows a still frame.
- **Semantic states.** Twelve actions: idle, observe, click, drag, scroll, text, key, navigate, app, transfer, record, system.
  - Themes are dotLottie files (128×128, 30 fps, at most 120 frames per action and 1,000 total).
  - An unprivileged compiler turns them into `.cua-theme` vector frames; the privileged overlay never parses Lottie or JSON ([personalize-cursor.mdx](https://github.com/trycua/cua/blob/main/docs/content/docs/how-to-guides/driver/personalize-cursor.mdx)).
- **Session pill** ([session_badge.rs](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/session_badge.rs)):
  - 25 pt below the pointer, 28 pt tall, at most 188 pt wide, Inter 11.5, label sanitised and cut to 28 characters.
  - The name shows for 2 s, fades over 0.4 s (smoothstep), and reappears when the human pointer hovers it.
  - It can carry a filled "delivery" chip (background / foreground) and an outlined "target" chip (ax / pixel / browser / desktop), each 18 pt; chips fade 0.4 s after the action ends.
- **Rules worth copying:**
  - The cursor moves to the resolved target **before** the action is dispatched.
  - Keyboard actions leave the cursor where it is and only change the animation.
  - Drags follow the real gesture's duration.
  - Cua's own disclaimer: "The cursor is a visual aid for people watching an agent. It is not a security indicator, an authorization prompt, or evidence that a tool call succeeded."
- **macOS focus rectangle.** Cyan `#5EC0E8`, 2.5 px stroke at alpha ≈230, fill alpha ≈20, quadratic ease-out fade (render_state.rs).
- **Keeping the overlay out of the agent's screenshots:**
  - Issue [#4194](https://github.com/trycua/cua/issues/4194) (closed): the cursor and pill were baked into agent screenshots, and OCR read "Submit" as "Suk nit".
  - The fix is [capture_exclusion.rs](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/capture_exclusion.rs). It hides overlays only for the driver's own agent-facing captures, restores them exactly once, and reports `not_excluded` when it cannot.
  - Per platform: Windows uses window display affinity, X11 empties the overlay shape and scrubs leftover pixels ([overlay_capture.rs](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/platform-linux/src/overlay_capture.rs)), macOS uses a ScreenCaptureKit filter, and Wayland reports `not_excluded`.
  - Screen recordings still show the cursor.
  - [#3542](https://github.com/trycua/cua/issues/3542) is still open: on Retina displays the cursor renders about 280 pt above the real click.
- **Trajectory recording and render.** `start_recording {record_video:true}` writes one `turn-NNNNN` folder per action plus `recording.mp4`. `cua-driver recording render … --scale 2.5` produces a zoom-on-click MP4 ([guide](https://github.com/trycua/cua/blob/main/docs/content/docs/how-to-guides/driver/record-and-render-a-trajectory.mdx)).

#### Other Cua pieces

- **cuabot in-VM cursor** ([overlay-cursor.py](https://github.com/trycua/cua/blob/main/libs/cuabot/src/mcp/overlay-cursor.py)):
  - A transparent GTK/cairo window inside the container, so it appears in the VNC stream.
  - WindMouse-style paths (gravity 9, wind 3, max step 15, damping distance 12), 32 px cursor, 0.1 s moves.
  - Starts fading after 15 s and takes 1 s to fade out.
  - Colour comes from the session name: golden-ratio hue, saturation 0.7, lightness 0.5.
- **Web TrajectoryViewer** ([TrajectoryViewer/index.tsx](https://github.com/trycua/cua/blob/main/libs/typescript/playground/src/components/TrajectoryViewer/index.tsx)):
  - Cursor: a DOM `handpointing.svg`, 32 px, with a drop shadow. Movement uses an ease-out-cubic requestAnimationFrame loop; the sequencer waits 500 ms for a move.
  - Click: a 300 ms squash to scale 0.5 over the first 30%, then a damped-sine rebound. **The next screenshot is swapped in at the bottom of the squash**, which hides the frame change.
  - Click ring: 40 px, `border-2 border-blue-500`, keyframe `pulseCircle` 1 s ease-out, scale 0.5 → 2, opacity 0.7 → 0.
  - Drag: 500 ms linear, drawn as an SVG line with `stroke rgba(255,255,255,.8)`, width 2, `dasharray 5,3`, plus a drop shadow.
  - Has a draggable control bar and can pull frames lazily from an MP4 plus JSON.
- **Playground chat.** Tool calls collapse into a wrench icon with a count badge. Expanded, it shows the screenshot next to the call list, animated 0.2 s easeInOut ([ToolCallsGroup.tsx](https://github.com/trycua/cua/blob/main/libs/typescript/playground/src/components/primitives/ToolCallsGroup.tsx)).
- **Cloud dashboard live view** ([DesktopPane.tsx](https://github.com/trycua/cua/blob/main/libs/fleet/src/components/DesktopPane.tsx)):
  - `@novnc/novnc` RFB through an authenticated proxy at `/api/svc/<ns>/<sandbox>-vnc/websockify`.
  - `viewOnly=false`, `scaleViewport=true`, `resizeSession=false`, background `#1b1b1b`, plus a Reconnect button.
  - They patch noVNC 1.7.0 to swap red and blue because "macOS VM framebuffers arrive BGR" ([patch](https://github.com/trycua/cua/blob/main/libs/fleet/patches/@novnc__novnc@1.7.0.patch)).
- **Lume and Lumier.** Lume uses Apple's private `_VZVNCServer` with a passphrase-protected security configuration ([VNCService.swift](https://github.com/trycua/cua/blob/main/libs/lume/src/VNC/VNCService.swift)). Lumier exposes noVNC on port 8006 ([provider.py](https://github.com/trycua/cua/blob/main/libs/python/computer/computer/providers/lumier/provider.py)).
- **Gradio UI.** Chat entries titled e.g. "🛠️ Performing {action} at (x, y)" and "🖥️ Computer Output" ([ui_components.py](https://github.com/trycua/cua/blob/main/libs/python/agent/cua_agent/ui/gradio/ui_components.py)).

### 3. Magentic-UI (microsoft/magentic-ui)

The main branch is now **MagenticLite 0.2.x** (a small "MagenticBrain" orchestrator plus the "Fara" browser model), with the browser running in a Quicksand VM. Version 0.1 lives on the `magentic-ui-0.1` branch ([README](https://github.com/microsoft/magentic-ui/blob/main/README.md)).

#### MagenticLite (current)

- **Live view** ([BrowserViewer.tsx](https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/BrowserViewer.tsx)):
  - react-vnc `VncScreen` with a per-slot RFB password and `showDotCursor={false}`.
  - A 10 s connection timeout leads to "Browser not available".
  - A ResizeObserver toggles `scaleViewport` off and on to force noVNC to rescale.
  - It sets `rfb.viewOnly` directly rather than remounting.
  - It focuses the canvas when the user takes control, but only if focus is on `<body>`.
  - Two-way clipboard: `onClipboard` writes to the host clipboard; `clipboardPaste` sends host text on canvas focus or paste.
  - Each slot boots Xvfb, VNC, noVNC and Chromium; Playwright connects over CDP ([quicksand_playwright_browser.py](https://github.com/microsoft/magentic-ui/blob/main/src/magentic_ui/tools/playwright/browser/quicksand_playwright_browser.py)).
- **Embedded card** ([BrowserEmbed.tsx](https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/BrowserEmbed.tsx), [DescriptionOverlay.tsx](https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/DescriptionOverlay.tsx)):
  - 480 px wide at 16:10 (1440×900). In history mode a screenshot `<img>` covers the VNC.
  - A frosted overlay shows the current action's thoughts and result: `absolute inset-x-2 bottom-2 bg-accent/75 rounded-xl p-2 backdrop-blur-md`, click to expand.
- **Playback row** ([PlaybackControlsRow.tsx](https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/PlaybackControlsRow.tsx), [ProgressBar.tsx](https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/ProgressBar.tsx)):
  - A "LIVE" label (10 px, bold, 0.2 em tracking) above a Switch.
  - Live mode: a "Control" button with tooltip "Take control of the browser".
  - History mode: an ARIA slider (arrow keys, Home, End; 6 px track, 16 px playhead, 100 ms transitions) plus previous/next buttons.
  - The pane is titled "Browser (Live)" or "Browser (History)".
- **Takeover** ([TakeoverNotice.tsx](https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/TakeoverNotice.tsx)):
  - `ControlState = 'agent' | 'user-pending' | 'user'`.
  - Pending: an animated stripe with "Waiting for the agent to stop...".
  - User in control: "You are in control of the browser. The agent is paused and won't observe these actions." plus a destructive "Release Control" button.
- **Approvals** ([InputRequestMessage.tsx](https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/chat/messages/InputRequestMessage.tsx)):
  - Card title "Approval Required", then "The following bash command needs your approval before it can be executed:" (or "action"), a monospace command box, "Reason: …", and "You may approve, deny, or send a message with an alternative suggestion."
  - Deny, plus a split Approve button whose menu offers "Always approve **{tool}** in this session" and "Always approve all tools in this session".
  - An approved card disappears.
  - Policies: `auto_approve`, `require_approval_untrusted` (default), `require_approval_all` ([configuration.md](https://github.com/microsoft/magentic-ui/blob/main/docs/configuration.md)).
  - A "Keep going?" Continue / Stop card appears when the round limit is hit.
- **Status and final answer:**
  - Status labels: "Ready to start", "In progress" (spinner), "Waiting for your input", "The task was paused", "The task was stopped", "The task is completed", "Something went wrong" ([lib/constants.ts](https://github.com/microsoft/magentic-ui/blob/main/frontend/src/lib/constants.ts)).
  - The final answer appears under a "Final Answer" header.

#### Version 0.1

- **Live view** ([browser_iframe.tsx](https://github.com/microsoft/magentic-ui/blob/magentic-ui-0.1/frontend/src/components/views/chat/DetailViewer/browser_iframe.tsx), [SecurityBanner.tsx](https://github.com/microsoft/magentic-ui/blob/magentic-ui-0.1/frontend/src/components/views/chat/DetailViewer/SecurityBanner.tsx)):
  - A noVNC iframe: `vnc.html?autoconnect=true&resize=scale&show_dot=true&scaling=local&quality=9&compression=0&view_only=0`.
  - Hovering an active run shows a `bg-black bg-opacity-50` "Take Control" overlay, which pauses the run and hands over control.
  - A yellow banner warns: "Security Note: Magentic-UI cannot see what you do when you take control. Be cautious about entering passwords or sensitive information."
- **Co-planning** ([plan.tsx](https://github.com/microsoft/magentic-ui/blob/magentic-ui-0.1/frontend/src/components/views/chat/plan.tsx), [approval_buttons.tsx](https://github.com/microsoft/magentic-ui/blob/magentic-ui-0.1/frontend/src/components/views/chat/approval_buttons.tsx)):
  - Plan steps can be reordered by drag (`@hello-pangea/dnd`); each step has a textarea and a trash icon; "sentinel" steps read "… EVERY {duration}".
  - Buttons: "Accept Plan" / "Generate New Plan"; approvals are "Approve" / "Reject".
- **Action guard** ([approval_guard.py](https://github.com/microsoft/magentic-ui/blob/magentic-ui-0.1/src/magentic_ui/approval_guard.py)):
  - Policies: always / never / auto-conservative / auto-permissive.
  - An LLM judge answers YES/NO, prompted with e.g. "If the websurfer is about to click a button that submits a form, or sends an email, or make a purchase, it should require human approval … When unsure, err on the side of caution."
- **In-page cursor, both versions** ([animation_utils.py](https://github.com/microsoft/magentic-ui/blob/main/src/magentic_ui/tools/playwright/utils/animation_utils.py)):
  - A `#red-cursor` div: 12 px, `radial-gradient(circle at center,#fff 20%,#f00 100%)`, `box-shadow 0 0 6px 2px rgba(255,0,0,.5)`, `transition:left .05s linear, top .05s linear`.
  - It moves in 10 linear steps of 20 ms.
  - The target element gets `border:2px solid red`.
  - Because this changes the page's own styles, it can end up in the agent's screenshots.

### 4. E2B: Surf, the Desktop SDK and the rollout demo

- **Surf** (Next.js):
  - Creates a sandbox (1024×720 default, 96 dpi), calls `stream.start()` then `getUrl()`, and shows it in an `<iframe allow="clipboard-read; clipboard-write">` ([route.ts](https://github.com/e2b-dev/surf/blob/main/app/api/chat/route.ts), [page.tsx](https://github.com/e2b-dev/surf/blob/main/app/page.tsx)).
  - Model "gpt-5.4"; typing is sent in 50-character chunks with a 25 ms delay; sandboxes time out after 5 minutes, with extend and stop actions ([config.ts](https://github.com/e2b-dev/surf/blob/main/lib/config.ts), [openai.ts](https://github.com/e2b-dev/surf/blob/main/lib/streaming/openai.ts)).
  - Server-sent event types: update, action, reasoning, done, error, sandbox_created{vncUrl}, action_completed ([types/api.ts](https://github.com/e2b-dev/surf/blob/main/types/api.ts)).
  - The chat shows "ACTION" cards containing raw JSON plus a pending/completed/failed status; repeated waits collapse to "wait x3" ([message.tsx](https://github.com/e2b-dev/surf/blob/main/components/chat/message.tsx)). There is no on-screen overlay.
- **Desktop SDK stream** (now in the e2b-dev/E2B monorepo, [sandbox.ts](https://github.com/e2b-dev/E2B/blob/main/packages/desktop-js/src/sandbox.ts)):
  - `x11vnc -bg … -forever -wait 50 -shared -rfbport 5900 [-usepw] [-id <windowId>]`; the `-id` flag streams a single window.
  - noVNC runs as `novnc_proxy --listen 6080`.
  - `getUrl({autoConnect, viewOnly, resize:'scale'|'remote'|'off', authKey})` builds the query string.
  - The template uses E2B's own noVNC fork, branch `e2b-desktop` ([template.py](https://github.com/e2b-dev/desktop/blob/main/template/template.py)).
- **cua-rollout-demo-public** (Aug 2026; **no license file**):
  - Human takeover goes through noVNC with a one-time password.
  - `vnc-up.sh` records ffmpeg x11grab at 1440×900, 12 fps, as fragmented MP4.
  - It captures **only human input** with `x11vnc -pipeinput "reopen,tee:input_logger.py --output events.ndjson"`. Agent input goes through xdotool directly, so it never reaches the log ([vnc-up.sh](https://github.com/e2b-dev/cua-rollout-demo-public/blob/main/template/vnc-up.sh), [README](https://github.com/e2b-dev/cua-rollout-demo-public/blob/main/README.md)).
- **open-computer-use** streams differently: ffmpeg x11grab → H.264 MPEG-TS over HTTP → ffplay ([streaming.py](https://github.com/e2b-dev/open-computer-use/blob/main/os_computer_use/streaming.py)).

### 5. OpenAI CUA sample app and the Anthropic computer-use demo

- **openai-cua-sample-app** has been rewritten. It is now one Next.js console plus two agents: JavaScript/Playwright and Python/PyAutoGUI, both built around code-execution tools ([README](https://github.com/openai/openai-cua-sample-app/blob/main/README.md)).
  - `ScreenshotPane` ([ScreenshotPane.tsx](https://github.com/openai/openai-cua-sample-app/blob/main/console/components/ScreenshotPane.tsx)):
    - An eyebrow label reads "Live frame", "Pinned frame" or "Awaiting frame".
    - Chips show the source, "Frame n / N", the time and the image size.
    - A "Review timeline" range scrubber, a "Show thumbnails" filmstrip that scrolls only itself, "Jump to latest", and "Replay JSON".
  - Run event types: run_started, workspace_prepared, lab_started, browser_session_started, browser_navigated, function_call_requested, function_call_completed, screenshot_captured, run_progress, run_completed, run_failed, run_cancelled. Each event has a level (ok / pending / warn / error) and a `sequence` number ([contracts/index.ts](https://github.com/openai/openai-cua-sample-app/blob/main/contracts/index.ts)).
  - There is no live stream, no cursor and no approval UI; the only control is Stop.
- **Anthropic computer-use demo** (now in `anthropics/claude-quickstarts`):
  - The page puts a Streamlit iframe (flex 1) next to a noVNC iframe (flex 2): `vnc.html?&resize=scale&autoconnect=1&view_only=1&reconnect=1&reconnect_delay=2000` ([index.html](https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/image/static_content/index.html)).
  - A "Toggle Screen Control (Off/On)" button flips `view_only`, which reloads the whole iframe.
  - Streamlit has "Chat" and "HTTP Exchange Logs" tabs. Tool calls render as `st.code("Tool Use: {name}\nInput: …")` and screenshots via `st.image`. Only the 3 most recent images are sent by default ([streamlit.py](https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/computer_use_demo/streamlit.py)).
  - Input uses xdotool `mousemove --sync` (instant) and types with `--delay 12` in 50-character chunks ([computer.py](https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/computer_use_demo/tools/computer.py)).

### 6. Kortix (Suna)

- **License.** Main is now under the **Elastic License 2.0**, which bars offering it as a hosted or managed service ([LICENSE](https://github.com/kortix-ai/suna/blob/main/LICENSE)). The December 2025 snapshot at commit `adadb9b1a2` was Apache-2.0.
- **The 2025 "Suna's Computer" side panel** ([tool-call-side-panel.tsx@adadb9b1a2](https://github.com/kortix-ai/suna/blob/adadb9b1a2/frontend/src/components/thread/tool-call-side-panel.tsx)):
  - Titled `${agentName}'s Computer`. Navigation mode is `'live' | 'manual'`.
  - Footer: previous/next icons, "n/N", a slider with a 6 px track, and a 116 px status pill:
    - Running and live: green pulsing dot, "Live Updates".
    - Idle and live: grey, "Latest Tool".
    - Running and manual: green, "Jump to Live".
    - Idle and manual: blue, "Jump to Latest".
  - Dragging the slider to the end re-enters live mode.
  - In manual mode it jumps back to live when the agent is running and either the user was on the latest step or the new call is a file operation.
  - A persistent VNC iframe loads `{vnc_preview}/vnc_lite.html?password=…&autoconnect=true&scale=local`, preloaded with a health check (up to 5 attempts), with a Browser/Tools view toggle ([HealthCheckedVncIframe.tsx](https://github.com/kortix-ai/suna/blob/adadb9b1a2/frontend/src/components/thread/HealthCheckedVncIframe.tsx)).
  - Tool calls map to views through [ToolViewRegistry.tsx](https://github.com/kortix-ai/suna/blob/adadb9b1a2/frontend/src/components/thread/tool-views/wrapper/ToolViewRegistry.tsx): `browser-*` → browser screenshot view; `execute-command` → terminal view; create/edit/read/delete file → file view; `str-replace` → diff; search/crawl/scrape; task lists; slides; sheets; anything else → GenericToolView.
- **The 2026 replacement, `ActionNavigator`** ([action-navigator.tsx](https://github.com/kortix-ai/suna/blob/main/apps/web/src/features/session/action-panel/shared/action-navigator.tsx), [logic](https://github.com/kortix-ai/suna/blob/main/apps/web/src/features/session/action-panel/shared/action-navigator-logic.ts)):
  - Previous/next, a slider with a time tooltip, an inline wall-clock label (rendered after mount to avoid SSR mismatches), "n/N", a live dot, and ←/→ keys that are ignored in text fields.
  - The follow rule: **stepping back pins manual mode; stepping onto the last action turns live-follow back on.**

### 7. Hugging Face Open Computer Agent, ScreenEnv and ScreenSuite

- **The Space `smolagents/computer-agent`** (Gradio, 984 likes, last modified 2025-11-17; no license declared in its metadata [UNVERIFIED]):
  - Uses E2B `stream.start(require_auth=True)` and adds `&view_only=true` unless "interactive" mode is on ([app.py](https://huggingface.co/spaces/smolagents/computer-agent/blob/main/app.py)).
  - Status dot: green blinking every 2 s for "Interactive"; red `#e74c3c` for "Agent running...".
  - The iframe sits inside a 910×800 PNG "HUD" monitor frame and is replaced by a blue-screen GIF on timeout or error ([scripts_and_styling.py](https://huggingface.co/spaces/smolagents/computer-agent/blob/main/scripts_and_styling.py)).
- **Click marker for the model.** After each click, PIL draws a green cross (±10 px, 3 px wide) and a circle (radius 20) onto the saved screenshot. The system prompt refers to it: "The green cross is off from the element" ([e2bqwen.py](https://huggingface.co/spaces/smolagents/computer-agent/blob/main/e2bqwen.py)). The same marker would work for people in replay.
- The Space also includes `model_replay.py` and `templates/viewer.html` [not inspected].
- **ScreenEnv** (MIT): a Docker Ubuntu/XFCE sandbox with Playwright, screen recording and an MCP server with 30+ tools. I found no noVNC in the repo tree ([README](https://github.com/huggingface/screenenv/blob/main/README.md)).
- **ScreenSuite** is a benchmark with no UI, so not relevant here.

### 8. Browser Use

- **Numbered boxes drawn on screenshots for the model** ([python_highlights.py](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/python_highlights.py)):
  - Colour by element type: button `#FF6B6B`, input `#4ECDC4`, select `#45B7D1`, link `#96CEB4`, textarea `#FF8C42`, anything else `#DDA0DD`.
  - Dashed boxes. The index badge is filled with the type colour, has a 2 px white outline and white bold text sized `max(10, min(20, cssWidth·1%))`.
  - The badge sits top-centre inside the element, or 5 px above it when the element is narrower than 60 px or shorter than 30 px, and is kept inside the image.
- **Live-page interaction highlight**, injected through CDP `Runtime.evaluate` ([session.py](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/session.py) `highlight_interaction_element` / `highlight_coordinate_click`; [profile.py](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/profile.py)):
  - Four corner brackets sized clamp(8, 35% of the shorter side, 20) px with a 3 px border. They start 10 px outside and move to −3 px (just outside the element) with `transition: all 0.15s ease-out`.
  - Visible for `interaction_highlight_duration` (1.0 s), then faded out over 0.3 s. Colour defaults to `rgb(255, 127, 39)`.
  - Coordinate clicks get a 30 px ring (3 px border) that grows from scale 0.3 over 0.2 s ease-out, plus a centre dot.
  - Both use z-index 2147483647.
- **Demo mode** ([demo_mode.py](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/demo_mode.py)):
  - An in-page log panel on the right: 340 px, `#05070d`, JetBrains Mono, z-index 2147480000, slides in over 0.25 s.
  - Level colours: info `#60a5fa`, action `#34d399`, thought `#f97316`, warning `#fbbf24`, success `#22c55e`, error `#f87171`.
  - Keeps 100 messages across navigations via sessionStorage, and is excluded from DOM extraction by a `data-browser-use-exclude-{session}` attribute.
- **Recording and cloud.** Recording uses CDP screencast (PNG, quality 90) to MP4 ([recording_watchdog.py](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/watchdogs/recording_watchdog.py)). Cloud sessions return a `liveUrl` ([cloud/views.py](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/cloud/views.py)); I found no open-source viewer for it.
- **Legacy `buildDomTree.js`** (tag 0.5.11, still vendored by nanobrowser; [index.js](https://github.com/browser-use/browser-use/blob/0.5.11/browser_use/dom/dom_tree/index.js)):
  - 12 colours cycled by index: `#FF0000 #00FF00 #0000FF #FFA500 #800080 #008080 #FF69B4 #4B0082 #FF4500 #2E8B57 #DC143C #4682B4`.
  - One overlay per client rect: `position:fixed; border:2px solid C; background:C+"1A"` (10% alpha).
  - Label: `background:C; color:#fff; padding:1px 4px; border-radius:4px; font-size:clamp(8, h/2, 12)px`, top-right inside the element, or above it when the element is too small.
  - All inside `#playwright-highlight-container` at z-index 2147483647, repositioned on scroll and resize.
- **web-ui** (Gradio): in headless mode it polls `take_screenshot()` every 0.1 s into an `<img>`. It also shows per-step screenshots, Pause/Resume, "ask for assistant" and GIF export ([browser_use_agent_tab.py](https://github.com/browser-use/web-ui/blob/main/src/webui/components/browser_use_agent_tab.py)).
- **workflow-use** (**AGPL-3.0**): records with rrweb (`checkoutEveryNms:10000`, input masking) and highlights with `2px solid lightgreen` over `rgba(144,238,144,.05)` ([content.ts](https://github.com/browser-use/workflow-use/blob/main/extension/src/entrypoints/content.ts)).

### 9. Short notes on the remaining tools

- **Skyvern** (AGPL-3.0; [BrowserStream.tsx](https://github.com/Skyvern-AI/skyvern/blob/main/skyvern-frontend/src/components/BrowserStream.tsx), [StreamControlBar.tsx](https://github.com/Skyvern-AI/skyvern/blob/main/skyvern-frontend/src/routes/streaming/StreamControlBar.tsx), [browser-stream.css](https://github.com/Skyvern-AI/skyvern/blob/main/skyvern-frontend/src/components/browser-stream.css), [InteractiveStreamView.tsx](https://github.com/Skyvern-AI/skyvern/blob/main/skyvern-frontend/src/routes/streaming/InteractiveStreamView.tsx), [domUtils.js](https://github.com/Skyvern-AI/skyvern/blob/main/skyvern/webeye/scraper/domUtils.js)):
  - noVNC RFB over `wss…/stream/vnc/{task|workflow_run}/{id}`.
  - A separate message socket sends `{kind:"take-control"}` and `{kind:"cede-control"}`. It waits for VNC, and every reconnect starts in agent control.
  - UI labels: "Take control", then "You're in control" with "Stop controlling". The take-control button sits at 30% opacity, goes to 100% on hover, and slides with a 0.2 s transition. The overlay shows a `not-allowed` cursor until you can take control.
  - An alternative CDP mode shows screencast frames as `<img>` and sends mouse and keys over CDP.
  - Per-action screenshot artifacts and task recordings.
  - The scraper draws hint boxes as `2px solid blue`.
- **Browserbase Open Operator** (archived, **no license**): an iframe of the Browserbase debugger (`devtools-fullscreen` rewritten to `devtools-internal-compiled`). Steps list tool GOTO / ACT / EXTRACT / OBSERVE / CLOSE / WAIT / NAVBACK plus the reasoning ([ChatFeed.tsx](https://github.com/browserbase/open-operator/blob/main/app/components/ChatFeed.tsx)).
- **nanobrowser** (Apache-2.0): vendors the browser-use `buildDomTree.js`. Actor avatar colours: User `#4CAF50`, System `#2196F3`, Planner `#FF9800`, Navigator `#40A9FF`, Validator `#EC407A`, Manager `#9C27B0` ([message.ts](https://github.com/nanobrowser/nanobrowser/blob/master/pages/side-panel/src/types/message.ts)).
- **Stagehand** (MIT):
  - `locator.highlight()` calls CDP `Overlay.highlightNode` with border `rgba(255,0,0,.9)` and fill `rgba(255,200,0,.2)`, for 800 ms by default (the CLI default is 2000 ms) ([locator.ts](https://github.com/browserbase/stagehand/blob/main/packages/extension/understudy/locator.ts)).
  - The CLI injects a 16×24 black SVG arrow with a 0.7 white stroke that follows synthetic `mousemove` events, with no easing ([cursor-overlay.ts](https://github.com/browserbase/stagehand/blob/main/packages/cli/src/lib/driver/cursor-overlay.ts)).
- **OpenManus** (MIT): no first-party web UI. It drives the browser through `uvx browser-use --cli-mcp` ([README](https://github.com/FoundationAgents/OpenManus/blob/main/README.md)).
- **Agent-S** (Apache-2.0): CLI only (`gui_agents/*/cli_app.py`); no UI found.
- **OpenHands** (MIT): the browser panel is a URL bar plus the last screenshot as an `<img>`. There is no VNC in the current tree ([browser.tsx](https://github.com/OpenHands/OpenHands/blob/main/src/components/features/browser/browser.tsx)).
- **Steel:**
  - steel-browser (Apache-2.0) streams with CDP `Page.startScreencast {format:"jpeg", quality:75}` and forwards `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` ([casting.handler.ts](https://github.com/steel-dev/steel-browser/blob/main/api/src/plugins/browser-socket/casting.handler.ts)).
  - surf.new (archived) embeds `debugUrl?showControls=false&interactive=true&initialInteractive=true` ([Browser.tsx](https://github.com/steel-dev/surf.new/blob/main/components/ui/Browser.tsx)).
- **Browserless** (SSPL-1.0 or commercial; [docs](https://docs.browserless.io/baas/interactive-browser-sessions/hybrid-automation)):
  - The CDP command `Browserless.liveURL` takes `timeout`, `interactable`, `resizable`, `quality` (1–100) and `showBrowserInterface`.
  - Frames and input travel over a same-origin WSS connection at `/live/<id>`.
  - `Browserless.liveComplete` signals the hand-back and `Browserless.closeLiveURL` ends the session.

### 10. Animated virtual cursors

I skipped the six repos the sibling researcher already covered.

- **Cua driver**: native, described in §2.
- **UI-TARS-desktop / Tarko** (Apache-2.0, 39.2k):
  - [MouseCursor.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/MouseCursor.tsx) uses framer-motion to animate `left`/`top` as percentages over the screenshot, from the previous position, with `duration .5, ease [0.16,1,0.3,1]`.
  - The cursor is a 36 px white-gradient arrow with a black 1.5 stroke and a drop shadow.
  - On clicks it adds two looping indigo ripples (`rgba(99,102,241,…)`, 1.5 s and 1.2 s, scale 0 → 2.5 and 0 → 2) and a glowing 4 px white core.
  - The desktop app's [ScreenMarker.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/window/ScreenMarker.ts) adds a click-through, always-on-top window with a pulsing blue edge glow while the agent is working ("waterflow": `rgba(30,144,255,.4)`, 5 s `cubic-bezier(.4,0,.6,1)` loop), plus SVG prediction markers.
  - Replay offers play, pause, restart, "Jump to final state" and speeds of 0.5×, 1×, 2×, 4×. The base interval is 800 ms divided by speed, with a 200 ms minimum ([ReplayControlPanel.tsx](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/standalone/replay/ReplayControlPanel.tsx), [useReplay.ts](https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/common/hooks/useReplay.ts)).
- **Midscene** (MIT) replay player ([StepScene.tsx](https://github.com/web-infra-dev/midscene/blob/main/packages/visualizer/src/component/player/scenes/StepScene.tsx), [pointer-layout.ts](https://github.com/web-infra-dev/midscene/blob/main/packages/visualizer/src/component/player/scenes/pointer-layout.ts), [blackboard/index.less](https://github.com/web-infra-dev/midscene/blob/main/packages/visualizer/src/component/blackboard/index.less)):
  - Runs at 30 fps. The pointer (44×56, hotspot 6,4) moves during the first 0.375 of each step (`POINTER_PHASE`); then the camera pans and zooms to it ("focus on cursor"). `CROSSFADE_FRAMES = 10`.
  - The search area is teal `#028391` with 15% fill. The target is orange `#fd5907` with 15% fill and a 1.2 s opacity pulse. Click points are 20 px orange dots with a glow.
  - It can export a branded video.
- **Magnitude** (Apache-2.0, last push 2026-02; [cursor.ts](https://github.com/magnitudedev/browser-agent/blob/main/packages/magnitude-core/src/web/visualizer/cursor.ts), [mouseEffects.ts](https://github.com/magnitudedev/browser-agent/blob/main/packages/magnitude-core/src/web/visualizer/mouseEffects.ts), [typeEffects.ts](https://github.com/magnitudedev/browser-agent/blob/main/packages/magnitude-core/src/web/visualizer/typeEffects.ts)):
  - A 32 px pointer (`#026aa1` / `#0384c7`) with `transition:left/top .3s cubic-bezier(.25,.1,.25,1)`. The code waits 300 ms by hand after each move, because evaluating the script does not wait for the CSS transition.
  - Click circle: 0 → 50 px over 500 ms ease-out; ripple 0.6 s in `#0096ff`.
  - **Typing HUD**: keycap badges fixed 40 px from the bottom, centred, at most 5, shown for 2 s, background `rgba(0,100,200,.54)`, radius 6 px. Keys pop in over 0.2 s (from scale 0.5 and 20 px lower) and out over 0.3 s.
- **matinee** (MIT, 24★; [motion.ts](https://github.com/benhowdle89/matinee/blob/main/src/motion.ts), [styles.css](https://github.com/benhowdle89/matinee/blob/main/src/styles.css)):
  - Easing is minimum-jerk, `10t³−15t⁴+6t⁵`. Paths are randomised curves that overshoot and then correct (`SETTLE_FRACTION .26`), with a slight tremor and idle drift.
  - Travel time is `clamp(160+√d·24·pace, 220, 1500)` ms. The random generator is seeded, so a replay reproduces the live motion exactly.
  - Click ripple: 620 ms `cubic-bezier(.2,.7,.3,1)`, 8 → 46 px. Also a nameplate, SVG/WebM export, and reduced-motion support.
- **ghost-cursor** (MIT; [spoof.ts](https://github.com/Xetera/ghost-cursor/blob/master/src/spoof.ts), [mouse-helper.ts](https://github.com/Xetera/ghost-cursor/blob/master/src/mouse-helper.ts)): Bezier paths with overshoot, timed by Fitts's law (`a=0, b=2, log2(D/W+1)`). Its mouse helper is a 20 px `rgba(0,0,0,.4)` circle that darkens while a button is pressed.
- **Also seen:**
  - dsh-computer-use (MIT) reuses cua-driver's cursor.
  - LUXORANOVA9/prototype has a framer-motion cursor over noVNC but no license and 0★; ignore it.

---

### Cross-project takeaways

1. **Streaming.**
   - For full desktops, noVNC/RFB over websockify is the default (Bytebot, Cua, Magentic, E2B, Anthropic, Suna 2025, Skyvern).
   - Browser-only tools use CDP screencast (Steel, Skyvern, Browserless, the browser-use recorder).
   - Review views rely on per-step screenshots. None of the projects I read streams the desktop over WebRTC.
   - Embedding `vnc.html` in an iframe is the simplest option but blocks overlays, and toggling `view_only` reloads the session.
   - Driving RFB directly on a canvas (react-vnc or noVNC) is needed for overlays and coordinate mapping.
2. **Where the pointer overlay lives.** The real pointer teleports (xdotool `--sync`, nut-js, PyAutoGUI), so any visible motion has to be synthesised from action events. There are three places to draw it:
   - **(a) Inside the VM** (Cua driver, cuabot, UI-TARS): visible in every viewer and recording, but it pollutes the agent's own screenshots (Cua #4194).
   - **(b) Injected into the page** (Browser Use, Magentic, Magnitude, Stagehand): browser-only, changes the DOM, and can leak into screenshots.
   - **(c) Drawn client-side over the stream or screenshot** (Cua TrajectoryViewer, Tarko, Midscene, Magentic's description overlay): nothing touches the agent's input.
   - For localDot: use (c) for live view and replay, with coordinates stored in framebuffer pixels and mapped through the `scaleViewport` letterboxing and HiDPI scaling (see Cua #3542). Use (a) only when baking an export.
3. **Show intent before effect.**
   - Cua glides to the target and waits for arrival before dispatching.
   - Magnitude waits 300 ms for its transition.
   - Cua's viewer swaps frames at the bottom of the click squash.
   - Suggested pipeline for localDot: `intent` event (target point, bbox, kind) → 220–900 ms glide (Cua speed profile or minimum-jerk) → dispatch → `result` event → ripple and settle.
   - Keyboard actions keep the cursor still and show a typing overlay.
4. **Semantic states.** Cua's 12-state vocabulary, plus its delivery and target chips, can drive both the cursor and the avatar companion.
5. **Highlight conventions.**
   - "Acting on" uses orange/red: `rgb(255,127,39)`, `#fd5907`, red border with amber fill.
   - "Looking at" uses teal/blue/cyan: `#028391`, Skyvern blue, `#5EC0E8`.
   - Typical geometry: 2–3 px stroke, 10–20% fill, 0.15–0.3 s in, about 1 s hold, 0.3 s fade.
   - Keep labels inside the viewport and move them above small targets.
6. **Timeline.**
   - Every project separates live-follow from a pinned position.
   - Best follow rule is Kortix's: stepping back pins, reaching the end resumes live.
   - Controls that work well: an explicit "Jump to Live / Latest" pill or LIVE switch, an ARIA slider with keyboard support, inline timestamps, a filmstrip, chat-scroll sync (Bytebot), 0.5–4× speed, and a camera that follows the pointer (Midscene).
7. **Takeover.**
   - Three-state handshake (agent → user-pending → user), with focus handover and clipboard bridging (Magentic).
   - Either record human input (Bytebot's global hooks, or E2B's `x11vnc -pipeinput tee` NDJSON plus MP4) or state plainly that the agent "won't observe these actions" (Magentic).
   - Always show a banner, and warn about typing secrets.
8. **Approvals.**
   - Use an inline card: exact command, reason, Deny, and Approve with a session-scoped "always" option.
   - Optionally add an LLM judge for irreversible actions (Magentic 0.1).
   - Opportunity: none of these projects highlights the pending target on the live stream while asking for approval.
9. **Pitfalls to plan for.**
   - macOS VM framebuffers arrive BGR (Cua's noVNC patch).
   - noVNC does not notice container resizes; toggle `scaleViewport` to force a rescale.
   - Remounting VncScreen to change `viewOnly` (Bytebot) causes a reconnect; setting `rfb.viewOnly` directly is better (Magentic).
   - Retina coordinate offsets (Cua #3542).
   - Mask sensitive typed text (Bytebot).

### What localDot can reuse directly

| What | Source and license | Caveats |
|---|---|---|
| RFB client | `@novnc/novnc` (MPL-2.0 core) and `react-vnc` (MIT, 165★, last push 2025-12) | Only changes to MPL files have to be shared. Add Cua's BGR swap for macOS VMs. |
| websockify and x11vnc | LGPL-3.0 and GPL-2.0 | Run them as separate processes inside the VM image; nothing is linked. |
| Viewer shell | Magentic BrowserViewer, ProgressBar, PlaybackControlsRow, TakeoverNotice, ApprovalCard (MIT) | Tailwind/shadcn tokens; keep the MIT notice. |
| Cursor physics and look | Cua `motion.rs`, `path_planner.rs`, `render_state.rs` constants, palette, pill layout, the 12-state set, and the `cua.default.lottie` artwork (MIT) | Port to TypeScript; play the Lottie with lottie-web or dotlottie-web. Inter is OFL. Treat user-supplied themes as untrusted, as Cua does. |
| Glide engine | matinee `motion.ts` (MIT) | Pure, dependency-free functions; seeded, so replays match live. |
| Click, drag and cursor animations | Cua TrajectoryViewer (MIT), Tarko MouseCursor (Apache-2.0), Midscene player and highlight CSS (MIT) | Apache-2.0 requires keeping the NOTICE. |
| Typing overlay | Magnitude typeEffects (Apache-2.0) | Written as in-page code; move it to the web overlay. |
| Highlight styles | Browser Use corner brackets, click ring, label placement, palettes (MIT) | – |
| Takeover recording and scroll-synced replay | Bytebot input tracking and useScrollScreenshot (Apache-2.0) | Repo is archived: copy the code, don't depend on it. |
| Live/manual follow rule | Kortix | Main is Elastic-2.0, so reimplement the rule from its description; the Apache-2.0 2025 side panel can be copied with attribution. |
| Human-input logging pattern | E2B rollout demo (`x11vnc -pipeinput tee`) | No license file: reuse the idea, not the code. |
| **Do not copy code from** | Skyvern and workflow-use (AGPL-3.0), Browserless (SSPL), Kortix main (ELv2), Open Operator (no license), the HF Space (no license declared), the E2B rollout demo (no license file) | – |

## 2.6 Newer standouts and the Sept 2026 "agent cursor" wave

Researched directly (not by a sub-researcher). Where only one hands-on source exists, it is labelled.

### Google Antigravity (agent-first IDE, Nov 2025 onward)
- The browser subagent drives a local Chrome through an extension plus CDP. Its tools include `browser_click_element`, `browser_scroll`, `capture_browser_screenshot` and `execute_browser_javascript` (reverse-engineering write-up: https://alokbishoyi.com/blogposts/reverse-engineering-browser-automation.html).
- **Live cue:** while the agent drives, the Chrome window gets a blue "Agent Control" border and the AI's cursor shows as a red dot that moves and clicks (hands-on review: https://dev.to/fabianfrankwerner/an-honest-review-of-google-antigravity-4g6f). This is the only first-hand source. A secondary summary called it a "blue cursor", so the cursor colour is [UNVERIFIED].
- **Recordings as artifacts.** From the docs: "Every time the browser subagent actuates on the Browser, it may choose to generate a recording." Playback sits "at the bottom of the Browser step UI", and every recording is also saved as a recording artifact that "loops through the browser agent's actions" (https://antigravity.google/docs/ide/browser-recordings/). Per the reverse-engineering post, recordings are saved as WebP videos in the artifacts directory. The "Walkthrough" artifact bundles video with screenshots (dev.to review).
- **Jank:** a "Controls Disabled" warning appeared about half the time even while the agent was working, and the agent sometimes connected to the wrong localhost port. The reviewer said it "feels like a prototype" (dev.to).
- **Takeaway:** short looping per-step recordings, attached to the step card, make async review cheap. localDot should attach a clip to every step card.

### Replit Agent 3 "App Testing" (Sept 2025 onward)
- The Agent pane has a live browser preview: "Watch Agent's cursor as it clicks around your app."
- After a test run: "click the video to replay the entire testing session", and "Use the sliders at the bottom to jump to specific sections of the test."
- **Handoff:** when blocked, the agent pops a **"Begin take over"** button. The user clicks into the preview, does the steps and lets the agent continue. There is also a **Skip** option, and "If you do not respond within 10 minutes, the Agent will continue as if you pressed 'Skip.'"
- When testing runs in a background task, the live browser shows inside that task. The top-level conversation has no separate pane. Sources: https://docs.replit.com/features/agent/app-testing and https://blog.replit.com/introducing-agent-3-our-most-autonomous-agent-yet
- **Takeaway:** the handoff has explicit timeout semantics, and each replay is split into sections.

### Devin (Cognition)
- The Progress tab puts shell commands, code edits and browser activity in one unified view. Clicking any step shows its details (https://docs.devin.ai/work-with-devin/devin-session-tools).
- **Time-travel consistency:** "Commands that are greyed out are commands run at a future point in time in the session". Clicking a command jumps the session view to that time.
- Scrubbing the timeline plus a "restore checkpoint" control rolls back files and memory. This comes from secondary guides (https://fast.io/resources/devin-session-tools-guide/), so the exact wording is [UNVERIFIED].
- **Takeover:** terminals toggle from read-only to writable. The interactive browser handles CAPTCHAs and MFA ("especially helpful for browser tasks where Devin may require assistance").
- **Takeaway:** one global time cursor. When you scrub back, every panel (terminal, file diff, log, screen) renders "as of" that time and greys out the future.

### Cursor cloud agents with computer use (2026)
- Self-hosted workers run on macOS or Linux. macOS uses a helper app, "Cursor Computer Use", which needs Accessibility and Screen Recording. Linux uses an X11 display, either an existing one or a managed TigerVNC + Xfce desktop. Desktop sharing is Linux-only: authorized viewers can "watch or take control" (the docs screenshot shows a **Take control** button). The machine runs a fail-closed input filter, the clipboard is blocked, and pixels leave only through the worker's outbound connection (https://cursor.com/docs/cloud-agent/self-hosted/computer-use).
- The IDE browser tool lets the user pick an element or draw a box and send it to the agent as image context (https://cursor.com/docs/agent/tools/browser).

### Amazon Nova Act (playground; GA Dec 2025)
- In the playground you "watch the agent taking actions in the hosted web browser", then download the Python script (https://docs.aws.amazon.com/nova-act/latest/userguide/step-1-playground.html). A GA write-up describes a live view of the agent on the right and the instructions in an "Agent Output Window" (https://dev.classmethod.jp/en/articles/amazon-nova-act-ga-browser-automation/).
- The console organises observability as runs → sessions → acts → steps. The VS Code extension works as a step-by-step visual debugger, and traces are saved as HTML files you can replay (search summary of https://aws.amazon.com/nova/act/ and the user guide; details [UNVERIFIED]).

### Gemini Intelligence on Android (Apr–May 2026)
- Screen automation runs in a background sandbox, "without taking over your device". A "live view" lets you "jump in, fix the issue, and let the AI resume" (Android Police, 9 Apr 2026: https://www.androidpolice.com/pixel-gemini-controls-apps/).
- "a progress bar allows users to stop Gemini at any time", and purchases require confirmation (Engadget, 12 May 2026: https://www.engadget.com/2170770/gemini-intelligence-brings-app-automation-to-android/). No public detail on touch indicators.

### Claude in Chrome: GIF replay export
- Primary source: the extension's `gif_creator` tool schema, as exposed to this research session. It exports a recording "with visual overlays (click indicators, action labels, progress bar, watermark)":
  - orange circles at click locations
  - red arrows for drag paths
  - black labels describing actions
  - an orange progress bar at the bottom
  - a Claude logo watermark

  Quality ranges 1–30 (default 10). Recording is scoped to the tab group. The tool says to screenshot right after start and right before stop so the first and last frames show the real states.
- **Takeaway:** the minimum viable shareable replay is keyframes plus four overlay types (click dot, drag arrow, action label, progress bar). It is cheap to build and very legible, which makes it a good first export format for localDot.

### The Aug–Sep 2026 OSS "agent cursor" wave (native overlays on real desktops)
In Aug–Sep 2026 several OSS computer-use drivers shipped a visible agent cursor that is separate from the user's pointer. They converged on the same rules independently, which is strong evidence for the spec in section 4.

1. **lahfir/agent-desktop** (Rust, Apache-2.0, about 1.7k stars, pushed 2026-09-29). This is the most rigorously specified implementation:
   - **Motion** (`crates/core/src/cursor_overlay/hand_path.rs`):
     - Distance-aware duration `clamp(40 + 70*log2(d/40 + 1), 90, 320)` ms, a Fitts/Shannon form.
     - A minimum-jerk primary submovement (`t^3(10 - 15t + 6t^2)`) over the first 74% of the time, overshooting to 103.5%, then a corrective submovement from 62%.
     - A lateral bow of `min(0.055*d, 38px) * sin(pi * t^0.8)`, plus a 1.1 px smoothed-noise "tremor" (7 cycles) enveloped by `sin(pi*t)`, so it is zero at both endpoints.
     - Deterministic: the seed is derived from the endpoints.
     - The plan doc records the choice: "Use an eased minimum-jerk glide with a visible human swing, not spring motion" (KD3). https://github.com/lahfir/agent-desktop/blob/HEAD/crates/core/src/cursor_overlay/hand_path.rs
   - **Truthful phases** (`phase.rs`, `timing.rs`):
     - `Travel` is sent *before* the action and acknowledged when the cursor lands. The action dispatches anyway after `CURSOR_ARRIVAL_TIMEOUT_MS = 900`.
     - `Effect` is sent *after* dispatch and is fire-and-forget. `Drag` arms tracking.
     - Idle rest comes after `CURSOR_IDLE_REST_MS = 6000`. The clicked element's outline is held for `CURSOR_HIGHLIGHT_HOLD_MS = 900`, and the ripple lasts `RIPPLE_MS = 300` (`motion.rs`).
   - **Product contract** (docs/plans/2026-08-21-0003-feat-agent-cursor-overlay-plan.md):
     - Click-family actions switch the arrow "briefly into a distinct hand pointer and emit a small neutral ripple centered on the destination **only after dispatch has begun**". The ripple "never implies that the application verified the requested outcome".
     - A preflight-rejected target shows no ripple (AE2). If post-dispatch verification fails, the real failure is still reported (AE3).
     - "Compact, subtly tilted … neutral in color, and free of a persistent agent dot or halo." They rejected "a large blue click puck" and "the rejected blue circular marker".
   - **Intent label:**
     - Optional and caller-authored. It is never derived from typed values, clipboard or element values (privacy).
     - Default maximum is 6 words, hard cap 12, with an ellipsis.
     - It sits on a white card with a 1.5 px near-black border at the cursor's bottom-right and flips at screen edges.
     - When the text changes, the old card eases out and the new one eases in, then "breathes".
     - The greeting on enable is "Hey, let's play with this computer!" (addendum).
   - **Style defaults** (`style.rs`): fill `#FFFFFF`, rim `#111318`, accent `#4299FF`, size 1.0 (range 0.5–4). With Reduce Motion the cursor appears at the destination without travel or breathing (R18). It is designed to run smoothly at 60 Hz and use 120 Hz when available (R7).
   - **Multi-agent:** each named agent (`--agent-id`) gets its own cursor and style profile (docs/plans/2026-09-05-001-feat-multi-agent-cursors-plan.md). A bug spawned two cursors in single-agent mode (issue #175), a reminder to enforce one cursor per agent identity.
2. **trycua/cua: Cua Driver** agent cursor plus a "session pill" label (e.g. `ga-r5-window-830674be`).
   - Issue #4194 (closed 2026-09-25): overlay pixels were baked into the agent's *own* desktop captures, and OCR read "Suk nit" instead of "Submit".
   - The fix excludes the overlay from agent-facing captures (Windows `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, macOS ScreenCaptureKit exclusion, X11 hide around the root grab) but keeps it in user-facing recordings. https://github.com/trycua/cua/issues/4194
   - Issue #3542: on a Retina Mac with resized screenshots, the overlay rendered about 280 pt above the correctly delivered click, a coordinate-mapping bug. #2879 proposes a cross-platform "pixel oracle" test that the drawn hotspot matches the delivered point. https://github.com/trycua/cua/issues/3542
3. **Hmbown/codewhale-cu-plugin PR #5** (2026-09-25, open):
   - The cursor is a cyan arrow with a badge. Before each point-targeted action it "glides to that point", clicks get "a short ring", and it "fades after 8 s idle".
   - The overlay panel uses `sharingType = none`, so the agent's screenshots never include it.
   - The backend "waits for the glide before sending input". Glide defaults to 180 ms (max 600).
   - The PR says this is "like Kimi CU". https://github.com/Hmbown/codewhale-cu-plugin/pull/5
4. **AndersonJ293/axscope PR #113** (merged 2026-09-28). A textbook fix of a *lying* animation:
   - The bug: `press()` moved the cursor and fired the ripple in the same frame while the CSS transition took 260 ms. Navigation also rebuilt the overlay, so the cursor vanished and popped in again.
   - The fix: the glide takes 40–80 ms by distance and *returns its duration*, and the presenter waits exactly that long, "so the input lands when the drawn cursor arrives". The last point is remembered per tab and restored after navigation.
   - Click is "a 240 ms tilt around the tip with a spring back", and the ripple fires on arrival.
   - The pointer is rounded with an indigo→violet gradient and a white rim, legible on light and dark pages. The overlay is versioned to prevent two cursors, and `prefers-reduced-motion` makes the cursor jump. https://github.com/AndersonJ293/axscope/pull/113
5. **AndrewKochulab/sim-mirror PR #38** (merged 2026-09-16):
   - The cursor "rests, dimmed, where the agent last acted, with its name chip" for `cursor_linger_s` after the last tool call (default 60 s).
   - Every tool call emits a `working` heartbeat at start, every 10 s (`WORKING_EVERY_S`) and at end, flagged `ongoing`. The viewer holds the cursor and the "using this device" badge until 1.5 beats after the last beat.
   - "**Never in a screenshot.** The cursor is the viewer's overlay, drawn over the canvas and never into it." https://github.com/AndrewKochulab/sim-mirror/pull/38
6. **arul28/ADE PR #1302** (Sept 2026):
   - Each lane gets a private macOS virtual display. A native Swift driver streams it as H.264 and records it.
   - Recordings cut still stretches (`--keep-idle` keeps them).
   - "A purple agent cursor shows where the agent points." There is a floating player and an iPhone viewer with pinch-zoom, where "Take control forces landscape". Stop asks to confirm with "Stop Mac Desktop?". https://github.com/arul28/ADE/pull/1302
7. **kumard3/agentcursor** (MIT, tiny) has a "human-path engine":
   - Fitts's-law duration and asymmetric eased velocity ("not a symmetric min-jerk bell").
   - Overshoot-and-correct, sub-pixel Gaussian jitter that is zero at the endpoints, off-center landing, right-skewed dwell before the press, and fresh entropy on every call.

   Its motive is anti-bot-detection, which localDot does not need, but dwell and overshoot help believability. https://github.com/kumard3/agentcursor

**What the wave agrees on** (adopted in section 4):
- It is a separate visual cursor, never the OS pointer.
- The overlay is never visible to the agent's own observation.
- Input dispatch waits for the drawn cursor to arrive, with a timeout of about 1 s.
- Click effects appear only after dispatch, and they mean "delivered", not "succeeded".
- Intent labels are short and authored by the caller.
- The cursor stays present, dimming and lingering at the last point while the agent thinks.
- Liveness comes from heartbeats.
- Reduced motion means jump or fade.
- Each agent has its own cursor identity.
- The drawn hotspot vs. delivered point is covered by an automated test.

## 2.7 HCI research on overseeing computer-use agents (2025–2026)

- **Liang, Barik, Nichols, Schoop, Cheng (CMU and Apple), "Understanding User Experiences of Computer Use Agents: Design Space and Opportunities for Building Agent UX Prototypes"**, arXiv 2510.04452 v3 (28 Jul 2026). An IUI '26 version is titled "Mapping the Design Space of User Experience for Computer Use Agents" (https://dl.acm.org/doi/10.1145/3742413.3789132). https://arxiv.org/abs/2510.04452
  - They reviewed 11 agents (Claude Computer Use, Operator, Magentic-UI, UI-TARS, Mariner, AutoGLM and others), interviewed 8 practitioners, and ran a Wizard-of-Oz validation with 20 end users.
  - The taxonomy has four categories: *User query*, *Explainability of agent activities*, *User control*, and *Mental model & expectations*.
  - The explainability subcategories map directly onto overlays:
    - "Visibility of agent activities": where the action occurs on the UI, and *retainability*, meaning whether history can be reviewed.
    - "Description of agent action"
    - "Transparency of agent reasoning"
    - "Preview of next steps": "visual indicators on the UI element that is about to be clicked"
    - "Presentation of plan"
    - "Communication of runtime status": running, waiting or done, for both the foreground watcher and the backgrounded user.
  - The control subcategories are:
    - intervention during execution: stop/pause, take over, demonstration, revert to previous steps
    - high-impact scenarios: risk indicators, permission, levels of impact
    - plan intervention
    - agent error: type, recovery, discoverability, communication
- **Chen et al., "Comparing Human Oversight Strategies for Computer-Use Agents"**, arXiv 2604.04918 (v1 6 Apr 2026, v2 12 Sep 2026). https://arxiv.org/abs/2604.04918
  - 48 participants, 192 live web sessions, four strategies:
    - Risk-Gated (modal approvals with "Approve Similar")
    - Action Confirmation (per-action)
    - Supervisory Co-Execution (plan-level approval)
    - Structurally Enriched (plan studio, risk-labelled traces, targeted prompts)
  - Plan-based strategies cut the occurrence of problematic actions (odds ratio about 0.24). But across all strategies users blocked only about 21% of the problematic actions that did execute (29/138).
  - Failure mechanisms were temporal misalignment (deciding too late, or approvals persisting without renewed scrutiny) and judging "procedural correctness" instead of content appropriateness.
  - Implications: "adaptively trigger and support mixed-initiative re-entry"; "treat delegation as an explicit and renewable semantic boundary"; "treat plans as trajectory constraints, not downstream authorization". Figures come from the HTML full text via a summarizer; the abstract is verified.
- **Peng & Li, "What Did It Actually Do?": Understanding Risk Awareness and Traceability for Computer-Use Agents**, arXiv 2603.28551 (31 Mar 2026). https://arxiv.org/html/2603.28551
  - The AgentTrace prototype has five parts: task timeline, resource touch map, permission and authority history, action provenance inspector, and persistent-change summary.
  - Against a chat summary plus a simple log (n=12), comprehension went from 61.3% to 84.7%, risky actions identified from 2.1 to 3.8, and recovery planning scores from 1.6 to 3.4.
  - Users "wanted post-hoc auditing support, not just pre-action warnings".
- **Mozannar et al., "Magentic-UI: Towards Human-in-the-loop Agentic Systems"**, arXiv 2507.22358 (30 Jul 2025): co-planning, co-tasking, multi-tasking, action guards, long-term memory. https://arxiv.org/abs/2507.22358
- **What this means for localDot:**
  - Watching live is optional behaviour. Most value comes at decision-critical moments and in post-hoc review.
  - Invest equally in:
    - a legible live layer: intent preview, where and what
    - well-timed interrupts: risk-gated approvals that are renewable, never "approve similar" for high-risk actions
    - a traceable replay: timeline, a "what changed/persisted" summary, provenance of each action back to the plan step or thought that caused it

# 3. Open-source building blocks and techniques (Task 2)

## 3.1 Streaming, 60 fps compositing, recording/replay, export

*Research thread E1. Includes a local x264 benchmark run on an Apple M3 Ultra.*

**How I researched this.** I used the GitHub API and read source files raw, plus official docs and MDN browser-compat-data (BCD). I also ran one local encode benchmark. The shared WebSearch budget ran out partway through, so everything below comes from primary sources I fetched directly. Items marked **[UNVERIFIED]** or **[estimate]** are not backed by a source. No files were created.

#### TL;DR
- **Selkies 2.0 (released 2026-09-23) is the closest off-the-shelf match.** It removed GStreamer and now defaults to WebSocket + WebCodecs. Its Rust engine, **pixelflux (MPL-2.0)**, already provides:
  - WebCodecs-ready Annex-B H.264
  - an H.264 recording tap and a crash-safe fragmented-MP4 recorder
  - an HTTP API that follows the Anthropic computer-use spec, including `cursor_position`
  - Sources: [release](https://github.com/selkies-project/selkies/releases/tag/2.0.0), [pixelflux](https://github.com/selkies-project/pixelflux)
- **noVNC is the worst fit for drawing our own cursor.**
  - It never receives the remote pointer position. Remote-cursor support is still an open PR, [#1964](https://github.com/novnc/noVNC/pull/1964).
  - View-only viewers see clicks made by an invisible cursor. Issue [#974](https://github.com/novnc/noVNC/issues/974) has been open since 2017.
- **Tart and Lume stream macOS guests the same way**, through Virtualization.framework's private `_VZVNCServer`.
  - Tart is now **`openai/tart`** under **FSL-1.1-ALv2**. Lume (in trycua/cua) is **MIT**.
  - Apple's license allows **2 extra macOS instances per Mac**, and only for listed purposes.
- **All four hosted agent-browser platforms now record video (MP4 or HLS).** Steel keeps rrweb only as a legacy path, and pairs video with a structured action timeline.
- **Overlays:** draw the time-critical overlays (cursor, click ripples, element boxes) into the same GPU canvas as the video, from one rAF loop running in a worker. Upload frames with `texImage2D(VideoFrame)` in WebGL or `importExternalTexture` in WebGPU.
- **Export:** use our own compositor + WebCodecs `VideoEncoder` + mediabunny, which is exactly what MIT-licensed **OpenScreen** (40k★) ships.
  - HyperFrames (Apache-2.0) is a good optional server-side renderer.
  - Avoid Remotion because of its license, and ffmpeg.wasm because its core is GPL and it runs at 0.04–0.08× native speed.

---

#### 1. Streaming the desktop to the browser on localhost

##### 1.1 Snapshot (GitHub API, 2026-09-30)
| Project | License | ★ | Latest release | Browser decode path | Transport |
|---|---|---|---|---|---|
| [noVNC](https://github.com/novnc/noVNC) | MPL-2.0 | 14.1k | v1.7.0, 2026-04-28 | JS decoders on the main thread; WebCodecs for RFB H.264 | WebSocket (via websockify) |
| [KasmVNC](https://github.com/kasmtech/KasmVNC) | GPL-2.0 | 5.3k | v1.5.0, 2026-07-29 | JPEG/WebP/QOI (WASM) rectangles; WebCodecs "video mode" | WebSocket; WebRTC data-channel UDP |
| [neko](https://github.com/m1k1o/neko) | Apache-2.0 | 22.4k | v3.1.6, 2026-09-30 | the browser's native WebRTC stack | WebRTC (Pion v4) + GStreamer |
| [Selkies](https://github.com/selkies-project/selkies) | MPL-2.0 | 2.2k | 2.0.0, 2026-09-23 | WebCodecs, with a JPEG-stripe fallback | WebSocket by default; WebRTC opt-in |
| [Guacamole](https://github.com/apache/guacamole-server) | Apache-2.0 | 4.0k (server) + 1.7k (client) | 1.6.0, tagged 2025-06-23 (no 2026 release) | drawing-instruction protocol rendered to canvas layers | Java webapp + guacd |

##### 1.2 noVNC
- **Rendering path**
  - The RFB decoders run on the page's main thread and write into a backbuffer canvas.
  - `Display.flip()` copies the damaged region to the visible canvas at the end of every FramebufferUpdate ([rfb.js](https://github.com/novnc/noVNC/blob/master/core/rfb.js) around L2676, [display.js](https://github.com/novnc/noVNC/blob/master/core/display.js)).
  - requestAnimationFrame is used only for resize handling. Frames are not paced to the display.
- **Performance limit:** JPEG and Tight-JPEG rectangles are turned into base64 `data:` URIs and decoded through `<img>` (`imageRect()` in display.js). That costs main-thread time when the screen changes a lot.
- **H.264:** v1.6.0 added the RFB "Open H.264" encoding (number 50), decoded with WebCodecs ([h264.js](https://github.com/novnc/noVNC/blob/master/core/decoders/h264.js), [v1.6.0 notes](https://github.com/novnc/noVNC/releases/tag/v1.6.0)).
  - The spec requires baseline profile and a separate decoder context per rectangle ([rfbproto](https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst)).
  - Which servers support it: [UNVERIFIED].
- **Cursor**
  - At 24-bit depth noVNC always requests the VMware-cursor and Cursor (-239) pseudo-encodings, so the server stops drawing the pointer into the framebuffer.
  - noVNC then shows the cursor image as a CSS cursor at the *local* mouse position ([encodings.js](https://github.com/novnc/noVNC/blob/master/core/encodings.js), `_sendEncodings` in rfb.js).
  - It implements neither PointerPos (-232) nor the VMware Cursor Position encoding (0x574d5666), which exist in the RFB spec.
  - Result: when the agent moves the pointer (for example with xdotool), viewers don't see it move.
- **`showDotCursor`** is an RFB property that shows a dot when the server's cursor is fully transparent. v1.7.0 removed the deprecated constructor option but kept the property ([v1.7.0 notes](https://github.com/novnc/noVNC/releases/tag/v1.7.0); verified in the v1.6.0 and v1.7.0 sources).
- **Prior art:** Anthropic's computer-use demo runs Xvfb + `x11vnc -forever -shared -nopw` + noVNC ([x11vnc_startup.sh](https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/image/x11vnc_startup.sh)).

##### 1.3 KasmVNC
- It deliberately breaks from the RFB spec, so legacy VNC viewers can't connect ([README](https://github.com/kasmtech/KasmVNC)).
- **Settings** ([configuration reference](https://www.kasmweb.com/kasmvnc/docs/latest/configuration.html)):
  - `encoding.max_frame_rate` defaults to 60.
  - Video-mode JPEG/WebP quality settings.
  - `network.udp.*` for the WebRTC UDP path.
- **Claims:**
  - The 1.0 release added "WebRTC UDP transit" and a multi-threaded WASM QOI decoder for lossless mode ([1.0.0 notes](https://kasmweb.com/kasmvnc/docs/master/release_notes/1.0.0.html)).
  - The press release says lossless QOI "can consume greater than 1 Gbps with HD+ resolutions at 60fps" ([PR Newswire](https://www.prnewswire.com/news-releases/kasm-technologies-releases-kasmvnc-v1-open-source-vnc-server-with-web-native-agentless-4k-60-fps-lossless-streaming-capability-301691477.html)).
- **1.5.0 (2026-07):** added a video streaming mode with H.264/H.265/AV1, hardware-accelerated through VA-API or NVENC, plus a relative-mouse mode ([release notes](https://github.com/kasmtech/KasmVNC/releases/tag/v1.5.0)).
  - The client decodes it with WebCodecs `VideoDecoder` and `optimizeForLatency: true` ([kasmvideo.js](https://github.com/kasmtech/noVNC/blob/master/core/decoders/kasmvideo.js)).
- **Remote cursor position:** [UNVERIFIED].

##### 1.4 neko
- **Pipeline:** Pion WebRTC v4 ([go.mod](https://github.com/m1k1o/neko/blob/master/server/go.mod)) with GStreamer `ximagesrc show-pointer=%v use-damage=false` ([capture/manager.go](https://github.com/m1k1o/neko/blob/master/server/internal/capture/manager.go)).
  - Supported codecs: vp8, vp9, av1, h264, h265 ([capture docs](https://github.com/m1k1o/neko/blob/master/webpage/docs/configuration/capture.md)).
  - **Default pipeline is VP8 at 25 fps with the pointer burned into the video** (`show_pointer=true`) ([config/capture.go](https://github.com/m1k1o/neko/blob/master/server/internal/config/capture.go)).
- **Cursor:** sent as binary data-channel messages, separate from the video ([payload/send.go](https://github.com/m1k1o/neko/blob/master/server/internal/webrtc/payload/send.go)):
  - `OP_CURSOR_POSITION` (0x01): uint16 x, y
  - `OP_CURSOR_IMAGE` (0x02): width, height, hotspot
- **When positions are sent:** only when the controlling user moves the pointer through neko's control API (`desktop.Move` then `SetCursorPosition`, in [control.go](https://github.com/m1k1o/neko/blob/master/server/internal/websocket/handler/control.go)). An initial position is read on connect.
  - So pointer moves made directly with xdotool are not broadcast. Drive input through neko's API, or keep the pointer in the video.
- **Prior art:** Kernel's WebRTC live view is adapted from neko ([kernel-images](https://github.com/kernel/kernel-images), Apache-2.0).

##### 1.5 Selkies 2.0 + pixelflux
- **Architecture** ([design.md](https://github.com/selkies-project/selkies/blob/main/docs/design.md), [release](https://github.com/selkies-project/selkies/releases/tag/2.0.0)):
  - "GStreamer is gone from the runtime." It is a single Python/aiohttp app on one port.
  - Capture and encoding are done by **pixelflux** (Rust/PyO3), audio by pcmflux.
  - WebSocket + WebCodecs is the default; WebRTC is opt-in via a vendored aiortc fork.
  - Claim: "60 frames per second at 1080p resolution with software encoding on less than 100% CPU."
- **Encoders** ([settings.md](https://github.com/selkies-project/selkies/blob/main/docs/settings.md)): `h264enc | h265enc | vp8enc | vp9enc | av1enc | h264enc-striped | jpeg`.
  - Hardware encoding via NVENC or VA-API, falling back to x264 (or OpenH264 in a GPL-free build).
  - `--framerate` defaults to 60, range 8–240.
  - For legible text: `--video-fullcolor` (4:4:4), `--video-max-qp`, and "paint-over" re-encoding once the screen stops changing.
  - `--backpressure-queue-size` defaults to 120.
- **Cursor:** `--enable-cursors` passes cursor *images* to the client, shown as CSS cursors or drawn on canvas. I found no server→client pointer-position stream [UNVERIFIED].
- **Web client:** the WebSocket client code references `MediaStreamTrackGenerator` / `VideoTrackGenerator` and `requestVideoFrameCallback`, with a 2D-canvas `drawImage` fallback ([selkies-ws-core.js](https://github.com/selkies-project/selkies/blob/main/addons/selkies-web-core/selkies-ws-core.js); inferred from grep, not docs). Its striped mode caps the decode queue at 8.
- **pixelflux features that matter here** ([README](https://github.com/selkies-project/pixelflux)):
  - A raw Annex-B mode for WebCodecs: `codec="h264"`, `video_fullframe=True`, `omit_stripe_headers=True`.
  - **GOP is infinite unless `keyframe_interval_s` is set.** Late joiners must call `request_idr_frame()`.
  - `recording_socket`: Annex-B/OBU/IVF out over a Unix socket (forces an IDR every 30 frames).
  - A built-in crash-safe fragmented-MP4 recorder.
  - `screenshot_png()`.
  - A Computer-Use HTTP server (bearer token required) with actions including `mouse_move` and **`cursor_position`**.
  - Zero-copy DMA-BUF → NVENC/VA-API paths.

##### 1.6 Apache Guacamole
- Java webapp plus the native `guacd` proxy. The protocol is "remote display rendering and event transport", not video ([architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)).
- **Protocol** ([reference](https://guacamole.apache.org/doc/gug/protocol-reference.html)):
  - `img` streams carry PNG/JPEG/WebP.
  - `cursor` sets the cursor image from a rectangle of a layer.
  - The server→client `mouse` instruction "reports that a user on the current connection has moved the mouse", i.e. the position of another Guacamole user, not the desktop's own pointer.
- 1.6.0 rewrote the server-side optimizer and added activity histograms to the recording player ([1.6.0](https://guacamole.apache.org/releases/1.6.0/)).
- Heavy to run. Not recommended for localDot.

##### 1.7 Custom pipeline: capture → encode → WebSocket → WebCodecs
- **Capture without the cursor**
  - X11 with ffmpeg `x11grab -draw_mouse 0` (the default is 1) ([ffmpeg-devices](https://ffmpeg.org/ffmpeg-devices.html#x11grab)).
    - **x11grab PTS is `av_gettime()`, i.e. wall-clock µs** ([xcbgrab.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavdevice/xcbgrab.c) L430).
  - GStreamer: `ximagesrc show-pointer=false`.
  - Wayland: the portal's `cursor_mode` is 1 = Hidden, 2 = Embedded, **4 = Metadata** (cursor sent as PipeWire metadata) ([ScreenCast.xml](https://github.com/flatpak/xdg-desktop-portal/blob/main/data/org.freedesktop.portal.ScreenCast.xml)).
  - macOS host: `SCStreamConfiguration.showsCursor` (macOS 12.3+) ([Apple](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/showscursor)); ffmpeg avfoundation `-capture_cursor` defaults to false.
  - Xvfb and every other X server accept `-nocursor` ([Xserver.man](https://gitlab.freedesktop.org/xorg/xserver/-/blob/master/man/Xserver.man)).
- **Knowing the pointer position (X11):** `XFixesGetCursorImage` returns the **x, y position plus the cursor image, hotspot and serial**. v2 adds `GetCursorImageAndName` and `CursorNotify` shape-change events ([fixesproto](https://gitlab.freedesktop.org/xorg/proto/xorgproto/-/blob/master/fixesproto.txt)).
- **Encoding:** x264 `-tune zerolatency` expands to `--bframes 0 --force-cfr --no-mbtree --sync-lookahead 0 --sliced-threads --rc-lookahead 0` (`x264 --fullhelp`).
  - In Annex-B mode, a key chunk must contain the IDR picture **and** its parameter sets ([W3C AVC registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/)).
- **Local benchmark** (Apple M3 Ultra, FFmpeg 9.0.1, libx264, synthetic `testsrc2`, 600 frames; indicative only):

  | Setting | Measured | CPU cost at 60 fps |
  |---|---|---|
  | 1080p ultrafast + zerolatency, 1 thread | 2.68 s wall (≈224 fps), ≈4.6 ms CPU/frame | ≈28% of one core |
  | 1080p ultrafast + zerolatency, 4 threads | ≈550 fps | — |
  | 1080p veryfast + zerolatency | ≈8 ms CPU/frame | ≈48% of one core |
  | 1280×800 ultrafast | ≈2 ms/frame | ≈13% of one core |
  | 1080p `h264_videotoolbox -realtime 1` | ≈0.7 s CPU total, ≈157 fps | tiny |

- **Transport**
  - WebSocket is enough on loopback.
  - WebTransport now works in Chrome 97+, Firefox 114+ and **Safari 26.4+** (~91% of users) ([caniuse](https://caniuse.com/webtransport)). But it needs an HTTP/3 server, and self-signed certificates via `serverCertificateHashes` must be ECDSA P-256 and valid for less than 2 weeks ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport)).
  - `WebSocketStream` (built-in backpressure) is Chrome 124+ only (BCD).
- **Decode:** `VideoDecoder` is available in Chrome 94, Firefox 130 and Safari 16.4 (BCD). If `description` is omitted, the decoder assumes **Annex B** (W3C). Config fields `optimizeForLatency` and `hardwareAcceleration` are documented on [MDN](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure).
- **Latency on localhost [estimate]:** ≤16.7 ms capture interval + a few ms encode + under 1 ms transport + 1–5 ms decode + up to 1 vsync ≈ **25–45 ms** end to end.
- **Timestamps:** put the capture wall-clock time in the WebCodecs chunk `timestamp`. It comes back unchanged on the decoded `VideoFrame.timestamp`, which gives exact frame-to-event sync for free.

##### 1.8 macOS guests (Virtualization.framework)
- **Tart** ([repo](https://github.com/openai/tart), 7.3k★, 2.40.1 on 2026-09-30, FSL-1.1-ALv2 [LICENSE](https://github.com/openai/tart/blob/main/LICENSE), which converts to Apache-2.0 two years after each release):
  - `--vnc` uses the guest's own Screen Sharing.
  - `--vnc-experimental` uses VZ's private `_VZVNCServer`, which also works in Recovery and during installation ([Run.swift](https://github.com/openai/tart/blob/main/Sources/tart/Commands/Run.swift), [FullFledgedVNC.swift](https://github.com/openai/tart/blob/main/Sources/tart/VNC/FullFledgedVNC.swift)).
- **Lume** (MIT, inside [trycua/cua](https://github.com/trycua/cua), 27.5k★, nightly v0.5.4 from 2026-09) also uses `_VZVNCServer` with a generated passphrase ([VNCService.swift](https://github.com/trycua/cua/blob/main/libs/lume/src/VNC/VNCService.swift)).
  - cua's computer-server can drive any VNC target through vncdotool ([vnc.py](https://github.com/trycua/cua/blob/main/libs/python/computer-server/computer_server/handlers/vnc.py)).
- **Limits**
  - Apple's license allows "up to two (2) additional copies or instances" in VMs per Mac, only for development, testing, macOS Server, or personal non-commercial use. It excludes "service bureau, time-sharing" use ([macOS Tahoe SLA](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf)).
  - The VNC server is a private API, so an OS update could break it.
  - Retina guests report input in points while the framebuffer is in pixels; account for the scale factor [UNVERIFIED specifics].
- **Linux on a macOS host:** [apple/container](https://github.com/apple/container) (Apache-2.0, 50k★, 1.5.0 on 2026-09-29) runs each container as a lightweight VM. It requires macOS 26 and Apple silicon.

##### 1.9 Hiding the real cursor and knowing its position
| Stack | Pointer in video? | Cursor shape sent to client | Remote position sent to client |
|---|---|---|---|
| noVNC | No, once cursor pseudo-encodings are negotiated | Yes (CSS cursor) | **No** |
| KasmVNC | Similar to RFB | Yes | [UNVERIFIED] |
| neko | Yes by default (set `show_pointer: false`) | `OP_CURSOR_IMAGE` | `OP_CURSOR_POSITION`, but only for moves made through neko's API |
| Selkies/pixelflux | `capture_cursor` setting | Yes | Poll pixelflux's HTTP `cursor_position` |
| Guacamole | `cursor` instruction | Yes | `mouse` instruction (other users' pointers) |
| Custom | `draw_mouse 0` / `showsCursor=false` / portal Metadata mode | XFixes image + name | XFixes / XQueryPointer at 60–120 Hz |

**Design point:** xdotool moves the pointer instantly, so the virtual cursor has to be animated from the action log. In "showcase" mode, delay the real click until the animation arrives.

##### 1.10 Recommendation for a localhost app
- **Linux guests:** build a custom path using pixelflux (Annex-B, `keyframe_interval_s = 1–2`), or `ffmpeg x11grab -draw_mouse 0 -f h264 -`.
  - Send one binary WebSocket message per access unit, with a header carrying frameId, key flag and capture time in µs.
  - Decode with WebCodecs in a worker.
  - Stream cursor position and shape over a side channel (XFixes).
  - Trade-offs: lowest latency, full control of timestamps, moderate complexity (about 1–2k LOC [estimate]).
  - Alternative: embed Selkies wholesale. Fastest to demo, but its client UI and cursor handling aren't ours.
- **macOS guests:** Lume VM → a host-side RFB client → re-encode with VideoToolbox (`-realtime 1`) → the same WebCodecs client. Use noVNC as the v0 fallback.
- **Use neko** only if multi-viewer WebRTC over a WAN matters later.

---

#### 2. Compositing overlays at 60 fps

##### 2.1 Getting video frames onto the GPU
- **WebGL:** `texImage2D` accepts `VideoFrame` as a source ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/texImage2D)).
- **WebGPU:** `importExternalTexture({source: VideoFrame})` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/importExternalTexture)).
  - The texture "*can* provide direct read access… avoiding unnecessary copies", which is typical for hardware-decoded video, and converts YUV to RGB in the shader automatically ([WebGPU explainer](https://gpuweb.github.io/gpuweb/explainer/)).
  - A texture imported from a `VideoFrame` **expires when the frame is closed**. Call `queue.submit` first, then `close()`.
  - Availability (BCD): Chrome 113 on Windows/macOS/ChromeOS; Chrome 144 on Linux (Intel Gen12+ only); Firefox 144 on Windows (partial); Safari 26. **Default to WebGL2 and make WebGPU optional.**

##### 2.2 Worker + OffscreenCanvas
- `transferControlToOffscreen()` hands the canvas to a worker. OffscreenCanvas WebGL2 works in Chrome 69, Firefox 105 and Safari 17. Worker `requestAnimationFrame` works in Chrome 69, Firefox 99 and Safari 16.4 (BCD).
- `VideoDecoder` also runs in workers, so the WebSocket → decode → render chain can live entirely off the main thread.
- **Gotcha [UNVERIFIED but expected]:** a worker canvas and main-thread DOM commit independently, so a DOM overlay can be one frame out of step with the video. Keep time-critical overlays inside the GPU scene.

```js
// worker.js — latest-frame-wins; one rAF loop; one camera matrix for video + overlays
const cfg = { codec: 'avc1.64002A', optimizeForLatency: true };   // no description ⇒ Annex B
let latest = null, waitKey = false, videoTs = 0;
const dec = new VideoDecoder({ output: f => { latest?.close(); latest = f; }, error: resync });
dec.configure(cfg);
ws.onmessage = ({ data }) => {
  const v = new DataView(data), key = (v.getUint8(0) & 1) === 1;
  if (dec.decodeQueueSize > 3) { dec.reset(); dec.configure(cfg); waitKey = true; askServerForIdr(); }
  if (waitKey && !key) return; waitKey = false;
  dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta',
    timestamp: Number(v.getBigUint64(1)), data: new Uint8Array(data, 9) }));
};
function tick(now) {
  if (latest) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, latest);
                videoTs = latest.timestamp; latest.close(); latest = null; }
  drawVideoQuad(M); overlays.render(M, videoTs, now);   // same matrix M
  requestAnimationFrame(tick);
}
```

##### 2.3 Syncing overlays to a `<video>` element (replay path)
- `requestVideoFrameCallback` gives `mediaTime` (the PTS of the composited frame), `presentationTime`, `expectedDisplayTime`, `presentedFrames` (use gaps to detect drops) and `processingDuration`. For WebRTC it also gives `captureTime`, `receiveTime` and `rtpTimestamp` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)).
- The callback can fire one vsync late; compare `expectedDisplayTime` with `now` to detect this. You must re-register it inside every callback.
- Available in Chrome 83, **Firefox 132** and Safari 15.4 (BCD).

##### 2.4 Renderer options
| Renderer | License / ★ / latest | Notes |
|---|---|---|
| **PixiJS v8** | MIT / 48.2k / v8.21.0, 2026-09-17 | `ImageSource` accepts `VideoFrame` ([src](https://github.com/pixijs/pixijs/blob/dev/src/rendering/renderers/shared/texture/sources/ImageSource.ts)); WebGL/WebGPU; a `WebWorkerAdapter` for OffscreenCanvas ([src](https://github.com/pixijs/pixijs/blob/dev/src/environment-webworker/WebWorkerAdapter.ts)); filters; used by OpenScreen |
| Three.js | MIT / 116k / r186, 2026-09-24 | `VideoFrameTexture.setFrame(frame)` for WebCodecs ([src](https://github.com/mrdoob/three.js/blob/dev/src/textures/VideoFrameTexture.js)); overkill for a 2D HUD |
| regl | MIT / 5.6k / 2.1.1, 2024-11 | stale, WebGL-only |
| TypeGPU | MIT / 3.2k / v0.12.6, 2026-09-25 | typed WebGPU/WGSL written in TypeScript; external-texture examples such as chroma-keying; pre-1.0 |
| DOM/SVG | — | best for text-heavy panels. Animate only `transform` and `opacity`. Use `will-change` sparingly: "every layer… requires memory" ([web.dev](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count)). Batch reads before writes ([web.dev](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)) |

##### 2.5 Coordinate mapping and camera
There are several coordinate spaces:
- **model screenshot px** — computer-use tools report coordinates "in screenshot pixels", and you must scale them back if you resized the screenshots ([Anthropic docs](https://docs.claude.com/en/docs/agents-and-tools/tool-use/computer-use-tool))
- **desktop px** — the canonical space; store all events here
- **video px**
- **CSS px**
- **device px**

Use **one affine matrix** for the video quad, the overlays, and the inverse mapping for input.
```ts
const fit = Math.min(css.w / desk.w, css.h / desk.h);   // letterbox
const s = fit * cam.zoom, tx = css.w/2 - cam.cx*s, ty = css.h/2 - cam.cy*s;
const toDevice = (x, y) => [(x*s + tx)*dpr, (y*s + ty)*dpr];      // desktop → device px
const toDesktop = (cx, cy) => [(cx - tx)/s, (cy - ty)/s];          // input hit-testing
```
- Zoom inside the GPU by resampling the texture at device resolution, rather than scaling the canvas with CSS, so vector overlays stay crisp.
- Size the canvas with `ResizeObserverEntry.devicePixelContentBoxSize` (Chrome 84, Firefox 108). Safari lacks it, so fall back to `contentRect × devicePixelRatio` (BCD).

##### 2.6 Open-source prior art
- **OpenScreen** ([repo](https://github.com/siddharthvaddem/openscreen); MIT; 40k★; v1.5.0 on 2026-06-06). A Screen Studio clone built on PixiJS v8, mediabunny, mp4box, web-demuxer and gsap.
  - Cursor smoothing: resample the path to 240 Hz, then run a spring-damper; the same parameters are used live and in export ([cursorPathSmoothing.ts](https://github.com/siddharthvaddem/openscreen/blob/main/src/lib/cursor/cursorPathSmoothing.ts)).
  - Auto-zoom from cursor dwell: 450–2600 ms dwell, 2% movement threshold ([zoomSuggestionUtils.ts](https://github.com/siddharthvaddem/openscreen/blob/main/src/components/video-editor/timeline/zoomSuggestionUtils.ts)).
  - Export: frames rendered through `Texture.from(VideoFrame)` in Pixi → `VideoEncoder` (`avc1.640033`, backpressure via `encodeQueueSize`, keyframe every 150 frames) → mediabunny `Mp4OutputFormat({fastStart:'in-memory'})` ([exporter/](https://github.com/siddharthvaddem/openscreen/tree/main/src/lib/exporter)).
- **Cap** ([repo](https://github.com/CapSoftware/Cap); 23k★): AGPLv3, except the `scap-*`/`cap-camera*` crates, which are MIT (useful for ScreenCaptureKit capture).
- **Playwright 1.59** (2026-04-01) added `page.screencast` with `showActions` action annotations, overlays, chapters and "agentic video receipts". 1.61 added a `cursor` option ([release notes](https://github.com/microsoft/playwright/blob/main/docs/src/release-notes-js.md)). It works by injecting overlays into the page, so it is browser-only.

---

#### 3. Recording and replay

##### 3.1 Container format
- **Crash-safe while recording:** `-movflags +frag_keyframe+empty_moov+default_base_moof`. MDN lists `default_base_moof` as the Chrome-specific requirement for MSE ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API/Transcoding_assets_for_MSE)).
- **Other ffmpeg options** ([ffmpeg-formats](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv); all verified present in FFmpeg 9.0.1):
  - `hybrid_fragmented`: writes a fragmented file while recording and converts it to a normal MP4 at the end.
  - `-write_prft wallclock|pts`: writes Producer Reference Time boxes that map NTP time to media time. mp4box.js can parse them ([prft.ts](https://github.com/gpac/mp4box.js/blob/main/src/boxes/prft.ts)).
- **Reference implementation (Kernel):** ffmpeg x11grab → libx264 High profile, yuv420p, `-use_wallclock_as_timestamps 1`, `+frag_keyframe+empty_moov`, `-frag_duration 2000000`. After the run it remuxes with `+faststart` and **writes action markers as MP4 chapters**, clamped to [0, duration] because markers can land before the first captured frame ([ffmpeg.go](https://github.com/kernel/kernel-images/blob/main/server/lib/recorder/ffmpeg.go), [markers.go](https://github.com/kernel/kernel-images/blob/main/server/lib/recorder/markers.go)).
- **Teeing the live stream:** raw Annex-B carries no timestamps. If you pipe it through `-f h264 -c copy`, ffmpeg assigns constant-frame-rate timing, which is wrong for damage-driven capture. Instead:
  - mux in-process with explicit per-frame timestamps (pixelflux's recorder, or mediabunny `EncodedVideoPacketSource` via `@mediabunny/server`), or
  - run a second x11grab encode for the archive. It costs about 0.3 of a core at 1080p60 (benchmark above), and lets you choose archive-quality settings.

##### 3.2 GOP, CFR/VFR and timestamps
- **Live stream:** request IDR frames on demand.
- **Recording:** use a fixed 1–2 s GOP (`-g 60 -keyint_min 60 -sc_threshold 0 -bf 0` at 60 fps). A seek then decodes at most GOP−1 frames.
- **VFR vs CFR:** desktops are mostly static, so variable frame rate (damage-driven capture, or `-vf mpdecimate`) saves space. Normalize to constant frame rate with `-fps_mode cfr` only for exports.
- **Clock sync**
  1. Use one host clock. x11grab PTS is already wall-clock µs. Store `t0` (the first frame's PTS) in a sidecar file and in PRFT boxes.
  2. On long runs, record periodic (monotonic, realtime) clock pairs to catch NTP slew.
  3. For VM guests, timestamp frames at host ingress and actions at the input injector. Calibrate the remaining constant offset with a "clapper": the first visible change after a known click [design suggestion].
  4. SEI is not practical: ffmpeg `h264_metadata sei_user_data` inserts only a fixed UUID+string, not per-frame values ([bsf docs](https://ffmpeg.org/ffmpeg-bitstream-filters.html#h264_005fmetadata)).
  5. On the WebRTC path, use rVFC `captureTime`.

##### 3.3 Playback and scrubbing
- **MSE:** good for scrubbing a run while it is still in progress, by appending fragments as they are written. For finished runs, a plain faststart MP4 with range requests is simpler. On iOS you need `ManagedMediaSource` (Safari 17 / iOS 17.1, BCD).
- **Frame-accurate scrubbing:** [mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0, 7.2k★, v1.61.0 on 2026-09-29).
  - `VideoSampleSink.getSample(t)` returns the last frame at or before t and decodes from the preceding keyframe. `samplesAtTimestamps()` avoids decoding the same packet twice. Call `close()` on every sample ([sinks](https://mediabunny.dev/guide/media-sinks)).
  - Alternatives: [mp4box.js](https://github.com/gpac/mp4box.js) (BSD-3, v2.4.1 on 2026-06-19) for demuxing and segmenting; [web-demuxer](https://github.com/bilibili/web-demuxer) (MIT, plus LGPL FFmpeg code in `lib/`; 1.1 MB WASM, or 493 kB for the mini build; 4.0.0 on 2025-12).
- **Thumbnails**
  - Server-side, keyframes only: `ffmpeg -skip_frame nokey -i run.mp4 -fps_mode vfr -vf "scale=240:-2,tile=10x10" sprite_%02d.jpg`. With a 1 s GOP that gives one thumbnail per second.
  - Client-side: mediabunny `CanvasSink({width,height,poolSize}).canvasesAtTimestamps([...])`.

##### 3.4 rrweb
- [rrweb](https://github.com/rrweb-io/rrweb): MIT, 20.2k★. **v2 is stable** (2.1.6 on 2026-09-18) and now ships as `@rrweb/record` and `@rrweb/replay`.
- **Canvas** is not recorded by default. `recordCanvas: true` with `sampling.canvas: 15` captures up to 15 fps snapshots (WebP optional). Replaying them needs `UNSAFE_replayCanvas`, which adds `allow-scripts` to the replay iframe ([recipe](https://github.com/rrweb-io/rrweb/blob/master/docs/recipes/canvas.md)).
- **Cross-origin iframes** need rrweb injected into every child frame, and events travel over `postMessage` ([recipe](https://github.com/rrweb-io/rrweb/blob/master/docs/recipes/cross-origin-iframes.md)).
- **Size:** control it with `checkoutEveryNms`, sampling, and `packFn` ([guide](https://github.com/rrweb-io/rrweb/blob/master/guide.md), [storage recipe](https://github.com/rrweb-io/rrweb/blob/master/docs/recipes/optimize-storage.md)).
- Video pixels and native OS UI are never captured, so rrweb is useful to localDot only as an optional in-guest source of DOM semantics.

##### 3.5 How hosted agent-browser platforms do replays (all video now)
- **Browserbase:** "records every session as a video by default". Replays are HLS playlists of fMP4 `.m4s` segments, one per tab, up to 10 tabs, kept 31 days; MP4 download was added 2026-07-15 ([docs](https://docs.browserbase.com/platform/browser/observability/session-replay), [changelog](https://www.browserbase.com/changelog)). Earlier rrweb-based replays: [UNVERIFIED].
- **Steel:** moved "from slow, unreliable screencasting and event-based playback" to "full OS-level streaming" (25 fps WebRTC) plus MP4/HLS recordings — "no event reconstruction, no missing UI elements". rrweb remains only for legacy headless sessions ([docs](https://docs.steel.dev/overview/sessions-api/embed-sessions/past-sessions)).
  - Its "Agent Traces" timeline rows carry a "wall clock plus an offset from session start". Clicking a row seeks the video, and activity markers appear on the progress bar ([docs](https://docs.steel.dev/overview/agent-traces/timeline)).
- **Kernel:** replays are MP4s produced by ffmpeg, started and stopped via API ([docs](https://kernel.sh/docs/browsers/replays)).
- **Browser Use Cloud:** MP4 recordings, **off by default** (`enableRecording` / `browserSettings.record`), processed asynchronously ([docs](https://docs.browser-use.com/cloud/browser/live-preview)).
- **Why video won:** fidelity (canvas, PDFs, native UI, cross-origin content) and play-anywhere embedding. **The pattern to copy:** video for pixels plus a structured event timeline for meaning.

---

#### 4. Exporting replays as shareable videos

| Tool | License | ★ / latest | How it renders | Fit for localDot |
|---|---|---|---|---|
| **Remotion** | Source-available [Remotion License](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md): free for individuals, companies of up to 3 people, and non-profits. Otherwise a company license: "Automators" $0.01/render with a $100/month minimum, which explicitly covers "embedding the Remotion Player" ([pricing](https://www.remotion.pro/license)) | 61.2k / v4.0.530, 2026-09-29 | React → headless Chrome + FFmpeg, Lambda. `renderMediaOnWeb` is stable since 4.0.491 (WebCodecs + mediabunny), but it emulates layout on a canvas with CSS gaps (no z-index, perspective, backdrop-filter…) and **sends telemetry on every client-side render** ([docs](https://www.remotion.dev/docs/client-side-rendering), [limits](https://www.remotion.dev/docs/client-side-rendering/limitations)). A 5.0 license change adds contractors to the team-size count ([PR #3750](https://github.com/remotion-dev/remotion/pull/3750)) | ✗ as a dependency — the license would pass to our users |
| **HyperFrames** (HeyGen) | Apache-2.0 | 54.5k / v0.8.96, 2026-09-30 (repo created 2026-03-10; pre-1.0, several releases a day) | HTML compositions timed with `data-start`/`data-duration`/`data-track-index`, animations as paused GSAP timelines in `window.__timelines`. The engine computes t = frame/fps, seeks, captures with **chrome-headless-shell `HeadlessExperimental.beginFrame`**, and encodes with FFmpeg. No wall clock and no fetching mid-render ([README](https://github.com/heygen-com/hyperframes), [determinism](https://hyperframes.heygen.com/concepts/determinism)). Outputs MP4, MOV (ProRes 4444), transparent WebM, GIF, PNG and HLS | ✓ optional "cinematic" renderer |
| Motion Canvas | MIT | 19.2k / v3.17.2, 2024-12 | TypeScript generator scenes | ✗ stale |
| Revideo (now [midrender/revideo](https://github.com/midrender/revideo)) | MIT | 4.1k / 0.11.0 on npm, 2026-07 | headless render API + React player | small community |
| ffmpeg.wasm | MIT wrapper; **`@ffmpeg/core` is GPL-2.0-or-later** (npm) | 17.8k / v12.15, 2025-01 | about 0.04× native single-threaded and 0.08× multi-threaded ([benchmark](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/apps/website/docs/performance.md)) | ✗ |
| **Our compositor + WebCodecs + mediabunny** | MPL-2.0, file-level, fine as an unmodified dependency | 7.2k / v1.61.0 | `VideoEncoder` with hardware acceleration + mediabunny MP4 muxer | ✓ **primary** |
| mp4-muxer / webm-muxer | MIT | deprecated in favor of mediabunny ([notice](https://github.com/Vanilagy/mp4-muxer)) | — | ✗ |

**Can HyperFrames render from a JSON timeline?** Not directly: it has "no proprietary timeline format". But it can do this through variables:
- declare them with `data-composition-variables`, and read them in a script with `window.__hyperframes.getVariables()`;
- pass values with `--variables '{…}'`, `--variables-file`, or `--batch rows.json` ([variables](https://hyperframes.heygen.com/concepts/variables));
- or write a custom frame adapter implementing `seekFrame(frame)`.
A localDot "reel template" could therefore build GSAP tweens from the event-log JSON. Whether large JSON variables are practical: [UNVERIFIED]. Render speed: [UNVERIFIED].

**Recommendation for 30–60 s highlight reels:**
1. Generate a reel spec (JSON) from the action log: segments, speed ramps over idle time, zoom keyframes led by click and typing targets, and captions from the action descriptions (no ASR needed).
2. Render it with the **same Pixi compositor** used live, so preview and export match.
3. Encode with `VideoEncoder`, respecting `encodeQueueSize`, and mux with mediabunny, as OpenScreen does.
4. Offer HyperFrames as an opt-in plugin for motion-graphics intros and outros or narration. Use gif.js (MIT) for GIF output.

---

#### 5. Performance hygiene
- **Frame budget:** 16.67 ms per frame, but "all of your work needs to be completed inside 10 milliseconds" ([web.dev](https://web.dev/articles/rendering-performance)).
  - Use **one** rAF loop that owns the video texture and every overlay.
  - Keep React out of the per-frame path: mutable stores plus Pixi, with React only for side panels.
  - Never read layout (such as `getBoundingClientRect`) inside the loop; cache it with ResizeObserver.
- **Workers:** put the WebSocket, `VideoDecoder`, and the OffscreenCanvas render in one worker. The main thread handles DOM chrome and input only.
- **Frame memory**
  - Chromium logs "A VideoFrame was garbage collected without being closed… to prevent stalls" ([webcodecs_logger.cc](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/webcodecs/webcodecs_logger.cc)); close frames promptly to reduce memory ([Chrome guide](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs)).
  - Keep at most 1–2 frames alive. With WebGL, close right after `texImage2D`. With WebGPU, close after `submit`.
- **Backpressure**
  - Watch `decodeQueueSize` and the `dequeue` event (Chrome 106, Firefox 130, Safari 16.4).
  - For live video: always decode every frame (P-frames need their references), present only the newest, and if the queue grows, reset the decoder, request an IDR, and skip until the next keyframe.
  - Chrome's encoder example drops frames when more than 2 are in flight.
  - Server side: bound the send queue per client (Selkies defaults to 120) and adapt bitrate from the frame round-trip time.
- **Measure**
  - `performance.now()` deltas in rAF, and rVFC `presentedFrames` gaps.
  - `getVideoPlaybackQuality()` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/getVideoPlaybackQuality)).
  - Long Animation Frames: `new PerformanceObserver(cb).observe({type:'long-animation-frame', buffered:true})` gives `blockingDuration`, `renderStart`, `styleAndLayoutStart` and `scripts[].forcedStyleAndLayoutDuration`. Chrome 123+ only ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing), BCD).
  - Glass-to-glass latency: on localhost the server and browser share the OS clock, so `Date.now()*1000 − frame.timestamp` gives it directly (minus display latency).

---

#### 6. Recommended stack for localDot
| Layer | Choice | License | Why |
|---|---|---|---|
| Linux guest | Xvfb (`-nocursor`) + WM in a container (apple/container, Docker or OrbStack on macOS hosts) | MIT/X11, Apache-2.0 | Simple XTEST/xdotool input; standard tooling |
| Capture/encode | **pixelflux** (Annex-B H.264, `keyframe_interval_s=1`, `capture_cursor=False`; its GPL-free OpenH264 build is an option), or ffmpeg x11grab + x264 zerolatency | MPL-2.0 / LGPL-GPL (run as a separate process) | Damage-driven capture, zero-copy hardware encode, recording tap, `cursor_position` API; about 0.3 core at 1080p60 in software |
| Cursor | XFixes position, image and name side channel at 60–120 Hz, plus a virtual cursor animated from the action log | — | We draw our own cursor and must know every position |
| Transport | WebSocket, one AU per message with a µs capture-time header; WebTransport later for remote access | own MIT code | Nothing is gained over loopback; simplest option |
| Browser video | WebCodecs `VideoDecoder` in a worker → WebGL2 (WebGPU optional) on OffscreenCanvas | platform | Lowest latency; the frame timestamp is ours |
| Overlays | **PixiJS v8** in the same worker and context, one camera matrix; TypeGPU for special shaders | MIT | Supports VideoFrame, worker adapter, filters |
| Recording | Tee the stream into fragmented MP4 (1–2 s GOP) via pixelflux's recorder or a second x11grab encode; events as JSONL on the same host clock; `-write_prft wallclock`; markers as chapters; finalize with `+faststart` or `hybrid_fragmented` | MPL-2.0 / FFmpeg | Crash-safe, seekable, and aligned with the action log |
| Replay | mediabunny (WebCodecs, frame-accurate scrubbing and thumbnails) with the same Pixi renderer; `<video>` + rVFC as a lightweight fallback | MPL-2.0 | Same look as live |
| Export | Same renderer → `VideoEncoder` → mediabunny MP4; optional HyperFrames plugin | MPL-2.0 / Apache-2.0 | License-clean and matches the preview |
| macOS guest | **Lume** VM → `_VZVNCServer` → host RFB bridge → VideoToolbox H.264 → same client; noVNC as v0 fallback | MIT / MPL-2.0 | Tart is FSL; mind the 2-VM license limit |
| Avoid | Remotion (license/telemetry), ffmpeg.wasm (GPL, slow), Guacamole (heavy), KasmVNC (GPL, non-standard RFB) as core dependencies | — | — |

## 3.2 Cursor motion, auto-zoom, overlays, avatar companion, sound, reduced motion

*Research thread E2.*

Method: official docs and primary source read through `gh api` / raw.githubusercontent / WebFetch. Partway through, a sibling agent reported that the shared WebSearch budget was used up, so later facts come from direct fetches of known URLs. Star counts and last-push dates come from the GitHub API on 2026-09-30. I measured bundle sizes myself from unpkg.com on the same day. Anything I could not confirm is marked [UNVERIFIED]. Nothing was written outside the scratchpad.

#### 0. Library ledger (license · ★ · last push)

| Library | License | ★ | Last push |
|---|---|---|---|
| Motion (motiondivision/motion), npm 13.4.6 | MIT | 33.8k | 2026-09-30 |
| react-spring 10.1.2 | MIT | 29.2k | 2026-09-30 |
| GSAP 3.15.0 | "Standard no-charge" (not OSI) | 28.7k | 2026-04-13 |
| ghost-cursor | MIT on GitHub / ISC on npm | 1.6k | 2026-09-28 |
| bezier-js 6.1.4 | MIT | – | – |
| Cap (CapSoftware/Cap) | AGPLv3 for most code | 23.0k | 2026-09-30 |
| OpenScreen (siddharthvaddem/openscreen) | MIT | 40.0k | 2026-06-17 |
| Recordly (webadderallorg/Recordly; fork of OpenScreen) | AGPLv3 plus attribution/branding terms | 32.0k | 2026-09-23 |
| Screenize (syi0808/screenize, development paused) | Apache-2.0 | 605 | 2026-05-22 |
| Screenity | GPL-3.0 | 18.7k | 2026-09-25 |
| OmniParser | GitHub says CC-BY-4.0 (README badge says MIT) | 25.5k | 2026-07-20 |
| microsoft/SoM | MIT | 1.6k | 2024-08 (stale) |
| browser-use | MIT | 116.8k | 2026-09-30 |
| Vimium | MIT | 27.0k | 2026-07-25 |
| KeyCastr | BSD-3 | 15.1k | 2026-09-07 |
| Keyviz (now Tauri) | GPL-3.0 | 9.7k | 2026-04-01 |
| screenkey (GitLab) | GPLv3 | 394 | 2026-09-29 |
| rive-wasm / rive-runtime / rive-react | MIT | 970 / 1.19k / 1.17k | 2026-09 |
| lottie-web 5.13.0 | MIT | 32.1k | 2025-09-01 (no 2026 activity) |
| dotlottie-web 0.80.0 | MIT | 889 | 2026-09-16 |
| ThorVG | MIT | 1.85k | 2026-09-30 |
| three-vrm 3.5.5 | MIT | 2.19k | 2026-09-30 |
| AIRI | MIT | 49.9k | 2026-09-30 |
| Open-LLM-VTuber | MIT plus LICENSE-Live2D.md | 14.0k | 2026-05-15 |
| TalkingHead | MIT | 1.57k | 2026-09-25 |
| BongoCat | Apache-2.0 | 23.7k | 2026-09-30 |
| pixi-live2d-display | MIT | 1.5k | 2024-08 (stale) |
| Howler 2.2.4 | MIT | 25.4k | 2025-11 |
| Tone.js 15.1.22 | MIT | 14.7k | 2026-09-29 |
| use-sound | MIT | 3.2k | 2025-06 |
| snd-lib 1.2.4 | MIT | 221 | 2025-10 |
| ZzFX | MIT | 793 | 2026-09-11 |
| PixiJS | MIT | 48.2k | 2026-09-30 |

#### 1. Cursor motion

##### 1.1 Spring engines

**Motion.** Real defaults from source (https://github.com/motiondivision/motion/blob/main/packages/motion-dom/src/animation/generators/spring.ts):
- Physics defaults: `stiffness: 100, damping: 10, mass: 1.0`.
- Time defaults: `duration: 800 ms, bounce: 0.3, visualDuration: 0.3 s`.
- Rest thresholds: restSpeed 2 and restDelta 0.5. For ranges under 5 units they drop to 0.01 and 0.005.
- The docs page (https://motion.dev/docs/spring) shows different defaults (stiffness 1, bounce 0.25). Trust the source.

The source has two load-bearing details:
```ts
if (options.visualDuration) {
  const root = (2 * Math.PI) / (options.visualDuration * 1.2)
  springOptions.stiffness = root * root
  springOptions.damping = 2 * clamp(0.05, 1, 1 - (options.bounce || 0)) * Math.sqrt(springOptions.stiffness)
}
// "Time-defined springs ignore inherited velocity."
const inheritVelocity = (velocity) => isTimeDefined ? 0 : -millisecondsToSeconds(velocity)
```
- **Cursor retargeting must use physics options (stiffness/damping/mass).** A visualDuration/bounce spring drops velocity when interrupted, which shows as a kink. The docs say the same thing for `springValue`: physics options "incorporate the velocity of the value for the smoothest and most reactive motion" (https://motion.dev/docs/spring-value).
- The generator exposes `retarget(keyframes, newVelocity)` and memoizes exp/sin terms for per-frame retargeting.
- `toString()` emits `"<ms> linear(...)"` sampled every 30 ms, via `generateLinearEasing` (https://github.com/motiondivision/motion/blob/main/packages/motion-dom/src/animation/waapi/utils/linear.ts).
- React equivalent is `useSpring(source, {stiffness})`, with `.jump()` for instant sets (https://motion.dev/docs/react-use-spring).

**react-spring presets** (https://github.com/pmndrs/react-spring/blob/main/packages/core/src/constants.ts), mass 1:

| Preset | Tension | Friction |
|---|---|---|
| default | 170 | 26 |
| gentle | 120 | 14 |
| wobbly | 180 | 12 |
| stiff | 210 | 20 |
| slow | 280 | 60 |
| molasses | 280 | 120 |

**GSAP.**
- All plugins have been free since the standard license took effect on 2025-04-30.
- The license prohibits use "in tools that allow users to build visual animations without code" that compete with Webflow (https://gsap.com/standard-license, https://gsap.com/licensing/).
- localDot is not such a tool, but the clause would pass on to forks. Prefer MIT libraries in an OSS core.
- `gsap.quickTo(target, "x", {duration: 0.4, ease: "power3"})` restarts a tween toward each new value (https://gsap.com/docs/v3/GSAP/gsap.quickTo()/).
- MotionPathPlugin `curviness` defaults to 1 (https://gsap.com/docs/v3/Plugins/MotionPathPlugin/).
- OpenScreen ships gsap ^3.15, motion ^12.38 and pixi.js ^8.18 together (its package.json).

**WAAPI `linear()`.**
- Baseline since December 2023: Chrome/Edge 113, Firefox 112, Safari 17.2 (https://developer.mozilla.org/en-US/docs/Web/CSS/easing-function/linear, https://developer.chrome.com/docs/css-ui/css-linear-easing-function).
- Roughly 24–30 stops approximate a bounce well.
- It is a fixed-duration curve. Interrupting it means re-sampling the current value and velocity in JS, so use it for fire-and-forget effects (ripples, label pops), not a retargeting cursor. This last point is my inference.

**All presets in one parameterization.** With m = 1: ω0 = √(k/m), ζ = c / (2√(km)), response = 2π/ω0. At steady state a spring chasing a moving target trails it by exactly c/k seconds, independent of mass. Cap exploits this (https://github.com/CapSoftware/Cap/blob/main/crates/rendering/src/cursor_interpolation.rs).

| Spring | k / c / m | ζ | Response | Lag c/k |
|---|---|---|---|---|
| Motion default physics | 100 / 10 / 1 | 0.50 (bouncy) | 0.63 s | 100 ms |
| Motion default visualDuration 0.3 / bounce 0.3 | ≈305 / 24.4 / 1 | 0.70 | 0.36 s | 80 ms |
| react-spring default | 170 / 26 / 1 | 1.00 | 0.48 s | 153 ms |
| Cap cursor "Mellow" (default) | 470 / 70 / 3 | 0.93 | 0.50 s | 149 ms |
| Cap "Slow" | 200 / 40 / 2.25 | 0.94 | 0.67 s | 200 ms |
| Cap "Smooth" | 80 / 28 / 2.5 | 0.99 | 1.11 s | 350 ms |
| Cap "Fast" | 380 / 30 / 1 | 0.77 | 0.32 s | 79 ms |
| Cap click "snappy" | 530 / 40 / 1 | 0.87 | 0.27 s | 75 ms |
| Cap drag | 1000 / 40 / 1 | 0.63 | 0.20 s | 40 ms |
| Cap camera | 200 / 40 / 2.25 | 0.94 | 0.67 s | 200 ms |
| OpenScreen zoom | 320 / 40 / 0.92 | 1.17 (overdamped) | 0.34 s | 125 ms |
| Screenize cursor (ζ 0.90, response 0.06 s) | ≈10966 / 189 | 0.90 | 0.06 s | 17 ms |
| Screenize camera pan (ζ 0.9, response 0.35 s) | ≈322 / 32 | 0.90 | 0.35 s | 100 ms |
| Screenize zoom (ζ 0.9, response 0.55 s) | ≈130 / 21 | 0.90 | 0.55 s | 157 ms |

Sources: https://github.com/CapSoftware/Cap/blob/main/crates/project/src/configuration.rs, https://github.com/siddharthvaddem/openscreen/blob/HEAD/src/components/video-editor/videoPlayback/motionSmoothing.ts, https://github.com/syi0808/screenize/blob/HEAD/Screenize/Render/SpringCursorSimulator.swift.

OpenScreen maps a "smoothing" slider onto spring values:
- 0 → k 1000, c 100, m 1.
- 0 to 0.5 → k 760→340, c 34→58, m 0.55→1.
- 0.5 to 2 → k 340→160, c 58→80, m 1→1.35.

##### 1.2 Human-like paths

**ghost-cursor** (https://github.com/Xetera/ghost-cursor/blob/master/src/spoof.ts, .../src/math.ts):
```ts
const fitts = (distance, width) => 0 + 2 * Math.log2(distance / width + 1)
const length = curve.length() * 0.8          // DEFAULT_WIDTH 100, MIN_STEPS 25
const speed = moveSpeed > 0 ? 25 / moveSpeed : Math.random()
const steps = Math.ceil((Math.log2(fitts(length, width) + 1) + speed * 25) * 3)
```
- **Curve.** A cubic Bezier. Both control points lie on random normals to the start→end line, on the same random side. The normal length ("spread") is clamp(D, 2, 200) px.
- **Overshoot.** If D > 500 px (`overshootThreshold`), it first goes to a random point inside a 120 px disc (`OVERSHOOT_RADIUS`), then corrects with spread 10.
- **Destination.** A random point inside the element box.
- **Timing.** Optional timestamps integrate Bezier arc speed divided by a random speed in 0.5–1.0.
- **Delays.** `moveDelay` 2000 ms, randomized to 0–2000. `hesitate` and `waitForClick` both default to 0.
- **Visualizer.** Its `mouse-helper.ts` draws a 20 px translucent disc (rgba(0,0,0,.4), 1 px white border, .2 s transitions) and restyles it per pressed button.

**WindMouse** (https://ben.land/post/2021/04/25/windmouse-human-mouse-movement/):
- The reference code is **GPLv3**, so do not copy it into an MIT codebase.
- Defaults: G_0 = 9 (gravity), W_0 = 3 (wind), M_0 = 15 (max step), D_0 = 12 (damping distance).
- Each step, wind decays by √3 and adds noise up to ±W/√5 while distance ≥ D_0.
- Velocity above M_0 is clipped to a random value in [M_0/2, M_0].
- Inside D_0, M_0 shrinks by √5 per step with a floor of 3.

**Other humanizers:** HumanCursor (MIT, 531★, 2024-11), pyclick (MIT, 2023), OxyMouse (MIT, 353★, 2025-09).

**Motor-control references.**
- Minimum-jerk reaching gives nearly straight paths with bell-shaped speed (Flash & Hogan 1985, J Neurosci 5:1688, PMID 4020415). The standard time warp is s = 10τ³ − 15τ⁴ + 6τ⁵.
- Fitts (Shannon form): MT = a + b·log2(D/W + 1) (https://en.wikipedia.org/wiki/Fitts%27s_law). Typical mouse a/b constants were not found [UNVERIFIED].

##### 1.3 Retargeting mid-flight without kinks

- **Cap.** Integrates an analytic spring-mass-damper and retargets every step, "with velocity always carried across retargets… no fixed animation durations" (https://github.com/CapSoftware/Cap/blob/main/crates/rendering/src/zoom_spring.rs, spring_mass_damper.rs). The step is 8 ms for the camera and 1/60 s for the cursor.
- **Lag compensation.** The cursor spring's target leads the raw path by c/k. A one-pole filter (0.12 per step, about 130 ms time constant) blends the lead when the spring profile changes.
- **Click anticipation.** The target snaps to the next click position once that click is ≤500 ms away. The spring switches to the snappy profile 175 ms before the click, and to the drag profile while the button is held.
- **OpenScreen overshoot clamp.** If a step crosses a moving target, snap to it and zero the velocity: "stay quick without jelly." It also clamps dt to 1–80 ms (https://github.com/siddharthvaddem/openscreen/blob/HEAD/src/components/video-editor/videoPlayback/zoomSpring.ts).
- **Re-planning a Bezier from the current state.** Keep C1 continuity with P1 = p0 + v0·T/3 and P2 = p1 − v1·T/3 (Hermite↔Bezier, https://en.wikipedia.org/wiki/Cubic_Hermite_spline).

##### 1.4 Screen Studio cursor features and open re-implementations

**Screen Studio documents these settings, with no numbers:**
- Cursor size, "Hide cursor if it's not moving", "Loop cursor position".
- "Rotate cursor while moving", "Remove cursor shakes" (unintended movement, often from accessibility tools), "Optimize original cursor types", "Stop cursor movement at the end of the video" (https://screen.studio/guide/cursor).
- Cursor animation style: Smooth / Medium / Rapid / None.
- Screen animation: "Focused" ("stabilizes quickly, making it easier to follow and read") or "Smooth".
- Separate motion-blur sliders for cursor movement, zooming, and moving (https://screen.studio/guide/animations).
- Smoothing can be disabled per fragment, e.g. for dropdown menus (https://screen.studio/guide/disable-smooth-mouse-movement).
- A click sound with volume control (https://screen.studio/guide/mouse-click-sound).

**Cap** (cursor_interpolation.rs, layers/cursor.rs, configuration.rs):
- **Shake filter.** Drop a sample if it reverses direction (dot product < 0) and both adjacent moves are under 0.015 of the frame, within a 100 ms window.
- **Decimation.** Resample to 60 fps and drop moves under 1/1920 of the frame.
- **Idle hide.** Off by default. Delay 2.0 s, minimum 500 ms, fade-out 400 ms. The cursor reappears 250 ms before it moves again.
- **Click press.** The cursor shrinks to 0.8× over 130 ms.
- **Rotation amount** 0.15.
- **Motion blur**, "Screen Studio semantics": smear length = per-frame travel × amount, linear, capped at 480 px.
- **Ripple.** Off by default. Color rgb(71,133,255), strength 0.7 (range 0–1), size 1.0 (range 0.25–3), duration 0.6 s (range 0.2–1.5).

**Recordly.**
- Cursor sway up to π/18 (10°), reached at 1400 px/s, vertical weight 0.65, default sway 0.4.
- Click bounce 2 over 350 ms.
- Click effect off by default: #2563EB, 600 ms.
- Source: https://github.com/webadderallorg/Recordly/blob/HEAD/src/components/video-editor/videoPlayback/cursorSway.ts and types.ts.

**Screenity.** A live click target that scales 1→0 and fades, plus a highlight and a spotlight that follow the pointer through rAF (https://github.com/alyssaxuu/screenity/blob/master/src/pages/Content/utils/CursorModes.jsx).

#### 2. Auto-zoom and camera follow

**Screen Studio (documented behavior).**
- Auto zoom "focuses on the areas where clicks occurred". With no click there is no zoom (https://screen.studio/guide/auto-zoom).
- A single "Create zooms automatically" toggle (https://screen.studio/guide/disable-automatic-zooms-).
- An "Instant Animation" toggle per zoom (https://screen.studio/guide/instant-zoom).
- Typing segments are detected only for speed-up (https://screen.studio/guide/speed-up-typing-segments).
- "Zoom that follows typing" is still "In Review" and was merged into another request (https://hub.screen.studio/p/zoom-that-follows-typing).
- Default zoom level and durations are not documented [UNVERIFIED].

**Cap: turning clicks into zoom segments** (https://github.com/CapSoftware/Cap/blob/main/apps/desktop-gpui/src/editor_edits.rs, mirroring src-tauri/src/recording.rs):
```rust
const CLICK_PRE_PADDING_MS: f64 = 300.0;   const CLICK_POST_PADDING_MS: f64 = 2500.0;
const CLICK_END_CLAMP_PADDING_MS: f64 = 800.0; const TRAILING_CLICK_IGNORE_MS: f64 = 1000.0;
const MERGE_GAP_MS: f64 = 2500.0;          // DEFAULT_AUTO_ZOOM_AMOUNT = 2.0, edge_snap_ratio 0.25
```
- In Cap's test, clicks at 1 s and 2 s merge into one segment [0.7, 4.5] s, and a click at 10 s becomes [9.7, 12.5] s.
- `auto_zoom_on_clicks` defaults to true (https://github.com/CapSoftware/Cap/blob/main/apps/desktop/src-tauri/src/general_settings.rs).

**Cap camera** (zoom_spring.rs, zoom.rs):
- **Channels.** Zoom amount, center, and activity, each driven by a spring (k 200, c 40, m 2.25).
- **Clustering.** All cursor moves are clustered greedily into boxes no larger than 50% × 70% of the visible zoomed viewport; this is the dead zone. The camera re-aims only when the cursor leaves the current box.
- **Edge snap.** With ratio 0.25, the range [0.25, 0.75] maps onto [0, 1], so edge targets frame flush without showing outside the frame.
- **Pre-aim.** While zoom ≤ 1.0005 the center moves instantly, so an incoming zoom launches already aimed. This avoids "a huge late pan that also detonated the motion blur."
- **Zoom-out.** Hold the last center while zooming out, and clamp the zoom amount to ≥1 so the view never bounces out past the frame.
- **Instant zooms** snap within ±0.1 s.

**OpenScreen** (https://github.com/siddharthvaddem/openscreen/blob/HEAD/src/components/video-editor/videoPlayback/constants.ts, zoomRegionUtils.ts, ../timeline/zoomSuggestionUtils.ts, ../types.ts):
- **Auto-suggest from dwell, not clicks.** A dwell is 450–2600 ms of movement under 0.02 of the frame. Candidates are ranked by dwell length and spaced at least 1800 ms apart.
- **Transitions.** Zoom-out 1015.05 ms; zoom-in 1.5× that (1522.6 ms), overlapped 500 ms into the region. Easing `cubic-bezier(0.16,1,0.3,1)`, which the code names `easeOutScreenStudio`.
- **Chained regions.** Regions ≤1500 ms apart pan directly over 1000 ms with `cubic-bezier(0.1,0,0.2,1)` instead of zooming out and back in.
- **Depth presets.** 1.25 / 1.5 / **1.8 (default)** / 2.2 / 3.5 / 5.0×, maximum 5.0.
- **Follow.** Distance-adaptive smoothing whose factor ramps from 0.10 to 0.25 over 0.15 of the frame, made frame-rate independent:
```ts
return 1 - (1 - baseFactor) ** (dtMs / referenceMs)   // referenceMs = 1000/40
```
- **Deadzones.** 1.25 px for translation and 0.002 for scale.
- **Zoom motion blur.** Default 0.35. Peak at 1400 px/s, maximum 14 px, threshold 12 px/s.

**Recordly.**
- Click clusters merge within 2500 ms, padded 500 ms each side.
- Interaction kinds: dwell, click, double-click, text-focus, dropdown-open, text-selection.
- Follow camera recenters only when the cursor leaves an inner safe zone inset 25% of the visible span per side, and freezes while zooming out (https://github.com/webadderallorg/Recordly/blob/HEAD/src/components/video-editor/videoPlayback/cursorFollowCamera.ts).
- "Focused" preset: 200 ms zoom in and out.

**Screenize** (Apache-2.0, so it can be ported; the most agent-relevant design):
- **Intent-driven waypoints.** Intents are typing (code, text field, terminal, rich text), clicking, navigating, dragging, reading, scrolling, switching, idle.
- **Zoom range per intent** (https://github.com/syi0808/screenize/blob/HEAD/Screenize/Generators/GenerationSettings.swift):

| Intent | Zoom range |
|---|---|
| Typing in code | 2.0–2.5× |
| Typing in a text field | 2.2–2.8× |
| Typing in a terminal | 1.6–2.0× |
| Typing rich text | 1.8–2.2× |
| Click | 1.5–2.5× |
| Navigate | 1.5–1.8× |
| Drag | 1.3–1.6× |
| Scroll | 1.3–1.5× |
| Read | 1.0–1.3× |
| Switch / idle | 1.0× |

  Overall maximum 2.8×.
- **Dead zone** (https://github.com/syi0808/screenize/blob/HEAD/Screenize/Generators/ContinuousCamera/ContinuousCameraTypes.swift, DeadZoneTarget.swift):
  - Safe zone 75% of the viewport (60% while typing); gradient band 0.25.
  - Partial correction 0.45 (0.80 while typing).
  - Hysteresis ±15% of the safe half-width.
  - Response 0.20 s if the next action is under 0.5 s away, 0.50 s if it is over 2.0 s away.
- **Urgency.** Response multipliers: immediate 0.05, high 0.5, normal 1, lazy 2, blended over 0.5 s. Camera lead times: 0.24 / 0.16 / 0.08 / 0 s.
- **Anticipation** (IntentClassifier.swift): typing 0.4 s, click 0.15 s, drag, scroll and switch 0.25 s. Typing session timeout 1.5 s; idle after 5 s.
- **Startup.** Ignore motion under 0.02 as jitter; motion over 0.08 within 0.35 s counts as deliberate.
- **Idle recentering.** Response 3.0 s once velocity drops below 0.02/s.

**Screenity** has only a manual live zoom: ×1.5 per modifier-key press, CSS transform plus transition (ZoomContainer.jsx).

**Motion-sickness mitigations these tools share:**
- Critically or over-damped camera springs (ζ 0.9–1.17).
- Dead zones with hysteresis, and partial rather than full recentering.
- Pre-aiming before zooming in; no panning while zooming out.
- Connected pans instead of zoom-out/zoom-in yo-yo.
- Maximum zoom 2–2.8×.
- Apple adds: under Reduce Motion, reduce "zooming, scaling, and peripheral motion" (https://developer.apple.com/design/human-interface-guidelines/accessibility).

#### 3. Overlays

**Set-of-Mark** (Yang et al., arXiv 2310.11441, Oct 2023): segment the image with SEEM/SAM and overlay "alphanumerics, masks, boxes". Zero-shot GPT-4V with these marks beat fully fine-tuned referring-expression models on RefCOCOg (https://arxiv.org/abs/2310.11441).

**OmniParser v2** (Feb 2025):
- 60% lower latency than v1.
- With GPT-4o, 39.6 average on ScreenSpot Pro, versus 0.8 for GPT-4o alone (https://www.microsoft.com/en-us/research/articles/omniparser-v2-turning-any-llm-into-a-computer-use-agent/).
- A YOLOv9-E detector was added 2026/7. `icon_detect_v3` is MIT-based; older Ultralytics detectors are AGPL; the caption models are MIT (https://github.com/microsoft/OmniParser).
- Demo defaults: box threshold 0.05, IoU 0.1, detection image size 640. Label and line sizes scale by image width / 3200 (gradio_demo.py).

**Browser Use highlight overlay** (https://github.com/browser-use/browser-use/blob/main/browser_use/browser/python_highlights.py):
- Dashed boxes, color-coded by element: button #FF6B6B, input #4ECDC4, select #45B7D1, link #96CEB4, textarea #FF8C42, other #DDA0DD.
- Label font = clamp(10, 20, 1% of CSS width), on a filled chip with a 2 px white outline.
- "Demo mode" injects a log panel with levels info / action / thought / success / warning / error and 0.25 s fades (demo_mode.py).

**Vimium hints.**
- Hint alphabet `"sadfjklewcmpgh"`, home row first (https://github.com/philc/vimium/blob/master/lib/settings.js).
- Markers: 11 px text on a #fff785→#ffc542 gradient, 1 px #c38a22 border, 3 px radius, shadow `0 3px 7px rgba(0,0,0,.3)` (content_scripts/vimium.css).

**Moving a highlight from one target to the next.**
- FLIP: measure first and last position, invert with transform, play. Work done in the "100ms after someone interacts" goes unnoticed (https://aerotwist.com/blog/flip-your-animations/).
- Motion `layoutId` gives shared-element morphs with scale correction; the incoming element's transition wins (https://motion.dev/docs/react-layout-animations).
- Animate only transform and opacity; every compositor layer costs memory (https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count).
- Marching ants: animate SVG `stroke-dashoffset` (https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/stroke-dashoffset).
- Glow: prefer a static-shadow layer whose opacity/scale animates over animating box-shadow (my inference from the compositor guidance).

**Click ripple reference numbers.**
- Material: expand 225 ms from origin scale 0.6, fade-in 75 ms, fade-out 150 ms, pressed opacity 0.16 (dark ink) or 0.32 (light) (https://github.com/material-components/material-components-web/blob/master/packages/mdc-ripple/constants.ts; repository archived Jan 2025).
- Cap and Recordly both use 600 ms.

**Keystroke HUDs.**
- **KeyCastr** (https://github.com/keycastr/keycastr/blob/main/keycastr/KCDefaultVisualizer.m):
  - Defaults: `commandKeysOnly: YES`, `fadeDelay 2.0 s`, `fadeDuration 0.2 s`, `keystrokeDelay 0.5 s`, font 16, bezel black at 80%.
  - Plain characters append to the current bezel until 0.5 s of inactivity starts a new one.
  - Any command-key stroke abandons the current bezel and starts a fresh line.
- **screenkey** (https://gitlab.com/screenkey/screenkey/-/blob/master/README.rst):
  - Display time 2.5 s. Mouse "hide duration" fade 1 s.
  - "Compress repeats" shows a counter after N repeats.
  - "Baked" backspace edits the displayed text.
  - Modifier styles: Ctrl+A, ⌘+A, or Emacs C-A. An optional "modifier sequences only" mode.
  - Pressing both Ctrl keys pauses it stealthily, e.g. during password entry.
- **Keyviz** (https://github.com/mulaRahul/keyviz/blob/main/src/stores/key_event.ts, key_style.ts): filter defaults to "modifiers", linger 5000 ms, fade animation 0.25 s, history off (maximum 5), scroll linger 300 ms.
- **Screen Studio:** "Show shortcuts", a label size slider, and "Show single key shortcuts". Single keys pressed close together while typing are filtered (https://screen.studio/guide/shortcuts).
- **Screenize:** display 1.5 s, fade-in 0.15 s, fade-out 0.3 s.

#### 4. Micro-animations and the avatar companion

##### 4.1 Runtimes

**Rive.**
- Runtime is MIT. `@rive-app/webgl2` (Rive Renderer, full editor fidelity including vector feathering) is the recommended package. Canvas2D wins for blend-mode-heavy scenes on mobile. `canvas-lite` drops text, layout, audio and scripting. `@rive-app/webgl` is deprecated after 2.37.0 (https://rive.app/docs/runtimes/web/canvas-vs-webgl).
- Use `useOffscreenRenderer: true` to share one WebGL2 context across instances.
- Measured `rive.wasm` in 2.43.1:

| Package | Raw | Gzipped |
|---|---|---|
| webgl2 | 2.22 MB | ≈906 KB |
| canvas | 1.96 MB | ≈804 KB |
| canvas-lite | 882 KB | ≈359 KB |

- State-machine Inputs are officially **deprecated** in favor of Data Binding (https://rive.app/docs/editor/state-machine/inputs).
- The ViewModelInstance API has `number()`, `string()`, `boolean()`, `color()`, `trigger()`, `enum()`, `list()`, `image()`, `viewModel()`, plus `.on(cb)` observers (https://github.com/rive-app/rive-wasm/blob/master/js/src/rive.ts, js/test/data_bind.test.ts):
```js
const r = new Rive({ src, canvas, stateMachines: "Main", autoBind: true, onLoad() {
  r.viewModelInstance.number("gazeX").value = 0.3; r.viewModelInstance.trigger("nod").trigger(); }});
```
- **Catch for an OSS project:** the free editor plan **cannot export .riv files**. Export needs Cadet at $9/seat/month or higher (https://rive.app/pricing). Contributors would need a paid seat to edit the avatar.
- Rive claims files 10–15× smaller than Lottie ("240KB → 16KB") (https://rive.app/blog/rive-as-a-lottie-alternative); vendor claim.

**Lottie.**
- lottie-web 5.13: `lottie.min.js` 306 KB (76 KB gz), `lottie_light` 168 KB (46 KB gz). No 2026 commits.
- dotlottie-web 0.80 (ThorVG):
  - wasm 1.24 MB (≈496 KB gz).
  - Software, WebGL2 and experimental WebGPU backends switch with a one-line import.
  - `DotLottieWorker` renders off the main thread (https://github.com/LottieFiles/dotlottie-web).
  - State machine API: `stateMachineLoad/Start/Stop`, `stateMachineSetNumericInput/BooleanInput/StringInput`, `stateMachineFireEvent`, `stateMachinePostClickEvent` (packages/web/src/dotlottie.ts).
- Open-source authoring: Glaxnimate (KDE) exports Lottie (https://glaxnimate.org/).

**Live2D.**
- Cubism Core is under the *Live2D Proprietary Software License*. The framework is under the *Live2D Open Software License*.
- Any business with annual revenue over ¥10,000,000 needs a Cubism SDK Release License (https://github.com/Live2D/CubismWebSamples/blob/develop/LICENSE.md). Poor fit for an OSS default.

**three-vrm** (MIT):
- `VRMLookAt` with `target` and `autoUpdate` (https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm-core/src/lookAt/VRMLookAt.ts).
- VRM 1.0 expression presets: happy / angry / sad / relaxed / surprised, the visemes aa / ih / ou / ee / oh, blink / blinkLeft / blinkRight, and lookUp / Down / Left / Right (https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md).
- LookAt range maps default to inputMaxValue 90, outputScale 10 (lookAt.md).

**Spline.** `@splinetool/runtime` 2.0.63 has **no license field** and unpacks to 35.9 MB (npm). Avoid for an OSS core.

##### 4.2 Believable gaze and liveliness: numbers to encode

- **Saccades** (https://en.wikipedia.org/wiki/Saccade): 20–200 ms, 20–30 ms typical in reading. Peak speed up to 700°/s. About 200 ms latency to an unexpected stimulus. 2–3 fixations per second.
- **Smooth pursuit** (https://en.wikipedia.org/wiki/Smooth_pursuit): above about 30°/s it needs catch-up saccades. Pursuit starts in 90–150 ms.
- **Anticipation.** In natural tasks gaze leads the hand by **0.56 s**, and moves on 0.61 s before the previous action finishes (Land, Mennie & Rusted 1999, PMID 10755142). This is larger than the 100–200 ms assumed in the brief.
- **Head vs eyes.** Width of the eye-only range 35.8 ± 31.9° (roughly ±18°). Beyond it the head covers about 0.77 of the excess (Stahl 1999, PMID 10333006).
- **Blinks** (https://en.wikipedia.org/wiki/Blinking): about 17/min baseline, 4–5/min while reading, 100–150 ms (up to 400 ms).
- **Gaze-evoked blinks.** Lid muscle activity fires with 97% of gaze shifts over 33°, starting with the movement (Evinger 1994, PMID 7813670).
- **Cubism defaults.**
  - Blink: next blink at a uniform random 0–7 s (interval 4.0 × 2 − 1); close 0.10 s, closed 0.05 s, open 0.15 s (https://github.com/Live2D/CubismWebFramework/blob/develop/src/effect/cubismeyeblink.ts).
  - Breathing: non-commensurate sines, head X ±15° at 6.53 s, Y ±8° at 3.53 s, Z ±10° at 5.53 s, body ±4° at 15.53 s, breath 3.23 s.
  - Pointer look-at: ±30° head, ±10° body (Samples/TypeScript/Demo/src/lappmodel.ts).
- **TalkingHead.**
  - Blink: 85% single blinks every 1–8 s, shaped 50 ms / 100–300 ms / 100 ms; 15% double blinks every 1–4 s.
  - Eye contact probability 0.2 when idle, 0.5 when speaking. Idle glances hold 2–5 s (https://github.com/met4citizen/TalkingHead/blob/main/modules/talkinghead.mjs).
- **AIRI idle saccade intervals** come from a table in 400 ms bins (about 7.5% under 0.8 s, spreading to about 4 s) (https://github.com/moeru-ai/airi/blob/main/packages/stage-ui-live2d/src/utils/eye-motions.ts).

##### 4.3 How companion products map state to animation

- **AIRI.**
  - The LLM emits `<|ACT {json}|>` and `<|DELAY n|>` stream tokens (packages/pipelines-audio/src/llm-streaming-control/parsers/act.ts, delay.ts).
  - Emotion enum: happy, sad, angry, think, surprised, awkward, question, curious, neutral. These map to Live2D motion groups and to VRM expressions such as happy, sad, surprised (constants/emotions.ts).
- **Open-LLM-VTuber.** The prompt tells the model to insert `[joy]`-style keywords. `emotionMap` maps them to expression indices, e.g. neutral 0, joy 3, sadness 1 (model_dict.json, prompts/utils/live2d_expression_prompt.txt).
- **Clippy.js.**
  - Animation vocabulary: Thinking, Searching, Writing, Processing, CheckingSomething, GetAttention, Congratulate, Idle*, plus Look* / Gesture* chosen by `atan2` into four quadrants (`gestureAt`) (https://github.com/clippyjs/clippy.js/blob/master/src/agent.js).
  - Repo license is unasserted and the art is Microsoft's.
- **BongoCat.** Each key has an assigned hand, which drives `CatParamLeftHandDown` / `CatParamRightHandDown` (crates/bongocat-app/src/model_input.rs).
- **Neuro-sama.** An LLM with TTS and a Live2D avatar, then Unity, then a 3D model in November 2025. Pipeline internals are private (https://en.wikipedia.org/wiki/Neuro-sama).
- **Grok Companions.** 3D animated characters launched July 2025 (https://en.wikipedia.org/wiki/Grok_(chatbot)). How their animation syncs is [UNVERIFIED].
- **Microsoft Mico.** Launched 2025-10-23 as "AI Clippy" (https://en.wikipedia.org/wiki/Microsoft_Copilot). Behavior details [UNVERIFIED].

#### 5. Sound design

- **Howler.** Core 26.9 KB (7.9 KB gz). Rate 0.5–4, pool of 5, sprites, `fade()` (https://github.com/goldfire/howler.js).
- **use-sound.** Under 1 KB in the bundle plus about 9–10 KB gz lazy-loaded Howler. Options `volume`, `playbackRate`, `interrupt`, `soundEnabled`, `sprite`. Josh Comeau's examples use volume 0.25–0.5 and add a keyboard-accessible, persisted mute, so the site stays "100% usable without sound" (https://www.joshwcomeau.com/react/announcing-use-sound-react-hook/).
- **Tone.js.** 345 KB (79 KB gz); overkill for ticks.
- **ZzFX.** About 1 KB, MIT, 20 parameters. Default `randomness = .05` gives ±5% pitch jitter per play (https://github.com/KilledByAPixel/ZzFX/blob/master/ZzFX.js).
- **SND (snd.dev, Dentsu).** Kits Sine / Piano / Industrial and events TAP, TYPE, NOTIFICATION, CAUTION and similar. Free for commercial use, but "redistributing … the materials by itself as unprocessed" is prohibited. Committing the raw files to a public repo is a gray area.
- **Web Audio platform rules.**
  - An AudioContext created before a user gesture starts "suspended" and needs `resume()` (https://developer.chrome.com/blog/autoplay).
  - Use AudioParam ramps, and give the user volume and mute controls (https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices).
  - `detune` is in cents, ±100 per semitone.
  - The Audio Session API types are "transient" (plays over and may duck others), "ambient" (mixable) and "transient-solo". It is experimental and not Baseline (https://w3c.github.io/audio-session/).
- **Procedural soft tick** (my sketch; peak 0.06 ≈ −24 dBFS):
```js
const f = 880 * (1 + (Math.random()*2-1)*0.05), t = ctx.currentTime;
const o = new OscillatorNode(ctx,{type:"sine",frequency:f}), g = new GainNode(ctx,{gain:1e-4});
g.gain.exponentialRampToValueAtTime(0.06, t+0.003); g.gain.exponentialRampToValueAtTime(1e-4, t+0.065);
o.connect(g).connect(bus); o.start(t); o.stop(t+0.08);
```

#### 6. Reduced motion

- `prefers-reduced-motion` has been Baseline since January 2020. "Reduce" means replacing motion with non-vestibular alternatives such as dissolves, not removing all animation (https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion).
- WCAG 2.3.3 (AAA): motion triggered by interaction must be disableable. Color, blur and opacity changes that do not change size, shape or position do not count as motion (https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html).
- Apple HIG under Reduce Motion: reduce "automatic and repetitive animations, including zooming, scaling, and peripheral motion". Tighten springs to reduce bounce, avoid z-axis depth animation, replace x/y/z transitions with fades, avoid animating blurs (https://developer.apple.com/design/human-interface-guidelines/accessibility).
- Motion's `<MotionConfig reducedMotion="user">` disables transform and layout animations but keeps opacity and backgroundColor (https://motion.dev/docs/react-accessibility).

#### 7. Recommended motion toolkit for localDot

**Architecture (my recommendation).**
- **Animate before acting.** The agent's tool call is known before it runs. Animate the cursor, camera and gaze first, then dispatch the real input when the cursor lands. That gives free look-ahead, which Screen Studio clones can only fake after the fact.
- Hide the VM's own cursor so there is no double cursor. Xvfb/Xorg accept `-nocursor` (https://gitlab.freedesktop.org/xorg/xserver/-/blob/master/os/utils.c).
- Render every overlay in one PixiJS 8 canvas, or one SVG layer, inside the same transformed container as the `<video>`, so zoom keeps them aligned.
- Stream at native resolution so 2× zoom stays crisp.

| Concern | Choice | License | Defaults |
|---|---|---|---|
| Spring engine | Motion `spring()` / `springValue`, or a small analytic spring-mass-damper (Cap pattern, reimplemented; don't copy AGPL code) | MIT | Physics options only, so velocity carries across retargets |
| Cursor path | bezier-js + min-jerk time warp, spring chasing the path target | MIT | Duration T = clamp(150 + 100·log2(D/W+1), 220, 700) ms (proposal; calibrate by eye). Control-point spread about 10% of D, one side. No random overshoot in "show" mode. Chase spring k 530 / c 40 / m 1 (ζ 0.87), with the target sampled 75 ms (c/k) ahead. Re-plan with P1 = p + v·T/3. Stiffen to snappy about 175 ms before the click; 80–120 ms dwell before clicking (proposal) |
| Click feedback | Custom canvas | – | Press to 0.8× over 130 ms, spring back. Ring 0.6→1.0× in about 225 ms with `cubic-bezier(.16,1,.3,1)`, fade 150–300 ms (total ≤600 ms), accent color at 0.7 strength, about 48 px |
| Target highlight | Spring on x/y/w/h (FLIP-style) | MIT | k 400 / c 40 (ζ 1.0, about 0.31 s). 4–6 px padding. Label chip fades in 120 ms. Optional marching ants via dashoffset. Optionally show the model's SoM marks for audit, then collapse to the chosen one |
| Camera | Screenize-style intent waypoints plus Cap-style clusters, edge snap and pre-aim | Apache-2.0 ideas / MIT code | Zoom by intent: click 2.0×, text typing 2.2×, terminal 1.8×, scroll 1.3×, reading 1.0×, maximum 2.5×. Pan k≈322 / c≈32 (0.35 s); zoom k≈130 / c≈21 (0.55 s). Lead 0.08–0.24 s. Dead zone 75% (60% typing), hysteresis 15%, correction 0.45 / 0.8, cluster box 50%×70%. Hold 2.5 s after the last action; merge actions under 2.5 s apart; pan directly between regions ≤1.5 s apart. No panning during zoom-out. Motion blur off by default |
| Keystroke HUD | Custom | – | Batch printable characters into one pill, flushed after 500 ms idle. Modifier combos as separate chips that start a new line. Compress repeats as ×N. Linger 1.5 s, fade in 150 ms, fade out 300 ms. **Mask password fields.** Because xdotool types every 12 ms by default (https://github.com/jordansissel/xdotool/blob/master/xdotool.pod), reveal text at a readable pace |
| Avatar | Default: code-driven SVG/canvas avatar with Motion springs (fully open to contributors). Optional skins: Rive `webgl2` / `canvas-lite` with data binding, or three-vrm | MIT runtimes (Rive editing needs a paid seat) | View model: `state` enum (idle / thinking / acting / typing / waiting / success / error), `gazeX`/`gazeY`, triggers. Gaze leads the next target by 300–550 ms. Saccade 40–80 ms. Pursuit spring about 0.1 s response. Head joins beyond the eye-only range at gain 0.77. Blink at uniform 1–7 s, 15% doubles, 100/50/150 ms; blink on shifts over 1/3 of the screen. Breathing on incommensurate 3.2 / 5.5 / 6.5 s sines. Typing: eyes on the caret, fewer blinks. Error: calm concern, not drama |
| Sound | Raw Web Audio or ZzFX; Howler if you use samples | MIT | Off by default or opt-in. Volume 0.1–0.25. ±5% pitch jitter. Per-sound cooldown 80–120 ms, at most 3 voices. Typing ticks −12 dB and one per 2–3 keys. Duck effects −8 dB during TTS. Persisted mute plus volume slider. `audioSession.type="ambient"` where supported |
| Reduced motion | `matchMedia('(prefers-reduced-motion: reduce)')` plus an in-app override | – | Cursor: 150 ms cross-fade or teleport with a static fading path line. Springs to ζ = 1. Auto-zoom off, or ≤1.25× with 150 ms dissolve cuts. No camera follow. Ripple becomes an opacity-only ring. Highlight fades instead of morphing. Avatar idle loops off. Motion blur off |

#### Gaps

- Screen Studio numeric defaults (zoom level, durations, spring values) are not published [UNVERIFIED].
- Typical mouse Fitts a/b constants: not found.
- Grok Companions and Mico animation internals [UNVERIFIED].
- Cap, Recordly, Screenity, Keyviz, screenkey and the WindMouse code are GPL/AGPL. Only the numbers and ideas above are reusable in an MIT localDot. Screenize (Apache-2.0) and OpenScreen (MIT) code can be ported with attribution.

# 4. Recommended visualization spec for localDot

**Goal.** Watching localDot should feel like watching a skilled person operate a computer, filmed by a good camera operator. Every visual must be:
- **True:** it depicts only what actually happened, at the moment it happened.
- **Anticipatory:** intent is shown before the act.
- **Quiet:** nothing moves when nothing is happening.
- **Deterministic:** the same event log renders the same pixels live, in replay and in export.

**Positioning.** Hosted products mostly show *that* an agent is working, with glow borders and step lists. localDot should also show *where*, *what* and *why*, at element level and in real time. No shipped product does this today (§0.1, item 10).

## 4.1 Principles (the truthfulness contract)

1. **Intent → travel → act → effect → settle → verify, always in that order.**
   - First show what the agent is about to do: target highlight, a label of at most 6 words, avatar gaze, then cursor travel.
   - Inject the real input at the instant the drawn cursor lands.
   - Show the delivery effect (press plus ring, or keycaps).
   - Only then show what changed and the verdict.
   - Sources: agent-desktop Travel/Effect phases; axscope ("input lands when the drawn cursor arrives"); cua ("moves to the resolved target before dispatch").
2. **One clock.**
   - Host events and video frames share one host clock: capture wall-clock µs go into `EncodedVideoChunk.timestamp` and come back as `VideoFrame.timestamp`.
   - Overlays render at the displayed frame's capture time ("video time"), interpolated between frames.
   - They are never more than one frame ahead of the newest decoded frame.
   - So a ripple can never appear before the pixels show the button pressed, and the cursor can never arrive after the page has already changed.
3. **Effects mean "delivered", never "succeeded".**
   - A ripple says the input was injected.
   - Success or failure appears only after `screen.settle` / `step.verify` (agent-desktop R10).
   - In Cua's words, the cursor "is not a security indicator, an authorization prompt, or evidence that a tool call succeeded".
4. **Overlays never reach the agent's eyes.**
   - Everything is composited in the viewer. The VM framebuffer and the model's screenshots stay pristine. Counter-example: cua #4194, where an overlay made OCR read "Submit" as "Suk nit".
   - Start Xvfb with `-nocursor`, or capture with `-draw_mouse 0`.
   - Draw the pointer from authoritative position events: XFixes, or the dispatch coordinates.
5. **Presence without noise.**
   - While the agent holds control, its cursor never blinks out between steps (sim-mirror).
   - While the agent thinks, the cursor rests at its last point, dimmed and gently floating.
   - Decorative motion is short, bounded and interruptible.
6. **Liveness from heartbeats, not timers.**
   - "Working" indicators follow real model and tool activity plus a heartbeat every 1 s.
   - A stall is shown as a stall.
   - A frozen stream is shown as "Reconnecting…".
7. **Attention at decision-critical moments.** Most people won't watch continuously (Liang et al.; Chen et al.). So invest in:
   - A glanceable ambient state: the frame plus the pill.
   - Approvals that are renewable and well timed.
   - An excellent post-hoc trace: Steel-style rows, plus summaries of what changed and what persisted. AgentTrace's trace raised comprehension from 61% to 85%.
8. **Replay equals live.**
   - One renderer: `render(eventLog, videoTime, viewState)`.
   - Paths are seeded and closed-form (matinee, agent-desktop).
   - Springs are evaluated analytically.
   - No `Math.random()` at render time.
9. **Honest speed.** Anything sped up says so, e.g. "Played at 4× · idle skipped". Google labels sped-up demos and links the unedited run.

## 4.2 Architecture and layers

```
guest (Xvfb -nocursor + WM in a container | Lume macOS VM)
  ├─ capture+encode: pixelflux (Annex-B H.264, keyframe_interval_s=1) | ffmpeg x11grab -draw_mouse 0 + x264 -tune zerolatency
  │     └─ each access unit → WS binary msg [flags | captureTimeµs | frameId | payload]
  │        └─ tee → fMP4 recorder (1–2 s GOP, -write_prft wallclock, action chapters)
  ├─ pointer side-channel: XFixes position+shape @60–120 Hz (needed for user takeover and human-input capture)
  └─ input injector (XTEST/xdotool/uinput | RFB for macOS) ← orchestrator dispatches at the scheduled instant
orchestrator → events.jsonl (append-only, host clock) → WS to viewers
viewer worker: WS → VideoDecoder → newest-frame-wins → WebGL2 texture → PixiJS v8 scene (video quad + world overlays), one rAF, OffscreenCanvas
viewer main thread: DOM chrome (sidebar, pill, approval sheets), input forwarding during takeover
```

| # | Layer | Space | Renderer | Contents |
|---|---|---|---|---|
| 0 | Stage | screen | DOM | Backdrop, device frame, **agent-control frame + tint** |
| 1 | Desktop video | world | Pixi/WebGL2 (worker) | Live or recorded frame at video time |
| 2 | Focus dim | world | Pixi | Optional spotlight dimming 25–35% outside the target (focus mode, approvals) |
| 3 | Highlights | world | Pixi | Target brackets/box + role/name chip; changed-region flashes; optional set-of-marks "agent vision" |
| 4 | Effects | world | Pixi | Press ring, drag path, scroll chevrons, "blocked" shake |
| 5 | Cursors | world (constant screen size) | Pixi | Agent cursor(s) + name chip; user pointer during takeover |
| 6 | World-anchored HUD | world anchor, screen size | Pixi text | Intent label card, typing pill, keycap chips (kept in the GPU scene so they stay frame-synced; a worker canvas and the DOM commit independently) |
| 7 | Screen HUD | screen | DOM (React) | Status pill with Take over / Stop, approval sheets, "Jump to live", captions |
| 8 | Companion | screen | own canvas (SVG, Canvas, Rive or VRM) | Avatar, docked outside the stage |

**Coordinates.**
- All geometry is stored in **guest desktop pixels** (top-left origin). A HiDPI `scale` is declared once in `session.start`.
- One affine matrix `M = camera ∘ letterbox ∘ dpr` maps world to device coordinates. Its inverse maps user input back to the guest.
- The orchestrator converts model-screenshot coordinates to desktop pixels *before* emitting events, never in the viewer. Getting this wrong is the bug class behind cua #3542, where the cursor was drawn 280 pt off.

**Implementation stack** (details in §3):

| Concern | Pick | License | Notes |
|---|---|---|---|
| Linux guest | Xvfb `-nocursor` + WM in a container (Docker/OrbStack, or apple/container on macOS 26) | MIT/X11, Apache-2.0 | macOS- or Linux-like theme; XTEST input |
| macOS guest | Lume (trycua/cua) VM | MIT | `_VZVNCServer` is private API; the Apple license allows 2 extra VMs per Mac; frames arrive BGR (Cua patches noVNC) |
| Capture/encode | pixelflux (Selkies 2.0) or ffmpeg x11grab + x264 zerolatency | MPL-2.0 / LGPL-GPL (separate process) | Roughly 25–45 ms glass-to-glass on localhost [estimate] |
| Transport | WebSocket, one access unit per message with a µs header | own | WebTransport later for remote viewers |
| Decode/render | WebCodecs + PixiJS v8 on an OffscreenCanvas worker (WebGPU optional) | MIT | Newest frame wins; `close()` every frame; on backlog, reset and request an IDR |
| Motion | Motion (physics springs), bezier-js, own closed-form path | MIT | Port ideas from matinee, cua-driver, agent-desktop, Screenize |
| Replay | mediabunny + the same Pixi renderer; `<video>` + rVFC fallback | MPL-2.0 | Frame-accurate scrubbing; thumbnails via `CanvasSink` |
| Export | Same renderer → `VideoEncoder` → mediabunny MP4; gif.js; optional HyperFrames | MPL-2.0 / MIT / Apache-2.0 | Avoid Remotion and ffmpeg.wasm |
| Panels | xterm.js, Monaco diff editor | MIT | — |
| Avatar | Code-driven SVG/Canvas by default; Rive / dotLottie / three-vrm skins | MIT runtimes | Rive editing needs a paid editor seat |
| Sound | Web Audio / ZzFX; Howler for samples | MIT | — |

## 4.3 What to build, prioritized, with parameters

### P0: the core loop (this *is* the product)

1. **Agent cursor** (layer 5)
   - **Look**
     - macOS-style arrow, 24 px tall at a constant *screen* size (counter-scaled under camera zoom).
     - Fill: localDot accent, or a per-agent colour from cua's 9-colour palette. Outline: 1.5 px white.
     - Soft 8–10 px "fog" halo (Codex): 18% dark over light content, 18% light over dark. Pick which by sampling the luminance of the texel under the tip once per frame.
     - **Name chip** (avatar glyph + name), 25 px below-right. It shows for 2 s on appear or state change, then fades over 0.4 s to a 6 px dot. Hovering reveals it again (cua pill).
   - **Travel**
     - Path: cubic Bézier with control points on one side at 10% of D (max 60 px). The side is picked by a seeded hash of the step id.
     - Timing: time-warped with minimum-jerk `s = 10τ³ − 15τ⁴ + 6τ⁵`.
     - Duration: `T = clamp(150 + 100·log2(D/W + 1), 220, 700) ms ÷ speed`, where `W = max(16, min(bbox.w, bbox.h))`, or 24 if unknown.
     - The arrow tilts up to 8° along the tangent, in proportion to speed, and returns to 0° at rest.
     - No overshoot in the default "Clean" style. An optional "Human" style adds a 3% overshoot and a corrective submovement starting at 62% of T (agent-desktop constants).
   - **Retarget mid-flight:** re-plan from the current position with velocity continuity, `P1 = p + v·T/3`.
   - **Arrival**
     - 90 ms dwell.
     - Press: scale 0.85 over 80 ms. Switch to a hand shape on clickable roles.
     - **Dispatch at the bottom of the press.** Cua's TrajectoryViewer does the same: the frame swaps at the bottom of the squash.
     - Release: spring back over 150 ms.
   - **While thinking:** dim to 70% and play cua's idle float at half amplitude (x = 2.5·sin, y = 3·cos−2.5 px, ±1.5°, 4 s loop). The name chip shows a "thinking…" shimmer.
   - **Visibility:** never hidden while the agent holds control. Fades out over 180 ms after 60 s idle, on handoff to the user, or on stop.
   - **Speed presets**

     | Preset | Behaviour |
     |---|---|
     | Watch | speed 1.0 |
     | Fast | speed 2.0 |
     | Instant | fade-teleport (150 ms); dispatch gated only 60 ms |
     | Cinematic | speed 0.8 + auto-camera |

2. **Target highlight** (layer 3)
   - **Appears** at `action.intent`, **120 ms before the cursor departs**.
   - **Default "Brackets" style** (Browser Use): four corner brackets, 3 px thick, arm `clamp(8, 0.35·min(w,h), 20)` px. They slide from 10 px outside the element to −3 px over 150 ms, ease-out.
   - **Alternative "Box" style:** rounded rect of the bbox + 4 px, 2 px stroke, 8% fill.
   - **Colour convention:** accent (warm) = *acting on*; teal (Midscene `#028391`) = *looking at*, i.e. candidates or search area.
   - **Morph** to the next target with a spring on x/y/w/h: k 400, c 40, m 1 (ζ 1, ~0.31 s).
   - **Chip:** "`Button · Checkout`" (role · accessible name, truncated at 32 chars), 12 px, fades in over 120 ms. It sits above the target and flips below it near the top edge.
   - **Hold** until 900 ms after dispatch, then fade over 300 ms.
   - **Coordinates only** (no AX/DOM hit): use the Anthropic localization marker instead of a box.
     - 36 px ring, 10% fill, 1.5 px border.
     - Crosshair extending 6 px past the ring.
     - 4 px centre dot.
3. **Press ring** (layer 4)
   - Fires at `action.dispatch` in video time.
   - Animation: scale 0.6→1.0 over 225 ms with `cubic-bezier(.16,1,.3,1)`; opacity 0.7→0 over 300 ms.
   - 44 px, accent colour, ≤ 600 ms in total.
   - Right-click: dashed ring. Double-click: two rings 90 ms apart. Held drag: a "hold" ring that stays while the button is down.
4. **Agent-control frame + status pill** (layers 0 and 7)
   - **Frame**
     - 2 px accent border and a 3% accent tint while the agent holds control.
     - It breathes (opacity 0.45↔0.85, 2.4 s sine) only while thinking, and is steady while acting.
     - On takeover it switches to neutral/green with the text "**You're in control**".
   - **Pill**, top-centre on the frame edge (Edge style): `{avatar} localDot is clicking "Checkout" · Step 7 · 0:42 · [Take over] [■]`.
     - Text changes cross-fade and slide 6 px over 200 ms. "Thinking…" shimmers.
     - The elapsed counter appears after 5 s.
     - If a heartbeat is missed, it shows "Still working…". If the stream stalls, it shows "Reconnecting…".
     - It uses the present progressive while the action runs. On completion the timeline row switches to past tense ("Clicked 'Checkout'"), as dots does.
5. **Step timeline** (sidebar, in the style of Steel Agent Traces)
   - **Plan checklist** on top with a counter ("3/7"). Finished items are struck through.
   - **Rows read as sentences:** icon + verb + target + app/URL + time offset, e.g. "click on **Sign in** · Safari · example.com · +0:42".
   - Typing bursts collapse into one row, and idle gaps get a marker ("⋯ thought for 14 s").
   - **Expanded row:** a 160×100 thumbnail of the settled frame cropped around the target, role/name, coordinates, duration and verdict.
   - **Clicking a row seeks** into replay. Coloured ticks on the scrubber mark each row.
   - Takeover spans and approvals appear as rows too.
   - **Density:** finished steps collapse into their plan item by default, and a "Final answer only" view hides the trace (Kimi Work 3.2.15; MiniMax Work mode).
6. **Typing HUD** (layer 6)
   - **Pill** above the focused field or caret: `⌨ quarterly report▍`. It follows KeyCastr semantics: printable characters append to the current pill, and a new pill starts after 500 ms idle.
   - **Keycap chips** at bottom-centre for modifier combos.
     - At most 5 on screen (Magnitude).
     - They pop in over 200 ms from scale 0.5 and 20 px below, linger 1.5–2 s, then fade over 300 ms.
     - Platform glyphs: `⌘ ⇧ S` on macOS guests, `Ctrl + Shift + S` on Linux.
     - Repeats compress to `↓ ×5`.
   - **Pace honesty.** The pill never shows more characters than `text.progress.count`.

     | Mode | Typing pace |
     |---|---|
     | Watch | 35 ms/char for the first 60 chars, then 6 ms/char with "+214 more" in the pill (xdotool's default 12 ms/char is too fast to read) |
     | Fast | 8 ms/char |
     | Instant | paste |

   - **Secrets**
     - Password role, `type=password`, or a tool-declared secret renders as `••••••`.
     - The plaintext is never logged: `%secret%` placeholders are resolved only at injection (Browserbase).
7. **Take over, pause, stop, and approvals** (§4.8) ship in P0.
8. **Replay basics:** scrubber with ticks, 0.5–4× speed, skip idle, **Jump to live**, and the Kortix follow rule (§4.9).

### P1: premium feel

9. **Auto-camera** (§4.6).
10. **"What changed" flash**
    - After `screen.settle`, outline the changed regions: downscaled diff, 8 px dilation, dropping regions under 0.3% of the screen.
    - Accent at 40%, fading to 0 over 700 ms.
    - The avatar glances at the largest region.
    - If a click produces no visible change within 1.5 s, the row is tagged "No visible change".
11. **Before/after compare** in replay: a wipe, or a Before/After/Both switch (Agent TARS), between the observation frame and the settled frame.
12. **Scroll and drag.**
    - Scroll: 3 chevrons in the scroll direction at the scroll point, fading over 500 ms, plus a wheel glyph on the cursor.
    - Drag: a dashed accent path with an arrowhead, held for 600 ms after release.
13. **Tool panels.**
    - Shell and file tools auto-switch the stage to a Terminal view (xterm.js) or a Diff view (Monaco); the desktop shrinks to a picture-in-picture.
    - **Follow** toggle with the Kortix rule: stepping back pins the view, reaching the latest step follows again.
    - A tool-view registry maps each tool to a view (Suna).
14. **Agent vision:** a picture-in-picture of exactly what the model saw (downscaled screenshot + set-of-marks labels, if used), next to the full-resolution frame. Layout from Anthropic's localization demo.
15. **Avatar sync** (§4.7).
16. **Exports** (§4.9).

### P2: advanced

17. **Multi-agent cursors:** one palette colour and name chip per subagent, plus per-agent timeline lanes (agent-desktop multi-agent; cua palette). For swarms, follow Kimi Agent Swarm:
    - staged "recruiting" copy;
    - per-agent status chips (waiting, running, done, stopped);
    - a per-agent toggle between the computer view and the activity trail.
18. **Sound pack** (§4.10).
19. **Catch-up playback:** after scrubbing, play at 2× until live, then ease back to 1×.
20. **Provenance and persistence**
    - Each step links to the plan item and the thought that caused it.
    - At session end, a "persistent changes" summary: files written, apps installed, settings and accounts touched (AgentTrace).
21. **Intent-preview countdown** for medium-risk steps: the target pulses and the cursor hovers for 1.5 s with a "Doing this in 1.5 s · [Stop]" chip.

## 4.4 Event schema (v1)

One canonical append-only JSONL log per session. It is the single source for the live view, replay, export, the timeline and the avatar. It borrows from:
- Agent TARS / Tarko's `AgentEventStream` (flat typed events; screenshots arrive as `environment_input`);
- the OpenAI and Anthropic computer-use action spaces;
- agent-desktop's `CursorOverlayInstruction` (`destination`, `drag_from`, `label`, `click`, `target`, `phase`);
- cua's semantic states;
- sim-mirror heartbeats;
- Steel trace rows.

```ts
// ---------- envelope ----------
type Micros = number;                // host wall-clock µs (same clock as VideoFrame.timestamp / fMP4 PRFT)
interface Ev<T extends string, D> {
  v: 1;
  id: string;                        // ULID
  seq: number;                       // strictly increasing per session
  t: Micros;                         // when it happened on the host; for action.dispatch = the injection instant
  agent: string;                     // "main" | subagent id  -> cursor colour / lane
  step?: string;                     // step ULID shared by all events of one step
  type: T;
  data: D;
}
type Point = { x: number; y: number };                 // guest desktop px, top-left origin
type Rect  = { x: number; y: number; w: number; h: number };

interface Target {
  point: Point;                      // exact coordinate that receives input
  bbox?: Rect;                       // element bounds (AX/DOM hit-test at point, or SoM box)
  source: "ax" | "dom" | "som" | "ocr" | "vision" | "coords";
  role?: string;                     // "button" | "textbox" | "link" | "menuitem" ...
  name?: string;                     // accessible name / visible label (truncate 64)
  app?: string; window?: string; url?: string;
  mark?: number;                     // set-of-marks id the model saw, if any
  secret?: boolean;                  // password field etc. -> mask everything typed here
}

type Input =
  | { kind: "click"; button: "left" | "right" | "middle"; count: 1 | 2 | 3; mods?: string[]; at: Point }
  | { kind: "move"; to: Point }
  | { kind: "drag"; from: Point; to: Point; path?: Point[] }
  | { kind: "scroll"; at: Point; dx: number; dy: number }
  | { kind: "type"; chars: number; masked: boolean }   // text itself only in text.progress (masked if secret)
  | { kind: "key"; combo: string[] }                    // ["Meta","Shift","S"]
  | { kind: "wait"; ms: number };

// ---------- session & stream ----------
type SessionStart = Ev<"session.start", { screen: { w: number; h: number; scale: number }; os: "linux" | "macos";
                                          clock: "host-wallclock-us"; video: { codec: string; track: string } }>;
type VideoSegment = Ev<"video.segment", { uri: string; t0: Micros; t1: Micros; gopMs: number }>;
type StreamHealth = Ev<"stream.health", { fps: number; e2eLatencyMs: number; dropped: number }>;

// ---------- cognition ----------
type AgentState = Ev<"agent.state", { state: "idle" | "thinking" | "acting" | "observing" | "waiting_user" | "paused" | "blocked" | "done"; reason?: string }>;
type Heartbeat  = Ev<"heartbeat", { ongoing: boolean; everyMs: 1000 }>;
type Thought    = Ev<"thought.delta", { text: string }>;              // public reasoning summary (streamed)
type PlanSet    = Ev<"plan.set", { items: { id: string; text: string; status: "todo" | "doing" | "done" | "skipped" }[] }>;
type PlanUpdate = Ev<"plan.update", { id: string; status: "todo" | "doing" | "done" | "skipped" }>;

// ---------- step lifecycle ----------
type StepStart = Ev<"step.start", { kind: "gui" | "shell" | "file" | "browser" | "ask" | "think"; planItem?: string; causeThought?: string }>;
type StepEnd   = Ev<"step.end", { status: "ok" | "failed" | "blocked" | "cancelled"; note?: string }>;

// ---------- GUI action pipeline ----------
type Intent = Ev<"action.intent", {
  verb: "click" | "move" | "drag" | "scroll" | "type" | "key" | "navigate" | "open_app" | "wait";
  label: string;                                // <= 6 words, model-authored; never derived from typed values
  target?: Target;
  risk: "none" | "low" | "medium" | "high";
  cameraIntent?: "typing-text" | "typing-code" | "typing-terminal" | "click" | "drag" | "scroll" | "read" | "navigate" | "switch";
  pointer?: { from: Point; to: Point; startsAt: Micros; durationMs: number; seed: number;
              curve: "bezier-minjerk-v1"; style: "clean" | "human" };   // makes travel deterministic
}>;
type Cancel   = Ev<"action.cancel", { reason: "preflight" | "policy" | "user" | "model" | "timeout"; detail?: string }>;
type Dispatch = Ev<"action.dispatch", { input: Input }>;                  // t = injection instant
type Result   = Ev<"action.result", { ok: boolean; error?: string }>;     // driver ack = delivered?
type TextProg = Ev<"text.progress", { chunk?: string; count: number; masked: boolean; caret?: Rect }>;
type Settle   = Ev<"screen.settle", { frameT: Micros; changed: Rect[]; diff: number; noVisibleChange: boolean }>;
type Observe  = Ev<"observe", { image: string; modelScale: number; marks?: { id: number; bbox: Rect; role?: string }[] }>;
type Verify   = Ev<"step.verify", { status: "success" | "unexpected" | "failed"; evidence?: string }>;

// ---------- non-GUI tools ----------
type ToolStart  = Ev<"tool.start", { tool: "shell" | "file.write" | "file.edit" | "browser.nav" | string; title: string; args?: unknown }>;
type ToolOutput = Ev<"tool.output", { stream: "stdout" | "stderr"; chunk: string }>;
type ToolEnd    = Ev<"tool.end", { exitCode?: number; ok: boolean }>;
type FileChange = Ev<"file.change", { path: string; op: "create" | "modify" | "delete"; patch?: string }>;

// ---------- safety, control, handoff ----------
type ApprovalReq = Ev<"approval.request", {
  kind: "purchase" | "send" | "post" | "delete" | "download" | "install" | "settings" | "permission" | "off_task" | "other";
  title: string;                                  // "Place order for $51.25?"
  preview?: { fields: [string, string][]; image?: string };
  target?: Target; risk: "medium" | "high";
  scopeOptions: ("once" | "session")[];           // "session" never offered for high risk
}>;
type ApprovalRes = Ev<"approval.resolve", { decision: "approve_once" | "approve_session" | "deny" | "take_over"; by: "user" | "timeout"; note?: string }>;
type ControlReq  = Ev<"control.request", { reason: "login" | "2fa" | "captcha" | "payment_entry" | "ambiguous" | "stuck"; message: string; autoSkipAfterMs?: number }>;
type Control     = Ev<"control.change", { holder: "agent" | "user_pending" | "user"; reason: "user_takeover" | "agent_request" | "resume" | "stop" }>;
type SafetyPause = Ev<"safety.pause", { detector: "injection" | "off_task" | "sensitive_site"; message: string; resolution?: "kept_paused" | "marked_safe" }>;
type Pause       = Ev<"pause.change", { paused: boolean; atStepBoundary: boolean }>;
type HumanInput  = Ev<"human.input", { input: Input }>;   // optional: user takeover input in agent vocabulary (Bytebot-style); only if user opted in

// ---------- optional presentation hints ----------
type CameraHint = Ev<"camera.hint", { focus: Rect; zoom?: number; reason: "typing" | "small-target" | "approval" }>;
```

**Canonical GUI step.** Timings are enforced by the backend.

```
step.start
action.intent            t0     label, target, risk, pointer{ startsAt = t0 + 120 ms, durationMs = T }
  [approval.request → approval.resolve]     only if risk ≥ policy threshold: cursor holds at target, sheet opens
action.dispatch          t0 + 120 ms + T + 90 ms (dwell) + 80 ms (press)      = injection instant
action.result            +2–30 ms                     driver ack
text.progress*           per injected chunk           typing only
screen.settle            frame diff < ε for 250 ms (cap 3 s)
observe                  next screenshot for the model
step.verify              optional outcome check
step.end
```

- **The backend owns timing.** It computes `durationMs` with the same shared formula the UI uses, and sleeps until the scheduled dispatch. There is no renderer-ack round trip (unlike agent-desktop's 900 ms ack timeout). This works with zero, one or many viewers, and in headless runs.
- **Viewers draw travel from `pointer.startsAt` in video time.** The drawn cursor therefore lands exactly on the frame where the click takes effect.
- **Streaming trick.** Emit `action.intent` as soon as the coordinate arguments have been parsed from the model's streamed tool call, even while other arguments (e.g. text to type) are still streaming. This hides most travel time inside model latency. If the call later turns out invalid, emit `action.cancel`.
- **Batches** (e.g. filling 5 fields) play sequentially, each gated by its own travel. Fast mode halves travel. Instant mode fade-teleports.
- **Coordinate-only models.** Hit-test the accessibility tree (AT-SPI on Linux, AX on macOS) or the DOM (CDP `DOM.getNodeForLocation`) at `point` to fill in `bbox`, `role` and `name`. If nothing is found, set `source: "coords"` and show the reticle.

**Mapping from other schemas**

| Source | localDot equivalent |
|---|---|
| Tarko `tool_call` / `tool_result` | `action.intent` + `action.dispatch` / `action.result` (GUI tools), or `tool.*` |
| Tarko `environment_input` (screenshot) | `observe` |
| Tarko `plan_*` | `plan.*` |
| Tarko `assistant_thinking_message` | `thought.delta` |
| Anthropic `left_click` / `type` / `key` / `scroll` / `left_click_drag` / `mouse_move` / `wait` | `Input` kinds |
| OpenAI `click` / `double_click` / `scroll` / `type` / `keypress` / `drag` / `move` / `wait` | `Input` kinds (`double_click` → `click` with `count: 2`) |
| Gemini computer-use per-action "intent" text | `action.intent.label` |
| Gemini 0–999 normalized coordinates | convert to px in the orchestrator |

## 4.5 Timing rules (so animation never lies and never lags)

| Rule | Value | Why |
|---|---|---|
| Overlay clock | Render at the capture time of the displayed frame (`VideoFrame.timestamp`; `<video>` rVFC `mediaTime` in replay). Interpolate between frames with `performance.now()` deltas, **never more than 1 frame ahead of the newest decoded frame** | Overlay and pixels always agree |
| Intent lead | Highlight + label + avatar gaze + camera start at `t0`; the cursor departs at `t0 + 120 ms` | Anticipation: eyes lead the hand |
| Travel | `clamp(150 + 100·log2(D/W + 1), 220, 700) ms ÷ speed` | Fitts-shaped; watchable, but not a "blocking tutorial" (agent-desktop R7) |
| Dwell + press | 90 ms dwell, then 80 ms press; dispatch at the bottom of the press | Human-like; the click reads clearly |
| Max blocking presentation per action | Watch 800 ms · Fast 350 ms · Instant 60 ms | Presentation never meaningfully slows the agent |
| Effect | Starts at `action.dispatch.t` in video time; ≤ 600 ms | Effect means delivered |
| Outcome marks | Only after `screen.settle` / `step.verify` | A ripple is not success |
| Typing reveal | Per injected chunk; never ahead of `text.progress.count` | The HUD can't claim text that hasn't been typed yet |
| Settle | Frame diff < ε for 250 ms (cap 3 s). The pill says "Waiting for the page" after 600 ms | Honest waiting state |
| Heartbeat | Every 1 s while the model or a tool is active; "stalled" after 1.5 missed beats | Liveness is real (sim-mirror uses 10 s beats; localhost can afford 1 s) |
| Cursor rest / hide | Dim + float after 1.2 s idle; hide after 60 s or on a control change | Presence without noise |
| Stream stall | > 500 ms without frames: freeze overlays and show "Reconnecting…" | Never animate over a dead picture |
| Label | ≤ 6 words (cap 12); cross-fade 200 ms on change; hold ≥ 1 s | Readable |
| Cancel | `action.cancel` → cursor stops, 2× 5 px shake over 180 ms, red outline flash, reason chip | Blocked actions are shown honestly |

**Smoothness mechanics**
- **Never use CSS transitions for anything the backend waits on.**
  - Sample the cursor from the closed-form path `p(t)` every rAF.
  - axscope's bug: a 260 ms CSS transition with a ripple fired on frame 0.
  - Magnitude's workaround: a hand-coded 300 ms wait.
- **Retarget with physics springs** (Motion stiffness/damping/mass). Motion's time-defined (`visualDuration`/`bounce`) springs *drop inherited velocity*, which produces a visible kink.
- **Camera springs and bbox morphs are evaluated analytically** at time `t` since their last retarget, carrying velocity across the retarget. Replays and exports are then frame-identical.

## 4.6 Camera and auto-zoom

- **Zoom levels by intent** (after Screenize, Apache-2.0; the intent comes from `action.intent.cameraIntent`, known *before* acting):

  | Intent | Zoom |
  |---|---|
  | typing in a text field | 2.0× |
  | typing code | 1.8× |
  | terminal | 1.6× |
  | click on a small target (< 2% of screen area) | 1.6–2.0× |
  | drag | 1.3× |
  | scroll | 1.2× |
  | read / observe | 1.0× |
  | navigate / switch app / approval | fit (1.0×) |

  Max zoom is 1.8× live and 2.5× in replay or export.
- **Springs** (critically damped or overdamped; motion-sickness safe):
  - pan: k≈322, c≈32, m 1 (ζ 0.9, 0.35 s);
  - zoom: k≈130, c≈21 (ζ 0.9, 0.55 s).
  - Camera motion starts at `action.intent`, so it naturally leads the cursor.
- **Dead zone**
  - Safe zone: 75% of the viewport (60% while typing).
  - Hysteresis: ±15%.
  - Partial correction: 0.45 (0.8 while typing).
  - Cluster actions into boxes no larger than 50% × 70% of the viewport (Cap). Edge-snap ratio 0.25, so targets near screen edges frame flush.
- **Rules**
  - **Pre-aim:** while at 1×, move the centre instantly before zooming in (Cap).
  - Never pan while zooming out; hold the last centre.
  - Chain pans between regions ≤ 1.5 s apart instead of yo-yoing out and back in (OpenScreen).
  - Merge actions < 2.5 s apart. Hold 2.5 s after the last action before zooming out (Cap: `MERGE_GAP_MS` 2500, post-padding 2500).
  - Zoom to fit on navigation or app switch, after 3 s idle, when thinking runs past 4 s, and before any approval sheet (show full context).
- **Modes**
  - **Live "Follow"**: on by default in Watch mode, capped at 1.8×, and only for typing, small targets and dense clusters.
  - **Fast mode:** off.
  - **Replay/Export "Cinematic":** offline planning over the whole log, with 400 ms look-ahead, idle compression (quiet gaps > 1.5 s play at 8× with a "⏩ thought for 12 s" badge), and optional motion blur (export only).
- **User override:** any manual pinch, scroll-zoom or drag disables auto-camera until the user presses **Recenter**.
- **Reduced motion:** no automatic camera movement. Use 150 ms dissolve cuts between fit and crop, max 1.25×. The cursor fade-teleports and nothing breathes.

## 4.7 Avatar companion sync

- **Rendering**
  - The default avatar is **code-driven**: an SVG/Canvas face with eyes, pupils, brows and mouth, animated with Motion springs. It is MIT and editable by every contributor.
  - Optional skins:
    - **Rive:** `@rive-app/webgl2`, Data Binding view model with `state` enum, `gazeX`/`gazeY`, and triggers. Editing needs a paid editor seat.
    - **dotLottie** state machines.
    - **three-vrm** `VRMLookAt` + expressions.
    - **A Pets-style sprite atlas.**
  - Dock the avatar outside the stage, or in a corner with auto-dodge when the target comes within 120 px. **It never covers the action.**
- **States** (a superset of OpenAI Pets): `idle · thinking · acting · typing · observing · waiting_user (needs input) · blocked (error/cancel/stall) · done (ready) · paused · talking (TTS)`.
  - With several agents, the badge priority is needs-input > blocked > ready > running (Pets).
- **Attention point** (recomputed per frame; the gaze target):
  1. approval sheet or question (look at the user or the sheet);
  2. the user's pointer during takeover;
  3. the current `action.intent` target;
  4. the agent cursor while it travels (smooth pursuit);
  5. the largest changed region right after `screen.settle` (a 400–700 ms glance);
  6. the chat input while `waiting_user`;
  7. otherwise, idle wander or looking at the user.
- **Gaze physiology** (from E2)
  - **Saccade** 40–80 ms to the target at `action.intent`. The hand (cursor) leaves 120 ms later and travels T, so gaze leads the hand's arrival by ~0.35–0.8 s. Natural tasks show a ~0.56 s lead (Land, Mennie & Rusted 1999).
  - **Pursuit:** a spring with ~0.1 s response while the cursor travels.
  - **Head** joins when the target is beyond ±18° of eye range, with gain 0.77.
  - **Blinks:** interval uniform 1–7 s, 15% doubles, 100/50/150 ms phases (close/closed/open). Blink on gaze shifts > 1/3 of the screen (gaze-evoked blinks), which also masks app-switch cuts.
  - **Breathing:** incommensurate sines at 3.2 / 5.5 / 6.5 s.
  - **Typing:** eyes on the caret, blinks drop to about 5/min.
- **Reactions** come only from semantic events:
  - `step.verify: success`: a small nod, at most 1 per 5 s.
  - `action.cancel` / `blocked`: calm concern and a head tilt, then a look at the reason chip.
  - `approval.request`: face the user and point to the sheet.
  - `done`: a 1 s celebratory beat.
  - Never react to raw input spam.
- **Controls:** a "Companion: on/off" setting, and reduced motion (gaze only, no body motion or idle loops).
  - Keep the avatar non-deceptive: it must never pretend to be a human.
  - Doubao/Qwen reportedly removed "personified agent" features when China's AI anthropomorphism measures took effect (2026-07-15) [single secondary source]. That is another reason to keep it optional.

## 4.8 Handoff, pause, stop and confirmations

- **Control states:** `agent → user_pending → user → agent` (Magentic, dots).
  - **Take over** (button in the pill, hotkey ⌥⌘T):
    1. The UI shows "Waiting for localDot to stop…" (it finishes the current atomic input: the keystroke chunk or the click).
    2. Then: "**You're in control.** localDot is paused and isn't watching."
  - The viewer flips the stream to interactive without reconnecting (Kernel `KERNEL_SET_READ_ONLY`; Magentic sets `rfb.viewOnly` directly).
  - The agent cursor fades out, the user's pointer shows normally, and the frame turns neutral/green.
  - **Return control** opens an optional note, "Tell localDot what you did". The agent then receives the note, a before/after diff of the takeover span and a fresh observation.
  - Optional, and only when the user opts in: human input converted into the agent's action vocabulary (Bytebot) as `human.input` events.
  - The timeline records "You took over · 1 m 12 s".
  - **Say plainly what is recorded:** the screen recording continues for the user's own replay (and can be paused), but none of it is sent to the model.
- **Agent-requested takeover** (`control.request`) for login, 2FA, CAPTCHA, payment entry, ambiguity, or being stuck:
  - An amber "Needs you" state (like AutoGLM's `need_takeover` `#FA920A`).
  - Signals: an OS notification, the attention sound, and a `●` badge on the tab title.
  - Buttons: **Take over** · **Skip this step** · **Stop**.
  - Auto-skip after a timeout (Replit 10 min; AutoGLM 200 s) only for optional steps, never for security-sensitive ones.
  - The agent never types credentials.
  - **Reason-coded card** (Genspark): "localDot needs you to sign in on this page" / "…to solve a CAPTCHA only a person can solve" / "…to enter a one-time code" / "…to complete a payment step".
  - **Anti-phishing guard** (Genspark): if the request was triggered by page content rather than the user's own instruction, warn: "This request came from something localDot read, not from you. Check the address bar before you sign in."
  - While the user types: "**Keyboard captured** — what you type goes to localDot's computer."
- **Pause:** shows "Pausing after this step…", then "Paused" at a step boundary.
- **Stop:** immediate, with an honest summary ("3 actions were already performed; nothing was purchased").
- **Loop guard** (Manus): if the same action repeats 3 or more times with no visible change, pause and ask "localDot may be stuck in a loop. Keep going?"
- **Approvals** (risk-gated, renewable; a sheet anchored to the target)
  - The cursor travels to the button and **holds** with a pulsing "held" ring (1.2 s period). The focus dim spotlights the target.
  - The sheet slides up from the stage bottom.
  - A **Why?** link expands the rationale and the plan step the action serves. Precedents: Manus's "Let Manus explain"; MiniMax shows an LLM rationale on every permission card.
  - Wording templates:
    - **Purchase:** "Place this order?" · items · **Total $51.25** · card ending 6411 · delivery date → **Approve once** / **Deny** / **Take over**
    - **Send:** "Send this email to 3 people?" · To / Subject / first lines of the body
    - **Delete:** "Permanently delete 12 files in ~/Downloads?"
    - **Off-task** (Edge template): "This page might not be relevant to your task. Continue?"
    - **Injection pause** (Operator template): "Paused: this page contains instructions that seem aimed at localDot. Review before continuing." → **Keep paused** / **Mark safe and resume**
  - **Scopes**
    - Per app, as Anthropic tiers access: view-only · click-only · full.
    - Per site: **Allow once** · **Always allow on this site** · **Decline**.
    - **Never "approve similar" for high-risk kinds.** Chen et al.: persisting approvals were a failure mode.
  - **Policy defaults**
    - **Approve first:** purchases, send/post, delete, downloading or running executables, system settings, granting permissions.
    - **Take over:** logins, 2FA, CAPTCHAs, payment fields.
    - **Silent:** read-only browsing and scrolling.
    - Follow Brave's anti-fatigue principle: prompt only when it matters.

## 4.9 Recording, replay and export

- **Per-session storage**
  - `events.jsonl`: secrets masked at the source.
  - `video/*.mp4`: fragmented, H.264, 1–2 s GOP, `-write_prft wallclock`, action chapters.
  - `observations/*.webp`: exact model inputs.
  - `thumbs/`: settled-frame crops.
  - `index.json`: step → time ranges.
- **Replay UI**
  - Scrubber with colour-coded ticks (click / type / approval / takeover / error) and step chapters.
  - Speeds 0.5–8×. **Skip idle** is on by default and labelled. Step ←/→, J/K/L and Space. A **Jump to live** pill.
  - **Follow rule** (Kortix): stepping back pins; reaching the end resumes live.
  - One global time cursor (Devin): the timeline, terminal, diff and plan all render "as of t", with future items greyed.
  - Replay pacing uses real timestamps with gap compression, not a fixed ms per event (improves on Tarko).
  - **Shared replays** autoplay after a 3 s countdown and offer **Skip to results** / **Watch again** (Manus; Tarko `?replay=1`). Unlike Manus and Kimi, also offer a speed control.
- **Exports**
  1. **MP4 highlight reel**
     - Rendered offline by the same renderer, frame by frame: cinematic camera, cursor, lower-third captions from step labels, idle compression, intro/outro cards.
     - `VideoEncoder` → mediabunny, following OpenScreen's exporter.
     - Burn in "sped up ×N" labels.
  2. **GIF** (Claude-in-Chrome style): keyframes, click circles, drag arrows, action labels, progress bar.
  3. **Single-file HTML replay** (Tarko): embedded events + video, with `?replay=1` autoplay.
  4. **Markdown trace** (Steel), written for another agent or a human to audit.
- **Redaction before sharing**
  - Blur regions tagged `secret`.
  - Optional auto-blur of emails, phone numbers and card numbers.
  - Recording pauses during sensitive steps (Anchor pattern).
  - A review step before any export.

## 4.10 Sound (optional)

- **Default "Attention only":**
  - a soft two-note chime when an approval or takeover is needed;
  - a warm resolve on done;
  - a muted low thud on error.
- **Opt-in "Full" pack:**
  - a soft tick on click dispatch at about −24 dBFS (a 880 Hz sine grain, 65 ms, ±5% pitch jitter);
  - typing ticks at −12 dB relative, one per 2–3 keys;
  - a very soft whoosh on navigation.
- **Rules**
  - Per-sound cooldown of 80–120 ms and at most 3 voices.
  - Duck 8–12 dB during avatar TTS.
  - Warm and soft: no sharp transients.
  - Only attention cues play while the tab is hidden.
  - Precedent: Manus plays one sound when a task finishes while you're away, and only once browser notifications are on.
  - Persisted mute plus a volume slider.
  - Create the AudioContext only after a user gesture, and resume it then.
  - Set `navigator.audioSession.type = "ambient"` where supported.
  - Implement with raw Web Audio or ZzFX; use Howler only for sample packs.

## 4.11 Performance budget and smoothness

- **Budget:** 60 fps target (120 on ProMotion). All per-frame work under ~10 ms; overlay + video composite under 4 ms on an M1-class laptop.
- **One worker owns** the WebSocket, `VideoDecoder`, and the Pixi/WebGL2 render on the OffscreenCanvas.
  - Newest frame wins. Call `close()` right after `texImage2D`.
  - If `decodeQueueSize > 3`, reset the decoder, request an IDR, and skip frames until the next keyframe.
- **The main thread** handles only DOM chrome and input.
  - React state for the HUD updates at ≤ 10 Hz.
  - Per-frame values go through refs or the worker.
  - No layout reads in loops; cache sizes with ResizeObserver (`devicePixelContentBoxSize`, falling back to `contentRect × dpr` on Safari).
- **Keep the page light:** thumbnails decode off-thread, the timeline list is virtualized, and diffs are computed in the backend.
- **Measure** in dev builds:
  - rAF deltas;
  - rVFC `presentedFrames` gaps;
  - Long Animation Frames (`PerformanceObserver` with `long-animation-frame`);
  - glass-to-glass latency (`Date.now()*1000 − frame.timestamp`, which works because host and viewer share a clock on localhost).

## 4.12 Verification ("pixel oracle" tests; cf. cua #2879)

- **Cursor accuracy:** for every `action.dispatch` in a recorded session, render the composited frame at `t`. Assert the drawn cursor hotspot is within 2 px (screen) of the mapped dispatch point at 1×, at 2× zoom, and on HiDPI.
- **Ordering:**
  - No ripple frame comes before the dispatch frame.
  - The typing HUD never shows more characters than `text.progress.count`.
  - No success mark appears before `screen.settle`.
- **Clean observations:** observation images contain no overlay pixels. This holds by construction; guard it against future in-VM overlays.
- **Determinism:** rendering the same log twice yields identical frames, in live and in export.

## 4.13 Localhost security baseline (lessons from Tarko's 2026 fixes)

- Validate the `Host` header against an allowlist to block DNS rebinding.
- Require a token whenever the server binds beyond loopback, and put CSRF tokens on mutations.
- Stream and VNC endpoints are authenticated even on localhost. Steel's debug URLs are unauthenticated: a counter-example.
- Preview iframes never combine `allow-scripts` with `allow-same-origin`.

## 4.14 Build order

- **M1 (P0):**
  - Streaming path: capture → WebCodecs → Pixi worker.
  - Event log, and orchestrator timing that gates dispatch on travel.
  - Cursor, highlight, press ring, frame + pill, timeline, typing HUD.
  - Takeover and approvals; basic replay.
- **M2 (P1):**
  - Intent camera, "what changed" and before/after.
  - Tool panels and agent vision.
  - Avatar v1 (code-driven).
  - Exports: MP4 / GIF / HTML / markdown.
- **M3 (P2):**
  - Multi-agent cursors, sound pack.
  - Provenance and persistence summary, intent-preview countdown.
  - macOS guest via Lume.

# 5. Source index (644 unique URLs, grouped by domain)

*Generated automatically from every URL cited above.*

- **aerotwist.com** (1): https://aerotwist.com/blog/flip-your-animations/
- **agent.minimax.io** (6): https://agent.minimax.io/docs/changelog · https://agent.minimax.io/docs/code/desktop/browser · https://agent.minimax.io/docs/code/desktop/infinite-canvas · https://agent.minimax.io/docs/code/welcome · https://agent.minimax.io/docs/code/workflows/modes · https://agent.minimax.io/docs/code/workflows/permissions
- **ai.google.dev** (1): https://ai.google.dev/gemini-api/docs/computer-use
- **aiagentindex.mit.edu** (3): https://aiagentindex.mit.edu/2025/chatgpt-agent · https://aiagentindex.mit.edu/2025/comet · https://aiagentindex.mit.edu/2025/opera-neon
- **aiblewmymind.substack.com** (1): https://aiblewmymind.substack.com/p/i-tested-chatgpt-agent-on-real-work
- **alokbishoyi.com** (1): https://alokbishoyi.com/blogposts/reverse-engineering-browser-automation.html
- **androidpolice.com** (1): https://www.androidpolice.com/pixel-gemini-controls-apps/
- **anthropic.com** (2): https://www.anthropic.com/news/3-5-models-and-computer-use · https://www.anthropic.com/news/developing-computer-use
- **antigravity.google** (1): https://antigravity.google/docs/ide/browser-recordings/
- **api.manus.im** (1): https://api.manus.im/api/chat/getSessionV2?sessionId=j7BUZNaC7vxEpqBU5GYQOR&type=shared&getFirstSegment=true
- **apple.com** (1): https://www.apple.com/legal/sla/docs/macOSTahoe.pdf
- **arxiv.org** (7): https://arxiv.org/abs/2310.11441 · https://arxiv.org/abs/2507.22358 · https://arxiv.org/abs/2508.14040 · https://arxiv.org/abs/2510.04452 · https://arxiv.org/abs/2604.04918 · https://arxiv.org/html/2411.00820v1 · https://arxiv.org/html/2603.28551
- **autoclaw.zhipuai.cn** (1): https://autoclaw.zhipuai.cn/
- **autoglm.zhipuai.cn** (4): https://autoglm.zhipuai.cn/ · https://autoglm.zhipuai.cn/assets/index-B5g-Ih_A.js · https://autoglm.zhipuai.cn/locales/en/common.json · https://autoglm.zhipuai.cn/locales/zh/common.json
- **aws.amazon.com** (1): https://aws.amazon.com/nova/act/
- **ben.land** (1): https://ben.land/post/2021/04/25/windmouse-human-mouse-movement/
- **blog.google** (8): https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/ · https://blog.google/products-and-platforms/products/chrome/gemini-in-chrome-android-auto-browse/ · https://blog.google/products/chrome/chrome-reimagined-with-ai/ · https://blog.google/products/gemini/gemini-3-gemini-app/ · https://blog.google/security/architecting-security-for-agentic/ · https://blog.google/technology/ai/io-2025-keynote/ · https://blog.google/technology/google-deepmind/gemini-computer-use-model/ · https://blog.google/technology/google-deepmind/google-gemini-ai-update-december-2024/
- **blog.replit.com** (1): https://blog.replit.com/introducing-agent-3-our-most-autonomous-agent-yet
- **blogs.opera.com** (8): https://blogs.opera.com/news/2025/03/opera-browser-operator-ai-agentics/ · https://blogs.opera.com/news/2025/04/opera-browser-operator-first-live-demo/ · https://blogs.opera.com/news/2025/07/this-is-what-you-can-do-with-opera-neon/ · https://blogs.opera.com/news/2025/09/opera-neon-agentic-ai-browser-release/ · https://blogs.opera.com/news/2025/12/opera-neon-becomes-available-in-public-early-access/ · https://blogs.opera.com/news/2026/02/opera-neon-ai-browser-intelligent-mode/ · https://blogs.opera.com/news/2026/08/your-ai-agents-can-use-opera-neon-free-of-charge/ · https://blogs.opera.com/security/2025/10/opera-neon-understanding-agentic-browser-security/
- **blogs.windows.com** (9): https://blogs.windows.com/msedgedev/2025/07/28/introducing-copilot-mode-in-edge-a-new-way-to-browse-the-web/ · https://blogs.windows.com/msedgedev/2025/10/23/considerations-for-safe-agentic-browsing/ · https://blogs.windows.com/msedgedev/2025/10/23/meet-copilot-mode-in-edge-your-ai-browser/ · https://blogs.windows.com/msedgedev/2025/11/18/edge-for-business-presents-the-worlds-first-secure-enterprise-ai-browser/ · https://blogs.windows.com/msedgedev/2026/05/13/new-updates-to-edge-across-desktop-and-mobile/ · https://blogs.windows.com/msedgedev/2026/05/20/new-in-edge-for-business-ai-for-work-safe-from-day-one/ · https://blogs.windows.com/windows-insider/2025/11/17/copilot-on-windows-copilot-actions-begins-rolling-out-to-windows-insiders/ · https://blogs.windows.com/windowsexperience/2025/10/16/securing-ai-agents-on-windows/ · https://blogs.windows.com/windowsexperience/2025/11/18/ignite-2025-windows-at-the-frontier-of-work/
- **bloomberg.com** (1): https://www.bloomberg.com/news/articles/2026-09-28/manus-expands-ai-tools-in-renewed-push-into-agent-market
- **brave.com** (3): https://brave.com/blog/ai-browsing/ · https://brave.com/blog/comet-prompt-injection/ · https://brave.com/blog/prompt-injection-flaw-opera-neon/
- **browserbase.com** (4): https://www.browserbase.com/blog/evaluating-browser-agents · https://www.browserbase.com/blog/introducing-browserbase-agents · https://www.browserbase.com/blog/introducing-director · https://www.browserbase.com/changelog
- **caniuse.com** (1): https://caniuse.com/webtransport
- **cdn.hailuo.ai** (1): https://cdn.hailuo.ai/mavis-chat/prod-web-va-0.1.196/_next/static/chunks/88822-2a89dcbe759b6ce5.js
- **cdn.kimi.com** (1): https://cdn.kimi.com/kimi-computer-use/latest/kimi-cu-plugin.zip
- **chrischinchilla.com** (1): https://chrischinchilla.com/blog/2026/opera-neon/
- **claude.com** (10): https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude · https://claude.com/blog/claude-for-chrome · https://claude.com/blog/claude-in-chrome-generally-available · https://claude.com/blog/cowork-built-in-browser · https://claude.com/blog/cowork-chrome-side-panel · https://claude.com/blog/cowork-is-now-claude · https://claude.com/blog/cowork-web-mobile · https://claude.com/blog/dispatch-and-computer-use · https://claude.com/claude-in-chrome · https://claude.com/product/cowork
- **cnbc.com** (1): https://www.cnbc.com/2025/12/30/meta-acquires-singapore-ai-agent-firm-manus-china-butterfly-effect-monicai.html
- **code.claude.com** (3): https://code.claude.com/docs/en/chrome · https://code.claude.com/docs/en/computer-use · https://code.claude.com/docs/en/desktop
- **codenote.net** (1): https://codenote.net/en/posts/computer-use-agents-macos-windows-selection-notes-2026/
- **codersera.com** (1): https://codersera.com/blog/manus-ai-2026-status-meta-block-desktop-app/
- **cursor.com** (2): https://cursor.com/docs/agent/tools/browser · https://cursor.com/docs/cloud-agent/self-hosted/computer-use
- **datacamp.com** (2): https://www.datacamp.com/tutorial/chatgpt-agent · https://www.datacamp.com/tutorial/claude-for-chrome-ai-powered-browser-assistance-automation
- **dev.classmethod.jp** (1): https://dev.classmethod.jp/en/articles/amazon-nova-act-ga-browser-automation/
- **dev.to** (1): https://dev.to/fabianfrankwerner/an-honest-review-of-google-antigravity-4g6f
- **developer.apple.com** (2): https://developer.apple.com/design/human-interface-guidelines/accessibility · https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/showscursor
- **developer.chrome.com** (3): https://developer.chrome.com/blog/autoplay · https://developer.chrome.com/docs/css-ui/css-linear-easing-function · https://developer.chrome.com/docs/web-platform/best-practices/webcodecs
- **developer.mozilla.org** (12): https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/importExternalTexture · https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/getVideoPlaybackQuality · https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback · https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API/Transcoding_assets_for_MSE · https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing · https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure · https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/texImage2D · https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport · https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices · https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion · https://developer.mozilla.org/en-US/docs/Web/CSS/easing-function/linear · https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/stroke-dashoffset
- **diabrowser.com** (2): https://www.diabrowser.com/changelog · https://www.diabrowser.com/release-notes/1-49-0-microsoft-tools
- **director.ai** (1): https://www.director.ai/
- **dl.acm.org** (1): https://dl.acm.org/doi/10.1145/3742413.3789132
- **docs.airtop.ai** (2): https://docs.airtop.ai/guides/how-to/creating-a-live-view · https://docs.airtop.ai/guides/how-to/recording-a-session
- **docs.anchorbrowser.io** (3): https://docs.anchorbrowser.io/advanced/browser-live-view · https://docs.anchorbrowser.io/agentic-browser-control/human-in-the-loop · https://docs.anchorbrowser.io/llms.txt
- **docs.aws.amazon.com** (1): https://docs.aws.amazon.com/nova-act/latest/userguide/step-1-playground.html
- **docs.browser-use.com** (3): https://docs.browser-use.com/cloud/agent/human-in-the-loop · https://docs.browser-use.com/cloud/browser/live-preview · https://docs.browser-use.com/llms.txt
- **docs.browserbase.com** (4): https://docs.browserbase.com/platform/agents/pausing-runs · https://docs.browserbase.com/platform/browser/observability/observability · https://docs.browserbase.com/platform/browser/observability/session-live-view · https://docs.browserbase.com/platform/browser/observability/session-replay
- **docs.browserless.io** (1): https://docs.browserless.io/baas/interactive-browser-sessions/hybrid-automation
- **docs.claude.com** (1): https://docs.claude.com/en/docs/agents-and-tools/tool-use/computer-use-tool
- **docs.devin.ai** (1): https://docs.devin.ai/work-with-devin/devin-session-tools
- **docs.replit.com** (1): https://docs.replit.com/features/agent/app-testing
- **docs.steel.dev** (4): https://docs.steel.dev/overview/agent-traces/overview · https://docs.steel.dev/overview/agent-traces/timeline · https://docs.steel.dev/overview/sessions-api/embed-sessions/live-sessions · https://docs.steel.dev/overview/sessions-api/embed-sessions/past-sessions
- **eesel.ai** (1): https://www.eesel.ai/blog/perplexity-comet-reviews
- **en.wikipedia.org** (11): https://en.wikipedia.org/wiki/Blinking · https://en.wikipedia.org/wiki/ChatGPT_Atlas · https://en.wikipedia.org/wiki/Cubic_Hermite_spline · https://en.wikipedia.org/wiki/Doubao · https://en.wikipedia.org/wiki/Fitts%27s_law · https://en.wikipedia.org/wiki/Grok_(chatbot · https://en.wikipedia.org/wiki/Manus_(AI_agent · https://en.wikipedia.org/wiki/Microsoft_Copilot · https://en.wikipedia.org/wiki/Neuro-sama · https://en.wikipedia.org/wiki/Saccade · https://en.wikipedia.org/wiki/Smooth_pursuit
- **engadget.com** (1): https://www.engadget.com/2170770/gemini-intelligence-brings-app-automation-to-android/
- **ernestchiang.com** (1): https://www.ernestchiang.com/en/posts/2025/claude-for-chrome/
- **explainx.ai** (1): https://www.explainx.ai/blog/manus-2-0-studio-cue-cascade-cloud-computer-2026
- **fast.io** (1): https://fast.io/resources/devin-session-tools-guide/
- **fellou.ai** (1): https://fellou.ai/
- **ffmpeg.org** (3): https://ffmpeg.org/ffmpeg-bitstream-filters.html#h264_005fmetadata · https://ffmpeg.org/ffmpeg-devices.html#x11grab · https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv
- **files.manuscdn.com** (3): https://files.manuscdn.com/webapp/_next/static/chunks/1831ao3j7dat0.js · https://files.manuscdn.com/webapp/_next/static/chunks/31e1a9lw6pjcf.js · https://files.manuscdn.com/webapp/_next/static/chunks/3y2uikqx3_1rt.js
- **flowith.io** (2): https://flowith.io/blog/canvas-cowork-skill · https://flowith.io/blog/canvas-evolved-habitat
- **gemini.browserbase.com** (1): https://gemini.browserbase.com
- **gemini.google** (2): https://gemini.google/overview/agent/spark · https://gemini.google/release-notes/
- **genspark.ai** (2): https://www.genspark.ai/_i18n/639c394b/en-US/messages.json · https://www.genspark.ai/blog
- **github.com** (313): https://github.com/AndersonJ293/axscope/pull/113 · https://github.com/AndrewKochulab/sim-mirror/pull/38 · https://github.com/CapSoftware/Cap · https://github.com/CapSoftware/Cap/blob/main/apps/desktop-gpui/src/editor_edits.rs · https://github.com/CapSoftware/Cap/blob/main/apps/desktop/src-tauri/src/general_settings.rs · https://github.com/CapSoftware/Cap/blob/main/crates/project/src/configuration.rs · https://github.com/CapSoftware/Cap/blob/main/crates/rendering/src/cursor_interpolation.rs · https://github.com/CapSoftware/Cap/blob/main/crates/rendering/src/zoom_spring.rs · https://github.com/FFmpeg/FFmpeg/blob/master/libavdevice/xcbgrab.c · https://github.com/FellouAI/fellou-blog/blob/main/src/content/blog/Fellou-v2-launch.mdx · https://github.com/FellouAI/fellou-blog/blob/main/src/content/blog/fellou-first-launch.mdx · https://github.com/FoundationAgents/OpenManus/blob/main/README.md · https://github.com/Hmbown/codewhale-cu-plugin/pull/5 · https://github.com/KilledByAPixel/ZzFX/blob/master/ZzFX.js · https://github.com/Live2D/CubismWebFramework/blob/develop/src/effect/cubismeyeblink.ts · https://github.com/Live2D/CubismWebSamples/blob/develop/LICENSE.md · https://github.com/LottieFiles/dotlottie-web · https://github.com/Luokavin/AutoGLM-For-Android · https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/release-notes/changelog.md · https://github.com/OpenHands/OpenHands/blob/main/src/components/features/browser/browser.tsx · https://github.com/Skyvern-AI/skyvern/blob/main/skyvern-frontend/src/components/BrowserStream.tsx · https://github.com/Skyvern-AI/skyvern/blob/main/skyvern-frontend/src/components/browser-stream.css · https://github.com/Skyvern-AI/skyvern/blob/main/skyvern-frontend/src/routes/streaming/InteractiveStreamView.tsx · https://github.com/Skyvern-AI/skyvern/blob/main/skyvern-frontend/src/routes/streaming/StreamControlBar.tsx · https://github.com/Skyvern-AI/skyvern/blob/main/skyvern/webeye/scraper/domUtils.js · https://github.com/TencentQQGYLab/AppAgent/blob/main/scripts/utils.py · https://github.com/Vanilagy/mediabunny · https://github.com/Vanilagy/mp4-muxer · https://github.com/X-PLUG/MobileAgent · https://github.com/X-PLUG/MobileAgent/blob/main/Mobile-Agent-v3.5/computer_use/run_gui_owl_1_5_for_pc.py · https://github.com/X-PLUG/MobileAgent/blob/main/Mobile-Agent-v3.5/computer_use/utils.py · https://github.com/Xetera/ghost-cursor/blob/master/src/mouse-helper.ts · https://github.com/Xetera/ghost-cursor/blob/master/src/spoof.ts · https://github.com/agent-infra/sandbox · https://github.com/alyssaxuu/screenity/blob/master/src/pages/Content/utils/CursorModes.jsx · https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-best-practices/dev_ui/localization_demo/static/index.html · https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/computer_use_demo/streamlit.py · https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/computer_use_demo/tools/computer.py · https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/image/static_content/index.html · https://github.com/anthropics/anthropic-quickstarts/tree/main/browser-use-demo · https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-best-practices · https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo · https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/computer_use_demo/streamlit.py · https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/computer_use_demo/tools/computer.py · https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/image/static_content/index.html · https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/image/x11vnc_startup.sh · https://github.com/apache/guacamole-server · https://github.com/apple/container · https://github.com/arul28/ADE/pull/1302 · https://github.com/benhowdle89/matinee/blob/main/src/motion.ts · https://github.com/benhowdle89/matinee/blob/main/src/styles.css · https://github.com/bilibili/web-demuxer · https://github.com/browser-use/browser-use/blob/0.5.11/browser_use/dom/dom_tree/index.js · https://github.com/browser-use/browser-use/blob/main/browser_use/browser/cloud/views.py · https://github.com/browser-use/browser-use/blob/main/browser_use/browser/demo_mode.py · https://github.com/browser-use/browser-use/blob/main/browser_use/browser/profile.py · https://github.com/browser-use/browser-use/blob/main/browser_use/browser/python_highlights.py · https://github.com/browser-use/browser-use/blob/main/browser_use/browser/session.py · https://github.com/browser-use/browser-use/blob/main/browser_use/browser/watchdogs/aboutblank_watchdog.py · https://github.com/browser-use/browser-use/blob/main/browser_use/browser/watchdogs/recording_watchdog.py · https://github.com/browser-use/web-ui/blob/main/src/webui/components/browser_use_agent_tab.py · https://github.com/browser-use/workflow-use/blob/main/extension/src/entrypoints/content.ts · https://github.com/browserbase/open-operator/blob/main/app/components/ChatFeed.tsx · https://github.com/browserbase/sdk-node/blob/main/src/resources/sessions/recording/recording.ts · https://github.com/browserbase/stagehand/blob/main/packages/cli/src/lib/driver/cursor-overlay.ts · https://github.com/browserbase/stagehand/blob/main/packages/extension/dom/locatorScripts/cursorOverlay.ts · https://github.com/browserbase/stagehand/blob/main/packages/extension/understudy/locator.ts · https://github.com/bytebot-ai/bytebot/blob/main/docs/guides/takeover-mode.mdx · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/server.ts · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/app/tasks/%5Bid%5D/page.tsx · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/VirtualDesktopStatusHeader.tsx · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/messages/content/ComputerToolContentNormal.tsx · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/messages/content/ComputerToolContentTakeOver.tsx · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/messages/content/ComputerToolUtils.tsx · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/ui/desktop-container.tsx · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/components/vnc/VncViewer.tsx · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/hooks/useScrollScreenshot.ts · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/hooks/useWebSocket.ts · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebot-ui/src/utils/screenshotUtils.ts · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebotd/root/etc/supervisor/conf.d/supervisord.conf · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebotd/src/input-tracking/input-tracking.service.ts · https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebotd/src/nut/nut.service.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/README.md · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/agent/prompts.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/services/runAgent.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/shared/setOfMarks.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/utils/agent.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/utils/image.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/main/window/ScreenMarker.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/components/ImageGallery/index.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/components/RunMessages/ShareOptions.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/components/ThoughtChain/index.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/const/actions.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/remote/cast/canvas.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/remote/cast/status.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/remote/cast/vnc.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/remote/free.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/widget/index.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/pages/widget/widget.css · https://github.com/bytedance/UI-TARS-desktop/blob/main/apps/ui-tars/src/renderer/src/utils/html.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/agent-tars/core/src/environments/local/browser/browser-gui-agent.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/gui-agent/operator-browser/src/browser-operator.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/gui-agent/operator-browser/src/ui-helper.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/omni-tars/omni-agent/src/index.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-interface/src/agent-event-stream.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-interface/src/agent-instance.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-interface/src/gui-agent.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-server/src/api/routes/queries.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-server/src/services/ShareService.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui-builder/src/builder.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/common/hooks/useReplay.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/common/hooks/useReplayMode.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/common/services/apiService.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/config/web-ui-config.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/standalone/modals/EventStreamModal.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/standalone/replay/ReplayControlPanel.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/agent-ui/src/standalone/workspace/renderers/BrowserControlRenderer.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/interface/src/web-ui-implementation.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/ai/BrowserShell.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/ai/ThinkingAnimation.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/MouseCursor.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/OperationDetailsCard.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/ScreenshotDisplay.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/StrategySwitch.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/useMousePosition.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/tarko/ui/src/components/gui-agent/useScreenshots.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/websites/docs/docs/en/guide/basic/browser.mdx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/websites/docs/docs/en/guide/basic/web-ui.mdx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/websites/tarko/docs/en/guide/advanced/agent-protocol.mdx · https://github.com/bytedance/UI-TARS-desktop/blob/main/multimodal/websites/tarko/docs/en/guide/basic/event-stream.mdx · https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/operators/nut-js/src/index.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/shared/src/types/agent.ts · https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/visualizer/src/component/blackboard.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/visualizer/src/component/color.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/visualizer/src/component/player.less · https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/visualizer/src/component/player.tsx · https://github.com/bytedance/UI-TARS-desktop/blob/main/packages/ui-tars/visualizer/src/component/replay-scripts.tsx · https://github.com/bytedance/UI-TARS-desktop/pull/1853 · https://github.com/bytedance/UI-TARS-desktop/pull/1938 · https://github.com/bytedance/UI-TARS-desktop/pull/1975 · https://github.com/bytedance/UI-TARS-desktop/pull/2026 · https://github.com/bytedance/UI-TARS-desktop/releases/tag/v0.2.4 · https://github.com/bytedance/UI-TARS-desktop/releases/tag/v0.3.0 · https://github.com/bytedance/UI-TARS-desktop/tree/main/multimodal/tarko/ui/src/components/gui-agent · https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/webcodecs/webcodecs_logger.cc · https://github.com/clippyjs/clippy.js/blob/master/src/agent.js · https://github.com/e2b-dev/E2B/blob/main/packages/desktop-js/src/sandbox.ts · https://github.com/e2b-dev/cua-rollout-demo-public/blob/main/README.md · https://github.com/e2b-dev/cua-rollout-demo-public/blob/main/template/vnc-up.sh · https://github.com/e2b-dev/desktop/blob/main/template/template.py · https://github.com/e2b-dev/open-computer-use/blob/main/os_computer_use/streaming.py · https://github.com/e2b-dev/surf/blob/main/app/api/chat/route.ts · https://github.com/e2b-dev/surf/blob/main/app/page.tsx · https://github.com/e2b-dev/surf/blob/main/components/chat/message.tsx · https://github.com/e2b-dev/surf/blob/main/lib/config.ts · https://github.com/e2b-dev/surf/blob/main/lib/streaming/openai.ts · https://github.com/e2b-dev/surf/blob/main/types/api.ts · https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/apps/website/docs/performance.md · https://github.com/flatpak/xdg-desktop-portal/blob/main/data/org.freedesktop.portal.ScreenCast.xml · https://github.com/goldfire/howler.js · https://github.com/gpac/mp4box.js · https://github.com/gpac/mp4box.js/blob/main/src/boxes/prft.ts · https://github.com/heygen-com/hyperframes · https://github.com/hqhq1025/kimi-computer-use-lab/blob/main/reports/kimi-cu-reverse-engineering-2026-08-10.md · https://github.com/huggingface/screenenv/blob/main/README.md · https://github.com/hyperbrowserai/HyperAgent/blob/main/src/context-providers/shared/highlight-colors.ts · https://github.com/jordansissel/xdotool/blob/master/xdotool.pod · https://github.com/kasmtech/KasmVNC · https://github.com/kasmtech/KasmVNC/releases/tag/v1.5.0 · https://github.com/kasmtech/noVNC/blob/master/core/decoders/kasmvideo.js · https://github.com/kernel/kernel-images · https://github.com/kernel/kernel-images/blob/main/server/lib/recorder/ffmpeg.go · https://github.com/kernel/kernel-images/blob/main/server/lib/recorder/markers.go · https://github.com/keycastr/keycastr/blob/main/keycastr/KCDefaultVisualizer.m · https://github.com/kortix-ai/suna/blob/adadb9b1a2/frontend/src/components/thread/HealthCheckedVncIframe.tsx · https://github.com/kortix-ai/suna/blob/adadb9b1a2/frontend/src/components/thread/tool-call-side-panel.tsx · https://github.com/kortix-ai/suna/blob/adadb9b1a2/frontend/src/components/thread/tool-views/wrapper/ToolViewRegistry.tsx · https://github.com/kortix-ai/suna/blob/main/LICENSE · https://github.com/kortix-ai/suna/blob/main/apps/web/src/features/session/action-panel/shared/action-navigator-logic.ts · https://github.com/kortix-ai/suna/blob/main/apps/web/src/features/session/action-panel/shared/action-navigator.tsx · https://github.com/kumard3/agentcursor · https://github.com/lahfir/agent-desktop/blob/HEAD/crates/core/src/cursor_overlay/hand_path.rs · https://github.com/m1k1o/neko · https://github.com/m1k1o/neko/blob/master/server/go.mod · https://github.com/m1k1o/neko/blob/master/server/internal/capture/manager.go · https://github.com/m1k1o/neko/blob/master/server/internal/config/capture.go · https://github.com/m1k1o/neko/blob/master/server/internal/webrtc/payload/send.go · https://github.com/m1k1o/neko/blob/master/server/internal/websocket/handler/control.go · https://github.com/m1k1o/neko/blob/master/webpage/docs/configuration/capture.md · https://github.com/magnitudedev/browser-agent/blob/main/packages/magnitude-core/src/web/visualizer/cursor.ts · https://github.com/magnitudedev/browser-agent/blob/main/packages/magnitude-core/src/web/visualizer/mouseEffects.ts · https://github.com/magnitudedev/browser-agent/blob/main/packages/magnitude-core/src/web/visualizer/typeEffects.ts · https://github.com/material-components/material-components-web/blob/master/packages/mdc-ripple/constants.ts · https://github.com/met4citizen/TalkingHead/blob/main/modules/talkinghead.mjs · https://github.com/microsoft/OmniParser · https://github.com/microsoft/magentic-ui/blob/magentic-ui-0.1/frontend/src/components/views/chat/DetailViewer/SecurityBanner.tsx · https://github.com/microsoft/magentic-ui/blob/magentic-ui-0.1/frontend/src/components/views/chat/DetailViewer/browser_iframe.tsx · https://github.com/microsoft/magentic-ui/blob/magentic-ui-0.1/frontend/src/components/views/chat/approval_buttons.tsx · https://github.com/microsoft/magentic-ui/blob/magentic-ui-0.1/frontend/src/components/views/chat/plan.tsx · https://github.com/microsoft/magentic-ui/blob/magentic-ui-0.1/src/magentic_ui/approval_guard.py · https://github.com/microsoft/magentic-ui/blob/main/README.md · https://github.com/microsoft/magentic-ui/blob/main/docs/configuration.md · https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/BrowserEmbed.tsx · https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/BrowserViewer.tsx · https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/DescriptionOverlay.tsx · https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/PlaybackControlsRow.tsx · https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/ProgressBar.tsx · https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/browser/TakeoverNotice.tsx · https://github.com/microsoft/magentic-ui/blob/main/frontend/src/components/chat/messages/InputRequestMessage.tsx · https://github.com/microsoft/magentic-ui/blob/main/frontend/src/lib/constants.ts · https://github.com/microsoft/magentic-ui/blob/main/src/magentic_ui/tools/playwright/browser/quicksand_playwright_browser.py · https://github.com/microsoft/magentic-ui/blob/main/src/magentic_ui/tools/playwright/utils/animation_utils.py · https://github.com/microsoft/playwright/blob/main/docs/src/release-notes-js.md · https://github.com/midrender/revideo · https://github.com/moeru-ai/airi/blob/main/packages/stage-ui-live2d/src/utils/eye-motions.ts · https://github.com/motiondivision/motion/blob/main/packages/motion-dom/src/animation/generators/spring.ts · https://github.com/motiondivision/motion/blob/main/packages/motion-dom/src/animation/waapi/utils/linear.ts · https://github.com/mrdoob/three.js/blob/dev/src/textures/VideoFrameTexture.js · https://github.com/mulaRahul/keyviz/blob/main/src/stores/key_event.ts · https://github.com/nanobrowser/nanobrowser/blob/master/pages/side-panel/src/types/message.ts · https://github.com/novnc/noVNC · https://github.com/novnc/noVNC/blob/master/core/decoders/h264.js · https://github.com/novnc/noVNC/blob/master/core/display.js · https://github.com/novnc/noVNC/blob/master/core/encodings.js · https://github.com/novnc/noVNC/blob/master/core/rfb.js · https://github.com/novnc/noVNC/issues/974 · https://github.com/novnc/noVNC/pull/1964 · https://github.com/novnc/noVNC/releases/tag/v1.6.0 · https://github.com/novnc/noVNC/releases/tag/v1.7.0 · https://github.com/onkernel/kernel-images · https://github.com/openai/openai-cua-sample-app · https://github.com/openai/openai-cua-sample-app/blob/main/README.md · https://github.com/openai/openai-cua-sample-app/blob/main/console/components/ScreenshotPane.tsx · https://github.com/openai/openai-cua-sample-app/blob/main/contracts/index.ts · https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet · https://github.com/openai/tart · https://github.com/openai/tart/blob/main/LICENSE · https://github.com/openai/tart/blob/main/Sources/tart/Commands/Run.swift · https://github.com/openai/tart/blob/main/Sources/tart/VNC/FullFledgedVNC.swift · https://github.com/philc/vimium/blob/master/lib/settings.js · https://github.com/pixijs/pixijs/blob/dev/src/environment-webworker/WebWorkerAdapter.ts · https://github.com/pixijs/pixijs/blob/dev/src/rendering/renderers/shared/texture/sources/ImageSource.ts · https://github.com/pixiv/three-vrm/blob/dev/packages/three-vrm-core/src/lookAt/VRMLookAt.ts · https://github.com/pmndrs/react-spring/blob/main/packages/core/src/constants.ts · https://github.com/remotion-dev/remotion/blob/main/LICENSE.md · https://github.com/remotion-dev/remotion/pull/3750 · https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst · https://github.com/rive-app/rive-wasm/blob/master/js/src/rive.ts · https://github.com/rrweb-io/rrweb · https://github.com/rrweb-io/rrweb/blob/master/docs/recipes/canvas.md · https://github.com/rrweb-io/rrweb/blob/master/docs/recipes/cross-origin-iframes.md · https://github.com/rrweb-io/rrweb/blob/master/docs/recipes/optimize-storage.md · https://github.com/rrweb-io/rrweb/blob/master/guide.md · https://github.com/selkies-project/pixelflux · https://github.com/selkies-project/selkies · https://github.com/selkies-project/selkies/blob/main/addons/selkies-web-core/selkies-ws-core.js · https://github.com/selkies-project/selkies/blob/main/docs/design.md · https://github.com/selkies-project/selkies/blob/main/docs/settings.md · https://github.com/selkies-project/selkies/releases/tag/2.0.0 · https://github.com/siddharthvaddem/openscreen · https://github.com/siddharthvaddem/openscreen/blob/HEAD/src/components/video-editor/videoPlayback/constants.ts · https://github.com/siddharthvaddem/openscreen/blob/HEAD/src/components/video-editor/videoPlayback/motionSmoothing.ts · https://github.com/siddharthvaddem/openscreen/blob/HEAD/src/components/video-editor/videoPlayback/zoomSpring.ts · https://github.com/siddharthvaddem/openscreen/blob/main/src/components/video-editor/timeline/zoomSuggestionUtils.ts · https://github.com/siddharthvaddem/openscreen/blob/main/src/lib/cursor/cursorPathSmoothing.ts · https://github.com/siddharthvaddem/openscreen/tree/main/src/lib/exporter · https://github.com/steel-dev/steel-browser/blob/main/api/src/plugins/browser-socket/casting.handler.ts · https://github.com/steel-dev/surf.new/blob/main/components/ui/Browser.tsx · https://github.com/syi0808/screenize/blob/HEAD/Screenize/Generators/ContinuousCamera/ContinuousCameraTypes.swift · https://github.com/syi0808/screenize/blob/HEAD/Screenize/Generators/GenerationSettings.swift · https://github.com/syi0808/screenize/blob/HEAD/Screenize/Render/SpringCursorSimulator.swift · https://github.com/trycua/cua · https://github.com/trycua/cua/blob/main/docs/content/docs/how-to-guides/driver/personalize-cursor.mdx · https://github.com/trycua/cua/blob/main/docs/content/docs/how-to-guides/driver/record-and-render-a-trajectory.mdx · https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/cursor-themes.md · https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Cargo.toml · https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/bezier.rs · https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/capture_exclusion.rs · https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/motion.rs · https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/path_planner.rs · https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/render_state.rs · https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/session_badge.rs · https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cursor-overlay/src/theme.rs · https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/platform-linux/src/overlay_capture.rs · https://github.com/trycua/cua/blob/main/libs/cuabot/src/mcp/overlay-cursor.py · https://github.com/trycua/cua/blob/main/libs/fleet/patches/@novnc__novnc@1.7.0.patch · https://github.com/trycua/cua/blob/main/libs/fleet/src/components/DesktopPane.tsx · https://github.com/trycua/cua/blob/main/libs/lume/src/VNC/VNCService.swift · https://github.com/trycua/cua/blob/main/libs/python/agent/cua_agent/ui/gradio/ui_components.py · https://github.com/trycua/cua/blob/main/libs/python/computer-server/computer_server/handlers/vnc.py · https://github.com/trycua/cua/blob/main/libs/python/computer/computer/providers/lumier/provider.py · https://github.com/trycua/cua/blob/main/libs/typescript/playground/src/components/TrajectoryViewer/index.tsx · https://github.com/trycua/cua/blob/main/libs/typescript/playground/src/components/primitives/ToolCallsGroup.tsx · https://github.com/trycua/cua/issues/3542 · https://github.com/trycua/cua/issues/4194 · https://github.com/volcengine/ai-app-lab/tree/main/demohouse/computer_use · https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md · https://github.com/web-infra-dev/midscene · https://github.com/web-infra-dev/midscene/blob/main/apps/chrome-extension/src/scripts/water-flow.ts · https://github.com/web-infra-dev/midscene/blob/main/packages/visualizer/src/component/blackboard/index.less · https://github.com/web-infra-dev/midscene/blob/main/packages/visualizer/src/component/player/scenes/StepScene.tsx · https://github.com/web-infra-dev/midscene/blob/main/packages/visualizer/src/component/player/scenes/export-branded-video.ts · https://github.com/web-infra-dev/midscene/blob/main/packages/visualizer/src/component/player/scenes/frame-calculator.ts · https://github.com/web-infra-dev/midscene/blob/main/packages/visualizer/src/component/player/scenes/pointer-layout.ts · https://github.com/web-infra-dev/midscene/tree/main/packages/visualizer · https://github.com/webadderallorg/Recordly/blob/HEAD/src/components/video-editor/videoPlayback/cursorFollowCamera.ts · https://github.com/webadderallorg/Recordly/blob/HEAD/src/components/video-editor/videoPlayback/cursorSway.ts · https://github.com/zai-org/Open-AutoGLM · https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/actions/handler.py · https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/adb/screenshot.py · https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/config/i18n.py · https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/config/prompts_en.py · https://github.com/zai-org/Open-AutoGLM/blob/main/phone_agent/config/prompts_zh.py
- **gitlab.com** (1): https://gitlab.com/screenkey/screenkey/-/blob/master/README.rst
- **gitlab.freedesktop.org** (3): https://gitlab.freedesktop.org/xorg/proto/xorgproto/-/blob/master/fixesproto.txt · https://gitlab.freedesktop.org/xorg/xserver/-/blob/master/man/Xserver.man · https://gitlab.freedesktop.org/xorg/xserver/-/blob/master/os/utils.c
- **glaxnimate.org** (1): https://glaxnimate.org/
- **gpuweb.github.io** (1): https://gpuweb.github.io/gpuweb/explainer/
- **gsap.com** (4): https://gsap.com/docs/v3/GSAP/gsap.quickTo( · https://gsap.com/docs/v3/Plugins/MotionPathPlugin/ · https://gsap.com/licensing/ · https://gsap.com/standard-license
- **guacamole.apache.org** (3): https://guacamole.apache.org/doc/gug/guacamole-architecture.html · https://guacamole.apache.org/doc/gug/protocol-reference.html · https://guacamole.apache.org/releases/1.6.0/
- **help.aliyun.com** (1): https://help.aliyun.com/zh/ecp/quickly-experience-and-create-cloud-phone-mobileclaw
- **help.manus.im** (2): https://help.manus.im/en/articles/11711218-how-can-i-take-over-manus-browser-or-vs-code · https://help.manus.im/en/articles/17190150-what-is-new-in-manus-2-0
- **help.openai.com** (3): https://help.openai.com/en/articles/11752874-chatgpt-agent · https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes · https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- **hub.screen.studio** (1): https://hub.screen.studio/p/zoom-that-follows-typing
- **huggingface.co** (3): https://huggingface.co/spaces/smolagents/computer-agent/blob/main/app.py · https://huggingface.co/spaces/smolagents/computer-agent/blob/main/e2bqwen.py · https://huggingface.co/spaces/smolagents/computer-agent/blob/main/scripts_and_styling.py
- **hyperbrowser.ai** (2): https://hyperbrowser.ai/docs/sessions/live-view · https://hyperbrowser.ai/docs/sessions/recordings
- **hyperframes.heygen.com** (2): https://hyperframes.heygen.com/concepts/determinism · https://hyperframes.heygen.com/concepts/variables
- **joshwcomeau.com** (1): https://www.joshwcomeau.com/react/announcing-use-sound-react-hook/
- **kasmweb.com** (2): https://kasmweb.com/kasmvnc/docs/master/release_notes/1.0.0.html · https://www.kasmweb.com/kasmvnc/docs/latest/configuration.html
- **kernel.sh** (4): https://kernel.sh/docs/browsers/computer-controls · https://kernel.sh/docs/browsers/live-view · https://kernel.sh/docs/browsers/replays · https://kernel.sh/docs/browsers/viewport
- **kimi.ai** (9): https://www.kimi.ai/blog/kimi-k2-thinking · https://www.kimi.ai/blog/kimi-k3 · https://www.kimi.ai/help/agent/agent-features-and-limits · https://www.kimi.ai/help/agent/agent-overview · https://www.kimi.ai/help/agent/agent-swarm · https://www.kimi.ai/help/kimi-webbridge/kimi-webbridge-how-it-works · https://www.kimi.ai/help/kimi-work/kimi-work-faq · https://www.kimi.ai/help/kimi-work/overview · https://www.kimi.ai/help/kimi-work/release-notes
- **labs.google.com** (1): https://labs.google.com/mariner/
- **labs.zenity.io** (1): https://labs.zenity.io/post/perplexity-comet-a-reversing-story
- **learn.chatgpt.com** (5): https://learn.chatgpt.com/docs/computer-use · https://learn.chatgpt.com/docs/dots · https://learn.chatgpt.com/docs/dots/computers-and-apps · https://learn.chatgpt.com/docs/pets · https://learn.chatgpt.com/docs/whats-new/devday-2026
- **learn.microsoft.com** (4): https://learn.microsoft.com/en-us/deployedge/microsoft-edge-management-browsing-with-copilot · https://learn.microsoft.com/en-us/microsoft-copilot-studio/computer-use · https://learn.microsoft.com/en-us/microsoft-copilot-studio/human-supervision-computer-use · https://learn.microsoft.com/en-us/microsoft-copilot-studio/monitor-computer-use
- **lovart.ai** (1): https://www.lovart.ai/
- **macrumors.com** (1): https://www.macrumors.com/2026/03/18/perplexity-comet-browser-iphone/
- **macstories.net** (1): https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested/
- **manus.im** (8): https://manus.im/blog · https://manus.im/blog/introducing-manus-2-0 · https://manus.im/blog/manus-browser-operator · https://manus.im/blog/manus-my-computer-desktop · https://manus.im/docs/features/browser-operator · https://manus.im/docs/features/cloud-browser.md · https://manus.im/docs/features/desktop.md · https://manus.im/share/xFgpHb15vKqfRPWIs3JJPJ?replay=1
- **mediabunny.dev** (1): https://mediabunny.dev/guide/media-sinks
- **microsoft.com** (1): https://www.microsoft.com/en-us/research/articles/omniparser-v2-turning-any-llm-into-a-computer-use-agent/
- **mindgard.ai** (1): https://mindgard.ai/blog/manus-rubra-full-browser-remote-control
- **minimax.io** (3): https://www.minimax.io/news/minimax-agent · https://www.minimax.io/news/minimax-m2 · https://www.minimax.io/news/minimax-m25
- **motion.dev** (5): https://motion.dev/docs/react-accessibility · https://motion.dev/docs/react-layout-animations · https://motion.dev/docs/react-use-spring · https://motion.dev/docs/spring · https://motion.dev/docs/spring-value
- **openai.com** (3): https://openai.com/index/introducing-chatgpt-agent/ · https://openai.com/index/introducing-operator/ · https://openai.com/index/operator-system-card/
- **operaneon.com** (2): https://www.operaneon.com/ · https://www.operaneon.com/faq
- **perplexity.ai** (7): https://www.perplexity.ai/changelog · https://www.perplexity.ai/changelog/what-we-shipped-october-3rd · https://www.perplexity.ai/help-center/comet/en/articles/11734688-assistant-panel · https://www.perplexity.ai/hub/blog/comet-assistant-puts-you-in-control · https://www.perplexity.ai/hub/blog/comet-for-android-is-here · https://www.perplexity.ai/hub/blog/the-new-comet-assistant · https://www.perplexity.ai/products/computer
- **platform.openai.com** (1): https://platform.openai.com/docs/guides/tools-computer-use
- **prnewswire.com** (1): https://www.prnewswire.com/news-releases/kasm-technologies-releases-kasmvnc-v1-open-source-vnc-server-with-web-native-agentless-4k-60-fps-lossless-streaming-capability-301691477.html
- **remotion.dev** (2): https://www.remotion.dev/docs/client-side-rendering · https://www.remotion.dev/docs/client-side-rendering/limitations
- **remotion.pro** (1): https://www.remotion.pro/license
- **rive.app** (4): https://rive.app/blog/rive-as-a-lottie-alternative · https://rive.app/docs/editor/state-machine/inputs · https://rive.app/docs/runtimes/web/canvas-vs-webgl · https://rive.app/pricing
- **screen.studio** (9): https://screen.studio/guide/animations · https://screen.studio/guide/auto-zoom · https://screen.studio/guide/cursor · https://screen.studio/guide/disable-automatic-zooms- · https://screen.studio/guide/disable-smooth-mouse-movement · https://screen.studio/guide/instant-zoom · https://screen.studio/guide/mouse-click-sound · https://screen.studio/guide/shortcuts · https://screen.studio/guide/speed-up-typing-segments
- **sherwood.news** (1): https://sherwood.news/tech/openais-operator-slowly-take-over-your-computer-mess-up-your-life/
- **sigmabrowser.com** (1): https://sigmabrowser.com/
- **simonwillison.net** (3): https://simonwillison.net/2025/Jan/23/introducing-operator/ · https://simonwillison.net/2025/Oct/21/introducing-chatgpt-atlas/ · https://simonwillison.net/2026/Jan/12/claude-cowork/
- **space.coze.cn** (1): https://space.coze.cn/
- **statics.moonshot.cn** (2): https://statics.moonshot.cn/kimi-web-seo/assets/Replay-BH5OAntv.js · https://statics.moonshot.cn/kimi-web-seo/assets/zh-CN-CjcCBPuD.js
- **support.claude.com** (5): https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome · https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide · https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork · https://support.claude.com/en/articles/14128542 · https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork
- **support.google.com** (4): https://support.google.com/chrome/answer/16821166 · https://support.google.com/gemini/answer/17094196 · https://support.google.com/gemini/answer/17094507 · https://support.google.com/gemini/answer/17208717
- **support.microsoft.com** (1): https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features
- **taskade.com** (1): https://www.taskade.com/blog/manus-ai-review
- **tech.yahoo.com** (1): https://tech.yahoo.com/ai/chatgpt/articles/chatgpts-atlas-browser-shows-potential-120000650.html
- **techcrunch.com** (5): https://techcrunch.com/2024/12/11/google-unveils-project-mariner-ai-agents-to-use-the-web-for-you/ · https://techcrunch.com/2025/03/09/manus-probably-isnt-chinas-second-deepseek-moment/ · https://techcrunch.com/2025/05/20/google-rolls-out-project-mariner-its-web-browsing-ai-agent/ · https://techcrunch.com/2025/07/09/perplexity-launches-comet-an-ai-powered-web-browser/ · https://techcrunch.com/2025/10/02/perplexitys-comet-ai-browser-now-free-max-users-get-new-background-assistant/
- **technologyreview.com** (1): https://www.technologyreview.com/2025/03/11/1113133/manus-ai-review/
- **techtalksnetwork.com** (1): https://techtalksnetwork.com/blog/let-perplexity-comet-browse-for-you
- **testingcatalog.com** (2): https://www.testingcatalog.com/exclusive-comrehansive-review-comet/ · https://www.testingcatalog.com/manus-ai-launches-browser-operator-extension/
- **theverge.com** (2): https://www.theverge.com/news/670848/google-agent-mode-gemini-app-project-mariner-i-o-2025 · https://www.theverge.com/news/709025/perplexity-comet-ai-browser-chrome-competitor
- **thezvi.wordpress.com** (1): https://thezvi.wordpress.com/2025/01/28/operator/
- **w3.org** (2): https://www.w3.org/TR/webcodecs-avc-codec-registration/ · https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
- **w3c.github.io** (1): https://w3c.github.io/audio-session/
- **web.archive.org** (7): https://web.archive.org/web/20260528180038/https://www.genspark.ai/blog/genspark-super-agent · https://web.archive.org/web/20260829170736/https://www.genspark.ai/blog/genspark-ai-browser · https://web.archive.org/web/20260829185128/https://www.genspark.ai/helpcenter/call-for-me · https://web.archive.org/web/20260830074603/https://www.genspark.ai/blog/genspark-ai-workspace-6 · https://web.archive.org/web/20260910024237/https://www.genspark.ai/blog/genspark-ai-workspace-4 · https://web.archive.org/web/20260915124421/https://www.genspark.ai/helpcenter/genspark-claw · https://web.archive.org/web/20260918065025/https://www.genspark.ai/helpcenter
- **web.dev** (3): https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing · https://web.dev/articles/rendering-performance · https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count
- **willo.ai** (1): https://www.willo.ai/blog/manus-review
- **winblogs.thesourcemediaassets.com** (1): https://winblogs.thesourcemediaassets.com/sites/44/2025/11/Copilot_Operator.gif
- **wired.com** (1): https://www.wired.com/story/openai-chatgpt-agent-launch/
- **x.com** (1): https://x.com/kierajmumick/status/2044835383981269430
- **xda-developers.com** (1): https://www.xda-developers.com/opera-neon-replacing-chrome-and-comet/
- **xiao9905.github.io** (1): https://xiao9905.github.io/AutoGLM/
- **youtube.com** (7): https://www.youtube.com/watch?v=2XJqLPqHtyo · https://www.youtube.com/watch?v=ODaHJzOyVCQ · https://www.youtube.com/watch?v=UAmKyyZ-b9E · https://www.youtube.com/watch?v=_lu-FcPUIfM · https://www.youtube.com/watch?v=jqx18KgIzAE · https://www.youtube.com/watch?v=slOLc1nkKY0 · https://www.youtube.com/watch?v=vH2f7cjXjKI
- **z-cdn.chatglm.cn** (1): https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.98/assets/index-BEIsjDOv.js
- **zh.wikipedia.org** (1): https://zh.wikipedia.org/wiki/豆包大模型
