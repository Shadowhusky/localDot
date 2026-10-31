# Developing localDot

The [README](../README.md) is the tour. This page is the workshop: how to build, run and test
localDot from source, and the details behind each part.

The [browser workspace guide](browser-workspace.md) covers the separate web browser, protected
saved logins, manual takeover, reviewed downloads and approved uploads.

## Development

The release-based CLI in `apps/cli` is an author draft pending independent review and installed
acceptance. The README's `install.sh` uses the existing source installer; its branch-based update
commands are documented in [Installing localDot](install.md). The following release commands
apply to the release-based CLI:
For a managed installation, `localdot update` checks for the latest stable release;
`localdot update --to 1.2.3-rc.2` selects an exact version (including a release candidate).
Both recover interrupted updates first and authenticate the exact release before activation.
Updates preserve recorded installation settings and refuse downgrades. An already-current
release is checked through `localdot up` before reporting readiness. After an interrupted
update, run `localdot up` to check or recover the installed app before retrying.

Managed `localdot doctor` currently verifies installation authority, resources, all four image
pins, gateway isolation and the authenticated app port. It requests fresh self-tests for idle,
running computers and rejects incomplete or changing computer inventories. Failed checks contain
the affected computer. The synthetic credential-canary exercise is implemented in the author
candidate, including owned cleanup and leak-scanner controls; independent review and a successful
live installed diagnostic run are still required.

Needs Node 24+ and pnpm 10. After `pnpm install`, the root scripts are:

- `pnpm test`: the Vitest suites of the apps, packages and scripts
- `pnpm typecheck`: `tsc --noEmit` in each app and package
- `pnpm format`, then `pnpm lint`: Biome
- `pnpm hygiene`: scans the files git tracks or would add for key-shaped secrets and private names
- `pnpm build:app-package <input.json> <new-output-directory>`: builds and audits a local app
  archive; see the [release packaging guide](release-packaging.md) for inputs and remaining
  release gates

Run the daemon with `pnpm --filter @localdot/daemon start`. It listens on `http://127.0.0.1:4750`
(`LOCALDOT_PORT` sets another port) and keeps its state in `~/.localdot` (`LOCALDOT_HOME` sets
another home). One daemon runs per home. The install token is in `<home>/daemon-token`, and auth is
cookie-free: HTTP requests send `Authorization: Bearer <token>`, and WebSocket clients offer the
subprotocols `localdot.v1, localdot.token.<token>`.

When updating a source checkout, restart its daemon after rebuilding the UI. The daemon serves
`apps/web/dist` from disk, so a browser refresh can load new controls while the process still
runs old API handlers. A UI build alone does not activate backend changes. Stop active tasks
before restarting; then verify the updated controls against the running daemon, not only a test
fixture. For a LaunchAgent, send `SIGTERM` to its loaded service and let its supervisor restart it.

### Several dots

`pnpm dots` runs `localdot dots` from this checkout. With the development LaunchAgents
`dev.localdot.keyd` and `dev.localdot.daemon` loaded, `pnpm dots add Work` makes `~/.localdot-work`,
gives it the next free ports and writes `dev.localdot.work.keyd` and `dev.localdot.work.daemon`
from the first dot's agents: the same keyd binary, Node and working directory, with the new dot's
`-home`, `-ports` and `-keychain-service` for keyd and its own `LOCALDOT_HOME`, `LOCALDOT_PORT`,
`LOCALDOT_TOOL_PORT`, `LOCALDOT_KEYD_PORTS`, `LOCALDOT_PREVIEW_PORTS` and `LOCALDOT_PUBLIC_ORIGIN`
for the daemon. `pnpm dots list`, `start`, `stop` and `remove` manage them, and the Settings and
switcher controls run the same command. On Linux the units are `localdot-<id>-keyd.service` and
`localdot-<id>-daemon.service`.

| | App | Tool API | keyd listeners | Previews | Keychain service |
| --- | --- | --- | --- | --- | --- |
| First dot (no `instance.json`) | 4750 | 4751 | 4760–4789 | 4900–4915 | `localdot-keyd` |
| Dot *n* | 4750 + 1000·*n* | +1 | +10 to +39 | +100 to +115 | `localdot-keyd.<id>` |

To run another dot by hand, start its keyd with the instance's flags, then its daemon; the daemon
takes any port its environment doesn't set from `<home>/instance.json`:

```sh
pnpm keyd -home ~/.localdot-work -ports 5760-5789 -keychain-service localdot-keyd.work
LOCALDOT_HOME=~/.localdot-work pnpm --filter @localdot/daemon start
```

Each dot's keyd holds its own Keychain or keyring service, so the one-holder rule applies per dot.
`POST /v1/keys/copy` with `{"home": …}` copies a keyd's keys and saved logins to the keyd of the dot
at that home, sealed to its key, after checking that the peer is a genuine keyd: the same signing
requirement through the peer's pid on macOS (the same executable for an unsigned development
build), and the same executable through `SO_PEERCRED` and `/proc/<pid>/exe` on Linux.
`POST /v1/vault/forget` empties the vault of a dot being removed. `pnpm images:cleanup` protects
the images every registered dot refers to.

## Images and the live desktop

- `cells/gate/build.sh` builds `localdot/gate:dev`; `cells/desktop/build.sh` bundles `desktopd`
  and builds `localdot/desktop:dev`. The first desktop build takes about 10–25 minutes.
- `cells/browser/build.sh` bundles `browserd` and builds `localdot/browser:dev` on top of the
  desktop image.
- `pnpm --filter @localdot/daemon doctor` checks Docker (Engine 28+), the images and the daemon
  port.
