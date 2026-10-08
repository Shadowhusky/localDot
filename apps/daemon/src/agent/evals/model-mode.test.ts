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

  it("refuses a paid model without its key before anything starts", () => {
    expect(() =>
      modelModeConfig(
        env({
          LOCALDOT_EVAL_MODEL: "openai:gpt-test",
          LOCALDOT_EVAL_SPEND_CAP_USD: "1",
          LOCALDOT_EVAL_INPUT_USD_PER_MTOK: "1",
          LOCALDOT_EVAL_OUTPUT_USD_PER_MTOK: "1",
        }),
      ),
    ).toThrow(/OPENAI_API_KEY/);
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
      binding: { route: "lmstudio", client: "lmstudio", computer: "generic", coords: "per1000" },
    });
    expect(config?.pricing.routes[0]?.models[0]).toMatchObject({
      inputUSDPerMTok: 0,
      outputUSDPerMTok: 0,
    });
    expect(config?.keyEnv).toBeUndefined();
  });
});

describe("keydModelMode", () => {
  const paid = {
    LOCALDOT_EVAL_MODEL: "anthropic:claude-sonnet-5-5",
    LOCALDOT_EVAL_SPEND_CAP_USD: "2",
    LOCALDOT_EVAL_INPUT_USD_PER_MTOK: "3",
    LOCALDOT_EVAL_OUTPUT_USD_PER_MTOK: "15",
    ANTHROPIC_API_KEY: "fixture-key-value",
  };
  // keyd's side of one brain listener: a closed admission, calls in flight, and the meter.
  const fakeKeyd = (meter: { spent: () => Promise<number>; inFlight?: number }) => {
    let gate = {
      taskId: "",
      generationId: "a".repeat(32),
      epoch: 1,
      paused: true,
      active: 0,
      retired: false,
    };
    return {
      status: vi.fn(async () => ({ sealKey: await sealKey() })),
      putSecret: vi.fn(async () => ({})),
      openCell: vi.fn(async () => ({
        cellId: "c",
        port: 4791,
        proxyToken: "p".repeat(43),
        surrogates: { "eval-anthropic": "ld_llm_0123456789abcdefghijkl_abcdef" },
      })),
      beginPricedTask: vi.fn(async (_cell: string, taskId: string) => {
        gate = { ...gate, taskId };
      }),
      // Once admission is closed, each look finds one more call in flight settled.
      modelAdmission: vi.fn(async () => {
        if (gate.paused && gate.active) gate = { ...gate, active: gate.active - 1 };
        return { ...gate };
      }),
      setModelAdmission: vi.fn(
        async (_cell: string, write: { taskId: string; state: "open" | "paused" }) => {
          if (write.taskId !== gate.taskId) throw new Error("stale owner");
          const open = write.state === "open";
          gate = {
            ...gate,
            paused: !open,
            epoch: gate.epoch + 1,
            active: open ? (meter.inFlight ?? 0) : gate.active,
          };
          return { ...gate };
        },
      ),
      cell: vi.fn(async (cellId: string) => ({
        cellId,
        role: "brain",
        port: 4791,
        task: { id: gate.taskId, limitUSD: 2, spentUSD: gate.active ? 0 : await meter.spent() },
      })),
      endTask: vi.fn(async () => {}),
      closeCell: vi.fn(async () => true),
    };
  };

  it("gives keyd each task's remaining budget and closes the listener after", async () => {
    const config = modelModeConfig(env(paid));
    if (!config) throw new Error("no config");
    const keyd = fakeKeyd({ spent: async () => 0.75 });
    const mode = keydModelMode(config, keyd as never, 4791, env(paid));
    const session = await mode.begin();
    expect(keyd.beginPricedTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      config.pricing,
      2,
    );
    const taskId = keyd.beginPricedTask.mock.calls[0]?.[1];
    expect(keyd.setModelAdmission).toHaveBeenCalledWith(expect.any(String), {
      taskId,
      generationId: "a".repeat(32),
      state: "open",
      expectedEpoch: 1,
    });
    expect(session.under.binding.surrogate).toBe("ld_llm_0123456789abcdefghijkl_abcdef");
    await session.end();
    expect(keyd.endTask).toHaveBeenCalled();
    expect(keyd.closeCell).toHaveBeenCalled();
  });

  // The model reports no usage here at all, as when a call is cut off mid-stream; keyd's meter
  // alone decides what is left, read once keyd has settled the calls still in flight.
  it("budgets the next task from keyd's metered spend", async () => {
    const config = modelModeConfig(env(paid));
    if (!config) throw new Error("no config");
    const keyd = fakeKeyd({ spent: async () => 0.75, inFlight: 2 });
    const mode = keydModelMode(config, keyd as never, 4791, env(paid));
    await (await mode.begin()).end();
    expect(keyd.setModelAdmission).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ state: "paused" }),
    );
    const [read] = keyd.cell.mock.invocationCallOrder;
    const [ended] = keyd.endTask.mock.invocationCallOrder;
    expect(read).toBeLessThan(ended as number);
    expect(mode.spentUSD).toBeCloseTo(0.75);
    await mode.begin();
    expect(keyd.beginPricedTask).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      config.pricing,
      1.25,
    );
  });

  it("counts the whole budget as spent when keyd cannot say", async () => {
    const config = modelModeConfig(env(paid));
    if (!config) throw new Error("no config");
    const keyd = fakeKeyd({ spent: () => Promise.reject(new Error("keyd is gone")) });
    const mode = keydModelMode(config, keyd as never, 4791, env(paid));
    await (await mode.begin()).end();
    expect(mode.spentUSD).toBe(2);
    await expect(mode.begin()).rejects.toThrow(/spend cap is used up/);
    expect(keyd.beginPricedTask).toHaveBeenCalledTimes(1);
  });

  it("refuses a paid model whose key variable is empty", async () => {
    const config = modelModeConfig(
      env({
        LOCALDOT_EVAL_MODEL: "openai:gpt-test",
        LOCALDOT_EVAL_SPEND_CAP_USD: "1",
        LOCALDOT_EVAL_INPUT_USD_PER_MTOK: "1",
        LOCALDOT_EVAL_OUTPUT_USD_PER_MTOK: "1",
        OPENAI_API_KEY: "fixture-key-value",
      }),
    );
    if (!config) throw new Error("no config");
    const mode = keydModelMode(config, {} as never, 4791, env({}));
    await expect(mode.begin()).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
