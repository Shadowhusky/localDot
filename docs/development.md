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
20 GiB, oldest first; events and captured screenshots remain. `LOCALDOT_RECORDING=0` disables
new video recordings. See [the Replay guide](replay.md) for privacy, retention settings,
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
`-stun off` disables that fallback; `-natpmp off -stun off` disables discovery.
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
`LOCALDOT_KEYD_PORTS` (default `4760-4789`) must match keyd's `-ports`.

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
DSH's session is currently a process-local orchestration log; it is **not** a second durable
conversation store. Restart restores localDot's saved transcript and inbox cursor. Model
requests continue through the AI SDK and keyd; tools continue through the authenticated
daemon API at `127.0.0.1:4751`, including JEV approvals and computer ownership checks.
No default DSH shell, credential store, session uploader or telemetry plugin is mounted.

**Stop** ends the agent run and revokes its access. It does not shut down the computer;
new conversations use the existing desktop. Computer recovery remains a daemon concern,
independent of the harness. Switching frameworks does not by itself improve a model's
screen recognition or eliminate browser failures.

The chat and model picker use the core API with the existing install-token
Authorization header and JSON request bodies:

- `GET /api/agent/providers` lists providers, catalog models, capabilities and available key IDs.
  `POST /api/agent/catalog/refresh` refreshes the models.dev catalog.
- `GET` and `PUT /api/agent/settings` read or replace settings. `main` drives the task, optional
  `fast` handles summaries, and optional `local` provides a fallback. A role choice contains
  `provider`, `model`, and a stored `key` ID for remote providers. LM Studio and Ollama need no
  key; keyd reaches them on `127.0.0.1:1234` and `:11434` respectively.
- Remote models missing a catalog price need an explicit `price` object containing both
  `inputUSDPerMTok` and `outputUSDPerMTok` (finite values from 0 to 10000, at least one positive).
  Optional `taskBudgetUSD` sets the initial spending limit. Each task keeps its selected models
  and immutable price table across brain restarts and follow-ups; editing settings affects new tasks.
- `POST /api/cells/<id>/agent` with `{"task":"…"}` starts on a ready computer and returns a
  `sessionId`. Follow-ups use `POST /api/agent/sessions/<id>/messages` with
  `{"kind":"followup","text":"…"}`; use `"steer"` to redirect current work. Do not automatically
  resend a mutation if its reply is lost: reconcile the session and event log first.
- Questions and hand-back require the current `askId` or `requestId` from the session snapshot.
  Completed files are downloaded from `/api/agent/sessions/<id>/files/<name>`, as attachments.

Memory lives in `<home>/memory/USER.md` and `MEMORY.md` (normally under `~/.localdot`). Skills
are `SKILL.md` directories under `<home>/skills/` and this repository's `skills/`; task startup
copies them into the computer's `~/.skills/`. Memory is context, including assistant-written
notes, rather than a source of new user instructions.

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
