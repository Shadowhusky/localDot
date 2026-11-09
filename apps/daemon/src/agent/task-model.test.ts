import { mkdtempSync, rmSync } from "node:fs";
import { type KeydRecord, type LocalDotEvent, type TaskModelRef, ulid } from "@localdot/protocol";
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
import { type AgentSettings, SettingsStore } from "./settings.ts";
import { fixtureModelAdmission } from "./testing/model-admission.ts";
import { TranscriptStore } from "./transcript.ts";

const AT = "2026-11-01T00:00:00Z";
const SONNET = { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" };
const HAIKU = { provider: "anthropic", model: "claude-haiku-4-5-20251001", key: "anthropic" };
const OPUS = { provider: "anthropic", model: "claude-opus-5-5", key: "anthropic" };
const fixtures: { runner: AgentRunner; log: EventLog; home: string }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.runner.close();
    f.log.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});
async function until(predicate: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("fixture did not reach its state");
}

function setup(initial: AgentSettings = { main: SONNET, models: [HAIKU, OPUS] }) {
  const home = mkdtempSync("/tmp/ld-task-model-");
  const log = new EventLog(home);
  const live = new LiveSessions();
  const conversations = new Conversations(home, log);
  const transcripts = new TranscriptStore(home);
  const cellId = ulid();
  let settings = initial;
  const keys: KeydRecord[] = [
    { id: "anthropic", kind: "llm", provider: "anthropic", createdAt: AT, updatedAt: AT },
  ];
  const opened: OpenBrain[] = [];
  const boots: { main: string; resume: boolean }[] = [];
  // Each model a brain works on until the test lets it finish.
  let exits = Promise.withResolvers<number>();
  let holding = false;
  const brains = {
    open: async (o: OpenBrain): Promise<BrainCell> => {
      opened.push(o);
      return {
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
      };
    },
    start: async (brain: BrainCell) => {
      const boot = runner.get(brain.sessionId)?.boot;
      if (boot) boots.push({ main: boot.models.main.model, resume: boot.resume });
    },
    exited: async (_brain: BrainCell, signal: AbortSignal) => {
      if (holding)
        return Promise.race([
          exits.promise,
          new Promise<number>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
        ]);
      const session = runner.get(_brain.sessionId);
      if (session) {
        const generation = session.generation;
        if (generation) {
          const inbox = await session.inbox(session.delivered, 0, generation.signal, generation);
          const after = inbox.items.at(-1)?.seq;
          if (after !== undefined)
            session.appendTranscript(transcripts, generation, {
              messages: inbox.items
                .filter((item) => item.kind !== "resume")
                .map((item) => ({
                  role: "user" as const,
                  content: item.text,
                  sourceInbox: { seq: item.seq, messageId: item.messageId },
                })),
              inboxAfter: after,
            });
        }
      }
      return 0;
    },
    close: async () => {},
  };
  const answers = new Map<string, () => Promise<string>>();
  const quickModel = vi.fn(async (role: ResolvedRole) => {
    const answer = answers.get(role.model.id);
    return answer ? answer() : `from ${role.model.id}`;
  });
  const claudeRuns: { model: string; resume: boolean }[] = [];
  const claudeRun = vi.fn(
    async (session: AgentSession, input: { model: string; resume: boolean }) => {
      claudeRuns.push({ model: input.model, resume: input.resume });
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
    },
  );
  const answer = vi.fn((quick: { model: string }) => async () => ({
    text: `from ${quick.model}`,
    inputTokens: 1,
    outputTokens: 1,
  }));
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
    installSkills: async () => [],
    waitForUploads: async () => {},
    stopSession: async (id) => {
      live.stop(id);
      return { revoked: true, paused: true, closed: false, stopped: false, errors: [] };
    },
    sleep: () => new Promise(() => {}),
    idleMs: 60_000,
    claudeCode: {
      driver: { run: claudeRun },
      status: async () => ({ state: "signed_in" }),
      answer,
    },
    quickModel,
  });
  fixtures.push({ runner, log, home });
  return {
    home,
    log,
    live,
    runner,
    cellId,
    conversations,
    transcripts,
    opened,
    boots,
    quickModel,
    claudeRuns,
    answer,
    answers,
    settings: () => settings,
    setSettings(next: AgentSettings) {
      settings = next;
    },
    hold(on: boolean) {
      holding = on;
      if (on) exits = Promise.withResolvers<number>();
    },
    finish() {
      exits.resolve(0);
    },
    events: <T extends LocalDotEvent["type"]>(id: string, type: T) =>
      log.read(id).filter((event) => event.type === type) as Extract<LocalDotEvent, { type: T }>[],
  };
}
const idle = (session: AgentSession) => until(() => session.status === "idle");

