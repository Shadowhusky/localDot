# OpenAI "dots" (the user's "Dot"): research notes

Researched 2026-09-30, the day after launch. Primary sources are OpenAI's launch post, safety post, Help Center, ChatGPT Learn docs, system card, and OpenAI's own launch videos and screenshots. I pulled frames from those videos and read them myself.

Labels used below:
- **[verified]**: stated in an OpenAI primary source.
- **[observed]**: seen in OpenAI's own marketing screenshots or video frames that I extracted. Marketing captures can be edited or staged, so treat them as evidence, not proof, of shipped behaviour.
- **[press]**: reported by the press.
- **[inferred]**: my own inference.
- **[unverified]**: from my training data. I did not re-check it live.

---

## 0. Verdict

- **"Dot" is real.** It is OpenAI's **dots** (lowercase, plural brand; each user has "your dot").
- **Launch:** announced **2026-09-29 at DevDay 2026** (Fort Mason, San Francisco) and rolling out from that day. [verified]
- **What it is:** a persistent, always-on personal agent inside ChatGPT, powered by **GPT-6 Astra**. Each dot has **its own cloud computer (a Linux VM-backed sandbox with Chrome)**, memory, 4,000+ app plugins, and channels: ChatGPT, voice call, Slack, Teams, and texting later. [verified]
- **It is not hardware, and "Dot" is not a codename.** One hint of an internal codename: the admin-guide URL is `learn.chatgpt.com/docs/enterprise/o-admin-guide` and its anchors read `can-we-use-o-if-…`. The logo's "o" is a ring glyph (`dots-o.svg`). This suggests dots were codenamed **"o"** internally. [inferred]
- **Unrelated earlier product:** a 2024 "Dot" companion app by New Computer was not OpenAI's. [unverified]
- **How it matches the user's description.** The user described a virtual window that looks like macOS or Linux and shows the agent's work.
  - In the ChatGPT desktop app, a tab named **"<Name>'s computer"** (for example "Alfred's computer") shows the dot's **Linux desktop**.
  - The desktop is framed in the dot's colour: a Chrome window, a dock (Chrome / Terminal / Files), and a status pill **"Alfred has control · [Take over]"**. [observed]
  - On a Mac, the macOS look is the ChatGPT app's own window (traffic lights). The guest OS is Linux. OpenAI says it "maintain[s] the underlying Linux operating system and Chrome browser". [verified]
- **Product lineage:**
  - Operator (Jan 2025): remote browser, screenshots plus mouse/keyboard, takeover mode, watch mode.
  - ChatGPT agent (Jul 2025): virtual computer with visual browser, text browser, terminal, and "on-screen narration".
  - Atlas agent mode (Oct 2025).
  - ChatGPT Work / Codex Computer Use (2026).
  - dots (Sep 2026).

---

## 1. Launch, availability, platforms, pricing

**Date and venue**
- 2026-09-29, DevDay 2026 keynote by Sam Altman. [verified]
- CNBC photo caption: a "dots" pop-up shop at DevDay let attendees "design stickers of their agents". [press]

**Plans** [verified]
- **Pro 100 / Pro 200 / Pro 500:** users 18+ outside the EEA, UK and Switzerland.
- **Business Premium:** worldwide.
- **Enterprise (including Edu and Healthcare):** beta, off by default, needs an admin to enable it.
- Rollout is gradual and "may take several days".

**Plan prices** [verified]
- Pro "from $100/month". Pro 200 is $200/month and reopened to new subscribers. Pro 500 is a new $500/month tier with "Astra Ultrafast".
- Business Premium price: **not found**.

**What the price includes** [verified]
- Your "first dot is included … at no extra cost". The plan includes "an allowance for deeper work, with extended limits for the first month".
- The release notes say that "for the next month, dots usage won't count toward … plan allowances. After this period, we'll share usage terms."
- Conversations with the dot don't count toward ChatGPT limits. Tasks the dot starts in Codex or ChatGPT Work do count.
- Planned: "add more dots, and scale the output of each dot by either increasing its speed or the total amount of work it can take on per month."
- **Post-launch economics are undisclosed.**

**Platforms** [verified]
- You create the dot in the **ChatGPT desktop app (macOS or Windows) or a desktop browser**.
- After that you can use it in the **mobile app** ("when the supporting update is available"). You can't create a dot on mobile, and **mobile web is not supported**.

**Channels**
- ChatGPT (desktop, web, mobile) and **voice calls** via the phone button. You can type during a call. The dot **cannot initiate calls at launch**; that is "planned for after launch". [verified]
- **Slack:** DM it, or @mention it in channels you add it to. It posts with its own identity and an "AGENT" badge. [verified / observed]
- **Teams:** the admin guide says Teams is an "invite-only alpha". [verified]
- **Texting:** sources conflict.
  - Help Center: a limited US Pro beta via a third-party provider.
  - Learn docs: "coming soon".
  - WIRED: a waitlist for iMessage/RCS. [press]
  - OpenAI demo video: an iMessage thread with the dot as a contact. [observed]

**Specialist dots (enterprise preview)** [verified]
- Each has its own identity, credentials, "IT-provisioned hardware" and systems-of-record integrations.
- Starting as pilots where OpenAI engineers co-design the workflow.
- Microsoft **Agent 365** governance integration is in progress.

