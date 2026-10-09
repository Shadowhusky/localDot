import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverNativeRetired } from "../../../apps/cli/src/install/native-recovery.ts";
import { assertNativeRetired } from "../../../apps/cli/src/install/native-retirement.ts";
import type { ApprovalContext, ApprovalIdentity } from "./approvals.ts";
import * as installer from "./install.ts";
import {
  type CodexConnection,
  harnessAvailability,
  type LaunchInput,
  launchCodex,
} from "./launch.ts";
import * as supervisorLocation from "./native-supervisor.ts";
import * as primitive from "./process.ts";
import * as profiles from "./profile.ts";
import * as retirementRecords from "./retirement-record.ts";
import type { OwnedCodexRoots } from "./roots.ts";
import * as directories from "./roots.ts";
import { createOwnedCodexDirectory, prepareOwnedCodexRoots } from "./roots.ts";
import * as supervised from "./supervised-process.ts";
import { codexRelease, releaseInstallKey } from "./version.ts";

const roots: string[] = [],
  live: CodexConnection[] = [],
  pipes: PassThrough[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const c of live.splice(0)) await c.stop().catch(() => {});
  for (const p of pipes.splice(0)) p.destroy();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const r of roots.splice(0)) rmSync(r, { force: true, recursive: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function privateEndpoint(owned: OwnedCodexRoots) {
  const mcp = createOwnedCodexDirectory(owned, "runRoot"),
    socket = join(mcp.path, "m.sock"),
    server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  chmodSync(socket, 0o600);
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      const at = servers.indexOf(server);
      if (at !== -1) servers.splice(at, 1);
      await directories.removeOwnedCodexDirectory(mcp);
    })());
  return { mcp, socket, close };
}
function fixture(
  options: {
    verifyGate?: Promise<installer.InstalledCodex | undefined>;
    stopFails?: boolean;
    pendingSpawn?: boolean;
  } = {},
) {
  const base = mkdtempSync("/tmp/ld9-");
  roots.push(base);
  const real = join(base, "user");
  mkdirSync(real, { mode: 0o700 });
  const owned = prepareOwnedCodexRoots(join(base, "ld"), real),
    release = codexRelease("darwin", "arm64");
  if (!release) throw new Error("fixture missing pin");
  const binDir = join(owned.binRoot, releaseInstallKey(release));
  mkdirSync(binDir, { mode: 0o700 });
  for (const file of ["codex", "codex-code-mode-host"]) {
    writeFileSync(join(binDir, file), "inert test fixture");
    chmodSync(join(binDir, file), 0o555);
  }
  const installed: installer.InstalledCodex = Object.freeze({
    version: "0.154.0",
    platform: "darwin-arm64",
    binDir,
    codexBin: join(binDir, "codex"),
    codeModeHostBin: join(binDir, "codex-code-mode-host"),
  });
  const verify = vi.fn(async () => (options.verifyGate ? options.verifyGate : installed)),
    ensure = vi.fn();
  vi.spyOn(installer, "createCodexInstaller").mockReturnValue({
    status: () => ({ state: "not_installed" }),
    ensureInstalled: ensure,
    verifiedInstallation: verify,
    cancel() {},
  });
  const started = deferred<void>(),
    exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>(),
    closed = deferred<void>(),
    failure = deferred<primitive.CodexProcessError>();
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  pipes.push(stdin, stdout, stderr);
  let raw: primitive.SpawnCodexInput | undefined,
    active = true;
  const proc: primitive.CodexProcess = {
    pid: 410001,
    stdin,
    stdout,
    stderr,
    started: started.promise,
    exited: exited.promise,
    closed: closed.promise,
    failure: failure.promise,
    stop: vi.fn(async () => {
      raw?.fence?.();
      await raw?.interrupt?.();
      if (options.stopFails) throw new primitive.CodexProcessError("process_shutdown_failed");
      exited.resolve({ code: 0, signal: null });
      closed.resolve();
    }),
  };
  const launches: { input: primitive.SpawnCodexInput; settings: unknown }[] = [];
  vi.spyOn(primitive, "spawnCodex").mockImplementation((input) => {
    raw = input;
    input.register(proc);
    const settings = JSON.parse(readFileSync(input.args[2] as string, "utf8"));
    launches.push({ input, settings });
    if (!options.pendingSpawn) started.resolve();
    return proc;
  });
  const owner = {
      register: vi.fn((c: CodexConnection) => {
        live.push(c);
      }),
      isCurrent: () => active,
    },
    stop = new AbortController(),
    fence = vi.fn(),
    failures: string[] = [];
  const input: LaunchInput = {
    purpose: "account",
    signal: stop.signal,
    owner,
    onFence: fence,
    onNotification: () => {},
    onFailure: (e) => {
      failures.push(e.code);
    },
  };
  return {
    owned,
    installed,
    verify,
    ensure,
    owner,
    stop,
    fence,
    failures,
    input,
    launches,
    proc,
    started,
    exited,
    closed,
    stdin,
    stdout,
    setActive: (v: boolean) => {
      active = v;
    },
  };
}
describe("owned Codex launch composition", () => {
  it("uses the installed supervisor transport with the already-verified sandbox request", async () => {
    const f = fixture();
    vi.spyOn(supervisorLocation, "nativeSupervisor").mockReturnValue(
      "/private/fixed-release/keyd/bin/keyd",
    );
    const legacyFixture = vi.mocked(primitive.spawnCodex).getMockImplementation();
    if (!legacyFixture) throw new Error("missing process fixture");
    vi.mocked(primitive.spawnCodex).mockImplementation(() => {
      throw new Error("legacy backend used");
    });
    const transport = vi
      .spyOn(supervised, "spawnSupervisedCodex")
      .mockImplementation((input) => legacyFixture(input));
    const c = await launchCodex({ roots: f.owned }, f.input);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]).toBe("/private/fixed-release/keyd/bin/keyd");
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(f.launches[0]?.input.command).toBe(process.execPath);
    await c.stop();
    await c.closed;
  });
  it("retires a task whose captured bridge already closed independently", async () => {
    const f = fixture(),
      endpoint = await privateEndpoint(f.owned);
    const c = await launchCodex(
      { roots: f.owned },
      {
        ...f.input,
        purpose: "task",
        sessionId: ulid(),
        mcp: endpoint.mcp,
        retireBridge: endpoint.close,
      },
    );
    await endpoint.close();
    expect(existsSync(endpoint.mcp.path)).toBe(false);
    await c.stop();
    await c.closed;
    await assertNativeRetired(dirname(f.owned.root), new AbortController().signal);
  });

  it("holds its receipt and closure until delayed bridge cleanup finishes", async () => {
    const f = fixture(),
      endpoint = await privateEndpoint(f.owned),
      gate = deferred<void>(),
      entered = deferred<void>();
    const c = await launchCodex(
      { roots: f.owned },
      {
        ...f.input,
        purpose: "task",
        sessionId: ulid(),
        mcp: endpoint.mcp,
        retireBridge: async () => {
          entered.resolve();
          await gate.promise;
          await endpoint.close();
        },
      },
    );
    let closed = false;
    void c.closed.then(() => {
      closed = true;
    });
    const stopping = c.stop();
    await entered.promise;
    expect(closed).toBe(false);
    expect(existsSync(endpoint.socket)).toBe(true);
    expect(existsSync(c.workDir)).toBe(false);
    expect(
      readdirSync(f.owned.profilesRoot).filter((name) => name.startsWith(".retired-")),
    ).toHaveLength(1);
    gate.resolve();
    await stopping;
    await c.closed;
    expect(existsSync(endpoint.socket)).toBe(false);
    expect(readdirSync(f.owned.profilesRoot)).toEqual([]);
  });

  it("preserves recovery evidence after the bridge owner rejects cleanup", async () => {
    const f = fixture(),
      endpoint = await privateEndpoint(f.owned);
    const c = await launchCodex(
      { roots: f.owned },
      {
        ...f.input,
        purpose: "task",
        sessionId: ulid(),
        mcp: endpoint.mcp,
        retireBridge: async () => {
          throw new Error("bridge uncertain");
        },
      },
    );
    await expect(c.stop()).rejects.toMatchObject({ code: "shutdown_failed" });
    expect(existsSync(endpoint.socket)).toBe(true);
    expect(
      readdirSync(f.owned.profilesRoot).filter((name) => name.startsWith(".retired-")),
    ).toHaveLength(1);
    await endpoint.close();
    await recoverNativeRetired(dirname(f.owned.root), new AbortController().signal);
    await assertNativeRetired(dirname(f.owned.root), new AbortController().signal);
  });

  it("never spawns if retirement identity capture fails", async () => {
    const f = fixture();
    vi.spyOn(retirementRecords, "prepareNativeRetirement").mockRejectedValue(new Error("capture"));
    await expect(launchCodex({ roots: f.owned }, f.input)).rejects.toMatchObject({
      code: "startup_failed",
    });
    expect(f.launches).toEqual([]);
    await assertNativeRetired(dirname(f.owned.root), new AbortController().signal);
  });

  it("publishes retirement before cleanup and leaves restart recovery evidence on cleanup failure", async () => {
    const f = fixture(),
      c = await launchCodex({ roots: f.owned }, f.input);
    const remove = vi
      .spyOn(directories, "removeOwnedCodexDirectory")
      .mockImplementation(async () => {
        const receipts = readdirSync(f.owned.profilesRoot).filter((name) =>
          name.startsWith(".retired-"),
        );
        expect(receipts).toHaveLength(1);
        throw new Error("cleanup interrupted");
      });
    await expect(c.stop()).rejects.toMatchObject({ code: "shutdown_failed" });
    expect(existsSync(c.workDir)).toBe(true);
    expect(
      readdirSync(f.owned.profilesRoot).filter((name) => name.startsWith(".retired-")),
    ).toHaveLength(1);
    remove.mockRestore();
    await recoverNativeRetired(dirname(f.owned.root), new AbortController().signal);
    await assertNativeRetired(dirname(f.owned.root), new AbortController().signal);
    await expect(c.stop()).rejects.toMatchObject({ code: "shutdown_failed" });
  });

  it("keeps both owned resources when retirement publication fails", async () => {
    const f = fixture(),
      prepare = retirementRecords.prepareNativeRetirement;
    vi.spyOn(retirementRecords, "prepareNativeRetirement").mockImplementation(async (...args) => {
      await prepare(...args);
      return {
        persist: async () => {
          throw new Error("persistence");
        },
      };
    });
    const c = await launchCodex({ roots: f.owned }, f.input);
    await expect(c.stop()).rejects.toMatchObject({ code: "shutdown_failed" });
    expect(existsSync(c.workDir)).toBe(true);
    expect(
      readdirSync(f.owned.profilesRoot).filter((name) => name.startsWith(".owned-")),
    ).toHaveLength(1);
    expect(readdirSync(f.owned.profilesRoot).filter((name) => name.startsWith(".retir"))).toEqual(
      [],
    );
  });

  it("installer retirement observes live profiles and clears only after confirmed native closure", async () => {
    const f = fixture(),
      home = dirname(f.owned.root),
      signal = new AbortController().signal;
    await assertNativeRetired(home, signal);
    const c = await launchCodex({ roots: f.owned }, f.input);
    await expect(assertNativeRetired(home, signal)).rejects.toThrow("Native task retirement");
    vi.mocked(f.proc.stop).mockResolvedValue(undefined);
    const stopping = c.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(assertNativeRetired(home, signal)).rejects.toThrow("Native task retirement");
    f.exited.resolve({ code: 0, signal: null });
    f.closed.resolve();
    await stopping;
    await assertNativeRetired(home, signal);
  });
  it("never spawns when the protected profile cannot be persisted", async () => {
    const f = fixture();
    const persist = vi
      .spyOn(directories, "persistOwnedCodexProfile")
      .mockRejectedValue(new Error("disk"));
    await expect(launchCodex({ roots: f.owned }, f.input)).rejects.toMatchObject({
      code: "startup_failed",
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(f.launches).toEqual([]);
    await assertNativeRetired(dirname(f.owned.root), new AbortController().signal);
  });
  it("registers before verification or resource creation, verifies twice, and never installs implicitly", async () => {
    const f = fixture(),
      verifications: { registered: number; spawned: number }[] = [];
    f.verify.mockImplementation(async () => {
      verifications.push({
        registered: f.owner.register.mock.calls.length,
        spawned: f.launches.length,
      });
      return f.installed;
    });
    const c = await launchCodex({ roots: f.owned }, f.input);
    expect(verifications).toEqual([
      { registered: 1, spawned: 0 },
      { registered: 1, spawned: 0 },
    ]);
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(f.ensure).not.toHaveBeenCalled();
    expect(f.launches).toHaveLength(1);
    const s = f.launches[0];
    expect(s?.input.command).toBe(process.execPath);
    expect(s?.input.args.slice(1, 8)).toEqual([
      "--settings",
      expect.any(String),
      "--",
      f.installed.codexBin,
      "app-server",
      "--listen",
      "stdio://",
    ]);
    expect(s?.settings).toMatchObject({
      network: { strictAllowlist: true, allowLocalBinding: false },
      filesystem: { allowWrite: expect.arrayContaining([f.owned.home, c.workDir]) },
    });
    expect(s?.input.env.CODEX_HOME).toBe(f.owned.home);
    expect(s?.input.env.TMPDIR).toBe(join(c.workDir, "tmp"));
    expect(s?.input.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(s?.input.args.some((arg) => arg.startsWith("mcp_servers."))).toBe(false);
    const originalWork = c.workDir;
    await c.stop();
    await c.closed;
    expect(c.workDir).toBe(originalWork);
    expect(existsSync(originalWork)).toBe(false);
    expect(readdirSync(f.owned.workRoot)).toEqual([]);
    expect(readdirSync(f.owned.profilesRoot)).toEqual([]);
    expect(existsSync(f.owned.home)).toBe(true);
    expect(existsSync(f.installed.codexBin)).toBe(true);
  });
  it("grants a task only its actual owned private socket and uses the fixed system nc bridge", async () => {
    const f = fixture(),
      { mcp, socket, close } = await privateEndpoint(f.owned);
    const c = await launchCodex(
      { roots: f.owned },
      { ...f.input, purpose: "task", sessionId: ulid(), mcp, retireBridge: close },
    );
    const args = f.launches[0]?.input.args ?? [];
    expect(args).toContain('mcp_servers.localdot.command="/usr/bin/nc"');
    expect(args).toContain(`mcp_servers.localdot.args=["-U", ${JSON.stringify(socket)}]`);
    expect(f.launches[0]?.settings).toMatchObject({
      network: {
        allowUnixSockets: [socket],
        allowLocalBinding: false,
        strictAllowlist: true,
      },
      filesystem: {
        allowRead: expect.arrayContaining([mcp.path]),
        allowWrite: expect.not.arrayContaining([mcp.path]),
      },
    });
    await c.stop();
    expect(existsSync(socket)).toBe(false);
    expect(readdirSync(f.owned.workRoot)).toEqual([]);
    expect(readdirSync(f.owned.profilesRoot)).toEqual([]);
  });
  it("refuses an absent install with no download, process or private-work allocation", async () => {
    const f = fixture();
    f.verify.mockResolvedValue(undefined);
    await expect(launchCodex({ roots: f.owned }, f.input)).rejects.toMatchObject({
      code: "install_required",
    });
    expect(f.ensure).not.toHaveBeenCalled();
    expect(f.launches).toEqual([]);
    expect(readdirSync(f.owned.workRoot)).toEqual([]);
  });
  it("rechecks the actual verifier after profile preparation and refuses a changed executable", async () => {
    const f = fixture();
    f.verify
      .mockResolvedValueOnce(f.installed)
      .mockRejectedValueOnce(new installer.CodexInstallError("integrity_failed"));
    await expect(launchCodex({ roots: f.owned }, f.input)).rejects.toMatchObject({
      code: "integrity_failed",
    });
    expect(f.launches).toEqual([]);
    expect(readdirSync(f.owned.workRoot)).toEqual([]);
    expect(readdirSync(f.owned.profilesRoot)).toEqual([]);
  });
  it("owns Stop before spawn and cleans only resources whose process closure was confirmed", async () => {
    const f = fixture({ pendingSpawn: true });
    const launching = launchCodex({ roots: f.owned }, f.input);
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
    f.stop.abort();
    f.started.reject(new primitive.CodexProcessError("cancelled"));
    await expect(launching).rejects.toMatchObject({ code: "cancelled" });
    expect(f.fence).toHaveBeenCalledOnce();
    expect(f.proc.stop).toHaveBeenCalled();
    await f.owner.register.mock.calls[0]?.[0].closed;
    expect(readdirSync(f.owned.workRoot)).toEqual([]);
  });
  it("Stop during a hung readonly verifier completes without permitting its late result to spawn", async () => {
    const gate = deferred<installer.InstalledCodex | undefined>(),
      f = fixture({ verifyGate: gate.promise });
    const launching = launchCodex({ roots: f.owned }, f.input);
    await Promise.resolve();
    f.stop.abort();
    await expect(launching).rejects.toMatchObject({ code: "cancelled" });
    gate.resolve(f.installed);
    await Promise.resolve();
    expect(f.launches).toEqual([]);
    expect(readdirSync(f.owned.workRoot)).toEqual([]);
    expect(f.fence).toHaveBeenCalledOnce();
  });
  it("keeps the startup timeout distinct from cancellation when a readonly verifier hangs", async () => {
    vi.useFakeTimers();
    const gate = deferred<installer.InstalledCodex | undefined>(),
      f = fixture({ verifyGate: gate.promise });
    const launching = launchCodex({ roots: f.owned }, f.input);
    const result = expect(launching).rejects.toMatchObject({ code: "startup_timed_out" });
    await vi.advanceTimersByTimeAsync(20000);
    await result;
    expect(f.failures).toEqual(["startup_timed_out"]);
    expect(f.launches).toEqual([]);
    gate.resolve(f.installed);
    await Promise.resolve();
    expect(f.launches).toEqual([]);
  });
  it("waits for an already-started profile write during Stop, then cleans its exact resources", async () => {
    const f = fixture(),
      gate = deferred<void>(),
      written = deferred<profiles.OwnedSandboxProfile>(),
      write = profiles.writeSettingsFile;
    vi.spyOn(profiles, "writeSettingsFile").mockImplementation(async (...args) => {
      const profile = await write(...args);
      written.resolve(profile);
      await gate.promise;
      return profile;
    });
    const launching = launchCodex({ roots: f.owned }, f.input);
    const profile = await written.promise;
    const rejection = expect(launching).rejects.toMatchObject({ code: "cancelled" });
    f.stop.abort();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(existsSync(profile.path)).toBe(true);
      expect(readdirSync(f.owned.workRoot)).toHaveLength(1);
      expect(f.launches).toEqual([]);
    } finally {
      gate.resolve();
      await rejection;
    }
    expect(readdirSync(f.owned.profilesRoot)).toEqual([]);
    expect(readdirSync(f.owned.workRoot)).toEqual([]);
  });
  it("refuses Stop before launch without registering or creating resources", async () => {
    const f = fixture();
    f.stop.abort();
    await expect(launchCodex({ roots: f.owned }, f.input)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(f.owner.register).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.launches).toEqual([]);
  });
  it("allows its registered owner to Stop synchronously during registration", async () => {
    const f = fixture();
    f.owner.register.mockImplementation((c) => {
      live.push(c);
      void c.stop().catch(() => {});
    });
    await expect(launchCodex({ roots: f.owned }, f.input)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.launches).toEqual([]);
  });
  it("refuses a mistyped asynchronous registration and consumes its rejection", async () => {
    const f = fixture();
    const promise = Promise.reject(new Error("fake-auth-secret"));
    promise.catch(() => {});
    f.owner.register.mockImplementation((() => promise) as never);
    await expect(launchCodex({ roots: f.owned }, f.input)).rejects.toMatchObject({
      code: "startup_failed",
    });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.launches).toEqual([]);
  });
  it("rejects and consumes a mistyped asynchronous ownership guard before any allocation", async () => {
    const f = fixture(),
      promise = Promise.reject(new Error("fake-auth-secret"));
    promise.catch(() => {});
    const consumed = vi.spyOn(promise, "catch");
    f.owner.isCurrent = (() => promise) as never;
    await expect(launchCodex({ roots: f.owned }, f.input)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(consumed).toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.owner.register).not.toHaveBeenCalled();
    expect(f.launches).toEqual([]);
  });
  it("retains profile/work and sticky ownership after an unconfirmed shutdown", async () => {
    const f = fixture({ stopFails: true }),
      c = await launchCodex({ roots: f.owned }, f.input);
    await expect(c.stop()).rejects.toMatchObject({ code: "shutdown_failed" });
    await expect(c.stop()).rejects.toMatchObject({ code: "shutdown_failed" });
    expect(existsSync(c.workDir)).toBe(true);
    expect(readdirSync(f.owned.profilesRoot)).toHaveLength(1);
    expect(f.fence).toHaveBeenCalledOnce();
    let settled = false;
    void c.closed.then(() => {
      settled = true;
    });
    f.closed.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
  });
  it("a transport failure fences first, stops independently and exposes only a typed safe cause", async () => {
    const f = fixture(),
      c = await launchCodex({ roots: f.owned }, f.input);
    f.stdout.write("null\n");
    expect(f.fence).toHaveBeenCalledOnce();
    await c.closed;
    expect(f.proc.stop).toHaveBeenCalled();
    expect(f.failures).toEqual(["transport_failed"]);
    expect(JSON.stringify(f.failures)).not.toContain("fake-auth-secret");
  });
  it("fences tool ownership before publishing failure to a reentrant owner callback", async () => {
    const f = fixture(),
      observed: boolean[] = [],
      onFailure = vi.fn(() => {
        observed.push(f.fence.mock.calls.length === 1);
      });
    const c = await launchCodex({ roots: f.owned }, { ...f.input, onFailure });
    f.stdout.write("null\n");
    await c.closed;
    expect(onFailure).toHaveBeenCalledOnce();
    expect(observed).toEqual([true]);
  });
  it("consumes a rejecting best-effort interrupt without delaying containment", async () => {
    const f = fixture(),
      promise = Promise.reject(new Error("fake-auth-secret"));
    promise.catch(() => {});
    const consumed = vi.spyOn(promise, "catch");
    const c = await launchCodex(
      { roots: f.owned },
      { ...f.input, interruptTurn: (() => promise) as never },
    );
    await c.stop();
    await c.closed;
    expect(consumed).toHaveBeenCalled();
    expect(f.proc.stop).toHaveBeenCalled();
  });
  it("unexpected process exit retires the connection and waits for process close before cleanup", async () => {
    const f = fixture(),
      c = await launchCodex({ roots: f.owned }, f.input);
    const gate = deferred<void>();
    vi.mocked(f.proc.stop).mockImplementation(async () => gate.promise);
    f.exited.resolve({ code: 1, signal: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.fence).toHaveBeenCalledOnce();
    expect(existsSync(c.workDir)).toBe(true);
    gate.resolve();
    f.closed.resolve();
    await c.closed;
    expect(f.failures).toEqual(["process_exited"]);
    expect(existsSync(c.workDir)).toBe(false);
  });
  it("preserves a process failure that aborts spawn readiness instead of calling it user cancellation", async () => {
    const f = fixture({ pendingSpawn: true });
    const launching = launchCodex({ roots: f.owned }, f.input);
    const rejection = expect(launching).rejects.toMatchObject({ code: "process_exited" });
    await vi.waitFor(() => expect(f.launches).toHaveLength(1));
    f.exited.resolve({ code: 1, signal: null });
    await rejection;
    expect(f.failures).toEqual(["process_exited"]);
    expect(f.fence).toHaveBeenCalledOnce();
  });
  it("keeps work and closure pending until closed pipes are confirmed even if process Stop resolves early", async () => {
    const f = fixture(),
      c = await launchCodex({ roots: f.owned }, f.input);
    const cleanup = vi.spyOn(directories, "removeOwnedCodexDirectory");
    vi.mocked(f.proc.stop).mockResolvedValue(undefined);
    const stopping = c.stop();
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanup).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(existsSync(c.workDir)).toBe(true);
    f.exited.resolve({ code: 0, signal: null });
    f.closed.resolve();
    await stopping;
    expect(existsSync(c.workDir)).toBe(false);
  });
  it("does not report closure when exact owned filesystem cleanup exceeds the retirement deadline", async () => {
    const f = fixture(),
      c = await launchCodex({ roots: f.owned }, f.input),
      gate = deferred<void>(),
      entered = deferred<void>(),
      remove = directories.removeOwnedCodexDirectory;
    vi.spyOn(directories, "removeOwnedCodexDirectory").mockImplementation(async (directory) => {
      entered.resolve();
      await gate.promise;
      return remove(directory);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = c.stop(),
      rejection = expect(stopping).rejects.toMatchObject({ code: "shutdown_failed" });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    expect(existsSync(c.workDir)).toBe(true);
    let closed = false;
    void c.closed.then(() => {
      closed = true;
    });
    gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(existsSync(c.workDir)).toBe(true);
    await expect(c.stop()).rejects.toMatchObject({ code: "shutdown_failed" });
  });
  it("blocked operations cannot use arbitrary caller approval replies", async () => {
    const f = fixture(),
      c = await launchCodex({ roots: f.owned }, f.input);
    let wire = "";
    f.stdin.on("data", (chunk) => {
      wire += chunk.toString();
    });
    f.stdout.write(
      `${JSON.stringify({ id: 0, method: "item/commandExecution/requestApproval", params: { command: "fake-auth-secret" } })}\n`,
    );
    await vi.waitFor(() => expect(wire).toContain('"decision":"decline"'));
    expect(wire).not.toContain("fake-auth-secret");
    expect(wire).not.toContain("jsonrpc");
    await c.stop();
  });
  it("accepts only an owned task elicitation and discards approval when its epoch retires before writing", async () => {
    const f = fixture(),
      { mcp, close } = await privateEndpoint(f.owned),
      turn = new AbortController();
    const identity: ApprovalIdentity = Object.freeze({
      generation: Object.freeze({ id: 1, signal: new AbortController().signal }),
      authGeneration: 1,
      turn: Object.freeze({ id: 1, signal: turn.signal, basisFrameId: ulid() }),
      mainThreadId: "thread-fixture",
      turnId: "turn-fixture",
      controlHeld: false,
    });
    let checks = 0,
      stale = false;
    const approval: ApprovalContext = {
      captured: identity,
      current: () => {
        if (stale && ++checks === 3) turn.abort();
        return identity;
      },
    };
    const c = await launchCodex(
      { roots: f.owned },
      {
        ...f.input,
        purpose: "task",
        sessionId: ulid(),
        mcp,
        retireBridge: close,
        approvalContext: () => approval,
      },
    );
    let wire = "";
    f.stdin.on("data", (chunk) => {
      wire += chunk.toString();
    });
    const params = {
      serverName: "localdot",
      threadId: identity.mainThreadId,
      turnId: identity.turnId,
      mode: "form",
      _meta: { codex_approval_kind: "mcp_tool_call" },
      requestedSchema: {
        type: "object",
        properties: { reviewed: { type: "boolean", default: false } },
      },
    };
    f.stdout.write(
      `${JSON.stringify({ id: 0, method: "mcpServer/elicitation/request", params })}\n`,
    );
    await vi.waitFor(() => expect(wire).toContain('"action":"accept"'));
    expect(JSON.parse(wire.trim())).toMatchObject({
      id: 0,
      result: { action: "accept", content: { reviewed: false } },
    });
    wire = "";
    stale = true;
    f.stdout.write(
      `${JSON.stringify({ id: 1, method: "mcpServer/elicitation/request", params })}\n`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(wire).toBe("");
    expect(checks).toBe(3);
    await c.stop();
  });
  it("account processes cannot approve a task elicitation even when handed a current task context", async () => {
    const f = fixture(),
      approvalContext = vi.fn();
    const c = await launchCodex({ roots: f.owned }, { ...f.input, approvalContext });
    let wire = "";
    f.stdin.on("data", (chunk) => {
      wire += chunk.toString();
    });
    f.stdout.write(
      `${JSON.stringify({ id: 0, method: "mcpServer/elicitation/request", params: { serverName: "localdot" } })}\n`,
    );
    await vi.waitFor(() => expect(wire).toContain('"action":"decline"'));
    expect(approvalContext).not.toHaveBeenCalled();
    await c.stop();
  });
  it("never spawns a task with missing/forged MCP receipt or invalid session identity", async () => {
    const f = fixture();
    for (const extra of [
      { sessionId: ulid() },
      { sessionId: "../../.codex", mcp: {} },
      { sessionId: ulid(), mcp: { path: "/tmp/m.sock" } },
    ])
      await expect(
        launchCodex({ roots: f.owned }, { ...f.input, purpose: "task", ...extra } as never),
      ).rejects.toMatchObject({ code: "endpoint_unavailable" });
    expect(f.launches).toEqual([]);
    expect(f.ensure).not.toHaveBeenCalled();
  });
  it("refuses account launches carrying a task or MCP capability", async () => {
    const f = fixture();
    await expect(
      launchCodex({ roots: f.owned }, { ...f.input, sessionId: ulid() }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.launches).toEqual([]);
  });
  it("keeps browser login gated until the bounded native callback proof is accepted", async () => {
    const f = fixture();
    await expect(
      launchCodex({ roots: f.owned }, { ...f.input, purpose: "login-browser" }),
    ).rejects.toMatchObject({ code: "browser_unavailable" });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.launches).toEqual([]);
  });
  it("closes notification authority when the owner becomes stale without an abort", async () => {
    const f = fixture(),
      onNotification = vi.fn(),
      c = await launchCodex({ roots: f.owned }, { ...f.input, onNotification });
    f.setActive(false);
    f.stdout.write(
      `${JSON.stringify({ method: "fixture/update", params: { message: "private" } })}\n`,
    );
    await c.closed;
    expect(onNotification).not.toHaveBeenCalled();
    expect(f.fence).toHaveBeenCalledOnce();
  });
});
describe("harness availability", () => {
  it("is a readonly fixed-platform preflight with safe missing-file reasons", () => {
    expect(harnessAvailability("linux", "x64")).toEqual({
      available: false,
      reason: "ChatGPT plan isn't available on Linux yet.",
    });
    expect(harnessAvailability("darwin", "x64")).toEqual({
      available: false,
      reason: "ChatGPT plan needs a Mac with Apple silicon.",
    });
    expect(harnessAvailability("win32", "x64").reason).toBe(
      "ChatGPT plan isn't available on this computer.",
    );
    expect(harnessAvailability("darwin", "arm64", "/not-a-cert/fake-auth-secret")).toEqual({
      available: false,
      reason: "The system certificate bundle is unavailable.",
    });
    expect(harnessAvailability().available).toBe(true);
  });
});
