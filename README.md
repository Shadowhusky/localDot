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
