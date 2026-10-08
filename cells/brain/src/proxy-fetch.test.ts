import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { APICallError, type ModelMessage, streamText } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { languageModel } from "./models.ts";
import { proxyFetch as makeProxyFetch, type ProxyFetch } from "./proxy-fetch.ts";
import {
  ENCRYPTED_REASONING,
  FIRST_CLASS_STREAMS,
  RESPONSES_WITH_REASONING,
  STREAM_USAGE,
} from "./testing/provider-streams.ts";
import { binding, PROXY_TOKEN, SURROGATE } from "./testing/scripted.ts";

const SSE = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello from keyd" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
]
  .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  .join("");

const servers: Server[] = [];
const transports: ProxyFetch[] = [];
function proxyFetch(url: string, token: string): ProxyFetch {
  const fetch = makeProxyFetch(url, token);
  transports.push(fetch);
  return fetch;
}
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

// keyd's cell listener, as the brain sees it: an HTTP proxy that wants the cell's token and
// answers http://llm.ldot/<route>/… itself.
async function fakeListener(
  reply: (req: IncomingMessage) => {
    status: number;
    body: string;
    type: string;
    headers?: Record<string, string>;
  },
) {
  const seen: { line: string; proxyAuth?: string; apiKey?: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({
      line: `${req.method} ${req.url}`,
      proxyAuth: req.headers["proxy-authorization"],
      apiKey: req.headers["x-api-key"] as string | undefined,
    });
    req.resume();
    const r = reply(req);
    res.writeHead(r.status, { "content-type": r.type, ...r.headers });
    res.end(r.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
  };
}

describe("the brain's way to a model", () => {
  it("sends plain HTTP in absolute form to keyd's listener, with the proxy token and the surrogate in Anthropic's header", async () => {
    const listener = await fakeListener(() => ({
      status: 200,
      body: SSE,
      type: "text/event-stream",
    }));
    const model = languageModel(binding(), proxyFetch(listener.url, PROXY_TOKEN));
    const result = streamText({ model, prompt: "hi", maxRetries: 0 });
    expect(await result.text).toBe("Hello from keyd");
    expect(listener.seen).toEqual([
      {
        line: "POST http://llm.ldot/anthropic/messages",
        proxyAuth: `Basic ${Buffer.from(`brain:${PROXY_TOKEN}`).toString("base64")}`,
        apiKey: SURROGATE,
      },
    ]);
  });

  it("surfaces keyd's budget refusal as a 402 the loop pauses on", async () => {
    const listener = await fakeListener(() => ({
      status: 402,
      type: "application/json",
      body: JSON.stringify({
        error: {
          type: "budget_exceeded",
          scope: "task",
          limitUSD: 5,
          spentUSD: 5,
        },
      }),
    }));
    const model = languageModel(binding(), proxyFetch(listener.url, PROXY_TOKEN));
    const result = streamText({ model, prompt: "hi", maxRetries: 0 });
    let error: unknown;
    for await (const part of result.fullStream) if (part.type === "error") error = part.error;
    expect(APICallError.isInstance(error) && error.statusCode).toBe(402);
  });

  it("reaches OpenAI-compatible routes with the surrogate as a bearer token, and local ones with none", async () => {
    const chat = `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const auths: (string | undefined)[] = [];
    const listener = await fakeListener((req) => {
      auths.push(req.headers.authorization);
      return { status: 200, body: chat, type: "text/event-stream" };
    });
    const fetch = proxyFetch(listener.url, PROXY_TOKEN);
    await streamText({
      model: languageModel(
        binding({
          client: "openai-compatible",
          route: "together",
          model: "moonshotai/Kimi-K2.5",
        }),
        fetch,
      ),
      prompt: "hi",
      maxRetries: 0,
    }).text;
    await streamText({
      model: languageModel(
        binding({
          client: "lmstudio",
          route: "lmstudio",
          model: "qwen/qwen3.8-27b",
          surrogate: undefined,
        }),
        fetch,
      ),
      prompt: "hi",
      maxRetries: 0,
    }).text;
    expect(listener.seen.map((s) => s.line)).toEqual([
      "POST http://llm.ldot/together/chat/completions",
      "POST http://llm.ldot/lmstudio/chat/completions",
    ]);
    expect(auths).toEqual([`Bearer ${SURROGATE}`, undefined]);
  });

  it("reaches Anthropic-compatible routes at their messages operation with the surrogate as a bearer token", async () => {
    const seen: { auth?: string; apiKey?: string; version?: string }[] = [];
    const listener = await fakeListener((req) => {
      seen.push({
        auth: req.headers.authorization,
        apiKey: req.headers["x-api-key"] as string | undefined,
        version: req.headers["anthropic-version"] as string | undefined,
      });
      return { status: 200, body: SSE, type: "text/event-stream" };
    });
    const model = languageModel(
      binding({
        client: "anthropic-compatible",
        route: "zai-anthropic",
        model: "glm-5.3-flash",
        computer: "generic",
      }),
      proxyFetch(listener.url, PROXY_TOKEN),
    );
    const result = streamText({ model, prompt: "hi", maxRetries: 0 });
    expect(await result.text).toBe("Hello from keyd");
    expect(listener.seen.map((s) => s.line)).toEqual([
      "POST http://llm.ldot/zai-anthropic/messages",
    ]);
    expect(seen).toEqual([
      { auth: `Bearer ${SURROGATE}`, apiKey: undefined, version: "2023-06-01" },
    ]);
  });
});

// keyd's listener again, keeping each request's headers and body.
async function recordingListener(sse: string) {
  const seen: {
    line: string;
    proxyAuth?: string;
    authorization?: string;
    apiKey?: string;
    azureKey?: string;
    body: Record<string, unknown>;
  }[] = [];
  const server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
    });
    req.on("end", () => {
      seen.push({
        line: `${req.method} ${req.url}`,
        proxyAuth: req.headers["proxy-authorization"],
        authorization: req.headers.authorization,
        apiKey: req.headers["x-api-key"] as string | undefined,
        azureKey: req.headers["api-key"] as string | undefined,
        body: JSON.parse(text) as Record<string, unknown>,
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
  };
}

describe("the first-class bearer providers' official packages", () => {
  for (const s of FIRST_CLASS_STREAMS) {
    it(`${s.client}: its own keyd route, a bearer surrogate, keyd's cap field, and its usage counted`, async () => {
      const listener = await recordingListener(s.sse);
      const model = languageModel(
        binding({
          client: s.client,
          route: s.client,
          model: s.model,
          computer: "generic",
        }),
        proxyFetch(listener.url, PROXY_TOKEN),
      );
      const result = streamText({
        model,
        prompt: "hi",
        maxRetries: 0,
        maxOutputTokens: 4096,
      });
      expect(await result.text).toBe("ok");
      const usage = await result.usage;
      expect({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }).toEqual(STREAM_USAGE);
      expect(listener.seen).toHaveLength(1);
      const [r] = listener.seen;
      expect(r?.line).toBe(`POST http://llm.ldot/${s.client}/${s.path}`);
      expect(r?.proxyAuth).toBe(`Basic ${Buffer.from(`brain:${PROXY_TOKEN}`).toString("base64")}`);
      expect(r?.authorization).toBe(`Bearer ${SURROGATE}`);
      expect(r?.apiKey).toBeUndefined();
      expect(JSON.stringify(r?.body)).not.toContain(SURROGATE);
      expect(r?.body.model).toBe(s.model);
      // The one cap field keyd's preset writes its own cap into (Part 4a's WithCap).
      expect(Object.keys(r?.body ?? {}).filter((k) => k.startsWith("max_"))).toEqual([s.capField]);
      expect(r?.body[s.capField]).toBe(4096);
      // Usage in the stream, so keyd charges what was used rather than the hold; and no fallback
      // model list, which keyd refuses (P5a-R31).
      expect(r?.body.stream_options).toEqual(s.asksForUsage ? { include_usage: true } : undefined);
      expect(r?.body).not.toHaveProperty("models");
      // xAI's Responses API keeps nothing on xAI's side (P5a-R33).
      if (s.client === "xai") expect(r?.body.store).toBe(false);
    });
  }
});

