import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CodexLaunchError, prepareOwnedCodexRoots } from "@localdot/codex-harness";
import { DEFAULT_AUTONOMY, type KeydRecord, ulid } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "../gateway/live.ts";
import { checkChatgptChoice } from "./bindings.ts";
import type { ChatgptStatus } from "./codex/account.ts";
import { CodexAuthOwner } from "./codex/auth-owner.ts";
import { CodexCleanupError } from "./codex/driver.ts";
import { MemoryStore } from "./memory.ts";
import { AgentRunner, type AgentRunnerDeps } from "./runner.ts";
import { type AgentSession, abortable } from "./session.ts";
import { AgentSettings } from "./settings.ts";
import { fixtureModelAdmission } from "./testing/model-admission.ts";
import { TranscriptStore } from "./transcript.ts";

const accountMocks = vi.hoisted(() => ({ launch: vi.fn(), installer: vi.fn() }));
vi.mock("@localdot/codex-harness", async (original) => ({
  ...(await original<typeof import("@localdot/codex-harness")>()),
  harnessAvailability: () => ({ available: true }),
  createCodexInstaller: accountMocks.installer,
  launchCodex: accountMocks.launch,
}));
const fixtures: { runner: AgentRunner; log: EventLog; home: string }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.runner.close();
    f.log.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("fixture did not reach its state");
}
function setup(idleMs = 60_000) {
  const home = mkdtempSync("/tmp/ld12-runner-");
  const log = new EventLog(home),
    live = new LiveSessions(),
    cellId = ulid();
  const transcripts = new TranscriptStore(home);
  let settings: AgentSettings = {
    main: { provider: "chatgpt", model: "gpt-6-astra" },
    fast: { provider: "anthropic", model: "stored-model", key: "missing-key" },
    local: { provider: "lmstudio", model: "stored-local" },
    taskBudgetUSD: 5,
    codexDenyRead: ["/Volumes/Private"],
  };
  let status: ChatgptStatus = {
    available: true,
    state: "signed_in",
    codexVersion: "0.154.0",
    account: { email: "fixture@example.com", plan: "plus" },
  };
  const state = { online: true, paused: false, busy: false, authGeneration: 1 };
  const run = vi.fn(async (session: AgentSession, _input: { model: string; resume: boolean }) => {
    const generation = session.beginBrain();
    session.setStatus("running");
    try {
      const inbox = await session.inbox(session.delivered, 0, generation.signal, generation);
      const after = inbox.items.at(-1)?.seq;
      if (after !== undefined)
        session.appendTranscript(transcripts, generation, {
          messages: inbox.items
            .filter((item) => item.kind !== "resume")
            .map((item) => ({
              messageId: item.messageId,
              role: "user" as const,
              content: item.text,
              sourceInbox: { seq: item.seq, messageId: item.messageId },
            })),
          inboxAfter: after,
        });
      return 0;
    } finally {
      session.retireBrain(generation);
    }
  });
  const ended = vi.fn(async (_id: string) => {});
  const secrets = vi.fn(async (): Promise<KeydRecord[]> => {
    throw new Error("subscription must not look up paid keys");
  });
  const beginTask = vi.fn(async () => {});
  const open = vi.fn(async () => {
    throw new Error("subscription must not open a brain cell");
  });
  const account = { status: vi.fn(async () => structuredClone(status)) };
  const installSkills = vi.fn(async () => [
    { name: "fixture", description: "A fixture", path: "~/.skills/fixture/SKILL.md" },
  ]);
  const containment = vi.fn(async (id: string) => {
    state.paused = true;
    live.stop(id);
    return { revoked: true, paused: true, closed: false, stopped: false, errors: [] };
  });
  const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
    signal.throwIfAborted();
  });
  const brains = {
    open,
    start: vi.fn(async () => {}),
    exited: vi.fn(async () => 0),
    close: vi.fn(async () => {}),
  };
  const admission = fixtureModelAdmission(brains);
  const deps: AgentRunnerDeps = {
    home,
    eventLog: log,
    live,
    cell: (id) =>
      id === cellId
        ? {
            id,
            state: "ready",
            scale: 1,
            createdAt: "2026-10-03T00:00:00Z",
            stream: NO_STREAM,
            ...(state.paused ? { paused: true } : {}),
          }
        : undefined,
    cellBusy: () => state.busy,
    brains,
    keyd: { secrets, beginTask, ...admission },
    keydHealth: () => ({ online: state.online, bootId: "fixture-boot" }),
    settings: () => settings,
    catalog: () => normalizeCatalog(MODELS_DEV_FIXTURE, "2026-10-03T00:00:00Z"),
    memory: new MemoryStore(home),
    transcripts,
    installSkills,
    waitForUploads: vi.fn(async () => {}),
    stopSession: containment,
    sleep,
    idleMs,
    codex: { driver: { run }, account, ended, authGeneration: () => state.authGeneration },
  };
  const runner = new AgentRunner(deps);
  fixtures.push({ runner, log, home });
  return {
    home,
    log,
    live,
    cellId,
    runner,
    deps,
    state,
    run,
    ended,
    account,
    secrets,
    beginTask,
    open,
    containment,
    sleep,
    installSkills,
    setSettings(value: AgentSettings) {
      settings = value;
    },
    setStatus(value: ChatgptStatus) {
      status = value;
    },
  };
}

