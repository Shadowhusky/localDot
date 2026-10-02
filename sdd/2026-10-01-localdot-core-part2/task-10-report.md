# Task 10 report: cell API, cell status socket and upgrade router

**Status: DONE_WITH_CONCERNS**

- **Commit:** `dfaf41f feat(daemon): cell API, status stream and upgrade router` on `feat/core-part2`, on top of BASE `28b5707`.
  - The message has no `Co-Authored-By` or AI line; a grep for co-authored, claude, anthropic and generated counts 0.
  - The working tree is clean.
- **Tests:** the daemon suites are 21 files and 231 tests (HEAD: 18 and 209). `pnpm test` is 30 files and 299 tests (Task 9 left 27 and 277).
  - format, lint, typecheck and hygiene all exit 0.
  - The five suites this task touches passed 60/60 on ten runs in a row.
  - 16 mutations, all caught.
  - Two runs of the real daemon passed. They used a seeded record whose Docker objects do not exist.
  - No Docker test was added.

## Concerns

1. **The startup line prints the install token.**
   - The brief, P2-R7 and Step 5 require `open http://127.0.0.1:<port>/#token=<token>`. Task 12's "No access token" page sends the user to that link.
   - Ruling 3 says nothing logs "request paths … or tokens". I read that as request and error logging, and kept the line as P2-R7's bootstrap output.
   - The smoke run checks that this is the only place the token appears in the daemon's stdout or stderr.
   - If you read ruling 3 as covering this line, gate it on a terminal: `if (process.stdout.isTTY)`. A supervisor's log file would then never get it. Task 15 reads the token file, so nothing breaks.
2. **The doctor now fails a setup the daemon handles.** This is Task 9's Concern 2, now live.
   - `main.ts` builds its client from `findDockerSocket()` (ruling 1), so the daemon finds Docker through the CLI context or `~/.docker/run/docker.sock`.
   - `doctor.ts` still **fails** `docker-socket` whenever `socket.fix` is set, and tells the user to turn on the default socket.
   - The `DockerSocket.fix` comment ("the daemon, which reads only DOCKER_HOST and the default path") is now stale.
   - I left Task 9's files alone, because they are under review. The proposed fix is about 3 lines plus one test expectation: `socketCheck` passes with the source named, and `fix` becomes a note or goes away.
3. **The per-path ticket check belongs to Task 11** (ruling 2 allows this).
   - The check is Task 11's `cellFor`: `tickets.resolve(params.ticket) === params.id`, in `desktopRoutes` and `desktopStreamRoute`.
   - Task 10 pins three things:
     - each cell's ticket resolves only to that cell;
     - the minted `path` names its own cell and ticket;
     - the router hands ticket routes their own authorisation, after Host and Origin.
   - **Carry to Task 11:** its brief's HTTP test covers another cell's path with this cell's ticket. Its WebSocket test checks only a bad ticket, so add cell A's ticket on cell B's `/api/websockets` path, expecting 403.
