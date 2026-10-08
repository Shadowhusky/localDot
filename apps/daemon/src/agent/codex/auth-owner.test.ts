import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  ClientMethod,
  CodexConnection,
  LaunchInput,
  RpcRequestOptions,
} from "@localdot/codex-harness";
import { ulid } from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../session.ts";
import { CodexAuthOwner } from "./auth-owner.ts";
import type { TaskLaunch } from "./driver.ts";
import { deferred, until } from "./testing/fake-codex.ts";

const mocks = vi.hoisted(() => ({ launch: vi.fn(), availability: vi.fn(), installer: vi.fn() }));
vi.mock("@localdot/codex-harness", async (original) => ({
  ...(await original<typeof import("@localdot/codex-harness")>()),
  launchCodex: mocks.launch,
  harnessAvailability: mocks.availability,
  createCodexInstaller: mocks.installer,
}));

import { CodexLaunchError, prepareOwnedCodexRoots } from "@localdot/codex-harness";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
beforeEach(() => {
  mocks.launch.mockReset();
  mocks.availability.mockReset().mockReturnValue({ available: true });
  mocks.installer.mockReset();
});
interface Holder {
  input: LaunchInput;
  conn: CodexConnection;
  requests: { method: ClientMethod; params: unknown }[];
  stopped: boolean;
  closed: boolean;
  forceClose(): void;
  stopGate?: Promise<void>;
  failStop?: boolean;
  notify(method: string, value: unknown): void;
}
function fixture(
  extra: Pick<
    import("./auth-owner.ts").CodexAuthOwnerDeps,
    "taskDenyRead" | "extraDenyRead" | "pauseForAuth"
  > = {},
) {
  const top = mkdtempSync("/tmp/ld11-"),
    realHome = join(top, "user");
  mkdirSync(realHome, { mode: 0o700 });
  const roots = prepareOwnedCodexRoots(join(top, "app"), realHome),
    holders: Holder[] = [],
    sessions: AgentSession[] = [];
  let account: unknown = { type: "chatgpt", email: "a@example.invalid", planType: "plus" },
    installState = "ready",
    now = 1000,
    maxActive = 0;
  const install = {
    status: vi.fn(() =>
      installState === "ready"
        ? { state: "ready", version: "0.154.0" }
        : { state: "not_installed" },
    ),
    ensureInstalled: vi.fn(),
    verifiedInstallation: vi.fn(),
    cancel: vi.fn(),
  };
  mocks.installer.mockReturnValue(install);
  const options = {
    hook: undefined as
      | ((h: Holder, method: ClientMethod, params: unknown) => Promise<unknown> | undefined)
      | undefined,
    launchGate: undefined as Promise<void> | undefined,
  };
  mocks.launch.mockImplementation(async (_deps, input: LaunchInput) => {
    const closed = deferred<void>(),
      exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>(),
      failure = deferred<never>();
    let stopping: Promise<void> | undefined;
    const holder: Holder = {
      input,
      conn: undefined as never,
      requests: [],
      stopped: false,
      closed: false,
      forceClose() {
        holder.closed = true;
        closed.resolve();
        exited.resolve({ code: 0, signal: null });
      },
      notify(method, value) {
        input.onNotification(method, value, { signal: input.signal });
      },
    };
    const conn = {
      pid: undefined,
      workDir: "/private/tmp/inert-owner-work",
      closed: closed.promise,
      exited: exited.promise,
      failure: failure.promise,
      stop() {
        if (stopping) return stopping;
        holder.stopped = true;
        input.onFence();
        stopping = (async () => {
          await holder.stopGate;
          if (holder.failStop) throw new Error("private-shutdown-diagnostic");
          holder.forceClose();
        })();
        void stopping.catch(() => {});
        return stopping;
      },
      rpc: {
        async request<T>(method: ClientMethod, params: unknown, opts: RpcRequestOptions<T>) {
          opts.signal.throwIfAborted();
          holder.requests.push({ method, params });
          const custom = options.hook?.(holder, method, params);
          let value: unknown = custom ? await custom : {};
          if (!custom && method === "account/read") value = { account, requiresOpenaiAuth: true };
          if (!custom && method === "model/list")
            value = {
              data: [
                {
                  id: "gpt-6-astra",
                  displayName: "GPT 6",
                  isDefault: true,
                  hidden: false,
                  defaultReasoningEffort: "medium",
                },
                {
                  id: "hidden",
                  displayName: "Hidden",
                  isDefault: false,
                  hidden: true,
                  defaultReasoningEffort: "low",
                },
              ],
            };
          if (!custom && method === "account/rateLimits/read")
            value = {
              rateLimits: {
                planType: "plus",
                primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 100 },
              },
            };
          if (!custom && method === "account/login/start")
            value = {
              type: "chatgptDeviceCode",
              loginId: `login-${holders.length}`,
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "ABCD-EFGH",
            };
          if (!custom && method === "account/logout") account = null;
          opts.signal.throwIfAborted();
          return opts.validateResult(value);
        },
        notify: vi.fn(),
      },
    } as unknown as CodexConnection;
    holder.conn = conn;
    holders.push(holder);
    maxActive = Math.max(maxActive, holders.filter((h) => !h.closed).length);
    input.owner.register(conn);
    await options.launchGate;
    input.signal.throwIfAborted();
    return conn;
  });
  const owner = new CodexAuthOwner({ roots, sessions: () => sessions, now: () => now, ...extra });
  cleanup.push(async () => {
    for (const s of sessions) s.stop();
    await owner.close().catch(() => {});
    rmSync(top, { recursive: true, force: true });
  });
  const session = () => {
    const s = new AgentSession(ulid(), ulid(), "private task", {
      append: () => undefined as never,
    });
    sessions.push(s);
    return s;
  };
  const task = (s: AgentSession): TaskLaunch => {
    const generation = s.generation ?? s.beginBrain(),
      epoch = Object.freeze({ id: generation.id, signal: generation.signal, basisFrameId: ulid() });
    const identity = {
      generation,
      authGeneration: owner.authGeneration,
      turn: epoch,
      mainThreadId: undefined,
      turnId: undefined,
      controlHeld: s.controlHeld,
    };
    return {
      sessionId: s.id,
      endpoint: {
        directory: { path: "/private/tmp/inert-owner-mcp" },
        close: vi.fn(async () => {}),
      } as never,
      signal: generation.signal,
      onRegister: vi.fn(),
      isCurrent: () => s.isCurrent(generation),
      onFence: vi.fn(),
      approvalContext: () => ({ captured: identity, current: () => identity }),
      onBlocked: vi.fn(),
      onNotification: vi.fn(),
      onFailure: vi.fn(),
      interruptTurn: () => undefined,
    };
  };
  return {
    owner,
    holders,
    sessions,
    install,
    options,
    session,
    task,
    roots,
    holder(index: number) {
      const holder = holders[index];
      if (!holder) throw new Error("Fixture holder missing");
      return holder;
    },
    setAccount(v: unknown) {
      account = v;
    },
    setInstalled(v: boolean) {
      installState = v ? "ready" : "not_installed";
    },
    advance(ms: number) {
      now += ms;
    },
    get maxActive() {
      return maxActive;
    },
  };
}
describe("one registered ChatGPT credential owner", () => {
  it("returns unavailable status without installation or process side effects", async () => {
    const f = fixture();
    f.setInstalled(false);
    expect(await f.owner.status()).toMatchObject({ available: false, state: "unavailable" });
    await expect(f.owner.login()).rejects.toMatchObject({ status: 503 });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(f.install.ensureInstalled).not.toHaveBeenCalled();
    expect(f.install.verifiedInstallation).not.toHaveBeenCalled();
  });
  it("reads once on a short-lived account holder, caches safe metadata and returns copies", async () => {
    const f = fixture(),
      status = await f.owner.status();
    expect(status).toMatchObject({
      state: "signed_in",
      account: { email: "a@example.invalid", plan: "plus" },
      usage: { windows: [{ usedPercent: 7 }] },
      models: [{ id: "gpt-6-astra" }],
    });
    expect(f.holders).toHaveLength(1);
    expect(f.holders[0]?.stopped).toBe(true);
    if (!status.account) throw new Error("Fixture account missing");
    status.account.email = "tampered";
    expect((await f.owner.status()).account?.email).toBe("a@example.invalid");
    expect(f.holders).toHaveLength(1);
    f.advance(30001);
    await f.owner.status();
    expect(f.holders).toHaveLength(2);
    expect(f.maxActive).toBe(1);
  });
  it("reserves one task before launch and rejects a second even while the first has no process", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal);
    await expect(f.owner.acquireTask(ulid(), new AbortController().signal)).rejects.toMatchObject({
      status: 409,
    });
    expect(f.holders).toHaveLength(0);
    await lease.release();
    const next = await f.owner.acquireTask(ulid(), new AbortController().signal);
    await next.release();
  });
  it("registers task ownership synchronously, forwards the genuine capture and retires before release", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal),
      input = f.task(s);
    const conn = await lease.launch(input);
    expect(input.onRegister).toHaveBeenCalledWith(conn);
    expect(f.holders[0]?.input.purpose).toBe("task");
    expect(f.holders[0]?.input.mcp).toBe(input.endpoint.directory);
    const originalClose = input.endpoint.close;
    input.endpoint.close = vi.fn(async () => {});
    await f.holders[0]?.input.retireBridge?.();
    expect(originalClose).toHaveBeenCalledOnce();
    expect(input.endpoint.close).not.toHaveBeenCalled();
    expect(await f.owner.status({ fresh: true })).toMatchObject({ state: "signed_out" });
    expect(f.holders).toHaveLength(1);
    await lease.release();
    await conn.closed;
    expect(f.holders[0]?.stopped).toBe(true);
  });
  it("retires every task including paused sessions before logout and clears stale cache immediately", async () => {
    const f = fixture();
    await f.owner.status();
    const s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal);
    await lease.launch(f.task(s));
    s.setStatus("paused");
    const old = f.owner.authGeneration;
    const logout = f.owner.logout();
    void logout.catch(() => {});
    expect(f.owner.authGeneration).toBe(old + 1);
    expect(lease.signal.aborted).toBe(true);
    expect(s.generation).toBeUndefined();
    expect(await f.owner.status()).not.toHaveProperty("account");
    await logout;
    expect((await f.owner.status()).state).toBe("signed_out");
    expect(f.holders[1]?.stopped).toBe(true);
    expect(f.holders[2]?.requests.some((r) => r.method === "account/logout")).toBe(true);
    expect(f.maxActive).toBe(1);
  });
  it("default code login retires its holder before reading the newly committed account", async () => {
    const f = fixture();
    f.setAccount(null);
    await f.owner.status();
    const login = await f.owner.login();
    expect(login.method).toBe("code");
    const holder = f.holders[1];
    if (!holder) throw new Error("Fixture holder missing");
    expect(holder.input.purpose).toBe("account");
    expect(holder.requests.find((r) => r.method === "account/login/start")?.params).toEqual({
      type: "chatgptDeviceCode",
    });
    expect((await f.owner.status()).state).toBe("signing_in");
    f.setAccount({ type: "chatgpt", email: "b@example.invalid", planType: "pro" });
    holder.notify("account/login/completed", { loginId: login.loginId, success: true });
    await until(() => f.holders.length === 3 && f.holders[2]?.stopped === true);
    expect(holder.stopped).toBe(true);
    expect((await f.owner.status()).account?.email).toBe("b@example.invalid");
    expect(f.maxActive).toBe(1);
  });
  it("ignores wrong and late login IDs and a canceled attempt's notifications", async () => {
    const f = fixture();
    f.setAccount(null);
    const login = await f.owner.login(),
      old = f.holders[0];
    if (!old) throw new Error("Fixture holder missing");
    old.notify("account/login/completed", { loginId: "wrong", success: true });
    expect((await f.owner.status()).state).toBe("signing_in");
    await f.owner.cancelLogin();
    const next = await f.owner.login();
    old.notify("account/login/completed", {
      loginId: login.loginId,
      success: false,
      error: "private-diagnostic",
    });
    expect((await f.owner.status()).login?.loginId).toBe(next.loginId);
    expect(JSON.stringify(await f.owner.status())).not.toContain("private-diagnostic");
  });
  it("uses a new reader after cancellation when login already committed credentials", async () => {
    const f = fixture();
    f.setAccount(null);
    await f.owner.login();
    f.setAccount({ type: "chatgpt", email: "b@example.invalid", planType: "pro" });
    await f.owner.cancelLogin();
    expect((await f.owner.status()).state).toBe("signed_in");
    expect(f.holders).toHaveLength(2);
    expect(f.maxActive).toBe(1);
  });
  it("forces refresh on a fresh account holder after retiring task ownership", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal);
    await lease.launch(f.task(s));
    const status = await f.owner.refresh();
    expect(status.state).toBe("signed_in");
    expect(lease.signal.aborted).toBe(true);
    expect(f.holders[1]?.requests.find((r) => r.method === "account/read")?.params).toEqual({
      refreshToken: true,
    });
    expect(f.maxActive).toBe(1);
  });
  it("marks only the current generation expired and removes account/model/window cache", async () => {
    const f = fixture();
    await f.owner.status();
    f.owner.markSignedOut(f.owner.authGeneration - 1);
    expect((await f.owner.status()).state).toBe("signed_in");
    f.owner.markSignedOut(f.owner.authGeneration);
    f.setAccount(null);
    expect(await f.owner.status({ fresh: true })).toMatchObject({ state: "expired" });
    expect(await f.owner.status()).not.toHaveProperty("models");
  });
  it("preserves held takeover while an account mutation retires its brain", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal);
    await lease.launch(f.task(s));
    const takeover = s.takeover("login", "Your turn");
    void takeover.catch(() => {});
    await until(() => s.controlHeld);
    const requestId = s.pendingTakeover;
    await f.owner.logout();
    expect(s.controlHeld).toBe(true);
    expect(s.pendingTakeover).toBe(requestId);
    expect(s.status).toBe("waiting_user");
    s.stop();
    await expect(takeover).rejects.toThrow("the session or agent call is no longer active");
  });
  it("keeps browser sign-in unavailable until the pinned native callback gate passes", async () => {
    const f = fixture();
    await expect(f.owner.login("browser")).rejects.toMatchObject({ status: 503 });
    expect(f.holders).toHaveLength(0);
  });
  it("blocks admission and credential writes after failed holder retirement, even after late closure", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal);
    await lease.launch(f.task(s));
    const holder = f.holders[0];
    if (!holder) throw new Error("Fixture holder missing");
    holder.failStop = true;
    await expect(f.owner.logout()).rejects.toMatchObject({
      status: 503,
      message: "Account process could not be stopped.",
    });
    holder.forceClose();
    await expect(f.owner.acquireTask(ulid(), new AbortController().signal)).rejects.toMatchObject({
      status: 503,
    });
    await expect(f.owner.refresh()).rejects.toMatchObject({ status: 503 });
    expect(f.holders).toHaveLength(1);
  });
  it("closes idempotently and refuses later launches", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal);
    await lease.launch(f.task(s));
    const closing = f.owner.close();
    expect(f.owner.close()).toBe(closing);
    await closing;
    expect(f.holders[0]?.stopped).toBe(true);
    await expect(f.owner.login()).rejects.toMatchObject({ status: 503 });
  });
  it("retires a reserved task with no process before beginning login", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal);
    const login = await f.owner.login();
    expect(lease.signal.aborted).toBe(true);
    expect(login.method).toBe("code");
    expect(f.holders).toHaveLength(1);
    await expect(lease.launch(f.task(s))).rejects.toMatchObject({ status: 409 });
  });
  it("waits for actual closure before releasing a task reservation", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal);
    await lease.launch(f.task(s));
    const gate = deferred<void>();
    f.holder(0).stopGate = gate.promise;
    const release = lease.release();
    expect(lease.release()).toBe(release);
    expect(f.holder(0).closed).toBe(false);
    await expect(f.owner.acquireTask(ulid(), new AbortController().signal)).rejects.toMatchObject({
      status: 409,
    });
    const beforeClose = await Promise.race([
      release.then(() => "released"),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 25)),
    ]);
    expect(beforeClose).toBe("waiting");
    gate.resolve();
    await release;
    const next = await f.owner.acquireTask(ulid(), new AbortController().signal);
    await next.release();
    expect(f.maxActive).toBe(1);
  });
  it("retains late startup ownership before any new credential write", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal),
      gate = deferred<void>();
    f.options.launchGate = gate.promise;
    const launching = lease.launch(f.task(s));
    void launching.catch(() => {});
    await until(() => f.holders.length === 1);
    const logout = f.owner.logout();
    await until(() => f.holder(0).stopped);
    expect(f.holders).toHaveLength(1);
    gate.resolve();
    await expect(launching).rejects.toThrow();
    await logout;
    expect(f.holder(1).requests.some((r) => r.method === "account/logout")).toBe(true);
    expect(f.maxActive).toBe(1);
  });
  it("keeps a startup deadline failure sticky after its late process closes", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal),
      gate = deferred<void>();
    f.options.launchGate = gate.promise;
    const launching = lease.launch(f.task(s));
    void launching.catch(() => {});
    const logout = f.owner.logout(),
      rejected = expect(logout).rejects.toMatchObject({
        status: 503,
        message: "Account process could not be stopped.",
      });
    await vi.advanceTimersByTimeAsync(2001);
    await rejected;
    gate.resolve();
    await expect(launching).rejects.toThrow();
    expect(f.holder(0).closed).toBe(true);
    await expect(f.owner.login()).rejects.toMatchObject({ status: 503 });
    expect(f.holders).toHaveLength(1);
  });
  it.each(["account/read", "model/list"] as const)(
    "an old %s reply cannot restore account A after logout",
    async (method) => {
      const f = fixture(),
        gate = deferred<unknown>();
      f.options.hook = (_holder, name) => (name === method ? gate.promise : undefined);
      const status = f.owner.status();
      void status.catch(() => {});
      await until(() => f.holders.some((h) => h.requests.some((r) => r.method === method)));
      await f.owner.logout();
      await expect(status).rejects.toMatchObject({ status: 409 });
      gate.resolve(
        method === "account/read"
          ? {
              account: { type: "chatgpt", email: "a@example.invalid", planType: "plus" },
              requiresOpenaiAuth: true,
            }
          : { data: [] },
      );
      await Promise.resolve();
      expect(await f.owner.status()).toMatchObject({ state: "signed_out" });
      expect(await f.owner.status()).not.toHaveProperty("account");
      expect(f.maxActive).toBe(1);
    },
  );
  it("serializes simultaneous start and login without granting an old generation lease", async () => {
    const f = fixture(),
      acquiring = f.owner.acquireTask(ulid(), new AbortController().signal);
    void acquiring.catch(() => {});
    const login = f.owner.login();
    await expect(acquiring).rejects.toMatchObject({ status: 409 });
    await login;
    expect(f.holders).toHaveLength(1);
    await expect(f.owner.acquireTask(ulid(), new AbortController().signal)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("a superseded mutation cannot run after a newer logout", async () => {
    const f = fixture(),
      old = f.owner.login();
    void old.catch(() => {});
    const logout = f.owner.logout();
    await expect(old).rejects.toMatchObject({ status: 409 });
    await logout;
    expect(f.holders).toHaveLength(1);
    expect(f.holder(0).requests.some((r) => r.method === "account/login/start")).toBe(false);
    expect((await f.owner.status()).state).toBe("signed_out");
  });
  it("rejects refresh during both pending and established sign-in", async () => {
    const f = fixture(),
      login = f.owner.login(),
      generation = f.owner.authGeneration;
    await expect(f.owner.refresh()).rejects.toMatchObject({ status: 409 });
    expect(f.owner.authGeneration).toBe(generation);
    await login;
    await expect(f.owner.refresh()).rejects.toMatchObject({ status: 409 });
    expect(f.holders).toHaveLength(1);
  });
  it("canceling when no sign-in exists does not supersede a logout", async () => {
    const f = fixture(),
      gate = deferred<unknown>();
    f.options.hook = (_h, name) => (name === "account/logout" ? gate.promise : undefined);
    const logout = f.owner.logout();
    await until(() => f.holders.some((h) => h.requests.some((r) => r.method === "account/logout")));
    const generation = f.owner.authGeneration;
    await f.owner.cancelLogin();
    expect(f.owner.authGeneration).toBe(generation);
    gate.resolve({});
    await logout;
    expect(f.holders).toHaveLength(1);
  });
  it("forwards a typed process failure before invalidating the task lease", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal),
      input = f.task(s),
      seen: boolean[] = [];
    vi.mocked(input.onFailure).mockImplementation(() => {
      seen.push(lease.signal.aborted);
    });
    await lease.launch(input);
    f.holder(0).input.onFence();
    expect(lease.signal.aborted).toBe(false);
    const cause = new CodexLaunchError("process_exited");
    f.holder(0).input.onFailure(cause);
    expect(seen).toEqual([false]);
    expect(input.onFailure).toHaveBeenCalledWith(cause);
    await lease.release();
  });
  it("does not reuse a task lease for a second raw launch", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal),
      input = f.task(s);
    await lease.launch(input);
    await expect(lease.launch(input)).rejects.toMatchObject({ status: 409 });
    expect(f.holders).toHaveLength(1);
    await lease.release();
  });
  it("pauses idle and paused ChatGPT sessions even when they have no active process", async () => {
    const f = fixture(),
      idle = f.session(),
      paused = f.session();
    idle.setStatus("idle");
    paused.beginBrain();
    paused.setStatus("paused");
    await f.owner.logout();
    expect(idle.status).toBe("paused");
    expect(paused.status).toBe("paused");
    expect(paused.generation).toBeUndefined();
  });
  it("accepts a matching early completion only after the returned login ID is validated", async () => {
    const f = fixture();
    f.setAccount(null);
    f.options.hook = (h, name) => {
      if (name !== "account/login/start") return;
      f.setAccount({ type: "chatgpt", email: "b@example.invalid", planType: "pro" });
      const loginId = `login-${f.holders.length}`;
      h.notify("account/login/completed", { loginId, success: true });
      return Promise.resolve({
        type: "chatgptDeviceCode",
        loginId,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      });
    };
    await f.owner.login();
    await until(() => f.holders.length === 2 && f.holder(1).closed);
    expect((await f.owner.status()).account?.email).toBe("b@example.invalid");
    expect(f.maxActive).toBe(1);
  });
  it("a forged early login ID cannot complete the real attempt", async () => {
    const f = fixture();
    f.setAccount(null);
    f.options.hook = (h, name) => {
      if (name !== "account/login/start") return;
      h.notify("account/login/completed", { loginId: "wrong", success: true });
      return Promise.resolve({
        type: "chatgptDeviceCode",
        loginId: "actual",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      });
    };
    const login = await f.owner.login();
    expect((await f.owner.status()).login?.loginId).toBe("actual");
    expect(f.holders).toHaveLength(1);
    f.holder(0).notify("account/login/completed", {
      loginId: login.loginId,
      success: false,
      error: "private token https://auth.openai.com/private",
    });
    await until(() => f.holders.length === 2 && f.holder(1).closed);
    const status = await f.owner.status();
    expect(status.lastError).toBe("The ChatGPT sign-in could not be completed.");
    expect(JSON.stringify(status)).not.toContain("private token");
  });
  it("cancels a pending login reply and determines any committed account with a new reader", async () => {
    const f = fixture(),
      gate = deferred<unknown>();
    f.setAccount(null);
    f.options.hook = (_h, name) => (name === "account/login/start" ? gate.promise : undefined);
    const login = f.owner.login();
    void login.catch(() => {});
    await until(() =>
      f.holders.some((h) => h.requests.some((r) => r.method === "account/login/start")),
    );
    f.setAccount({ type: "chatgpt", email: "b@example.invalid", planType: "pro" });
    await f.owner.cancelLogin();
    await expect(login).rejects.toMatchObject({ status: 409 });
    gate.resolve({
      type: "chatgptDeviceCode",
      loginId: "late",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
    expect((await f.owner.status()).account?.email).toBe("b@example.invalid");
    expect(f.maxActive).toBe(1);
  });
  it("cancels a 600-second sign-in deadline and ignores its later callback", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setAccount(null);
    const login = await f.owner.login();
    await vi.advanceTimersByTimeAsync(600001);
    expect(f.holder(0).requests.some((r) => r.method === "account/login/cancel")).toBe(true);
    expect(f.holder(0).closed).toBe(true);
    const status = await f.owner.status();
    expect(status.lastError).toBe("The sign-in timed out.");
    f.holder(0).notify("account/login/completed", { loginId: login.loginId, success: true });
    expect((await f.owner.status()).state).toBe("signed_out");
  });
  it("rejects unsafe login output and stops the holder without exposing its URL", async () => {
    const f = fixture();
    f.options.hook = (_h, name) =>
      name === "account/login/start"
        ? Promise.resolve({
            type: "chatgptDeviceCode",
            loginId: "login",
            verificationUrl: "https://evil.invalid/private-token",
            userCode: "ABCD-EFGH",
          })
        : undefined;
    await expect(f.owner.login()).rejects.toMatchObject({ status: 503 });
    expect(f.holder(0).closed).toBe(true);
    expect(JSON.stringify(await f.owner.status())).not.toContain("private-token");
  });
  it("unsupported host status never launches or echoes an untrusted availability error", async () => {
    const f = fixture();
    mocks.availability.mockReturnValue({ available: false, reason: "/private/credential-token" });
    expect(await f.owner.status()).toMatchObject({
      state: "unavailable",
      reason: "The ChatGPT plan needs macOS on Apple silicon for now.",
    });
    expect(f.holders).toHaveLength(0);
  });
  it("safe account errors retain only the last same-generation status", async () => {
    const f = fixture();
    await f.owner.status();
    f.options.hook = (_h, name) =>
      name === "account/read" ? Promise.reject(new Error("private credential URL")) : undefined;
    const status = await f.owner.status({ fresh: true });
    expect(status.state).toBe("signed_in");
    expect(status.lastError).toBe("The ChatGPT account could not be checked.");
    expect(JSON.stringify(status)).not.toContain("private credential URL");
  });
  it("retires a captured holder even if the typed-failure observer throws", async () => {
    const f = fixture(),
      s = f.session(),
      lease = await f.owner.acquireTask(s.id, s.abort.signal),
      input = f.task(s);
    vi.mocked(input.onFailure).mockImplementation(() => {
      throw new Error("private observer diagnostic");
    });
    await lease.launch(input);
    expect(() => f.holder(0).input.onFailure(new CodexLaunchError("process_exited"))).toThrow(
      "private observer diagnostic",
    );
    await lease.release();
    expect(f.holder(0).closed).toBe(true);
    const next = await f.owner.acquireTask(ulid(), new AbortController().signal);
    await next.release();
  });
  it("clears a dead sign-in process immediately and checks the account on a new holder", async () => {
    const f = fixture();
    f.setAccount(null);
    await f.owner.login();
    f.holder(0).input.onFence();
    expect(await f.owner.status()).not.toHaveProperty("login");
    await until(() => f.holders.length === 2 && f.holder(1).closed);
    expect(await f.owner.status()).toMatchObject({
      state: "signed_out",
      lastError: "The ChatGPT sign-in connection ended.",
    });
    expect(f.maxActive).toBe(1);
  });
  it("a lost sign-in callback cannot hide credentials already committed before exit", async () => {
    const f = fixture();
    f.setAccount(null);
    await f.owner.login();
    f.setAccount({ type: "chatgpt", email: "b@example.invalid", planType: "pro" });
    f.holder(0).input.onFence();
    await until(() => f.holders.length === 2 && f.holder(1).closed);
    expect((await f.owner.status()).account?.email).toBe("b@example.invalid");
    expect(await f.owner.status()).not.toHaveProperty("lastError");
    expect(f.maxActive).toBe(1);
  });
});

