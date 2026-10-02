# Task 7 report: cell records, per-cell tokens, stream tickets and keyd ports

**Status: DONE_WITH_CONCERNS.** All five modules and three test files are built to the brief and
verified. The concern is three small deviations in `store.ts`, for the controller to accept or
veto. The first is a real leak: the brief's log line can write per-cell token text to stderr. Each
deviation has RED evidence against the brief's code. I also added 8 tests (5 of them new `it`s
pinning the P2-R2 ticket properties, the F24 reservation contract and the store fixes), each shown
non-vacuous by RED or by a mutation.

Branch `feat/core-part2`, base `787802b`. The working tree is clean after the commit.

| Commit | Message |
|---|---|
| `2f6d921` | `feat(daemon): cell records, per-cell tokens, tickets and keyd ports` |

The commit body is empty: no `Co-Authored-By` line and no AI attribution (checked with grep).

## Test summary

| Check | Result |
|---|---|
| `pnpm exec vitest run apps/daemon/src/cells/{store,secrets,ports}.test.ts` | 15/15: the brief's 7 + 8 added (store 3, secrets 4, ports 1). Stable over 5 repeated runs |
| `pnpm test` | 22 files, 194 tests passed (179 at base `787802b` + 15) |
| `pnpm format` | rewrapped one long object literal in `store.test.ts` (formatting only) |
| `pnpm exec biome check --write apps/daemon/src/cells` | no fixes needed (import order already right) |
| `pnpm lint` | exit 0. Biome first flagged `noUnsafeOptionalChaining` in my 128-bit test; fixed by restructuring |
| `pnpm typecheck` | exit 0 (all 5 workspace projects) |
| `pnpm hygiene` | exit 0 |
| Docker tests | none in this task (no Docker surface) |

Host: Node v25.6.0 (`.nvmrc` says 24; no Node 24 binary on this Mac).

## Steps

- **Step 1.** `types.ts` written verbatim. Checked against desktopd's served shape
  (`cells/desktop/desktopd/src/app.ts` `DesktopdHealth` / `HidpiReport`, `xsettings.ts` `Screen`):
  they match field for field.
- **Step 2.** `testing/sample-record.ts` and the brief's three test files, verbatim.
- **Step 3, RED.** 3 files fail to load: `Error: Cannot find module './store.ts' | './secrets.ts' |
  './ports.ts' imported from …`. That is Vitest 5's wording for "Failed to load url" (as in Tasks 5
  and 6). No tests ran.
- **Step 4.** `store.ts`, `secrets.ts` and `ports.ts`, verbatim from the brief.
- **Step 5, GREEN.** 7/7, as the brief expects.
- **Then the additions,** by TDD. The store tests are RED on the brief's code (below). The
  ticket and port tests pin properties the brief's code already has, so I proved them with
  mutations instead.
- **Then the store fixes.** GREEN at 15/15, then `pnpm format && pnpm lint`, typecheck, hygiene,
  `pnpm test`, and the commit.

## Deviations in `store.ts` (accept or veto)

1. **A corrupt `cell.json` is logged without the parser's message.** The brief logs
   `` `cell ${id}: unreadable record: ${String(err)}` ``. V8 quotes the input text around the fault in
   some `SyntaxError`s, and `cell.json` holds the tokens. I checked this on Node 25.6.0:
   `Unexpected token 's', ...""stream": ssssssssss"... is not valid JSON`. Controller note 2 says
   tokens never appear in logs. Now `JSON.parse` sits in its own `try`, the log is the fixed
   `` `cell ${id}: cell.json is not valid JSON, skipping it` ``, and the shape check is null-safe
   (`record?.v === 1 && record.id === id`), so `null`, numbers and strings return `undefined`
   without throwing.
   - RED on the brief's code: `expected 'cell 01M3…: unreadable record: SyntaxError: Unexpected
     token 'S', ...""stream": SSSSSSSSSS"... is not valid JSON' not to contain 'SSSS'`.
2. **`save()` refuses a non-ULID id** (`invalid cell id`), as `remove()` already did. Both now
   go through one `#dir(id)` helper. The brief's `save({ id: "../escape" })` wrote
   `<home>/escape/cell.json`, outside `cells/`. Part 3's frame store makes the same check on save.
   - RED: `expected [Function] to throw an error`.
3. **The constructor tightens `<home>/cells` to 0700** if the folder already exists. This mirrors
   Part 1's token store, which tightens a reused file. `mkdirSync` leaves an existing folder's mode
   alone, and a 0700 `cells/` keeps every `cell.json` private whatever the file's own mode.
   - RED: `expected 493 to be 448` (0755 stayed).

All other code is the brief's, byte for byte: `types.ts`, `sample-record.ts`, `secrets.ts`,
`ports.ts`, and the rest of `store.ts`, including the atomic temp + rename write. Nothing
downstream depends on the old log text (grep of the Part 2/3 plans and the Task 8 brief). The
plan's line 3307 still shows the leaking line, if the plan is ever reused.

## Controller note 1: the P2-R2 ticket properties, each pinned

