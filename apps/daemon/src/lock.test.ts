import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireDaemonLock, DaemonLockedError } from "./lock.ts";

// Above any pid macOS (99999) or Linux (2^22) hands out, so no process can hold it.
const DEAD_PID = 2 ** 31 - 1;

const tempHome = () => mkdtempSync(join(tmpdir(), "local dot's lock-"));

describe("acquireDaemonLock", () => {
  it("creates the home and a 0600 lock holding this process's pid", () => {
    const home = join(tempHome(), "home");
    const file = join(home, "daemon.lock");
    acquireDaemonLock(file);
    expect(readFileSync(file, "utf8")).toBe(`${process.pid}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("refuses a second daemon while the lock's pid is alive", () => {
    const file = join(tempHome(), "daemon.lock");
    acquireDaemonLock(file);
    expect(() => acquireDaemonLock(file)).toThrow(DaemonLockedError);
    expect(() => acquireDaemonLock(file)).toThrow(
      `another localdot daemon is running (pid ${process.pid})`,
    );
    expect(readFileSync(file, "utf8")).toBe(`${process.pid}\n`);
  });

  it.each([
    ["a pid no process holds", `${DEAD_PID}\n`],
    ["no pid at all", ""],
    ["a pid that is not a number", "not-a-pid\n"],
  ])("replaces a stale lock holding %s", (_label, content) => {
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
});