describe("ChatGPT provider selection", () => {
  it("accepts a valid main selection", () => {
    expect(() =>
      checkChatgptChoice("main", { provider: "chatgpt", model: "gpt-6-astra" }),
    ).not.toThrow();
  });
  it.each(["fast", "local"] as const)("rejects ChatGPT in the %s role", (role) => {
    expect(() => checkChatgptChoice(role, { provider: "chatgpt", model: "gpt-6-astra" })).toThrow(
      "main model",
    );
  });
  it.each([{ key: "api-key" }, { price: { inputUSDPerMTok: 1, outputUSDPerMTok: 2 } }])(
    "rejects paid route fields %j",
    (extra) => {
      expect(() =>
        checkChatgptChoice("main", { provider: "chatgpt", model: "gpt-6-astra", ...extra }),
      ).toThrow();
    },
  );
  it.each(["GPT-6", "openai/gpt-6", "g".repeat(65)])(
    "rejects unsupported wire model %s",
    (model) => {
      expect(() => checkChatgptChoice("main", { provider: "chatgpt", model })).toThrow(
        "unknown ChatGPT model",
      );
    },
  );
  it("keeps Codex deny folders bounded and literal", () => {
    expect(
      AgentSettings.parse({ codexDenyRead: ["/Volumes/Private", "/private/tmp/directory"] })
        .codexDenyRead,
    ).toHaveLength(2);
    for (const path of [
      "relative",
      "/a*",
      "/a?",
      "/a[b]",
      "/a\0",
      "/a\n",
      "/a\r",
      `/${"a".repeat(1024)}`,
    ])
      expect(AgentSettings.safeParse({ codexDenyRead: [path] }).success, path).toBe(false);
    expect(AgentSettings.safeParse({ codexDenyRead: Array(33).fill("/private") }).success).toBe(
      false,
    );
  });
});

