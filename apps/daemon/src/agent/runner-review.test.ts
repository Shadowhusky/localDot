import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAREFUL_AUTONOMY, type KeydRecord, ulid } from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { afterEach, expect, it, vi } from "vitest";
import { NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "../gateway/live.ts";
import type { ChatgptStatus } from "./codex/account.ts";
import { MemoryStore } from "./memory.ts";
import { AgentRunner, type AgentRunnerDeps } from "./runner.ts";
import type { AgentSession } from "./session.ts";
import type { AgentSettings } from "./settings.ts";
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
  const home = mkdtempSync(join(tmpdir(), "localdot-admission-regression-"));
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

it("reviewer: pending task keeps its policy while an idle prior task drains", async () => {
  const f = setup();
  f.setSettings({
    main: { provider: "chatgpt", model: "gpt-6-astra" },
    autonomy: CAREFUL_AUTONOMY,
  });
  const old = await f.runner.start(f.cellId, "prior task");
  await until(() => old.status === "idle");
  const gate = deferred<void>();
  const entered = deferred<void>();
  const settled = f.live.settled.bind(f.live);
  const spy = vi.spyOn(f.live, "settled").mockImplementation(async (id) => {
    if (id === old.id) {
      entered.resolve();
      await gate.promise;
    }
    await settled(id);
  });
  const pending = f.runner.start(f.cellId, "new task", undefined, { continues: old.id });
  try {
    await entered.promise;
    f.setSettings({
      main: { provider: "chatgpt", model: "gpt-6-astra" },
      autonomy: { ...CAREFUL_AUTONOMY, send: "act" },
    });
    gate.resolve();
    const session = await pending;
    expect(session.autonomy.send).toBe("ask");
  } finally {
    gate.resolve();
    await pending.catch(() => {});
    spy.mockRestore();
  }
});
it("reviewer: a later explicit task request receives the newly saved policy", async () => {
  const f = setup();
  f.setSettings({
    main: { provider: "chatgpt", model: "gpt-6-astra" },
    autonomy: CAREFUL_AUTONOMY,
  });
  const old = await f.runner.start(f.cellId, "prior task");
  await until(() => old.status === "idle");
  f.setSettings({
    main: { provider: "chatgpt", model: "gpt-6-astra" },
    autonomy: { ...CAREFUL_AUTONOMY, send: "act" },
  });
  const next = await f.runner.start(f.cellId, "explicit later task");
  expect(old.autonomy.send).toBe("ask");
  expect(next.autonomy.send).toBe("act");
});
