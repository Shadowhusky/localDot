# A tour of localDot

[Install localDot](../README.md#install) · [Back to the overview](../README.md)

The screenshots use sample data. Open any image for its full-resolution view.

## Watch, stop and steer

<picture>
    <source media="(max-width: 600px)" srcset="readme/watch-mobile.png">
    <img src="readme/watch.png" width="880" alt="A running task with the live computer, progress and chat controls">
  </picture>

[Desktop screenshot](readme/watch.png) · [Phone screenshot](readme/watch-mobile.png).

The live picture is dot's isolated computer. **Stop** ends the run, cancels queued messages and
releases the conversation. It keeps the computer running. With text in the composer, **Send**
queues a follow-up; **Steer now** on that message delivers it immediately.

**Take control** gives you the mouse, keyboard and paste controls. dot cannot observe or act
while you hold control, and this part is not recorded. Choose **Hand back**, or send a message,
to let dot continue. History stays available during takeover.

Recent conversations are searchable and grouped by day. Each has a menu to open or delete it.
A new conversation uses the same computer, including its saved browser profile.

## Background work, steps and files

Commands and file changes appear in a native **Activity** window inside the streamed computer.
A brief entrance and dot gesture introduce it. Consecutive commands reuse the window; you can
scroll, select and copy output, resize it or close it. It clears before visual actions and
handoffs. The display uses existing redacted events, without extra model calls or commands.

[View the Activity window](readme/work.png).

The side panel's **Steps** tab lists actions, timings, failures and blocked requests. **Files**
shows outputs and changes; research tasks also get **Sources**. The plan strip shows the current
and next item; open it to see the whole plan. Model usage and cost belong in turn metadata.

Use **Panels** to hide or restore Chat and Activity. Drag a panel edge to resize, double-click
to reset, or focus the divider and use arrow keys. Sizes, visibility and tabs persist in your
browser. Steps and Files follow the selected conversation, including after reconnecting.

## Models

Set up models in **Settings → Models**. The composer lists every configured model, grouped by
provider or plan. Adding another provider preserves your earlier configuration. A normal switch
applies to the next task; if a task is held at a model or credit limit, **Continue** uses the
latest selection.

- **Provider APIs:** Anthropic, OpenAI, Google Gemini, Azure OpenAI, xAI, Mistral, DeepSeek,
  Groq, OpenRouter, Together, Fireworks, Cerebras, Perplexity, Cohere, DeepInfra, Moonshot,
  Alibaba, Z.ai, Zhipu AI, MiniMax, Volcengine Ark and SiliconFlow.
- **Claude Code:** uses your installed Claude Code and plan. localDot leaves its sign-in,
  settings and memory files alone; enable it explicitly.
- **ChatGPT plan:** uses Codex in a separate home. Available only on Apple silicon builds with
  native and real-account acceptance recorded. See [setup and checks](development.md#optional-chatgpt-plan-harness).
- **Coding/token plans:** MiniMax Token Plan and Alibaba Token/Coding Plans are supported.
  Other vendors may restrict plans to their named coding tools; use their API offering instead.
- **Your endpoint:** OpenAI-compatible or Anthropic-compatible servers. Enter the model ID,
  capabilities and price. Ollama and LM Studio can run locally without an API bill.

The main model must understand screenshots and use computer tools. Fast and local helper models
are optional. Open a finished reply's metadata for model usage and cost; estimates are labelled.

## Permissions and sign-ins

<a href="readme/permissions.png"><img src="readme/permissions.png" width="400" alt="The composer permission menu with Custom, Auto and Full access"></a>

- **Custom** follows your settings. Balanced allows ordinary reading, browsing and work on dot's
  computer; sending as you, payments, uploads and account changes ask first. Careful asks before
  each step except reading and browsing.
- **Auto** lets Jev review routine actions and asks when it cannot approve them.
- **Full access** skips routine confirmations but asks for destructive actions.

Eligible approvals can cover one action, a task, a site or always. Revoke an “always” choice in
Settings. Network isolation and private credential handling apply in every mode. The optional
purpose check looks for private data headed somewhere unrelated to your task.

For a supported website login, dot uses a saved account or asks through a private form. localDot
fills the verified HTTPS form; passwords stay out of model input and conversation logs. Missing
or rejected fields are requested separately. Authentication codes also use private inputs and
are not saved as passwords. Passkeys, device approval and unsupported forms may need a manual
handoff, with an explanation. [How browser sign-ins work](browser-workspace.md#sign-in-once).

Connected-app access and website sign-ins are separate. In **Settings → Connectors**, add an MCP
server by address or command and set each tool to **Just runs**, **Asks first** or **Off**.
With Custom permissions, reads run and changes ask by default. Credentials go only to their app.

## Research and voice

Turn on **Research** for a question that needs more exploration. dot searches, reads pages and
numbers its sources, then delivers a cited report as Markdown and PDF. The default budget is
20 sources or 15 minutes; change it in Settings, ask to continue, or choose **Wrap up now**.
Search and page-reading tools use public sites without your browser sign-ins.

Hold the microphone, or use **⌥Space** on Mac / **Ctrl+Shift+Space** elsewhere, to dictate.
Review the transcript before sending. Speech recognition runs on your device when supported,
or through an available whisper.cpp model. Online recognition needs your permission. You can
cancel recording or dismiss its notice immediately; voice recordings are not saved.

## Results and replay

Finished tasks show a summary, delivered files and before/after images. Open supported images,
PDFs, documents, decks, HTML, text, code, spreadsheets, audio and video in their viewers.
Unfamiliar extensions open as text when readable; unsupported or unavailable files show an
explanation and remain downloadable. Failed text loads offer **Try again**.

Choose **Revise** for another pass. Revised files keep versions, with Compare. Recordings let
you revisit steps and skip idle time. Video export offers **Quality**, **Fast** and **Showcase**;
exports run locally and continue if you close the browser tab.

## Memory and routines

**What dot knows** lets you inspect, edit and delete memory. Reusable setup experience records
its project or workflow, conditions, source task and a check to perform before reuse. Relevant
experience is loaded across conversations and routine runs; it does not grant new permissions.
See [memory design and experiments](experience-memory.md).

Ask dot to repeat work on a schedule, or create a routine yourself. Routines run while localDot
is running, with your chosen permission policy and preferences for when you are away.

## Your computer and phone

The computer is Linux with a familiar menu bar, dock and launcher. It includes Chromium,
LibreOffice, GIMP, a code editor and a terminal. The isolated task browser preserves sign-ins
across restarts and tasks; recovery uses its saved profile.

Startup shows actual progress through network, desktop and screen connection. Reloading the
page does not reset the timer. Stop and new conversations leave the computer running; shut it
down yourself when finished.

The same app works on a phone. Use a private Tailscale connection for remote access and enable
notifications when you want a nudge. [Remote access setup](install.md#servers-without-a-screen).
