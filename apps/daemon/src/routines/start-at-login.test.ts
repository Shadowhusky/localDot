import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartAtLoginError, shellStartAtLoginPort, startAtLoginPort } from "./start-at-login.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const identity = {
  ownerId: "a".repeat(32),
  release: { version: "0.4.0", packageSha256: "b".repeat(64), manifestSha256: "c".repeat(64) },
};
function fixture(code: number | null) {
  const home = mkdtempSync(join(tmpdir(), "ld-login-port-"));
  roots.push(home);
  mkdirSync(join(home, "install"), { mode: 0o700 });
  const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("close", null));
        return true;
      }),
    });
    if (code !== null)
      queueMicrotask(() => {
        if (code === 0)
          writeFileSync(
            join(home, "install", "start-at-login.json"),
            JSON.stringify({
              v: 1,
              enabled: args[2] === "on",
              changedAt: "2026-10-12T07:30:00.000Z",
            }),
            { mode: 0o600 },
          );
        child.emit("close", code);
      });
    return child;
  }) as never;
  const port = startAtLoginPort({
    home,
    identity,
    node: "/runtime/node",
    env: { HOME: "/Users/sam", PATH: "/runtime:/usr/bin", LOCALDOT_TOKEN: "never" },
    platform: "darwin",
    spawn,
    timeoutMs: 50,
  });
  return { home, calls, port };
}

describe("start at login from the daemon", () => {
  it("is unavailable outside the installed app or off macOS and Linux", async () => {
    const port = startAtLoginPort({ home: "/tmp/x", identity: null, node: "/n", env: {} });
    expect(await port.status()).toBe("unavailable");
    expect(await port.set(true)).toBe("unavailable");
    const windows = startAtLoginPort({
      home: "/tmp/x",
      identity,
      node: "/n",
      env: {},
      platform: "win32",
    });
    expect(await windows.status()).toBe("unavailable");
  });
  it("is available on Linux, where the CLI manages a systemd user unit", async () => {
    const linux = startAtLoginPort({
      home: "/tmp/ld-no-such-home",
      identity,
      node: "/n",
      env: {},
      platform: "linux",
    });
    expect(await linux.status()).toBe("off");
  });
  it("reads off when nothing was recorded", async () => {
    expect(await fixture(0).port.status()).toBe("off");
  });
  it("runs the installed CLI with a fixed command and a minimal environment", async () => {
    const f = fixture(0);
    expect(await f.port.set(true)).toBe("on");
    expect(f.calls).toEqual([
      {
        command: "/runtime/node",
        args: [
          join(
            f.home,
            "install",
            "releases",
            `${"b".repeat(64)}-${"c".repeat(64)}`,
            "app",
            "bin",
            "localdot.mjs",
          ),
          "start-at-login",
          "on",
        ],
        options: {
          cwd: "/",
          env: {
            HOME: "/Users/sam",
            PATH: "/runtime:/usr/bin",
            LANG: "en_US.UTF-8",
            LOCALDOT_HOME: f.home,
          },
          stdio: "ignore",
        },
      },
    ]);
    expect(await f.port.set(false)).toBe("off");
  });
  it("fails when the CLI fails or hangs", async () => {
    await expect(fixture(1).port.set(true)).rejects.toThrow(StartAtLoginError);
    await expect(fixture(null).port.set(true)).rejects.toThrow(StartAtLoginError);
  });
  it("refuses a symlinked record", async () => {
    const f = fixture(0);
    writeFileSync(
      join(f.home, "elsewhere.json"),
      JSON.stringify({ v: 1, enabled: true, changedAt: "2026-10-12T07:30:00.000Z" }),
    );
    symlinkSync(join(f.home, "elsewhere.json"), join(f.home, "install", "start-at-login.json"));
    await expect(f.port.status()).rejects.toThrow(StartAtLoginError);
  });
});

it("supports public packages and invokes only their installed startup command", async () => {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), "ld-shell-login-")));
  roots.push(prefix);
  const home = join(prefix, "state");
  mkdirSync(join(prefix, "bin"));
  writeFileSync(
    join(prefix, "install.env"),
    `# Managed by localDot's install.sh\nLOCALDOT_HOME="${home}"\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(prefix, "bin/localdot"), "#!/bin/sh\n", { mode: 0o700 });
  const execute = vi.fn(async (_command, args) => ({
    stdout: args[1] === "off" ? "off\n" : "on\n",
  }));
  const port = await shellStartAtLoginPort(
    home,
    prefix,
    { HOME: prefix, SECRET: "not-forwarded" },
    execute as never,
  );
  expect(await port.status()).toBe("on");
  expect(await port.set(false)).toBe("off");
  expect(execute.mock.calls[1]?.slice(0, 2)).toEqual([
    join(prefix, "bin/localdot"),
    ["start-at-login", "off"],
  ]);
  expect(JSON.stringify(execute.mock.calls)).not.toContain("not-forwarded");
  const wrong = await shellStartAtLoginPort("/other-home", prefix, {}, execute as never);
  expect(await wrong.status()).toBe("unavailable");
});
