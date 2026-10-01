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
    expect(() => acquireDaemonLock(file)).toThrow(
      `another localdot daemon is running (pid ${sleeper.pid})`,
    );
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
    expect(() => acquireDaemonLock(file)).toThrow(
      `${file} is a directory; remove it or point LOCALDOT_HOME elsewhere`,
    );
  });

  it.skipIf(process.getuid?.() === 0)("explains an unreadable lock in one line", () => {
    const file = join(tempHome(), "daemon.lock");
    writeFileSync(file, `${DEAD_PID}\n`);
    chmodSync(file, 0o000);
    expect(() => acquireDaemonLock(file)).toThrow(DaemonLockError);
    expect(() => acquireDaemonLock(file)).toThrow(
      `cannot read ${file} (EACCES); fix its permissions or remove it`,
    );
    chmodSync(file, 0o600);
  });
});