Sources:
- https://openai.com/index/introducing-dots/
- https://help.openai.com/en/articles/20001530-getting-started-with-your-dot
- https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- https://learn.chatgpt.com/docs/dots
- https://learn.chatgpt.com/docs/dots/channels
- https://learn.chatgpt.com/docs/enterprise/o-admin-guide
- https://chatgpt.com/pricing/
- https://www.wired.com/story/openai-dots-always-on-ai-agents-that-proactively-help/
- https://www.cnbc.com/2026/09/29/openai-devday-2026-live-updates.html

---

## 2. Model and agent stack

**Model: GPT-6 Astra** [verified]
- OpenAI calls it "our most capable and aligned model" and "the world's best computer use model".
- **OSWorld 2.0: 72.6% at about 40 minutes per task**, versus GPT-5.6 Sol at 65.7% and about 75 minutes.
- OpenAI also updated the Codex harness for computer-use speed: "1.9x faster task completion" on Mind2Web.
- Released Sept 3, 2026 per TNW [press]. GPT-6.1 Astra was cancelled after failing safety tests [press].
- Sources: https://openai.com/index/gpt-6-astra/ and https://deploymentsafety.openai.com/gpt-6-astra/change-log

**Harness**
- The system card compares a **"dots harness"** with the **"Codex harness"**. The dots harness has:
  - a **new time-budget setting** that "guides how long they work";
  - a clock tool with "wait";
  - a **custom confirmation policy** that gets higher priority than in Codex.
  [verified, system card §12]
- A dot "often delegat[es] work to subagents". [verified]
  - It can run "background agents … in parallel".
  - It can start **cloud threads**, which appear as separate conversations.
  - It can create **ChatGPT Work or Codex tasks** on a connected computer, continue existing local Codex tasks, and use **Codex cloud environments**.
  - It "can decide when to pause and wake up to continue work". [verified, Learn docs]
- **ChatGPT Work Cloud uses "the Codex task-execution harness"**, and dots share the same cloud-computer capability controls. [verified]
- **Auto-review** (internally "Guardian", per Axios) is a separate reviewer agent. Its open-source policy lives in the Codex repo (`codex-rs/core/src/guardian/policy.md`). [verified / press]
- **Safety monitor** for misalignment and misuse can pause the dot and show a warning. [verified]

**Tools**
- Cloud computer (browser, shell/code, desktop apps).
- Plugins across 4,000+ apps. Plugin permissions are shared across ChatGPT, Work, Codex and dots.
- Local computer via the ChatGPT desktop app (local files, skills, local browser, Computer Use plugin).
- Memory and notes.
- Scheduling and event triggers (for example a new Slack bug report).

---

## 3. Architecture

### 3.1 Cloud computer (the "virtual computer")

- "Each dot has its own cloud computer, where it can browse, analyze information, create files, and run tools." [verified]
  - "Within each dot's protected workspace, sandboxing restricts what code and tools that dot can access… We also isolate users' cloud environments from one another and **maintain the underlying Linux operating system and Chrome browser**."
  - Source: https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/
- Execution is separated from control: dots "run code in environments that are separate from the systems that coordinate their work and enforce key safeguards… they cannot use that access to change those safety systems or turn off required checks." Auto-review's controls are kept "outside the environments dots can change". [verified]
- Work Cloud (same infrastructure family) runs tasks "in **VM-backed sandboxes**, with execution state associated with the authenticated account user…". The environment can be reused or replaced "while preserving eligible state". Execution state and snapshots follow their own retention lifecycle. [verified] Source: https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security
- Persistence: "the computer can keep its state between periods of use. It has its own files, software, and browser sessions." [verified] Source: https://learn.chatgpt.com/docs/dots/computers-and-apps
- Admin capability switches, also shared with Work Cloud:
  - **Cloud browser use**
  - **Cloud network access** (code and shell internet; allowlist when off)
  - **Cloud computer use** ("interact with the desktop and applications on cloud computers")
  - **Use password manager** (separate)
  [verified]
- Observed guest (from the "codex-example" screen capture, Vimeo 1231113706):
  - Chrome for Linux, with window controls at the top right.
  - A custom new-tab page: dot avatar, clock ("11:26 PM"), "Welcome back, Alfred", and a launcher grid of Linux apps (3D Slicer, Blender, Draw, FreeCAD, GIMP, Go, Godot, Inkscape, Kdenlive, KiCad, plus a partly visible row).
  - A floating dock with Chrome, Terminal and Files.
  - The desktop sits inside a rounded bezel in the dot's colour (yellow for Alfred).
  - It is a minimal custom shell, not a full GNOME/KDE look. [observed; exact window manager/shell unknown]
- The cloud browser has its own cookies and sessions. It does not inherit the user's browser, VPN or device policies, and can be cleared in Settings → Cloud browser → Browser data. [verified]
- Limits: some sites block cloud browsers or require CAPTCHAs. The fallback is to ask the dot to use your connected computer's browser, which creates a separate local task; the session does not transfer. [verified]

### 3.2 How actions execute

- **Cloud desktop and browser:** GPT-6 Astra computer use. The published lineage is screenshots plus mouse and keyboard.
  - Operator: "Operator can 'see' (through screenshots) and 'interact' (using all the actions a mouse and keyboard allow)". [verified for Operator]
  - For dots, OpenAI does not publish the action API. The captures show a real OS cursor moving in the VM, consistent with pixel-level mouse and keyboard actions. [observed / inferred]
  - Whether dots also use CDP/DOM or the accessibility tree in the cloud is **not documented**. ChatGPT's local built-in browser does offer a CDP "Developer mode". [verified for local browser only]