- Build the UI with `pnpm --filter @localdot/web build`, start the daemon, then open its
  `#token=` link. **Start computer** creates an isolated desktop, gate and named home volume.
  The live stream reaches Chrome through the daemon. **Stop computer** shuts it down while
  keeping the home volume for the next start. **Stop task** in the composer ends the agent run
  and releases it for a new conversation. The CLI emergency Stop freezes the computer;
  **Resume computer** continues a frozen computer with fresh key stand-ins.
- The desktop has the WhiteSur light theme, a menu bar and a Plank dock. Pinned versions and
  licenses are in `cells/desktop/THIRD-PARTY.md`.
- `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker` runs the Docker suites.
  `LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e` checks the live desktop in installed
  Google Chrome, including Stop/Start, Stop/Resume, key management and daemon restart recovery.
- `LOCALDOT_MEASURE=1 pnpm --filter @localdot/web e2e --grep measure` records frame rate and CPU.
  The stream defaults to 4:2:0 H.264, which every browser decodes; iPhones and iPads cannot decode
  4:4:4. `LOCALDOT_STREAM_FULLCOLOR=1` streams 4:4:4 for sharper coloured text in desktop Chrome.
  Both modes keep the stream setting locked in the client. Results and screenshots are in
  `apps/web/e2e/out/`.
- Processes that need to stop the daemon should run `node --import tsx src/main.ts` from
  `apps/daemon`; pnpm's start command does not forward SIGTERM.
- `apps/web/vendor/selkies` is the pinned MPL-2.0 client served by the daemon. The cell supplies
  stream data; the client code comes from the local installation.

The token fragment is removed from the visible URL after loading. Browser history may retain
the original install link, so treat that link as a credential.

The native UI regression runs in an isolated display, never the user's running computer:

```sh
mkdir -p /tmp/localdot-corners
docker run --rm --network none --entrypoint /bin/sh \
  -v "$PWD/cells/desktop:/source:ro" -v /tmp/localdot-corners:/results \
  localdot/desktop:dev /source/tests/native-corners.sh --out /results
```

It checks application search, file search and Activity corners against a changing background
at both display scales, including a multiline command in the single-line Activity header.
It also verifies native maximize, restore and minimize operations and rejects changed targets.
Rofi is built with a narrow alpha-visual patch: a 32-bit X11 visual alone does not guarantee
transparent corners. Screenshots are saved in `/tmp/localdot-corners`.

## Replay

Sessions record locally even when nobody is watching. Open **Replay** and choose a session in
the history rail to scrub its video, inspect the step timeline, compare before/after screenshots,
change speed, or skip idle stretches. A running session offers **Jump to live**.

Space plays or pauses; K pauses; Left/Right choose steps; J/L move ten seconds; `[`/`]` change
speed from ½× to 8×; B opens the before/after comparison. **Export MP4** saves the chosen range
with the pointer and overlays, optional captions, and the selected speed. Use desktop Chrome
with file-picker and H.264 encoding support.

Recordings live in `~/.localdot/sessions/<id>/recording/`. Takeover stretches are never recorded.
By default, finalized videos expire after 30 days or when the completed-video budget exceeds
20 GiB, oldest first; events and captured screenshots remain. Finished videos are re-encoded
in the background to take far less space. `LOCALDOT_RECORDING=0` disables new video recordings. See [the Replay guide](replay.md) for privacy, retention settings,
recovery, export details, and the browser acceptance commands.

## keyd

`keyd/` contains the Go key service. It holds real credentials, gives cells scoped
surrogates, checks outbound destinations, scrubs credential reflections, and
enforces task and daily model budgets. Its admin API uses a private Unix socket.

From `keyd/`, run `go test -race ./...` or build with
`go build -o bin/keyd ./cmd/keyd`. For a local instance with an in-memory vault,
run `bin/keyd -home /tmp/localdot-keyd-demo -vault memory -natpmp off -stun off`. The admin socket is
`/tmp/localdot-keyd-demo/keyd/admin.sock`; cell listeners use ports 4760–4789.
`bin/keyd verify-audit /tmp/localdot-keyd-demo/keyd/audit.jsonl` checks the audit
chain. Use a short home path because macOS limits Unix socket path lengths.

The Go toolchain is pinned in `keyd/go.mod`. Tests use local fake providers and
make no paid model calls. The optional
`KEYD_KEYCHAIN_TEST=1 go test ./internal/vault -run LoginKeychain` exercises the
macOS login Keychain with disposable test entries.

keyd learns and denies the network's public IPv4 address to block connections
back through the router. It asks the router first (NAT-PMP); if the router has
no public answer, it asks the configured STUN server (Cloudflare by default).
If UDP discovery fails, the default configuration tries Cloudflare over direct HTTPS/IPv4
with certificate verification, no environment proxy, no redirects and a bounded response.
`-stun off` disables both Cloudflare fallbacks; `-natpmp off -stun off` disables discovery.
The admin status reports whether this guard is active, unknown or off. It retries
unknown addresses every 30 seconds for four rounds, then every five minutes,
refreshes known addresses every five minutes, and checks for a changed gateway
every 30 seconds. Tests use local fake routers and STUN servers.

## Keys

In development, start keyd in its own terminal before the daemon. `pnpm keyd` builds
`keyd/bin/keyd` and runs it on `~/.localdot` (or `LOCALDOT_HOME`), keeping saved keys in the macOS
login Keychain. `pnpm keyd -vault memory` keeps them in memory for that run. The daemon reaches it
at `<home>/keyd/admin.sock` and refuses a socket other users could reach. Until keyd runs,
computers do not start and the top bar says **Key layer offline**. The daemon's
`LOCALDOT_KEYD_PORTS` (default `4760-4789`) must match keyd's `-ports`, and `LOCALDOT_TOOL_PORT`
(default 4751) moves the brain's tool API.

