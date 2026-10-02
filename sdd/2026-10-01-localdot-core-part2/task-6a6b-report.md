# Tasks 6a + 6b report: daemon lock residuals, session metadata in the session folder

**Status: DONE_WITH_CONCERNS.** 6a is DONE. 6b is built to the brief, verbatim, and verified. Its
concern: the brief's recovery code adds an index write outside the event log's index guard. With
the index locked, an append to a session that is not cached now fails, where HEAD kept appending.
A scratch repro shows it, and a 2-hunk fix is proposed below. That fix is verified but **not
applied**, for the controller to rule on. 6b also adds one test beyond the brief (a pin for the
brief's own tie-break), and there is one Minor note.

Branch `feat/core-part2`, base `46bb349`. The working tree is clean after both commits.

| Task | Commit | Message |
|---|---|---|
| 6a | `f2cf20e` | `fix(daemon): publish the lock with its pid, treat own pid as stale, handle SIGHUP` |
| 6b | `84484e7` | `feat(daemon): keep session metadata in the session folder and rebuild the index from it` |

Both commit bodies are empty, with no `Co-Authored-By` or AI attribution (checked with
`git log --format=%b`). Only port 4795 was used. Nothing was listening on 4750, and 4750 was not
touched. The two RED baselines on HEAD code (6a's `main.ts`, 6b's `event-log.ts`) each ran from a
throwaway `src/zz-*.ts` copy, which was deleted at once (`git status` clean afterwards).

---

## Task 6a: Daemon lock residuals

### Test summary

| Check | Result |
|---|---|
| `pnpm exec vitest run apps/daemon/src/lock.test.ts` | 10/10. None skipped: this is not root, so the unreadable-lock case ran |
| Step 4: lock + app + port suites | 3 files, 52 tests passed |
| `pnpm test` | 19 files, 164 passed (161 at `46bb349`, plus 3 net new lock cases) |
| `pnpm format` | rewrapped `lock.ts` and `lock.test.ts` to 100 columns (formatting only) |
| `pnpm lint` | exit 0, no fixes |
| `pnpm typecheck` | exit 0 |
| `pnpm hygiene` | exit 0 |

### Steps

- **Step 1.** `lock.test.ts` was replaced with the brief's file, verbatim.
- **Step 2, RED.** 3 failed, 7 passed:
  - own pid: `DaemonLockedError: another localdot daemon is running (pid 46157)`, as the brief
    predicts.
  - directory: received `EISDIR: illegal operation on a directory, read`.
  - unreadable: received `EACCES: permission denied, open '…/daemon.lock'`.
  - "`DaemonLockError` is not exported" shows in `tsc`:
    `src/lock.test.ts(15,29): error TS2724: '"./lock.ts"' has no exported member named 'DaemonLockError'`.
    At runtime, Vitest's transform reads the missing export as `undefined`. `toThrow(undefined)`
    then passes on any throw, so only the message assertions fail.
- **Step 3.** `lock.ts` was written as the brief gives it, and the two `main.ts` places changed as
  given: the import, `SIGHUP` in the signal list, and both error branches in `lockHome`. The two
  trivia (F29):
  - **SUMMARY D18:** the ")" is restored. It now reads `README.md 'Decision'): C: Theatre`, which
    matches the ledger source (umbrella
    `docs/superpowers/plans/2026-09-30-localdot-core-part1-carry-forward.md:17`).
  - **`DEFAULT_PORT`:** `git grep -n DEFAULT_PORT` lists only `port.ts:1` and `port.ts:4`, so the
    `export` is dropped. `parsePort` is unchanged.
- **Step 4, GREEN.** 10/10, and the app and port tests pass. The manual SIGHUP check ran as written
  (F22), under bash, as an exec'd node on 4795 with a captured `LOCALDOT_HOME`:
  ```
  localdot daemon on http://127.0.0.1:4795 (token in /var/folders/…/tmp.eTtm0GBBVI/h/daemon-token)
  exit 129
  daemon-token
  index.sqlite
  sessions
  ```
  The output matches the brief: `exit 129`, the token and the event log, and no `daemon.lock`.
  **The RED baseline** is the same command against HEAD's `main.ts`:
  ```
  bash: line 6: 47340 Hangup: 1   ( cd "$d" && exec env … node --import tsx src/zz-main-head-check.ts )
  exit 129
  daemon-token
  daemon.lock
  index.sqlite
  sessions
  ```
  The exit code alone does not tell the two apart, because a shell reports death by SIGHUP as 129
  too. What differs is the lock: HEAD dies from the signal and leaves `daemon.lock` behind. The new
  code exits through its handler, and the `exit` hook releases the lock.
- **Extra check on `lockHome`.** Each case prints one line, exits 1 and shows no stack trace:
  ```
  …/h/daemon.lock is a directory; remove it or point LOCALDOT_HOME elsewhere            (exit 1)
  another localdot daemon is running (pid 47498); remove …/h/daemon.lock if that process is not localdot   (exit 1)
  cannot read …/h/daemon.lock (EACCES); fix its permissions or remove it                 (exit 1)
  ```
- **Step 5.** `pnpm format && pnpm lint && pnpm typecheck`, then the commit with the brief's
  message and files.

### Self-review

- **Temp file.** After a successful `link`, the `finally` removes the temp, which is a second name
  for the same inode. A `rename` consumes the temp. On a throw, the `finally` removes it. The
  `readdirSync(home)` assertions show that no `.tmp` file is left in any path.
- **The lock is never empty.** The lock appears only by `link` or `rename` of a file whose content
  is already complete, so no reader can see an empty lock.
- **Note (pre-existing, unchanged, Minor).** Two daemons starting in the same instant against the
  same stale lock can both pass the liveness check and both `rename` over it. The last rename wins,
  and both run. HEAD's `replaceStale` had the same window, and the brief does not address it, so I
  left it. It needs a simultaneous double start on a stale lock.
- **Out of scope.** A home directory that cannot be written still fails at the temp
  `writeFileSync` with a raw error and a stack trace. The brief names only an unreadable lock and
  a directory at the lock path.

---

## Task 6b: Session metadata in the session folder

### Test summary

| Check | Result |
|---|---|
| Step 4: `vitest run packages/protocol/src apps/daemon/src/event-log.test.ts apps/daemon/src/event-stream.test.ts apps/daemon/src/app.test.ts` | 5 files, 69 passed (the brief's 68, plus the added tie-break pin) |
| `pnpm --filter @localdot/protocol schema && git diff --exit-code packages/protocol/schema` | schema unchanged (exit 0) |
| `pnpm test` | 19 files, 170 passed (164, plus 2 `ulidTime`, 3 brief event-log tests and 1 added) |
| `pnpm format` | rewrapped `event-log.test.ts` (long lines, and the `for … rmSync` one-liner became a two-line braceless `for`) |
| `pnpm exec biome check --write` on the 4 files | no fixes: the import order was already right (`node:crypto` before `node:fs`) |
| `pnpm lint` / `pnpm typecheck` / `pnpm hygiene` | exit 0 / 0 / 0 |

### Steps

- **Step 1.** The brief's tests were appended verbatim, with `ulidTime` added to the `./ids.ts`
  import and `rmSync` to the `node:fs` import.
- **Step 2, RED.** 5 failed, 19 passed:
  - both `ulidTime` tests: `TypeError: ulidTime is not a function`. The second test sees that
    `TypeError` where it expects a `RangeError`.
  - stores: `ENOENT: no such file or directory, stat '…/sessions/<id>/session.json'`.
  - rebuilds: `expected [] to deeply equal [ { …(4) }, { …(4) } ]`.
  - derives: `ENOENT: no such file or directory, open '…/sessions/<id>/session.json'`.
- **Step 3.** All of it as the brief gives it: `ulidTime`, the event-log imports, `SessionMeta`,
  `createSession` writing `session.json` before the index row, the `INSERT OR IGNORE` in
  `#stateOf`, `writeMeta`, `readMeta`, and `ORDER BY s.started_at DESC, s.id DESC`.
- **Step 4, GREEN.** The F32 vector holds: `ulidTime("01ARZ3NDEKTSV4RRFFQ69G5FAV")` is
  `1_469_922_850_259`. `ulid(1_759_312_800_000)` is derived to `2025-10-01T10:00:00.000Z`.
- **Step 5.** `pnpm format && pnpm lint && pnpm typecheck`, then the commit with the brief's
  message and files. On the final tree, the 6a SIGHUP check was re-run: the daemon boots with the
  new event log and gives the same output (`exit 129`, no `daemon.lock`, 4795 free afterwards).

### Addition beyond the brief: a test that pins the tie-break

The brief adds `s.id DESC` so that list order survives a rebuild, but none of its tests detect
removing it. I dropped `, s.id DESC` from a scratch copy, and the rebuild test still passed in 5
of 5 runs: SQLite returns tied rows in id order both before and after the rebuild. So I added one
test, `orders sessions that start in the same millisecond by id, highest first`. It makes two
folders with the same ULID time (`ulid(t, zeros)` and `ulid(t, sevens)`). Their derived
`session.json` files therefore have the same `startedAt`, and the test expects `[high, low]`.

- Without the tie-break, it fails: `expected [ '01K6FKDT800000000000000000', … ] to deeply equal [ '01K6FKDT807777777777777777', … ]`.
- With it, the test passes.

The change is test-only and 11 lines long. The controller can drop it.

### Concern 1 (Important by the event log's own invariant; rare in practice): a locked index now blocks appends after a restart

`event-log.ts` states: "The JSONL file is the record; a failed index write only marks the index
for a rebuild." Part 1 tests this with "keeps appending while the index is locked". That test only
covers a **cached** session.

The brief puts `INSERT OR IGNORE INTO sessions` in `#stateOf`, outside `#updateIndex`. When another
connection holds a write lock on `index.sqlite` for more than 2 s (`BUSY_TIMEOUT_MS`), every
session that is not cached fails as follows:

- at startup, recovery fails (`could not recover session …`);
- any append to that session throws `database is locked`;
- the event is not written.

At startup every existing session is uncached, and so is a session after a stray write. When the
lock is released, everything recovers on the next touch. Nothing is corrupted, but appends fail
while the lock is held.

**Repro.** A scratch script, not committed. It creates a session, appends once and closes. Then
it takes `BEGIN IMMEDIATE` on the index from a second connection, opens a new `EventLog` and
appends:

```
== HEAD (f2cf20e) event-log
index update for session 01M3W812DZYFMNDE7X464KS9EX failed, will rebuild: Error: database is locked
index update for session 01M3W812DZYFMNDE7X464KS9EX failed, will rebuild: Error: database is locked
append while locked: ok
events in the JSONL: 2
== 6b event-log (as committed)
could not recover session 01M3W816RQN99D07X4HHYFE37J: Error: database is locked
append while locked: threw Error: database is locked
events in the JSONL: 1
```

**Proposed fix (verified, NOT applied).** Do the session-row insert inside `#rebuildIndex`'s
transaction instead:

```diff
@@ #stateOf
     const file = this.#existingFileOf(sessionId);
-    const meta = readMeta(join(this.#root, sessionId), sessionId);
-    this.#db
-      .prepare("INSERT OR IGNORE INTO sessions (id, title, started_at) VALUES (?, ?, ?)")
-      .run(meta.id, meta.title, meta.startedAt);
     const { events, validBytes } = readValid(file);
@@ #rebuildIndex
   #rebuildIndex(sessionId: string, events: LocalDotEvent[]): void {
+    const meta = readMeta(join(this.#root, sessionId), sessionId);
     this.#db.exec("BEGIN IMMEDIATE");
     try {
+      this.#db
+        .prepare("INSERT OR IGNORE INTO sessions (id, title, started_at) VALUES (?, ?, ?)")
+        .run(meta.id, meta.title, meta.startedAt);
       this.#deleteEvents.run(sessionId);
```

`#stateOf` already runs `#rebuildIndex` under `#updateIndex`. `append`'s stale-repair path runs it
too. So a locked index only marks the session stale, and the session row comes back with the next
successful rebuild. A failure while deriving `session.json` (for example `EACCES`) is caught the
same way.

I applied it to the working tree to check it:

- event-log, event-stream and app: 3 files, 58 tests passed;
- the repro: `append while locked: ok`, `events in the JSONL: 2`, the same as HEAD.

Then I restored the committed file (`git diff --exit-code HEAD` clean).

There is one trade-off. If a session's `events.jsonl` is unreadable **and** the index was deleted,
the fix gives that session no row, so it isn't listed. With the brief's placement, the row goes in
before `readValid` throws. If accepted, the fix also wants one test: it locks the index, reopens,
appends to an existing session and expects success. That costs about 4 s of busy-wait, inside a
`timeout: 10_000` like the existing locked-index test.

### Concern 2 (Minor): `readMeta` does not check `title`

`readMeta` checks only `id` and `startedAt`. Take a hand-edited `session.json` with a valid `id`
and `startedAt` but no `title`. It passes the check, and the insert then throws `Provided value
cannot be bound to SQLite parameter 2.` (checked on node:sqlite, Node 25.6.0). The session cannot
recover until someone fixes the file. Only a hand edit can produce such a file, since `writeMeta` is
atomic. A one-condition fix: add `&& (meta.title === null || typeof meta.title === "string")`.
Such a file is then re-derived.

### Trivia

`SessionMeta` is exported as the brief writes it, but nothing imports it. This is the same shape
as 6a's `DEFAULT_PORT` item. I kept the export.

---

# Fix rounds after the controller's rulings

Three new commits on top of `84484e7`, each with its own test run. None carries an attribution
line, and the tree is clean after each one.

| Fix | Commit | Message |
|---|---|---|
| 6b concern 1 | `9cf56e6` | `fix(daemon): re-insert the session row inside the index rebuild so a locked index never blocks appends` |
| Task 5 micro fix | `123f443` | `fix(desktopd): time out child processes and tell an unset xsetting from a failed read` |
| Task 6 review | `787802b` | `fix(daemon): never fall back to TCP for an empty Docker socket, reject 3xx and unsendable requests` |

After the third commit: `pnpm test` 19 files, **179 passed**. `pnpm format` changed nothing after
its rewrap, and `pnpm lint`, `pnpm typecheck` and `pnpm hygiene` exit 0.

## Fix 1: 6b concern 1 (ruling: accepted), `9cf56e6`

**The change.** These are the two hunks proposed above, unchanged. The `INSERT OR IGNORE` leaves
`#stateOf` and runs inside `#rebuildIndex`'s `BEGIN IMMEDIATE` transaction, with `readMeta` just
before it. A locked index now only marks the session stale, and the session row comes back with the
next successful rebuild.

**The test (the scratch repro, made permanent).** It is called "keeps appending to a session
recovered while the index is locked, and restores its row". It creates a session, appends and
closes. A second connection then deletes the session's row (as a deleted index would) and holds
`BEGIN IMMEDIATE`. A new `EventLog` recovers under that lock and appends; then the lock is released
and it appends again. The test expects:
- the locked append succeeds (seq 1);
- exactly 2 logged index failures;
- seqs 0, 1, 2;
- the index rows match the file;
- `listSessions()` gives `[{ id, title: "locked", events: 3 }]`.

It has a `timeout: 10_000`, like Part 1's locked-index test, and runs in about 4.2 s.

- **RED on `84484e7`:** `Error: database is locked`, thrown by the append at line 241 after
  4234 ms.
- **GREEN after:** event-log 21/21, including the kept `s.id DESC` tie-break test. `pnpm test` is
  171/171.
- **It pins the placement, not only "doesn't throw".** As a mutation I left the insert in `#stateOf`
  but wrapped it in `try {} catch {}`, and removed it from `#rebuildIndex`. That variant no longer
  throws, but the test fails with `expected [] to deeply equal [ ObjectContaining{…} ]`: the row is
  never restored. So the test requires the rebuild path to put the row back.

Concern 2 (`readMeta` does not check `title`) was not part of the ruling and is still open
(Minor).

## Fix 2: Task 5 micro fix (desktopd), `123f443`

### (a) A time limit on every child process

`execFileAsync` is now `(file, args) => execFileP(file, args, { timeout: 2_000, killSignal: "SIGKILL" })`.
Every child goes through it: `xdpyinfo`, `pgrep` and `xfconf-query`.

**Verified on the real `execFile`** with a scratch script, not committed. A fake `xdpyinfo` that
runs `exec sleep 47` sits first on `PATH`:
- `readScreen() -> null after 2004 ms`;
- `hung children left: none`;
- a timed-out read rejects with `{"code":null,"killed":true,"signal":"SIGKILL","stderr":""}`. The
  unit test's fake uses this same shape.

### (b) A same-length wrong token

New test: "refuses a wrong token of the right length". It sends `Bearer ${"e".repeat(TOKEN.length)}`
(43 characters) and expects 401. It passes on the current code. **The proof:** with `auth.ts` cut
down to `return a.length === b.length;`, only this test fails (`expected 200 to be 401`), and every
pre-existing app test still passes. Before this test, nothing exercised `timingSafeEqual`. The file
was restored afterwards (`git diff` clean).

### (c) Telling an unset xsetting from a failed read

**Evidence first.** I probed `xfconf-query` in the real image: a throwaway container
`localdot-test-xfconf-probe` on `6452129c4aab`, with no network, `abc` on the shared bus and
`LANG=en_US.UTF-8`.

| Mode | exit | stdout | stderr |
|---|---|---|---|
| unset property (`-p /Nope/Missing`) | 1 | empty | `Property "/Nope/Missing" does not exist on channel "xsettings".` |
| set property | 0 | `1` | empty |
| session bus unreachable | 1 | empty | `Failed to init libxfconf: Could not connect: No such file or directory.` |
| unknown channel | 1 | empty | `Property "/x" does not exist on channel "nosuchchannel".` |
| `xfconfd` stopped (SIGSTOP) | hangs: killed by `timeout 60` (124) | empty | empty |
| **`xfconfd` killed mid-call** | **1** | empty | **`Property "/Gdk/WindowScalingFactor" does not exist on channel "xsettings".`** |
| `-l -v` normal | 0 | every property and its value | empty |
| `-l -v` unknown channel | 0 | empty | empty |
| `-l -v` with `xfconfd` killed mid-call | 0 | empty | empty |

What this shows:
- **The stderr line separates most failures from "unset".** An unreachable bus and a killed read
  (once (a) puts a time limit on it) look different from "does not exist".
- **But `-p` reports a read that `xfconfd` dropped mid-call exactly as it reports an unset
  property.** So the stderr line alone cannot meet "a failed read must never report ok at 1×".
- **A listing comes back whole or empty.** It is one D-Bus call.
- **The session's channel is never empty.** `startwm.sh` rewrites `xsettings.xml` from a template
  of 17 properties on every start, before it execs `xfce4-session`.

**The design.**
- `-p` stays the normal path. Both properties are always set in this image, so the existing call
  pattern and its test are unchanged.
- A "does not exist" answer (exit 1 and exactly that line) is confirmed with one `xfconf-query -c
  <channel> -l`. The property counts as unset (`null`) only when a non-empty listing lacks it.
- An empty listing, or a listing that names the property, throws.
- So does any other failure: no bus, a killed read, or output that is not an integer.
- `readXsettings` returns `null` (not ready) when a read throws, and `hidpiReport(…, null)` is never
  ok.

This is a small step past the ruling's wording, which assumed `xfconf-query` itself tells the cases
apart. I found no other way to meet the ruling's "never" given its behaviour. Cost if wrong:
dropping the listing is about 10 lines and one test.

**Tests** (`xsettings.test.ts`). The fake now answers as the real tool does: the exact "does not
exist" stderr, and `-l` lists the channel. An `intercept(run, args, answer)` helper injects single
failures.
- "reads an unset property as null once a listing of the channel confirms it": the old unset
  test, plus a check that the `-l` call is made.
- "reports not ready when a read fails any other way, so a failed read is never ok at 1x": no
  session bus, killed by the timeout, and not a number. Each must give `null` **and**
  `hidpiReport(1, …).ok === false`.
- "does not take a dropped read for an unset property": an empty listing, and a listing that names
  the property.

- **RED:** 3 failed, 9 passed: `expected [ …(4) ] to include 'xfconf-query -c xsettings -l'`;
  `no session bus: expected { windowScalingFactor: null, …(1) } to be null`;
  `an empty listing: expected { windowScalingFactor: null, …(1) } to be null`. On the old code,
  the no-bus case reads `{ windowScalingFactor: null, xftDpi: 96 }`, and `hidpiReport(1, …)`
  scores that as ok.
- **GREEN:** desktopd 12/12 (9 before, plus 3). `pnpm test` is 174/174.

### The image and the Docker test

I rebuilt `localdot/desktop:dev` with `cells/desktop/build.sh`, so the test runs the new bundle.
Every layer came from the cache except the two desktopd layers.

- **First attempt:** the export succeeded, but unpacking failed with a containerd error:
  `failed to prepare extraction snapshot … parent snapshot sha256:38d1e434… does not exist: not
  found`. This looks like a Docker Desktop image-store quirk after the old image's snapshot chain
  was collected; nothing in the change touches it.
- **That image still ran:** a throwaway `localdot-test-unpack-check` unpacked it on demand and
  found the new code in `/opt/localdot/desktopd.mjs`.
- **A cached retry** built cleanly (`build rc=0`, unpack done). **The image is now `5131850d32ba`**,
  replacing Task 5's `6452129c4aab`.

**End to end in a real 1× cell** (`localdot-test-desktopd-wedge`, desktopd published on 127.0.0.1):
- ready: `200 0.028s {"ok":true,"scale":1,…}`;
- `xfconf-query -c xsettings -l` prints one bare name per line (`/Gdk/WindowScalingFactor$`);
- `xfconfd` frozen with SIGSTOP: three polls, each `200` in 2.016 s, 2.027 s and 2.024 s, with
  `"ok":false,…"windowScalingFactor":null,"xftDpi":null`, and `xfconf-query processes alive now: 0`;
- after SIGCONT: `200 0.018s {"ok":true,…}`.

The container was removed. On the old code, a frozen `xfconfd` hangs `xfconf-query` for good (row 5
above): `/healthz` hangs, and each poll leaves a stuck child.

**`LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/desktop-image.docker.test.ts`**
(once, no `--`): 1 file, **19/19 in 38.17 s** on `5131850d32ba`. No `localdot-test-*` containers or
volumes are left.

## Fix 3: Task 6 review findings (Docker client), `787802b`

1. **An empty socket path never falls through to TCP.**
   - `dockerSocketPath` returns the default path when nothing follows `unix://` (and, as before,
     for a non-unix `DOCKER_HOST`).
   - `new DockerClient("")` throws `RangeError("the Docker socket path is empty")`. A short comment
     says why: Node would connect to `localhost:80`, cell tokens included.
   - RED: `expected '' to be '/var/run/docker.sock'`, and `expected [Function] to throw an error`.
2. **3xx replies.**
   - 304 resolves `undefined`, with a comment: the container was already started or stopped.
   - Any other status ≥ 300 rejects as `DockerError` with its status.
   - The test, "resolves a 304 (nothing to do) and rejects any other 3xx as DockerError", sends a
     304 to `/containers/c1/start` and a 301 to `/containers/c1/json`. RED: `expected undefined to
     be an instance of DockerError` (the 301 resolved).
3. **A request that cannot be sent rejects instead of throwing.**
   - `JSON.stringify` and `httpRequest` now run inside the executor, in a `try`. A throw there
     rejects with `DockerError(0, "request not sent: <reason>", path)`.
   - The test, "rejects, never throws, for a body it cannot serialise or a path Node refuses",
     checks that `request()` returns a promise, and that it rejects with
     `{ name: "DockerError", status: 0, path }`. The two cases are `{ Memory: 1n }` and
     `/containers/a b/start`.
   - RED: the BigInt body **threw synchronously**
     (`threw TypeError: Do not know how to serialize a BigInt`). The spaced path rejected as a bare
     `TypeError: Request path contains unescaped characters`.
   - Note: status 0 keeps `DockerError`'s wording, so the message reads
     `docker unreachable on /containers/a b/start: request not sent: …`.
4. **API versions compare as `[major, minor]` integers.** `docker.docker.test.ts` gets a small
   `compareApi`, and a guard that `compareApi("1.100", DOCKER_API) > 0` (`Number("1.100")` is
   `1.1 < 1.47`). **`LOCALDOT_DOCKER_TESTS=1 pnpm test:docker apps/daemon/src/cells/docker.docker.test.ts`:
   1/1** against Engine 29.2.0 (read-only `GET /version`).
5. **Stronger tests.**
   - The query test sends `{ filters: '{"label":["localdot.cell=a b"]}', name: "x&y=z w" }`. It
     asserts the exact URL
     `?filters=%7B%22label%22%3A%5B%22localdot.cell%3Da+b%22%5D%7D&name=x%26y%3Dz+w`, and that the
     server decodes the same values back.
   - The 404 test asserts the exact message, `docker 404 on /containers/c1/json: No such container: c1`.
   - **A finding about the fake:** its old `writeHead(status, {content-type})` + `end(body)`
     replies were *already* chunked. Node chunks after an explicit `writeHead` without a length, as
     I checked on Node 25.6.0. So the fake never sent a `Content-Length` reply, which is what Docker
     sends for small JSON. Its default replies now carry `Content-Length`.
   - New "reads a chunked reply whole": three pieces 10 ms apart, with no length.
   - New "reads a large reply whole": 20,000 containers, a body over 1 MB.

   **The mutations show these catch what the old tests let through.** Each run was checked to have
   applied, and `docker.ts` was restored byte-for-byte (`cmp`) afterwards.
   - Naive `k=v&…` query joining: only the query test fails.
   - Keeping only the first `data` chunk (`res.once`): only the chunked and large tests fail.
   - Rewording the `DockerError` message: only the exact-message 404 test fails.

GREEN: Docker client unit tests 12/12 (7 before, plus 5). `pnpm test` is 179/179.
