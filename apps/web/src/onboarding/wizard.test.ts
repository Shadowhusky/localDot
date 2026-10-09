import { describe, expect, it } from "vitest";
import { providerFixture } from "../settings/testing.ts";
import {
  FRESH,
  kindOf,
  nextStep,
  parseProgress,
  previousStep,
  recommendedFast,
  recommendedMain,
  stepNumber,
  stepTitle,
  thinksWith,
  WIZARD_STEPS,
  wizardShown,
} from "./wizard.ts";

const models = (id: string) =>
  providerFixture().providers.find((provider) => provider.id === id)?.models ?? [];

describe("first-run setup", () => {
  it("shows on first run: settings known, no model chosen, never put off or finished", () => {
    expect(wizardShown({ known: true, configured: false, progress: FRESH })).toBe(true);
    // Never while it is unknown whether a model is chosen.
    expect(wizardShown({ known: false, configured: false, progress: FRESH })).toBe(false);
    // Someone set up before setup existed is never sent through it.
    expect(wizardShown({ known: true, configured: true, progress: FRESH })).toBe(false);
  });

  it("stays away once put off or finished, and comes back where it was when under way", () => {
    const later = { step: "key" as const, dismissed: true };
    expect(wizardShown({ known: true, configured: false, progress: later })).toBe(false);
    const done = { step: "turn-on" as const, finished: true };
    expect(wizardShown({ known: true, configured: false, progress: done })).toBe(false);
    // The model was saved on the way, then the page reloaded at Permissions.
    const midway = { step: "permissions" as const };
    expect(wizardShown({ known: true, configured: true, progress: midway })).toBe(true);
  });

  it("walks the steps in order, with Back to the welcome from the first", () => {
    const walked = [];
    let progress = { ...FRESH };
    while (progress.step !== "turn-on") {
      progress = { ...progress, step: nextStep(progress) };
      walked.push(progress.step);
    }
    expect(walked).toEqual([...WIZARD_STEPS]);
    expect(previousStep("thinks")).toBe("welcome");
    expect(previousStep("model")).toBe("key");
    expect(previousStep("welcome")).toBe("welcome");
  });

  it("returns to the summary from a change once nothing after it needs choosing again", () => {
    expect(nextStep({ step: "model", back: "turn-on" })).toBe("turn-on");
    expect(nextStep({ step: "permissions", back: "turn-on" })).toBe("turn-on");
    // A new way of thinking needs its key and model before it can return.
    expect(nextStep({ step: "thinks", back: "turn-on" })).toBe("key");
    expect(nextStep({ step: "key", back: "turn-on" })).toBe("model");
  });

  it("counts five steps after the welcome and names the credential for how dot thinks", () => {
    expect(stepNumber("welcome")).toBe(0);
    expect(stepNumber("thinks")).toBe(1);
    expect(stepNumber("turn-on")).toBe(5);
    expect(stepTitle("key", "api")).toBe("Key");
    expect(stepTitle("key", "chatgpt")).toBe("Sign-in");
    expect(stepTitle("key", "local")).toBe("Server");
    expect(stepTitle("model", "local")).toBe("Model");
  });

  it("reads back only what it kept, starting over on anything else", () => {
    const kept = {
      step: "model",
      kind: "plan",
      provider: "minimax-coding-plan",
      key: "token-plan",
      dismissed: true,
      back: "turn-on",
    };
    expect(parseProgress(JSON.stringify(kept))).toEqual(kept);
    for (const raw of [null, "", "{", "[]", '{"step":"phone"}', '"model"'])
      expect(parseProgress(raw)).toEqual(FRESH);
    expect(parseProgress('{"step":"key","kind":"vm","provider":"../x","finished":"yes"}')).toEqual({
      step: "key",
    });
  });

  it("knows how a saved main model thinks", () => {
    expect(kindOf("anthropic")).toBe("api");
    expect(kindOf("chatgpt")).toBe("chatgpt");
    expect(kindOf("claude-code")).toBe("claude-code");
    expect(thinksWith("claude-code", "claude-code")).toBe("Claude Code");
    expect(parseProgress(JSON.stringify({ step: "key", kind: "claude-code" })).kind).toBe(
      "claude-code",
    );
    expect(kindOf("alibaba-coding-plan")).toBe("plan");
    expect(kindOf("ollama")).toBe("local");
    expect(kindOf("anthropic-compatible")).toBe("custom");
    expect(kindOf(undefined)).toBeUndefined();
    expect(thinksWith("api", "anthropic")).toBe("Anthropic API key");
    expect(thinksWith("custom", "openai-compatible", "https://llm.example.test/v1")).toBe(
      "llm.example.test",
    );
  });
});

describe("the models setup suggests", () => {
  it("suggests the best at using a computer at an everyday price, and a cheap one for small jobs", () => {
    const anthropic = models("anthropic");
    expect(recommendedMain(anthropic)?.name).toBe("Claude Sonnet 5.5");
    expect(recommendedFast(anthropic, "claude-sonnet-5-5")?.name).toBe("Claude Haiku 4.5");
    const openai = models("openai");
    expect(recommendedMain(openai)?.name).toBe("GPT-6.1 Sol");
    // A model that can call tools comes before a cheaper one that can't.
    expect(recommendedFast(openai, "gpt-6.1-sol")?.name).toBe("GPT-6 Luna");
  });

  it("never suggests a model that can't use tools, and suggests nothing from an empty list", () => {
    const toolless = models("openai").filter((model) => model.tier === "no-tools");
    expect(recommendedMain(toolless)).toBeUndefined();
    expect(recommendedMain([])).toBeUndefined();
    expect(recommendedFast(models("xai"), "grok-4.3")).toBeUndefined();
  });
});