Add keys with the Theatre's **Keys** button. The page seals each value to keyd's key for the
current boot using WebCrypto; the daemon relays the sealed copy. Desktop shells receive scoped
stand-ins for **Web/API keys**, named `LOCALDOT_KEY_<NAME>` (for example, `open-weather` becomes
`LOCALDOT_KEY_OPEN_WEATHER`). Those stand-ins work through keyd for the hosts and header
bound to the key. keyd inserts the saved value into allowed outbound HTTPS requests and scrubs
credential reflections from responses. The cell's web traffic reaches keyd through its gate.

**Stop** revokes the computer's stand-ins and freezes it. If freezing fails, it closes the
computer's keyd listener and stops its containers. **Resume computer** revokes again and refreshes
the stand-ins while the computer is still frozen; it requires keyd to be running. Existing
processes keep their revoked values: start a new shell or reload `/etc/localdot/cell/surrogates.sh`
to use the fresh stand-ins. If keyd has restarted, resuming starts a fresh desktop with the same home volume. The Keys sheet and
`pnpm --filter @localdot/daemon run doctor` report whether keyd knows this network's public address,
which it refuses to dial (the hairpin guard).

`LOCALDOT_KEYD_TESTS=1 pnpm test:keyd` runs the daemon's suites against a real keyd built from
`keyd/`, using the Go toolchain pinned in `keyd/go.mod`. `LOCALDOT_KEYD_BIN` selects an existing
binary. These suites use local fake providers and an in-memory vault; their listeners default to
`4791-4797` (`LOCALDOT_TEST_KEYD_PORTS` selects another range).

With Docker Desktop, the built gate and desktop images, and internet access, run:

```sh
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/keyd/cell-egress.docker.test.ts
LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/keyd/canary.docker.test.ts
```

The egress suite probes the production cell, gate and keyd path. The canary suite plants a fake
key, exercises that path, and scans readable process memory, environments, command lines and
written files for raw and encoded key material. It also checks the clipboard and container/keyd
logs. Positive controls and coverage thresholds check that the scan can detect planted material.
The suite also checks that Stop freezes the
cell and that Resume replaces revoked stand-ins. These Docker suites and browser e2e tests run
locally; CI runs the host tests, Go checks and real-keyd integration suites.

## The agent

Build `localdot/brain:dev` with `cells/brain/build.sh`, alongside the gate and desktop images.
The API-model agent runs in a separate brain cell. DeepSeek Harness **0.1.7-rc.2**
with Cordis **4.0.4** drives its step scheduling, serial tool dispatch, turn completion and
cancellation (`cells/brain/src/harness.ts`). These exact pins satisfy the repository's
14-day dependency-age policy. Claude Code and ChatGPT plan integrations retain their
respective vendor runtimes.

The localDot adapter retains the durable multimodal transcript, provider-native replay,
compaction, queue acknowledgements, retry/budget handling and screenshot coordinates.
DSH orchestration events and native child transcripts are persisted as isolated metadata
in the daemon's generation-fenced, redacted, fsynced transcript journal. Upstream session
ownership, checkpoints, crash-tail repair and resume use this storage adapter. Root provider
history and inbox acknowledgements remain localDot-owned; native child history uses upstream
compaction and retains exact provider replay blocks. Model
requests continue through the AI SDK and keyd; tools continue through the authenticated
daemon API at `127.0.0.1:4751`, including JEV approvals and computer ownership checks.