| Property | Pinned by | Non-vacuous? |
|---|---|---|
| 128 random bits | new: `issue` calls `randomBytes` exactly once with 16, and the ticket is exactly that buffer's base64url | mutation: `Math.random()` bytes → this test fails, the brief's pass |
| One live ticket per cell | brief: a second `issue("cell-a")` returns `t1` | brief test |
| Compared in constant time | new: a same-length miss calls `timingSafeEqual` once per live ticket (2) | mutation: `live === ticket` → fails, the brief's pass |
| Never logged | new: the registry's whole life (issue, re-issue, hit, miss, malformed, revoke) writes nothing via `console.{debug,error,info,log,trace,warn}` | mutation: `console.debug` of the ticket in `issue` → fails |
| Scoped to one cell | brief: `resolve` returns exactly the issuing cell (`t1`→a, `t2`→b). The path check is Task 11's `cellFor` (`resolve(ticket) === id`), tested at plan 6121–6132 (other cell's ticket → 403) | brief test + Task 11 |
| Revoked on leaving `ready` / on remove | registry: brief's `revoke` test (the revoked ticket stops resolving, the other cell's still does, re-issue gives a new one). Wiring: Task 10's `cellRoutes` (plan 5644–5647, 5688), tested at 5472–5492 | brief test + Task 10 |
| Revoked on daemon restart (memory only) | new: a fresh registry resolves none of another registry's tickets and mints a new one | mutation: a module-level shared map → fails with `expected 'cell-a' to be undefined` |
| Minted only through the authenticated API | registry: `issue()` is the only minting path; `resolve` never mints. The guard is Task 10's `POST /api/cells/:id/stream-ticket` behind the install token (plan 5694–5701, test 5472) | Task 10 |

The secrets tests mock `node:crypto` with pass-through `vi.fn` spies (`randomBytes`,
`timingSafeEqual`), in the style of `token.test.ts`'s `node:fs` mock. Behaviour is unchanged. The
flip-last-character logic is a shared `lastCharFlipped` helper, which the brief's test now uses
too (same assertion).

## Controller note 2: per-cell tokens in logs, errors and file modes

- **Logs:** the only log line in these modules is deviation 1, now fixed. The registry never
  logs (pinned).
- **Errors:** the only thrown messages are `invalid cell id`, the keyd range error and `fs` errors
  that carry paths (ULIDs), never file contents.
- **Modes:** `cells/` is 0700 (tightened if it already existed), `cells/<id>/` is 0700, and
  `cell.json` is 0600 via a `wx` temp file and a rename.
- The round-trip test now also asserts:
  - `cells/<id>` is 0700;
  - a second `save` replaces the record, stays 0600 and leaves only `cell.json` (no temp debris).
    A copy-instead-of-rename mutation fails it with `expected [ 'cell.json', …(2) ] to deeply
    equal [ 'cell.json' ]`.

## Controller note 3: how keyd port allocation stays safe for concurrent creates

`allocateKeydPort(inUse: Iterable<number>): number` is **synchronous and pure**. It reads
whatever iterable the caller passes, at call time, and keeps no state. The caller holds the
in-memory "taken" set, and that is exactly Task 8's brief:
`allocateKeydPort([...store.list().map((r) => r.keydPort), ...this.#reservedKeydPorts])`, then
`#reservedKeydPorts.add(port)` before the first `await`, released in `finally` once the record is
saved or undone. JS runs that allocate-and-reserve span without interleaving, so two concurrent
`create()`s can't get the same port.

The new test pins this contract: two concurrent async creates, each allocating against
`[...saved, ...reserved]` and reserving before `await`, get `[4761, 4762]`. Making the allocator
async fails it.

## Controller notes 4–6

- **Names:** `sample-record.ts` builds every Docker name from the id it is given (a `ulid()` by
  default, or Task 8's fixed `01JXYZ…ABCD`, a valid ULID). The store builds paths only from ids
  that pass `ULID_PATTERN` (`get` returns `undefined`; `save` and `remove` throw). There are no
  Docker API paths in this task.
- **Docker:** no Docker tests here, and none were run.
- **Commit:** conventional subject, no attribution. Only `/Volumes/Husky's SSD 4T/Projects/localdot`
  was touched; temporary evidence lives in the session scratchpad.

## Concerns and carry-forward

1. **Deviations 1–3** above: accept or veto. Reverting one costs a few lines and one test.
2. **Tickets ride in URL paths** (`/cells/:id/desktop/:ticket/…`). Today nothing logs request paths:
   no request logger in `app.ts`/`main.ts`, and none of the plan's `console.*` calls print a path.
   Tasks 10, 11 and later should keep it that way, or redact the ticket segment, if any access or
   error log ever includes a path.
3. **Minor, kept as in the brief:**
   - `get()` rethrows non-`ENOENT` read errors (`EACCES`, `EISDIR`, `ENOTDIR`), so one bad entry
     makes the whole `list()` throw.
   - A crash between the temp write and the rename leaves a `cell.json.<hex>.tmp` (0600) in a
     folder that `list()` skips but nothing cleans up until `remove`.
   - Two records with the same millisecond `createdAt` keep readdir order.