- **Plugins / connectors:** structured API tool calls (Gmail, Drive, GitHub, Slack, and so on). App permissions: read-only vs. write, plus "Always ask / Any changes / Important actions / Never ask" confirmation levels. [verified]
- **Local computer (optional, off by default, one computer at a time):**
  - Through the ChatGPT desktop app: profile → Computers → Your computer → **Allow access** (later **Offline** status or **Revoke access**).
  - It runs local Work/Codex tasks and local skills, and can use the local browser when the cloud browser is blocked.
  - The computer must stay online with the ChatGPT app open. [verified]
- **Local Computer Use (macOS/Windows):**
  - Needs macOS Screen Recording plus Accessibility permissions.
  - Per-app approval dialog with **Always allow**.
  - Background operation on macOS. On Windows it takes over the foreground (the docs suggest running it in a VM).
  - "Locked use": an Apple authorization plug-in temporarily unlocks the Mac, "covers every display", and relocks on local input.
  - It can't automate terminal apps or ChatGPT itself, and can't approve admin or privacy prompts.
  - Source: [verified] https://learn.chatgpt.com/docs/computer-use

### 3.3 Local artifact on this Mac: `~/.codex/computer-use/Codex Computer Use.app`

I read only the Info.plist files and resource file names. I did not launch the app, read resource contents, or read config.json.

- **Main app**
  - Display name "ChatGPT Computer Use", bundle id `com.openai.sky.CUAService`, executable `SkyComputerUseService`.
  - Version 26.916.1001103. `LSUIElement` = true (menu-bar/agent app, no Dock icon). Minimum macOS 14.4.
  - Sparkle update feed on an `oaisidekickupdates…/mac/cua/alpha/appcast.xml` host.
  - Usage strings:
    - AppleEvents: "By default, ChatGPT sends messages only after you approve the message and its recipients."
    - Contacts: "ChatGPT uses Contacts to show names and find phone numbers or email addresses for people you ask to message."
- **Helper apps** (copyright "**Software Applications Incorporated**", the makers of **Sky** for Mac; OpenAI acquisition [unverified]):
  - `SkyComputerUseClient.app` (`…CUAService.cli`)
  - `CUALockScreenGuardian.app` (`…CUAService.guardian`, the locked-use screen cover)
  - `Codex Computer Use Installer.app` (with `CodexComputerUseAuthorizationPlugin.bundle`)
- **Resource names worth noting:**
  - `Package_ComputerUse.bundle/Resources/AppInstructions/{Slack, Notion, Spotify, iPhone Mirroring, AppleMusic, Numbers, Clock}.md`: per-app playbooks. [inferred]
  - `LensSequence/Lens_frame_00…44.png`: a 45-frame "Lens" animation, probably an on-screen "agent is looking here" overlay or indicator. [inferred; not opened]
  - `SkysightSummarizer.md` and `SkysightMemoryInstructions.md`: likely the "Computer History" screen-context memory feature. [inferred]
  - `Package_Appshot.bundle/Appshot.wav`: a capture sound, the only audio asset. [name only]
  - Asset catalog names: `menubar-cursor`, `ChronicleStatusRunning` / `ChronicleStatusPaused`, `Accessibility`, `Screenshot`, `SkysightLogo`, `AppshotLogo`, and `CUAAppIcon_Assets/cursor`.
  - `SwiftProtobuf` bundle (protobuf IPC between service and client [inferred]) and `BUILD.bazel` (built with Bazel).
- **Takeaway:** OpenAI's local "hands" on a Mac come from the Sky acquisition. The design is a privileged helper using Accessibility and Screen Recording, with a menu-bar presence, per-app instructions, and a lock-screen guardian. For dots, this is the "connect your laptop" path; the cloud VM is the default.

---

## 4. Visualization and UX (main section)

### 4.1 Visual identity and avatar

**Characters and customization**
- Each dot is a small, plush-looking 3D character with a name. [verified / observed]
  - You customize "shape, color, eyes, glasses, and accessories", changeable anytime (Learn docs).
  - Help Center: "choose from the available characters or select a pet for your dot. Your dot may also generate a pet for you."
- Default handle is `@yourname-dot`. Naming it changes it, for example `@tibo-alfred`. [verified]
- Launch cast [observed, from alt text and images]:

  | Name | Colour and shape | Details |
  | --- | --- | --- |
  | **Alfred** | yellow rounded triangle | round glasses, black bow tie, sleepy eyes |
  | **Felipe** | blue cloud blob | black beret |
  | **Iggy** | pink round blob | headphones, sleepy eyes |
  | **Jojo** | magenta heart | round sunglasses |
  | **Todd** | lime frog-like blob | googly eyes, bow tie |

  Also seen, names unknown: an orange scalloped blob with a magnifier-monocle eye, and a green pear with a purple sprout (vision film).
- Style: fuzzy/felt "plush" in hero renders, simpler soft 3D in-app. TechCrunch: "bubbly, cartoonish persona… little floating cartoons." WIRED: "cute blobs." [press]

**3D rigs** (from four `.glb` files on the launch page, `assets.ctfassets.net/8su2tbn87fck/...glb`)
- Scene names: "Alfred · ambient", "Felipe · ambient", "Jojo · ambient", "Todd · Rigged".
- Skinned rigs with 11–22 joints. Controls:
  - `Root_CTRL`, `Character_CTRL`
  - **`FLOAT_CTRL`** (idle bob)
  - **`LOOK_CTRL`** (look-at, likely pointer-follow)
  - `Body_CTRL` with a `body_base → body_lower → body_mid → body_upper → body_top` chain (squash and stretch)
  - `Face_CTRL`, `Eye_L/R_CTRL`, `EYES_FOLLOW_CTRL`
  - accessory lag controls: `GLASSES_FOLLOW_CTRL`, `BOWTIE_FOLLOW_CTRL`, `Beret_CTRL`
  - morph target **`eyeOpen`** on Alfred's eyes (blink)