Each model call is sent a lighter copy of the root history (`cells/brain/src/context.ts`): the
newest three to six screenshots, and for DeepSeek, OpenAI and Azure, whose APIs accept it,
reasoning from only the newest 8 turns and, older than the newest 12 turns, tool output over 2,000
characters replaced by a one-line note (the skill tool's instructions stay). Reasoning and output
leave together, 16 turns at a time, so the prefix a provider caches changes once every 16 calls.
Other clients get older turns as they were: Claude binds each thinking block to the conversation
before it, so an edited earlier turn invalidates every later block. The stored transcript keeps
everything. localDot summarizes the older half once that copy passes 60% of the window or, for
those three clients, 120k tokens if that is less (the turns a summary keeps would carry Claude
thinking bound to the conversation it replaced). The summary's usage is reported, and a failed
summary is tried again once the copy has grown by a tenth. Upstream compaction summarizes child
sessions only, with 8,192 tokens of headroom and a 4,000-token summary; the root's DSH log is
never summarized into the conversation. A restarted brain does not add harness context (catalogs,
skill bodies, reminders) its restored transcript already holds, and a resumed DSH session is
continued, not given the task again.

The runtime composition now includes the upstream `dsh-tool-todo`, `dsh-skill`,
`dsh-skill-filesystem`, `dsh-tool-skill`, and `dsh-repeat-tool-reminder` plugins at the
same exact version. Their schemas and injected context reach the actual model requests;
simply mounting plugins while discarding `GenerateOptions` does not activate their behavior.
`todo_write` uses upstream validation and maps to localDot's persisted plan events. Native
plugin outcomes, including refusals, join the same durable provider transcript as daemon tools.

The upstream filesystem skill provider reads **the virtual computer**, through the existing
authorized `files` gateway. It never scans the Mac or the brain container for user skills.
The catalog starts as the skills the daemon installed for the task in `/config/.skills`, known
from the boot configuration without a read, and is the only place the model sees them listed.
The agent's own folders, `/config/.agents/skills` and `/config/.dsh/skills`, are scanned only
after a skills installer runs or a command or file write changes one of them. A folder found
missing is not probed again in the task unless a later command names it, and a rescan reads only
skills it has not read. Running a skill's scripts or reading its files rescans nothing. Loading a
skill always rereads its `SKILL.md` and honors its invocation frontmatter.
Host filesystem watching is disabled. The last complete scan is retained across transient failures;
truncated/binary instructions are rejected, reads remain bounded and redacted, and discovery
cannot run commands. Native plugin pre-execution respects the host's veto and cancellation.
The current skill catalog is restored to model context after localDot compaction.

Online discovery remains the agent's research step: use the available web tools to compare
relevant official skills and dependencies, inspect the selected instructions, then install
inside the virtual computer's standard skill directories through the authorized shell. The
upstream skill plugin loads catalogs; it does not itself search the whole Internet or select
an objectively best skill. No task-specific video recipe is bundled.

**Runtime integration:** the API-model profile now mounts upstream goal state and round
driving, durable session ownership/checkpoints, jobs, one-shot and continuable child agents,
child messaging/interruption, token accounting and compaction. Child model requests use the
same selected provider through keyd; child actions use the daemon's existing tool API. The
parent alone gets visible-browser, mouse/keyboard, approvals, user questions and delivery
tools. Children can research, read/write files, run shell commands and load skills, with a
maximum of three active children and one generation. Shared filesystem work still needs
coordination. `done` cannot complete while jobs or children are running; Stop cancels the
agent tree. Accepted completion closes the upstream goal; interrupted goals remain recoverable.

This is the localDot application profile, not the stock DSH CLI. Stock host-process shell,
credential stores, session upload/telemetry, CLI UI and workflow/PTC tools are not mounted.
Claude Code and ChatGPT subscription runtimes retain their vendor-supported execution paths.

The migration boundary is the agent runtime, not the stock CLI application. Use the upstream
[composition](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/base)
as the capability inventory, while keeping the deployment adapters explicit:

| Capability | Current ownership / migration acceptance |
| --- | --- |
| Agent scheduling and cancellation | Upstream DSH, with localDot Stop, manual control and inbox admission. |
| Skills and implementation checklist | Upstream discovery, parser, loader and todo validation; computer reads and progress persistence remain localDot adapters. |
| Recovery guidance | Upstream repeat-call reminders reach the provider. They advise recovery, not automatic completion or silent task cancellation. |
| Browser, shell, files, search and delivery | Existing authorized localDot tools; stock host-process tools must not execute on the Mac or in the brain. DSH service adapters for jobs must route to the same computer. |
| Models and credentials | Current provider adapters through keyd; preserve native signed reasoning/replay blocks and route-specific settings. Subscription runtimes stay vendor-owned. |
| Durable sessions and compaction | Upstream orchestration/child state uses the daemon journal; root multimodal history and inbox stay localDot-owned. Child compaction preserves signed provider replay. |
| Goals and background jobs | Upstream goal state, round continuation, native jobs and completion wakeups, constrained by localDot Stop and keyd spending limits. |
| Subagents | Upstream spawn, one-shot/background work, continuation messaging, listing and interruption; distinct persisted session identities, shared keyd accounting, no child browser/mouse/keyboard tools. |
| UI, computer lifecycle and snapshots | Product services, not provided by switching the agent framework. |

Before activation, run an isolated real-model task that researches candidate workflows online,
loads and applies a newly installed skill, verifies the actual output, and returns it through
`done.files`. Also exercise unavailable prerequisites, cancellation, manual takeover, restart
recovery and provider-native replay. Scripted models establish protocol correctness only;
they do not establish that the selected real model will research or plan well. Production
bundling now executes the artifact in a temporary directory with an empty environment, without
adjacent package metadata or node_modules, before publishing the bundle. A separately tagged
candidate image also passes import/startup in a read-only container with no network or credentials.

Deployment verification (2026-10-14): the current computer updated through the supported API
with its home mounts and installed `gh`/WeChat versions unchanged. The package database is
merged by complete Debian package records; conflicting versions still block the update.
A real configured-provider run (`01M4WWK3Q9H8J6JJX1MYT4F5Y1`) exercised native planning,
background research through the daemon, skill loading, artifact verification and `done.files`.
The resulting ZIP was independently downloaded through the Files API and its CRC, CSV rows
and source URLs checked. This verifies runtime wiring, not general creative quality.
Real-provider checks caught and fixed system-message placement, streaming-only gateway
compatibility, and undefined SDK replay fields rejected by the native journal. The SDK bridge
now has a test covering native child journaling, a real tool round trip and completion.
Final checks: 283 brain/recall tests, 10 Docker acceptance cases, 9 native and 15 offline Codex
probes. The broad suite passed 13,029 tests; two provenance assertions were updated to retain
skill-catalog reads as untrusted file sources and both passed on rerun. No policy exemption was
added. The synthetic skill directory remains temporarily because a newer user task started
before cleanup; its name is `localdot-runtime-check-20261014` and it is not a bundled skill.

**Stop** ends the agent run and revokes its access. It does not shut down the computer;
new conversations use the existing desktop. Computer recovery remains a daemon concern,
independent of the harness. Switching frameworks does not by itself improve a model's
screen recognition or eliminate browser failures.

The chat and model picker use the core API with the existing install-token
Authorization header and JSON request bodies:

- `GET /api/agent/providers` lists providers, catalog models, capabilities and available key IDs.
  `POST /api/agent/catalog/refresh` refreshes the models.dev catalog.
- `GET /api/agent/plan-usage` gives each subscription plan's (`chatgpt`, `claude-code`) latest known
  5-hour and weekly usage, each window with when it was read. Every task's `subscription.usage`
  events feed it, and it is kept in `<home>/plan-usage.json`. `?fresh=1` also reads, in the
  background, plans whose figures are over two minutes old from their own apps, at most once a minute
  and with no model turn: Codex's `account/rateLimits/read` and Claude Code's `/usage` data through the
  Agent SDK (an experimental call; when it fails, only the tasks' reports remain).
- `GET` and `PUT /api/agent/settings` read or replace settings. `main` drives the task, optional
  `fast` writes summaries and answers the purpose check, and optional `local` provides a fallback. A role choice contains
  `provider`, `model`, and a stored `key` ID for remote providers. LM Studio and Ollama need no
  key; keyd reaches them on `127.0.0.1:1234` and `:11434` respectively.
- Remote models missing a catalog price need an explicit `price` object containing both
  `inputUSDPerMTok` and `outputUSDPerMTok` (finite values from 0 to 10000, at least one positive).
  Optional `taskBudgetUSD` sets the initial spending limit. Each task keeps its selected models
  and immutable price table across brain restarts and follow-ups; editing settings affects new tasks.
- `POST /api/cells/<id>/agent` with `{"task":"…"}` starts on a ready computer and returns a
  `sessionId`. Follow-ups use `POST /api/agent/sessions/<id>/messages` with
  `{"kind":"followup","text":"…"}`; use `"steer"` to redirect current work. Do not automatically
  resend a mutation if its reply is lost: reconcile the session and event log first. A steer that
  dot's model hasn't taken in yet ends the wait dot is in, on every model path, within a second: a
  `computer` wait (a batch stops after it), `done` waiting for progress, a `shell` command's opening
  `sleep` (only while it is still sleeping, before anything after it has run; the command is stopped
  as Stop stops one), and the wait for its turn on a computer another task is using (the action is
  then not done). Each message ends one wait; actions already under way finish.
- `POST /api/agent/sessions/<id>/stop` ends a task's run (204). With `?giveBack=1` it answers 200
  `{"messages":[{"messageId","text"}]}`: the stopper's own messages dot had not acted on yet (no
  words of its own and no tool call but a screenshot since), oldest first. The daemon decides
  this as Stop ends the run, so a tool call starts before it or never. Those messages are
  `message.delivery` `withdrawn` with reason `stopped`: they leave the thread on every device, the
  context a later task continues from, and search. Anyone else's (the owner's, when a shared link
  stops its task) are `cancelled`, `stopped`, left for an Edit. A task that gave back everything
  and did nothing hands its conversation back to the task it continued, or to a new one, and
  once settled its record is removed, provided its log holds nothing but messages, thinking and
  looks at the screen. Other Stops (the CLI's, Shut down, Stop everything) leave unanswered
  messages unsent with Edit.
- Questions and hand-back require the current `askId` or `requestId` from the session snapshot.
  Completed files are downloaded from `/api/agent/sessions/<id>/files/<name>`, as attachments.
- `POST /api/conversations/<id>/title` with `{"title":"…"}` (1–80 characters once trimmed, one
  line, no control characters) names the conversation that task belongs to, any of its tasks
  finding it; `{"title":null}` gives it back its automatic name. Both answer 204; a bad body is
  400, an unknown task 404. The user's name wins over dot's until cleared. Shared links can't
  rename. `POST /api/agent/sessions/<id>/persona` with `{"persona":"coder"}` switches a running
  task's dot: its agent carries on from its saved history with that dot's skills and role.
- `POST /api/conversations/<id>/tag` with `{"tag":"blue"}` (`red`, `orange`, `yellow`, `green`,
  `blue`, `purple`, or `null` to take it off), `/pin` with `{"pinned":true}` and `/archive` with
  `{"archived":true}` organize the conversation that task belongs to, as rename does, and answer
  204. They are kept by the conversation's first task in `<home>/conversations-organized.json`, so
  they last as it goes on, except archiving: a new task in an archived conversation brings it back.
  A conversation with a task under way can't be archived (409). Each change goes to every open
  app as a `conversation.organized` event on `/api/events`. `GET /api/conversations` leaves the
  archived ones out, keeps those pinned before the rest are counted, and says how many are
  archived (`archivedCount`); `?archived=1` lists them. Shared links can't organize or delete.

A new conversation's first message gets one short call to a quick model beside the task
(`agent/first-look.ts`): the fast model, else the main model at its least thinking (Claude Code's
own no-tools answer, or a priced keyd listener of the daemon's own for keys). It names the
conversation in at most six words, recorded as a `session.title` event that the conversation list,
Replay and search results show; until it comes, or when it never does, the first message is the
name. The task never waits for it. With **Auto** on (`autoPersona`), the same call also picks the
dot, and the task waits up to 4 seconds for it before installing skills and starting its agent,
falling back to the chosen dot (`persona.choice` `default`). A pick that comes later still counts
while dot has neither said nor done anything and isn't waiting on the user: it is recorded as a
second `persona.choice` (`auto`), and a different dot takes over as a switch does, from the saved
history. A ChatGPT plan has no call to spare: its one
Codex process is the task's. The agent's own first reply can't do this: Claude Code and Codex shape
their own output, and the dot's skills and role must be in place before that agent starts. Follow-up
tasks keep the conversation's names and dot without asking again.

Memory lives in `<home>/memory/USER.md` and `MEMORY.md` (normally under `~/.localdot`). Skills
are `SKILL.md` directories under `<home>/skills/` and this repository's `skills/`; task startup
copies them into the computer's `~/.skills/`. Memory is context, including assistant-written
notes, rather than a source of new user instructions. General session learning, bounded recall,
its research basis and reproducible retrieval checks are described in
[experience-memory.md](experience-memory.md).

`pnpm test` covers the model loop, transport fixtures and host Tool API integration without
paid calls. The separate agent real-cell suites require both `LOCALDOT_DOCKER_TESTS=1` and
`LOCALDOT_TASK15_TESTS=1`. They use a build-tag-only keyd with an owned loopback TLS provider and
a public fake canary; no external provider or real key is used. Ordinary Docker suites skip
these cases. Build the brain and gate images first, then run:

```sh
go -C keyd build -tags localdot_acceptance -o /tmp/localdot-agent-keyd-fixture ./internal/acceptancefixture
LOCALDOT_DOCKER_TESTS=1 LOCALDOT_TASK15_TESTS=1 \
  LOCALDOT_KEYD_BIN=/tmp/localdot-agent-keyd-fixture \
  LOCALDOT_TASK15_BRAIN_IMAGE=localdot/brain:dev \
  LOCALDOT_TASK15_GATE_IMAGE=localdot/gate:dev \
  pnpm test:docker apps/daemon/src/agent/brain-cell.docker.test.ts \
    apps/daemon/src/agent/containment.docker.test.ts \
    apps/daemon/src/agent/task-pricing.docker.test.ts
```

All ten cases must pass. These suites reserve ports 4792–4796 and create uniquely owned
containers, networks and temporary homes. They cover the standard bundled brain loop,
isolation and Stop containment, plus immutable spending across brain replacement and a keyd
process restart. The pricing case uses a bounded real-image request worker to fit its initial
$5 reservation; it does not replace the standard-loop acceptance. Missing explicit fixture
configuration fails once both flags are enabled.

### Optional live provider checks

Live computer-use acceptance remains pending until explicitly run with a funded account or an
already loaded local model. Ordinary host tests and `LOCALDOT_KEYD_TESTS=1 pnpm test:keyd`
skip all live provider cases. To opt in, also set `LOCALDOT_LLM_TESTS` to a comma-separated subset
of `anthropic,openai,google,lmstudio` and select just this file:

```sh
LOCALDOT_KEYD_TESTS=1 LOCALDOT_LLM_TESTS=google \
  pnpm test:keyd apps/daemon/src/agent/providers.keyd.test.ts
```

Before that command, put the selected provider's key in the shell environment and set its two
`*_CU_INPUT_USD_PER_MTOK` / `*_CU_OUTPUT_USD_PER_MTOK` variables to the model's current prices.
Both values are required for remote models; zero is allowed on one side. The suite does not
fetch prices or use guessed prices. The table's default model IDs are configurable test inputs,
not claims of current model availability or successful live verification.

| Case | Key environment variable | Model override | Price-variable prefix |
| --- | --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_CU_MODEL` (default `claude-sonnet-5-5`) | `ANTHROPIC` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_CU_MODEL` (default `gpt-6-luna`) | `OPENAI` |
| `google` | `GEMINI_API_KEY` | `GEMINI_CU_MODEL` (default `gemini-3.1-flash-lite`) | `GEMINI` |
| `lmstudio` | none | `LMSTUDIO_CU_MODEL` (default `qwen/qwen3.8-27b`) | none; local prices are zero |

For example, Google's price variables are `GEMINI_CU_INPUT_USD_PER_MTOK` and
`GEMINI_CU_OUTPUT_USD_PER_MTOK`. Each selected case seals its key into a disposable in-memory
keyd vault, initializes a unique task with an immutable model/price snapshot and a $0.25 keyd
budget calculated from those supplied rates, then makes one request with a 1024-token output
cap and a 30-second deadline. It checks a returned click against a generated image; no click
is sent to a real desktop. There are no model retries. Credentials and provider error bodies
are not printed, and owned transports/cells/keys are closed or deleted afterward.

A structured provider refusal for unavailable credit records a skipped case, leaving live
acceptance pending. Missing configuration, authentication errors, keyd budget or unpriced-model
refusals, invalid clicks and timeouts fail. The LM Studio case calls an existing model only when
selected and never loads, unloads or reconfigures it. Test keyd listeners use the existing
`LOCALDOT_TEST_KEYD_PORTS` range; choose a separate free range for concurrent acceptance work.

### Optional ChatGPT plan harness

The optional ChatGPT harness uses the independently measured Codex **0.154.0** release on
Apple silicon macOS. Installation is explicit; reading account or installation status does
not download it. Its credentials live in localDot's private Codex home, separate from the
user's `~/.codex`. The ordinary API-key providers remain available separately.

Sign-in uses an OpenAI device code. Browser callback sign-in is unavailable: the native
macOS rule cannot restrict port 1455 to loopback without also allowing a wildcard bind.
No broader callback profile is used. Canceling an attempt, signing out or refreshing the
account retires existing account and task processes before changing authentication.
An interrupted task requires explicit Resume after authentication changes.

The release check and offline acceptance use inert credentials and owned local services:

```sh
pnpm check:codex-release
LOCALDOT_CODEX_TESTS=1 LOCALDOT_CODEX_ARCHIVE=/absolute/path/to/darwin-arm64.tgz \
  pnpm test:codex
```

The first command verifies the committed source-bound offline receipt and the acceptance
record in `harness/codex/acceptance/record.json`. The ChatGPT plan stays switched off in the
app until that record carries a passed native sandbox stamp and a passed real-account stamp
for the exact pin and manifest; no installation state or environment variable opens it.
Stamps are produced on a supported Mac and copied from the output directory into
`harness/codex/acceptance/`:

```sh
pnpm check:codex-release --run --archive /abs/codex.tgz --out /abs/new-offline-dir
pnpm check:codex-release --native --archive /abs/codex.tgz --out /abs/new-native-dir
pnpm check:codex-release --account --archive /abs/codex.tgz --out /abs/new-account-dir
```

The offline record and the native stamp are bound to the release sources, so any change
under `harness/codex`, `apps/daemon/src` or `packages/protocol/src` needs both rerun. The
account stamp is bound only to the pin and its manifest. The `--account` run is the manual
sign-in described below; ChatGPT ships device code sign-in switched off for personal
accounts, so turn it on under ChatGPT Settings → Security first. `--native` keeps the account
stamp of the record in `harness/codex/acceptance/`, so copy the `--account` output there first,
then run `--run` and `--native` on the commit being released, copy their output and verify once.

`pnpm test:codex` runs the 15 pinned protocol/tool probes and 10 native sandbox/encrypted-refresh
probes on a supported Mac. The native cases require permission to create their own private
temporary files, inert real-home canary and local listeners. They read no existing home credential
contents. Compiler, sandbox, child-process, cleanup or unavailable-platform errors fail
acceptance. The receipt describes offline acceptance only; real account acceptance and
Linux runtime support remain unverified until separately demonstrated. The native socket
rules and private filesystem permissions do not isolate arbitrary malicious processes
already running as the same macOS user.

Real account acceptance is a separate manual command, excluded from `pnpm test` and
`pnpm test:codex`. Run it only when deliberately authorizing a real OpenAI sign-in:

```sh
LOCALDOT_CODEX_TESTS=1 LOCALDOT_CODEX_SIGNIN=1 \
  LOCALDOT_CODEX_ARCHIVE=/absolute/path/to/darwin-arm64.tgz pnpm test:codex-signin
```

It first cancels an owned device-code attempt, then prints a fresh OpenAI verification
URL and one-time code. Complete that sign-in within ten minutes. The suite checks private
ChatGPT credentials and a forced token refresh in a disposable native home, compares
metadata of the user's existing Codex directory/auth/config without reading their
contents, retires its processes and removes its exact private home after success.
A failed or uncertain cleanup retains that private home and fails the test. Keep manual
terminal output private. This command sends no model turn, quota request or usage reset;
it has not been run as part of offline acceptance. Live model acceptance still needs a
separate explicit opt-in.

## Connectors

Settings → Connectors lets dot use the user's apps through MCP tools as well as through the screen.
Connectors live in `<home>/connectors.json`; their tools, as last listed, in
`<home>/connector-tools.json`. Neither holds a key.

- **Remote apps** (streamable HTTP or SSE) are reached by the daemon through a keyd listener of
  their own (role `connector`): keyd swaps the key's stand-in for the key at the server's host.
  Sign-in apps use OAuth with PKCE in the user's browser; the access token goes straight into keyd
  as `connector-<id>`. There is no refresh: when the app stops taking it, the user signs in again.
- **Programs** (`npx`, `uvx` and the like) run in a connector cell: an internal network, a gate
  that relays only keyd (`LD_ROLE=connector`) and a read-only container with no host mounts, built
  by `cells/connector/build.sh` as `localdot/connector:dev`. MCP runs over the container's stdin
  and stdout.
- Keys named `connector-*` are never given to the computer, only to their connector.
- Each task's harness (brain, ChatGPT plan, Claude Code) is shown the enabled tools as
  `<app>__<tool>` with sanitized descriptions and schemas. Every call goes through the safety
  classifier (read-only tools run; changes ask with their exact arguments, and a yes for the task
  covers that tool only), the purpose check for its arguments, and marks the task as having read
  private data.

## README images

The README keeps the illustrated tour in one document. It uses the actual phone layout for Watch,
focused 2× screenshots, and narrow versions of the original hand-drawn diagrams. Refresh screenshots
with `node --import tsx e2e/ui/readme-capture.ts` from `apps/web` after building the app.
The capture uses a separate fixture with sample data; it never connects to a user's session.

The `*-mobile` drawings use the same paper, handwriting and doodles as the desktop versions,
with vertical layouts and lettering sized for a 288 px content width. Keep captions and full-size
links beside screenshots. Historical performance experiments belong in the measurement notes,
not in release-to-release claims in the README.

The pencil diagrams and charts in `docs/readme/` are drawn by `docs/diagrams/build.mjs` with
roughjs and the Kalam handwriting font (SIL Open Font License, in `docs/diagrams/fonts/`). The
lettering is converted to outlines, so the SVGs render anywhere without the font. Each run
writes an SVG and a PNG of every drawing. Desktop PNG fallbacks are made at two thirds of the
sheet's size, phone fallbacks at 2×, and both use `pngquant` when available:

```sh
cd docs/diagrams
pnpm install --ignore-workspace
pnpm build                  # or: node build.mjs system safety
```

The numbers in the charts come from the measurements listed in
[measurements/2026-10-readme-numbers.md](measurements/2026-10-readme-numbers.md). The
screenshots and the tour come from the fixture daemon (`apps/web/e2e/fixtures/ui-server.ts`)
with sample data only. `QA_ACTIVITY=research` starts it on a research task part-way through, with
web searches, page reads and numbered sources.

### Desktop memory and saved sign-ins

The desktop Chromium and developer tools share one container budget. Its default is
4 GiB RAM plus at most 256 MiB swap (Docker `MemorySwap` is the combined total),
not unlimited memory and not a reservation from the Docker VM. The VM still needs
capacity for the separate browser, brain and other containers. Settings › Your computer
(`GET`/`PUT /api/computer-size`, kept in `<home>/computer-size.json`) sizes one dot's computer
in 0.5 GB steps and whole CPUs, at least 2 GB and 2 CPUs, up to Docker's memory less 2 GiB and
what other running dots hold. The web browser gets three quarters of the memory and half the
CPUs. Changes apply live; less memory than the desktop uses now waits for its next start.
Available swap is
bounded by the VM's own swap configuration. Sustained oversized workloads can
still exhaust these limits; reuse preview servers and limit build/test concurrency.
`work_context` now reports the container's cgroup v2 working set, limit, swap and
cumulative OOM kills. Shell replies report new OOM kills during the command even
when the command itself succeeds, so a killed renderer is not misdiagnosed as a
lost sign-in. Unsupported counters remain unknown. No user process is automatically
killed and browser profiles are never reset to clear pressure.

Both visible browsers recognize the same verified HTTPS login forms, including
React function actions with React's exact inert throw sentinel. Arbitrary
`javascript:` actions, cross-origin forms, password-change forms and changed
identities do not qualify for saved-password reuse. Desktop perception binds the
password node to the top-level DOM snapshot's actual origin and the validated form;
the input path rechecks that identity before typing. Saved credentials remain in
keyd, outside model context. Native app or unsupported forms accept one-time private
input but explicitly report that it was not saved. Passwords supplied through the
old desktop-only path were never persisted and cannot be retroactively recovered.


Shell transport recovery retains up to 128 terminal receipts for ten minutes inside desktopd.
Receipts contain completion metadata only, never output or credentials. After a lost stream,
the daemon cancels the exact command id and reads its receipt for at most five seconds. Only a
validated terminal receipt avoids containment; unavailable/unknown/malformed results still
require recovery. Commands are never replayed, and recovered results explicitly mark output
incomplete. Critical container or shared-VM memory pressure refuses new shell work before any command starts.
VM evidence includes available RAM and the kernel full-memory-stall average, reported separately
from the container limit; absent kernel metrics remain unknown.
The desktop cap must leave room for the separate browser, brain, Docker engine and other apps;
increasing it alone is not a solution to a small VM or an unbounded development workload.


### Reclaiming old development images

From a source checkout, run `pnpm images:cleanup` to preview old localDot runtime builds,
then `pnpm images:cleanup --apply` to remove the reviewed candidates. Run between image
builds and computer updates. `LOCALDOT_HOME` selects the source installation;
`LOCALDOT_DOCKER_SOCKET` selects its local Docker socket (default `/var/run/docker.sock`).

The retention policy keeps images younger than 24 hours, current `dev`/`latest`/`stable`
tags, two development rollback generations per role, and the newest two release versions
per role and architecture. Every running or stopped container, saved image reference,
system snapshot, update checkpoint and migration base is protected. Unknown image tags,
unlabelled dangling images and unrelated repositories are retained. New runtime builds
carry `localdot.image-role`, allowing future cleanup to recognize untagged localDot builds.

The command is manual, defaults to preview, checks fresh references before each deletion,
and aborts when metadata changes or cannot be read. Docker deletion is non-forced and
ancestor pruning is disabled. A conflicting Docker reference is retained and reported.
It never deletes containers, volumes, build caches, installed apps, or recovery disk copies.
Packaged installations are deliberately refused until this operation participates in the
installer's lock and authenticated release-retention policy. There is no background timer.

Image sizes include shared layers: adding displayed sizes exaggerates savings. Compare
Docker's `system df` before and after cleanup. Build cache and APFS recovery clones can
retain underlying blocks, so removing images need not immediately free the same amount
of host disk space. Recovery checkpoint retirement is a separate, explicit operation.
See [Docker image removal](https://docs.docker.com/reference/cli/docker/image/rm/) for
alias and shared-image behavior.

### Computer-update scratch storage

A computer update commits a temporary checkpoint before migrating the stopped root filesystem.
After preparation, localDot retires that attempt's checkpoint and any candidate that failed
verification. It rechecks the original container's exact identity, image, ownership and stopped
state before each removal. The delivered candidate, original image and migration bases remain
protected. Removal is non-forced with ancestor pruning disabled; a remaining reference or failed
check retains the image without failing the update. Historical recovery snapshots and host Docker
recovery disks are not swept by this operation.

Developer release builds also leave expanded payloads and isolated npm caches beside their
immutable package archives. These are development artifacts, not installed-user data. Once a
release is verified, obsolete expanded payloads and caches may be removed while retaining its
archive, receipts, bootstrap files and all signing material. Keep current verification candidates
until publication is complete.

### Delegated agent progress

The DeepSeek harness emits bounded `subagent.state` events from upstream's paired start/end
lifecycle. The parent remains alive until every child has finished persisting its result and
delivering its settlement notification; a child's temporary idle state is not completion. The
Activity → Agents tab projects these events from the existing session stream, with virtualized
rows and lazily expanded results. It adds no model requests or polling. Existing recordings
without lifecycle events cannot reconstruct their child-agent history.

The delayed-journal regression in `cells/brain/src/harness.test.ts` covers the settlement gap.
`apps/web/e2e/ui/subagents.spec.ts` checks live and restored rows; the work-history and work-view
UI tests cover mobile collapse controls and the compact Auto/Work/Screen menu. SafeMarkdown
recognizes bounded HTTP(S) and www links, while keeping code literal and rejecting unsafe URLs.
