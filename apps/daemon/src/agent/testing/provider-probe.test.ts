import { APICallError } from "ai";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxyFetch } from "../../../../../cells/brain/src/proxy-fetch.ts";
import type { KeydClient } from "../../keyd/client.ts";
import {
  PROBE_BUDGET_USD,
  PROBE_DEADLINE_MS,
  PROBE_OUTPUT_TOKENS,
  probeImage,
  providerCase,
  requireGammaClick,
  runProviderCase,
  safeProviderError,
  selectedProviders,
} from "./provider-probe.ts";

const env = (values: Record<string, string | undefined>) => (name: string) => values[name];
const rates = { ANTHROPIC_CU_INPUT_USD_PER_MTOK: "0", ANTHROPIC_CU_OUTPUT_USD_PER_MTOK: "1" };
function apiError(status: number, body: unknown) {
  return new APICallError({
    message: "credential-fixture",
    url: "http://llm.ldot/route",
    requestBodyValues: {},
    statusCode: status,
    responseBody: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function response(calls: unknown[] = [{ action: "left_click", coordinate: [773, 800] }]) {
  const parts = [
    {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: calls.map((args, index) => ({
              index,
              id: `call${index}`,
              type: "function",
              function: { name: "computer", arguments: JSON.stringify(args) },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    },
  ];
  return new Response(
    `${parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
function fixture(fetchImpl: typeof fetch = async () => response()) {
  const order: string[] = [];
  const client = {
    openCell: vi.fn<KeydClient["openCell"]>(async (request) => {
      order.push("open");
      return {
        cellId: request.cellId,
        port: request.port,
        proxyToken: "p".repeat(43),
        caCertPem: "-----BEGIN CERTIFICATE-----fixture",
        caPath: "/fixture",
        surrogates: { anthropic: "ld_llm_0123456789abcdefghijkl_abcdef" },
      };
    }),
    beginPricedTask: vi.fn<KeydClient["beginPricedTask"]>(async () => {
      order.push("priced");
    }),
    endTask: vi.fn<KeydClient["endTask"]>(async () => {
      order.push("end");
    }),
    closeCell: vi.fn<KeydClient["closeCell"]>(async () => {
      order.push("cell-close");
      return true;
    }),
  };
  const seen: { url: string; body: string; signal: AbortSignal | null | undefined }[] = [];
  const transport = Object.assign(
    vi.fn<typeof fetch>(async (input, init) => {
      order.push("fetch");
      seen.push({ url: String(input), body: String(init?.body), signal: init?.signal });
      return fetchImpl(input, init);
    }),
    {
      close: vi.fn(async () => {
        order.push("proxy-close");
      }),
    },
  ) as ProxyFetch & { close: ReturnType<typeof vi.fn> };
  const makeProxy = vi.fn(() => transport);
  return { client, transport, makeProxy, order, seen };
}
afterEach(() => vi.useRealTimers());
describe("provider acceptance gate and bounded fixture contract", () => {
  it("requires both flags without ever reading a credential or model when not selected", () => {
    const read = vi.fn((name: string) => {
      if (name.endsWith("API_KEY")) throw new Error("credential read");
      return undefined;
    });
    expect([...selectedProviders(read)]).toEqual([]);
    expect(read.mock.calls).toEqual([["LOCALDOT_KEYD_TESTS"]]);
    expect([...selectedProviders(env({ LOCALDOT_KEYD_TESTS: "1" }))]).toEqual([]);
    expect([...selectedProviders(env({ LOCALDOT_LLM_TESTS: "anthropic" }))]).toEqual([]);
    expect([
      ...selectedProviders(
        env({ LOCALDOT_KEYD_TESTS: "1", LOCALDOT_LLM_TESTS: " google,openai,google " }),
      ),
    ]).toEqual(["google", "openai"]);
    expect(() =>
      selectedProviders(env({ LOCALDOT_KEYD_TESTS: "1", LOCALDOT_LLM_TESTS: "all" })),
    ).toThrow("unsupported case");
  });
  it("requires complete finite remote prices, retains an explicit zero, and freezes only the selected model", () => {
    const read = vi.fn(env(rates));
    const config = providerCase("anthropic", read);
    expect(read.mock.calls.flat()).not.toContain("ANTHROPIC_API_KEY");
    expect(config.pricing).toEqual({
      v: 1,
      routes: [
        {
          route: "anthropic",
          models: [
            {
              id: "claude-sonnet-5-5",
              inputUSDPerMTok: 0,
              outputUSDPerMTok: 1,
              maxOutputTokens: 1024,
            },
          ],
        },
      ],
    });
    for (const patch of [
      { ANTHROPIC_CU_INPUT_USD_PER_MTOK: "" },
      { ANTHROPIC_CU_INPUT_USD_PER_MTOK: "NaN" },
      { ANTHROPIC_CU_INPUT_USD_PER_MTOK: "Infinity" },
      { ANTHROPIC_CU_INPUT_USD_PER_MTOK: "10001" },
      { ANTHROPIC_CU_INPUT_USD_PER_MTOK: "-1" },
      { ANTHROPIC_CU_OUTPUT_USD_PER_MTOK: "0" },
      { ANTHROPIC_CU_MODEL: "bad model" },
    ])
      expect(() => providerCase("anthropic", env({ ...rates, ...patch }))).toThrow();
    expect(() => providerCase("anthropic", env({ ANTHROPIC_CU_INPUT_USD_PER_MTOK: "1" }))).toThrow(
      "explicit input and output",
    );
    expect(providerCase("lmstudio", env({})).pricing.routes[0]?.models[0]).toMatchObject({
      inputUSDPerMTok: 0,
      outputUSDPerMTok: 0,
    });
  });
  it("skips only structured provider billing refusals and never reflects raw error text", () => {
    expect(
      safeProviderError(
        apiError(429, { error: { code: "insufficient_quota", message: "credential-fixture" } }),
      ).kind,
    ).toBe("billing");
    expect(
      safeProviderError(
        apiError(400, {
          error: { type: "invalid_request_error", message: "Your credit balance is too low" },
        }),
      ).kind,
    ).toBe("billing");
    for (const error of [
      apiError(402, { error: { code: "budget_exceeded", message: "billing disabled" } }),
      apiError(403, { error: { code: "model-unpriced", message: "unpriced model" } }),
      apiError(401, { error: { code: "insufficient_quota" } }),
      apiError(500, { error: { code: "insufficient_quota" } }),
      apiError(400, "billing disabled credential-fixture"),
      new Error("credential-fixture"),
    ]) {
      expect(safeProviderError(error).kind).toBe("request");
      expect(safeProviderError(error).message).not.toContain("credential-fixture");
    }
  });
  it("requires one left click within Gamma in pixels or grid space", () => {
    const pixel = providerCase("anthropic", env(rates)).binding;
    const grid = providerCase("lmstudio", env({})).binding;
    expect(() =>
      requireGammaClick(
        [{ toolName: "computer", input: { action: "left_click", coordinate: [990, 640] } }],
        pixel,
      ),
    ).not.toThrow();
    expect(() =>
      requireGammaClick(
        [{ toolName: "computer", input: { action: "left_click", coordinate: [773, 800] } }],
        grid,
      ),
    ).not.toThrow();
    for (const calls of [
      [],
      [{ toolName: "shell", input: {} }],
      [{ toolName: "computer", input: { action: "screenshot" } }],
      [{ toolName: "computer", input: { action: "right_click", coordinate: [990, 640] } }],
      [{ toolName: "computer", input: { action: "double_click", coordinate: [990, 640] } }],
      [{ toolName: "computer", input: { action: "left_click", coordinate: [1080, 640] } }],
      [{ toolName: "computer", input: { action: "left_click", coordinate: [990, 674] } }],
      Array(2).fill({
        toolName: "computer",
        input: { action: "left_click", coordinate: [990, 640] },
      }),
    ])
      expect(() => requireGammaClick(calls, pixel)).toThrow();
  });
  it("sends the real SDK image/tool wire only after immutable priced admission and closes every resource", async () => {
    const f = fixture();
    const config = providerCase("lmstudio", env({}));
    const image = await probeImage();
    expect(await sharp(image).metadata()).toMatchObject({
      width: 1280,
      height: 800,
      format: "png",
    });
    await runProviderCase(f.client, config, image, 4791, f.makeProxy);
    expect(f.order).toEqual(["open", "priced", "fetch", "proxy-close", "end", "cell-close"]);
    expect(f.client.beginPricedTask.mock.calls[0]).toEqual([
      f.client.openCell.mock.calls[0]?.[0].cellId,
      expect.stringMatching(/^[0-9A-Z]{26}$/),
      config.pricing,
      PROBE_BUDGET_USD,
    ]);
    expect(f.seen).toHaveLength(1);
    const wire = JSON.parse(f.seen[0]?.body ?? "");
    expect(f.seen[0]?.url).toBe("http://llm.ldot/lmstudio/chat/completions");
    expect(wire.max_tokens).toBe(PROBE_OUTPUT_TOKENS);
    expect(wire.tools).toHaveLength(1);
    expect(wire.tools[0].function.name).toBe("computer");
    expect(wire.messages[0].content).toContainEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
    });
    expect(f.makeProxy).toHaveBeenCalledWith("http://127.0.0.1:4791", "p".repeat(43));
    expect(f.transport.close).toHaveBeenCalledOnce();
  });
  it("does not call a model when priced initialization fails, and still ends/closes its owned cell", async () => {
    const f = fixture();
    f.client.beginPricedTask.mockRejectedValueOnce(new Error("credential-fixture"));
    await expect(
      runProviderCase(
        f.client,
        providerCase("lmstudio", env({})),
        Buffer.alloc(0),
        4791,
        f.makeProxy,
      ),
    ).rejects.toThrow("provider probe failed");
    expect(f.makeProxy).not.toHaveBeenCalled();
    expect(f.order).toEqual(["open", "end", "cell-close"]);
  });
  it("does not retry a failed provider call or leak its body, and cleanup continues after close failure", async () => {
    const f = fixture(
      async () =>
        new Response(JSON.stringify({ error: { message: "credential-fixture" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      runProviderCase(
        f.client,
        providerCase("lmstudio", env({})),
        Buffer.alloc(1),
        4791,
        f.makeProxy,
      ),
    ).rejects.toThrow("provider probe request failed (HTTP 500)");
    expect(f.seen).toHaveLength(1);
    expect(f.transport.close).toHaveBeenCalledOnce();
    expect(f.client.closeCell).toHaveBeenCalledOnce();
    const g = fixture();
    g.transport.close.mockRejectedValueOnce(new Error("credential-fixture"));
    g.client.endTask.mockRejectedValueOnce(new Error("credential-fixture"));
    await expect(
      runProviderCase(
        g.client,
        providerCase("lmstudio", env({})),
        Buffer.alloc(1),
        4791,
        g.makeProxy,
      ),
    ).rejects.toThrow("provider fixture cleanup failed");
    expect(g.client.closeCell).toHaveBeenCalledOnce();
  });
  it("aborts a silent response body at the whole-call deadline and closes the dispatcher", async () => {
    vi.useFakeTimers();
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    let cancelled = false;
    const f = fixture(async (_input, init) => {
      entered();
      return new Response(
        new ReadableStream({
          start(c) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                cancelled = true;
                c.error(new Error("fixture abort"));
              },
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const result = runProviderCase(
      f.client,
      providerCase("lmstudio", env({})),
      Buffer.alloc(1),
      4791,
      f.makeProxy,
    ).then(
      () => undefined,
      (error) => error as Error,
    );
    await ready;
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS - 1);
    expect(cancelled).toBe(false);
    expect(f.transport.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancelled).toBe(true);
    expect((await result)?.message).toBe("provider probe failed or reached its deadline");
    expect(f.transport.close).toHaveBeenCalledOnce();
    expect(f.client.closeCell).toHaveBeenCalledOnce();
  });
});