describe("ChatGPT runner lifecycle", () => {
  it("runs the subscription with no paid key lookup, brain cell or USD task account", async () => {
    const f = setup();
    f.secrets.mockResolvedValueOnce([]);
    const s = await f.runner.start(f.cellId, "Fixture task");
    await until(() => s.status === "idle");
    expect(f.run).toHaveBeenCalledExactlyOnceWith(s, { model: "gpt-6-astra", resume: false });
    expect(f.secrets).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.beginTask).not.toHaveBeenCalled();
    expect(f.runner.isChatgpt(s.id)).toBe(true);
    expect(f.runner.skillsOf(s.id)).toEqual(await f.installSkills.mock.results[0]?.value);
    s.stop();
    await f.live.settled(s.id);
    expect(f.ended).toHaveBeenCalledExactlyOnceWith(s.id);
  });
  it.each(["signed_out", "expired"] as const)("refuses start while %s", async (state) => {
    const f = setup();
    f.setStatus({ available: true, state, codexVersion: "0.154.0" });
    await expect(f.runner.start(f.cellId, "Fixture task")).rejects.toMatchObject({ status: 400 });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.secrets).not.toHaveBeenCalled();
  });
  it("refuses unavailable and absent harness without falling back", async () => {
    const f = setup();
    f.setStatus({
      available: false,
      state: "unavailable",
      reason: "Pinned acceptance is pending.",
      codexVersion: "0.154.0",
    });
    await expect(f.runner.start(f.cellId, "Fixture task")).rejects.toThrow(
      "Pinned acceptance is pending.",
    );
    f.deps.codex = undefined;
    await expect(f.runner.start(f.cellId, "Fixture task")).rejects.toThrow("not set up");
    expect(f.open).not.toHaveBeenCalled();
    expect(f.secrets).not.toHaveBeenCalled();
  });
  it("preserves model and deny folders on retries and idle follow-ups after a settings edit", async () => {
    const f = setup();
    f.run.mockResolvedValueOnce(70);
    const s = await f.runner.start(f.cellId, "Fixture task");
    await until(() => s.status === "idle");
    expect(f.sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
    f.setSettings({
      main: { provider: "anthropic", model: "other", key: "new-api-key" },
      codexDenyRead: ["/changed"],
    });
    s.post("followup", "One more thing");
    await until(() => f.run.mock.calls.length === 3 && s.status === "idle");
    expect(f.run.mock.calls.map(([, input]) => input)).toEqual([
      { model: "gpt-6-astra", resume: false },
      { model: "gpt-6-astra", resume: true },
      { model: "gpt-6-astra", resume: true },
    ]);
    expect(f.runner.codexDenyReadOf(s.id)).toEqual(["/Volumes/Private"]);
    expect(f.secrets).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
  it("refuses a USD budget and counts only active subscription tasks", async () => {
    const f = setup(),
      gate = deferred<number>();
    f.run.mockImplementationOnce(async (s) => {
      s.setStatus("running");
      return abortable(gate.promise, s.abort.signal);
    });
    const s = await f.runner.start(f.cellId, "Fixture task");
    await until(() => f.run.mock.calls.length === 1);
    expect(f.runner.activeChatgptTasks()).toBe(1);
    await expect(f.runner.raiseBudget(s.id, 10)).rejects.toMatchObject({
      status: 409,
      message: "A ChatGPT plan task has no budget in localDot.",
    });
    expect(f.beginTask).not.toHaveBeenCalled();
    s.setStatus("paused");
    expect(f.runner.activeChatgptTasks()).toBe(0);
    gate.resolve(0);
  });
  it("requires desktop readiness and key-layer health without LLM key lookup", async () => {
    const f = setup();
    f.state.busy = true;
    await expect(f.runner.start(f.cellId, "Fixture task")).rejects.toMatchObject({ status: 409 });
    f.state.busy = false;
    await f.runner.keydChanged({ online: false }, { online: true });
    await expect(f.runner.start(f.cellId, "Fixture task")).rejects.toMatchObject({ status: 503 });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.secrets).not.toHaveBeenCalled();
  });
  it("waits for hand-back before a subscription follow-up", async () => {
    const f = setup();
    const s = await f.runner.start(f.cellId, "Fixture task");
    await until(() => s.status === "idle");
    s.beginBrain();
    const waiter = s.takeover("login", "Finish a login");
    void waiter.catch(() => {});
    await until(() => s.controlHeld);
    s.post("followup", "Continue");
    await new Promise<void>((r) => setImmediate(r));
    expect(f.run).toHaveBeenCalledTimes(1);
    const request = s.pendingTakeover;
    if (!request) throw new Error("missing takeover");
    expect(s.endTakeover(request, "Done")).toBe(true);
    await until(() => f.run.mock.calls.length === 2);
  });
  it("contains uncertain Codex cleanup without crash replacement", async () => {
    const f = setup();
    f.run.mockRejectedValueOnce(new CodexCleanupError());
    const s = await f.runner.start(f.cellId, "Fixture task");
    await f.live.settled(s.id);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.containment).toHaveBeenCalledExactlyOnceWith(s.id);
    expect(f.sleep).not.toHaveBeenCalled();
    await expect(f.runner.start(f.cellId, "Another task")).rejects.toMatchObject({ status: 409 });
  });
  it("keeps an idle task paused after account change until explicit Resume", async () => {
    const f = setup(),
      s = await f.runner.start(f.cellId, "Fixture task");
    await until(() => s.status === "idle");
    s.setStatus("paused");
    s.append("agent.state", { state: "paused", reason: "chatgpt account changed" });
    s.post("followup", "Keep this message for the resumed account");
    await new Promise<void>((r) => setImmediate(r));
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(s.status).toBe("paused");
    await f.runner.keydChanged({ online: false }, { online: true });
    await f.runner.keydChanged({ online: true, bootId: "fixture-boot" }, { online: false });
    await new Promise<void>((r) => setImmediate(r));
    expect(f.run).toHaveBeenCalledTimes(1);
    s.post("resume", "");
    await until(() => f.run.mock.calls.length === 2 && s.status === "idle");
  });
  it("freezes autonomy before account preflight and preserves it through an idle follow-up", async () => {
    const f = setup(),
      gate = deferred<ChatgptStatus>();
    f.setSettings({
      main: { provider: "chatgpt", model: "gpt-6-astra" },
      autonomy: DEFAULT_AUTONOMY,
    });
    f.account.status.mockReturnValueOnce(gate.promise);
    const pending = f.runner.start(f.cellId, "Synthetic policy task");
    await until(() => f.account.status.mock.calls.length === 1);
    f.setSettings({
      main: { provider: "chatgpt", model: "gpt-6-astra" },
      autonomy: { ...DEFAULT_AUTONOMY, send: "act" },
    });
    gate.resolve({ available: true, state: "signed_in", codexVersion: "0.154.0" });
    const session = await pending;
    await until(() => session.status === "idle");
    expect(session.autonomy.send).toBe("ask");
    expect(Object.isFrozen(session.autonomy)).toBe(true);
    session.post("followup", "Continue synthetic work");
    await until(() => f.run.mock.calls.length === 2 && session.status === "idle");
    expect(session.autonomy.send).toBe("ask");
    expect(f.secrets).not.toHaveBeenCalled();
  });

  it("does not start after the request is canceled during account preflight", async () => {
    const f = setup(),
      gate = deferred<ChatgptStatus>(),
      controller = new AbortController();
    f.account.status.mockReturnValueOnce(gate.promise);
    const start = f.runner.start(f.cellId, "Fixture task", controller.signal);
    void start.catch(() => {});
    await until(() => f.account.status.mock.calls.length === 1);
    controller.abort();
    gate.resolve({ available: true, state: "signed_in", codexVersion: "0.154.0" });
    await expect(start).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.runner.sessions.size).toBe(0);
  });
});