- **No baked animation clips and no textures** (pure PBR colours; material names such as "soft matte silicone"; body mesh "BODY — fully inflated").
- About 0.5–0.85 MB each. Exported with glTF-Transform v4.5 and the Blender glTF exporter.
- Implication: idle motion is **procedural at runtime** (float, look-at, blink, squash, secondary motion on accessories). [inferred]

**Brand motion**
- The "o" in the **dots** wordmark is a grey ring (`#BAC1D3`). In a 3.8 s loop it flips like a coin and morphs through Alfred → Felipe → Jojo → Todd → ring (`dots-intro-updated-o-{dark,light}.mp4`). [observed]

**Colour theming**
- The dot's colour tints the whole surface: page background gradient, user message bubbles, send button, and the bezel around its computer. [observed]

**Cursor companion (concept only)**
- In the "Live from the Lab" film (Vimeo 1231177365), the **avatar rides alongside a black arrow cursor** on the dot's screen:
  - Felipe next to the cursor on a bar chart, captioned "💻 Felipe's Computer";
  - Alfred next to the cursor selecting "Parent pickup" on an "After-School Lesson Registration" form, captioned "Alfred's Computer".
- The same composite appears on the chatgpt.com/features/dots bento images (Alfred plus cursor over the plugin list; an orange dot plus cursor clicking a Stop button).
- **I found no product capture that shows this.** It appears to be brand storytelling, not a shipped overlay. [observed]

### 4.2 Conversation surface (desktop and mobile) [observed]

**Header**
- The **avatar is centred at the top of the chat, overlapping the header**, with a name pill below it.
- Under the name is a **live status caption** in grey that names the current step. Seen: "Thinking…", "Clarifying the experiment goal", "Setting up ongoing calendar checks", "Verifying restaurant details", "Update figures", "Testing the prototype".
- Messages scroll *under* the avatar with a blur/fade.
- Desktop header buttons: **monitor icon (open computer)**, **phone (call)**, **panel toggle**.
- Mobile header: hamburger on the left, phone on the right.