describe("a task's own model", () => {
  it("runs a new task on the model chosen for it, and leaves Settings the default", async () => {
    const f = setup();
    const session = await f.runner.start(f.cellId, "First", undefined, {
      model: { provider: OPUS.provider, model: OPUS.model, key: OPUS.key },
    });
    await idle(session);
    expect(f.boots.at(-1)?.main).toBe(OPUS.model);
    expect(f.settings().main).toEqual(SONNET);
    expect(f.runner.taskModel(session.id)).toMatchObject({ model: OPUS.model });
    expect(f.events(session.id, "message.user")[0]?.data).toMatchObject({
      model: { provider: "anthropic", model: OPUS.model },
    });
    const other = await f.runner.start(f.cellId, "Another task", undefined, { continues: null });
    await idle(other);
    expect(f.boots.at(-1)?.main).toBe(SONNET.model);
  });

  it("remembers a choice for the conversation's next task, whatever Settings says by then", async () => {
    const f = setup();
    const first = await f.runner.start(f.cellId, "First");
    await idle(first);
    f.runner.chooseTaskModel(first.id, { ...HAIKU });
    // A new daemon reads it from the task's record.
    expect(new Conversations(f.home, f.log).model(first.id)).toMatchObject({
      model: HAIKU.model,
    });
    f.setSettings({ main: OPUS, models: [HAIKU, SONNET] });
    const next = await f.runner.start(f.cellId, "Next", undefined, { continues: first.id });
    await idle(next);
    expect(f.boots.at(-1)?.main).toBe(HAIKU.model);
    expect(f.runner.taskModel(next.id)).toMatchObject({ model: HAIKU.model });
  });

  it("starts an older conversation with no choice on the default", async () => {
    const f = setup();
    const first = await f.runner.start(f.cellId, "First");
    await idle(first);
    rmSync(`${f.home}/sessions/${first.id}/model.json`);
    f.setSettings({ main: OPUS });
    const next = await f.runner.start(f.cellId, "Next", undefined, { continues: first.id });
    await idle(next);
    expect(f.boots.at(-1)?.main).toBe(OPUS.model);
  });

  it("refuses a model the user hasn't added", async () => {
    const f = setup();
    await expect(
      f.runner.start(f.cellId, "First", undefined, {
        model: { provider: "openai", model: "gpt-6.1-sol", key: "other" },
      }),
    ).rejects.toThrow("Add this model under Settings first.");
  });
});

