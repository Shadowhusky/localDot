### Task 6b: Session metadata in the session folder (A19, P2-R15)

The SQLite index can be rebuilt from the session folders only if a session's title and start time
live there too. Each session gets a `session.json` next to its `events.jsonl`; recovery at startup
re-inserts the `sessions` row from it, so deleting `index.sqlite` loses nothing.

**Files:**
- Modify: `apps/daemon/src/event-log.ts`, `packages/protocol/src/ids.ts`
- Test: `apps/daemon/src/event-log.test.ts`, `packages/protocol/src/ids.test.ts`

**Interfaces:**
- Produces: `ulidTime(id: string): number` in `@localdot/protocol` (the ULID's millisecond timestamp);
  `<home>/sessions/<id>/session.json` = `{ "id", "title": string | null, "startedAt": ISO string }`,
  mode 0600, written before the index row; `EventLog` rebuilds `sessions` from these files at
  startup and derives the file from the ULID time for a folder that lacks it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/src/ids.test.ts`:
```ts
describe("ulidTime", () => {
  it("reads the millisecond timestamp back out of a ULID", () => {
    const now = 1_759_312_800_000;
    expect(ulidTime(ulid(now))).toBe(now);
    expect(ulidTime("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(1_469_922_850_259);
  });

  it("rejects strings that are not ULIDs", () => {
    expect(() => ulidTime("nope")).toThrow(RangeError);
  });
});
```
(add `ulidTime` to the existing import from `./ids.ts`.)

Append to `apps/daemon/src/event-log.test.ts`, inside `describe("EventLog")`:
```ts
  it("stores each session's title and start time in its folder", () => {
    const dir = home();
    const log = new EventLog(dir);
    const id = log.createSession("Compare flights");
    const file = join(dir, "sessions", id, "session.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const meta = JSON.parse(readFileSync(file, "utf8")) as { id: string; title: string | null; startedAt: string };
    expect(meta.id).toBe(id);
    expect(meta.title).toBe("Compare flights");
    expect(Number.isNaN(Date.parse(meta.startedAt))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "sessions", log.createSession(), "session.json"), "utf8")).title).toBeNull();
  });

  it("rebuilds the sessions index from the session folders", () => {
    const dir = home();
    const first = new EventLog(dir);
    const a = first.createSession("A");
    const b = first.createSession("B");
    first.append(a, thinking);
    first.append(a, idle);
    first.append(b, thinking);
    const before = first.listSessions();
    first.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(join(dir, `index.sqlite${suffix}`), { force: true });
    const second = new EventLog(dir);
    // A and B usually start in the same millisecond: listSessions breaks that tie by id, so the
    // order survives a rebuild, but B need not come before A.
    expect(second.listSessions()).toEqual(before);
    expect(new Map(second.listSessions().map((s) => [s.id, [s.title, s.events]]))).toEqual(
      new Map([
        [a, ["A", 2]],
        [b, ["B", 1]],
      ]),
    );
  });

  it("derives session.json from the ULID for a folder that lacks it", () => {
    const dir = home();
    const id = ulid(1_759_312_800_000);
    mkdirSync(join(dir, "sessions", id), { recursive: true });
    writeFileSync(join(dir, "sessions", id, "events.jsonl"), "");
    const log = new EventLog(dir);
    const meta = JSON.parse(readFileSync(join(dir, "sessions", id, "session.json"), "utf8")) as { title: string | null; startedAt: string };
    expect(meta).toEqual({ id, title: null, startedAt: "2025-10-01T10:00:00.000Z" });
    expect(log.listSessions().map((s) => s.id)).toContain(id);
  });
```
(add `rmSync` to the `node:fs` import at the top of the file.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run packages/protocol/src/ids.test.ts apps/daemon/src/event-log.test.ts`
Expected: FAIL — `ulidTime` is not exported; `session.json` does not exist; the rebuilt index lists
no sessions.

- [ ] **Step 3: Implement**

Append to `packages/protocol/src/ids.ts`:
```ts
export function ulidTime(id: string): number {
  if (!ULID_PATTERN.test(id)) throw new RangeError(`not a ULID: ${id}`);
  let time = 0;
  for (const char of id.slice(0, 10)) time = time * 32 + CROCKFORD.indexOf(char);
  return time;
}
```

`apps/daemon/src/event-log.ts` — add the imports and the metadata helpers, and use them:
```ts
import { renameSync, rmSync, writeFileSync } from "node:fs";   // added to the existing node:fs import
import { randomBytes } from "node:crypto";
import { ulidTime } from "@localdot/protocol";                  // added to the existing protocol import

export interface SessionMeta {
  id: string;
  title: string | null;
  startedAt: string;
}
```
In `createSession`, write the file before the index row:
```ts
  createSession(title?: string): string {
    const id = ulid();
    const dir = join(this.#root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const meta: SessionMeta = { id, title: title ?? null, startedAt: new Date().toISOString() };
    writeMeta(dir, meta);
    this.#db
      .prepare("INSERT INTO sessions (id, title, started_at) VALUES (?, ?, ?)")
      .run(id, meta.title, meta.startedAt);
    // ... the rest unchanged
  }
```
In `#stateOf`, right after `const file = this.#existingFileOf(sessionId);`, re-insert the session row
from the folder:
```ts
    const meta = readMeta(join(this.#root, sessionId), sessionId);
    this.#db
      .prepare("INSERT OR IGNORE INTO sessions (id, title, started_at) VALUES (?, ?, ?)")
      .run(meta.id, meta.title, meta.startedAt);
```
And the two helpers at the bottom of the file:
```ts
function writeMeta(dir: string, meta: SessionMeta): void {
  const file = join(dir, "session.json");
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(meta)}\n`, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

// A folder without session.json predates this file: its ULID carries the start time.
function readMeta(dir: string, id: string): SessionMeta {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as SessionMeta;
    if (meta.id === id && typeof meta.startedAt === "string") return meta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`session ${id}: unreadable session.json, deriving it: ${String(err)}`);
    }
  }
  const meta: SessionMeta = { id, title: null, startedAt: new Date(ulidTime(id)).toISOString() };
  writeMeta(dir, meta);
  return meta;
}
```

In `listSessions`, break ties on the start time by id, so the order is the same before and after a
rebuild (two sessions can start in the same millisecond):
```ts
        GROUP BY s.id ORDER BY s.started_at DESC, s.id DESC
```

- [ ] **Step 4: Run the suites**

Run: `pnpm exec vitest run packages/protocol/src apps/daemon/src/event-log.test.ts apps/daemon/src/event-stream.test.ts apps/daemon/src/app.test.ts && pnpm --filter @localdot/protocol schema && git diff --exit-code packages/protocol/schema`
Expected: all pass; the exported JSON schema is unchanged (ids are not part of it).

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add packages/protocol/src apps/daemon/src/event-log.ts apps/daemon/src/event-log.test.ts
git commit -m "feat(daemon): keep session metadata in the session folder and rebuild the index from it"
```

---
