import { describe, expect, it } from "vitest";
import type { RoleChoice } from "./choices.ts";
import {
  libraryGroups,
  libraryProblem,
  modelSources,
  newChoices,
  promoted,
  setModelOn,
  withModels,
  withoutModel,
} from "./model-library.ts";
import { formOf } from "./settings-form.ts";
import { providerFixture } from "./testing.ts";

const index = {
  ...providerFixture(),
  keys: [
    ...providerFixture().keys,
    { id: "relay", provider: "openai-compatible", baseURL: "https://relay.example/v1" },
  ],
};
const SOL: RoleChoice = {
  provider: "openai-responses-compatible",
  model: "gpt-6.1-sol",
  key: "relay",
  price: { inputUSDPerMTok: 5, outputUSDPerMTok: 30 },
};
const TERRA: RoleChoice = { ...SOL, model: "gpt-6.1-terra" };
const LUNA: RoleChoice = { ...SOL, model: "gpt-6-luna" };

describe("the user's models", () => {
  it("lists each once, those in a role first, under its endpoint", () => {
    const groups = libraryGroups(
      { choices: { main: SOL, fast: TERRA }, models: [LUNA, TERRA] },
      index,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("relay.example");
    expect(groups[0]?.rows.map((row) => [row.choice.model, row.role])).toEqual([
      ["gpt-6.1-sol", "main"],
      ["gpt-6.1-terra", "fast"],
      ["gpt-6-luna", undefined],
    ]);
  });

  it("turns one off and on, removes it, and adds without a duplicate", () => {
    const off = setModelOn([LUNA, TERRA], LUNA, false);
    expect(off[0]).toEqual({ ...LUNA, off: true });
    expect(setModelOn(off, LUNA, true)[0]).toEqual(LUNA);
    expect(withoutModel(off, LUNA)).toEqual([TERRA]);
    expect(withModels([LUNA], [LUNA, TERRA])).toEqual([LUNA, TERRA]);
  });

  it("makes any model the default, with its price, the old default joining the list", () => {
    const draft = formOf({ main: SOL, models: [{ ...TERRA, off: true }] });
    const next = promoted(draft, "main", { ...TERRA, off: true });
    expect(next.choices.main).toEqual(TERRA);
    expect(next.prices.main).toEqual({ input: "5", output: "30" });
    expect(next.models).toEqual([SOL]);
  });

  it("says why one can't run", () => {
    const keys = [{ id: "relay", kind: "llm", provider: "openai-compatible" }] as const;
    expect(libraryProblem(SOL, [])).toBe("Its key is gone");
    expect(libraryProblem({ ...SOL, price: undefined }, keys)).toBe("Needs a price");
    expect(libraryProblem({ ...SOL, price: undefined, plan: true }, keys)).toBeUndefined();
    expect(libraryProblem({ provider: "claude-code", model: "opus" }, [])).toBeUndefined();
  });
});

describe("adding models", () => {
  const keys = index.keys.map((key) => ({ ...key, kind: "llm" as const }));
  it("offers each saved key, once, as its provider or endpoint", () => {
    const sources = modelSources(index, keys);
    expect(sources.find((row) => row.id === "relay")).toMatchObject({
      label: "relay.example",
      custom: true,
      key: "relay",
    });
    expect(sources.find((row) => row.id === "anthropic")).toMatchObject({
      provider: "anthropic",
      custom: false,
    });
  });

  it("sets a new model up as the endpoint's others are, keeping the key where it is", () => {
    const source = modelSources(index, keys).find((row) => row.id === "relay");
    if (!source) throw new Error("no source");
    const siblings = [{ ...SOL, price: undefined, plan: true as const, speedTiers: true as const }];
    expect(
      newChoices(source, ["my-model"], [], siblings, undefined, "openai-responses-compatible"),
    ).toEqual([
      {
        provider: "openai-responses-compatible",
        model: "my-model",
        key: "relay",
        plan: true,
        speedTiers: true,
      },
    ]);
  });

  it("prices a model from the catalog when another provider lists it, else as typed", () => {
    const source = modelSources(index, keys).find((row) => row.id === "relay");
    if (!source) throw new Error("no source");
    const typed = { inputUSDPerMTok: 1, outputUSDPerMTok: 2 };
    const providers = [
      {
        id: "openai",
        models: [
          {
            id: "gpt-6-luna",
            name: "GPT-6 Luna",
            contextTokens: 400_000,
            inputUSDPerMTok: 3,
            outputUSDPerMTok: 9,
            tier: "native" as const,
            computer: "generic" as const,
            coords: "pixels" as const,
            note: "",
          },
        ],
      },
    ];
    expect(
      newChoices(
        source,
        ["gpt-6-luna", "other"],
        providers,
        [],
        typed,
        "openai-responses-compatible",
      ),
    ).toEqual([
      {
        provider: "openai-responses-compatible",
        model: "gpt-6-luna",
        key: "relay",
        price: { inputUSDPerMTok: 3, outputUSDPerMTok: 9 },
        contextTokens: 400_000,
      },
      { provider: "openai-responses-compatible", model: "other", key: "relay", price: typed },
    ]);
  });
});
