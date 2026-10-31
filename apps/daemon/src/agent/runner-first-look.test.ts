import { mkdtempSync, rmSync } from "node:fs";
import {
  type BootConfig,
  type KeydRecord,
  type LocalDotEvent,
  type ModelOptions,
  PERSONAS,
  ulid,
} from "@localdot/protocol";
import { normalizeCatalog } from "@localdot/providers";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "../gateway/live.ts";
import type { ResolvedRole } from "./bindings.ts";
import type { BrainCell, OpenBrain } from "./brain-cell.ts";
import { Conversations } from "./conversation.ts";
import { MemoryStore } from "./memory.ts";
import { AgentRunner } from "./runner.ts";
import type { AgentSession } from "./session.ts";
import type { AgentSettings } from "./settings.ts";
import { fixtureModelAdmission } from "./testing/model-admission.ts";
import { TranscriptStore } from "./transcript.ts";

const AT = "2026-10-30T00:00:00Z";
const CLAUDE: AgentSettings = { main: { provider: "claude-code", model: "opus" } };
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("fixture did not reach its state");
}
const reply = (body: object) => JSON.stringify(body);

function setup(initial: AgentSettings = CLAUDE) {
  const home = mkdtempSync("/tmp/ld-first-look-");
  const log = new EventLog(home);
  const live = new LiveSessions();
  const conversations = new Conversations(home, log);
  const transcripts = new TranscriptStore(home);
  const cellId = ulid();
  let settings = initial;
  const keys: KeydRecord[] = [
    { id: "anthropic", kind: "llm", provider: "anthropic", createdAt: AT, updatedAt: AT },
  ];
  // What the quick model says next, and each question it was asked.
  let answer: (prompt: string) => Promise<string> = async () => reply({ title: "Named" });
  const asked: { model: string; options?: ModelOptions; system: string; prompt: string }[] = [];
  const claudeAnswer = vi.fn((quick: { model: string; options?: ModelOptions }) => {
    return async (system: string, prompt: string) => {
      asked.push({ ...quick, system, prompt });
      return { text: await answer(prompt), inputTokens: 120, outputTokens: 9 };
    };
  });
  const quickModel = vi.fn(async (role: ResolvedRole, system: string, prompt: string) => {
    asked.push({ model: role.model.id, system, prompt });
    return answer(prompt);
  });
  // The order things happened in, and the dot each agent start worked as.
  const order: string[] = [];
  const installSkills = vi.fn(async (_cell: string, _signal: AbortSignal, persona?: string) => {
    order.push(`skills:${persona ?? "everyday"}`);
    return [];
  });
  let hold = false;
  const runs: { resume: boolean; role?: string }[] = [];
  const run = vi.fn(async (session: AgentSession, input: { resume: boolean }) => {
    const generation = session.beginBrain();
    session.setStatus("running");
    order.push("agent");
    runs.push({ resume: input.resume, role: runner.roleOf(session.id) });
    try {
      if (hold) {
        await new Promise<void>((resolve) =>
          generation.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return 1;
      }
      // The agent takes the messages it was sent, so the task then waits for the next one.
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
  const boots: BootConfig[] = [];
  const brains = {
    open: async (o: OpenBrain): Promise<BrainCell> => ({
      id: ulid(),
      sessionId: o.sessionId,
      keydPort: 4791,
      home: "test",
      names: { internalNetwork: "i", egressNetwork: "e", gate: "g", brain: "b" },
      gateInternalIp: "172.30.4.10",
      gateEgressIp: "172.30.5.10",
      brainIp: "172.30.4.11",
      proxyUrl: "http://172.30.4.10:3128",
      proxyToken: "p".repeat(43),
      toolToken: "t".repeat(43),
      surrogates: { anthropic: `ld_llm_${"0".repeat(22)}_abcdef` },
    }),
    start: async (brain: BrainCell) => {
      order.push("agent");
      const boot = runner.get(brain.sessionId)?.boot;
      if (boot) boots.push(structuredClone(boot));
    },
    exited: async () => 0,
    close: async () => {},
  };
  // Auto's wait ends when the test says.
  const waits: (() => void)[] = [];
  const sleep = (_ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      waits.push(resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const runner = new AgentRunner({
    home,
    eventLog: log,
    live,
    cell: (id) =>
      id === cellId
        ? { id, state: "ready", scale: 1, createdAt: AT, stream: NO_STREAM }
        : undefined,
    brains,
    keyd: {
      secrets: async () => keys,
      beginTask: async () => {},
      ...fixtureModelAdmission(brains),
    },
    keydHealth: () => ({ online: true, bootId: "boot" }),
    settings: () => settings,
    catalog: () => normalizeCatalog(MODELS_DEV_FIXTURE, AT),
    memory: new MemoryStore(home),
    transcripts,
    conversations,
    installSkills,
    waitForUploads: async () => {},
    stopSession: async (id) => {
      live.stop(id);
      return { revoked: true, paused: true, closed: false, stopped: false, errors: [] };
    },
    sleep,
    idleMs: 60_000,
    claudeCode: {
      driver: { run },
      status: async () => ({ state: "signed_in" }),
      answer: claudeAnswer,
    },
    quickModel,
  });
  fixtures.push({ runner, log, home });
  const events = (id: string, type: LocalDotEvent["type"]) =>
    log.read(id).filter((event) => event.type === type);
  return {
    log,
    live,
    cellId,
    runner,
    conversations,
    claudeAnswer,
    quickModel,
    installSkills,
    run,
    runs,
    boots,
    order,
    asked,
    waits,
    events,
    titles: (id: string) => events(id, "session.title").map((event) => event.data),
    choices: (id: string) => events(id, "persona.choice").map((event) => event.data),
    answer(next: (prompt: string) => Promise<string>) {
      answer = next;
    },
    hold(value: boolean) {
      hold = value;
    },
    setSettings(value: AgentSettings) {
      settings = value;
    },
    async end(session: AgentSession) {
      await until(() => session.status === "idle");
      await runner.release(undefined, session.id);
    },
  };
}

describe("a new conversation's name", () => {
  it("comes from one quick call beside the task, which never waits for it", async () => {
    const f = setup();
    const named = deferred<string>();
    f.answer(() => named.promise);
    const session = await f.runner.start(f.cellId, "Plan three autumn days in Kyoto");
    await until(() => f.run.mock.calls.length === 1);
    expect(f.titles(session.id)).toEqual([]);
    named.resolve(reply({ title: "Kyoto autumn trip." }));
    await until(() => f.titles(session.id).length === 1);
    expect(f.titles(session.id)).toEqual([{ title: "Kyoto autumn trip", by: "auto" }]);
    // The main model on the plan, at its least thinking, asked once and counted.
    expect(f.claudeAnswer.mock.calls).toEqual([
      [{ model: "opus", options: { reasoningEffort: "low" } }],
    ]);
    expect(f.asked[0]?.system).not.toContain('"dot"');
    expect(f.events(session.id, "model.usage").map((event) => event.data)).toContainEqual({
      role: "main",
      route: "claude-code",
      model: "opus",
      inputTokens: 120,
      outputTokens: 9,
    });
    expect(f.conversations.list().conversations[0]?.title).toBe("Kyoto autumn trip");
    session.post("followup", "Add a day in Nara");
    await until(() => f.run.mock.calls.length === 2);
    expect(f.asked).toHaveLength(1);
    session.stop();
    await f.live.settled(session.id);
  });

  it("asks the fast model when there is one", async () => {
    const f = setup({
      main: { provider: "claude-code", model: "opus" },
      fast: { provider: "claude-code", model: "haiku" },
    });
    const session = await f.runner.start(f.cellId, "Fix the login bug");
    await until(() => f.titles(session.id).length === 1);
    expect(f.claudeAnswer).toHaveBeenCalledWith({ model: "haiku" });
    session.stop();
    await f.live.settled(session.id);
  });

  it("is the first message when the quick model fails or says nothing usable", async () => {
    for (const fail of [
      () => Promise.reject(new Error("offline")),
      async () => "I can't help with that.",
    ]) {
      const f = setup();
      f.answer(fail);
      const session = await f.runner.start(f.cellId, "Sort my receipts");
      await until(() => f.asked.length === 1 && session.status === "idle");
      await new Promise<void>((r) => setImmediate(r));
      expect(f.titles(session.id)).toEqual([]);
      expect(f.conversations.list().conversations[0]?.title).toBe("Sort my receipts");
      session.stop();
      await f.live.settled(session.id);
    }
  });

  it("carries over to a task that continues the conversation, which asks nothing", async () => {
    const f = setup();
    const first = await f.runner.start(f.cellId, "Plan three autumn days in Kyoto");
    await until(() => f.titles(first.id).length === 1);
    await f.end(first);
    const next = await f.runner.start(f.cellId, "Now add a day in Nara");
    expect(f.events(next.id, "session.start")[0]?.data).toMatchObject({
      title: "Named",
      continues: first.id,
    });
    expect(f.asked).toHaveLength(1);
    expect(f.conversations.list().conversations).toHaveLength(1);
    expect(f.conversations.list().conversations[0]?.title).toBe("Named");
    next.stop();
    await f.live.settled(next.id);
  });

  it("is the user's once they rename it, for the tasks and the time on the computer after", async () => {
    const f = setup();
    const first = await f.runner.start(f.cellId, "Plan three autumn days in Kyoto");
    await until(() => f.titles(first.id).length === 1);
    f.log.append(first.id, {
      agent: "main",
      type: "session.title",
      data: { title: "Mum's trip", by: "user" },
    });
    await f.end(first);
    const next = await f.runner.start(f.cellId, "Now add a day in Nara");
    expect(f.events(next.id, "session.start")[0]?.data).toMatchObject({ title: "Named" });
    expect(f.titles(next.id)).toEqual([{ title: "Mum's trip", by: "user" }]);
    expect(f.conversations.list().conversations[0]?.title).toBe("Mum's trip");
    await f.end(next);
    const held = await f.runner.hold(f.cellId);
    expect(f.events(held.sessionId, "session.start")[0]?.data).toMatchObject({
      title: "Mum's trip",
    });
    expect(f.titles(held.sessionId)).toEqual([]);
    expect(f.log.sessionInfo([held.sessionId]).get(held.sessionId)?.title).toBe(
      "You used the computer",
    );
  });

  it("never comes from a ChatGPT plan, whose one Codex process is the task's", async () => {
    const f = setup({ main: { provider: "chatgpt", model: "gpt-6-astra" } });
    expect(f.quickModel).not.toHaveBeenCalled();
    expect(f.claudeAnswer).not.toHaveBeenCalled();
  });

  it("asks a fast model billed per token through the daemon's own listener", async () => {
    const f = setup({
      main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
      fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001", key: "anthropic" },
    });
    const session = await f.runner.start(f.cellId, "Fix the login bug");
    await until(() => f.titles(session.id).length === 1);
    expect(f.quickModel).toHaveBeenCalledOnce();
    expect(f.quickModel.mock.calls[0]?.[0]).toMatchObject({ role: "fast", keyId: "anthropic" });
    session.stop();
    await f.live.settled(session.id);
  });
});

describe("Auto's dot", () => {
  const auto: AgentSettings = { ...CLAUDE, persona: "finance", autoPersona: true };

  it("is picked before the agent starts, so its skills and role apply from the first request", async () => {
    const f = setup(auto);
    const picked = deferred<string>();
    f.answer(() => picked.promise);
    const session = await f.runner.start(f.cellId, "Fix the failing test in the repo");
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(f.order).toEqual([]);
    picked.resolve(reply({ title: "Failing test fix", dot: "coder", reason: "Code work" }));
    await until(() => f.runs.length === 1);
    expect(f.order).toEqual(["skills:coder", "agent"]);
    expect(f.runs[0]?.role).toBe(PERSONAS.coder.guidance);
    expect(f.choices(session.id)).toEqual([{ persona: "coder", by: "auto", reason: "Code work" }]);
    expect(f.asked[0]?.system).toContain("- coder: Builds, fixes and ships software");
    expect(f.titles(session.id)).toEqual([{ title: "Failing test fix", by: "auto" }]);
    session.stop();
    await f.live.settled(session.id);
  });

  it("gives way to the default dot when no answer comes in time, and the name still comes", async () => {
    const f = setup(auto);
    const late = deferred<string>();
    f.answer(() => late.promise);
    const session = await f.runner.start(f.cellId, "Fix the failing test");
    await until(() => f.waits.length === 1);
    f.waits[0]?.();
    await until(() => f.runs.length === 1);
    expect(f.order).toEqual(["skills:finance", "agent"]);
    expect(f.choices(session.id)).toEqual([{ persona: "finance", by: "default" }]);
    session.append("message.assistant", { messageId: ulid(), text: "Looking at the test." });
    late.resolve(reply({ title: "Failing test fix", dot: "coder" }));
    await until(() => f.titles(session.id).length === 1);
    // dot has spoken as Finance: a pick this late changes nothing.
    expect(f.runner.roleOf(session.id)).toBe(PERSONAS.finance.guidance);
    expect(f.choices(session.id)).toEqual([{ persona: "finance", by: "default" }]);
    session.stop();
    await f.live.settled(session.id);
  });

  it("still switches to a late pick before dot's first word or action, from its history", async () => {
    const f = setup(auto);
    const late = deferred<string>();
    f.answer(() => late.promise);
    f.hold(true);
    const session = await f.runner.start(f.cellId, "Fix the failing test");
    await until(() => f.waits.length === 1);
    f.waits[0]?.();
    await until(() => f.runs.length === 1);
    f.hold(false);
    late.resolve(reply({ title: "Failing test fix", dot: "coder", reason: "Code work" }));
    await until(() => f.runs.length === 2);
    expect(f.runs).toEqual([
      { resume: false, role: PERSONAS.finance.guidance },
      { resume: true, role: PERSONAS.coder.guidance },
    ]);
    expect(f.order).toEqual(["skills:finance", "agent", "skills:coder", "agent"]);
    expect(f.choices(session.id)).toEqual([
      { persona: "finance", by: "default" },
      { persona: "coder", by: "auto", reason: "Code work" },
    ]);
    session.stop();
    await f.live.settled(session.id);
  });

  it("records a late pick of the default dot without restarting the agent", async () => {
    const f = setup(auto);
    const late = deferred<string>();
    f.answer(() => late.promise);
    f.hold(true);
    const session = await f.runner.start(f.cellId, "Reconcile the Q3 ledger");
    await until(() => f.waits.length === 1);
    f.waits[0]?.();
    await until(() => f.runs.length === 1);
    late.resolve(reply({ title: "Q3 ledger", dot: "finance", reason: "Numbers" }));
    await until(() => f.choices(session.id).length === 2);
    expect(f.choices(session.id).at(-1)).toEqual({
      persona: "finance",
      by: "auto",
      reason: "Numbers",
    });
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(f.runs).toHaveLength(1);
    session.stop();
    await f.live.settled(session.id);
  });

  it("keeps the user's own switch over a pick that comes after it", async () => {
    const f = setup(auto);
    const late = deferred<string>();
    f.answer(() => late.promise);
    f.hold(true);
    const session = await f.runner.start(f.cellId, "Draw a logo");
    await until(() => f.waits.length === 1);
    f.waits[0]?.();
    await until(() => f.runs.length === 1);
    f.runner.switchPersona(session.id, "design");
    await until(() => f.runs.length === 2);
    late.resolve(reply({ title: "Logo", dot: "coder" }));
    await until(() => f.titles(session.id).length === 1);
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(f.runner.roleOf(session.id)).toBe(PERSONAS.design.guidance);
    expect(f.choices(session.id).at(-1)).toEqual({ persona: "design", by: "user" });
    expect(f.runs).toHaveLength(2);
    session.stop();
    await f.live.settled(session.id);
  });

  it("stays with the conversation: a task that continues it keeps the dot without asking", async () => {
    const f = setup(auto);
    f.answer(async () => reply({ title: "Pitch deck", dot: "design", reason: "Slides" }));
    const first = await f.runner.start(f.cellId, "Make a pitch deck");
    await f.end(first);
    const next = await f.runner.start(f.cellId, "Make the cover darker");
    await until(() => f.runs.length === 2);
    expect(f.order).toEqual(["skills:design", "agent", "skills:design", "agent"]);
    expect(f.asked).toHaveLength(1);
    expect(f.choices(next.id)).toEqual([]);
    next.stop();
    await f.live.settled(next.id);
  });

  it("is picked for a task billed per token before its brain boots", async () => {
    const f = setup({
      main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
      autoPersona: true,
    });
    f.answer(async () => reply({ title: "Q3 budget model", dot: "finance", reason: "Numbers" }));
    const session = await f.runner.start(f.cellId, "Build a Q3 budget model");
    await until(() => f.boots.length === 1);
    expect(f.quickModel.mock.calls[0]?.[0]).toMatchObject({ role: "main" });
    expect(f.order).toEqual(["skills:finance", "agent"]);
    expect(f.boots[0]?.role).toBe(PERSONAS.finance.guidance);
    session.stop();
    await f.live.settled(session.id);
  });

  it("can be switched for the task: the agent carries on as the new dot, from its history", async () => {
    const f = setup(auto);
    f.answer(async () => reply({ title: "Logo", dot: "coder", reason: "Code" }));
    f.hold(true);
    const session = await f.runner.start(f.cellId, "Draw a logo");
    await until(() => f.runs.length === 1);
    f.hold(false);
    f.runner.switchPersona(session.id, "design");
    await until(() => f.runs.length === 2);
    expect(f.runs).toEqual([
      { resume: false, role: PERSONAS.coder.guidance },
      { resume: true, role: PERSONAS.design.guidance },
    ]);
    expect(f.order).toEqual(["skills:coder", "agent", "skills:design", "agent"]);
    expect(f.choices(session.id).at(-1)).toEqual({ persona: "design", by: "user" });
    // The same dot again changes nothing.
    f.runner.switchPersona(session.id, "design");
    expect(f.choices(session.id)).toHaveLength(2);
    session.stop();
    await f.live.settled(session.id);
    expect(() => f.runner.switchPersona(session.id, "coder")).toThrow("This task has ended.");
  });

  it("is not asked for when Auto is off: the chosen dot works the task", async () => {
    const f = setup({ ...CLAUDE, persona: "research" });
    const session = await f.runner.start(f.cellId, "Compare three laptops");
    await until(() => f.runs.length === 1);
    expect(f.asked[0]?.system).not.toContain('"dot"');
    expect(f.order).toEqual(["skills:research", "agent"]);
    expect(f.choices(session.id)).toEqual([]);
    session.stop();
    await f.live.settled(session.id);
  });
});