describe("the Responses APIs keep nothing on the provider (P5a-R33)", () => {
  const cases = [
    { client: "openai", auth: "authorization" },
    { client: "azure", auth: "api-key" },
    { client: "xai", auth: "authorization" },
  ] as const;
  for (const { client, auth } of cases) {
    it(`${client}: store is false, and a reasoning model's thinking goes to the next turn encrypted`, async () => {
      const listener = await recordingListener(RESPONSES_WITH_REASONING);
      const model = languageModel(
        binding({
          client,
          route: client,
          model: "m",
          reasoning: true,
          computer: "generic",
        }),
        proxyFetch(listener.url, PROXY_TOKEN),
      );
      const first = streamText({ model, prompt: "hi", maxRetries: 0 });
      expect(await first.text).toBe("ok");
      const messages: ModelMessage[] = [
        { role: "user", content: "hi" },
        ...(await first.response).messages,
        { role: "user", content: "again" },
      ];
      expect(await streamText({ model, messages, maxRetries: 0 }).text).toBe("ok");
      const [a, b] = listener.seen;
      expect(a?.line).toBe(`POST http://llm.ldot/${client}/responses`);
      if (auth === "api-key") {
        // Azure's own header, and no Authorization at all.
        expect([a?.azureKey, a?.authorization]).toEqual([SURROGATE, undefined]);
      } else {
        expect([a?.authorization, a?.azureKey]).toEqual([`Bearer ${SURROGATE}`, undefined]);
      }
      for (const body of [a?.body, b?.body]) {
        expect(body?.store).toBe(false);
        expect(body?.include).toEqual(["reasoning.encrypted_content"]);
      }
      const input = b?.body.input as {
        type?: string;
        encrypted_content?: string;
      }[];
      expect(input.filter((i) => i.type === "reasoning")).toMatchObject([
        { encrypted_content: ENCRYPTED_REASONING },
      ]);
      expect(input.some((i) => i.type === "item_reference")).toBe(false);
    });
  }

  it("asks a model that does not reason for no encrypted reasoning", async () => {
    const listener = await recordingListener(RESPONSES_WITH_REASONING);
    const model = languageModel(
      binding({
        client: "openai",
        route: "openai",
        model: "m",
        reasoning: false,
        computer: "generic",
      }),
      proxyFetch(listener.url, PROXY_TOKEN),
    );
    await streamText({ model, prompt: "hi", maxRetries: 0 }).text;
    expect(listener.seen[0]?.body.store).toBe(false);
    expect(listener.seen[0]?.body).not.toHaveProperty("include");
  });
});

