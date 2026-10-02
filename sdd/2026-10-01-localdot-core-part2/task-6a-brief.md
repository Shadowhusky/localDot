### Task 6a: Daemon lock residuals (Ruling 36, P2-R11)

Part 1's final re-review left four items on the single-writer lock: publish the lock with the pid
already inside (a temp file linked into place, never an empty lock), treat the daemon's own pid as a
stale holder (a lock left by a previous incarnation whose pid was recycled), handle `SIGHUP`, and
give a one-line message for a lock that cannot be read. This task closes them before any new daemon
code lands, along with the same re-review's two trivia: the ")" that SUMMARY D18's quote drops, and
the `export` on `DEFAULT_PORT`, which nothing imports.

**Files:**
- Modify: `apps/daemon/src/lock.ts`, `apps/daemon/src/main.ts`, `apps/daemon/src/port.ts`,
  `docs/spikes/SUMMARY.md`
- Test: `apps/daemon/src/lock.test.ts`

**Interfaces:**
- Produces: `acquireDaemonLock(file): () => void` (unchanged signature), `DaemonLockedError { pid }`,
  new `DaemonLockError` (unreadable lock or a directory at the path; message says what to do).
  `main.ts` exits on `SIGINT`, `SIGTERM` and `SIGHUP`, and its `lockHome` prints either error's
  message without a stack trace. `port.ts` keeps `DEFAULT_PORT` to itself (`parsePort` is unchanged).

- [ ] **Step 1: Rewrite the lock tests**

`apps/daemon/src/lock.test.ts` (replace the whole file):
```ts
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireDaemonLock, DaemonLockError, DaemonLockedError } from "./lock.ts";

// Above any pid macOS (99999) or Linux (2^22) hands out, so no process can hold it.
const DEAD_PID = 2 ** 31 - 1;

const tempHome = () => mkdtempSync(join(tmpdir(), "local dot's lock-"));

// A live process that is not this one, for the "someone else holds it" case.
const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
afterAll(() => sleeper.kill());

describe("acquireDaemonLock", () => {
  it("creates the home and a 0600 lock that holds this process's pid the instant it returns", () => {
    const home = join(tempHome(), "home");
    const file = join(home, "daemon.lock");
    acquireDaemonLock(file);
    expect(readFileSync(file, "utf8")).toBe(`${process.pid}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readdirSync(home)).toEqual(["daemon.lock"]);
  });

  it("refuses to start while another live process holds the lock", () => {
    const file = join(tempHome(), "daemon.lock");
    writeFileSync(file, `${sleeper.pid}\n`);
    expect(() => acquireDaemonLock(file)).toThrow(DaemonLockedError);
    expect(() => acquireDaemonLock(file)).toThrow(`another localdot daemon is running (pid ${sleeper.pid})`);
    expect(readFileSync(file, "utf8")).toBe(`${sleeper.pid}\n`);
  });

  it.each([
    ["a pid no process holds", `${DEAD_PID}\n`],
    ["no pid at all", ""],
    ["a pid that is not a number", "not-a-pid\n"],
    ["this process's own pid", `${process.pid}\n`],
  ])("replaces a stale lock holding %s and leaves no temp file", (_label, content) => {
    const home = tempHome();
    const file = join(home, "daemon.lock");
    writeFileSync(file, content);
    acquireDaemonLock(file);
    expect(readFileSync(file, "utf8")).toBe(`${process.pid}\n`);
    expect(readdirSync(home)).toEqual(["daemon.lock"]);
  });

  it("releases by removing the lock, and a second release is harmless", () => {
    const file = join(tempHome(), "daemon.lock");
    const release = acquireDaemonLock(file);
    release();
    expect(existsSync(file)).toBe(false);
    release();
    acquireDaemonLock(file);
    expect(readFileSync(file, "utf8")).toBe(`${process.pid}\n`);
  });

  it("never removes a lock that another daemon has taken since", () => {
    const file = join(tempHome(), "daemon.lock");
    const release = acquireDaemonLock(file);
    writeFileSync(file, `${DEAD_PID}\n`);
    release();
    expect(readFileSync(file, "utf8")).toBe(`${DEAD_PID}\n`);
  });

  it("explains a directory at the lock path in one line", () => {
    const file = join(tempHome(), "daemon.lock");
    mkdirSync(file);
    expect(() => acquireDaemonLock(file)).toThrow(DaemonLockError);
    expect(() => acquireDaemonLock(file)).toThrow(`${file} is a directory; remove it or point LOCALDOT_HOME elsewhere`);
  });

  it.skipIf(process.getuid?.() === 0)("explains an unreadable lock in one line", () => {
    const file = join(tempHome(), "daemon.lock");
    writeFileSync(file, `${DEAD_PID}\n`);
    chmodSync(file, 0o000);
    expect(() => acquireDaemonLock(file)).toThrow(DaemonLockError);
    expect(() => acquireDaemonLock(file)).toThrow(`cannot read ${file} (EACCES); fix its permissions or remove it`);
    chmodSync(file, 0o600);
  });
});
```

- [ ] **Step 2: Run them to see the new cases fail**

Run: `pnpm exec vitest run apps/daemon/src/lock.test.ts`
Expected: FAIL — `DaemonLockError` is not exported; "this process's own pid" expects a replacement
but gets `DaemonLockedError`.

- [ ] **Step 3: Rewrite the lock and the signal list**

`apps/daemon/src/lock.ts` (replace the whole file):
```ts
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class DaemonLockedError extends Error {
  constructor(readonly pid: number) {
    super(`another localdot daemon is running (pid ${pid})`);
    this.name = "DaemonLockedError";
  }
}

