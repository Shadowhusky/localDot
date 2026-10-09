import { DEFAULT_AUTONOMY } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { formOf, needsPrice, priceOf, validateForm } from "./settings-form.ts";
import { providerFixture } from "./testing.ts";

const custom = () =>
  formOf({
    main: { provider: "openai-compatible", model: "custom", key: "gateway" },
    codexDenyRead: ["/private/fixture"],
  });
describe("configuration validation before explicit save", () => {
  it("refuses conflicting manual rates for the same route/model across active roles", () => {
    const d = custom();
    d.choices.fast = { provider: "openai-compatible", model: "custom", key: "gateway" };
    d.prices.main = { input: "0", output: "2" };
    d.prices.fast = { input: "1", output: "2" };
    expect(validateForm(d, {}, providerFixture())).toEqual({
      ok: false,
      problems: [expect.stringContaining("conflicting")],
    });
    d.prices.fast = { input: "0", output: "2" };
    expect(validateForm(d, {}, providerFixture())).toMatchObject({ ok: true });
  });
  it.each([
    ["", "1"],
    ["1", ""],
    ["", ""],
    ["NaN", "1"],
    ["Infinity", "1"],
    ["-1", "1"],
    ["10001", "1"],
    ["0", "0"],
    [" ", "1"],
    ["0x10", "1"],
    ["1e999", "1"],
  ])("does not fill or clip invalid price fields %s / %s", (input, output) => {
    const d = custom();
    d.prices.main = { input, output };
    expect(priceOf(d.prices.main)).toBeUndefined();
    expect(validateForm(d, {}, providerFixture())).toMatchObject({ ok: false });
  });
  it.each([
    ["0", "2"],
    ["1", "0"],
    ["10000", "10000"],
  ])("accepts explicit rates unchanged %s / %s", (input, output) => {
    const d = custom();
    d.prices.main = { input, output };
    const checked = validateForm(d, { codexDenyRead: ["/private/fixture"] }, providerFixture());
    expect(checked).toEqual({
      ok: true,
      document: {
        main: {
          provider: "openai-compatible",
          model: "custom",
          key: "gateway",
          price: { inputUSDPerMTok: Number(input), outputUSDPerMTok: Number(output) },
        },
        codexDenyRead: ["/private/fixture"],
      },
    });
  });
  it("requires explicit Other prices even when a catalog model reports a price", () => {
    const index = providerFixture(),
      d = custom();
    const other = index.providers.find((p) => p.id === "openai-compatible");
    if (!other) throw new Error("provider fixture missing");
    other.models.push({
      id: "custom",
      name: "Custom",
      contextTokens: 1000,
      inputUSDPerMTok: 1,
      outputUSDPerMTok: 2,
      tier: "vision-tools",
      computer: "generic",
      coords: "pixels",
      note: "Computer tools",
    });
    expect(needsPrice(d.choices.main, index)).toBe(true);
    expect(validateForm(d, {}, index)).toMatchObject({ ok: false });
  });
  it("rejects deleted, wrong-provider and wrong-endpoint key bindings", () => {
    const d = custom();
    d.prices.main = { input: "0", output: "2" };
    for (const keys of [
      [],
      [{ id: "gateway", provider: "openai" }],
      [{ id: "gateway", provider: "openai-compatible", baseURL: "https://api.other.test/v1" }],
    ]) {
      const index = providerFixture();
      index.keys = keys;
      // Other uses the configured stored endpoint, so another valid Other endpoint is still a
      // supported user choice. A preset provider must match its canonical endpoint exactly.
      if (keys[0]?.provider === "openai-compatible") {
        d.choices.main = { provider: "togetherai", model: "custom", key: "gateway" };
        index.providers
          .find((p) => p.id === "togetherai")
          ?.models.push({
            id: "custom",
            name: "Custom",
            contextTokens: 1000,
            inputUSDPerMTok: 1,
            outputUSDPerMTok: 2,
            tier: "vision-tools",
            computer: "generic",
            coords: "pixels",
            note: "Tools",
          });
      }
      expect(validateForm(d, {}, index)).toMatchObject({ ok: false });
    }
  });
  it("saves what a custom endpoint's model can do, and no price when it is on a flat-rate plan", () => {
    const index = providerFixture();
    index.keys.push({
      id: "anc",
      provider: "anthropic-compatible",
      baseURL: "https://api.z.ai/api/anthropic/v1",
    });
    const choice = { provider: "anthropic-compatible", model: "glm-5.3-flash", key: "anc" };
    const d = formOf({ main: { ...choice, vision: false, contextTokens: 128_000 } });
    expect(needsPrice(d.choices.main, index)).toBe(true);
    d.prices.main = { input: "0.6", output: "2.2" };
    expect(validateForm(d, {}, index)).toEqual({
      ok: true,
      document: {
        main: {
          ...choice,
          vision: false,
          contextTokens: 128_000,
          price: { inputUSDPerMTok: 0.6, outputUSDPerMTok: 2.2 },
        },
      },
    });
    // On a plan, the price typed before is kept in the form but never saved.
    d.choices.main = { ...choice, plan: true };
    expect(needsPrice(d.choices.main, index)).toBe(false);
    expect(validateForm(d, {}, index)).toEqual({
      ok: true,
      document: { main: { ...choice, plan: true } },
    });
    for (const contextTokens of [1, 4_095, 2_000_001])
      expect(
        validateForm(
          { ...d, choices: { main: { ...choice, plan: true, contextTokens } } },
          {},
          index,
        ),
      ).toEqual({
        ok: false,
        problems: [
          "Main: enter a context window from 4,096 to 2,000,000 tokens, or leave it empty.",
        ],
      });
  });

  it("states abilities only for custom endpoints", () => {
    const claude = { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" };
    const d = formOf({ main: claude });
    d.choices.main = { ...claude, vision: false, contextTokens: 9_000, plan: true };
    // Only a custom endpoint's plan makes an unpriced model need no price.
    const free = { provider: "openrouter", model: "meta-llama/llama-4-maverick:free", key: "k" };
    expect(needsPrice({ ...free, plan: true }, providerFixture())).toBe(true);
    expect(validateForm(d, {}, providerFixture())).toEqual({
      ok: true,
      document: { main: claude },
    });
  });

  it("saves a plan with a key bound to its address and refuses a plan that is not offered", () => {
    const index = providerFixture();
    index.keys.push({
      id: "token-plan",
      provider: "openai-compatible",
      baseURL: "https://api.minimax.io/v1",
    });
    const plan = formOf({
      main: { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "token-plan" },
    });
    // A plan uses its own limits: no manual rate, and a rate saved before is dropped.
    expect(needsPrice(plan.choices.main, index)).toBe(false);
    expect(validateForm(plan, {}, index)).toEqual({
      ok: true,
      document: {
        main: { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "token-plan" },
      },
    });
    const stored = formOf({
      main: {
        provider: "minimax-coding-plan",
        model: "MiniMax-M3",
        key: "token-plan",
        price: { inputUSDPerMTok: 0.3, outputUSDPerMTok: 1.2 },
      },
    });
    expect(validateForm(stored, {}, index)).toEqual({
      ok: true,
      document: {
        main: { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "token-plan" },
      },
    });
    // A plan-only task shows no ceiling, so a ceiling it cannot show never blocks the save.
    const noCeiling = formOf({
      main: { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "token-plan" },
      taskBudgetUSD: 4,
    });
    noCeiling.spending.task = "";
    expect(validateForm(noCeiling, { taskBudgetUSD: 4 }, index)).toMatchObject({
      ok: true,
      document: { taskBudgetUSD: 4 },
    });
    noCeiling.choices.fast = {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      key: "anthropic",
    };
    expect(validateForm(noCeiling, {}, index)).toEqual({
      ok: false,
      problems: ["Enter a limit per task, per day or both, or turn the spending limit off."],
    });
    noCeiling.spending.on = false;
    expect(validateForm(noCeiling, { taskBudgetUSD: 4 }, index)).toMatchObject({ ok: true });
    expect(validateForm(noCeiling, { taskBudgetUSD: 4 }, index)).not.toMatchObject({
      document: { taskBudgetUSD: 4 },
    });
    // One key cannot be the plan for main and pay as you go for fast.
    const shared = formOf({
      main: { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "token-plan" },
      fast: { provider: "minimax", model: "MiniMax-M3", key: "token-plan" },
    });
    expect(validateForm(shared, {}, index)).toEqual({
      ok: false,
      problems: ["Fast: this key is a plan for main. Use a pay-as-you-go key here."],
    });
    shared.choices = { main: shared.choices.fast, fast: shared.choices.main };
    expect(validateForm(shared, {}, index)).toEqual({
      ok: false,
      problems: ["Fast: this key is pay as you go for main. Use a key from this plan here."],
    });
    // Even an index that listed models for it, with any compatible key, cannot save the row.
    index.providers
      .find((p) => p.id === "zai-coding-plan")
      ?.models.push(...(index.providers.find((p) => p.id === "zai")?.models ?? []));
    const refused = formOf({
      main: { provider: "zai-coding-plan", model: "glm-5v-turbo", key: "gateway" },
    });
    refused.prices.main = { input: "1", output: "1" };
    expect(validateForm(refused, {}, index)).toEqual({
      ok: false,
      problems: ["Main: choose a provider that is available here."],
    });
    // As the picker leaves it: the row chosen, with no model.
    refused.choices.main = { provider: "zai-coding-plan", model: "" };
    expect(validateForm(refused, {}, index)).toEqual({
      ok: false,
      problems: ["Main: choose a provider that is available here."],
    });
  });
  it("does not override catalog prices and keeps local routes keyless and free", () => {
    const index = providerFixture();
    expect(
      validateForm(
        formOf({
          main: {
            provider: "anthropic",
            model: "claude-sonnet-5-5",
            key: "anthropic",
            price: { inputUSDPerMTok: 1, outputUSDPerMTok: 1 },
          },
        }),
        {},
        index,
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateForm(formOf({ main: { provider: "ollama", model: "custom" } }), {}, index),
    ).toEqual({ ok: true, document: { main: { provider: "ollama", model: "custom" } } });
    expect(needsPrice({ provider: "ollama", model: "custom" }, index)).toBe(false);
    expect(
      validateForm(
        formOf({ main: { provider: "ollama", model: "custom", key: "gateway" } }),
        {},
        index,
      ),
    ).toMatchObject({ ok: false });
  });
  it("preserves inactive paid choices with ChatGPT main and revalidates them when switching back", () => {
    const saved = {
      main: { provider: "chatgpt", model: "account-model" },
      fast: { provider: "openai", model: "missing", key: "deleted" },
      codexDenyRead: ["/private/fixture"],
    };
    expect(validateForm(formOf(saved), saved, providerFixture())).toEqual({
      ok: true,
      document: saved,
    });
    const d = formOf(saved);
    d.choices.main = { provider: "ollama", model: "custom" };
    expect(validateForm(d, saved, providerFixture())).toMatchObject({ ok: false });
    expect(
      validateForm(
        formOf({ main: { provider: "chatgpt", model: "unreported" } }),
        {},
        providerFixture(),
      ),
    ).toMatchObject({ ok: false });
  });
  it("accepts a reported subscription model without invented capability or pricing metadata", () => {
    const index = providerFixture();
    index.keyLayer = "offline";
    index.keys = [];
    const saved = {
      main: { provider: "chatgpt", model: "older-model" },
      fast: { provider: "openai", model: "stored-paid", key: "deleted" },
      taskBudgetUSD: 8,
    };
    const draft = formOf(saved);
    draft.choices.main = { provider: "chatgpt", model: "reported-model" };
    expect(validateForm(draft, saved, index, [{ id: "reported-model", name: "Reported" }])).toEqual(
      { ok: true, document: { ...saved, main: { provider: "chatgpt", model: "reported-model" } } },
    );
    draft.choices.main = { provider: "ollama", model: "local" };
    expect(validateForm(draft, saved, index)).toMatchObject({ ok: false });
  });
  it("saves Claude Code as the main model with one of its own models, and keeps the rest", () => {
    const index = providerFixture();
    index.keys = [];
    const saved = {
      main: { provider: "openai", model: "stored-paid", key: "deleted" },
      fast: { provider: "openai", model: "stored-paid", key: "deleted" },
      taskBudgetUSD: 8,
    };
    const draft = formOf(saved);
    draft.choices.main = { provider: "claude-code", model: "sonnet" };
    expect(validateForm(draft, saved, index, [{ id: "sonnet", name: "Sonnet" }])).toEqual({
      ok: true,
      document: { ...saved, main: { provider: "claude-code", model: "sonnet" } },
    });
    expect(validateForm(draft, saved, index)).toEqual({
      ok: false,
      problems: ["Main: set up Claude Code and choose one of its models."],
    });
    draft.choices.main = { provider: "claude-code", model: "sonnet", key: "anthropic" };
    expect(validateForm(draft, saved, index, [{ id: "sonnet", name: "Sonnet" }])).toEqual({
      ok: false,
      problems: [
        "Main: Claude Code is available for main only, without an API key or manual price.",
      ],
    });
  });
  it("reports every problem at once instead of the first one", () => {
    const d = formOf({ main: { provider: "ollama", model: "custom" } });
    d.choices.local = { provider: "ollama", model: "" };
    d.spending = { on: true, task: "abc", day: "" };
    expect(validateForm(d, {}, providerFixture())).toEqual({
      ok: false,
      problems: [
        "Local: choose a valid model ID.",
        "Enter a limit per task from $0.01 to $10,000, or leave it empty.",
      ],
    });
    delete d.choices.main;
    expect(validateForm(d, {}, providerFixture())).toMatchObject({
      ok: false,
      problems: [
        "Choose a main provider and model.",
        "Local: choose a valid model ID.",
        "Enter a limit per task from $0.01 to $10,000, or leave it empty.",
      ],
    });
  });
  it("has no spending limit or check-in until the user turns one on", () => {
    const d = formOf({ main: { provider: "ollama", model: "custom" } });
    expect(d.spending).toEqual({ on: false, task: "", day: "" });
    expect(d.checkIns).toEqual({
      steps: { on: false, value: "150" },
      failures: { on: false, value: "5" },
      actions: { on: false, value: "400" },
    });
    expect(validateForm(d, {}, providerFixture())).toEqual({
      ok: true,
      document: { main: { provider: "ollama", model: "custom" } },
    });
  });
  it("has the purpose check on (Auto) unless the user turned it off, and saves only Off", () => {
    const main = { provider: "ollama", model: "custom" } as const;
    const d = formOf({ main });
    expect(d.purposeCheck).toBe(true);
    expect(formOf({ main, purposeCheck: "off" }).purposeCheck).toBe(false);
    expect(validateForm({ ...d, purposeCheck: false }, { main }, providerFixture())).toEqual({
      ok: true,
      document: { main, purposeCheck: "off" },
    });
    expect(
      validateForm({ ...d, purposeCheck: true }, { main, purposeCheck: "off" }, providerFixture()),
    ).toEqual({ ok: true, document: { main } });
  });
  it("tells tasks about recent ones unless the user turned it off, and saves only Off", () => {
    const main = { provider: "ollama", model: "custom" } as const;
    const d = formOf({ main });
    expect(d.recentActivity).toBe(true);
    expect(formOf({ main, recentActivity: "off" }).recentActivity).toBe(false);
    expect(validateForm({ ...d, recentActivity: false }, { main }, providerFixture())).toEqual({
      ok: true,
      document: { main, recentActivity: "off" },
    });
    expect(
      validateForm(
        { ...d, recentActivity: true },
        { main, recentActivity: "off" },
        providerFixture(),
      ),
    ).toEqual({ ok: true, document: { main } });
  });
  it("keeps the limits and check-ins the user turned on, and drops ones turned off", () => {
    const saved = {
      main: { provider: "ollama", model: "custom" },
      taskBudgetUSD: 2,
      dayBudgetUSD: 10,
      checkIns: { steps: 150, actions: 400 },
    };
    const d = formOf(saved);
    expect(d.spending).toEqual({ on: true, task: "2", day: "10" });
    expect(validateForm(d, saved, providerFixture())).toEqual({ ok: true, document: saved });
    d.spending = { on: true, task: "", day: "12.5" };
    d.checkIns.steps.on = false;
    d.checkIns.failures = { on: true, value: "3" };
    expect(validateForm(d, saved, providerFixture())).toEqual({
      ok: true,
      document: {
        main: { provider: "ollama", model: "custom" },
        dayBudgetUSD: 12.5,
        checkIns: { failures: 3, actions: 400 },
      },
    });
    d.spending.on = false;
    d.checkIns.failures.on = false;
    d.checkIns.actions.on = false;
    expect(validateForm(d, saved, providerFixture())).toEqual({
      ok: true,
      document: { main: { provider: "ollama", model: "custom" } },
    });
  });
  it("refuses limits and check-ins it cannot keep, without guessing", () => {
    const d = formOf({ main: { provider: "ollama", model: "custom" } });
    d.spending.on = true;
    for (const task of ["0", "10001", "1e999", "abc"]) {
      d.spending.task = task;
      expect(validateForm(d, {}, providerFixture())).toMatchObject({ ok: false });
    }
    d.spending.task = "3.5";
    expect(validateForm(d, {}, providerFixture())).toMatchObject({
      ok: true,
      document: { taskBudgetUSD: 3.5 },
    });
    for (const value of ["", "1", "100001", "2.5"]) {
      d.checkIns.actions = { on: true, value };
      expect(validateForm(d, {}, providerFixture())).toMatchObject({ ok: false });
    }
  });
});

it("explicit autonomy save preserves fixed protected-input rules and applies only the next-task document", () => {
  const saved = {
      main: { provider: "openai-compatible", model: "custom", key: "gateway" },
      autonomy: DEFAULT_AUTONOMY,
    },
    draft = formOf(saved);
  draft.prices.main = { input: "1", output: "1" };
  draft.autonomy = { ...DEFAULT_AUTONOMY, send: "handoff" };
  const result = validateForm(draft, saved, providerFixture());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("valid future-task settings required");
  expect(result.document.autonomy).toEqual({ ...DEFAULT_AUTONOMY, send: "handoff" });
  expect(saved.autonomy).toEqual(DEFAULT_AUTONOMY);
});