describe("a message's model", () => {
  it("runs a follow-up at rest on its model, in place, with the task's history", async () => {
    const f = setup();
    const session = await f.runner.start(f.cellId, "First");
    await idle(session);
    const turn = await f.runner.messageTurn(session.id, { ...OPUS });
    session.enqueue("Now this", undefined, turn);
    await until(() => f.boots.length === 2);
    expect(f.boots).toEqual([
      { main: SONNET.model, resume: false },
      { main: OPUS.model, resume: true },
    ]);
    expect(f.runner.get(session.id)).toBe(session);
    expect(f.opened[0]?.account).toBe(session.id);
    expect(f.opened[1]?.account).not.toBe(session.id);
    expect(f.opened[1]?.pricing).not.toEqual(f.opened[0]?.pricing);
    expect(
      f.transcripts.read(session.id).filter((m) => typeof m.content === "object" && m.content),
    ).toEqual([{ role: "user", content: { type: "localdot-model-switch" } }]);
    expect(f.events(session.id, "message.user").at(-1)?.data).toMatchObject({
      text: "Now this",
      model: { model: OPUS.model },
    });
    await idle(session);
    expect(f.runner.selectionOf(session.id)).toMatchObject({
      roles: [{ role: "main", model: OPUS.model }],
    });
  });

  it("the model card moves a stalled task to the chosen model, in place, with its history", async () => {
    const f = setup();
    const session = await f.runner.start(f.cellId, "First");
    await idle(session);
    session.setStatus("paused");
    session.append("agent.state", { state: "paused", reason: "model refused", detail: "400: No" });
    expect(session.openBlockers).toHaveLength(1);
    await f.runner.retryOnModel(session.id, { ...OPUS });
    expect(session.openBlockers).toEqual([]);
    expect(f.events(session.id, "blocker.clear").at(-1)?.data).toMatchObject({
      outcome: "fixed",
      movedTo: { provider: OPUS.provider, model: OPUS.model },
    });
    expect(f.runner.get(session.id)).toBe(session);
    expect(session.stopped).toBe(false);
  });

  it("the model card's same model retries it, and holds until the model answers", async () => {
    const f = setup();
    const session = await f.runner.start(f.cellId, "First");
    await idle(session);
    session.setStatus("paused");
    session.append("agent.state", { state: "paused", reason: "model unavailable" });
    const seq = session.inboxSequence;
    await f.runner.retryOnModel(session.id, { ...SONNET });
    expect(session.inboxSequence).toBe(seq + 1);
    expect(session.openBlockers).toHaveLength(1);
    expect(f.events(session.id, "blocker.clear")).toEqual([]);
  });

  it("the model card hands over to the conversation's next task for another kind of model", async () => {
    const f = setup();
    const session = await f.runner.start(f.cellId, "First");
    await idle(session);
    session.setStatus("paused");
    session.append("agent.state", { state: "paused", reason: "provider limit reached" });
    const start = vi.spyOn(f.runner, "start").mockImplementation(async () => session);
    const turn = vi.spyOn(f.runner, "messageTurn").mockResolvedValue({
      model: { provider: "chatgpt", model: "gpt-6-sol" },
      ref: { provider: "chatgpt", model: "gpt-6-sol" },
      moves: () => true,
      reached: () => {},
      handOver: () => {},
    });
    await f.runner.retryOnModel(session.id, { provider: "chatgpt", model: "gpt-6-sol" });
    expect(start).toHaveBeenCalledWith(
      f.cellId,
      "Continue where you left off.",
      undefined,
      expect.objectContaining({
        continues: session.id,
        model: { provider: "chatgpt", model: "gpt-6-sol" },
      }),
    );
    start.mockRejectedValueOnce(new Error("no"));
    session.append("agent.state", { state: "paused", reason: "provider limit reached" });
    await expect(
      f.runner.retryOnModel(session.id, { provider: "chatgpt", model: "gpt-6-sol" }),
    ).rejects.toThrow("no");
    expect(session.openBlockers).toHaveLength(1);
    turn.mockRestore();
    start.mockRestore();
  });

  it("keeps going on the same model without restarting anything extra", async () => {
    const f = setup();
    const session = await f.runner.start(f.cellId, "First");
    await idle(session);
    session.enqueue("More", undefined, await f.runner.messageTurn(session.id, { ...SONNET }));
    await until(() => f.boots.length === 2);
    expect(f.opened[1]?.account).toBe(session.id);
    expect(f.transcripts.read(session.id).some((m) => typeof m.content === "object")).toBe(false);
  });

  it("takes a working task to the model of a message sent while it works", async () => {
    const f = setup();
    f.hold(true);
    const session = await f.runner.start(f.cellId, "First");
    await until(() => f.boots.length === 1);
    const turn = await f.runner.messageTurn(session.id, { ...OPUS });
    session.post("steer", "Change of plan", undefined, turn);
    await until(() => f.boots.length === 2);
    expect(f.boots[1]).toEqual({ main: OPUS.model, resume: true });
  });

  it("says whether a message would take a working task off its model", async () => {
    const f = setup();
    f.hold(true);
    const session = await f.runner.start(f.cellId, "First");
    await until(() => f.boots.length === 1);
    const moves = async (ref: TaskModelRef) =>
      (await f.runner.messageTurn(session.id, ref))?.moves();
    expect(await moves({ ...SONNET })).toBe(false);
    expect(await moves({ ...OPUS })).toBe(true);
    expect(await moves({ provider: "claude-code", model: "opus" })).toBe(true);
  });

  it("keeps a message for another model queued through dot's long wait, and those behind it", async () => {
    const f = setup();
    f.hold(true);
    const session = await f.runner.start(f.cellId, "First");
    await until(() => f.boots.length === 1);
    session.enqueue("For Opus", undefined, await f.runner.messageTurn(session.id, { ...OPUS }));
    session.enqueue("For Sonnet", undefined, await f.runner.messageTurn(session.id, { ...SONNET }));
    const wait = session.listenForUser(new AbortController().signal, true);
    expect(wait.spoke).toBe(false);
    expect(wait.queued).toBe(false);
    expect(session.generation).toBeDefined();
    expect(f.boots).toHaveLength(1);
    expect(f.events(session.id, "message.delivery")).toEqual([]);
    wait.end();
  });

  it("runs a queued message on the model chosen when it was queued, one model to a turn", async () => {
    const f = setup();
    f.hold(true);
    const session = await f.runner.start(f.cellId, "First");
    await until(() => f.boots.length === 1);
    session.enqueue("For Opus", undefined, await f.runner.messageTurn(session.id, { ...OPUS }));
    session.enqueue("For Haiku", undefined, await f.runner.messageTurn(session.id, { ...HAIKU }));
    // Nothing changes under the task at work.
    expect(f.boots).toHaveLength(1);
    expect(f.events(session.id, "message.user").at(-1)?.data).toMatchObject({
      queued: true,
      model: { model: HAIKU.model },
    });
    f.hold(false);
    f.finish();
    await until(() => f.boots.length === 3);
    expect(f.boots.map((boot) => boot.main)).toEqual([SONNET.model, OPUS.model, HAIKU.model]);
    // A later message waits its turn and can't jump the queue.
    const sent = f.events(session.id, "message.delivery").map((event) => event.data.state);
    expect(sent).toEqual(["sent", "sent"]);
  });

  it("opens each model's spending with what the task's limit has left", async () => {
    const f = setup({ main: SONNET, models: [OPUS], taskBudgetUSD: 5 });
    const session = await f.runner.start(f.cellId, "First");
    await idle(session);
    f.log.append(session.id, {
      type: "model.spend",
      agent: "keyd",
      data: {
        route: "anthropic",
        model: SONNET.model,
        costUSD: 2,
        basis: "billed",
        taskSpentUSD: 2,
        daySpentUSD: 2,
        taskLimitUSD: 5,
      },
    } as never);
    session.enqueue("Now this", undefined, await f.runner.messageTurn(session.id, { ...OPUS }));
    await until(() => f.boots.length === 2);
    expect(f.opened[0]?.budgetUSD).toBe(5);
    expect(f.opened[1]?.budgetUSD).toBe(3);
    expect(f.runner.accountOf(session.id)).toEqual({ id: f.opened[1]?.account, spentBefore: 2 });
  });

  it("leaves a model that can't run where it is, and says why, before taking the message", async () => {
    const f = setup({ main: SONNET, models: [{ ...OPUS, key: "gone" }] });
    const session = await f.runner.start(f.cellId, "First");
    await idle(session);
    await expect(f.runner.messageTurn(session.id, { ...OPUS, key: "gone" })).rejects.toThrow(
      "needs a key",
    );
    expect(f.runner.selectionOf(session.id)).toMatchObject({ roles: [{ model: SONNET.model }] });
  });

  it("moves to another runtime as a new task of the conversation, told what was said", async () => {
    const f = setup();
    f.hold(true);
    const session = await f.runner.start(f.cellId, "First");
    await until(() => f.boots.length === 1);
    const ref = { provider: "claude-code", model: "opus" };
    session.enqueue("On Claude Code", undefined, await f.runner.messageTurn(session.id, ref));
    session.enqueue("And this", undefined, await f.runner.messageTurn(session.id, ref));
    expect(f.claudeRuns).toEqual([]);
    f.hold(false);
    f.finish();
    await until(() => f.claudeRuns.length > 0);
    const next = f.conversations.current();
    expect(next).not.toBe(session.id);
    expect(f.claudeRuns[0]).toEqual({ model: "opus", resume: false });
    const nextId = next as string;
    expect(f.log.read(nextId).find((e) => e.type === "session.start")?.data).toMatchObject({
      continues: session.id,
    });
    expect(f.runner.get(nextId)?.earlier.join("\n")).toContain("The user: First");
    expect(f.events(nextId, "message.user")[0]?.data).toMatchObject({ text: "On Claude Code" });
    // What moved left the old task's thread, and nothing was said twice.
    expect(f.events(session.id, "message.delivery").map((event) => event.data.state)).toEqual([
      "withdrawn",
      "withdrawn",
    ]);
    await until(() => f.events(nextId, "message.user").length === 2);
    expect(f.events(nextId, "message.user")[1]?.data).toMatchObject({ text: "And this" });
  });

  it("stays on the model at hand, and says so, when another runtime can't start", async () => {
    const f = setup();
    f.hold(true);
    const session = await f.runner.start(f.cellId, "First");
    await until(() => f.boots.length === 1);
    const turn = await f.runner.messageTurn(session.id, { provider: "claude-code", model: "opus" });
    session.enqueue("On Claude Code", undefined, turn);
    (f.runner as unknown as { start: () => Promise<never> }).start = () =>
      Promise.reject(new Error("no"));
    f.hold(false);
    f.finish();
    await until(() => f.events(session.id, "message.assistant").length > 0);
    expect(f.events(session.id, "message.assistant")[0]?.data.text).toContain(
      "I couldn't move to the model you chose",
    );
    expect(f.events(session.id, "message.user").at(-1)?.data).toMatchObject({
      text: "On Claude Code",
    });
  });
});

