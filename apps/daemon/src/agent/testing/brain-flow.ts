import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { type BootConfig, DEFAULT_AGENT_LIMITS, ulid } from "@localdot/protocol";
import { fromTranscript } from "../../../../../cells/brain/src/context.ts";
import { EventSink } from "../../../../../cells/brain/src/events.ts";
import { Agent } from "../../../../../cells/brain/src/loop.ts";
import { languageModel } from "../../../../../cells/brain/src/models.ts";
import { type ProxyFetch, proxyFetch } from "../../../../../cells/brain/src/proxy-fetch.ts";
import { ToolClient } from "../../../../../cells/brain/src/tool-client.ts";
import { PROXY_TOKEN, TOOL_TOKEN, toolHarness } from "./harness.ts";

export const LLM_SURROGATE = "ld_llm_0123456789abcdefghijkl_abcdef";
export interface ToolUse {
  name: string;
  input: unknown;
}
export interface WireRequest {
  line: string;
  headers: IncomingHttpHeaders;
  body: string;
}
export interface ApiRequest {
  path: string;
  body: string;
}

// Provider wire data only. The official Anthropic adapter parses these responses in every test.
function toolUse(calls: ToolUse[]): string {
  const events: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: {
        id: `msg_${ulid()}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 1 },
      },
    },
  ];
  for (const [index, call] of calls.entries())
    events.push(
      {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: `toolu_${ulid()}`, name: call.name, input: {} },
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
      },
      { type: "content_block_stop", index },
    );
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  );
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function urlOf(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not listen");
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function listening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      server.removeListener("error", reject);
      resolve();
    };
    server.once("error", reject);
    server.once("listening", done);
  });
}

// Owns two ephemeral loopback listeners, real transports, and one disposable daemon home.
// Neither listener forwards requests; no DNS, external model, keyd process, or Docker is used.
export async function brainFlow(script: ToolUse[][]) {
  const h = toolHarness();
  const abort = new AbortController();
  const transports: ProxyFetch[] = [];
  const clients: ToolClient[] = [];
  const sinks: EventSink[] = [];
  const wire: WireRequest[] = [];
  const apiRequests: ApiRequest[] = [];
  const frames: { frameId: string; data: string }[] = [];
  const controls: {
    beforeModel?: (request: WireRequest) => void;
    afterApi?: (request: ApiRequest, response: Response) => Response;
  } = {};
  const png = h.tools.png.png;
  h.tools.png.png = async (...args) => {
    const data = await png(...args);
    frames.push({ frameId: args[1], data: data.toString("base64") });
    return data;
  };
  const listener = createServer((req, res) => {
    const parts: Buffer[] = [];
    let bytes = 0;
    req.on("data", (part: Buffer) => {
      bytes += part.byteLength;
      if (bytes > 2 * 1024 * 1024) req.destroy();
      else parts.push(part);
    });
    req.on("end", () => {
      const body = Buffer.concat(parts, bytes).toString("utf8");
      const request = { line: `${req.method} ${req.url}`, headers: req.headers, body };
      wire.push(request);
      if (
        req.headers["proxy-authorization"] !==
        `Basic ${Buffer.from(`brain:${PROXY_TOKEN}`).toString("base64")}`
      ) {
        res.writeHead(407).end();
        return;
      }
      if (req.method !== "POST" || req.url !== "http://llm.ldot/anthropic/messages") {
        res.writeHead(404).end();
        return;
      }
      try {
        controls.beforeModel?.(request);
        const next = script.shift();
        if (!next) throw new Error("fixture script exhausted");
        res.writeHead(200, { "content-type": "text/event-stream" }).end(toolUse(next));
      } catch {
        res.writeHead(500).end("fixture expectation failed");
      }
    });
  });
  // A CONNECT regression must fail promptly, without an unanswered proxy socket.
  listener.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  let server: ReturnType<typeof serve> | undefined;
  try {
    listener.listen(0, "127.0.0.1");
    await listening(listener);
    server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const record = {
          path: new URL(request.url).pathname,
          body: request.body ? await request.clone().text() : "",
        };
        apiRequests.push(record);
        const response = await h.app.fetch(request);
        return controls.afterApi?.(record, response) ?? response;
      },
    });
    await listening(server as Server);
  } catch (error) {
    await closeServer(listener);
    if (server) await closeServer(server as Server);
    h.close();
    throw error;
  }
  const apiUrl = urlOf(server as Server);
  const proxyUrl = urlOf(listener);
  const publish = (options: { token?: string; resume?: boolean } = {}) => {
    const generation = h.session.generation ?? h.session.beginBrain();
    h.session.restoreDelivered(h.transcripts);
    const boot: BootConfig = {
      sessionId: h.session.id,
      task: "Click the middle of the screen",
      models: {
        main: {
          route: "anthropic",
          client: "anthropic",
          model: "claude-sonnet-5-5",
          surrogate: LLM_SURROGATE,
          computer: "anthropic-toolset",
          coords: "pixels",
          vision: true,
          reasoning: false,
          contextTokens: 200_000,
          maxOutputTokens: 4096,
        },
      },
      proxy: { url: proxyUrl, token: PROXY_TOKEN },
      memory: { user: "", memory: "" },
      skills: [],
      limits: { ...DEFAULT_AGENT_LIMITS, maxRetries: 0 },
      resume: options.resume ?? false,
      inboxAfter: h.session.delivered,
    };
    h.session.publishBrain(generation, {
      toolToken: options.token ?? TOOL_TOKEN,
      brainCellId: ulid(),
      boot,
    });
    return generation;
  };
  publish();
  const client = (token = h.session.toolToken ?? TOOL_TOKEN) => {
    const api = new ToolClient(apiUrl, token);
    clients.push(api);
    return api;
  };
  const run = async () => {
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]);
    const api = client();
    const boot = await api.boot(signal);
    const fetch = proxyFetch(boot.proxy.url, boot.proxy.token);
    transports.push(fetch);
    const stored = boot.resume ? await api.transcript(signal) : [];
    const history = boot.resume
      ? await fromTranscript(stored, (ref) => api.frame(ref.frameId, ref.region, signal), 3, signal)
      : [];
    const sink = new EventSink({ send: (events, active) => api.events(events, active) });
    sinks.push(sink);
    const agent = new Agent({
      boot,
      api,
      sink,
      models: { main: languageModel(boot.models.main, fetch) },
      history,
      storedTranscript: stored,
    });
    try {
      return await agent.run(signal);
    } finally {
      await sink.close();
    }
  };
  const close = async () => {
    abort.abort();
    h.session.stop();
    await Promise.all(sinks.map((sink) => sink.close()));
    await Promise.all([...clients.map((api) => api.close()), ...transports.map((f) => f.close())]);
    await Promise.all([closeServer(server as Server), closeServer(listener)]);
    h.close();
  };
  return { h, wire, apiRequests, frames, controls, publish, client, run, close };
}
