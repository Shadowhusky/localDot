import { type InboxItem, type ToolResult, type TranscriptMessage, ulid } from "@localdot/protocol";
import { APICallError, type ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromTranscript, imagePart, toTranscript } from "./context.ts";
import { EventSink } from "./events.ts";
import { Agent, type AgentOptions } from "./loop.ts";
import {
  binding,
  bootConfig,
  call,
  calls,
  fakeApi,
  say,
  scriptedModel,
  type Turn,
} from "./testing/scripted.ts";

type Chunks = Extract<Turn, unknown[]>;
const sinks: EventSink[] = [];
afterEach(async () => {
  for (const s of sinks.splice(0)) await s.close();
  vi.useRealTimers();
});
function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
function item(seq: number, kind: InboxItem["kind"], text: string): InboxItem {
  return { seq, messageId: ulid(), kind, text };
}
function image(
  frameId: string,
  region?: { x: number; y: number; w: number; h: number },
): ToolResult {
  return {
    ok: true,
    content: [
      {
        type: "image",
        frameId,
        ...(region ? { region } : {}),
        mediaType: "image/png",
        data: "iVBORw0KGgo=",
      },
    ],
  };
}
function frame(
  frameId: string,
  region?: { x: number; y: number; w: number; h: number },
): ModelMessage {
  return {
    role: "user",
    content: [imagePart({ frameId, ...(region ? { region } : {}) }, "iVBORw0KGgo=") as never],
  };
}
function setup(
  turns: Turn[],
  opts: {
    history?: ModelMessage[];
    stored?: TranscriptMessage[];
    f?: ReturnType<typeof fakeApi>;
    boot?: Parameters<typeof bootConfig>[0];
    fast?: Turn[];
    hooks?: AgentOptions["hooks"];
    sleep?: AgentOptions["sleep"];
  } = {},
) {
  const main = scriptedModel(turns),
    fast = opts.fast ? scriptedModel(opts.fast) : undefined,
    f = opts.f ?? fakeApi();
  const sink = new EventSink({ send: async () => {}, flushMs: 10000, heartbeatMs: 10000 });
  sinks.push(sink);
  const abort = new AbortController();
  const events: unknown[] = [];
  const agent = new Agent({
    boot: bootConfig({ resume: true, ...opts.boot }),
    api: f.api,
    sink,
    models: { main: main.model, ...(fast ? { fast: fast.model } : {}) },
    history: opts.history ?? [],
    storedTranscript: opts.stored,
    hooks: opts.hooks,
    sleep: opts.sleep ?? (async () => {}),
    onEvent: (e) => events.push(e),
  });
  return { agent, main, fast, f, abort, events, run: () => agent.run(abort.signal) };
}
const done = () => call("done", { summary: "Finished" });

