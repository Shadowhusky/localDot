import { getEventListeners } from "node:events";
import type { ModelMessage } from "ai";
import { afterEach, expect, it } from "vitest";
import { EventSink } from "./events.ts";
import { Agent } from "./loop.ts";
import {
  binding,
  bootConfig,
  call,
  calls,
  fakeApi,
  say,
  scriptedModel,
} from "./testing/scripted.ts";

const sinks: EventSink[] = [];
afterEach(async () => {
  for (const s of sinks.splice(0)) await s.close();
});

it("cancels an already-running event send when a newly bound lifetime ends", async () => {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  let active: AbortSignal | undefined;
  const sink = new EventSink({
    send: async (_events, signal) => {
      active = signal;
      await gate;
    },
  });
  sinks.push(sink);
  sink.state("thinking");
  const sending = sink.flush();
  await Promise.resolve();
  expect(active).toBeDefined();
  const abort = new AbortController();
  sink.bind(abort.signal);
  abort.abort();
  try {
    expect(active?.aborted).toBe(true);
  } finally {
    resolve();
    await sending;
  }
});

it("cancels prior event sends when a stopped inbox binds an already-aborted lifetime", async () => {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  let active: AbortSignal | undefined;
  const sink = new EventSink({
    send: async (_events, signal) => {
      active = signal;
      await gate;
    },
  });
  sinks.push(sink);
  sink.state("thinking");
  const sending = sink.flush();
  await Promise.resolve();
  sink.bind(AbortSignal.abort());
  try {
    expect(active?.aborted).toBe(true);
  } finally {
    resolve();
    await sending;
  }
});

it("cancels an outstanding send in the actual stopped-inbox Agent.run path", async () => {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  let active: AbortSignal | undefined;
  const sink = new EventSink({
    send: async (_events, signal) => {
      active = signal;
      await gate;
    },
  });
  sinks.push(sink);
  const f = fakeApi();
  let polls = 0;
  f.api.inbox = async () => {
    if (++polls === 3) {
      void sink.flush();
      await Promise.resolve();
      expect(active).toBeDefined();
      return { items: [], stopped: true };
    }
    return { items: [], stopped: false };
  };
  const main = scriptedModel([call("done", { summary: "Must not run" })]);
  const agent = new Agent({
    boot: bootConfig({ resume: true }),
    api: f.api,
    sink,
    models: { main: main.model },
    history: [],
  });
  try {
    expect(await agent.run(new AbortController().signal)).toBe("stopped");
    expect(main.prompts).toHaveLength(0);
    let closed = false;
    void sink.close().then(() => {
      closed = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect({ aborted: active?.aborted, closed }).toEqual({ aborted: true, closed: true });
  } finally {
    resolve();
    await sink.close();
  }
});

it("discards an after-tool hook result once its active run is cancelled", async () => {
  const f = fakeApi();
  let resolve!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const main = scriptedModel([
    calls(["shell", { command: "pwd" }], ["done", { summary: "Must not run" }]),
  ]);
  const sink = new EventSink({ send: async () => {} });
  sinks.push(sink);
  const abort = new AbortController();
  const agent = new Agent({
    boot: bootConfig({ resume: true }),
    api: f.api,
    sink,
    models: { main: main.model },
    history: [],
    hooks: {
      afterToolCall: async () => {
        entered();
        await gate;
        return { ok: true, content: [{ type: "text", text: "late private result" }] };
      },
    },
  });
  const running = agent.run(abort.signal);
  await started;
  const before = f.transcript.length;
  abort.abort();
  resolve();
  expect(await running).toBe("stopped");
  expect(f.toolCalls.map((c) => c.name)).toEqual(["shell"]);
  expect(JSON.stringify(agent.history)).not.toContain("late private result");
  expect(f.transcript).toHaveLength(before);
});

it("fails before model execution or live history replacement when compaction persistence fails", async () => {
  const f = fakeApi();
  const append = f.api.appendTranscript;
  f.api.appendTranscript = async (messages, after, signal) => {
    if (
      messages.some(
        (m) =>
          typeof m.content === "object" &&
          m.content !== null &&
          "type" in m.content &&
          m.content.type === "localdot-compaction",
      )
    )
      throw new Error("compaction disk failure");
    return append(messages, after, signal);
  };
  const main = scriptedModel([call("done", { summary: "Must not run" })]),
    fast = scriptedModel([say("New compacted summary")]);
  const sink = new EventSink({ send: async () => {} });
  sinks.push(sink);
  const history: ModelMessage[] = [
    { role: "user", content: "x".repeat(6000) },
    { role: "assistant", content: "first" },
    { role: "user", content: "y" },
    { role: "assistant", content: "second" },
    { role: "user", content: "z" },
  ];
  const agent = new Agent({
    boot: bootConfig({
      resume: true,
      models: { main: binding({ contextTokens: 2000 }), fast: binding() },
    }),
    api: f.api,
    sink,
    models: { main: main.model, fast: fast.model },
    history,
  });
  await expect(agent.run(new AbortController().signal)).rejects.toThrow("compaction disk failure");
  expect(main.prompts).toHaveLength(0);
  expect(agent.history[0]).toEqual(history[0]);
  expect(JSON.stringify(agent.history)).not.toContain("New compacted summary");
});

it("detaches each distinct bound listener when normal close finishes", async () => {
  const first = new AbortController(),
    second = new AbortController();
  const sink = new EventSink({ send: async () => {}, signal: first.signal });
  sinks.push(sink);
  sink.bind(first.signal);
  sink.bind(second.signal);
  expect(getEventListeners(first.signal, "abort")).toHaveLength(1);
  expect(getEventListeners(second.signal, "abort")).toHaveLength(1);
  await sink.close();
  expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
  expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
});

it("cancels a draining normal close through a signal bound after close began", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active: AbortSignal | undefined;
  const first = new AbortController(),
    second = new AbortController();
  const sink = new EventSink({
    signal: first.signal,
    send: async (_events, signal) => {
      active = signal;
      await gate;
    },
  });
  sinks.push(sink);
  sink.state("thinking");
  const closing = sink.close();
  await Promise.resolve();
  sink.bind(second.signal);
  second.abort();
  try {
    expect(active?.aborted).toBe(true);
    await closing;
    expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
  } finally {
    release();
  }
});
