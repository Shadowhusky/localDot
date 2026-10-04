import { mkdtempSync, rmSync } from "node:fs";
import { CodexLaunchError, type CodexTurnEpoch, RpcError } from "@localdot/codex-harness";
import { parseEvent, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import { TranscriptStore } from "../transcript.ts";
import {
  CODEX_CRASHED,
  CODEX_DONE,
  CODEX_GAVE_UP,
  CodexCleanupError,
  CodexDriver,
  type CodexDriverDeps,
  type DriverEndpointInput,
} from "./driver.ts";
import type { McpCallContext, McpEndpoint } from "./mcp-endpoint.ts";
import { deferred, fakeCodex, until } from "./testing/fake-codex.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC3sAAAAASUVORK5CYII=",
  "base64",
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(
  task = "Find the weather",
  extra: Pick<CodexDriverDeps, "waitForAuthResume" | "heartbeatMs"> = {},
) {
  const home = mkdtempSync("/tmp/ld10-"),
    transcript = new TranscriptStore(home),
    events: { type: string; data: Record<string, unknown> }[] = [];
  const session = new AgentSession(ulid(), ulid(), task, {
    append: (_id, draft) => {
      const event = parseEvent({ v: 1, id: ulid(), seq: events.length, t: 0, ...draft });
      events.push({ type: event.type, data: event.data } as never);
      return event;
    },
  });
  const gates = { endpoint: undefined as Promise<void> | undefined };
  const fake = fakeCodex(),
    endpoints: {
      input: DriverEndpointInput;
      endpoint: McpEndpoint;
      epoch?: CodexTurnEpoch;
      closed: boolean;
    }[] = [];
  const observe = vi.fn(async () => ({
      frameId: ulid(),
      full: true as const,
      png: Buffer.from(PNG),
    })),
    sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
  const deps: CodexDriverDeps = {
    auth: fake.auth,
    transcripts: transcript,
    observe,
    instructions: () => "Only localdot tools.",
    redactorFor: () => redactor(["fake-private-diagnostic"]),
    sleep,
    heartbeatMs: 10,
    ...extra,
    openEndpoint: async (input) => {
      const record = {
        input,
        endpoint: undefined as never as McpEndpoint,
        epoch: undefined as CodexTurnEpoch | undefined,
        closed: false,
      };
      record.endpoint = {
        dir: "/private/tmp/fake-mcp",
        socket: "/private/tmp/fake-mcp/m.sock",
        directory: { path: "/private/tmp/fake-mcp" } as never,
        setTurn(epoch) {
          if (record.closed || record.epoch) throw new Error("fake endpoint cannot be reused");
          record.epoch = epoch;
        },
        retireTurn(epoch) {
          if (record.epoch === epoch) record.epoch = undefined;
        },
        connections: () => 0,
        pauseAtBoundary: async () => {
          throw new Error("This legacy fixture has no native Pause receipt.");
        },
        validatePauseReceipt: () => false,
        close: async () => {
          record.closed = true;
          record.epoch = undefined;
        },
      };
      endpoints.push(record);
      await gates.endpoint;
      return record.endpoint;
    },
  };
  const driver = new CodexDriver(deps),
    running: Promise<number>[] = [];
  const run = (resume = false) => {
    const promise = driver.run(session, { model: "gpt-6-astra", resume });
    running.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  cleanups.push(async () => {
    session.stop();
    for (const promise of running) await promise.catch(() => {});
    rmSync(home, { recursive: true, force: true });
  });
  const context = (index = endpoints.length - 1): McpCallContext => {
    const record = endpoints[index];
    if (!record?.epoch) throw new Error("No active fake tool epoch.");
    return Object.freeze({
      generation: record.input.generation,
      authGeneration: record.input.authGeneration,
      turnEpoch: record.epoch,
      basisFrameId: record.epoch.basisFrameId,
      connection: {},
      requestId: 1,
      signal: AbortSignal.any([record.input.signal, record.epoch.signal]),
    });
  };
  const done = (index = endpoints.length - 1) =>
    endpoints[index]?.input.onResult?.(
      "done",
      { ok: true, final: true, content: [] },
      context(index),
    );
  return {
    session,
    fake,
    endpoints,
    transcript,
    events,
    observe,
    sleep,
    deps,
    driver,
    run,
    context,
    done,
    gates,
  };
}
describe("owned Codex task driver", () => {
  it("submits the full PNG in the explicit turn, keeps its frame ID in daemon metadata, and registers one lease", async () => {
    const f = fixture(),
      run = f.run(),
      conn = await f.fake.nextLaunch(1),
      request = await conn.waitFor("turn/start");
    const frame = await f.observe.mock.results[0]?.value;
    expect(request.params).toMatchObject({
      threadId: conn.threadId,
      input: [
        { type: "text", text: f.session.task },
        { type: "image", url: `data:image/png;base64,${PNG.toString("base64")}` },
      ],
    });
    expect(f.endpoints[0]?.epoch?.basisFrameId).toBe(frame?.frameId);
    expect(JSON.stringify(request.params)).not.toContain(frame?.frameId);
    expect(f.session.tainted).toBe(true);
    f.done();
    expect(await run).toBe(CODEX_DONE);
    expect(conn.stopped).toBe(true);
    expect(f.endpoints[0]?.closed).toBe(true);
    expect(f.fake.maxLeases).toBe(1);
    expect(f.fake.activeLeases).toBe(0);
  });
  it("does not treat a deliberately retired connection as a crash", async () => {
    const f = fixture(),
      run = f.run(),
      first = await f.fake.nextLaunch(1);
    await first.waitFor("turn/start");
    first.complete();
    const second = await f.fake.nextLaunch(2);
    await second.waitFor("turn/start");
    expect(first.stopped).toBe(true);
    f.done();
    expect(await run).toBe(CODEX_DONE);
  });
  it("returns the crash exit code only for an actual unexpected process loss", async () => {
    const f = fixture(),
      run = f.run(),
      conn = await f.fake.nextLaunch(1);
    await conn.waitFor("turn/start");
    conn.crash();
    expect(await run).toBe(CODEX_CRASHED);
    expect(f.fake.launches).toHaveLength(1);
  });
});
describe("Codex conversation and durable input recovery", () => {
  it("initializes once with fixed readonly thread configuration", async () => {
    const f = fixture(),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    await c.waitFor("turn/start");
    expect(c.requests.map((r) => r.method)).toEqual([
      "initialize",
      "account/read",
      "thread/start",
      "turn/start",
    ]);
    expect(c.notifications).toEqual([{ method: "initialized", params: {} }]);
    expect(c.requests.find((r) => r.method === "account/read")?.params).toEqual({
      refreshToken: false,
    });
    expect(c.requests.find((r) => r.method === "thread/start")?.params).toMatchObject({
      model: "gpt-6-astra",
      ephemeral: true,
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    f.done();
    expect(await run).toBe(CODEX_DONE);
  });
  it("nudges once on a fresh connection, then leaves no-result work idle", async () => {
    const f = fixture(),
      run = f.run(),
      first = await f.fake.nextLaunch(1);
    await first.waitFor("turn/start");
    first.complete();
    const second = await f.fake.nextLaunch(2),
      nudge = await second.waitFor("turn/start");
    expect(JSON.stringify(nudge.params)).toContain("call the localdot done tool");
    second.complete();
    expect(await run).toBe(CODEX_GAVE_UP);
    expect(f.events).toContainEqual({
      type: "agent.state",
      data: { state: "idle", reason: "no result" },
    });
    expect(f.fake.launches).toHaveLength(2);
  });
  it("persists and acknowledges a steer before sending it, and queues a follow-up", async () => {
    const f = fixture(),
      run = f.run(),
      first = await f.fake.nextLaunch(1);
    await first.waitFor("turn/start");
    const steer = f.session.post("steer", "cheaper please"),
      followup = f.session.post("followup", "also hotels");
    const request = await first.waitFor("turn/steer");
    expect(f.session.delivered).toBe(followup.seq);
    expect(request.params).toEqual({
      threadId: first.threadId,
      expectedTurnId: first.turnId,
      input: [{ type: "text", text: "cheaper please" }],
    });
    await until(() => f.session.delivered === followup.seq);
    expect(f.transcript.read(f.session.id).filter((m) => m.sourceInbox)).toEqual(
      [steer, followup].map((i) => ({
        role: "user",
        content: i.text,
        sourceInbox: { seq: i.seq, messageId: i.messageId },
      })),
    );
    expect(first.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
    first.complete();
    const second = await f.fake.nextLaunch(2),
      turn = await second.waitFor("turn/start");
    expect(JSON.stringify(turn.params)).toContain("also hotels");
    expect(JSON.stringify(turn.params)).not.toContain(steer.messageId);
    f.done();
    expect(await run).toBe(CODEX_DONE);
  });
  it.each(["refused", "uncertain"])(
    "recovers %s steering from one durable record on a fresh connection",
    async (mode) => {
      const f = fixture(),
        run = f.run(),
        first = await f.fake.nextLaunch(1);
      await first.waitFor("turn/start");
      first.requestHook = (method) =>
        method === "turn/steer"
          ? Promise.reject(
              mode === "refused"
                ? new RpcError("turn/steer", -32602)
                : new Error("fake-private-diagnostic"),
            )
          : undefined;
      const steer = f.session.post("steer", "Keep the window open");
      const second = await f.fake.nextLaunch(2),
        turn = await second.waitFor("turn/start");
      expect(first.stopped).toBe(true);
      expect(JSON.stringify(turn.params)).toContain("Keep the window open");
      expect(JSON.stringify(turn.params)).toContain("previous steering request was not confirmed");
      expect(
        f.transcript.read(f.session.id).filter((m) => m.sourceInbox?.messageId === steer.messageId),
      ).toHaveLength(1);
      f.done();
      expect(await run).toBe(CODEX_DONE);
    },
  );
  it("recovers acknowledged input after an actual crash and carries plan and last safe reply", async () => {
    const f = fixture(),
      run = f.run(),
      first = await f.fake.nextLaunch(1);
    await first.waitFor("turn/start");
    f.session.plan = [{ id: "forecast", text: "Open the forecast", status: "done" }];
    const user = f.session.post("followup", "Check tomorrow too");
    await until(() => f.session.delivered === user.seq);
    first.notify("item/completed", {
      threadId: first.threadId,
      turnId: first.turnId,
      item: { id: "reply", type: "agentMessage", phase: "final_answer", text: "Forecast checked." },
    });
    first.crash();
    expect(await run).toBe(CODEX_CRASHED);
    const resumed = f.run(true),
      second = await f.fake.nextLaunch(2),
      turn = await second.waitFor("turn/start");
    const text = (turn.params as { input: { text?: string }[] }).input[0]?.text;
    expect(text).toContain("[x] Open the forecast");
    expect(text).toContain("Check tomorrow too");
    expect(text).toContain("Forecast checked.");
    expect(text).not.toContain(user.messageId);
    f.done();
    expect(await resumed).toBe(CODEX_DONE);
  });
  it("pauses signed-out work with no live generation, lease, process or screenshot until explicit Resume", async () => {
    const f = fixture();
    f.fake.setSignedIn(false);
    f.session.post("resume", "");
    const run = f.run(),
      first = await f.fake.nextLaunch(1);
    await until(() => f.session.status === "paused");
    expect(first.requests.map((r) => r.method)).toEqual(["initialize", "account/read"]);
    expect(f.session.generation).toBeUndefined();
    expect(f.fake.activeLeases).toBe(0);
    expect(f.observe).not.toHaveBeenCalled();
    f.fake.setSignedIn(true);
    f.session.post("followup", "Now use the new login");
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(f.fake.launches).toHaveLength(1);
    f.session.post("resume", "");
    const second = await f.fake.nextLaunch(2),
      turn = await second.waitFor("turn/start");
    expect(JSON.stringify(turn.params)).toContain("Now use the new login");
    f.done();
    expect(await run).toBe(CODEX_DONE);
  });
  it("stays paused when sign-in is still absent, and Stop wakes its generation-free wait", async () => {
    const f = fixture();
    f.fake.setSignedIn(false);
    const run = f.run();
    await until(() => f.session.status === "paused");
    f.session.post("resume", "");
    await f.fake.nextLaunch(2);
    await until(
      () =>
        f.events.filter((e) => e.type === "agent.state" && e.data.state === "paused").length === 2,
    );
    f.session.stop();
    expect(await run).toBe(CODEX_DONE);
    expect(
      f.fake.launches.every((c) => c.stopped && !c.requests.some((r) => r.method === "turn/start")),
    ).toBe(true);
  });
  it.each(["unauthorized", "usageLimitExceeded"])(
    "retires and pauses a %s turn without fallback or retries",
    async (kind) => {
      const f = fixture(),
        run = f.run(),
        first = await f.fake.nextLaunch(1);
      await first.waitFor("turn/start");
      first.complete("failed", kind);
      await until(() => f.session.status === "paused");
      expect(first.stopped).toBe(true);
      expect(f.fake.launches).toHaveLength(1);
      expect(f.sleep).not.toHaveBeenCalled();
      expect(f.fake.signedOut).toEqual(kind === "unauthorized" ? [1] : []);
      expect(JSON.stringify(f.events)).not.toContain("fake-private-diagnostic");
      f.session.post("resume", "");
      const second = await f.fake.nextLaunch(2);
      await second.waitFor("turn/start");
      expect(second.threadId).not.toBe(first.threadId);
      f.done();
      expect(await run).toBe(CODEX_DONE);
    },
  );
  it("requires explicit Resume after every auth generation change, including a second login", async () => {
    const f = fixture(),
      run = f.run(),
      first = await f.fake.nextLaunch(1);
    await first.waitFor("turn/start");
    for (let generation = 2; generation <= 3; generation++) {
      f.fake.changeAuth();
      await until(() => f.session.status === "paused");
      expect(f.fake.activeLeases).toBe(0);
      expect(f.session.generation).toBeUndefined();
      expect(f.fake.launches).toHaveLength(generation - 1);
      f.session.post("resume", "");
      const c = await f.fake.nextLaunch(generation);
      await c.waitFor("turn/start");
      expect(f.endpoints[generation - 1]?.input.authGeneration).toBe(generation);
    }
    f.done();
    expect(await run).toBe(CODEX_DONE);
    expect(f.fake.maxLeases).toBe(1);
  });
  it("retries transient model failure with 1/2/4 delays, then pauses with no provider change", async () => {
    const f = fixture(),
      run = f.run();
    for (let n = 1; n <= 4; n++) {
      const c = await f.fake.nextLaunch(n);
      await c.waitFor("turn/start");
      c.complete("failed", "serverOverloaded");
    }
    await until(() => f.session.status === "paused");
    expect(f.sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
    expect(f.events.filter((e) => e.type === "model.retry").map((e) => e.data.attempt)).toEqual([
      1, 2, 3,
    ]);
    expect(f.fake.launches.every((c) => JSON.stringify(c.requests).includes("gpt-6-astra"))).toBe(
      true,
    );
    f.session.stop();
    expect(await run).toBe(CODEX_DONE);
  });
});
describe("Codex authority, takeover and retirement", () => {
  it.each(["commandExecution", "fileChange", "webSearch", "foreign"])(
    "ends %s violations without a replacement",
    async (type) => {
      const f = fixture(),
        run = f.run(),
        c = await f.fake.nextLaunch(1);
      await c.waitFor("turn/start");
      c.notify(type === "fileChange" ? "item/completed" : "item/started", {
        threadId: c.threadId,
        turnId: c.turnId,
        item: {
          id: "blocked",
          type: type === "foreign" ? "mcpToolCall" : type,
          ...(type === "fileChange" ? { status: "completed" } : {}),
          ...(type === "foreign" ? { server: "foreign", tool: "x", status: "inProgress" } : {}),
        },
      });
      expect(await run).toBe(CODEX_GAVE_UP);
      expect(f.fake.launches).toHaveLength(1);
      expect(c.stopped).toBe(true);
      expect(f.events.some((e) => e.type === "step.end" && e.data.status === "blocked")).toBe(true);
    },
  );
  it("discourages two sub-agents on fresh owned turns and ends the third", async () => {
    const f = fixture(),
      run = f.run();
    for (let n = 1; n <= 3; n++) {
      const c = await f.fake.nextLaunch(n),
        turn = await c.waitFor("turn/start");
      if (n > 1) expect(JSON.stringify(turn.params)).toContain("Sub-agents are not available here");
      c.notify("item/started", {
        threadId: c.threadId,
        turnId: c.turnId,
        item: { id: "child", type: "subAgentActivity" },
      });
    }
    expect(await run).toBe(CODEX_GAVE_UP);
    expect(f.fake.launches).toHaveLength(3);
  });
  it("applies main-thread current approval provenance and records fixed blocked decisions", async () => {
    const f = fixture(),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    await c.waitFor("turn/start");
    const prompt = (threadId: string) => ({
      threadId,
      turnId: c.turnId,
      serverName: "localdot",
      mode: "form",
      _meta: { codex_approval_kind: "mcp_tool_call" },
      message: "fake-private-diagnostic",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(c.serverRequest("mcpServer/elicitation/request", prompt(c.threadId))).toMatchObject({
      verdict: "approved",
      result: { action: "accept", content: {} },
    });
    expect(c.serverRequest("mcpServer/elicitation/request", prompt("child"))).toMatchObject({
      verdict: "declined",
    });
    expect(
      c.serverRequest("item/fileChange/requestApproval", {
        threadId: c.threadId,
        turnId: c.turnId,
        itemId: "file",
      }),
    ).toMatchObject({ result: { decision: "decline" } });
    expect(f.events.some((e) => e.type === "step.end" && e.data.status === "blocked")).toBe(true);
    expect(JSON.stringify(f.events)).not.toContain("fake-private-diagnostic");
    f.done();
    expect(await run).toBe(CODEX_DONE);
    expect(c.serverRequest("mcpServer/elicitation/request", prompt(c.threadId))).toMatchObject({
      verdict: "declined",
    });
  });
  it("ignores tool completion with an old, missing, aborted or wrong-basis capture", async () => {
    const f = fixture(),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    await c.waitFor("turn/start");
    const context = f.context(),
      result = { ok: true, final: true, content: [] };
    const wrong: McpCallContext[] = [
      { ...context, generation: Object.freeze({ ...context.generation }) },
      { ...context, turnEpoch: Object.freeze({ ...context.turnEpoch }) },
      { ...context, authGeneration: context.authGeneration + 1 },
      { ...context, basisFrameId: ulid() },
      { ...context, signal: AbortSignal.abort() },
      {} as never,
    ];
    for (const capture of wrong) f.endpoints[0]?.input.onResult?.("done", result, capture);
    expect(c.stopped).toBe(false);
    f.done();
    expect(await run).toBe(CODEX_DONE);
  });
  it("finishes the persisted call cap without resetting tool accounting during recovery", async () => {
    const f = fixture();
    f.session.toolCalls = 400;
    const run = f.run(),
      c = await f.fake.nextLaunch(1);
    await c.waitFor("turn/start");
    const message = f.session.post("followup", "This must not bypass the call limit");
    await until(() => f.session.delivered === message.seq);
    f.endpoints[0]?.input.onResult?.(
      "computer",
      { ok: false, final: true, content: [] },
      f.context(),
    );
    expect(await run).toBe(CODEX_DONE);
    expect(f.session.toolCalls).toBe(400);
    expect(c.requests.some((r) => r.method === "turn/interrupt")).toBe(true);
  });
  it("retires a stale screenshot basis and obtains a new full frame without replaying an action", async () => {
    const f = fixture(),
      run = f.run(),
      first = await f.fake.nextLaunch(1);
    await first.waitFor("turn/start");
    const old = f.context();
    f.session.toolCalls = 7;
    f.session.lastFrameId = ulid();
    f.endpoints[0]?.input.onRetire?.("stale");
    expect(old.signal.aborted).toBe(true);
    expect(first.stopped).toBe(true);
    const second = await f.fake.nextLaunch(2),
      turn = await second.waitFor("turn/start");
    expect(f.context().basisFrameId).not.toBe(old.basisFrameId);
    expect(f.context().basisFrameId).toBe((await f.observe.mock.results[1]?.value)?.frameId);
    expect(f.session.toolCalls).toBe(7);
    expect(JSON.stringify(turn.params)).toContain("do not apply the canceled action automatically");
    f.endpoints[0]?.input.onResult?.("done", { ok: true, final: true, content: [] }, old);
    expect(second.stopped).toBe(false);
    f.done();
    expect(await run).toBe(CODEX_DONE);
  });
  it("preserves takeover across connection retirement and suppresses replacement, frames and stale events", async () => {
    const f = fixture("Find the weather", { heartbeatMs: 60_000 }),
      run = f.run(),
      first = await f.fake.nextLaunch(1);
    await first.waitFor("turn/start");
    const old = f.context(),
      waiter = f.session.takeover("login", "Enter it yourself");
    void waiter.catch(() => {});
    // No timer or microtask may run before the model transport and tool epoch are fenced.
    expect(first.stopped).toBe(true);
    expect(old.signal.aborted).toBe(true);
    expect(f.session.generation).toBeUndefined();
    expect(f.endpoints[0]?.closed).toBe(true);
    await until(() => f.session.status === "waiting_user" && first.stopped);
    const requestId = f.session.pendingTakeover;
    expect(requestId).toBeDefined();
    expect(f.session.generation).toBeUndefined();
    expect(f.fake.activeLeases).toBe(0);
    first.crash();
    first.notify("item/started", {
      threadId: first.threadId,
      turnId: first.turnId,
      item: { id: "stale", type: "mcpToolCall", server: "localdot", tool: "computer" },
    });
    f.endpoints[0]?.input.onResult?.("done", { ok: true, final: true, content: [] }, old);
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(f.session.status).toBe("waiting_user");
    expect(f.fake.launches).toHaveLength(1);
    expect(f.fake.activeLeases).toBe(0);
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(f.session.endTakeover("wrong", "ignored")).toBe(false);
    expect(f.session.endTakeover(requestId as string, "Signed in; continue")).toBe(true);
    const second = await f.fake.nextLaunch(2),
      turn = await second.waitFor("turn/start");
    expect(JSON.stringify(turn.params)).toContain("Signed in; continue");
    expect(
      f.transcript
        .read(f.session.id)
        .filter((m) => m.sourceInbox && m.content === "Signed in; continue"),
    ).toHaveLength(1);
    f.done();
    expect(await run).toBe(CODEX_DONE);
  });
  it.each(["during retirement", "after retirement"])(
    "waits for both hand-back and explicit Resume after auth changes %s under takeover",
    async (when) => {
      const f = fixture(),
        run = f.run(),
        c = await f.fake.nextLaunch(1);
      await c.waitFor("turn/start");
      const waiter = f.session.takeover("login", "Your turn");
      void waiter.catch(() => {});
      if (when === "after retirement") await until(() => f.fake.activeLeases === 0);
      f.fake.changeAuth();
      await until(() => c.stopped && f.session.status === "waiting_user");
      f.session.post("resume", "");
      const id = f.session.pendingTakeover as string;
      expect(f.fake.launches).toHaveLength(1);
      expect(f.session.endTakeover(id, "New login ready")).toBe(true);
      await until(() => f.session.status === "paused" || f.fake.launches.length > 1);
      expect(f.fake.launches).toHaveLength(1);
      expect(f.session.status).toBe("paused");
      f.session.post("resume", "");
      const second = await f.fake.nextLaunch(2);
      await second.waitFor("turn/start");
      f.done();
      expect(await run).toBe(CODEX_DONE);
    },
  );
  it("fences takeover during endpoint startup before any process or screenshot can be created", async () => {
    const f = fixture("Find the weather", { heartbeatMs: 60_000 }),
      opened = deferred<void>();
    f.gates.endpoint = opened.promise;
    cleanups.unshift(async () => opened.resolve());
    const run = f.run();
    await until(() => f.endpoints.length === 1);
    const waiter = f.session.takeover("login", "Please wait");
    void waiter.catch(() => {});
    expect(f.session.generation).toBeUndefined();
    expect(f.fake.launches).toHaveLength(0);
    opened.resolve();
    await until(() => f.endpoints[0]?.closed === true && f.fake.activeLeases === 0);
    await expect(waiter).rejects.toBeInstanceOf(Error);
    expect(f.session.controlHeld).toBe(true);
    expect(f.fake.launches).toHaveLength(0);
    expect(f.observe).not.toHaveBeenCalled();
    f.session.stop();
    expect(await run).toBe(CODEX_DONE);
  });
  it("Stops a running turn without waiting for its interrupt reply", async () => {
    const f = fixture(),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    await c.waitFor("turn/start");
    f.session.stop();
    expect(await run).toBe(CODEX_DONE);
    expect(c.requests.filter((r) => r.method === "turn/interrupt")).toHaveLength(1);
    expect(f.endpoints[0]?.closed).toBe(true);
  });
  it("classifies a registered launcher startup failure as an actual crash, preserving retirement", async () => {
    const f = fixture(),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    c.input.onFence();
    c.input.onFailure(new CodexLaunchError("startup_failed"));
    expect(await run).toBe(CODEX_CRASHED);
    expect(c.stopped).toBe(true);
    expect(f.fake.activeLeases).toBe(0);
  });
});
describe("Codex startup, storage and failure containment", () => {
  it("finishes autonomous launcher fencing when no separate failure callback arrives", async () => {
    const f = fixture(),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    await c.waitFor("turn/start");
    c.input.onFence();
    await c.connection.closed;
    const outcome = await Promise.race([
      run,
      new Promise<"unresolved">((resolve) => setTimeout(() => resolve("unresolved"), 100)),
    ]);
    expect(c.stopped).toBe(true);
    expect(outcome).toBe(CODEX_CRASHED);
    expect(f.fake.activeLeases).toBe(0);
  });
  it.each(["tool", "endpoint"])(
    "continues an acknowledged follow-up when %s done arrives before the next model turn",
    async (source) => {
      const f = fixture(),
        run = f.run(),
        first = await f.fake.nextLaunch(1);
      await first.waitFor("turn/start");
      const again = deferred<void>(),
        acquire = f.fake.auth.acquireTask.bind(f.fake.auth);
      vi.spyOn(f.fake.auth, "acquireTask").mockImplementation((...args) => {
        again.resolve();
        return acquire(...args);
      });
      const followup = f.session.post("followup", "Please also compare Saturday");
      await until(() => f.session.delivered === followup.seq);
      if (source === "tool") f.done();
      else f.endpoints[0]?.input.onRetire?.("done");
      expect(
        await Promise.race([again.promise.then(() => "continued"), run.then(() => "ended")]),
      ).toBe("continued");
      const second = await f.fake.nextLaunch(2),
        turn = await second.waitFor("turn/start");
      expect(JSON.stringify(turn.params)).toContain(followup.text);
      expect(
        f.transcript
          .read(f.session.id)
          .filter((m) => m.sourceInbox?.messageId === followup.messageId),
      ).toHaveLength(1);
      f.done();
      expect(await run).toBe(CODEX_DONE);
    },
  );
  it("continues an unconfirmed acknowledged steer when done races with its RPC reply", async () => {
    const f = fixture(),
      gate = deferred<unknown>(),
      run = f.run(),
      first = await f.fake.nextLaunch(1);
    await first.waitFor("turn/start");
    cleanups.unshift(async () => {
      gate.resolve({ turnId: first.turnId });
    });
    const again = deferred<void>(),
      acquire = f.fake.auth.acquireTask.bind(f.fake.auth);
    vi.spyOn(f.fake.auth, "acquireTask").mockImplementation((...args) => {
      again.resolve();
      return acquire(...args);
    });
    first.requestHook = (method) => (method === "turn/steer" ? gate.promise : undefined);
    const steer = f.session.post("steer", "Use the second result");
    await first.waitFor("turn/steer");
    expect(f.session.delivered).toBe(steer.seq);
    f.done();
    expect(
      await Promise.race([again.promise.then(() => "continued"), run.then(() => "ended")]),
    ).toBe("continued");
    const second = await f.fake.nextLaunch(2),
      turn = await second.waitFor("turn/start");
    expect(JSON.stringify(turn.params)).toContain(steer.text);
    gate.resolve({ turnId: first.turnId });
    await Promise.resolve();
    expect(second.stopped).toBe(false);
    f.done();
    expect(await run).toBe(CODEX_DONE);
  });
  it("keeps an acknowledged follow-up pending if completion reenters durable storage", async () => {
    const f = fixture(),
      run = f.run(),
      first = await f.fake.nextLaunch(1);
    await first.waitFor("turn/start");
    const again = deferred<void>(),
      acquire = f.fake.auth.acquireTask.bind(f.fake.auth),
      append = f.session.appendTranscript.bind(f.session);
    vi.spyOn(f.fake.auth, "acquireTask").mockImplementation((...args) => {
      again.resolve();
      return acquire(...args);
    });
    vi.spyOn(f.session, "appendTranscript").mockImplementation((...args) => {
      const result = append(...args);
      if (args[2].messages?.some((m) => m.sourceInbox?.messageId === message.messageId)) f.done();
      return result;
    });
    const message = f.session.post("followup", "Keep this at the storage boundary");
    expect(
      await Promise.race([again.promise.then(() => "continued"), run.then(() => "ended")]),
    ).toBe("continued");
    const second = await f.fake.nextLaunch(2),
      turn = await second.waitFor("turn/start");
    expect(JSON.stringify(turn.params)).toContain(message.text);
    expect(
      f.transcript.read(f.session.id).filter((m) => m.sourceInbox?.messageId === message.messageId),
    ).toHaveLength(1);
    f.done();
    expect(await run).toBe(CODEX_DONE);
  });
  it("does not continue already confirmed initial input after done", async () => {
    const f = fixture(),
      ready = deferred<void>(),
      inbox = f.session.inbox.bind(f.session);
    let calls = 0;
    vi.spyOn(f.session, "inbox").mockImplementation((...args) => {
      if (++calls === 2) ready.resolve();
      return inbox(...args);
    });
    const message = f.session.post("followup", "Include this in the first turn");
    const run = f.run(),
      first = await f.fake.nextLaunch(1),
      turn = await first.waitFor("turn/start");
    await ready.promise;
    expect(JSON.stringify(turn.params)).toContain(message.text);
    f.done();
    expect(await run).toBe(CODEX_DONE);
    expect(f.fake.launches).toHaveLength(1);
  });
  it("does not continue a confirmed steer after done", async () => {
    const f = fixture(),
      run = f.run(),
      first = await f.fake.nextLaunch(1);
    await first.waitFor("turn/start");
    const ready = deferred<void>(),
      inbox = f.session.inbox.bind(f.session);
    vi.spyOn(f.session, "inbox").mockImplementation((...args) => {
      ready.resolve();
      return inbox(...args);
    });
    const message = f.session.post("steer", "The first request is enough");
    await first.waitFor("turn/steer");
    await ready.promise;
    expect(f.session.delivered).toBe(message.seq);
    f.done();
    expect(await run).toBe(CODEX_DONE);
    expect(f.fake.launches).toHaveLength(1);
  });
  it("fsyncs exact user input before steer admission even when Stop wins the RPC reply", async () => {
    const f = fixture(),
      observed = deferred<{ delivered: number; state: ReturnType<TranscriptStore["state"]> }>(),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    await c.waitFor("turn/start");
    c.requestHook = (method) => {
      if (method !== "turn/steer") return;
      const snapshot = { delivered: f.session.delivered, state: f.transcript.state(f.session.id) };
      f.session.stop();
      observed.resolve(snapshot);
      return Promise.resolve({ turnId: c.turnId });
    };
    const user = f.session.post("steer", "Save this before submitting it"),
      snapshot = await observed.promise;
    expect(await run).toBe(CODEX_DONE);
    expect(snapshot.delivered).toBe(user.seq);
    expect(snapshot.state.inboxAfter).toBe(user.seq);
    expect(
      snapshot.state.messages.filter((m) => m.sourceInbox?.messageId === user.messageId),
    ).toEqual([
      {
        role: "user",
        content: user.text,
        sourceInbox: { seq: user.seq, messageId: user.messageId },
      },
    ]);
  });
  it.each(["endpoint", "launch", "initialize", "account", "thread", "observe"])(
    "fences Stop during %s startup and contains late resources",
    async (stage) => {
      const f = fixture(),
        gate = deferred<void>();
      cleanups.unshift(async () => {
        gate.resolve();
      });
      if (stage === "endpoint") f.gates.endpoint = gate.promise;
      if (stage === "launch") f.fake.launchGate = gate.promise;
      if (stage === "observe")
        f.observe.mockImplementation(async () => {
          await gate.promise;
          return { frameId: ulid(), full: true, png: Buffer.from(PNG) };
        });
      const methods = {
        initialize: "initialize",
        account: "account/read",
        thread: "thread/start",
      } as const;
      if (stage in methods)
        f.fake.requestHook = (method) =>
          method === methods[stage as keyof typeof methods]
            ? gate.promise.then(() => ({}))
            : undefined;
      const run = f.run();
      if (stage === "endpoint") await until(() => f.endpoints.length === 1);
      else {
        const c = await f.fake.nextLaunch(1);
        if (stage === "observe") await until(() => f.observe.mock.calls.length === 1);
        else if (stage in methods) await c.waitFor(methods[stage as keyof typeof methods]);
      }
      f.session.stop();
      expect(f.session.generation).toBeUndefined();
      gate.resolve();
      expect(await run).toBe(CODEX_DONE);
      expect(f.fake.launches.every((c) => c.stopped)).toBe(true);
      expect(f.endpoints.every((e) => e.closed)).toBe(true);
      expect(f.fake.launches.some((c) => c.requests.some((r) => r.method === "turn/start"))).toBe(
        false,
      );
    },
  );
  it("Stop aborts an acquisition wait without launching or creating a brain", async () => {
    const f = fixture(),
      gate = deferred<void>();
    f.fake.acquireGate = gate.promise;
    cleanups.unshift(async () => {
      gate.resolve();
    });
    const run = f.run();
    await Promise.resolve();
    f.session.stop();
    expect(await run).toBe(CODEX_DONE);
    gate.resolve();
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(f.fake.launches).toHaveLength(0);
    expect(f.endpoints).toHaveLength(0);
    expect(f.session.generation).toBeUndefined();
  });
  it("does not release a failed holder or admit replacement after the cleanup deadline", async () => {
    const f = fixture(),
      gate = deferred<void>(),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    cleanups.unshift(async () => {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });
    await c.waitFor("turn/start");
    c.stopGate = gate.promise;
    vi.useFakeTimers();
    f.done();
    const failed = expect(run).rejects.toBeInstanceOf(CodexCleanupError);
    await vi.advanceTimersByTimeAsync(2001);
    await failed;
    expect(f.fake.activeLeases).toBe(1);
    expect(f.fake.launches).toHaveLength(1);
    await expect(
      f.driver.run(f.session, { model: "gpt-6-astra", resume: true }),
    ).rejects.toBeInstanceOf(CodexCleanupError);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1);
    await expect(
      f.driver.run(f.session, { model: "gpt-6-astra", resume: true }),
    ).rejects.toBeInstanceOf(CodexCleanupError);
  });
  it("retains a reserved lease when pre-generation release fails", async () => {
    const f = fixture(),
      gate = deferred<void>();
    f.fake.releaseGate = gate.promise;
    cleanups.unshift(async () => {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });
    vi.spyOn(f.session, "beginBrain").mockImplementationOnce(() => {
      f.fake.changeAuth();
      throw new Error("retired before generation");
    });
    vi.useFakeTimers();
    const run = f.run(),
      failed = expect(run).rejects.toBeInstanceOf(CodexCleanupError);
    await vi.advanceTimersByTimeAsync(2001);
    await failed;
    expect(f.fake.activeLeases).toBe(1);
    expect(f.endpoints).toHaveLength(0);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1);
  });
  it.each(["before append", "after append", "ack"])(
    "preserves exact input across an injected failure %s",
    async (stage) => {
      const f = fixture(),
        message = f.session.post("followup", "Carry this exact message"),
        original = f.transcript.append.bind(f.transcript);
      if (stage === "ack")
        vi.spyOn(f.transcript, "acknowledge").mockImplementationOnce(() => {
          throw new Error("fake-private-diagnostic");
        });
      else
        vi.spyOn(f.transcript, "append").mockImplementation((id, rows) => {
          if (rows.some((m) => m.sourceInbox)) {
            if (stage === "after append") original(id, rows);
            throw new Error("fake-private-diagnostic");
          }
          original(id, rows);
        });
      expect(await f.run()).toBe(CODEX_GAVE_UP);
      expect(f.session.delivered).toBe(0);
      vi.restoreAllMocks();
      const resumed = f.run(true),
        c = await f.fake.nextLaunch(2),
        request = await c.waitFor("turn/start");
      expect(JSON.stringify(request.params)).toContain(message.text);
      expect(
        f.transcript
          .read(f.session.id)
          .filter((m) => m.sourceInbox?.messageId === message.messageId),
      ).toHaveLength(1);
      expect(f.session.delivered).toBe(message.seq);
      f.done();
      expect(await resumed).toBe(CODEX_DONE);
    },
  );
  it("retired storage callbacks cannot acknowledge fetched input or send it to the model", async () => {
    const f = fixture(),
      user = f.session.post("followup", "Not acknowledged yet"),
      original = f.transcript.append.bind(f.transcript);
    vi.spyOn(f.transcript, "append").mockImplementation((id, rows) => {
      original(id, rows);
      if (rows.some((m) => m.sourceInbox)) f.session.stop();
    });
    expect(await f.run()).toBe(CODEX_DONE);
    expect(f.session.delivered).toBe(0);
    expect(f.transcript.state(f.session.id).inboxAfter).toBe(0);
    expect(
      f.transcript.read(f.session.id).filter((m) => m.sourceInbox?.messageId === user.messageId),
    ).toHaveLength(1);
    expect(f.fake.launches[0]?.requests.some((r) => r.method === "turn/start")).toBe(false);
  });
  it("emits heartbeats only while running, and no heartbeat while waiting for the user", async () => {
    const f = fixture();
    vi.useFakeTimers();
    const run = f.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fake.launches[0]?.requests.some((r) => r.method === "turn/start")).toBe(true);
    await vi.advanceTimersByTimeAsync(35);
    expect(f.events.filter((e) => e.type === "heartbeat")).toHaveLength(3);
    f.session.setStatus("waiting_user");
    const before = f.events.length;
    await vi.advanceTimersByTimeAsync(35);
    expect(f.events.slice(before).some((e) => e.type === "heartbeat")).toBe(false);
    f.session.stop();
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toBe(CODEX_DONE);
  });
  it.each(["crop", "bad header", "oversize"])(
    "rejects a %s observation before publishing a tool basis",
    async (mode) => {
      const f = fixture();
      f.observe.mockImplementation(async () => ({
        frameId: ulid(),
        full: (mode !== "crop") as true,
        png:
          mode === "bad header"
            ? Buffer.from("invalid")
            : mode === "oversize"
              ? Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)])
              : Buffer.from(PNG),
      }));
      expect(await f.run()).toBe(CODEX_GAVE_UP);
      expect(f.endpoints[0]?.epoch).toBeUndefined();
      expect(f.fake.launches[0]?.requests.some((r) => r.method === "turn/start")).toBe(false);
    },
  );
  it("caps a recap instead of silently dropping already acknowledged input", async () => {
    const f = fixture();
    for (let n = 0; n < 34; n++) f.session.post("followup", "x".repeat(8000));
    expect(await f.run(true)).toBe(CODEX_GAVE_UP);
    expect(f.session.delivered).toBe(34);
    expect(f.transcript.read(f.session.id).filter((m) => m.sourceInbox)).toHaveLength(34);
    expect(f.fake.launches[0]?.requests.some((r) => r.method === "turn/start")).toBe(false);
  });
  it("refuses protected source input before journaling, without echoing it", async () => {
    const f = fixture();
    f.session.post("steer", "fake-private-diagnostic");
    const before = f.events.length;
    expect(await f.run()).toBe(CODEX_GAVE_UP);
    expect(f.session.delivered).toBe(0);
    expect(JSON.stringify(f.transcript.read(f.session.id))).not.toContain(
      "fake-private-diagnostic",
    );
    expect(JSON.stringify(f.events.slice(before))).not.toContain("fake-private-diagnostic");
  });
  it("rejects overlapping run admission and invalid model input without another lease", async () => {
    const f = fixture(),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    await c.waitFor("turn/start");
    await expect(f.driver.run(f.session, { model: "gpt-6-astra", resume: true })).rejects.toThrow(
      "already running",
    );
    expect(f.fake.maxLeases).toBe(1);
    f.done();
    expect(await run).toBe(CODEX_DONE);
    expect(await f.driver.run(f.session, { model: "", resume: false })).toBe(CODEX_GAVE_UP);
    expect(f.fake.launches).toHaveLength(1);
  });
  it("immediate done cannot acknowledge follow-up content that the inbox loop has not seen", async () => {
    const f = fixture(),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    await c.waitFor("turn/start");
    const followup = f.session.post("followup", "This arrived with done");
    f.done();
    expect(await run).toBe(CODEX_DONE);
    expect(f.session.delivered).toBe(0);
    const resumed = f.run(true),
      second = await f.fake.nextLaunch(2),
      turn = await second.waitFor("turn/start");
    expect(JSON.stringify(turn.params)).toContain(followup.text);
    expect(f.session.delivered).toBe(followup.seq);
    expect(
      f.transcript
        .read(f.session.id)
        .filter((m) => m.sourceInbox?.messageId === followup.messageId),
    ).toHaveLength(1);
    f.done();
    expect(await resumed).toBe(CODEX_DONE);
  });
  it("keeps the turn's initial basis when a tool returns another frame", async () => {
    const f = fixture(),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    await c.waitFor("turn/start");
    const first = f.context(),
      anotherFrame = ulid();
    f.session.lastFrameId = anotherFrame;
    f.endpoints[0]?.input.onResult?.(
      "computer",
      {
        ok: true,
        content: [
          {
            type: "image",
            mediaType: "image/png",
            data: PNG.toString("base64"),
            frameId: anotherFrame,
          },
        ],
      },
      first,
    );
    expect(f.context().turnEpoch).toBe(first.turnEpoch);
    expect(f.context().basisFrameId).toBe(first.basisFrameId);
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(c.stopped).toBe(false);
    f.done();
    expect(await run).toBe(CODEX_DONE);
  });
  it("waits for a positively confirmed lease release before obtaining a new generation or frame", async () => {
    const f = fixture(),
      gate = deferred<void>(),
      run = f.run(),
      first = await f.fake.nextLaunch(1);
    await first.waitFor("turn/start");
    cleanups.unshift(async () => {
      gate.resolve();
    });
    f.fake.releaseGate = gate.promise;
    first.complete();
    await until(() => first.stopped && f.session.generation === undefined);
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(f.fake.launches).toHaveLength(1);
    expect(f.fake.activeLeases).toBe(1);
    expect(f.observe).toHaveBeenCalledTimes(1);
    gate.resolve();
    const second = await f.fake.nextLaunch(2);
    await second.waitFor("turn/start");
    expect(f.fake.maxLeases).toBe(1);
    f.done();
    expect(await run).toBe(CODEX_DONE);
  });
});

describe("daemon-owned auth Resume handoff", () => {
  it.each(["before lease", "after lease"])(
    "Stop wakes an auth Resume dependency stalled %s",
    async (stage) => {
      const gate = deferred<void>();
      let calls = 0;
      const waiting = vi.fn(async () => {
        calls++;
        if (stage === "before lease" || calls === 2) await gate.promise;
      });
      const f = fixture("Fixture task", { waitForAuthResume: waiting }),
        run = f.run();
      try {
        await until(() => calls === (stage === "before lease" ? 1 : 2));
        expect(f.fake.activeLeases).toBe(stage === "before lease" ? 0 : 1);
        f.session.stop();
        const result = await Promise.race([
          run,
          new Promise<"stalled">((r) => setTimeout(() => r("stalled"), 50)),
        ]);
        expect(result).toBe(CODEX_DONE);
        expect(f.fake.activeLeases).toBe(0);
        expect(f.fake.launches).toHaveLength(0);
        expect(f.endpoints).toHaveLength(0);
        expect(f.observe).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        await run.catch(() => {});
      }
    },
  );
  it("keeps launch and frame admission blocked until explicit auth Resume", async () => {
    const gate = deferred<void>(),
      entered = deferred<void>();
    const f = fixture("Fixture task", {
        waitForAuthResume: async () => {
          entered.resolve();
          await gate.promise;
        },
      }),
      run = f.run();
    try {
      await entered.promise;
      expect(f.fake.activeLeases).toBe(0);
      expect(f.fake.launches).toHaveLength(0);
      expect(f.observe).not.toHaveBeenCalled();
      gate.resolve();
      const c = await f.fake.nextLaunch(1);
      await c.waitFor("turn/start");
      f.done();
      expect(await run).toBe(CODEX_DONE);
    } finally {
      gate.resolve();
      f.session.stop();
      await run.catch(() => {});
    }
  });
  it("uses the owner's mutation cursor when Resume arrives while the old holder is closing", async () => {
    let after: number | undefined;
    const f = fixture("Fixture task", {
        waitForAuthResume: async (s) => {
          if (after === undefined) return;
          await s.waitForResume(after);
          after = undefined;
        },
      }),
      run = f.run(),
      c = await f.fake.nextLaunch(1);
    await c.waitFor("turn/start");
    const closed = deferred<void>();
    c.stopGate = closed.promise;
    try {
      after = f.session.inboxSequence;
      f.fake.changeAuth();
      await until(() => c.stopped);
      f.session.post("resume", "");
      expect(f.fake.launches).toHaveLength(1);
      closed.resolve();
      const next = await f.fake.nextLaunch(2);
      await next.waitFor("turn/start");
      expect(f.endpoints[1]?.input.authGeneration).toBe(2);
      expect(f.fake.maxLeases).toBe(1);
      f.done();
      expect(await run).toBe(CODEX_DONE);
    } finally {
      closed.resolve();
      f.session.stop();
      await run.catch(() => {});
    }
  });
});
