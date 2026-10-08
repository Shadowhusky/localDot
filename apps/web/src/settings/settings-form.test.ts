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
    // models.dev prices plan models at $0, so they still take a manual rate for now.
    expect(needsPrice(plan.choices.main, index)).toBe(true);
    expect(validateForm(plan, {}, index)).toMatchObject({ ok: false });
    plan.prices.main = { input: "0.3", output: "1.2" };
    expect(validateForm(plan, {}, index)).toMatchObject({
      ok: true,
      document: { main: { provider: "minimax-coding-plan", key: "token-plan" } },
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
      problems: ["Main: choose a supported provider for this role."],
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
    index.defaultTaskBudgetUSD = null;
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
  it("reports every problem at once instead of the first one", () => {
    const d = formOf({ main: { provider: "ollama", model: "custom" } });
    d.choices.local = { provider: "ollama", model: "" };
    d.defaultBudget = false;
    d.budget = "abc";
    expect(validateForm(d, {}, providerFixture())).toEqual({
      ok: false,
      problems: ["Local: choose a valid model ID.", "Enter an explicit task ceiling in USD."],
    });
    delete d.choices.main;
    expect(validateForm(d, {}, providerFixture())).toMatchObject({
      ok: false,
      problems: [
        "Choose a main provider and model.",
        "Local: choose a valid model ID.",
        "Enter an explicit task ceiling in USD.",
      ],
    });
  });
  it("requires a known default or an explicit valid ceiling, with no guessed budget", () => {
    const index = providerFixture();
    index.defaultTaskBudgetUSD = null;
    const d = formOf({ main: { provider: "ollama", model: "custom" } });
    expect(validateForm(d, {}, index)).toMatchObject({ ok: false });
    d.defaultBudget = false;
    for (const budget of ["", "0", "-1", "10001", "1e999", "0.0000001"]) {
      d.budget = budget;
      expect(validateForm(d, {}, index)).toMatchObject({ ok: false });
    }
    d.budget = "3.5";
    expect(validateForm(d, {}, index)).toEqual({
      ok: true,
      document: { main: { provider: "ollama", model: "custom" }, taskBudgetUSD: 3.5 },
    });
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
