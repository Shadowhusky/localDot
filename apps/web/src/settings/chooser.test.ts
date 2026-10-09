import { providerById } from "@localdot/providers";
import { describe, expect, it } from "vitest";
import { matches, searchTerms } from "../ui/listbox.ts";
import type { PickerModel } from "./choices.ts";
import { modelItems, priceLine, providerGroups } from "./chooser.ts";

const models: PickerModel[] = [
  {
    id: "text-a",
    name: "Text fixture",
    tier: "text-only",
    computer: "none",
    coords: "pixels",
    note: "Can use files and the shell, not the screen",
    contextTokens: 1000,
    inputUSDPerMTok: 1,
    outputUSDPerMTok: 2.5,
  },
  {
    id: "summary-b",
    name: "Summary fixture",
    tier: "no-tools",
    computer: "none",
    coords: "pixels",
    note: "Cannot call tools",
    contextTokens: 1000,
    inputUSDPerMTok: 0,
    outputUSDPerMTok: 0,
  },
];

const labels = (role: "main" | "fast" | "local", value = "") =>
  providerGroups(role, value).map((group) => group.label);
const item = (role: "main" | "fast" | "local", id: string) =>
  providerGroups(role, "")
    .flatMap((group) => group.items)
    .find((row) => row.value === id);
const found = (role: "main" | "fast" | "local", text: string) =>
  providerGroups(role, "")
    .flatMap((group) => group.items)
    .filter((row) => matches(row, searchTerms(text)))
    .map((row) => row.value);

describe("provider choices", () => {
  it("groups the registry with plans, the plan apps and the plans not offered", () => {
    expect(labels("main")).toEqual([
      "API providers",
      "Compatible providers",
      "Plans",
      "Subscription",
      "Local servers",
      "Not available here",
      "Later releases",
    ]);
    expect(item("main", "minimax-coding-plan")).toMatchObject({
      label: "MiniMax Token Plan",
      description: "Uses your plan's limits",
    });
    expect(item("main", "zai-coding-plan")).toMatchObject({
      description: "Not available here",
      disabledReason: undefined,
    });
    expect(item("main", "amazon-bedrock")?.disabledReason).toBe("Coming in a later release");
    expect(item("main", "chatgpt")?.disabledReason).toBeUndefined();
    expect(item("fast", "chatgpt")?.disabledReason).toBe("Main model only");
    expect(item("main", "claude-code")).toMatchObject({
      label: "Claude Code (your plan)",
      description: "Uses your own Claude Code",
      disabledReason: undefined,
    });
    expect(item("fast", "claude-code")?.disabledReason).toBe("Main model only");
  });
  it("gives the local model only the servers on this Mac", () => {
    expect(labels("local")).toEqual(["Local servers"]);
    expect(
      providerGroups("local", "").flatMap((group) => group.items.map((row) => row.value)),
    ).toEqual(["lmstudio", "ollama"]);
  });
  it("finds Anthropic and Claude Code on a Claude plan search", () => {
    for (const text of ["claude", "Claude Code", "claude code", "subscription", "claude max"])
      expect(found("main", text), text).toEqual(
        expect.arrayContaining(
          ["subscription", "claude max"].includes(text)
            ? ["claude-code"]
            : ["anthropic", "claude-code"],
        ),
      );
    expect(found("main", "groq")).toEqual(["groq"]);
  });
  it("lists Claude Code's own models, and says when it no longer offers the chosen one", () => {
    const rows = modelItems(
      "main",
      undefined,
      "claude-code",
      [],
      [{ id: "sonnet", name: "Sonnet" }],
      "retired",
    );
    expect(rows).toEqual([
      {
        value: "retired",
        label: "retired",
        disabledReason: "Your Claude Code doesn't offer it now",
      },
      { value: "sonnet", label: "Sonnet", description: "sonnet" },
    ]);
    expect(providerGroups("main", "claude-code")[0]?.label).not.toBe("Chosen before");
  });
  it("keeps a provider that is no longer offered visible, but not choosable", () => {
    const groups = providerGroups("main", "retired-provider");
    expect(groups[0]).toEqual({
      label: "Chosen before",
      items: [
        {
          value: "retired-provider",
          label: "retired-provider",
          disabledReason: "No longer offered",
        },
      ],
    });
  });
});

describe("model choices", () => {
  it("allows a model without tools only for the fast role and shows ID and price", () => {
    const openai = providerById("openai");
    const main = modelItems("main", openai, "openai", models, [], "text-a");
    expect(main).toEqual([
      expect.objectContaining({ value: "text-a", description: "text-a · $1 in · $2.5 out" }),
      expect.objectContaining({
        value: "summary-b",
        description: "summary-b",
        disabledReason: "Can't use tools, so it can't do the work",
      }),
    ]);
    expect(modelItems("fast", openai, "openai", models, [], "")[1]?.disabledReason).toBeUndefined();
  });
  it("keeps a saved model the list no longer has, and a typed ID on a custom endpoint", () => {
    const openai = providerById("openai");
    expect(modelItems("main", openai, "openai", [], [], "gone")).toEqual([
      { value: "gone", label: "gone", disabledReason: "Not in the model list now" },
    ]);
    const custom = providerById("anthropic-compatible");
    expect(modelItems("main", custom, "anthropic-compatible", models, [], "my-model")[0]).toEqual({
      value: "my-model",
      label: "my-model",
      description: "Your model ID",
    });
  });
  it("refuses a router ID on OpenRouter", () => {
    const row = modelItems(
      "main",
      providerById("openrouter"),
      "openrouter",
      [{ ...(models[0] as PickerModel), id: "openrouter/auto" }],
      [],
      "",
    )[0];
    expect(row?.disabledReason).toBe("Choose a specific model, not a router");
  });
  it("lists the ChatGPT account's own models", () => {
    expect(
      modelItems(
        "main",
        undefined,
        "chatgpt",
        [],
        [{ id: "account", name: "Account model" }],
        "old",
      ),
    ).toEqual([
      { value: "old", label: "old", disabledReason: "This account no longer offers it" },
      { value: "account", label: "Account model", description: "account" },
    ]);
  });
  it("prices nothing for a model the catalog prices at zero", () => {
    expect(priceLine(models[1] as PickerModel)).toBeUndefined();
  });
});