export class DaemonLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonLockError";
  }
}

// One daemon per home. The pid is written to a private temp file that is linked into place, so no
// reader ever sees an empty lock. A holder that is dead, or this very process (a lock left by a
// previous incarnation whose pid was recycled), is stale and gets replaced.
export function acquireDaemonLock(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const content = `${process.pid}\n`;
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try {
    if (!linkIfAbsent(temp, file)) {
      const holder = readHolder(file);
      if (holder !== undefined && holder !== process.pid && isAlive(holder)) {
        throw new DaemonLockedError(holder);
      }
      renameSync(temp, file);
    }
  } finally {
    rmSync(temp, { force: true });
  }
  return () => {
    if (readPid(file) === process.pid) rmSync(file, { force: true });
  };
}

function linkIfAbsent(temp: string, file: string): boolean {
  try {
    linkSync(temp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

// A directory or an unreadable file at the lock path is a setup problem, reported in one line.
function readHolder(file: string): number | undefined {
  let text: string;
  try {
    if (statSync(file).isDirectory()) {
      throw new DaemonLockError(`${file} is a directory; remove it or point LOCALDOT_HOME elsewhere`);
    }
    text = readFileSync(file, "utf8").trim();
  } catch (err) {
    if (err instanceof DaemonLockError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new DaemonLockError(`cannot read ${file} (${code ?? String(err)}); fix its permissions or remove it`);
  }
  return /^[1-9]\d*$/.test(text) ? Number(text) : undefined;
}

function readPid(file: string): number | undefined {
  try {
    const text = readFileSync(file, "utf8").trim();
    return /^[1-9]\d*$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

// Signal 0 only probes: EPERM means the process exists under another user.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
```

`apps/daemon/src/main.ts` — change the two places (the rest of the file is unchanged):
```ts
import { acquireDaemonLock, DaemonLockError, DaemonLockedError } from "./lock.ts";
// ...
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => process.exit(128 + constants.signals[signal]));
}
// ...
function lockHome(file: string): () => void {
  try {
    return acquireDaemonLock(file);
  } catch (err) {
    if (err instanceof DaemonLockedError) {
      return fail(`${err.message}; remove ${file} if that process is not localdot`);
    }
    if (err instanceof DaemonLockError) return fail(err.message);
    throw err;
  }
}
```

The two trivia. In `docs/spikes/SUMMARY.md`, D18's ledger quote ends `README.md 'Decision': C: Theatre"`,
but the ledger reads `README.md 'Decision'): C: Theatre`: restore the ")". In
`apps/daemon/src/port.ts`, `export const DEFAULT_PORT = 4750;` becomes `const DEFAULT_PORT = 4750;`
(`git grep -n DEFAULT_PORT` lists only `port.ts`).

- [ ] **Step 4: Run the lock tests and the daemon suites**

Run: `pnpm exec vitest run apps/daemon/src/lock.test.ts apps/daemon/src/app.test.ts apps/daemon/src/port.test.ts`
Expected: 10 lock tests pass (9 if running as root skips the unreadable case); the app and port tests
still pass.
Then start the daemon directly with node, which is how every harness and process manager must start
it (`pnpm … start` does not forward `SIGTERM` to the daemon). The subshell `exec`s node, so `$!` is
the daemon itself; port 4795 keeps it clear of a daemon already on 4750:
```bash
h="$(mktemp -d)/h"
(cd "/Volumes/Husky's SSD 4T/Projects/localdot/apps/daemon" && exec env LOCALDOT_PORT=4795 LOCALDOT_HOME="$h" node --import tsx src/main.ts) &
sleep 2; kill -HUP $!; wait $!; echo "exit $?"; ls -A "$h"
```
Expected: `exit 129` (128 + SIGHUP); `ls` shows the token and the event log, and no `daemon.lock`.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/daemon/src/lock.ts apps/daemon/src/lock.test.ts apps/daemon/src/main.ts apps/daemon/src/port.ts docs/spikes/SUMMARY.md
git commit -m "fix(daemon): publish the lock with its pid, treat own pid as stale, handle SIGHUP"
```

---
