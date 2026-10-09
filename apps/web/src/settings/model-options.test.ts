import type { AgentSettingsDocument } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { modelNames } from "./model-names.ts";
import { currentOption, modelGroups, type PlanAccount } from "./model-options.ts";
import { providerFixture } from "./testing.ts";

const index = providerFixture();
const names = modelNames(index, { chatgpt: [], claudeCode: [] });
const signedOut: PlanAccount = { ready: false, models: [] };
const claude: PlanAccount = {
  ready: true,
  models: [
    { id: "sonnet", name: "Claude Sonnet" },
    { id: "opus", name: "Claude Opus" },
  ],
};
const chatgpt: PlanAccount = { ready: true, models: [{ id: "plan-model", name: "Plan model" }] };
const saved: AgentSettingsDocument = {
  main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
  fast: { provider: "openai", model: "gpt-6-luna", key: "openai" },
  taskBudgetUSD: 3,
};
const shape = (groups: ReturnType<typeof modelGroups>) =>
  groups.map((group) => [group.label, group.options.map((option) => option.name)]);

describe("the models the composer can switch to", () => {
  it("lists the models chosen for each role, then each signed-in plan's, by provider", () => {
    const groups = modelGroups(saved, index, { chatgpt, claudeCode: claude }, names);
    expect(shape(groups)).toEqual([
      ["Anthropic", ["Claude Sonnet 5.5"]],
      ["OpenAI", ["GPT-6 Luna"]],
      ["Claude Code", ["sonnet", "opus"]],
      ["ChatGPT plan", ["plan-model"]],
    ]);
    expect(groups[0]?.options[0]?.id).toBe(currentOption(saved));
    expect(groups[1]?.options[0]?.choice).toEqual(saved.fast);
  });

  it("leaves out a plan that isn't signed in and a model whose key is gone", () => {
    const keyless = { ...index, keys: index.keys.filter((key) => key.id !== "openai") };
    expect(
      shape(modelGroups(saved, keyless, { chatgpt: signedOut, claudeCode: signedOut }, names)),
    ).toEqual([["Anthropic", ["Claude Sonnet 5.5"]]]);
  });

  it("leaves out a model that can't do the work as main", () => {
    const textOnly: AgentSettingsDocument = {
      ...saved,
      fast: { provider: "openai", model: "fixture-text-no-tools", key: "openai" },
    };
    expect(
      shape(modelGroups(textOnly, index, { chatgpt: signedOut, claudeCode: signedOut }, names)),
    ).toEqual([["Anthropic", ["Claude Sonnet 5.5"]]]);
  });

  it("keeps the current plan model in its place, and lists it even once the account drops it", () => {
    const onPlan: AgentSettingsDocument = {
      ...saved,
      main: { provider: "claude-code", model: "opus" },
    };
    const plans = { chatgpt: signedOut, claudeCode: claude };
    expect(shape(modelGroups(onPlan, index, plans, names))).toEqual([
      ["OpenAI", ["GPT-6 Luna"]],
      ["Claude Code", ["sonnet", "opus"]],
    ]);
    const gone: AgentSettingsDocument = {
      ...saved,
      main: { provider: "claude-code", model: "haiku" },
    };
    expect(shape(modelGroups(gone, index, plans, names))[1]).toEqual([
      "Claude Code",
      ["haiku", "sonnet", "opus"],
    ]);
  });

  it("offers nothing before a main model is chosen", () => {
    expect(modelGroups({}, index, { chatgpt, claudeCode: claude }, names)).toEqual([]);
    expect(modelGroups(null, index, { chatgpt, claudeCode: claude }, names)).toEqual([]);
  });
});

describe("model names", () => {
  const named = modelNames(index, {
    chatgpt: [{ id: "plan-model", name: "Plan model" }],
    claudeCode: [{ id: "sonnet", name: "Claude Sonnet" }],
  });

  it("names a model by its account or catalog, through a stored key's route too", () => {
    expect(named.name("claude-code", "sonnet")).toBe("Claude Sonnet");
    expect(named.name("chatgpt", "plan-model")).toBe("Plan model");
    expect(named.name("anthropic", "claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(named.provider("openai", "gpt-6-luna")).toBe("openai");
    expect(named.provider("gateway", "my-model")).toBe("openai-compatible");
    const keyed = modelNames(
      { ...index, keys: [{ id: "work-key", provider: "anthropic" }] },
      { chatgpt: [], claudeCode: [] },
    );
    expect(keyed.provider("work-key", "claude-opus-5-5")).toBe("anthropic");
    expect(keyed.name("work-key", "claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(keyed.provider("gone-key", "claude-opus-5-5")).toBeUndefined();
  });

  it("names a plan app's call by its maker's catalog, and keeps an unknown ID as it is", () => {
    expect(named.name("claude-code", "claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(named.name("some-key", "mystery-1")).toBe("mystery-1");
  });
});
