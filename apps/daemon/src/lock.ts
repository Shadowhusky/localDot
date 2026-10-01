import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class DaemonLockedError extends Error {
  constructor(readonly pid: number) {
    super(`another localdot daemon is running (pid ${pid})`);
    this.name = "DaemonLockedError";
  }
}

// One daemon per home: a second one would run the event log's recovery against a live writer.
export function acquireDaemonLock(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const content = `${process.pid}\n`;
  try {
    writeFileSync(file, content, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const holder = readPid(file);
    if (holder !== undefined && isAlive(holder)) throw new DaemonLockedError(holder);
    replaceStale(file, content);
  }
  return () => {
    if (readPid(file) === process.pid) rmSync(file, { force: true });
  };
}

function replaceStale(file: string, content: string): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function readPid(file: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return /^[1-9]\d*$/.test(text) ? Number(text) : undefined;
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