describe("runner auth mutation cursors", () => {
  it("does not discard an already accepted Resume when the same mutation pauses again", async () => {
    const f = setup(),
      gate = deferred<number>();
    f.run.mockImplementationOnce((s) => abortable(gate.promise, s.abort.signal));
    const s = await f.runner.start(f.cellId, "Fixture task");
    await until(() => f.run.mock.calls.length === 1);
    try {
      f.state.authGeneration = 2;
      s.append("agent.state", { state: "paused", reason: "chatgpt account changed" });
      s.post("resume", "");
      await f.runner.waitForAuthResume(s);
      s.append("agent.state", { state: "paused", reason: "chatgpt account changed" });
      let resumed = false;
      const wait = f.runner.waitForAuthResume(s).then(() => {
        resumed = true;
      });
      void wait.catch(() => {});
      await new Promise<void>((r) => setImmediate(r));
      expect(resumed).toBe(true);
      await wait;
    } finally {
      gate.resolve(0);
    }
  });
  it("requires a new Resume for a newer mutation and ignores ordinary follow-up input", async () => {
    const f = setup(),
      gate = deferred<number>();
    f.run.mockImplementationOnce((s) => abortable(gate.promise, s.abort.signal));
    const s = await f.runner.start(f.cellId, "Fixture task");
    await until(() => f.run.mock.calls.length === 1);
    try {
      f.state.authGeneration = 2;
      s.append("agent.state", { state: "paused", reason: "chatgpt account changed" });
      s.post("resume", "");
      f.state.authGeneration = 3;
      s.append("agent.state", { state: "paused", reason: "chatgpt account changed" });
      s.post("followup", "Continue under the new account");
      let resumed = false;
      const wait = f.runner.waitForAuthResume(s).then(() => {
        resumed = true;
      });
      void wait.catch(() => {});
      await new Promise<void>((r) => setImmediate(r));
      expect(resumed).toBe(false);
      s.post("resume", "");
      await wait;
      expect(resumed).toBe(true);
    } finally {
      gate.resolve(0);
    }
  });
});