4. **Temp dirs.** The brief's `setup()` leaked one `local dot's api-*` EventLog folder per test (13 per run). I removed all 300 such folders from `$TMPDIR`:
   - 215 came from my runs.
   - 85 predate my first run. The prefix exists in no committed file, so they likely came from the pre-flight scan's scratch copy.

   The suite now shares one log per file and removes it in `afterAll`. A run leaves none behind (checked).

## What changed beyond the brief, and why

1. **The router guards `route.open()`** (`upgrade-router.ts`).
   - A throw inside the `upgrade` listener is an uncaught exception, and it would end the daemon.
   - The status route throws whenever `CellStore.get()` rethrows EACCES, EISDIR or EIO for an unreadable `cell.json`. The Task 8 ruling forbids exactly this crash path.
   - Now a throw gets a `500 Internal Server Error` and exactly one line: `upgrade <route pattern> failed (<err.code or err.name>)`. The error's message is never logged: it can quote the request, and tickets travel in paths (ruling 3).
   - **RED on the brief's router:** both new tests hit an uncaught error, then a 5 s timeout. Vitest's unhandled-error dump showed the ticket path, `Error: cannot open /cells/C/desktop/TTTTTTTTTTTTTTTTTTTTTT/ws`, which is the leak the fixed line avoids. The status test showed `Error: EACCES: permission denied, open '/x/cells/01M3…/cell.json'`.
2. **`POST /api/cells` with a JSON `null` body.**
   - The brief's `(await c.req.json().catch(() => ({}))).scale` threw `TypeError: Cannot read properties of null (reading 'scale')`. That gave a 500, and Hono's default handler logged the stack.
   - The fix is `((await c.req.json().catch(() => null)) ?? {})`, which treats `null` like an empty body: scale 2, as before.
   - RED: `expected 500 to be 202`.
3. **`main.ts`** uses `new DockerClient(findDockerSocket().path)` (ruling 1).
   - Everything else is the brief's block.
   - HEAD's `server.on("error")` port-in-use handler is unchanged (ruling 5), and reconcile is still awaited before `serve()`.
   - Biome only rewrapped the reconcile call and the router call.
4. **Fake orchestrator.** `remove(id, opts)` records `{ id, purgeHome }` in `removals`, after `#require`, so the `?purge=1` mapping can be pinned. Purge deletes the user's home volume.
5. **New tests:**
   - 8 in `api.test.ts`;
   - 2 in `status-stream.test.ts`;
   - a new `upgrade-router.test.ts` with 5 tests. It is not in the brief's file list: the router is new code, and ruling 4's "before any handler runs" needs a test with a spy handler.
6. **Kept from Part 1:** WebSocket upgrades also accept `Authorization: Bearer`, for non-browser clients. Part 1's "accepts a non-browser client with a bearer header and no origin" must keep passing. Cookies, query tokens and a lone `localdot.v1` are refused, which is pinned.

## P2-R2: each rule and the test that pins it

