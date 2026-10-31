import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type BrainEvent, type ModelBinding, ulid } from "@localdot/protocol";
import { APICallError, streamText } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { EventSink } from "./events.ts";
import { Agent } from "./loop.ts";
import { languageModel } from "./models.ts";
import { failureMessage } from "./provider-failure.ts";
import { type ProxyFetch, proxyFetch } from "./proxy-fetch.ts";
import { FIRST_CLASS_STREAMS, RESPONSES_WITH_REASONING } from "./testing/provider-streams.ts";
import { binding, bootConfig, fakeApi, PROXY_TOKEN } from "./testing/scripted.ts";

type Reply = (res: ServerResponse) => void;

const servers: Server[] = [];
const transports: ProxyFetch[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((f) => f.close()));
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

// keyd's listener relaying a provider: each request gets the next reply in turn.
async function listener(replies: Reply[]) {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      bodies.push(body);
      (replies.shift() ?? replies.at(-1) ?? ((r) => r.end()))(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

function model(b: ModelBinding, url: string) {
  const fetch = proxyFetch(url, PROXY_TOKEN);
  transports.push(fetch);
  return languageModel(b, fetch);
}

const DEEPSEEK = binding({
  client: "deepseek",
  route: "deepseek",
  model: "deepseek-flash",
  computer: "generic",
});
const CHAT_SSE = FIRST_CLASS_STREAMS.find((s) => s.client === "deepseek")?.sse ?? "";

const sse = (...events: unknown[]) =>
  events.map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`)).join("");
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "c1",
  object: "chat.completion.chunk",
  created: 1,
  model: "deepseek-v4-flash",
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const USAGE = {
  id: "c1",
  object: "chat.completion.chunk",
  created: 1,
  model: "deepseek-v4-flash",
  choices: [],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 80,
    total_tokens: 1280,
    prompt_cache_hit_tokens: 1000,
    prompt_cache_miss_tokens: 200,
    completion_tokens_details: { reasoning_tokens: 30 },
  },
};

const streamed =
  (body: string): Reply =>
  (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(body);
  };
// What keyd's relay does when the provider's connection resets mid-stream: Go's ReverseProxy
// aborts the reply, so the brain's side closes before the chunked body ends.
const cut =
  (body: string, how: "close" | "reset" = "close"): Reply =>
  (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(body);
    setTimeout(() => (how === "reset" ? res.socket?.resetAndDestroy() : res.socket?.destroy()), 10);
  };
const firstEvents = (body: string, n: number) =>
  `${body.split("\n\n").slice(0, n).join("\n\n")}\n\n`;

// DeepSeek's well-formed reply, with what its docs say a stream may carry: keep-alive comments,
// reasoning_content, and a last chunk with empty choices and its cache usage.
const DONE_CALL = streamed(
  sse(
    ": keep-alive\n\n",
    chunk({ role: "assistant", reasoning_content: "Finished." }),
    ": keep-alive\n\n",
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "done", arguments: JSON.stringify({ summary: "x" }) },
        },
      ],
    }),
    chunk({}, "tool_calls"),
    USAGE,
    "data: [DONE]\n\n",
  ),
);

const BROKE_OFF =
  "The reply broke off before it ended: Failed to process successful response; terminated; other side closed (UND_ERR_SOCKET)";

function agent(replies: Reply[], limits = { maxRetries: 8 }) {
  const events: BrainEvent[] = [];
  const f = fakeApi();
  const sink = new EventSink({
    send: async (e) => void events.push(...e),
    flushMs: 1,
    heartbeatMs: 10_000,
  });
  const ready = listener(replies);
  return {
    events,
    f,
    ready,
    states: () => events.filter((e) => e.type === "agent.state").map((e) => e.data),
    retries: () => events.filter((e) => e.type === "model.retry").map((e) => e.data),
    run: async () => {
      const { url } = await ready;
      const a = new Agent({
        boot: bootConfig({ models: { main: DEEPSEEK }, limits }),
        // A pause polls the inbox; letting timers run between polls lets a stuck pause time out.
        api: {
          ...f.api,
          inbox: async (...args: Parameters<typeof f.api.inbox>) => {
            await new Promise((resolve) => setImmediate(resolve));
            return f.api.inbox(...args);
          },
        },
        sink,
        models: { main: model(DEEPSEEK, url) },
        history: [],
        sleep: async () => {},
        pauseWaitMs: 1,
      });
      const out = await a.run(new AbortController().signal);
      await sink.close();
      return out;
    },
  };
}

describe("a reply that breaks off mid-stream", () => {
  const clients: [string, ModelBinding, string, string][] = [
    ["DeepSeek", DEEPSEEK, CHAT_SSE, "other side closed (UND_ERR_SOCKET)"],
    [
      "an OpenAI-compatible endpoint",
      binding({
        client: "openai-compatible",
        route: "cdx",
        model: "gpt-6-luna",
        computer: "generic",
      }),
      CHAT_SSE,
      "other side closed (UND_ERR_SOCKET)",
    ],
    [
      "an OpenAI Responses endpoint",
      binding({ client: "openai", route: "cdx", model: "gpt-6-luna", computer: "generic" }),
      RESPONSES_WITH_REASONING,
      "other side closed (UND_ERR_SOCKET)",
    ],
    ["DeepSeek, reset", DEEPSEEK, CHAT_SSE, "read ECONNRESET"],
  ];
  it.each(clients)(
    "from %s is the SDK's 200 'Failed to process successful response', said plainly",
    async (name, b, body, cause) => {
      const { url } = await listener([
        cut(firstEvents(body, 1), name.endsWith("reset") ? "reset" : "close"),
      ]);
      const result = streamText({ model: model(b, url), prompt: "hi", maxRetries: 0 });
      let error: unknown;
      try {
        for await (const part of result.fullStream) if (part.type === "error") error = part.error;
      } catch (e) {
        error = e;
      }
      expect(APICallError.isInstance(error)).toBe(true);
      expect(error).toMatchObject({
        statusCode: 200,
        message: "Failed to process successful response",
      });
      expect(failureMessage(error)).toBe(
        `The reply broke off before it ended: Failed to process successful response; terminated; ${cause}`,
      );
    },
  );

  it("is tried again after a short wait, and the task carries on", async () => {
    let t: ReturnType<typeof agent>;
    // Queued in case the loop pauses instead, so that shows as a failure rather than a wait.
    const resumeAfter: Reply = (res) => {
      t.f.inbox.push({ seq: 1, messageId: ulid(), kind: "resume", text: "" });
      cut(sse(chunk({ role: "assistant", reasoning_content: "Look" })))(res);
    };
    t = agent([resumeAfter, DONE_CALL]);
    expect(await t.run()).toBe("done");
    expect(t.retries()).toEqual([
      { role: "main", attempt: 1, waitMs: 2000, status: 200, message: BROKE_OFF },
    ]);
    expect(t.states().some((s) => s.state === "paused")).toBe(false);
    expect(t.events.filter((e) => e.type === "model.usage").map((e) => e.data)).toEqual([
      expect.objectContaining({ inputTokens: 1200, outputTokens: 80, reasoningTokens: 30 }),
    ]);
  });

  it("pauses as a model not answering, with the cause, once its retries run out", async () => {
    let t: ReturnType<typeof agent>;
    const resumeAfter: Reply = (res) => {
      t.f.inbox.push({ seq: 1, messageId: ulid(), kind: "resume", text: "" });
      cut(sse(chunk({ role: "assistant", content: "Opening" })))(res);
    };
    t = agent(
      [cut(sse(chunk({ role: "assistant", content: "Opening" }))), resumeAfter, DONE_CALL],
      {
        maxRetries: 1,
      },
    );
    expect(await t.run()).toBe("done");
    expect(t.states()).toContainEqual({
      state: "paused",
      reason: "model unavailable",
      detail: `200: ${BROKE_OFF}`,
    });
    expect(t.states().some((s) => s.reason === "model refused")).toBe(false);
  });
});

describe("other replies a provider may send", () => {
  it.each(["insufficient_system_resource", "aborted"])(
    "drops a DeepSeek reply its servers cut short (%s) and asks again",
    async (reason) => {
      const t = agent([
        streamed(
          sse(
            chunk({ role: "assistant", reasoning_content: "Half a thought" }),
            chunk({}, reason),
            USAGE,
            "data: [DONE]\n\n",
          ),
        ),
        DONE_CALL,
      ]);
      expect(await t.run()).toBe("done");
      expect(t.retries()).toEqual([
        {
          role: "main",
          attempt: 1,
          waitMs: 2000,
          message: `The provider stopped the reply partway (${reason})`,
        },
      ]);
      const { bodies } = await t.ready;
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).not.toContain("Half a thought");
    },
  );

  it("retries a malformed chunk without quoting the reply", async () => {
    const t = agent([
      streamed(
        `${sse(chunk({ role: "assistant", content: "Plan" }))}data: {"choices":[{"delta":{"content":"PRIVATE-TEXT"\n\n`,
      ),
      DONE_CALL,
    ]);
    expect(await t.run()).toBe("done");
    expect(t.retries()).toEqual([
      {
        role: "main",
        attempt: 1,
        waitMs: 2000,
        message: "The reply could not be read: not valid JSON",
      },
    ]);
  });

  it("still pauses on a real refusal, such as an image a text-only model can't take", async () => {
    let t: ReturnType<typeof agent>;
    const refuse: Reply = (res) => {
      t.f.inbox.push({ seq: 1, messageId: ulid(), kind: "resume", text: "" });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "unknown variant `image_url`, expected `text`",
            type: "invalid_request_error",
          },
        }),
      );
    };
    t = agent([refuse, DONE_CALL]);
    expect(await t.run()).toBe("done");
    expect(t.states()).toContainEqual({
      state: "paused",
      reason: "model refused",
      detail: "400: unknown variant `image_url`, expected `text`",
    });
    expect(t.retries()).toEqual([]);
  });
});