describe("immutable model frame basis", () => {
  it("uses one basis for all clicks in a response and the newest result only on the next model call", async () => {
    const a = ulid(),
      b = ulid(),
      c = ulid(),
      d = ulid();
    const images = [b, c, d];
    const f = fakeApi((name) => (name === "computer" ? image(images.shift() ?? d) : undefined));
    const t = setup(
      [
        calls(
          ["computer", { action: "left_click", coordinate: [1, 1] }],
          ["computer", { action: "left_click", coordinate: [2, 2] }],
        ),
        call("computer", { action: "left_click", coordinate: [3, 3] }),
        done(),
      ],
      { f, history: [frame(a)] },
    );
    expect(await t.run()).toBe("done");
    expect(
      f.toolCalls
        .filter((c) => c.name === "computer")
        .map((c) => (c.input as { basedOn?: string }).basedOn),
    ).toEqual([a, a, c]);
  });
  it("stops later computer calls after stale failure and bases the following turn on the fresh failure image", async () => {
    const a = ulid(),
      b = ulid();
    let n = 0;
    const f = fakeApi((name) => (name === "computer" ? { ...image(b), ok: ++n !== 1 } : undefined));
    const t = setup(
      [
        calls(
          ["computer", { action: "left_click", coordinate: [1, 1] }],
          ["computer", { action: "left_click", coordinate: [2, 2] }],
          ["shell", { command: "pwd" }],
        ),
        call("computer", { action: "left_click", coordinate: [3, 3] }),
        done(),
      ],
      { f, history: [frame(a)] },
    );
    expect(await t.run()).toBe("done");
    const computer = f.toolCalls.filter((c) => c.name === "computer");
    expect(computer).toHaveLength(2);
    expect(computer.map((c) => (c.input as { basedOn?: string }).basedOn)).toEqual([a, b]);
    expect(f.toolCalls.some((c) => c.name === "shell")).toBe(true);
  });
  it("uses restored image data but never a marker or crop as a full-frame basis", async () => {
    const a = ulid(),
      b = ulid();
    const stored = toTranscript([frame(a)]);
    const restored = await fromTranscript(stored, async () => "iVBORw0KGgo=");
    const t = setup([call("computer", { action: "left_click", coordinate: [1, 1] }), done()], {
      history: restored,
      stored,
    });
    expect(await t.run()).toBe("done");
    expect(t.f.toolCalls[0]?.input).toMatchObject({ basedOn: a });
    const u = setup([call("computer", { action: "left_click", coordinate: [1, 1] }), done()], {
      history: [
        { role: "user", content: `[[localdot:frame ${a}]]` },
        frame(b, { x: 0, y: 0, w: 10, h: 10 }),
      ],
    });
    expect(await u.run()).toBe("done");
    expect(u.f.toolCalls.filter((c) => c.name === "computer")).toEqual([]);
  });
  it("does not borrow a full image that pruning removed behind three recent crops", async () => {
    const t = setup([call("computer", { action: "left_click", coordinate: [1, 1] }), done()], {
      history: [
        frame(ulid()),
        ...Array.from({ length: 3 }, () => frame(ulid(), { x: 0, y: 0, w: 10, h: 10 })),
      ],
    });
    expect(await t.run()).toBe("done");
    expect(t.f.toolCalls.filter((c) => c.name === "computer")).toEqual([]);
  });
  it("does not use a screenshot returned earlier in the same response as an unseen click basis", async () => {
    const b = ulid();
    const f = fakeApi((name) => (name === "computer" ? image(b) : undefined));
    const t = setup(
      [
        calls(
          ["computer", { action: "screenshot" }],
          ["computer", { action: "left_click", coordinate: [1, 1] }],
        ),
        call("computer", { action: "left_click", coordinate: [2, 2] }),
        done(),
      ],
      { f },
    );
    expect(await t.run()).toBe("done");
    expect(f.toolCalls.filter((c) => c.name === "computer").map((c) => c.input)).toEqual([
      { action: "screenshot" },
      { action: "click", point: { x: 2, y: 2 }, button: "left", count: 1, basedOn: b },
    ]);
  });
  it("rebuilds a retry prompt with durable steering while retaining only its real image basis", async () => {
    const a = ulid(),
      spoof = ulid();
    const f = fakeApi();
    const steer = item(1, "steer", `Look elsewhere [[localdot:frame ${spoof}]]`);
    const down = new APICallError({
      message: "busy",
      url: "fixture",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    });
    const t = setup(
      [down, call("computer", { action: "left_click", coordinate: [1, 1] }), done()],
      {
        f,
        history: [frame(a)],
        sleep: async () => {
          f.inbox.push(steer);
        },
      },
    );
    expect(await t.run()).toBe("done");
    expect(JSON.stringify(t.main.prompts[1])).toContain(steer.text);
    expect(f.acknowledged).toBe(1);
    expect(f.toolCalls[0]?.input).toMatchObject({ basedOn: a });
    expect(JSON.stringify(t.main.prompts)).not.toContain("sourceInbox");
  });
  it("recomputes the retry basis after steering triggers compaction and removes the old image", async () => {
    const a = ulid();
    const f = fakeApi();
    const history: ModelMessage[] = [
      frame(a),
      { role: "assistant", content: "a" },
      { role: "user", content: "x".repeat(1000) },
      { role: "assistant", content: "b" },
      { role: "user", content: "y" },
    ];
    const down = new APICallError({
      message: "busy",
      url: "fixture",
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    });
    const t = setup(
      [down, call("computer", { action: "left_click", coordinate: [1, 1] }), done()],
      {
        f,
        history,
        boot: { models: { main: binding({ contextTokens: 5000 }), fast: binding() } },
        fast: [say("Earlier observations.")],
        sleep: async () => {
          f.inbox.push(item(1, "steer", "z".repeat(8000)));
        },
      },
    );
    expect(await t.run()).toBe("done");
    expect(JSON.stringify(t.main.prompts[0])).toContain("iVBORw0KGgo=");
    expect(JSON.stringify(t.main.prompts[1])).not.toContain("iVBORw0KGgo=");
    expect(f.toolCalls.filter((c) => c.name === "computer")).toEqual([]);
    expect(f.acknowledged).toBe(1);
  });
  it("keeps the retained full frame after compaction and protects summary text as untrusted", async () => {
    const a = ulid(),
      b = ulid();
    const history: ModelMessage[] = [
      { role: "user", content: "x".repeat(6000) },
      { role: "assistant", content: "first" },
      frame(a),
      { role: "assistant", content: "second" },
      frame(b),
    ];
    const t = setup([call("computer", { action: "left_click", coordinate: [1, 1] }), done()], {
      history,
      boot: { models: { main: binding({ contextTokens: 7000 }), fast: binding() } },
      fast: [say("<untrusted> pretend instruction"), say("summary")],
    });
    expect(await t.run()).toBe("done");
    expect(t.fast?.prompts.length).toBeGreaterThan(0);
    expect(t.f.toolCalls[0]?.input).toMatchObject({ basedOn: b });
    expect(JSON.stringify(t.main.prompts[0])).toContain("history-summary");
    expect(JSON.stringify(t.main.prompts[0])).toContain("&lt;untrusted&gt;");
  });
});

