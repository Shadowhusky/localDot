import { describe, expect, it, vi } from "vitest";

import { keydModelMode, ModelModeRefused, modelModeConfig } from "./model-mode.ts";

const env = (values: Record<string, string>) => (name: string) => values[name];

async function sealKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as { publicKey: Parameters<typeof crypto.subtle.exportKey>[1] };
  return Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
}

describe("modelModeConfig", () => {
  it("stays off without a model binding, whatever else is set", () => {
    expect(modelModeConfig(env({}))).toBeUndefined();
    expect(modelModeConfig(env({ LOCALDOT_EVAL_SPEND_CAP_USD: "5" }))).toBeUndefined();
  });

  it("refuses a model without a valid spend cap", () => {
    for (const cap of [undefined, "", "0", "-1", "abc", "1e3", "101"]) {
      const values: Record<string, string> = { LOCALDOT_EVAL_MODEL: "lmstudio:qwen/qwen3.8-27b" };
      if (cap !== undefined) values.LOCALDOT_EVAL_SPEND_CAP_USD = cap;
      expect(() => modelModeConfig(env(values)), String(cap)).toThrow(ModelModeRefused);
    }
  });

  it("refuses an unknown client or a malformed binding", () => {
    for (const model of ["qwen3", ":model", "unknown:model", "lmstudio:"])
      expect(() =>
        modelModeConfig(env({ LOCALDOT_EVAL_MODEL: model, LOCALDOT_EVAL_SPEND_CAP_USD: "1" })),
      ).toThrow(/<client>:<model>/);
  });

  it("refuses a paid model without its prices", () => {
    expect(() =>
      modelModeConfig(
        env({
          LOCALDOT_EVAL_MODEL: "anthropic:claude-sonnet-5-5",
          LOCALDOT_EVAL_SPEND_CAP_USD: "2",
        }),
      ),
    ).toThrow(/USD_PER_MTOK/);
  });

  it("prices a local model at zero and keeps the cap", () => {
    const config = modelModeConfig(
      env({ LOCALDOT_EVAL_MODEL: "lmstudio:qwen/qwen3.8-27b", LOCALDOT_EVAL_SPEND_CAP_USD: "0.5" }),
    );
    expect(config).toMatchObject({
      capUSD: 0.5,
      prices: { inputUSDPerMTok: 0, outputUSDPerMTok: 0 },
      binding: { route: "lmstudio", client: "lmstudio", computer: "generic", coords: "per1000" },
    });
    expect(config?.keyEnv).toBeUndefined();
  });
});

describe("keydModelMode", () => {
  it("gives keyd each task's remaining budget and closes the listener after", async () => {
    const config = modelModeConfig(
      env({
        LOCALDOT_EVAL_MODEL: "anthropic:claude-sonnet-5-5",
        LOCALDOT_EVAL_SPEND_CAP_USD: "2",
        LOCALDOT_EVAL_INPUT_USD_PER_MTOK: "3",
        LOCALDOT_EVAL_OUTPUT_USD_PER_MTOK: "15",
      }),
    );
    if (!config) throw new Error("no config");
    const keyd = {
      status: vi.fn(async () => ({ sealKey: await sealKey() })),
      putSecret: vi.fn(async () => ({})),
      openCell: vi.fn(async () => ({
        cellId: "c",
        port: 4791,
        proxyToken: "p".repeat(43),
        surrogates: { "eval-anthropic": "ld_llm_0123456789abcdefghijkl_abcdef" },
      })),
      beginPricedTask: vi.fn(async () => {}),
      endTask: vi.fn(async () => {}),
      closeCell: vi.fn(async () => true),
    };
    const mode = keydModelMode(
      config,
      keyd as never,
      4791,
      env({ ANTHROPIC_API_KEY: "fixture-key-value" }),
    );
    const session = await mode.begin(1.25);
    expect(keyd.beginPricedTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      config.pricing,
      1.25,
    );
    expect(session.under.binding.surrogate).toBe("ld_llm_0123456789abcdefghijkl_abcdef");
    await session.end();
    expect(keyd.endTask).toHaveBeenCalled();
    expect(keyd.closeCell).toHaveBeenCalled();
  });

  it("refuses a paid model whose key variable is empty", async () => {
    const config = modelModeConfig(
      env({
        LOCALDOT_EVAL_MODEL: "openai:gpt-test",
        LOCALDOT_EVAL_SPEND_CAP_USD: "1",
        LOCALDOT_EVAL_INPUT_USD_PER_MTOK: "1",
        LOCALDOT_EVAL_OUTPUT_USD_PER_MTOK: "1",
      }),
    );
    if (!config) throw new Error("no config");
    const mode = keydModelMode(config, {} as never, 4791, env({}));
    await expect(mode.begin(1)).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
