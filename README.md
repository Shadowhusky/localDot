<p align="center">
  <img width="80" src="docs/readme/dot.png" alt="dot, a small white ball with two dark eyes">
</p>

<h1 align="center">localDot</h1>

<p align="center">An AI with a computer of its own.</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a> · <a href="https://localdot.dev">localdot.dev</a>
</p>

<a href="https://localdot.dev/film/localdot-film.mp4"><img width="100%" src="docs/readme/film.jpg" alt="The localDot film: six dots, each dressed for its job, under the words A dot for every job"></a>

<p align="center"><a href="https://localdot.dev/film/localdot-film.mp4">▶ Watch the 37-second film</a></p>

dot does real work on a computer of its own, right on yours: a Linux desktop with a browser, a
terminal and everyday apps, running in Docker. You watch from your browser or your phone, step in
whenever you like, and every task is recorded.

## Install

**macOS (Apple silicon) or Linux (x64)**, in Terminal:

```sh
curl -fsSL https://downloads.localdot.dev/install.sh | bash
```

**Windows**, in PowerShell (alpha, runs through WSL 2):

```powershell
irm https://downloads.localdot.dev/install.ps1 | iex
```

The installer checks Docker and walks you through anything missing, then prints a link. Open it,
pick a model, and give dot something to do.

`localdot open` prints a fresh sign-in link, `localdot update` installs the latest release and
keeps your data, and `localdot doctor` diagnoses a problem.
[Install guide](docs/install.md) · [Use it from your phone or a server](docs/install.md#servers-without-a-screen)

## What dot does

<img width="100%" src="docs/readme/app.png" alt="localDot at work: dot's computer shows Kiyomizu-dera's website in Chromium, dot says what it is doing under the screen, and the chat lists what it found while planning three days in Kyoto">

- **Watch it work.** Live, from your laptop or your phone. You see every click and keystroke as it
  happens.
- **Step in any time.** Take control and the mouse is yours. Hand it back and dot picks up where
  you left off.
- **You decide how often it asks.** Custom, Auto or Full access. Even with full access, dot asks
  before buying anything or deleting things online.
- **Use any model.** An API key from 25 providers, your ChatGPT or Claude plan, or a model on
  your own machine. Switch any time.
- **Rewind anything.** Every task is recorded step by step. Scrub back to see exactly what dot
  did.
- **Share the good part.** Trim to the moment, speed it up as much as 16 times, add captions and
  save it as a video.
- **A dot for every job.** Everyday, coder, researcher, finance, video editor or designer. Each
  brings only the skills its work needs, so it stays focused and spends nothing on the rest.
- **Open source, and yours.** The app, dot's computer and every recording stay on your machine,
  and your keys live in a local vault.

## Models

dot needs a model that can read screenshots and use tools. Add one in **Settings → Models**, then
pick it from the message box.

- **API keys:** Anthropic, OpenAI, Google Gemini, Azure OpenAI, xAI, Mistral, DeepSeek, Groq,
  OpenRouter, Together, Fireworks, Cerebras, Perplexity, Cohere, DeepInfra, Moonshot, Alibaba,
  Z.ai, Zhipu AI, MiniMax, Volcengine Ark and SiliconFlow.
- **Plans:** your Claude plan through Claude Code, your ChatGPT plan through Codex, and the
  MiniMax and Alibaba token and coding plans.
- **Your own:** any OpenAI- or Anthropic-compatible server, including Ollama and LM Studio on your
  machine.

Hosted models see screenshots and the task's context. [Model options](docs/model-options.md)

## Safety

dot works on its own computer, not yours. Reading, searching, clicking and running code there just
happen. It asks before it sends anything as you, pays for something, uploads your files, or
changes or deletes things on a remote service. Your LAN, your router and cloud metadata are
blocked. Your real keys stay in keyd, a small local service: dot only ever holds stand-ins, and
the real key is added on the way out, for that key's own hosts.

Pages, search results and app responses reach the model marked as untrusted. An optional purpose
check flags private data heading somewhere unrelated to the task. This is alpha software, so
review what dot does with your accounts. [How the agent runs](docs/agent-runtime.md) ·
[Purpose check](docs/purpose-check.md)

## How it works

Your browser talks to the localDot daemon on your machine, which serves the app, runs tasks,
streams dot's desktop and records every step. dot's computer is a set of containers: the desktop
you watch, a web browser that keeps your sign-ins, the agent's loop, and a gate that is its only
way out to the network. [The system drawn out](docs/readme/system.svg)

| Folder | What's in it |
| --- | --- |
| `apps/daemon` | The daemon: API, agent loop, safety checks, tools and recordings (TypeScript on Node) |
| `apps/web` | The app you open in your browser (React) |
| `apps/site` | localdot.dev and the film |
| `packages/protocol` | Types shared by the daemon and the app |

Run it from source: [development guide](docs/development.md).

## Help

- [Open an issue](https://github.com/Shadowhusky/localdot/issues) with what you did and what
  `localdot doctor` says.
- Other devices: Tailscale, an SSH tunnel, or the optional relay in Settings
  ([remote access](docs/remote-access.md)).
- `localdot uninstall` removes localDot and keeps your data in `~/.localdot`.

## Licence

[MIT](LICENSE). Third-party notices are in [THIRD-PARTY.md](THIRD-PARTY.md).