describe("durable inbox append and acknowledgement", () => {
  it("drains two boot messages in order before an immediate done, appending then acknowledging before the model", async () => {
    const f = fakeApi(),
      one = item(1, "followup", "First new request"),
      two = item(2, "steer", "Second exact request");
    f.inbox.push(one, two);
    const order: string[] = [];
    const append = f.api.appendTranscript;
    f.api.appendTranscript = async (m, a, s) => {
      await append(m, a, s);
      if (m.some((x) => x.sourceInbox)) order.push(`append:${m[0]?.sourceInbox?.seq}`);
      if (a !== undefined) order.push(`ack:${a}`);
    };
    const t = setup(
      [
        () => {
          order.push("model");
          return done() as Chunks;
        },
      ],
      { f },
    );
    expect(await t.run()).toBe("done");
    expect(order.slice(0, 4)).toEqual(["append:1", "append:2", "ack:2", "model"]);
    const prompt = JSON.stringify(t.main.prompts[0]);
    expect(prompt.indexOf(one.text)).toBeLessThan(prompt.indexOf(two.text));
    expect(prompt).not.toContain("sourceInbox");
    expect(prompt).not.toContain(one.messageId);
    expect(f.transcript.filter((m) => m.sourceInbox)).toHaveLength(2);
    expect(f.acknowledged).toBe(2);
  });
  it("waits for append completion and acknowledgement completion before the first model", async () => {
    const f = fakeApi();
    f.inbox.push(item(1, "followup", "Wait for me"));
    const appendGate = defer<void>(),
      ackGate = defer<void>(),
      append = f.api.appendTranscript;
    let appending = false,
      acking = false;
    f.api.appendTranscript = async (m, a, s) => {
      if (m.some((x) => x.sourceInbox)) {
        appending = true;
        await appendGate.promise;
      }
      if (a !== undefined) {
        acking = true;
        await ackGate.promise;
      }
      await append(m, a, s);
    };
    const t = setup([done()], { f });
    const run = t.run();
    await vi.waitUntil(() => appending);
    expect(t.main.prompts).toHaveLength(0);
    expect(acking).toBe(false);
    appendGate.resolve();
    await vi.waitUntil(() => acking);
    expect(t.main.prompts).toHaveLength(0);
    ackGate.resolve();
    expect(await run).toBe("done");
  });
  it.each(["before-append", "after-append"])(
    "replays once after %s failure without losing an unacknowledged message",
    async (point) => {
      const f = fakeApi();
      const queued = item(1, "followup", "Never lose this");
      f.inbox.push(queued);
      const append = f.api.appendTranscript;
      let injected = false;
      f.api.appendTranscript = async (m, a, s) => {
        if (!injected && m.some((x) => x.sourceInbox)) {
          injected = true;
          if (point === "after-append") await append(m, a, s);
          throw new Error("fixture crash");
        }
        await append(m, a, s);
      };
      const first = setup([done()], { f });
      await expect(first.run()).rejects.toThrow(/fixture crash/);
      expect(first.main.prompts).toHaveLength(0);
      expect(f.acknowledged).toBe(0);
      f.api.appendTranscript = append;
      const stored = await f.api.transcript();
      const history = await fromTranscript(stored, async () => undefined);
      const next = setup([done()], { f, stored, history });
      expect(await next.run()).toBe("done");
      expect(
        f.transcript.filter((m) => m.sourceInbox?.messageId === queued.messageId),
      ).toHaveLength(1);
      expect(JSON.stringify(next.main.prompts[0]).split(queued.text)).toHaveLength(2);
      expect(f.acknowledged).toBe(1);
    },
  );
  it("deduplicates replay after durable append but failed acknowledgement", async () => {
    const f = fakeApi();
    const queued = item(1, "followup", "Acknowledge after append");
    f.inbox.push(queued);
    const append = f.api.appendTranscript;
    f.api.appendTranscript = async (m, a, s) => {
      if (a !== undefined) throw new Error("ack failed");
      await append(m, a, s);
    };
    const first = setup([done()], { f });
    await expect(first.run()).rejects.toThrow(/ack failed/);
    expect(f.transcript.filter((m) => m.sourceInbox)).toHaveLength(1);
    expect(f.acknowledged).toBe(0);
    f.api.appendTranscript = append;
    const stored = await f.api.transcript(),
      history = await fromTranscript(stored, async () => undefined);
    const next = setup([done()], { f, stored, history });
    expect(await next.run()).toBe("done");
    expect(f.transcript.filter((m) => m.sourceInbox)).toHaveLength(1);
    expect(f.acknowledged).toBe(1);
  });
  it("does not acknowledge after Stop between durable append and acknowledgement", async () => {
    const f = fakeApi();
    f.inbox.push(item(1, "followup", "Stop fence"));
    const append = f.api.appendTranscript;
    const t = setup([done()], { f });
    f.api.appendTranscript = async (m, a, s) => {
      await append(m, a, s);
      if (m.some((x) => x.sourceInbox)) t.abort.abort();
    };
    expect(await t.run()).toBe("stopped");
    expect(f.acknowledged).toBe(0);
    expect(t.main.prompts).toHaveLength(0);
    expect(f.transcript.filter((m) => m.sourceInbox)).toHaveLength(1);
  });
  it("uses the boot acknowledged cursor after an acknowledgement reply was lost", async () => {
    const f = fakeApi();
    f.inbox.push(item(1, "followup", "Already durable"));
    const append = f.api.appendTranscript;
    f.api.appendTranscript = async (m, a, s) => {
      await append(m, a, s);
      if (a !== undefined) throw new Error("reply lost");
    };
    const first = setup([done()], { f });
    await expect(first.run()).rejects.toThrow(/reply lost/);
    expect(f.acknowledged).toBe(1);
    f.api.appendTranscript = append;
    const inbox = vi.spyOn(f.api, "inbox");
    const stored = await f.api.transcript(),
      history = await fromTranscript(stored, async () => undefined);
    const next = setup([done()], { f, stored, history, boot: { inboxAfter: 1 } });
    expect(await next.run()).toBe("done");
    expect(inbox.mock.calls.every((c) => c[0] === 1)).toBe(true);
    expect(f.transcript.filter((m) => m.sourceInbox)).toHaveLength(1);
  });
  it("does not acknowledge a queued mid-run follow-up until the model would finish", async () => {
    const f = fakeApi(),
      queued = item(1, "followup", "Do this next"),
      steer = item(2, "steer", "Steer this turn");
    const t = setup(
      [
        () => {
          f.inbox.push(queued, steer);
          return call("update_plan", { items: [{ text: "working", status: "doing" }] }) as Chunks;
        },
        () => {
          expect(f.acknowledged).toBe(0);
          return done() as Chunks;
        },
        () => {
          expect(f.acknowledged).toBe(2);
          return done() as Chunks;
        },
      ],
      { f },
    );
    expect(await t.run()).toBe("done");
    expect(JSON.stringify(t.main.prompts[1])).toContain(steer.text);
    expect(JSON.stringify(t.main.prompts[1])).not.toContain(queued.text);
    expect(JSON.stringify(t.main.prompts[2])).toContain(queued.text);
    expect(f.toolCalls.filter((c) => c.name === "done")).toHaveLength(1);
    expect(f.transcript.filter((m) => m.sourceInbox)).toHaveLength(2);
  });
  it("acknowledges resume-only controls, while empty polls never manufacture cursor progress", async () => {
    const f = fakeApi();
    f.inbox.push(item(1, "resume", ""));
    const append = vi.spyOn(f.api, "appendTranscript");
    const t = setup([done()], { f });
    expect(await t.run()).toBe("done");
    expect(f.acknowledged).toBe(1);
    expect(f.transcript.some((m) => m.sourceInbox)).toBe(false);
    expect(append.mock.calls.filter((c) => c[1] !== undefined).map((c) => c[1])).toEqual([1]);
  });
  it("refuses a future sequence or conflicting replay without acknowledgement or a model call", async () => {
    for (const conflict of [false, true]) {
      const f = fakeApi();
      const queued = item(conflict ? 1 : 2, "followup", "new text");
      f.inbox.push(queued);
      const stored: TranscriptMessage[] = conflict
        ? [
            {
              role: "user",
              content: "different original",
              sourceInbox: { seq: 1, messageId: queued.messageId },
            },
          ]
        : [];
      const t = setup([done()], {
        f,
        stored,
        history: await fromTranscript(stored, async () => undefined),
      });
      await expect(t.run()).rejects.toThrow(/sequence|Conflicting/);
      expect(f.acknowledged).toBe(0);
      expect(t.main.prompts).toHaveLength(0);
    }
  });
});

