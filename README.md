<p align="center">
  <img width="80" src="docs/readme/dot.png" alt="dot, a small white ball with two dark eyes">
</p>

<h1 align="center">localDot</h1>

<p align="center">
  An AI assistant that runs a Linux desktop on your computer. Watch and control it from your browser.
</p>

<p align="center">
  <a href="LICENSE">MIT licensed</a> · Alpha · macOS, Linux and Windows (WSL 2)
</p>

## Install

The installer downloads prebuilt packages. You do not need a GitHub account or a local copy of this repository.

**macOS (Apple silicon) or Linux (x64)** — open Terminal:

```sh
curl -fsSL https://downloads.localdot.dev/install.sh | bash
```

**Windows** — open PowerShell:

```powershell
irm https://downloads.localdot.dev/install.ps1 | iex
```

Keep the terminal open until setup prints your app link. The installer checks Docker and offers
to install missing dependencies. On Windows, it also guides you through WSL, Ubuntu, and Docker
integration. Follow any prompts, then open the link and choose a model.

Already installed? `localdot update` installs the latest release and keeps your data.
`localdot open` prints a fresh sign-in link. Open a new terminal if the command
is not found. The current alpha includes Apple silicon Mac and Linux x64 packages; Windows uses
the Linux package through WSL 2. Clean native Windows installation remains to be verified.