| P2-R2 rule | Pinned by (file › test) | Mutations caught |
|---|---|---|
| Minted only through the authenticated API | `cells/api.test.ts` › "mints stream tickets only through the authenticated API". These are refused, and `TicketRegistry.issue` is never called: no token, a wrong bearer, the token in a cookie, in the `sec-websocket-protocol` header or in `?token=`, a foreign Origin, a foreign Host, and GET. Then one bearer POST calls `issue` exactly once. Also "requires the install token" (brief). Neither upgrade route nor the router can reach the registry: none of them takes a `TicketRegistry`. | M4 (cell routes registered before the `/api/*` token middleware), M6 (HTTP also reads the subprotocol header) |
| Only for a `ready` cell | `cells/api.test.ts` › "refuses a ticket while the cell is anything but ready". starting, stopping, stopped and failed each give 409 `cell is <state>`, and `issue` is never called. Also "issues stream tickets only for ready cells and revokes them on removal" (brief). | M5 (409 only when stopped) |
| One live ticket: the same one while the cell stays ready | The brief's test re-mints the same ticket. "writes nothing to the console…" re-mints the same ticket. "revokes the ticket whenever…" shows a `updateStream` event on a ready cell keeps it. | M3 (revoke on every event) |
| Revoked when the cell leaves `ready`, through the orchestrator subscription | `cells/api.test.ts` › "revokes the ticket whenever the cell leaves ready, with no API call involved". The orchestrator alone emits starting (the watch loop's restart), stopping, stopped, failed and removed, and each revokes. Also "gives each cell its own ticket and path, and revokes per cell" (stopping), and the brief's test (stop route). | M1 (no subscription), M2 (revoke only on stopped or removed) |
| Revoked when the cell is removed | The brief's test (DELETE). `cells/api.test.ts` › "revokes the ticket on removal even when the orchestrator sends no event": `remove` is mocked to emit nothing, as the real `#emit` does when `cell.json` is unreadable, and the explicit revoke still runs. "removed" is also in the subscription test. | M16 (explicit revoke after DELETE removed) |
| Resolves only for its own cell's stream path | `cells/api.test.ts` › "gives each cell its own ticket and path, and revokes per cell":<br>• two ready cells get different tickets;<br>• each resolves to its own cell;<br>• `path` is `/cells/<own id>/desktop/<own ticket>/`;<br>• revoking A leaves B.<br>`upgrade-router.test.ts` › "checks Host and Origin before any route and leaves a ticket route to authorise itself". **The path check itself is Task 11's** `cellFor` (see Concern 3). | M9 (ticket routes made to demand the install token), M10 (ticket routes skip Host/Origin) |
| Compared in constant time, through `TicketRegistry` | Task 10 compares no ticket anywhere: an audit grep finds only `issue` and `revoke` calls outside `secrets.ts`. The only compare is `TicketRegistry.resolve` (`timingSafeEqual`), pinned by Task 7's `secrets.test.ts` › "compares a presented ticket with every live one in constant time". Task 11's `cellFor` goes through `resolve`. | (Task 7's) |
| Never logged (with ruling 3: no request paths, no tokens) | `cells/api.test.ts` › "writes nothing to the console while it mints, re-mints and revokes tickets". `upgrade-router.test.ts` › "writes no request path, ticket or token to the console" (accepted, refused, 404 and 400 upgrades on a ticket-bearing path). `upgrade-router.test.ts` › "answers 500 when a route throws, logs only the route's pattern…": the thrown message quotes the ticket path and is not logged. | M11 (log `err.message`), M12 (log each upgrade's path), M14 (API request logger) |
| Memory only, so a daemon restart revokes all | Task 7's `secrets.test.ts`. `main.ts` makes one `new TicketRegistry()` per process and persists nothing. | n/a |

## The other rulings

- **Ruling 4, cookie-free auth:**
  - **HTTP is bearer only.** Pinned by the mint test above: a cookie, the subprotocol header and `?token=` all get 401. Mutation M6 is caught.
  - **The server selects only `localdot.v1`.** Pinned for the new route by `status-stream.test.ts` › "selects localdot.v1 and never echoes the token subprotocol", with the token protocol offered first. Mutation M13 is caught. The session route keeps Part 1's test.
  - **Unauthenticated upgrades are refused before any handler runs.** Pinned by `upgrade-router.test.ts` › "refuses a token route without the install token before its handler runs": these get 403 with the spy handler never called:
    - no token, a wrong token, a lone `localdot.v1`, a cookie, `?token=`.

    Mutation M8 is caught. The status test's missing-token case also gets 403.
  - **Unmatched paths** get 404 without any handler.
- **Ruling 5:** see item 3 above.
- **Ruling 6:** no Docker tests. The smoke runs sent Docker only GET and DELETE requests for `localdot-test-smoke-*` names that never existed. `docker ps -a`, `network ls` and `volume ls` with `--filter name=localdot-test-smoke` were empty, with exit 0, before and after. Port 4750 was free again afterwards.
- **Ruling 7:** see the commit line at the top.

## Verification

| Command | Result |
|---|---|
| `pnpm exec vitest run apps/daemon/src/event-stream.test.ts` (Step 1, the brief's router and event-stream) | 10/10, the Part 1 tests unchanged |
| Step 4 RED, the brief's tests | `status-stream.test.ts`: `Cannot find module './status-stream.ts'` (Vitest 5's wording for "Failed to load url"). `api.test.ts`: 4/5 fail, every route answering 404. tsc: `'cells' does not exist in type 'AppOptions'` and `Cannot find module './status-stream.ts'` |
| Step 4 GREEN, the brief's code | 7/7, and the daemon typecheck passes |
| The extra tests on the brief's code | 3 RED (items 1 and 2 above). The other 12 pass: they pin behaviour the brief already has, so each was proven by a mutation (below) |
| The five touched suites after the fixes | 60/60, on ten runs in a row |
| `pnpm exec vitest run apps/daemon/src` | 21 files, 231 tests |
| `pnpm format` / `pnpm exec biome check --write apps/daemon/src` / `pnpm lint` | `pnpm format` rewrapped 7 files (the brief's long lines), with no import-order fixes needed. lint exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm hygiene` | exit 0 |
| `pnpm test` | 30 files, 299 tests, exit 0 |

### Mutations

Each was applied alone, then the suite was run and the file restored. Every restore was checked byte-for-byte with `filecmp`.

| Mutation | Caught by |
|---|---|
| M1 no revoke subscription | the brief's ticket test, "revokes…whenever", "gives each cell…" |
| M2 revoke only on stopped or removed | "revokes…whenever", "gives each cell…" |
| M3 revoke on every event | "revokes…whenever" (the stream update must keep the ticket) |
| M4 cell routes before the token middleware | "requires the install token", "mints…only through the authenticated API", "writes nothing…" |
| M5 ticket for any state but stopped | the brief's ticket test, "refuses a ticket while…" |
| M6 HTTP also reads the token subprotocol | "mints…only through the authenticated API" |
| M7 purge on any `purge` query | "purges the home volume only when asked with purge=1" |
| M8 router skips the token check | "refuses a token route…", "writes no request path…" |
| M9 router demands the token on ticket routes | "checks Host and Origin…", "answers 500…", "writes no request path…" |
| M10 ticket routes skip Host and Origin | "checks Host and Origin…", "writes no request path…" |
| M11 log the thrown error's message | "answers 500 when a route throws, logs only the route's pattern…" |
| M12 log each upgrade's path | "writes no request path, ticket or token to the console" |
| M13 select the first offered subprotocol | "selects localdot.v1 and never echoes the token subprotocol" |
| M14 API request logger | "writes nothing to the console while it mints…" |
| M15 no guard around `open()` | "answers 500 when a route throws…", "answers 500 to an unreadable cell record…" (both time out on the uncaught error) |
| M16 no explicit revoke after DELETE | "revokes the ticket on removal even when the orchestrator sends no event" |

### The real daemon (Step 5)

The smoke script started `node --import tsx src/main.ts` from `apps/daemon` with a temp `LOCALDOT_HOME` and port 4750. The home held one seeded, shape-valid `cell.json` whose Docker names are `localdot-test-smoke-*`. The script lives in the scratchpad and was not committed. All 16 checks passed:

- the daemon line and `open http://127.0.0.1:4750/#token=<token>`, with the token equal to `daemon-token`;
- **reconcile reached the engine through `findDockerSocket()`**: the cell shows `failed`, "containers missing: removed outside localDot", which is the engine's 404. An unreachable socket would have said "is Docker Desktop running?";
- `/healthz` 200;
- `/api/cells` without the token 401;
- stream-ticket for the failed cell: 409 `cell is failed`;
- the status socket:
  - without the token: 403;
  - for an unknown cell: 404;
- the session-stream route is wired: an unknown session gets 404;
- the status socket selected only `localdot.v1`;
- `DELETE` gave 204, and the status socket sent `failed` then `removed` and closed with 1000;
- no cells left;
- SIGTERM: exit 143, lock released;
- the token appears exactly once in all daemon output.

The daemon's output, with the token redacted:
```
localdot daemon on http://127.0.0.1:4750 (token in /var/folders/…/T/ld-smoke-SpbQSe/daemon-token)
open http://127.0.0.1:4750/#token=<token>
--- daemon stderr ---
(empty)
```
The brief's literal command, `pnpm --filter @localdot/daemon start`, was also run in its own process group and stopped with SIGINT to the group (Ctrl-C). It printed both lines, exited 130 and released the lock. pnpm also printed its usual `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL … Exit status 130`. Both temp homes were removed.

## Notes (minor, not blocking)

- **No revoke if `cell.json` is unreadable when a state changes.** `CellOrchestrator.#emit` then sends no event, so the subscription cannot revoke. Removal is covered by the explicit revoke. A ticket left for a cell that is not ready reaches no stream: `endpoints()` is undefined without ports, so Task 11 answers 503.
- **Hono's default `onError` logs any thrown error with `console.error(err)`.** No Task 10 route throws an error that carries a request path or a secret. Task 11's ticket-path routes should keep it that way, or install an `app.onError` that logs a fixed line.
