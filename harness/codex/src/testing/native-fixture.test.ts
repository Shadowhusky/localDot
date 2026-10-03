import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InstalledCodex } from "../install.ts";
import type { CodexProcess, SpawnCodexInput } from "../process.ts";
import type { OwnedCodexRoots } from "../roots.ts";
import { codexRelease, releaseInstallKey } from "../version.ts";

// Inert registered process handles and real owned loopback listeners prove retirement error
// paths without executing cc, openssl, Codex, a sandbox or an account operation.
const state = vi.hoisted(() => ({
  top: "",
  ports: [] as number[],
  processes: [] as CodexProcess[],
  initialize: vi.fn<() => Promise<void>>(),
  reset: vi.fn<() => Promise<void>>(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: state.initialize,
    reset: state.reset,
    getProxyPort: () => state.ports[0],
    getSocksProxyPort: () => state.ports[1],
  },
}));
vi.mock("../install.ts", async (original) => {
  const actual = await original<typeof import("../install.ts")>();
  return {
    ...actual,
    VerifiedCodexInstaller: class {
      readonly installed: InstalledCodex;
      constructor(roots: OwnedCodexRoots) {
        const release = codexRelease("darwin", "arm64");
        if (!release) throw new Error("missing inert unit manifest");
        state.top = dirname(dirname(roots.root));
        const binDir = join(roots.binRoot, releaseInstallKey(release));
        mkdirSync(binDir, { mode: 0o700 });
        for (const name of ["codex", "codex-code-mode-host"])
          writeFileSync(join(binDir, name), "inert unit executable", { mode: 0o555 });
        this.installed = {
          version: "0.154.0",
          platform: "darwin-arm64",
          binDir,
          codexBin: join(binDir, "codex"),
          codeModeHostBin: join(binDir, "codex-code-mode-host"),
        };
      }
      async ensureInstalled() {
        return this.installed;
      }
      async verifiedInstallation() {
        return this.installed;
      }
    },
  };
});
vi.mock("../process.ts", async (original) => {
  const actual = await original<typeof import("../process.ts")>();
  return {
    ...actual,
    spawnCodex: (input: SpawnCodexInput) => {
      const owner: CodexProcess = {
        pid: undefined,
        stdin: new PassThrough(),
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        started: Promise.resolve(),
        exited: Promise.resolve({ code: 0, signal: null }),
        closed: Promise.resolve(),
        failure: new Promise(() => {}),
        stop: vi.fn(async () => {}),
      };
      state.processes.push(owner);
      input.register(owner);
      return owner;
    },
  };
});
const servers: Server[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const arch = Object.getOwnPropertyDescriptor(process, "arch");
async function closeServers() {
  for (const server of servers)
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
}
beforeEach(async () => {
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
  state.top = "";
  state.ports.length = 0;
  state.processes.length = 0;
  state.initialize.mockReset();
  state.reset.mockReset();
  for (let i = 0; i < 2; i++) {
    const server = createServer((socket) => socket.end());
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing owned unit listener");
    state.ports.push(address.port);
  }
  state.initialize.mockResolvedValue(undefined);
  state.reset.mockImplementation(closeServers);
});
afterEach(async () => {
  await closeServers();
  servers.length = 0;
  for (const owner of state.processes) {
    owner.stdin?.destroy();
    owner.stdout?.destroy();
    owner.stderr?.destroy();
  }
  if (state.top && existsSync(state.top)) {
    // Every injected process is inert; independently drain our actual listeners, then remove
    // the exact owned unit root that the production fixture correctly retained on failure.
    const info = lstatSync(state.top);
    expect([info.uid, info.mode & 0o777]).toEqual([process.getuid?.(), 0o700]);
    rmSync(state.top, { recursive: true });
  }
  if (platform) Object.defineProperty(process, "platform", platform);
  if (arch) Object.defineProperty(process, "arch", arch);
});
async function prepare() {
  const { prepareNativeFixture } = await import("./native-fixture.ts");
  return prepareNativeFixture("/tmp/inert-never-read-native-archive.tgz");
}
it("confirms registered process and real proxy retirement before deleting native fixture files", async () => {
  const f = await prepare(),
    first = f.close();
  expect(f.close()).toBe(first);
  await first;
  expect(state.processes[0]?.stop).toHaveBeenCalledOnce();
  expect(state.reset).toHaveBeenCalledOnce();
  expect(servers.every((server) => !server.listening)).toBe(true);
  expect(existsSync(f.root)).toBe(false);
});
it("attempts proxy retirement after a process fails and keeps rejection and private files", async () => {
  const f = await prepare();
  const fault = new Error("inert process ownership uncertain");
  vi.mocked(state.processes[0]?.stop as CodexProcess["stop"]).mockRejectedValueOnce(fault);
  const first = f.close();
  await expect(first).rejects.toMatchObject({ errors: [fault] });
  expect(f.close()).toBe(first);
  await expect(f.close()).rejects.toMatchObject({ errors: [fault] });
  expect(state.reset).toHaveBeenCalledOnce();
  expect(servers.every((server) => !server.listening)).toBe(true);
  expect(existsSync(f.root)).toBe(true);
});
it("refuses false cleanup success when the proxy manager leaves actual listeners alive", async () => {
  const f = await prepare();
  state.reset.mockResolvedValueOnce(undefined);
  const first = f.close();
  await expect(first).rejects.toThrow("Native fixture ownership was not retired.");
  expect(state.reset).toHaveBeenCalledOnce();
  expect(servers.every((server) => server.listening)).toBe(true);
  expect(existsSync(f.root)).toBe(true);
  expect(f.close()).toBe(first);
});
it("unwinds process and proxy ownership after partial manager initialization fails", async () => {
  const fault = new Error("inert partially initialized manager");
  state.initialize.mockRejectedValueOnce(fault);
  const failure = await prepare().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toContain(fault);
  expect(state.reset).toHaveBeenCalled();
  expect(state.processes[0]?.stop).toHaveBeenCalledOnce();
  expect(servers.every((server) => !server.listening)).toBe(true);
  expect(existsSync(state.top)).toBe(true);
});

it("keeps an outer retention request sticky while still retiring all inner owners", async () => {
  const f = await prepare();
  const retired = Promise.withResolvers<void>();
  state.reset.mockImplementationOnce(async () => {
    await retired.promise;
    await closeServers();
  });
  const first = f.close();
  expect(f.close({ retain: true })).toBe(first);
  expect(f.close({ retain: false })).toBe(first);
  retired.resolve();
  await first;
  expect(state.processes[0]?.stop).toHaveBeenCalledOnce();
  expect(state.reset).toHaveBeenCalledOnce();
  expect(servers.every((server) => !server.listening)).toBe(true);
  expect(existsSync(f.root)).toBe(true);
  expect(f.close({ retain: false })).toBe(first);
  await f.close();
  expect(existsSync(f.root)).toBe(true);
});
