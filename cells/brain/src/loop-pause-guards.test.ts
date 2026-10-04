import { type ToolResult, ulid } from "@localdot/protocol";
import { expect, it } from "vitest";
import { EventSink } from "./events.ts";
import { Agent } from "./loop.ts";
import { bootConfig, call, calls, fakeApi, scriptedModel } from "./testing/scripted.ts";

it.each(["failure-count", "turn-count"] as const)(
  "a Pause at the %s guard remains resumable instead of treating refusal as user Stop",
  async (limit) => {
    let isPaused = false;
    let waiting = false;
    let finished: string | undefined;
    let resume!: () => void;
    const release = new Promise<void>((r) => {
      resume = r;
    });
    const paused: ToolResult = {
      ok: false,
      pause: true,
      content: [{ type: "text", text: "Task paused" }],
    };
    const f = fakeApi((name) => {
      if (name === "shell") {
        isPaused = true;
        return {
          ok: true,
          pause: true,
          content: [{ type: "text", text: "Current shell finished" }],
        };
      }
      if (isPaused) return paused;
      if (name === "ask_user")
        return { ok: true, content: [{ type: "text", text: "The user chose A" }] };
    });
    f.api.control = async (_after, waitMs, signal) => {
      if (!isPaused) return { revision: 2 };
      if (waitMs) {
        waiting = true;
        await Promise.race([
          release,
          new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true })),
        ]);
        signal?.throwIfAborted();
        return { revision: 2 };
      }
      return {
        revision: 1,
        pause: {
          requestId: ulid(),
          revision: 1,
          phase: "paused",
          reason: "user",
          atStepBoundary: true,
          resumeAvailable: true,
        },
      };
    };
    const boot = bootConfig({ resume: true });
    if (limit === "turn-count") boot.limits = { ...boot.limits, maxTurns: 1 };
    const queued: [string, unknown][] =
      limit === "failure-count"
        ? Array.from({ length: 5 }, (_, i) => [
            "files",
            { op: "write", path: `queued-${i}`, content: "must not run" },
          ])
        : [];
    const model = scriptedModel([
      calls(["shell", { command: "echo current" }], ...queued),
      call("done", { summary: "Finished after explicit Resume" }),
    ]);
    const signal = new AbortController();
    const sink = new EventSink({ send: async () => {}, flushMs: 10000, heartbeatMs: 10000 });
    const agent = new Agent({ boot, api: f.api, sink, models: { main: model.model }, history: [] });
    const running = agent.run(signal.signal).then((v) => {
      finished = v;
      return v;
    });
    try {
      const deadline = Date.now() + 2000;
      while (!waiting && !finished && Date.now() < deadline)
        await new Promise<void>((r) => setTimeout(r, 5));
      if (!waiting && !finished)
        throw new Error("review fixture did not reach a control/finish boundary");
      const actual = {
        waiting,
        finished,
        effects: f.toolCalls.map((c) => c.name),
        models: model.prompts.length,
      };
      expect(actual, JSON.stringify(actual)).toEqual({
        waiting: true,
        finished: undefined,
        effects: ["shell"],
        models: 1,
      });
      isPaused = false;
      resume();
      expect(await running).toBe("done");
      expect(f.toolCalls.some((c) => c.name === "files")).toBe(false);
    } finally {
      isPaused = false;
      resume();
      signal.abort();
      await running.catch(() => {});
      await sink.close();
    }
  },
);

it("Pause arriving during a loop guard waits and asks again only after explicit Resume", async () => {
  let isPaused = false,
    waiting = false,
    asks = 0;
  let resume!: () => void;
  const release = new Promise<void>((r) => {
    resume = r;
  });
  const f = fakeApi((name) => {
    if (name === "ask_user") {
      asks++;
      if (asks === 1) {
        isPaused = true;
        return { ok: false, pause: true, content: [] };
      }
      return { ok: true, content: [{ type: "text", text: "The user chose A" }] };
    }
  });
  const requestId = ulid();
  f.api.control = async (_after, waitMs, signal) => {
    if (!isPaused) return { revision: 2 };
    if (waitMs) {
      waiting = true;
      await Promise.race([
        release,
        new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true })),
      ]);
      signal?.throwIfAborted();
      return { revision: 2 };
    }
    return {
      revision: 1,
      pause: {
        requestId,
        revision: 1,
        phase: "paused",
        reason: "user",
        atStepBoundary: true,
        resumeAvailable: true,
      },
    };
  };
  const boot = bootConfig({ resume: true });
  boot.limits = { ...boot.limits, maxTurns: 1 };
  const model = scriptedModel([
    call("shell", { command: "echo current" }),
    call("done", { summary: "Continued after guard Resume" }),
  ]);
  const abort = new AbortController();
  const sink = new EventSink({ send: async () => {}, flushMs: 10000, heartbeatMs: 10000 });
  const agent = new Agent({ boot, api: f.api, sink, models: { main: model.model }, history: [] });
  let finished: string | undefined;
  const running = agent.run(abort.signal).then((out) => {
    finished = out;
    return out;
  });
  try {
    const deadline = Date.now() + 2000;
    while (!waiting && !finished && Date.now() < deadline)
      await new Promise<void>((r) => setTimeout(r, 5));
    expect({ waiting, finished, asks, models: model.prompts.length }).toEqual({
      waiting: true,
      finished: undefined,
      asks: 1,
      models: 1,
    });
    isPaused = false;
    resume();
    expect(await running).toBe("done");
    expect(asks).toBe(2);
  } finally {
    isPaused = false;
    resume();
    abort.abort();
    await running.catch(() => {});
    await sink.close();
  }
});