describe("tool lifetime cancellation", () => {
  it("returns stopped for a stopped inbox without model calls or another transcript write", async () => {
    const f = fakeApi();
    f.stop();
    const append = vi.spyOn(f.api, "appendTranscript");
    const t = setup([done()], { f });
    expect(await t.run()).toBe("stopped");
    expect(t.main.prompts).toHaveLength(0);
    expect(append).not.toHaveBeenCalled();
  });
  it("propagates cancellation through the harness and rejects late results before later calls or persistence", async () => {
    const f = fakeApi();
    const tool = f.api.tool;
    const gate = defer<ToolResult>();
    let active: AbortSignal | undefined;
    const api = f.api as AgentOptions["api"];
    api.tool = async (name, id, input, signal) => {
      if (name === "shell") {
        active = signal;
        return gate.promise;
      }
      return tool(name, id, input);
    };
    const t = setup(
      [calls(["shell", { command: "sleep" }], ["done", { summary: "must not finish" }])],
      { f },
    );
    const run = t.run();
    await vi.waitUntil(() => active !== undefined);
    expect(active?.aborted).toBe(false);
    t.abort.abort();
    expect(active?.aborted).toBe(true);
    const count = f.transcript.length;
    gate.resolve({ ok: true, content: [{ type: "text", text: "late secret data" }] });
    expect(await run).toBe("stopped");
    expect(f.toolCalls.some((c) => c.name === "done")).toBe(false);
    expect(f.transcript).toHaveLength(count);
    expect(JSON.stringify(t.agent.history)).not.toContain("late secret data");
  });
  it("rechecks cancellation after an ignored before-tool hook and never dispatches", async () => {
    const gate = defer<undefined>();
    let entered = false;
    const t = setup([call("shell", { command: "x" })], {
      hooks: {
        beforeToolCall: async () => {
          entered = true;
          return gate.promise;
        },
      },
    });
    const run = t.run();
    await vi.waitUntil(() => entered);
    t.abort.abort();
    gate.resolve(undefined);
    expect(await run).toBe("stopped");
    expect(t.f.toolCalls).toEqual([]);
  });
});