describe("synchronous account mutation pause", () => {
  it.each(["failed journal", "held takeover", "no queued followup"])(
    "requires auth Resume independent of %s",
    async (mode) => {
      const f = setup(mode === "no queued followup" ? 250 : 60_000),
        s = await f.runner.start(f.cellId, "Fixture task");
      await until(() => s.status === "idle");
      const realHome = join(f.home, "user");
      mkdirSync(realHome, { mode: 0o700 });
      const roots = prepareOwnedCodexRoots(join(f.home, "account-fixture"), realHome);
      accountMocks.installer.mockReturnValue({
        status: () => ({ state: "ready", version: "0.154.0" }),
        ensureInstalled: vi.fn(),
        verifiedInstallation: vi.fn(),
        cancel: vi.fn(),
      });
      accountMocks.launch.mockReset().mockRejectedValue(new CodexLaunchError("startup_failed"));
      const options = {
        roots,
        sessions: () => [s],
        pauseForAuth: (session: AgentSession, generation: number) =>
          f.runner.pauseForAuth(session, generation),
      };
      const owner = new CodexAuthOwner(options);
      if (!f.deps.codex) throw new Error("fixture missing codex");
      f.deps.codex.authGeneration = () => owner.authGeneration;
      let held: Promise<unknown> | undefined;
      let append: ReturnType<typeof vi.spyOn> | undefined;
      try {
        if (mode !== "held takeover") {
          const original = s.append.bind(s);
          append = vi
            .spyOn(s, "append")
            .mockImplementation((...args: Parameters<AgentSession["append"]>) => {
              if (
                args[0] === "agent.state" &&
                (args[1] as { reason?: string }).reason === "chatgpt account changed"
              )
                throw new Error("fixture journal failed");
              return original(...args);
            });
        } else {
          s.beginBrain();
          held = s.takeover("login", "Fixture handover");
          void held.catch(() => {});
        }
        await expect(owner.logout()).rejects.toMatchObject({ status: 503 });
        if (mode !== "held takeover") expect(accountMocks.launch).not.toHaveBeenCalled();
        if (mode !== "no queued followup") s.post("followup", "Keep for explicit auth Resume");
        if (mode === "held takeover") {
          expect(s.controlHeld).toBe(true);
          const id = s.pendingTakeover;
          if (!id) throw new Error("fixture missing handover");
          expect(s.endTakeover(id, "Handed back")).toBe(true);
          await expect(held).rejects.toThrow("session or agent call is no longer active");
        }
        append?.mockRestore();
        await new Promise<void>((r) => setImmediate(r));
        await new Promise<void>((r) => setImmediate(r));
        expect(s.stopped).toBe(false);
        expect(f.runner.sessions.has(s.id)).toBe(true);
        expect(f.run).toHaveBeenCalledTimes(1);
        if (mode === "no queued followup") s.post("followup", "Keep for explicit auth Resume");
        s.post("resume", "");
        await until(() => f.run.mock.calls.length === 2 && s.status === "idle");
      } finally {
        append?.mockRestore();
        s.stop();
        await owner.close();
      }
    },
  );
});

it("native Pause receipt uncertainty runs the existing revoke and computer containment path", async () => {
  const f = setup();
  const nativePause = vi.fn(async () => {
    throw new CodexCleanupError();
  });
  const nativeResume = vi.fn(async () => {});
  const codex = f.deps.codex;
  if (!codex) throw new Error("native fixture missing");
  codex.driver.pauseAtBoundary = nativePause;
  codex.driver.resumeAtBoundary = nativeResume;
  const session = await f.runner.start(f.cellId, "Inert native safety boundary");
  await until(() => f.run.mock.calls.length === 1 && session.status === "idle");
  f.runner.pauseTask(session.id, ulid());
  await until(() => session.stopped);
  expect(nativePause).toHaveBeenCalledTimes(1);
  expect(nativeResume).not.toHaveBeenCalled();
  await until(() => f.containment.mock.calls.length === 1);
  expect(f.containment).toHaveBeenCalledWith(session.id);
  expect(session.safetyPause?.resumeAvailable).toBe(false);
});