describe("auth mutation journal failures", () => {
  it.each(["login", "logout", "refresh"] as const)(
    "still retires and pauses every later session during %s",
    async (operation) => {
      const f = fixture(),
        first = f.session(),
        later = f.session(),
        idle = f.session();
      first.beginBrain();
      const generation = later.beginBrain();
      later.setStatus("running");
      idle.setStatus("idle");
      vi.spyOn(first, "append").mockImplementation(() => {
        throw new Error("inert journal full");
      });
      const mutation = f.owner[operation]();
      void mutation.catch(() => {});
      // Required fences and status changes happen synchronously, even before the rejection.
      expect(later.generation).toBeUndefined();
      expect(generation.signal.aborted).toBe(true);
      expect(later.status).toBe("paused");
      expect(idle.status).toBe("paused");
      await expect(mutation).rejects.toMatchObject({ status: 503 });
      expect(f.holders).toHaveLength(0);
    },
  );
  it("attempts pause and later retirement even if a retirement observer throws", async () => {
    const f = fixture(),
      first = f.session(),
      later = f.session();
    const firstGeneration = first.beginBrain(),
      laterGeneration = later.beginBrain();
    const original = first.retireBrain.bind(first);
    vi.spyOn(first, "retireBrain").mockImplementation((generation) => {
      original(generation);
      throw new Error("inert retirement observer failed");
    });
    const mutation = f.owner.logout();
    void mutation.catch(() => {});
    expect(firstGeneration.signal.aborted).toBe(true);
    expect(first.status).toBe("paused");
    expect(laterGeneration.signal.aborted).toBe(true);
    expect(later.status).toBe("paused");
    await expect(mutation).rejects.toMatchObject({ status: 503 });
    expect(f.holders).toHaveLength(0);
  });
});

