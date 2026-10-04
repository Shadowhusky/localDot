import { EventEmitter } from "node:events";
import { type TranscriptMessage, ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { imagePart, toTranscript } from "./context.ts";
import { type BrainEntryDeps, runBrain } from "./entry.ts";
import { EventSink } from "./events.ts";
import type { AgentOptions } from "./loop.ts";
import type { ProxyFetch } from "./proxy-fetch.ts";
import { bootConfig, PROXY_TOKEN, scriptedModel } from "./testing/scripted.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const signals = new EventEmitter();
  const order: string[] = [];
  const seenSignals: AbortSignal[] = [];
  const log = vi.fn();
  const api = {
    boot: vi.fn(async (signal?: AbortSignal) => {
      if (signal) seenSignals.push(signal);
      return bootConfig();
    }),
    transcript: vi.fn(async (signal?: AbortSignal): Promise<TranscriptMessage[]> => {
      if (signal) seenSignals.push(signal);
      return [];
    }),
    frame: vi.fn(async (_id: string, _region: unknown, signal?: AbortSignal) => {
      if (signal) seenSignals.push(signal);
      return "pixels";
    }),
    events: vi.fn(async (_events: unknown, signal?: AbortSignal) => {
      if (signal) seenSignals.push(signal);
    }),
    tool: vi.fn(async () => ({ ok: true, content: [] })),
    inbox: vi.fn(async () => ({ items: [], stopped: false })),
    appendTranscript: vi.fn(async () => {}),
    control: vi.fn(async () => ({ revision: 0 })),
    close: vi.fn(async () => {
      order.push("api closed");
    }),
  };
  const proxy = Object.assign(vi.fn(), {
    close: vi.fn(async () => {
      order.push("proxy closed");
    }),
  }) as unknown as ProxyFetch;
  let options: AgentOptions | undefined;
  const run = vi.fn(async (signal: AbortSignal) => {
    seenSignals.push(signal);
    return "done" as const;
  });
  const deps: BrainEntryDeps = {
    env: { LOCALDOT_TOOL_URL: "http://127.0.0.1:4751", LOCALDOT_TOOL_TOKEN: PROXY_TOKEN },
    on: (signal, listener) => {
      signals.on(signal, listener);
    },
    off: (signal, listener) => {
      signals.off(signal, listener);
    },
    log,
    api: vi.fn(() => api),
    proxy: vi.fn(() => proxy),
    model: vi.fn(() => scriptedModel([]).model),
    sink: vi.fn((options) => {
      const sink = new EventSink(options);
      const close = sink.close.bind(sink);
      sink.close = vi.fn(async () => {
        order.push("sink closed");
        await close();
      });
      return sink;
    }),
    agent: vi.fn((opts) => {
      options = opts;
      return { run };
    }),
  };
  return {
    deps,
    api,
    proxy,
    signals,
    order,
    seenSignals,
    log,
    run,
    get options() {
      return options;
    },
  };
}

