import type { ModelBinding, TranscriptMessage } from "@localdot/protocol";
import type { LanguageModel } from "ai";
import { fromTranscript } from "./context.ts";
import { EventSink, type EventSinkOptions } from "./events.ts";
import { Agent, type AgentOptions } from "./loop.ts";
import { languageModel } from "./models.ts";
import { type ProxyFetch, proxyFetch } from "./proxy-fetch.ts";
import { ToolClient } from "./tool-client.ts";

export const BRAIN_DONE = 0;
export const BRAIN_CRASHED = 1;
export const BRAIN_INVALID_ENV = 2;
export const BRAIN_GAVE_UP = 3;
type StopSignal = "SIGTERM" | "SIGINT";
type BrainApi = Pick<
  ToolClient,
  | "boot"
  | "transcript"
  | "frame"
  | "events"
  | "tool"
  | "inbox"
  | "appendTranscript"
  | "control"
  | "close"
>;

export interface BrainEntryDeps {
  env: NodeJS.ProcessEnv;
  on(signal: StopSignal, listener: () => void): void;
  off(signal: StopSignal, listener: () => void): void;
  log(message: string): void;
  api(url: string, token: string): BrainApi;
  proxy(url: string, token: string): ProxyFetch;
  model(binding: ModelBinding, fetch: typeof globalThis.fetch): LanguageModel;
  sink(options: EventSinkOptions): EventSink;
  agent(options: AgentOptions): Pick<Agent, "run">;
}

const defaults: BrainEntryDeps = {
  env: process.env,
  on: (signal, listener) => {
    process.on(signal, listener);
  },
  off: (signal, listener) => {
    process.removeListener(signal, listener);
  },
  log: (message) => console.error(message),
  api: (url, token) => new ToolClient(url, token),
  proxy: proxyFetch,
  model: languageModel,
  sink: (options) => new EventSink(options),
  agent: (options) => new Agent(options),
};

function validEnvironment(url: string, token: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash &&
      /^[A-Za-z0-9_-]{43}$/.test(token)
    );
  } catch {
    return false;
  }
}

// Install Stop before the first asynchronous boundary, including boot and transcript restoration.
// Fixtures override factories; production main uses these concrete owned implementations.
export async function runBrain(overrides: Partial<BrainEntryDeps> = {}): Promise<number> {
  const deps = { ...defaults, ...overrides };
  const stop = new AbortController();
  const abort = () => stop.abort();
  for (const signal of ["SIGTERM", "SIGINT"] as const) deps.on(signal, abort);
  let api: BrainApi | undefined;
  let proxy: ProxyFetch | undefined;
  let sink: EventSink | undefined;
  let code = BRAIN_CRASHED;
  try {
    const url = deps.env.LOCALDOT_TOOL_URL ?? "";
    const token = deps.env.LOCALDOT_TOOL_TOKEN ?? "";
    if (!validEnvironment(url, token)) {
      deps.log("brain: LOCALDOT_TOOL_URL and LOCALDOT_TOOL_TOKEN are required and must be valid");
      code = BRAIN_INVALID_ENV;
    } else {
      stop.signal.throwIfAborted();
      api = deps.api(url, token);
      const boot = await api.boot(stop.signal);
      stop.signal.throwIfAborted();
      proxy = deps.proxy(boot.proxy.url, boot.proxy.token);
      const models = {
        main: deps.model(boot.models.main, proxy),
        ...(boot.models.fast ? { fast: deps.model(boot.models.fast, proxy) } : {}),
        ...(boot.models.local ? { local: deps.model(boot.models.local, proxy) } : {}),
      };
      const storedTranscript: TranscriptMessage[] = boot.resume
        ? await api.transcript(stop.signal)
        : [];
      stop.signal.throwIfAborted();
      const ownedApi = api;
      const history = boot.resume
        ? await fromTranscript(
            storedTranscript,
            (ref) => ownedApi.frame(ref.frameId, ref.region, stop.signal),
            undefined,
            stop.signal,
          )
        : [];
      stop.signal.throwIfAborted();
      sink = deps.sink({
        signal: stop.signal,
        send: (events, signal) => ownedApi.events(events, signal),
      });
      const agent = deps.agent({ boot, api, sink, models, history, storedTranscript });
      const outcome = await agent.run(stop.signal);
      code =
        stop.signal.aborted || outcome === "stopped" || outcome === "done"
          ? BRAIN_DONE
          : BRAIN_GAVE_UP;
    }
  } catch {
    code = stop.signal.aborted ? BRAIN_DONE : BRAIN_CRASHED;
    if (!stop.signal.aborted) deps.log("brain: run failed");
  } finally {
    // Drain final events on normal completion; Stop already cancelled sends. Even a failed sink
    // cleanup cannot prevent either owned transport from being destroyed.
    try {
      await sink?.close();
    } catch {
      if (!stop.signal.aborted) {
        deps.log("brain: event cleanup failed");
        code = BRAIN_CRASHED;
      }
    }
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => proxy?.close()),
      Promise.resolve().then(() => api?.close()),
    ]);
    if (closed.some((result) => result.status === "rejected") && !stop.signal.aborted) {
      deps.log("brain: transport cleanup failed");
      code = BRAIN_CRASHED;
    }
    for (const signal of ["SIGTERM", "SIGINT"] as const) deps.off(signal, abort);
  }
  return stop.signal.aborted ? BRAIN_DONE : code;
}