describe("per-task deny-read snapshots", () => {
  it("copies the trusted task deny list when reserving rather than when launching", async () => {
    const paths = ["/Volumes/TaskPrivate"],
      taskDenyRead = vi.fn(() => paths);
    const f = fixture({ taskDenyRead, extraDenyRead: ["/fixed-deny"] }),
      s = f.session();
    const lease = await f.owner.acquireTask(s.id, s.abort.signal);
    paths.push("/later-settings-change");
    await lease.launch(f.task(s));
    expect(taskDenyRead).toHaveBeenCalledExactlyOnceWith(s.id);
    expect(mocks.launch.mock.calls[0]?.[0].extraDenyRead).toEqual([
      "/fixed-deny",
      "/Volumes/TaskPrivate",
    ]);
    await lease.release();
  });
  it("does not consult task settings for a standalone account reader", async () => {
    const taskDenyRead = vi.fn(() => ["/task-only"]),
      f = fixture({ taskDenyRead });
    await f.owner.status();
    expect(taskDenyRead).not.toHaveBeenCalled();
    expect(f.holder(0).input.purpose).toBe("account");
    expect(mocks.launch.mock.calls[0]?.[0].extraDenyRead).toEqual([]);
  });
});

it("installs every runner pause barrier before journal publication despite one callback failure", async () => {
  const pauses = vi.fn((session: AgentSession, _generation: number) => {
    if (session.task === "first") throw new Error("fixture pause notification failed");
  });
  const f = fixture({ pauseForAuth: pauses });
  for (const task of ["first", "later", "idle"]) {
    const session = new AgentSession(ulid(), ulid(), task, { append: () => ({}) as never });
    if (task !== "idle") session.beginBrain();
    f.sessions.push(session);
  }
  const generation = f.sessions[1]?.generation;
  const work = f.owner.logout();
  void work.catch(() => {});
  expect(pauses.mock.calls.map(([s]) => s.task)).toEqual(["first", "later", "idle"]);
  expect(pauses.mock.calls.map((args) => args[1])).toEqual([2, 2, 2]);
  expect(generation?.signal.aborted).toBe(true);
  expect(f.sessions.map((s) => s.status)).toEqual(["paused", "paused", "paused"]);
  await expect(work).rejects.toMatchObject({ status: 503 });
  expect(f.holders).toHaveLength(0);
});
