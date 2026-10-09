import { randomBytes } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

// The live process holding the lock, if any.
export function lockHolder(file: string): number | undefined {
  const pid = readPid(file);
  return pid !== undefined && isAlive(pid) ? pid : undefined;
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
      throw new DaemonLockError(
        `${file} is a directory; remove it or point LOCALDOT_HOME elsewhere`,
      );
    }
    text = readFileSync(file, "utf8").trim();
  } catch (err) {
    if (err instanceof DaemonLockError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new DaemonLockError(
      `cannot read ${file} (${code ?? String(err)}); fix its permissions or remove it`,
    );
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