describe("brain entry lifecycle", () => {
  it("installs both Stop handlers before boot and rejects a late boot result before model construction", async () => {
    const f = fixture();
    const ready = deferred<ReturnType<typeof bootConfig>>();
    f.api.boot.mockImplementationOnce(async (signal) => {
      expect(f.signals.listenerCount("SIGTERM")).toBe(1);
      expect(f.signals.listenerCount("SIGINT")).toBe(1);
      f.signals.emit("SIGTERM");
      expect(signal?.aborted).toBe(true);
      return ready.promise;
    });
    const pending = runBrain(f.deps);
    ready.resolve(bootConfig());
    expect(await pending).toBe(0);
    expect(f.deps.model).not.toHaveBeenCalled();
    expect(f.deps.agent).not.toHaveBeenCalled();
    expect(f.api.close).toHaveBeenCalledTimes(1);
    expect(f.signals.listenerCount("SIGTERM")).toBe(0);
    expect(f.log).not.toHaveBeenCalled();
  });
  it("passes raw inbox metadata solely as bookkeeping, restores pixels, forwards event signals and drains before transport close", async () => {
    const f = fixture();
    const sourceInbox = { seq: 1, messageId: ulid() };
    const stored = [
      ...toTranscript([
        { role: "user", content: [imagePart({ frameId: ulid() }, "original") as never] },
      ]),
      { role: "user" as const, content: "exact text", sourceInbox },
    ];
    f.api.boot.mockResolvedValueOnce(bootConfig({ resume: true }));
    f.api.transcript.mockResolvedValueOnce(stored);
    f.run.mockImplementationOnce(async (signal) => {
      f.seenSignals.push(signal);
      f.options?.sink.state("thinking");
      return "done";
    });
    expect(await runBrain(f.deps)).toBe(0);
    expect(f.options?.storedTranscript).toEqual(stored);
    expect(f.options?.history.at(-1)).toEqual({ role: "user", content: "exact text" });
    expect(JSON.stringify(f.options?.history)).not.toContain("sourceInbox");
    expect(JSON.stringify(f.options?.history)).toContain("pixels");
    expect(JSON.stringify(stored)).not.toContain("pixels");
    expect(f.api.events).toHaveBeenCalled();
    expect(f.seenSignals.every((signal) => signal === f.seenSignals[0] || signal.aborted)).toBe(
      true,
    );
    expect(f.order[0]).toBe("sink closed");
    expect(f.order.slice(1).sort()).toEqual(["api closed", "proxy closed"]);
    expect(f.signals.listenerCount("SIGINT")).toBe(0);
  });
  it("does not start an agent after Stop during frame restoration", async () => {
    const f = fixture();
    f.api.boot.mockResolvedValueOnce(bootConfig({ resume: true }));
    f.api.transcript.mockResolvedValueOnce(
      toTranscript([{ role: "user", content: [imagePart({ frameId: ulid() }, "frame") as never] }]),
    );
    f.api.frame.mockImplementationOnce(async (_id, _region, signal) => {
      f.signals.emit("SIGINT");
      expect(signal?.aborted).toBe(true);
      return "late";
    });
    expect(await runBrain(f.deps)).toBe(0);
    expect(f.deps.agent).not.toHaveBeenCalled();
    expect(f.order.sort()).toEqual(["api closed", "proxy closed"]);
  });
  it("uses fixed safe diagnostics for boot, model, loop and cleanup failures", async () => {
    for (const stage of ["boot", "model", "run", "close"] as const) {
      const f = fixture();
      const secret = "credential-bearing-peer-error";
      if (stage === "boot") f.api.boot.mockRejectedValueOnce(new Error(secret));
      if (stage === "model")
        (f.deps.model as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
          throw new Error(secret);
        });
      if (stage === "run") f.run.mockRejectedValueOnce(new Error(secret));
      if (stage === "close") f.api.close.mockRejectedValueOnce(new Error(secret));
      expect(await runBrain(f.deps)).toBe(1);
      expect(JSON.stringify(f.log.mock.calls)).not.toContain(secret);
      expect(f.log).toHaveBeenCalled();
      expect(f.api.close).toHaveBeenCalledTimes(1);
      expect(f.signals.listenerCount("SIGTERM")).toBe(0);
    }
  });
  it("does not construct transports with invalid environment and still unregisters handlers", async () => {
    const f = fixture();
    f.deps.env = {
      LOCALDOT_TOOL_URL: `http://user:${PROXY_TOKEN}@example.test`,
      LOCALDOT_TOOL_TOKEN: PROXY_TOKEN,
    };
    expect(await runBrain(f.deps)).toBe(2);
    expect(f.deps.api).not.toHaveBeenCalled();
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(PROXY_TOKEN);
    expect(f.signals.listenerCount("SIGINT")).toBe(0);
  });
  it("returns the gave-up code and Stop always wins a late outcome", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce("gave_up" as never);
    expect(await runBrain(f.deps)).toBe(3);
    const stopped = fixture();
    stopped.run.mockImplementationOnce(async () => {
      stopped.signals.emit("SIGTERM");
      return "gave_up" as never;
    });
    expect(await runBrain(stopped.deps)).toBe(0);
  });
});

it("destroys both transports even if closing the event sink fails", async () => {
  const f = fixture();
  f.deps.sink = (options) => {
    const sink = new EventSink(options);
    sink.close = async () => {
      throw new Error("credential-bearing-sink-failure");
    };
    return sink;
  };
  expect(await runBrain(f.deps)).toBe(1);
  expect(f.order.sort()).toEqual(["api closed", "proxy closed"]);
  expect(JSON.stringify(f.log.mock.calls)).not.toContain("credential-bearing-sink-failure");
});