it("rejects non-gateway targets and upstream redirects without leaking proxy credentials", async () => {
  const listener = await fakeListener(() => ({
    status: 302,
    body: "",
    type: "text/plain",
    headers: { location: "http://llm.ldot/another/route" },
  }));
  const fetch = proxyFetch(listener.url, PROXY_TOKEN);
  for (const target of [
    "https://api.openai.com/responses",
    "http://llm.ldot.evil/route",
    "http://llm.ldot:9999/route",
    "http://u:p@llm.ldot/route",
  ])
    await expect(fetch(target)).rejects.toThrow("keyd gateway");
  expect(listener.seen).toEqual([]);
  await expect(fetch("http://llm.ldot/anthropic/messages")).rejects.toThrow();
  expect(listener.seen).toHaveLength(1);
  await fetch.close();
  await expect(fetch("http://llm.ldot/anthropic/messages")).rejects.toThrow();
  expect(listener.seen).toHaveLength(1);
});

it("forbids caller overrides of stateless Responses settings", async () => {
  const listener = await recordingListener(RESPONSES_WITH_REASONING);
  const model = languageModel(
    binding({ client: "openai", route: "openai", model: "m", reasoning: true }),
    proxyFetch(listener.url, PROXY_TOKEN),
  );
  expect(
    await streamText({
      model,
      prompt: "hi",
      maxRetries: 0,
      providerOptions: { openai: { store: true, include: [] } },
    }).text,
  ).toBe("ok");
  expect(listener.seen[0]?.body).toMatchObject({
    store: false,
    include: ["reasoning.encrypted_content"],
  });
});

it("local SDKs never send a supplied surrogate", async () => {
  const listener = await recordingListener(
    FIRST_CLASS_STREAMS.find((s) => s.client === "groq")?.sse ?? "",
  );
  const fetch = proxyFetch(listener.url, PROXY_TOKEN);
  await streamText({
    model: languageModel(binding({ client: "ollama", route: "ollama", model: "m" }), fetch),
    prompt: "hi",
    maxRetries: 0,
  }).text;
  expect(listener.seen[0]?.authorization).toBeUndefined();
});

it("preserves a native Request body and close aborts a pending model body", async () => {
  let captured = "";
  const server = createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      captured += chunk;
    });
    req.on("end", () => {
      res.writeHead(200);
      res.write("pending");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const fetch = proxyFetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    PROXY_TOKEN,
  );
  const response = await fetch(
    new Request("http://llm.ldot/provider/messages", {
      method: "POST",
      body: "owned request",
    }),
  );
  const reading = response.text();
  const rejected = expect(reading).rejects.toThrow();
  await fetch.close();
  await rejected;
  expect(captured).toBe("owned request");
});

it("sends screenshot pixels through Anthropic and Google SDKs without putting the proxy token in model content", async () => {
  const { imagePart } = await import("./context.ts");
  const google = `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })}\n\n`;
  for (const [client, sse] of [
    ["anthropic", SSE],
    ["google", google],
  ] as const) {
    const listener = await recordingListener(sse);
    const model = languageModel(
      binding({
        client,
        route: client,
        computer: client === "anthropic" ? "anthropic-toolset" : "generic",
      }),
      proxyFetch(listener.url, PROXY_TOKEN),
    );
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          imagePart({ frameId: "01JXYZ0000000000000000AAAA" }, "iVBORw0KGgo=") as never,
        ],
      },
    ];
    const result = streamText({ model, messages, maxRetries: 0 });
    expect(await result.text).toBe(client === "anthropic" ? "Hello from keyd" : "ok");
    const request = JSON.stringify(listener.seen[0]?.body);
    expect(request).toContain("iVBORw0KGgo=");
    expect(request).not.toContain(PROXY_TOKEN);
    expect(request).not.toContain(SURROGATE);
  }
});