describe("what steps record", () => {
  it("names the model running when each step started, as a fallback changes it too", async () => {
    const f = setup();
    f.hold(true);
    const session = await f.runner.start(f.cellId, "First");
    await until(() => f.boots.length === 1);
    session.append("step.start", { kind: "think" }, "s1");
    session.append("model.usage", {
      role: "local",
      route: "ollama",
      model: "qwen",
      inputTokens: 1,
      outputTokens: 1,
    });
    session.append("step.start", { kind: "think" }, "s2");
    expect(f.events(session.id, "step.start").map((event) => event.data.model)).toEqual([
      { route: "anthropic", model: SONNET.model },
      { route: "ollama", model: "qwen" },
    ]);
  });
});

describe("short questions with no tools", () => {
  it("answers on the main model when there is no fast model", async () => {
    const f = setup();
    const session = await f.runner.start(f.cellId, "First");
    await idle(session);
    await expect(
      f.runner.sideAnswer(session.id, "Why?", new AbortController().signal),
    ).resolves.toEqual({
      answer: `from ${SONNET.model}`,
      provider: "anthropic",
      model: SONNET.model,
    });
  });

  it("falls back to the main model when the fast one fails, and tells the real reason", async () => {
    const f = setup({ main: SONNET, fast: HAIKU });
    const { ModelAnswerError } = await import("./safety/judge-model.ts");
    f.answers.set(HAIKU.model, () =>
      Promise.reject(new ModelAnswerError(400, "Input must be a list")),
    );
    const session = await f.runner.start(f.cellId, "First");
    await idle(session);
    await expect(
      f.runner.sideAnswer(session.id, "Why?", new AbortController().signal),
    ).resolves.toEqual({
      answer: `from ${SONNET.model}`,
      provider: "anthropic",
      model: SONNET.model,
      failed: { model: HAIKU.model, reason: "answered 400: Input must be a list" },
    });
  });

  it("says why when no model answers", async () => {
    const f = setup({ main: SONNET, fast: HAIKU });
    const { ModelAnswerError } = await import("./safety/judge-model.ts");
    for (const model of [HAIKU.model, SONNET.model])
      f.answers.set(model, () => Promise.reject(new ModelAnswerError(529, "Overloaded")));
    const session = await f.runner.start(f.cellId, "First");
    await idle(session);
    await expect(
      f.runner.sideAnswer(session.id, "Why?", new AbortController().signal),
    ).rejects.toMatchObject({
      status: 502,
      problem: "no-answer",
      reason: "answered 529: Overloaded",
    });
  });

  it("asks an ended task's model, not the default, through its own listener", async () => {
    const f = setup();
    const session = await f.runner.start(f.cellId, "First", undefined, { model: { ...HAIKU } });
    await idle(session);
    session.stop();
    await f.live.settled(session.id);
    await expect(
      f.runner.sideAnswer(session.id, "Why?", new AbortController().signal),
    ).resolves.toMatchObject({ model: HAIKU.model });
  });

  it("names a new task and picks its dot on the main model when there's no fast model", async () => {
    const f = setup({ main: SONNET, autoPersona: true });
    f.answers.set(SONNET.model, async () => '{"title":"Named by main","dot":"coder"}');
    const session = await f.runner.start(f.cellId, "Fix the build");
    await until(() => f.events(session.id, "session.title").length > 0);
    expect(f.events(session.id, "session.title")[0]?.data).toEqual({
      title: "Named by main",
      by: "auto",
    });
    await until(() => f.events(session.id, "persona.choice").length > 0);
    expect(f.events(session.id, "persona.choice")[0]?.data).toMatchObject({
      persona: "coder",
      by: "auto",
    });
  });

  it("names a new task on the main model when the fast one fails", async () => {
    const f = setup({ main: SONNET, fast: HAIKU, autoPersona: true });
    f.answers.set(HAIKU.model, () => Promise.reject(new Error("refused")));
    f.answers.set(SONNET.model, async () => '{"title":"Named by main","dot":"coder"}');
    const session = await f.runner.start(f.cellId, "Fix the build");
    await until(() => f.events(session.id, "session.title").length > 0);
    expect(f.events(session.id, "persona.choice")[0]?.data).toMatchObject({ by: "auto" });
  });
});

describe("the user's list of models", () => {
  const store = () => new SettingsStore(mkdtempSync("/tmp/ld-settings-"));
  it("keeps what an existing document holds, and a model leaving a role", () => {
    const s = store();
    s.put({ main: SONNET, models: [HAIKU] });
    expect(s.put({ main: OPUS }).models).toEqual([HAIKU, SONNET]);
  });
  it("takes a list sent with the save as the user's own, removals and off switches included", () => {
    const s = store();
    s.put({ main: SONNET, models: [HAIKU, OPUS] });
    const saved = s.put({ main: SONNET, models: [{ ...OPUS, off: true }] });
    expect(saved.models).toEqual([{ ...OPUS, off: true }]);
    expect(s.put({ main: SONNET, models: [] }).models).toBeUndefined();
  });
  it("lists a role's model once, in the role", () => {
    const s = store();
    expect(s.put({ main: SONNET, fast: HAIKU, models: [HAIKU, SONNET] }).models).toBeUndefined();
  });
});
