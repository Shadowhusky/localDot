# localDot

An open-source, localhost-first personal assistant that works inside its own isolated virtual
computer and shows exactly what it is doing, action by action.

Status: early development.

## Development

Needs Node 24+ and pnpm 10. After `pnpm install`, the root scripts are:

- `pnpm test`: the Vitest suites of the apps, packages and scripts
- `pnpm typecheck`: `tsc --noEmit` in each app and package
- `pnpm format`, then `pnpm lint`: Biome
- `pnpm hygiene`: scans the files git tracks or would add for key-shaped secrets and private names

Run the daemon with `pnpm --filter @localdot/daemon start`. It listens on `http://127.0.0.1:4750`
(`LOCALDOT_PORT` sets another port) and keeps its state in `~/.localdot` (`LOCALDOT_HOME` sets
another home). One daemon runs per home. The install token is in `<home>/daemon-token`, and auth is
cookie-free: HTTP requests send `Authorization: Bearer <token>`, and WebSocket clients offer the
subprotocols `localdot.v1, localdot.token.<token>`.

## Images and the live desktop

- `cells/gate/build.sh` builds `localdot/gate:dev`; `cells/desktop/build.sh` bundles `desktopd`
  and builds `localdot/desktop:dev`. The first desktop build takes about 10–25 minutes.
- `pnpm --filter @localdot/daemon doctor` checks Docker Desktop (Engine 28+), the images and
  the daemon port.
- Build the UI with `pnpm --filter @localdot/web build`, start the daemon, then open its
  `#token=` link. **Start computer** creates an isolated desktop, gate and named home volume.
  The live stream reaches Chrome through the daemon. **Stop computer** shuts it down while
  keeping the home volume for the next start. During a session, **Stop** freezes it;
  **Resume computer** continues it with fresh key stand-ins.
- The desktop has the WhiteSur light theme, a menu bar and a Plank dock. Pinned versions and
  licenses are in `cells/desktop/THIRD-PARTY.md`.
- `LOCALDOT_DOCKER_TESTS=1 pnpm test:docker` runs the Docker suites.
  `LOCALDOT_DOCKER_TESTS=1 pnpm --filter @localdot/web e2e` checks the live desktop in installed
  Google Chrome, including Stop/Start, Stop/Resume, key management and daemon restart recovery.
- `LOCALDOT_MEASURE=1 pnpm --filter @localdot/web e2e --grep measure` records frame rate and CPU.
  Repeat with `LOCALDOT_STREAM_FULLCOLOR=0` to measure 4:2:0 instead of the default 4:4:4.
  Both modes keep the stream setting locked in the client. Results and screenshots are in
  `apps/web/e2e/out/`.
- Processes that need to stop the daemon should run `node --import tsx src/main.ts` from
  `apps/daemon`; pnpm's start command does not forward SIGTERM.
- `apps/web/vendor/selkies` is the pinned MPL-2.0 client served by the daemon. The cell supplies
  stream data; the client code comes from the local installation.

The token fragment is removed from the visible URL after loading. Browser history may retain
the original install link, so treat that link as a credential.

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