describe("daemon safety Pause directives", () => {
  const pause = () => ({
    requestId: ulid(),
    revision: 1,
    phase: "paused" as const,
    reason: "user" as const,
    atStepBoundary: true,
    resumeAvailable: true,
  });
  async function spin(predicate: () => boolean) {
    for (let n = 0; n < 500; n++) {
      if (predicate()) return;
      await new Promise<void>((r) => setImmediate(r));
    }
    throw new Error("safety boundary not reached");
  }
  it("persists the actual paused batch, skips subsequent effects and waits for authenticated control", async () => {
    const resumed = defer<{ revision: number }>();
    let isPaused = false,
      waiting = false;
    const metadata = pause();
    const f = fakeApi((name) => {
      if (name === "shell") {
        isPaused = true;
        return {
          ok: true,
          pause: true,
          content: [{ type: "text", text: "Current shell finished" }],
        };
      }
    });
    f.api.control = async (_after, waitMs) => {
      if (!isPaused) return { revision: 0 };
      if (waitMs) {
        waiting = true;
        return resumed.promise;
      }
      return { revision: 1, pause: metadata };
    };
    const t = setup(
      [
        calls(
          ["shell", { command: "echo current" }],
          ["files", { op: "write", path: "queued", content: "forbidden" }],
        ),
        done(),
      ],
      {
        f,
        hooks: {
          afterToolCall: async (info) =>
            info.name === "shell"
              ? { ok: true, content: [{ type: "text", text: "Adjusted" }] }
              : undefined,
        },
      },
    );
    const running = t.run();
    await spin(() => waiting);
    expect(t.main.prompts).toHaveLength(1);
    expect(f.toolCalls.map((c) => c.name)).toEqual(["shell"]);
    expect(JSON.stringify(f.transcript)).toContain("Skipped: the task was paused");
    expect(JSON.stringify(f.transcript)).toContain("Adjusted");
    f.inbox.push(item(1, "steer", "Continue"), item(2, "resume", ""));
    await new Promise<void>((r) => setImmediate(r));
    expect(t.main.prompts).toHaveLength(1);
    isPaused = false;
    resumed.resolve({ revision: 2 });
    expect(await running).toBe("done");
    expect(f.toolCalls.map((c) => c.name)).toEqual(["shell", "done"]);
  });
  it("treats a keyd task_paused reply as a control wait with zero ordinary retries", async () => {
    const resumed = defer<{ revision: number }>();
    let isPaused = false,
      waiting = false;
    const metadata = pause(),
      f = fakeApi();
    f.api.control = async (_after, waitMs) => {
      if (!isPaused) return { revision: 0 };
      if (waitMs) {
        waiting = true;
        return resumed.promise;
      }
      return { revision: 1, pause: metadata };
    };
    const down = new APICallError({
      message: "paused",
      url: "fixture",
      requestBodyValues: {},
      statusCode: 409,
      responseBody: JSON.stringify({ code: "task_paused" }),
      isRetryable: false,
    });
    const sleep = vi.fn(async () => {});
    const t = setup(
      [
        () => {
          isPaused = true;
          return down;
        },
        done(),
      ],
      { f, sleep },
    );
    const running = t.run();
    await spin(() => waiting);
    expect(t.main.prompts).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(t.events.some((e) => JSON.stringify(e).includes("model_error"))).toBe(false);
    isPaused = false;
    resumed.resolve({ revision: 2 });
    expect(await running).toBe("done");
    expect(t.main.prompts).toHaveLength(2);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("keeps heartbeat during an active tool then stops it at the settled Pause", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const active = defer<ToolResult>(),
      resumed = defer<{ revision: number }>();
    let acting = false,
      waiting = false,
      isPaused = false;
    const metadata = pause(),
      f = fakeApi();
    const ordinary = f.api.tool;
    f.api.tool = async (...args) => {
      if (args[0] === "shell") {
        acting = true;
        return active.promise;
      }
      return ordinary(...args);
    };
    f.api.control = async (_after, waitMs) => {
      if (!isPaused) return { revision: 0 };
      if (waitMs) {
        waiting = true;
        return resumed.promise;
      }
      return { revision: 1, pause: metadata };
    };
    const delivered: import("@localdot/protocol").BrainEvent[] = [];
    const sink = new EventSink({
      send: async (events) => {
        delivered.push(...events);
      },
      heartbeatMs: 1000,
      flushMs: 100,
    });
    sinks.push(sink);
    const main = scriptedModel([call("shell", { command: "echo current" }), done()]);
    const controller = new AbortController();
    const agent = new Agent({
      boot: bootConfig({ resume: true }),
      api: f.api,
      sink,
      models: { main: main.model },
      history: [],
    });
    const running = agent.run(controller.signal);
    await spin(() => acting);
    isPaused = true;
    await vi.advanceTimersByTimeAsync(1000);
    await sink.flush();
    expect(delivered.some((e) => e.type === "heartbeat" && e.data.ongoing)).toBe(true);
    active.resolve({ ok: true, pause: true, content: [{ type: "text", text: "Settled" }] });
    await spin(() => waiting);
    await sink.flush();
    const ongoing = delivered.filter((e) => e.type === "heartbeat" && e.data.ongoing).length;
    await vi.advanceTimersByTimeAsync(2000);
    await sink.flush();
    expect(delivered.filter((e) => e.type === "heartbeat" && e.data.ongoing)).toHaveLength(ongoing);
    expect(delivered.some((e) => e.type === "heartbeat" && !e.data.ongoing)).toBe(true);
    isPaused = false;
    resumed.resolve({ revision: 2 });
    expect(await running).toBe("done");
  });
});
