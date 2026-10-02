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

## keyd

`keyd/` contains the Go key service. It holds real credentials, gives cells scoped
surrogates, checks outbound destinations, scrubs credential reflections, and
enforces task and daily model budgets. Its admin API uses a private Unix socket.

From `keyd/`, run `go test -race ./...` or build with
`go build -o bin/keyd ./cmd/keyd`. For a local instance with an in-memory vault,
run `bin/keyd -home /tmp/localdot-keyd-demo -vault memory`. The admin socket is
`/tmp/localdot-keyd-demo/keyd/admin.sock`; cell listeners use ports 4760–4789.
`bin/keyd verify-audit /tmp/localdot-keyd-demo/keyd/audit.jsonl` checks the audit
chain. Use a short home path because macOS limits Unix socket path lengths.

The Go toolchain is pinned in `keyd/go.mod`. Tests use local fake providers and
make no paid model calls. The optional
`KEYD_KEYCHAIN_TEST=1 go test ./internal/vault -run LoginKeychain` exercises the
macOS login Keychain with disposable test entries. Daemon and UI integration is
the next part of development.