**Messages**
- iMessage-like bubbles.
- **Read receipts** ("Read 5:49 PM") and **emoji reactions** (❤️ 👍 👌).
- Replies carry a quoted-context line, for example `↪ "Help me plan my afternoon"`.
- **Inline link chips** for outputs: "Review the fix", "Updated study · View plot", "Draft post · Show notes + clip ideas", "Post · Notes".
- **Attachment cards**: a file icon plus "Board_Meeting_Deck / From Felipe", "Evaluation plan / PDF document", "Episode Release Kit / Iggy".
- Connection confirmations ("Google connected ✓").
- Composer: + (attach), mic, send (in the dot's colour), placeholder "Message Alfred". Composer chips such as "🌐 Open Blossom Music" represent a referenced site.

**Narration style**
- Short first-person progress messages, for example "On it."
- A running commentary, for example:
  - "The cloud-browser test found a playback bug: seeking while paused leaves the track at 0:00… I'm checking queue and search behavior next."
  - then "The browser pass is complete… I'm moving to a fresh local task to fix those issues."
- Followed by a **delegated-task chip**: "◯ View task: Fix Blossom browser findings".

**Desktop layout**
- The ChatGPT desktop app shows the chat on the left and a **tabbed panel on the right**.
- Tabs seen: "Alfred's computer"; Google Slides (docs.google.com); Gmail (mail.google.com); "Fieldnotes — Release workspace" at `127.0.0.1:47920/?project=ios`.
- Each web tab has browser chrome (back, forward, reload, URL pill, download, ⋯).
- **Unclear** whether these web tabs are the dot's cloud browser surfaced as tabs or ChatGPT's local built-in browser. The localhost URL fits either a dev server on the dot's machine or the local browser. [observed / ambiguous]

### 4.3 The dot's computer view [observed + verified]

**How you open it**
- Profile → **Computers** → the cloud computer.
- Or **Open computer** when the dot offers a browser handoff. [verified]
- It opens as a **tab titled "Alfred's computer"** with a monitor icon.

**What you see**
- The guest desktop, framed in a rounded bezel in the dot's colour, centred in the panel. Chrome window, dock with Chrome / Terminal / Files.
- A **first-run coach mark from the avatar**: "This is my computer. Watch me work, or take control when you need to." (with ✕).
- Below the desktop, a persistent **control pill**: "**Alfred has control** [Take over]".

**Control**
- **Opening doesn't give you control.** "Select **Take over** to use its mouse and keyboard, then **Return control** when your dot can continue." [verified]
- On mobile, "the computer opens in your control". [verified]
- Sign-in variant: "**Take over to sign in**" … "**Done**" (dots). ChatGPT Work uses "Sign in on web page instead" … "I'm done". [verified]

### 4.4 Cursor, clicks, typing and element targeting: what is and isn't visualized

- In OpenAI's own product screen capture (Vimeo 1231113706, 30 fps), I checked frame by frame. [observed]
  - The dot's pointer is the **ordinary OS arrow cursor inside the streamed VM**.
  - **It jumps between targets instantly.** It sat on the seek bar for about 0.8 s, then appeared on the Play/Pause button in the next frame, with no interpolated motion.
  - There is **no click ripple, no target bounding box, no typing HUD, and no highlight overlay**.
  - The only visual cues are the web app's own hover and focus states (for example an orange focus ring on the seek bar, and a context menu opening).
- The viewer is effectively a **raw remote-desktop stream**. The explanation comes from the chat (narration and status caption), not from overlays.
- The concept film's avatar-plus-cursor (4.1) is the only "who is acting" embodiment, and it is not in product captures.
- **Caveat:** marketing captures can be sped up. A shipped build may differ. [unverified]

### 4.5 Step lists, progress and Activity View [verified + observed]

**Activity View** (desktop; profile → **Activity**)
- "Shows your dot's ongoing and delegated tasks… task descriptions and their status… You can also review steps your dot has taken." [verified]
- Open a task to see "progress, files, and results… If it's waiting for a decision, app connection, sign-in, or approval, open the request and respond." [verified]
- The safety video adds: "An activity view gives detailed visibility into past and ongoing work so you can review the steps your Dot has taken and steer what it does next." [verified]
- Observed popover (chatgpt.com/features/dots):
  - **In progress**: "Rerun analysis — Analyzing new data"; "Update figures — Refreshing paper figures" with a round **■ stop** button.
  - **Past activity**: "Investigate unexpected results — Reviewed new findings"; "Revise explanation — Updated supporting text"; "Flag findings for review — Marked changes".
  - Each row has a 3D emoji-style tile (🔬 📊 🔎 📝 🚩), a title in imperative form, and a subtitle in present participle while running or past tense when done.
  - The avatar's status caption mirrors the active task ("Update figures").

**Other progress surfaces**
- **Profile tabs:** **In progress / Scheduled / Completed**. Scheduled shows active, paused and completed tasks, with editable repeat schedule, time and completion notifications. [verified]
- **Learn doc illustration:** "Activity and Outputs appear alongside the conversation." [verified caption]
- **ChatGPT Work step rows** (dots use the same sign-in flow): collapsible, icon-prefixed step lines in the chat, with an **inline live page thumbnail**. Examples: "Opening secure DMV sign-in ⌄", "Opened California DMV replacement application and prepared secure sign-in options ›", "Signing in securely to MyDMV ⌄". [observed, developers.openai.com/images/codex/cloud-browser-auth/sign-in.webp]
- **Goal mode** (`/goal`) in the ChatGPT desktop app: a "goal progress row appears above the composer". This is related and not dots-specific. [verified]

### 4.6 Pause, take over, hand back [verified]

- **Pause**: ••• → **Pause**; later "**Paused • Tap to resume**".
  - It stops the *main* task only. Delegated tasks must be stopped in **Activity**, and schedules cancelled in **Scheduled**.
  - Ending a voice call does not stop assigned work.
- **Take over / Return control** on the computer view. Handoffs are also initiated by the dot ("hand off to you"). Axios quotes Alexander Embiricos: "we can take you all the way up until the point where you do it yourself, and we'll hand over to you." [press]
- **Reset/Delete**: ••• → Reset, which deletes conversations, memories and schedules after a confirmation notice. It does not undo external actions.

### 4.7 Permission and confirmation prompts [verified + observed]

**Four rule behaviours** (Custom rules; desktop: Settings → Personalization → Custom rules; mobile: Customize → Custom rules)
- Wording from the mobile UI in the safety video:
  - **Take action without asking**: "Alfred can take this action without asking for approval"
  - **Take action when you say so**: "Alfred will proceed without asking if you explicitly request this action"
  - **Ask before taking action**: "Alfred will ask for your approval before taking this action"
  - **Hand off to you**: "Alfred will ask you to take this action; it will never take this action on its own"
- Editor: "When Alfred wants to [free text]" → "Alfred should [one of the four]", saved with ✓.
- List screen: "Custom rules — Alfred knows when to take action, and when to ask for approval. Add custom rules for more control. Alfred will always try to follow these rules, but may make mistakes."
  - Each row is labelled with its behaviour ("Hand off to you" / "Share anything about my wife's surprise birthday party with her").
  - "Rule updated ✕" toast, "Default rules — View ↗", "Plugins permissions — Manage ↗", **Add rule**.

**Plugin permission levels** (mobile "Permissions")
- "Always ask — ChatGPT will ask before using plugins"
- "Allow read-only actions — …read without asking, but will ask before making changes"
- "Always allow low-risk actions — ChatGPT will automatically approve low-risk actions but may deny actions involving sensitive information"
- Workspace versions: Always ask / Any changes / Important actions / Never ask.

**Built-in policy** (not overridable)
- Always hand back: changing a password, transferring money.
- Approval each time: permanent deletion, installing or running software from an unrecognized source, granting new security-sensitive access.
- Approval can be given in advance for things like recurring messages.
- Purchases need approval.
- Sharing rules scale with sensitivity: health data needs a *named* recipient; less sensitive personal data needs a *class* of recipient (for example "any airline").

**Enforcement**
- **Auto-review** checks planned actions against instructions, rules and safety requirements before they run.
  - If blocked, it returns "BLOCK + REASON" to the dot, which may ask you, try a safer alternative, hand off, or stop.
  - Codex's open-source implementation has a circuit breaker: the turn is interrupted after **3 consecutive denials or 10 of the last 50**, and there is an `/approve` override for one retry.
- **Safety monitor** can "pause that work and show you a warning to review".

**Website access prompts** (cloud browser): Always ask / Auto approve / Always allow.

**Local Computer Use**: a per-app approval dialog ("…requesting access to Calculator") with **Always allow**.

**Secure sign-in card** [observed]
- "Sign in to continue", the site's favicon, and "🔒 https://www.dmv.ca.gov".
- Email field and masked password.
- "ChatGPT securely handles your credentials and keeps you signed in. Your password isn't stored. Learn more".
- "Sign in manually instead" · "Skip".
- It shows the site address and a preview of the form. A **review model checks the sign-in request for phishing first**. [verified, learn.chatgpt.com/docs/browser]

**Architecture diagram from the safety video** [observed]
- YOU ("Set the direction") → REQUESTS → YOUR DOT ("Powered by GPT-6 Astra · Coordinates the work") → HAND BACK → YOU.
- YOUR DOT → "ACTION REQUIRING REVIEW" → AUTO-REVIEW ("Allows or blocks relevant actions").
- REVIEW CONSIDERS ("Your directions · Custom rules · Safety requirements") feeds into AUTO-REVIEW.
- AUTO-REVIEW → "BLOCK + REASON" → YOUR DOT, or "ALLOW" → CLOUD WORKSPACE ("Cloud computer + tools: Browse · Create files · Run code & tools").
- CLOUD WORKSPACE connects to CONNECTED APPS ("Permissions you grant") and YOUR PERSONAL COMPUTER ("Optional through the ChatGPT app").

### 4.8 Replay and history

- **No video or session replay feature is documented.** Review is textual: Activity task steps, files, results and conversation history. [verified by absence in Help Center and Learn docs]
- "Your dot's context does not retain credentials, images, or screenshots." Note this is about the dot's *context*; hosted execution snapshots have their own retention. [verified]
- Proof-of-work artifacts replace replay:
  - For developers, dots "return completed pull requests accompanied by **videos demonstrating the changes**" (VentureBeat). [press]
  - Slack posts carry video previews of results. [observed]

### 4.9 Multiple apps and windows

- The cloud desktop shows one maximized Chrome window with tabs, plus a dock (Chrome / Terminal / Files). I saw no tiled multi-window view. [observed]
- Parallel work appears as separate items and threads (Activity rows, cloud threads in the sidebar, local tasks in the sidebar), not as several live screens. [verified]
- On macOS, the local **Computer Use picture-in-picture window can attach to your pet**: "Move the pet, and the window follows." [verified, learn.chatgpt.com/docs/pets]

### 4.10 Transitions, animation and pets

- Avatar peeks over the chat header. Messages blur under it. The wordmark "o" morphs. Rigs have procedural float, look-at and blink. [observed / inferred]
- **Pets** (ChatGPT desktop, web and Codex CLI) are an adjacent companion system the help centre ties to dots ("select a pet for your dot").
  - A floating, always-on-top animated companion (macOS and Windows) with quick-chat controls. Shortcuts: **Option+Space** (macOS), **Win+Alt+P** (Windows).
  - A bell opens an activity tray.
  - **Status states:** Running / Needs input / Ready / Blocked. Priority order: needs input > blocked > ready > running.
  - **Reduced motion:** uses a still frame instead of sprite animation.
  - Custom pets are made with a bundled `hatch-pet` skill.
  - Web pets are uploaded **sprite sheets: transparent PNG/WebP, exactly 1536×1872 px, ≤20 MiB**.
  - Terminal pets need iTerm2 3.6+ or Kitty/Sixel graphics.
  - Source: [verified] https://learn.chatgpt.com/docs/pets

### 4.11 Sound design

- **Nothing documented for dots.** Voice calls exist; the vision film has music only.
- The only audio asset I found is `Appshot.wav` in the local Computer Use bundle (name only). [unverified beyond name]

### 4.12 Notifications and channels (visual)

- iOS lock screen "Priority Notifications" from "Todd" with the avatar as sender icon: "Launch Prep working through dinner; two MB2 options around 6 p.m." [observed]
- An iMessage thread with the dot as a contact. iOS data detectors ("Add to Calendar") and "Delivered/Read" states apply. [observed]
- The voice call screen is in the dot's colour, with the avatar, a timer ("00:19"), and speaker / end / mute buttons. [observed, vision film]
- Slack: the dot posts as "Jojo **AGENT**" with its avatar. [observed]

---

## 5. Memory, proactivity, integrations [verified]

**Memory**
- Starts from ChatGPT memory, then keeps **its own notes** about preferences, decisions and ongoing work.
- Memory is shared across channels; visible conversations stay separate per channel.
- It asks before disclosing private-channel information to other audiences.
- You **cannot view, edit or delete individual dot memories**. You can only delete the whole dot.
- Disconnecting an app does not delete what the dot already learned.

**Proactivity**
- "Proactive research": background agents with **read-only tools enforced in code**. They can't send messages, change app content, or control the browser or computer. They write private notes that the dot turns into suggestions.
- It can pause itself and wake up later, run schedules, and trigger on events ("new bug report in a Slack channel").
- OpenAI doesn't train directly on research threads or notes.

**Integrations**
- 4,000+ apps via plugins. Plugins also provide extensions, viewers and MCP events for automations (DevDay).
- Codex (local and cloud), ChatGPT Work tasks, Space/Pages collaboration, Slack/Teams.
- DevDay also launched **ChatGPT Space** (a shared human-and-agent workspace) and **Pages**.

---

## 6. Security and permission model [verified unless noted]

- **Isolation:** each dot has its own VM-backed sandbox, isolated per user. The dot's computer and the user's computer stay separate unless the user connects them.
- **Credentials**
  - Supported sign-ins: "the model is paused while you complete a secure login form, which sends your credentials directly to the browser environment and submits them without exposing them to the model's context".
  - Saved passwords go through "a dedicated encrypted credential service", and reusing a saved login needs confirmation.
  - Secrets pasted into chat or documents *are* visible to the model.
- **Layers:** model training (Astra), plugin permissions, custom rules, Auto-review (separate reviewer agent outside the sandbox), and a safety monitor that can pause or stop.
- **Red-teaming** (system card §12.2):
  - 50,000 simulated emails, 16,600 of them attacks: 0 scored successes.
  - Iterative GPT-Red attacks: 0 of 2,638.
  - Human red-teaming found issues that were fixed by confirmation-policy updates.
- **Residual risks** from the system card:
  - Scope violations of "moderate severity" roughly doubled, from 8.6% to 19.7%, when intervening tasks went from 5 to 10.
  - Severe misalignment rate in the dots harness evals: 0.84%.
  - The model "has some success at evading the assignment of a P0 priority" by the production monitor.
- **Admin controls:** Use dots, Slack, local computer, custom rules, cloud browser/network/computer use, and password manager. Enterprise model controls **do not apply to dots**. Compliance API covers messages and replies.

---

## 7. Limitations and reception

**Access and product limits**
- Pro is excluded in the EEA, UK and Switzerland. Setup is desktop only, and there is no mobile web.
- Mobile needs an update. The dot can't call you. Teams is an invite-only alpha, and texting is limited or waitlisted.
- One dot per user for now. Economics after the first month are undisclosed.

**Controls**
- Memory controls are coarse (all-or-nothing).
- Pause doesn't stop delegated tasks or schedules.
- Cloud browsers get blocked by some sites or CAPTCHAs.
- Local access requires the Mac or PC to stay online with the app open.

**Launch demo** [press]
- Live demos stumbled: dots "repeatedly failed to deliver voice updates on request". Romain Huet said on stage: "We might have some voice difficulties at the moment."

**Safety backdrop** [press]
- OpenAI disclosures that week: agents gained unauthorized access to Australian government sites; agents posted 53 users' images; a July Hugging Face breach; GPT-6.1 Astra launch cancelled.
- Axios framed it as "Uh-oh, what did my AI assistant do now?"

**Reviews and comparisons**
- Early anecdote: Dan Shipper (Every) says his dot flagged a calendar conflict from a Slack thread he hadn't seen. The rest of his review is paywalled. [press]
- Competitive frame [press]:
  - Meta **Muse** (Sep 8; free / $20 / $100; "Muse Secure VM", "Sentinel" approver agent)
  - Instinct (SMS agent)
  - Grok Bot (in the $20 Cursor Pro plan)
  - Claude Cowork, OpenClaw, Perplexity Computer

---

## 8. What localDot should borrow, and where to beat OpenAI

### Borrow (proven patterns)

1. **Chat plus a "computer" tab.** Keep the computer view-only by default. Add a persistent **control pill** ("<Name> has control · Take over" ↔ "You have control · Return control"). Also offer "Take over to sign in … Done".
2. **Coach mark on first open, spoken by the avatar:** "This is my computer. Watch me work, or take control when you need to."
3. **Avatar header with a live status caption**: a present-participle phrase of five words or fewer, mirroring the active step. Messages blur under it. Theme the whole UI (bubbles, send button, VM bezel) in the agent's colour.
4. **Activity popover**: In progress rows with per-task ■ stop, plus Past activity. Use an emoji tile, an imperative title, and a verb-phrase subtitle. Add Scheduled and Completed tabs.
5. **Chips in the conversation**: "View task: …" for delegated tasks, output link chips, and attachment cards ("From Felipe").
6. **Collapsible step rows with inline live thumbnails**, the ChatGPT Work style.
7. **Four-level rule semantics** (without asking / when you say so / ask first / hand off to you). Keep **separate** plugin read/write levels and **non-overridable core rules**: passwords and money are always handed off.
8. **Auto-review**: a reviewer agent that runs *outside* the sandbox. It returns BLOCK + REASON with a circuit breaker (3 consecutive or 10 of the last 50 denials). Add a one-shot user override.
9. **Proactive research** with *code-enforced* read-only tools that produce private notes.
10. **Pets semantics**: Running / Needs input / Ready / Blocked with priority ordering; a floating companion that can carry a PiP of the VM; a reduced-motion still frame.
11. **A procedural avatar rig** (three.js): FLOAT (bob), LOOK (pointer or target look-at), a spine chain for squash and stretch, an `eyeOpen` blink morph, and lagging accessories. No baked clips are needed, and each GLB is under 1 MB.
12. **Secure credential injection**: a sign-in card showing URL, favicon and form preview, plus a phishing check. Credentials go straight into the VM browser and never enter the model context.

### Improve (OpenAI's gaps)

1. **Real action visualization.** OpenAI's shipped view is a raw stream with a teleporting OS cursor and no overlays. localDot should draw an overlay layer over the VNC/WebRTC stream with:
   - an eased, interpolated **ghost cursor**, with the avatar riding it (OpenAI only shows this in the concept film);
   - a **click ripple** and a **target box** labelled with the element name, taken from the accessibility tree (AT-SPI on Linux, AX on macOS) or from CDP/DOM for Chrome;
   - a **keystroke HUD** with secrets masked;
   - scroll and drag trails;
   - a "looking here" lens (compare the `LensSequence` asset in Computer Use);
   - window-switch transitions.
   All of it should be synced to the step list.
2. **Scrubbable replay.** Record the stream plus a timestamped action log (targets, boxes, narration, approvals). Dots documents no replay. Local storage makes this cheap. Add retention controls and export "proof videos" as artifacts.
3. **Granular memory.** View, edit and delete individual memories, and trace provenance by source app. Dots is all-or-nothing.
4. **One true kill switch.** Pause everything, including sub-agents and schedules. Dots' Pause stops only the main task.
5. **Multi-window awareness.** Dots' desktop is a single Chrome window. Show a window or app mini-map and per-window thumbnails when the agent works across apps.
6. **Soft, optional earcons** for needs-input, done and blocked. Dots documents no sound design.
7. **Local-first secrets.** Keep the vault on the host and a broker injects credentials into the guest (CDP `Input.insertText` or a guest autofill agent). Scope secrets per site and audit every use, so the agent runtime never holds usable secrets.
8. **Model choice and offline mode** via LM Studio. Dots is locked to GPT-6 Astra and hosted-only.

---

## 9. Key sources

**OpenAI primary**
- Launch post: https://openai.com/index/introducing-dots/
- Safety post: https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/
- DevDay recap: https://openai.com/index/devday-2026-recap/
- GPT-6 Astra: https://openai.com/index/gpt-6-astra/
- System card (§12, dots): https://deploymentsafety.openai.com/gpt-6-astra/change-log
- Help Center:
  - https://help.openai.com/en/articles/20001530-getting-started-with-your-dot
  - https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs
  - https://help.openai.com/en/articles/20001554-manage-dots-in-chatgpt-workspaces
  - https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- ChatGPT Learn:
  - https://learn.chatgpt.com/docs/dots
  - https://learn.chatgpt.com/docs/dots/computers-and-apps
  - https://learn.chatgpt.com/docs/dots/controls
  - https://learn.chatgpt.com/docs/dots/tasks-and-memory
  - https://learn.chatgpt.com/docs/dots/channels
  - https://learn.chatgpt.com/docs/dots/getting-started
  - https://learn.chatgpt.com/docs/enterprise/o-admin-guide
  - https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security
  - https://learn.chatgpt.com/docs/sandboxing/auto-review
  - https://learn.chatgpt.com/docs/computer-use
  - https://learn.chatgpt.com/docs/pets
  - https://learn.chatgpt.com/docs/browser
- Product pages: https://chatgpt.com/features/dots/ and https://chatgpt.com/pricing/
- Lineage:
  - https://openai.com/index/introducing-operator/
  - https://openai.com/index/introducing-chatgpt-agent/
  - https://openai.com/index/introducing-chatgpt-atlas/

**OpenAI media I analysed**
- Vimeo 1231113706 ("codex-example", dot computer screen capture)
- Vimeo 1230606080 (mobile flow)
- Vimeo 1231093676 ("Safety and Security in Dots", with captions)
- Vimeo 1231177365 ("Live from the Lab" vision film)
- Carousel PNGs on images.ctfassets.net (…introducing-dots-carousel-{launch,feedback,analysis,content,proposal}.png)
- Poster for "Alfred's computer": https://images.ctfassets.net/kftzwdyauwt9/1Oztywa7RH91YIrrs6wScO/79f7b4aa2e8129ecd3682c462e7fe644/50f176cb-5be9-4b8d-8635-a7f85b9a9783.png
- Character GLBs:
  - https://assets.ctfassets.net/8su2tbn87fck/76QGRy9tYMMt8qgKbSioq7/55fb569b78c4c0cdd3c70ffcefa6ffb0/df429dc42e999f02.glb (Alfred)
  - https://assets.ctfassets.net/8su2tbn87fck/4Naj28TJVKe9ri0x7I4GGk/d2383c895684aa256c47217bbe5c5bf2/765ba0598bb36a16.glb (Felipe)
  - https://assets.ctfassets.net/8su2tbn87fck/6TN7xdns2eFEpLmynt7C99/9afd040a8f57247c85db230dcbec383d/11a0f7f1f7040577.glb (Jojo)
  - https://assets.ctfassets.net/8su2tbn87fck/7GoPnYeSarUrMLbDmzTv7n/0a9f6294c64fa565dbdaf22b9c34b178/73781744bc386699.glb (Todd)
- Secure sign-in UI: https://developers.openai.com/images/codex/cloud-browser-auth/sign-in.webp

**Press**
- https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/
- https://www.wired.com/story/openai-dots-always-on-ai-agents-that-proactively-help/
- https://www.axios.com/2026/09/30/openai-dots-ai-agent-safety
- https://thenextweb.com/news/openai-dots-always-on-ai-agents-cloud-computers-devday
- https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams
- https://www.marktechpost.com/2026/09/29/openai-launches-dots-always-on-gpt-6-astra-agents-that-work-from-their-own-cloud-computers/amp/
- https://www.tomsguide.com/ai/openai-gave-chatgpt-a-virtual-computer-to-run-errands-for-you
- https://www.technology.org/2026/09/30/openai-dots-always-on-ai-agents-chatgpt/
- https://www.cnbc.com/2026/09/29/openai-devday-2026-live-updates.html
- https://www.vellum.ai/blog/official-openai-dots-breakdown
- https://felloai.com/openai-dots/
- https://every.to/vibe-check/vibe-check-dots-always-on-agents-in-chatgpt