[Installation guide](docs/install.md) · [Releases](https://github.com/Shadowhusky/localdot/releases) ·
[Use your phone or a server](docs/install.md#servers-without-a-screen) · [Run from source](docs/development.md#development)

## About

localDot gives an AI agent a Linux desktop with a browser, terminal, and desktop apps. The
desktop runs in Docker on your machine; the interface opens in your browser. Ask dot to work
on a task, watch its progress, or take control yourself. Recordings let you review what happened.

Conversations, files, and recordings are stored locally. You can use a provider API, a supported
subscription, or a local model. Hosted models receive screenshots and task context. Results
depend on the model and the task.

Credentials are managed by a separate local service. Permission settings control which
actions need your approval. This is alpha software: expect bugs and review work before
relying on it.

## What dot can do

<picture>
  <source media="(max-width: 600px)" srcset="docs/readme/capabilities-mobile.svg" type="image/svg+xml">
  <source media="(max-width: 600px)" srcset="docs/readme/capabilities-mobile.png">
  <source srcset="docs/readme/capabilities.svg" type="image/svg+xml">
  <img width="100%" src="docs/readme/capabilities.png" alt="Pencil sketch of eleven things dot can do: use the screen, a web browser that keeps your sign-ins, a terminal, files, web search for web, images and news, deep research with numbered sources and a cited report, voice, your apps as tools, routines on a schedule, a memory you can edit, and asking you before it acts as you.">
</picture>

[Open the full-size drawing](docs/readme/capabilities.svg).

The tour below shows the interface. Links below each image open the full-size version.

## A quick tour

> Screenshots use sample data. On a phone, tap a screenshot to open its full-size view.

[Watch](#watch) · [Activity](#activity) · [Research](#search-read-and-research) ·
[Models](#models-and-usage) · [Permissions](#permissions-and-sign-in) ·
[Connectors](#connectors) · [Phone](#on-your-phone) · [Replay](#replay-and-export) ·
[Routines](#routines) · [Settings](#first-run-and-settings)

### Watch

<picture>
  <source media="(max-width: 600px)" srcset="docs/readme/watch-mobile.png">
  <img width="100%" src="docs/readme/watch.png" alt="The live computer, task progress and chat; phones show the phone layout">
</picture>

[Open desktop screenshot](docs/readme/watch.png) · [Open phone screenshot](docs/readme/watch-mobile.png).

Watch the live desktop alongside the conversation. **Stop** ends the current run without
shutting down the computer. **Take control** lets you use it yourself.

Use **Panels** to show or hide Chat and Activity. Panel sizes, visibility and selected tabs
are saved in your browser. Background commands appear in a floating **command window** that
you can move, minimize or hide. It shows the existing activity feed and stays outside the
computer recording.

<a href="docs/readme/work.png"><img width="100%" src="docs/readme/work.png" alt="The floating command window over the app shows command output; pictured with sample test output"></a>

<a href="docs/readme/panels.png"><img width="100%" src="docs/readme/panels.png" alt="The Panels menu offers Hide chat and Hide activity; Files is selected in the resizable Activity panel"></a>

While dot is running, the empty message box shows **Stop**. Start typing and it changes to
**Send**. New messages wait until the current task finishes; choose **Steer now** on a queued
message to send it immediately, or **Edit** to move it back to the input before resending.
Stopping also cancels queued messages.

<a href="docs/readme/queue.png"><img width="100%" src="docs/readme/queue.png" alt="A queued message marked After this task, with a Steer now button and Stop in the empty composer"></a>

Open earlier conversations from the history menu, or use each conversation’s actions menu
to delete it. History remains available while you hold control. Sending a new instruction
hands control back to dot.

<a href="docs/readme/conversations.png"><img width="100%" src="docs/readme/conversations.png" alt="Recent conversations with a separate actions menu offering Open conversation and Delete conversation"></a>

### Activity

<a href="docs/readme/activity.png"><img width="100%" src="docs/readme/activity.png" alt="The Activity tab: a compact plan strip reading 1 of 4 with the current and next item, Steps and Files tabs, the step list with timings and results, and a usage line with the model and tokens"></a>

The plan shows the current step and progress. Open **Steps** for recorded actions, timings,
errors and blocked requests. **Files** lists task outputs; research tasks also have **Sources**.
Model usage and estimated cost are in the reply’s metadata.

The panels are yours to size. Drag the edge between the picture and the side panel, double-click
it to reset, or focus it and use the arrow keys. localDot remembers the width.

### Search, read and research

<a href="docs/readme/research.png"><img width="100%" src="docs/readme/research.png" alt="Two Activity panels from a research task. Left: steps such as Searched the web for air source heat pump performance, Read energysavingtrust.org.uk, Reading a PDF from nrel.gov and Searched the news. Right: the Sources tab with six numbered sources, their sites and passages, 6 of 20 read, and Wrap up now"></a>

dot can search the web, images and news, and read pages without opening a browser window.
These requests use public sources without your browser sign-ins. Pages and search results
are passed to the model as untrusted content.

For a bigger question, turn on **Research** in the message box (dot suggests it when a question
reads like one). dot splits the question into a few smaller ones, reads widely, and numbers every
page it reads as a source. It stops at 20 sources or 15 minutes unless you change that in
Settings, and you can tell it to wrap up early or keep going. You get a report with citations,
as Markdown and as a PDF, with the passages it quoted from each source.

### Models and usage

<a href="docs/readme/models.png"><img width="100%" src="docs/readme/models.png" alt="Left: the model menu from the message box, grouped as Anthropic, OpenAI, Claude Code and ChatGPT plan, with Manage models at the bottom. Right: a finished turn's line, Claude Sonnet 5.5 · 25.1K tokens, opened to show each model's tokens in and out"></a>

The chip in the message box names the model doing the work. Open it to pick from every model
you've set up, grouped by provider and plan; **Manage models…** at the bottom takes you to
Settings. Configuring another provider keeps the models you already added. A switch applies to
the next task; the running task keeps its model. If a task is held by a model or credit limit,
choose an available model and **Continue** retries with that selection.

Open a reply’s metadata to see its model, token usage and cost. Estimates are labeled.

### Talk to it

<a href="docs/readme/voice.png"><img width="100%" src="docs/readme/voice.png" alt="Settings, Voice: speech to text on this device after a one-time download, language, allow online speech (off), read replies aloud (off), and a note that your voice is never saved"></a>

Hold the mic in the message box, or press ⌥Space (Ctrl+Shift+Space off a Mac), and talk. Your
words land in the message so you can check them before you send. The speech is turned into text
on your device when the browser can do it, or by a whisper.cpp model you already have on your
machine. The browser's online speech service is only used if you allow it. dot can also read its
replies aloud in your device's own voice. Cancel recording or dismiss a microphone notice to
return to the message controls. localDot does not save the microphone recording.

### Permissions and sign-in

<a href="docs/readme/approval.png"><img width="100%" src="docs/readme/approval.png" alt="An approval card over the computer: Send this as you? with the target, the site, and buttons for Don't send and Send"></a>

The shield in the message box opens **Permissions**:

- **Custom** follows your autonomy and tool settings, including the Balanced and Careful presets.
- **Auto** lets Jev review routine actions, asking you when it cannot approve them.
- **Full access** runs actions without routine confirmation, while destructive actions still ask.

<a href="docs/readme/permissions.png"><img width="100%" src="docs/readme/permissions.png" alt="Permissions menu in the chat composer: Custom, Auto and Full access, each with a short explanation"></a>

Under the default Custom/Balanced settings, sending as you, paying, uploads and account changes
ask first. The card says what will happen, and eligible answers can cover this once, the task,
the site or always. Network isolation and private credential handling apply in every mode.

<a href="docs/readme/ask.png"><img width="100%" src="docs/readme/ask.png" alt="dot asks for a sign-in inside the chat: username and password fields, with a note that dot types the password into the site and never sees it"></a>

When dot needs a sign-in, the form shows up in the chat (or as a sheet on your phone). You type
your account and password. localDot saves supported browser logins in its protected local
vault, fills the verified sign-in form and submits it. Later tasks can reuse the saved login
for the same HTTPS site without asking again. The password stays out of model input and
conversation logs. Saved accounts are also reused on username-first pages; missing or rejected
fields are requested separately. Authenticator, email, SMS, and recovery codes use private inputs
and are never saved as passwords. Device approval, passkeys, security challenges, and unsupported
forms may still need you; a handoff tells you why. Connected-app access and website sign-ins are
separate: dot uses the access already available for the kind of work requested. See [browser sign-ins](docs/browser-workspace.md#sign-in-once).

### Take over any time

<a href="docs/readme/control.png"><img width="100%" src="docs/readme/control.png" alt="You're in control: the island shows Hand back, dot waits under the picture, and a toolbar offers keys, typing and full screen"></a>

Press **Take control** to use the mouse, keyboard or paste text. Agent interaction and
recording pause until you hand control back. Full screen is one
click away when you want the whole display. Conversation history stays available during takeover.

### Connectors

<a href="docs/readme/connectors.png"><img width="100%" src="docs/readme/connectors.png" alt="Settings, Connectors: GitHub with its tools listed one by one, each set to Just runs, Asks first or Off, and Linear waiting for a sign-in"></a>

Connect GitHub, Linear, Notion, Sentry, Brave Search, or DeepWiki in **Settings → Connectors**.
You can also add an MCP server by URL or command. dot can then call its tools directly.

Set each tool to **Just runs**, **Asks first**, or **Off**. With Custom permissions, reads run
without approval and changes ask first by default. Credentials are held by keyd and sent only
to the connected service. Command-based connectors run in separate containers without access
to your host files.

### On your phone

<a href="docs/readme/phone.png"><img width="100%" src="docs/readme/phone.png" alt="Three phone screens: watching a task, a sign-in sheet, and Replay with the plan strip and step list"></a>

The phone layout has a compact message box and full-screen computer view. Connect through
Tailscale or enable the optional relay in Settings. Notifications depend on your browser and
notification permissions.

### Replay and export

<a href="docs/readme/export.png"><img width="100%" src="docs/readme/export.png" alt="Replay with the Export video sheet: a preview with dot under the picture, a filmstrip with trim handles, and the Quality, Fast and Showcase presets"></a>

Computer tasks are recorded locally, except while you hold control. Scrub through a recording,
compare the screen before and after a step, or skip idle time. Trim a section and export it with
**Quality**, **Fast**, or **Showcase** settings. Showcase includes dot and its captions. Exports
run on the host computer and continue if you close the browser tab.

### Files and revisions

<a href="docs/readme/done.png"><img width="100%" src="docs/readme/done.png" alt="A finished task: the summary, two files with inline previews, a start and an end screenshot, Watch replay, and a quiet line with the model and tokens"></a>

Files appear in the conversation with previews for images, documents, code, spreadsheets,
audio, and video. Use **Revise** to request a change; earlier versions remain available to
compare. Documents and slide decks open in a viewer with page thumbnails.

Readable text files can be previewed even with an unfamiliar extension. Unsupported files
remain downloadable; a failed preview offers **Try again**.

### Routines

<a href="docs/readme/routines.png"><img width="100%" src="docs/readme/routines.png" alt="Left: dot proposes a routine called Morning bills in the chat. Right: the Routines list with schedules"></a>

Schedule recurring tasks, such as checking a set of sites each weekday. You can create a
routine yourself or ask dot to set one up. Routines require localDot to be running and use
your permission settings, including how to handle requests while you are away.

### First run and Settings

<a href="docs/readme/onboarding.png"><img width="100%" src="docs/readme/onboarding.png" alt="The welcome screen: Hi, I'm dot, with three promises and a Get started button"></a>

Setup walks you through a model, a key or a sign-in, how careful dot should be, and turning the
computer on. You can skip setup and return to it in Settings.

<a href="docs/readme/settings.png"><img width="100%" src="docs/readme/settings.png" alt="Settings: models, autonomy, always allow, spending, appearance, voice, notifications, what dot knows, accounts, connectors, keys and your computer"></a>

Settings has the rest: models, autonomy, the things you've always allowed, research limits,
spending limits (off until you want them), voice, what dot remembers about you (all of it
editable and deletable), the sites you're signed in to, your apps, and your keys.

### The computer itself

<a href="docs/readme/computer.png"><img width="100%" src="docs/readme/computer.png" alt="dot's computer: a macOS-style menu bar and dock, with Chromium showing a travel article"></a>

The desktop includes Chromium, LibreOffice, GIMP, a code editor, and a terminal, with a menu
bar, dock, and app launcher. Sign-ins in its web
browser are retained across restarts and new tasks, though sites may ask you to sign in again. If the web browser stops
answering, localDot attempts to restart it with the saved profile.

<a href="docs/readme/computer-launcher.png"><img width="100%" src="docs/readme/computer-launcher.png" alt="The launcher open over LibreOffice Calc, with calc typed in the search field"></a>

<a href="docs/readme/starting.png"><img width="100%" src="docs/readme/starting.png" alt="Starting your computer: dot over a dark curtain, 0:14 · Waiting for the desktop, and a progress bar"></a>

Startup progress shows which service is being prepared: networking, desktop, or streaming.
The status survives a page refresh and is shared across browser tabs.

## Meet dot

<p align="center">
  <img width="100%" src="docs/readme/dot-sequence.gif" alt="dot working through a task, its tool changing with each step: thinking, opening a web page, waiting for it to load, clicking, typing">
</p>

dot’s pose changes with the current action: a keyboard for typing, a terminal for commands,
or a magnifier for inspection. Its caption describes the current step or tells you when
input is needed.

<a href="docs/readme/dot-poses.png"><img width="100%" src="docs/readme/dot-poses.png" alt="Every one of dot's poses at hero and dock size: typing, terminal, browsing, clicking, dragging, looking, thinking, waiting, needs you, sending, saving, remembering, done and something failed"></a>

## How it works

<picture>
  <source media="(max-width: 600px)" srcset="docs/readme/system-mobile.svg" type="image/svg+xml">
  <source media="(max-width: 600px)" srcset="docs/readme/system-mobile.png">
  <source srcset="docs/readme/system.svg" type="image/svg+xml">
  <img width="100%" src="docs/readme/system.png" alt="Pencil sketch: your browser and phone talk to the localDot daemon on your machine. The daemon runs an isolated computer made of four containers: desktop, web browser, brain and gate. The gate leads to keyd, which holds the real keys and adds them on the way out to model providers, the web and your apps. Web search and page reads go from the daemon to keyd with no sign-ins or keys, and your apps go through keyd too, each app that runs as a program in an app cell of its own.">
</picture>

[Open the full-size drawing](docs/readme/system.svg).

| Part | What it does |
| --- | --- |
| **Daemon** | The app itself, on your machine (TypeScript on Node). Serves the web UI, runs tasks, streams the desktop, records task activity, and handles approvals. |
| **Desktop** | The screen you watch: a Linux desktop streamed as H.264. dot clicks, types and drags here. |
| **Web browser** | A separate browser that keeps your sign-ins. The desktop can't read its cookies. |
| **Brain** | DeepSeek Harness drives the API-model agent loop through localDot’s tool and permission gateways. It holds stand-in keys only. |
| **Gate** | The computer's only way out to the network. Restricts network access and routes outbound traffic through the local policy service. |
| **Web tools** | Web search and page reading, done by the daemon itself through a keyd listener of their own. It reaches public websites only and carries no sign-ins and no keys. |
| **App cells** | One sealed container for each of your apps that runs as a program: read-only, none of your files, and a gate that only reaches keyd. Apps on the internet are reached through keyd directly. |
| **keyd** | A small Go service that keeps your real keys (in the macOS Keychain, your Linux keyring or an encrypted file), checks where everything is going, and swaps the keys in at the edge. |

<picture>
  <source media="(max-width: 600px)" srcset="docs/readme/task-loop-mobile.svg" type="image/svg+xml">
  <source media="(max-width: 600px)" srcset="docs/readme/task-loop-mobile.png">
  <source srcset="docs/readme/task-loop.svg" type="image/svg+xml">
  <img width="100%" src="docs/readme/task-loop.png" alt="Pencil sketch of one task: ask, plan, act, look, narrate, replay. Act, look and narrate repeat until the task is done; when dot needs you it asks in the chat.">
</picture>

[Open the full-size drawing](docs/readme/task-loop.svg).

A task goes round a simple loop: act, take a fresh look at the screen, say what happened, repeat.
dot can batch several actions into one turn and find buttons by name instead of hunting for
pixels. Not every step needs the screen: searching, reading a page and using one of your apps happen directly, and they show
up in the same step list.

## Safety

<picture>
  <source media="(max-width: 600px)" srcset="docs/readme/safety-mobile.svg" type="image/svg+xml">
  <source media="(max-width: 600px)" srcset="docs/readme/safety-mobile.png">
  <source srcset="docs/readme/safety.svg" type="image/svg+xml">
  <img width="100%" src="docs/readme/safety.png" alt="Pencil sketch of six walls between dot and the internet: hard checks, purpose check, approvals, the isolated computer, the network gate and stand-in keys. Searching, reading and clicking pass straight through; sending an email as you asks; posting your notes to a random site asks; poking the router is blocked; smuggling out an API key only gets a stand-in.">
</picture>

[Open the full-size drawing](docs/readme/safety.svg).

What asks and what doesn't, with **Custom** permissions and the default **Balanced** preset:

| dot wants to… | What happens |
| --- | --- |
| Click, type, scroll or drag on its own computer | Just runs |
| Open pages, read, search the web | Just runs |
| Read something with one of your apps | Just runs |
| Run code or a terminal command on its own computer | Just runs |
| Send a message or email as you, or post as you | Asks first |
| Pay for or buy something | Asks first |
| Sign in to a supported HTTPS site | Uses a saved login or requests credentials through a private form |
| Upload your files somewhere | Asks first |
| Change account settings or delete data on a remote service | Asks first |
| Change something with one of your apps | Asks first, with exactly what it would send (you can set each tool) |
| Let an app on its computer connect beyond websites, such as another port | Asks first, naming the app, the host and the port |
| Send private data somewhere unrelated to the task | Asks first, when the purpose check is on |
| Reach your LAN, your router or cloud metadata | Blocked |
| Use an API key | Gets a stand-in; the real key is added at the edge, for that key's hosts only |

The **Careful** preset asks before every step except reading and browsing. **Auto** and
**Full access** change the confirmation policy as described above. Eligible answers
can be scoped: just this once, for this task, for this site, or always, and you can take an
"always" back in Settings.

The optional purpose check uses request metadata and private-text matching to flag transfers
that appear unrelated to the task. Like any automated check, it can miss a problem or ask
unnecessarily. It does not replace reviewing the destination and scope of an action.

Pages, search results and connector responses are marked as untrusted context for the model.
Review permission settings before giving dot access to your accounts.

## Models

For screen interaction, choose a model that can interpret screenshots and use tools. You can
optionally assign a smaller model to titles and other quick tasks. Configure providers in
**Settings → Models**, then select a model from the message box.

- **Provider APIs:** Anthropic, OpenAI, Google Gemini, Azure OpenAI, xAI, Mistral, DeepSeek,
  Groq, OpenRouter, Together, Fireworks, Cerebras, Perplexity, Cohere, DeepInfra, Moonshot,
  Alibaba, Z.ai, Zhipu AI, MiniMax, Volcengine Ark and SiliconFlow.
- **Claude Code:** uses your installed Claude Code and plan. localDot leaves its sign-in,
  settings and memory files alone; enable it explicitly.
- **ChatGPT plan:** uses Codex in a separate home. Available only on Apple silicon builds with
  native and real-account acceptance recorded. See [setup and checks](docs/development.md#optional-chatgpt-plan-harness).
- **Coding/token plans:** MiniMax Token Plan and Alibaba Token/Coding Plans are supported.
  Other vendors may restrict plans to their named coding tools; use their API offering instead.
- **Your endpoint:** OpenAI-compatible or Anthropic-compatible servers. Enter the model ID,
  capabilities and price. Ollama and LM Studio can run locally without an API bill.

The main model must understand screenshots and use computer tools. Fast and local helper models
are optional. Open a finished reply's metadata for model usage and cost; estimates are labelled.

## Updates and help

Installed copies check for updates automatically and can download them in the background.
A dismissed notice stays available in **Settings → Your computer → Software update**. Installation
asks before shutting down the computer and restarting localDot. Existing installations need one
manual `localdot update` to enable automatic checks. [Update details](docs/install.md#automatic-updates).

- **Open:** `localdot open`
- **Update manually:** `localdot update`
- **Diagnose a problem:** `localdot doctor`
- **Uninstall:** `localdot uninstall` — keeps your data in `~/.localdot`.

For another device, use Tailscale, an SSH tunnel, or the optional relay in Settings. The relay
is off by default; localDot’s relay and Cloudflare can process traffic that passes through it.
[Phone and server setup](docs/install.md#servers-without-a-screen) · [Relay details](docs/remote-access.md).

## FAQ

**Does it touch my real computer?**
The agent’s desktop runs in containers. localDot itself runs services on your host and uses
Docker, disk space and network access. The agent can access files you attach and services you
connect; it does not receive general access to your host filesystem.

**Could it email my boss without asking?**
With the default Custom/Balanced settings, sending as you asks first and the card shows what
would be sent. Auto can approve routine actions through Jev; Full access allows sending without
a routine confirmation. Choose the permission mode that matches the authority you want to give dot.

**What does it cost?**
localDot is free and MIT licensed. Models cost whatever your provider charges, and localDot shows
usage and cost estimates for each task. Spending limits are off until you enable them.

**Where does my data go?**
Screenshots and the task's text go to the model provider you chose, and dot visits the sites the
task needs. Web searches go to public search engines, without your sign-ins. Pick a local model
and the model calls stay on your computer. The optional remote relay, when enabled, also
handles traffic between your browser and localDot; local access does not need it.

**Why is it called dot?**
Look at it.

**Can I build on it?**
Yes. Skills are plain `SKILL.md` folders, dot's memory uses editable Markdown files and daily notes, and any MCP server can become one of dot's tools in Settings → Connectors. See
[docs/development.md](docs/development.md).

Dot can learn reusable methods from browser, app, research, document and coding sessions,
including corrections and failed approaches. It saves concise lessons with their scope, observed
outcome, source task and a check before reuse. New conversations and routines load a small,
relevant selection; more can be recalled when needed. You can inspect, edit, or delete it under **What dot knows → Daily notes**.
It remains observed context, never permission to act. [Design and experiments](docs/experience-memory.md).

## Contributing

Bug reports, ideas and pull requests are welcome. Building, testing and running from source are
covered in [docs/development.md](docs/development.md). Before sending a change, run
`pnpm typecheck`, `pnpm lint`, the tests for what you touched, and `pnpm hygiene` (it scans for
anything that looks like a key).

## Licence

[MIT](LICENSE). Third-party notices are in [THIRD-PARTY.md](THIRD-PARTY.md). The handwriting in
the diagrams is Kalam, under the SIL Open Font License
([docs/diagrams/fonts/OFL.txt](docs/diagrams/fonts/OFL.txt)).
