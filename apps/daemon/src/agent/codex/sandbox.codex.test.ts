import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareCodexHome } from "../../../../../harness/codex/src/home.ts";
import { CODEX_HOME_DENY_WRITE } from "../../../../../harness/codex/src/profile.ts";
import {
  type NativeFixture,
  prepareNativeFixture,
} from "../../../../../harness/codex/src/testing/native-fixture.ts";

if (process.env.LOCALDOT_CODEX_TESTS !== "1")
  throw new Error("Native acceptance requires explicit offline opt-in.");
const archive = process.env.LOCALDOT_CODEX_ARCHIVE;
assert.ok(archive);
let f: NativeFixture | undefined;
const servers: Server[] = [],
  sockets = new Set<Socket>();
const secretNames = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "LOCALDOT_INSTALL_TOKEN",
  "HTTP_PROXY_AUTH",
  "GITHUB_TOKEN",
];
type OwnedCanary = { directory: string; identity: { dev: number; ino: number } };
let homeCanary: OwnedCanary | undefined;
let shared:
  | { parent: string; parentIdentity: { dev: number; ino: number }; canary?: OwnedCanary }
  | undefined;
function removeCanary(owned: OwnedCanary) {
  const info = lstatSync(owned.directory);
  expect([info.dev, info.ino, info.uid, info.mode & 0o777]).toEqual([
    owned.identity.dev,
    owned.identity.ino,
    process.getuid?.(),
    0o700,
  ]);
  expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
  expect(realpathSync(owned.directory)).toBe(owned.directory);
  expect(readdirSync(owned.directory)).toEqual(["canary"]);
  const file = lstatSync(join(owned.directory, "canary"));
  expect(file.isFile() && !file.isSymbolicLink() && file.nlink === 1).toBe(true);
  expect([file.uid, file.mode & 0o777]).toEqual([process.getuid?.(), 0o600]);
  rmSync(owned.directory, { recursive: true });
}
const fixture = () => {
  assert.ok(f);
  return f;
};
async function listener(address: string | number) {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.end();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (typeof address === "number") server.listen(address, "127.0.0.1", resolve);
    else server.listen(address, resolve);
  });
  return server;
}
beforeAll(async () => {
  for (const name of secretNames) vi.stubEnv(name, "offline-native-inert");
  f = await prepareNativeFixture(archive);
}, 65_000);
afterAll(async () => {
  const errors: unknown[] = [];
  let childrenRetired = f === undefined;
  for (const socket of sockets) socket.destroy();
  for (const server of servers) {
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (f) {
    try {
      const retain = errors.length > 0;
      await f.close({ retain });
      expect(existsSync(f.root)).toBe(retain);
      childrenRetired = !retain;
    } catch (error) {
      errors.push(error);
    }
  }
  if (homeCanary && childrenRetired) {
    try {
      removeCanary(homeCanary);
    } catch (error) {
      errors.push(error);
    }
  }
  if (shared && childrenRetired) {
    try {
      const parent = lstatSync(shared.parent);
      expect([parent.dev, parent.ino, parent.uid, parent.mode & 0o777]).toEqual([
        shared.parentIdentity.dev,
        shared.parentIdentity.ino,
        process.getuid?.(),
        0o700,
      ]);
      if (shared.canary) removeCanary(shared.canary);
      // The exclusively created parent is removed only when empty.
      rmdirSync(shared.parent);
    } catch (error) {
      errors.push(error);
    }
  }
  vi.unstubAllEnvs();
  if (errors.length) throw new AggregateError(errors, "Owned native acceptance cleanup failed.");
});
describe("native macOS Codex confinement", () => {
  it("allows owned home/work while denying protected config writes and user/data reads", async () => {
    const f = fixture();
    const config = readFileSync(join(f.roots.home, "config.toml"));
    const cases: [string[], boolean][] = [
      [["read", join(f.roots.home, "config.toml")], true],
      [["write", join(f.roots.home, "config.toml")], false],
      [["write", join(f.roots.home, "auth.json")], true],
      [["write", join(f.work.path, "tmp/positive")], true],
      [["directory", homedir()], false],
      [["directory", join(homedir(), ".codex")], false],
      [["directory", `/System/Volumes/Data${homedir()}`], false],
      [["directory", "/Volumes"], false],
    ];
    try {
      for (const [args, allowed] of cases) {
        expect((await f.probe("task", args, false)).ok).toBe(true);
        const result = await f.probe("task", args);
        expect(result.ok, args.join(" ")).toBe(allowed);
        if (!allowed) expect([1, 13]).toContain(result.errno);
      }
    } finally {
      writeFileSync(join(f.roots.home, "config.toml"), config);
    }
  }, 40_000);
  it("denies all protected home writes with writable owned positive controls", async () => {
    const f = fixture();
    try {
      for (const name of CODEX_HOME_DENY_WRITE) {
        const args = ["write", join(f.roots.home, name)];
        expect((await f.probe("account", args, false)).ok).toBe(true);
        const result = await f.probe("account", args);
        expect(result.ok, name).toBe(false);
        expect([1, 13]).toContain(result.errno);
      }
    } finally {
      prepareCodexHome(f.roots);
    }
  }, 40_000);
  it("denies parent canaries and both shared-temp spellings while private temp stays writable", async () => {
    const f = fixture(),
      parentCanary = join(dirname(f.roots.root), "owned-parent-canary");
    writeFileSync(parentCanary, "offline-native-inert", { mode: 0o600 });
    const parent = "/private/tmp/claude";
    // An existing directory is never acquired or overwritten by this fixture.
    mkdirSync(parent, { mode: 0o700 });
    shared = { parent, parentIdentity: lstatSync(parent) };
    const directory = realpathSync(mkdtempSync(join(parent, "ld14-")));
    shared.canary = { directory, identity: lstatSync(directory) };
    const canary = join(directory, "canary");
    writeFileSync(canary, "offline-native-inert", { mode: 0o600 });
    for (const path of [parentCanary, canary, canary.replace("/private/tmp/", "/tmp/")]) {
      for (const operation of ["read", "write"]) {
        const args = [operation, path];
        expect((await f.probe("task", args, false)).ok).toBe(true);
        const result = await f.probe("task", args);
        expect(result.ok, `${operation} ${path}`).toBe(false);
        expect([1, 13]).toContain(result.errno);
      }
    }
    expect((await f.probe("task", ["write", join(f.work.path, "tmp/owned-positive")])).ok).toBe(
      true,
    );
  }, 40_000);
  it("denies the owned real-home canary through natural and Data-volume spellings", async () => {
    const f = fixture();
    const directory = realpathSync(
      mkdtempSync(join(realpathSync(homedir()), ".localdot-native-canary-")),
    );
    homeCanary = { directory, identity: lstatSync(directory) };
    const canary = join(directory, "canary");
    writeFileSync(canary, "offline-native-inert", { flag: "wx", mode: 0o600 });
    const alias = `/System/Volumes/Data${canary}`;
    expect([lstatSync(alias).dev, lstatSync(alias).ino]).toEqual([
      lstatSync(canary).dev,
      lstatSync(canary).ino,
    ]);
    for (const path of [canary, alias]) {
      for (const operation of ["read", "write"]) {
        const args = [operation, path];
        expect((await f.probe("account", args, false)).ok).toBe(true);
        const result = await f.probe("account", args);
        expect(result.ok, `${operation} ${path}`).toBe(false);
        expect([1, 13]).toContain(result.errno);
      }
    }
  }, 40_000);
  it("grants only the owned UDS and exact proxy ports", async () => {
    const f = fixture();
    const own = join(f.mcp.path, "m.sock"),
      foreign = join(f.root, "other.sock");
    await listener(own);
    await listener(foreign);
    const tcp = await listener(0),
      address = tcp.address();
    assert.ok(address && typeof address !== "string");
    const cases: [string[], boolean][] = [
      [["unix", own], true],
      [["unix", foreign], false],
      [["connect", "127.0.0.1", String(address.port)], false],
      ...f.proxyPorts.map(
        (port) => [["connect", "127.0.0.1", String(port)], true] as [string[], boolean],
      ),
    ];
    for (const [args, allowed] of cases) {
      expect((await f.probe("task", args, false)).ok).toBe(true);
      const result = await f.probe("task", args);
      expect(result.ok, args.join(" ")).toBe(allowed);
      if (!allowed) expect([1, 13]).toContain(result.errno);
    }
  }, 40_000);
  it("denies every task/account listener and refuses the unavailable browser profile", async () => {
    const f = fixture();
    for (const purpose of ["task", "account"] as const) {
      for (const ip of ["127.0.0.1", "::1", "0.0.0.0", "::"]) {
        for (const port of ["1455", "1456", "0"]) {
          const args = ["bind", ip, port];
          expect((await f.probe(purpose, args, false)).ok).toBe(true);
          const result = await f.probe(purpose, args);
          expect(result.ok, `${purpose} ${ip}:${port}`).toBe(false);
          expect([1, 13]).toContain(result.errno);
        }
      }
    }
    const allocated = f.processes.length;
    await expect(f.probe("login-browser", ["bind", "127.0.0.1", "1455"])).rejects.toThrow();
    expect(f.processes.length).toBe(allocated);
  }, 40_000);
  it("receives the scrubbed production environment", async () => {
    const f = fixture();
    for (const name of secretNames) expect(process.env[name]).toBe("offline-native-inert");
    expect(await f.probe("task", ["environment", f.roots.home])).toEqual({ ok: true, errno: 0 });
  });
  it("authenticates to the owned default proxy and rejects a foreign CONNECT host", async () => {
    expect(await fixture().proxyRefusal()).toEqual({ unauthenticated: 407, forbiddenHost: 403 });
  });
  it("denies native sandbox reinitialization with an unsandboxed positive control", async () => {
    const f = fixture(),
      args = ["nested", "inert"];
    expect((await f.probe("task", args, false)).ok).toBe(true);
    const result = await f.probe("task", args);
    expect(result.ok).toBe(false);
    expect([1, 13]).toContain(result.errno);
  });
});
